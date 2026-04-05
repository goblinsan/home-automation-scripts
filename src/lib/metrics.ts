/**
 * Health monitoring and benchmark metrics backed by Postgres + Redis.
 *
 * Postgres stores durable time-series health checks and benchmark results.
 * Redis caches the latest state snapshot for fast UI reads.
 */

import type pg from 'pg';
import type Redis from 'ioredis';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────────

export interface MonitoringConfig {
  enabled: boolean;
  postgres: { host: string; port: number; database: string; user: string; password: string };
  redis: { host: string; port: number };
  healthCheckIntervalSeconds: number;
}

export interface HealthCheckRow {
  id: number;
  target_kind: string;       // 'node' | 'app' | 'workload' | 'service-profile'
  target_id: string;         // e.g. 'core-node', 'gateway-api', 'stt-service'
  status: string;            // 'healthy' | 'degraded' | 'down' | 'unknown'
  response_time_ms: number | null;
  details: string | null;    // JSON blob with extra info
  checked_at: string;        // ISO timestamp
}

export interface BenchmarkRun {
  id: number;
  suite_id: string;           // e.g. 'stt-transcription'
  name: string;               // human label for the run
  engine: string;             // e.g. 'faster-whisper', 'insanely-fast-whisper'
  config: Record<string, unknown>;  // model, compute_type, device, etc.
  hardware: string;           // e.g. 'RTX 4060 8GB'
  results: BenchmarkResult[];
  started_at: string;
  finished_at: string | null;
  notes: string;
}

export interface BenchmarkResult {
  test_name: string;
  metric: string;             // e.g. 'rtf', 'wer', 'latency_ms'
  value: number;
  unit: string;
}

export interface HealthSnapshot {
  targets: HealthTarget[];
  collectedAt: string;
}

export interface HealthTarget {
  kind: string;
  id: string;
  label: string;
  status: string;
  responseTimeMs: number | null;
  details: Record<string, unknown> | null;
  lastChecked: string;
  uptimePercent24h: number | null;
}

// ── Connection management ──────────────────────────────────────────────────

let pool: pg.Pool | null = null;
let redis: Redis | null = null;
let collectorTimer: ReturnType<typeof setInterval> | null = null;

const REDIS_HEALTH_KEY = 'gw:health:snapshot';

export function getPool(): pg.Pool {
  if (!pool) throw new Error('Metrics Postgres pool not initialized');
  return pool;
}

export function getRedis(): Redis | null {
  return redis;
}

export async function initMetrics(config: MonitoringConfig): Promise<void> {
  const { default: pgMod } = await import('pg');

  pool = new pgMod.Pool({
    host: config.postgres.host,
    port: config.postgres.port,
    database: config.postgres.database,
    user: config.postgres.user,
    password: config.postgres.password,
    max: 5,
    idleTimeoutMillis: 30_000,
  });

  // Redis is optional — used only as a cache
  try {
    const { default: RedisMod } = await import('ioredis');
    const client = new RedisMod({
      host: config.redis.host,
      port: config.redis.port,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      retryStrategy(times) { return times > 3 ? null : Math.min(times * 200, 2000); },
    });
    await client.connect();
    redis = client;
    console.log('[monitoring] Redis connected');
  } catch (err) {
    console.warn('[monitoring] Redis unavailable, running without cache:', err instanceof Error ? err.message : err);
    redis = null;
  }

  await runMigrations();
}

export async function shutdownMetrics(): Promise<void> {
  stopHealthCollector();
  if (redis) { redis.disconnect(); redis = null; }
  if (pool) { await pool.end(); pool = null; }
}

// ── Migration runner ───────────────────────────────────────────────────────

const MIGRATIONS_DIR = resolve(import.meta.dirname ?? '.', '../../migration/metrics');

export async function runMigrations(): Promise<void> {
  const db = getPool();

  // Bootstrap the migrations tracking table (the one exception to file-based migrations)
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         SERIAL PRIMARY KEY,
      filename   TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Read migration files sorted by name
  let files: string[];
  console.log('[migrations] Looking for migration files in:', MIGRATIONS_DIR);
  try {
    files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    console.log('[migrations] Found files:', files);
  } catch (err) {
    console.warn('[migrations] No migration directory found at', MIGRATIONS_DIR, err instanceof Error ? err.message : err);
    return;
  }

  if (files.length === 0) return;

  // Get already-applied migrations
  const { rows: applied } = await db.query('SELECT filename FROM schema_migrations');
  const appliedSet = new Set(applied.map((r: { filename: string }) => r.filename));

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`[migrations] Applying ${file}…`);

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[migrations] Applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      client.release();
    }
  }
}

// ── Health checks ──────────────────────────────────────────────────────────

export async function recordHealthCheck(
  targetKind: string,
  targetId: string,
  status: string,
  responseTimeMs: number | null,
  details: Record<string, unknown> | null
): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO health_checks (target_kind, target_id, status, response_time_ms, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [targetKind, targetId, status, responseTimeMs, details ? JSON.stringify(details) : null]
  );
}

export async function getHealthHistory(
  targetKind: string,
  targetId: string,
  hours: number = 24,
  limit: number = 200
): Promise<HealthCheckRow[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT id, target_kind, target_id, status, response_time_ms, details::text, checked_at::text
     FROM health_checks
     WHERE target_kind = $1 AND target_id = $2 AND checked_at > now() - ($3 || ' hours')::interval
     ORDER BY checked_at DESC
     LIMIT $4`,
    [targetKind, targetId, String(hours), limit]
  );
  return rows;
}

export async function getUptimePercent(targetKind: string, targetId: string, hours: number = 24): Promise<number | null> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT
       count(*) AS total,
       count(*) FILTER (WHERE status = 'healthy') AS healthy
     FROM health_checks
     WHERE target_kind = $1 AND target_id = $2 AND checked_at > now() - ($3 || ' hours')::interval`,
    [targetKind, targetId, String(hours)]
  );
  if (!rows[0] || rows[0].total === 0) return null;
  return Math.round((rows[0].healthy / rows[0].total) * 10000) / 100;
}

/** Build the full snapshot from DB, cache in Redis */
export async function buildHealthSnapshot(
  targets: Array<{ kind: string; id: string; label: string }>
): Promise<HealthSnapshot> {
  const db = getPool();
  const healthTargets: HealthTarget[] = [];

  for (const t of targets) {
    const { rows } = await db.query(
      `SELECT status, response_time_ms, details::text, checked_at::text
       FROM health_checks
       WHERE target_kind = $1 AND target_id = $2
       ORDER BY checked_at DESC LIMIT 1`,
      [t.kind, t.id]
    );
    const latest = rows[0];
    const uptime = await getUptimePercent(t.kind, t.id, 24);
    healthTargets.push({
      kind: t.kind,
      id: t.id,
      label: t.label,
      status: latest?.status ?? 'unknown',
      responseTimeMs: latest?.response_time_ms ?? null,
      details: latest?.details ? JSON.parse(latest.details) : null,
      lastChecked: latest?.checked_at ?? '',
      uptimePercent24h: uptime,
    });
  }

  const snapshot: HealthSnapshot = { targets: healthTargets, collectedAt: new Date().toISOString() };

  try {
    const r = getRedis();
    if (r) r.set(REDIS_HEALTH_KEY, JSON.stringify(snapshot), 'EX', 120);
  } catch { /* redis is optional cache */ }

  return snapshot;
}

/** Get cached snapshot from Redis, or null */
export async function getCachedHealthSnapshot(): Promise<HealthSnapshot | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    const raw = await r.get(REDIS_HEALTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ── Health collector (background interval) ─────────────────────────────────

export type HealthProbeFunction = () => Promise<Array<{
  kind: string;
  id: string;
  label: string;
  status: string;
  responseTimeMs: number | null;
  details: Record<string, unknown> | null;
}>>;

let probeFunction: HealthProbeFunction | null = null;

export function startHealthCollector(intervalSeconds: number, probe: HealthProbeFunction): void {
  probeFunction = probe;
  stopHealthCollector();

  const runOnce = async () => {
    if (!probeFunction) return;
    try {
      const results = await probeFunction();
      for (const r of results) {
        await recordHealthCheck(r.kind, r.id, r.status, r.responseTimeMs, r.details);
      }
      await buildHealthSnapshot(results.map((r) => ({ kind: r.kind, id: r.id, label: r.label })));
    } catch (err) {
      console.error('[health-collector]', err instanceof Error ? err.message : err);
    }
  };

  runOnce();
  collectorTimer = setInterval(runOnce, intervalSeconds * 1000);
  console.log(`[health-collector] started with ${intervalSeconds}s interval`);
}

export function stopHealthCollector(): void {
  if (collectorTimer) { clearInterval(collectorTimer); collectorTimer = null; }
}

// ── Benchmarks ─────────────────────────────────────────────────────────────

export async function createBenchmarkRun(
  suiteId: string,
  name: string,
  engine: string,
  config: Record<string, unknown>,
  hardware: string,
  notes: string = ''
): Promise<number> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO benchmark_runs (suite_id, name, engine, config, hardware, notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [suiteId, name, engine, JSON.stringify(config), hardware, notes]
  );
  return rows[0].id;
}

export async function addBenchmarkResult(
  runId: number,
  testName: string,
  metric: string,
  value: number,
  unit: string = ''
): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO benchmark_results (run_id, test_name, metric, value, unit)
     VALUES ($1, $2, $3, $4, $5)`,
    [runId, testName, metric, value, unit]
  );
}

export async function finishBenchmarkRun(runId: number): Promise<void> {
  const db = getPool();
  await db.query(`UPDATE benchmark_runs SET finished_at = now() WHERE id = $1`, [runId]);
}

export async function getBenchmarkRuns(suiteId?: string, limit: number = 50): Promise<BenchmarkRun[]> {
  const db = getPool();
  const where = suiteId ? `WHERE suite_id = $1` : '';
  const params = suiteId ? [suiteId, limit] : [limit];
  const { rows } = await db.query(
    `SELECT r.id, r.suite_id, r.name, r.engine, r.config::text, r.hardware,
            r.started_at::text, r.finished_at::text, r.notes
     FROM benchmark_runs r
     ${where}
     ORDER BY r.started_at DESC
     LIMIT $${suiteId ? 2 : 1}`,
    params
  );

  const runs: BenchmarkRun[] = [];
  for (const row of rows) {
    const { rows: results } = await db.query(
      `SELECT test_name, metric, value, unit FROM benchmark_results WHERE run_id = $1 ORDER BY id`,
      [row.id]
    );
    runs.push({
      id: row.id,
      suite_id: row.suite_id,
      name: row.name,
      engine: row.engine,
      config: JSON.parse(row.config),
      hardware: row.hardware,
      results,
      started_at: row.started_at,
      finished_at: row.finished_at,
      notes: row.notes,
    });
  }
  return runs;
}

export async function deleteBenchmarkRun(runId: number): Promise<void> {
  const db = getPool();
  await db.query(`DELETE FROM benchmark_runs WHERE id = $1`, [runId]);
}

export async function compareBenchmarkRuns(runIds: number[]): Promise<{
  runs: BenchmarkRun[];
  metrics: string[];
  comparison: Record<string, Record<number, number>>;
}> {
  const runs: BenchmarkRun[] = [];
  for (const id of runIds) {
    const list = await getBenchmarkRuns(undefined, 1000);
    const found = list.find((r) => r.id === id);
    if (found) runs.push(found);
  }

  const metrics = [...new Set(runs.flatMap((r) => r.results.map((res) => res.metric)))];
  const comparison: Record<string, Record<number, number>> = {};
  for (const m of metrics) {
    comparison[m] = {};
    for (const run of runs) {
      const result = run.results.find((r) => r.metric === m);
      if (result) comparison[m][run.id] = result.value;
    }
  }

  return { runs, metrics, comparison };
}

/** Purge health checks older than the given number of days */
export async function purgeOldHealthChecks(olderThanDays: number = 30): Promise<number> {
  const db = getPool();
  const { rowCount } = await db.query(
    `DELETE FROM health_checks WHERE checked_at < now() - ($1 || ' days')::interval`,
    [String(olderThanDays)]
  );
  return rowCount ?? 0;
}
