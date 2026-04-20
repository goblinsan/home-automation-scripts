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

export interface ProjectTrackingMilestoneInput {
  id?: string;
  title: string;
  status?: string;
  targetDate?: string | null;
  sortOrder?: number;
  notes?: string;
}

export interface ProjectTrackingUpdateInput {
  source?: string;
  kind?: string;
  summary: string;
  details?: Record<string, unknown> | null;
  createdAt?: string | null;
}

export interface ProjectTrackingProjectUpsert {
  projectId: string;
  name: string;
  status?: string;
  priority?: string;
  summary?: string;
  nextAction?: string;
  notesRepoPath?: string;
  planFilePath?: string;
  metadata?: Record<string, unknown> | null;
  lastCheckInAt?: string | null;
  milestones?: ProjectTrackingMilestoneInput[];
  update?: ProjectTrackingUpdateInput;
}

export interface ProjectTrackingProjectOverview {
  projectId: string;
  name: string;
  status: string;
  priority: string;
  summary: string;
  nextAction: string;
  notesRepoPath: string | null;
  planFilePath: string | null;
  metadata: Record<string, unknown> | null;
  lastCheckInAt: string | null;
  updatedAt: string;
  latestUpdateSummary: string | null;
  latestUpdateAt: string | null;
  totalMilestones: number;
  completedMilestones: number;
  overdueMilestones: number;
  dueSoonMilestones: number;
  isStale: boolean;
}

export interface ProjectTrackingOverview {
  projects: ProjectTrackingProjectOverview[];
  generatedAt: string;
  totals: {
    activeProjects: number;
    atRiskProjects: number;
    staleProjects: number;
    dueSoonMilestones: number;
  };
  clipboardSummary: string;
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

function normalizeProjectToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

function priorityWeight(priority: string): number {
  switch (priority) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

function isDoneProjectStatus(status: string): boolean {
  return ['done', 'completed', 'archived', 'cancelled'].includes(status);
}

function isDoneMilestoneStatus(status: string): boolean {
  return ['done', 'complete', 'completed'].includes(status);
}

function isAtRiskProject(project: Pick<ProjectTrackingProjectOverview, 'status' | 'overdueMilestones'>): boolean {
  return ['at-risk', 'blocked'].includes(project.status) || project.overdueMilestones > 0;
}

export function createEmptyProjectTrackingOverview(): ProjectTrackingOverview {
  return {
    projects: [],
    generatedAt: new Date().toISOString(),
    totals: {
      activeProjects: 0,
      atRiskProjects: 0,
      staleProjects: 0,
      dueSoonMilestones: 0,
    },
    clipboardSummary: 'No tracked projects yet.',
  };
}

function buildProjectTrackingClipboardSummary(overview: ProjectTrackingOverview): string {
  if (overview.projects.length === 0) {
    return 'No tracked projects yet.';
  }

  const lines = [
    `Generated: ${overview.generatedAt}`,
    `Active projects: ${overview.totals.activeProjects}`,
    `At risk: ${overview.totals.atRiskProjects}`,
    `Stale: ${overview.totals.staleProjects}`,
    `Milestones due soon: ${overview.totals.dueSoonMilestones}`,
    '',
  ];

  for (const project of overview.projects) {
    lines.push(`## ${project.name} [${project.status} / ${project.priority}]`);
    if (project.summary) {
      lines.push(`Summary: ${project.summary}`);
    }
    if (project.nextAction) {
      lines.push(`Next action: ${project.nextAction}`);
    }
    lines.push(
      `Milestones: ${project.completedMilestones}/${project.totalMilestones} complete; ${project.overdueMilestones} overdue; ${project.dueSoonMilestones} due soon`
    );
    if (project.latestUpdateSummary) {
      lines.push(`Latest update: ${project.latestUpdateSummary}`);
    }
    if (project.lastCheckInAt) {
      lines.push(`Last check-in: ${project.lastCheckInAt}`);
    }
    if (project.notesRepoPath) {
      lines.push(`Notes repo: ${project.notesRepoPath}`);
    }
    if (project.planFilePath) {
      lines.push(`Plan file: ${project.planFilePath}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

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

const MIGRATIONS_DIR = resolve(import.meta.dirname ?? '.', '../../db/migrations');

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

export async function upsertProjectTrackingProject(input: ProjectTrackingProjectUpsert): Promise<void> {
  const db = getPool();
  const client = await db.connect();
  const milestones = Array.isArray(input.milestones) ? input.milestones : [];

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tracked_projects (
         project_id, name, status, priority, summary, next_action,
         notes_repo_path, plan_file_path, metadata, last_check_in_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (project_id) DO UPDATE
       SET name = EXCLUDED.name,
           status = EXCLUDED.status,
           priority = EXCLUDED.priority,
           summary = EXCLUDED.summary,
           next_action = EXCLUDED.next_action,
           notes_repo_path = EXCLUDED.notes_repo_path,
           plan_file_path = EXCLUDED.plan_file_path,
           metadata = EXCLUDED.metadata,
           last_check_in_at = EXCLUDED.last_check_in_at,
           updated_at = now()`,
      [
        input.projectId,
        input.name,
        input.status ?? 'on-track',
        input.priority ?? 'medium',
        input.summary ?? '',
        input.nextAction ?? '',
        input.notesRepoPath ?? null,
        input.planFilePath ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.lastCheckInAt ?? null,
      ]
    );

    if (input.milestones !== undefined) {
      await client.query('DELETE FROM project_milestones WHERE project_id = $1', [input.projectId]);
      for (let index = 0; index < milestones.length; index += 1) {
        const milestone = milestones[index];
        const milestoneId = (milestone.id?.trim() || `${normalizeProjectToken(milestone.title)}-${index + 1}`);
        await client.query(
          `INSERT INTO project_milestones (
             project_id, milestone_id, title, status, target_date, sort_order, notes, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
          [
            input.projectId,
            milestoneId,
            milestone.title,
            milestone.status ?? 'pending',
            milestone.targetDate ?? null,
            milestone.sortOrder ?? index,
            milestone.notes ?? '',
          ]
        );
      }
    }

    if (input.update?.summary) {
      await client.query(
        `INSERT INTO project_updates (project_id, source, kind, summary, details, created_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))`,
        [
          input.projectId,
          input.update.source ?? 'manual',
          input.update.kind ?? 'status-update',
          input.update.summary,
          input.update.details ? JSON.stringify(input.update.details) : null,
          input.update.createdAt ?? null,
        ]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getProjectTrackingOverview(limit: number = 12, staleAfterHours: number = 72): Promise<ProjectTrackingOverview> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT
       p.project_id,
       p.name,
       p.status,
       p.priority,
       p.summary,
       p.next_action,
       p.notes_repo_path,
       p.plan_file_path,
       p.metadata::text,
       p.last_check_in_at::text,
       p.updated_at::text,
       COALESCE(m.total_milestones, 0) AS total_milestones,
       COALESCE(m.completed_milestones, 0) AS completed_milestones,
       COALESCE(m.overdue_milestones, 0) AS overdue_milestones,
       COALESCE(m.due_soon_milestones, 0) AS due_soon_milestones,
       u.summary AS latest_update_summary,
       u.created_at::text AS latest_update_at
     FROM tracked_projects p
     LEFT JOIN (
       SELECT
         project_id,
         count(*) AS total_milestones,
         count(*) FILTER (WHERE lower(status) IN ('done', 'complete', 'completed')) AS completed_milestones,
         count(*) FILTER (
           WHERE target_date IS NOT NULL
             AND target_date < CURRENT_DATE
             AND lower(status) NOT IN ('done', 'complete', 'completed')
         ) AS overdue_milestones,
         count(*) FILTER (
           WHERE target_date IS NOT NULL
             AND target_date >= CURRENT_DATE
             AND target_date <= CURRENT_DATE + 7
             AND lower(status) NOT IN ('done', 'complete', 'completed')
         ) AS due_soon_milestones
       FROM project_milestones
       GROUP BY project_id
     ) m ON m.project_id = p.project_id
     LEFT JOIN LATERAL (
       SELECT summary, created_at
       FROM project_updates u
       WHERE u.project_id = p.project_id
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) u ON true
     ORDER BY
       CASE lower(p.priority)
         WHEN 'critical' THEN 4
         WHEN 'high' THEN 3
         WHEN 'medium' THEN 2
         WHEN 'low' THEN 1
         ELSE 0
       END DESC,
       p.updated_at DESC
     LIMIT $1`,
    [limit]
  );

  const cutoffMs = Date.now() - (staleAfterHours * 60 * 60 * 1000);
  const projects = rows.map((row) => {
    const lastActivity = row.last_check_in_at || row.latest_update_at || row.updated_at;
    const lastActivityMs = lastActivity ? Date.parse(lastActivity) : Number.NaN;
    const project: ProjectTrackingProjectOverview = {
      projectId: row.project_id,
      name: row.name,
      status: String(row.status || 'unknown').toLowerCase(),
      priority: String(row.priority || 'medium').toLowerCase(),
      summary: row.summary || '',
      nextAction: row.next_action || '',
      notesRepoPath: row.notes_repo_path || null,
      planFilePath: row.plan_file_path || null,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      lastCheckInAt: row.last_check_in_at || null,
      updatedAt: row.updated_at,
      latestUpdateSummary: row.latest_update_summary || null,
      latestUpdateAt: row.latest_update_at || null,
      totalMilestones: Number(row.total_milestones || 0),
      completedMilestones: Number(row.completed_milestones || 0),
      overdueMilestones: Number(row.overdue_milestones || 0),
      dueSoonMilestones: Number(row.due_soon_milestones || 0),
      isStale: Number.isNaN(lastActivityMs) ? false : lastActivityMs < cutoffMs,
    };
    return project;
  }).sort((a, b) => {
    const priorityDelta = priorityWeight(b.priority) - priorityWeight(a.priority);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });

  const overview: ProjectTrackingOverview = {
    projects,
    generatedAt: new Date().toISOString(),
    totals: {
      activeProjects: projects.filter((project) => !isDoneProjectStatus(project.status)).length,
      atRiskProjects: projects.filter(isAtRiskProject).length,
      staleProjects: projects.filter((project) => project.isStale).length,
      dueSoonMilestones: projects.reduce((sum, project) => sum + project.dueSoonMilestones, 0),
    },
    clipboardSummary: '',
  };
  overview.clipboardSummary = buildProjectTrackingClipboardSummary(overview);
  return overview;
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
