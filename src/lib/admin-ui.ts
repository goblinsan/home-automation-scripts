import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildArtifacts } from './build.ts';
import { getAllScheduledJobs, getWorkerNode, loadGatewayConfig, parseGatewayConfig, saveGatewayConfig, type GatewayConfig } from './config.ts';
import {
  bootstrapWorkerNode,
  controlContainerServiceWorkload,
  controlMinecraftWorkload,
  getContainerServiceLogs,
  getContainerServiceWorkloadStatus,
  deployPiProxyService,
  deployRemoteWorkload,
  getMinecraftWorkloadStatus,
  getPiProxyServiceStatus,
  readCurrentSlot,
  restartPiProxyService,
  runServiceProfileAgent,
  syncServiceProfileRuntime,
  type AgentRunPayload,
  type AgentRunResult,
  type NodeSetupRequest
} from './deploy.ts';
import {
  createEmptyProjectTrackingOverview,
  initMetrics,
  shutdownMetrics,
  startHealthCollector,
  stopHealthCollector,
  getPool,
  getCachedHealthSnapshot,
  buildHealthSnapshot,
  recordHealthCheck,
  getHealthHistory,
  runMigrations,
  getBenchmarkRuns,
  createBenchmarkRun,
  addBenchmarkResult,
  finishBenchmarkRun,
  deleteBenchmarkRun,
  getProjectTrackingOverview,
  purgeOldHealthChecks,
  upsertProjectTrackingProject,
  type HealthProbeFunction,
} from './metrics.ts';
import { DEFAULT_WORKFLOW_SEED_PATH, importWorkflowSeed, planWorkflowSeedImport, type WorkflowRecord } from './workflows.ts';
import { buildPersonalAssistantWorkflowSeeds, buildProjectTrackingUpserts, upsertManagedAssistantAgents, writePersonalAssistantPlanFile } from './personal-assistant.ts';
import { renderAdminPage } from './admin-ui/index.ts';

export interface AdminServerOptions {
  configPath: string;
  host: string;
  port: number;
  buildOutDir: string;
}

interface RuntimeSnapshot {
  startedAt: string;
  uptimeSeconds: number;
  host: string;
  port: number;
  configPath: string;
  buildOutDir: string;
  adminRoutePath: string;
  totalApps: number;
  enabledApps: number;
  totalJobs: number;
  enabledJobs: number;
  totalFeatures: number;
  enabledFeatures: number;
  generated: {
    buildDirectoryExists: boolean;
    nginxSiteExists: boolean;
    controlPlaneUnitExists: boolean;
  };
}

interface PiProxyRegistryServerRecord {
  workloadId: string;
  nodeId: string;
  description: string;
  serverName: string;
  worldName: string;
  motd: string;
  levelName: string;
  targetHost: string;
  targetPort: number | null;
  networkMode: string | null;
  startedAt: string | null;
}

interface PiProxyRegistryPayload {
  generatedAt: string;
  profile: {
    description: string;
    systemdUnitName: string;
    listenHost: string;
    listenPort: number;
    registryPath: string;
    pollIntervalSeconds: number;
  };
  servers: PiProxyRegistryServerRecord[];
}

interface WorkflowTarget {
  type: string;
  ref: string;
}

interface WorkflowRetryPolicy {
  maxAttempts?: number;
  backoffSeconds?: number;
}

interface WorkflowRecord {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  sleepUntil: string | null;
  target: WorkflowTarget;
  input?: Record<string, unknown>;
  secrets?: string[];
  timeoutSeconds?: number;
  retryPolicy?: WorkflowRetryPolicy;
  lastRunAt: string | null;
  lastStatus: 'idle' | 'running' | 'success' | 'failed' | 'sleeping';
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobCatalogRecord {
  id: string;
  name: string;
  description: string;
}

interface AgentRunUiState {
  agentId: string;
  prompt: string;
  contextJson: string;
  deliveryJson: string;
  workflowSeedPath: string;
  result: AgentRunResult | null;
}

interface TtsStatusSnapshot {
  healthStatus: number | null;
  voices: unknown;
}

interface KulrsActivityRuntimeStatus {
  jobId: string;
  configuredEnabled: boolean;
  timerInstalled: boolean;
  timerActiveState: string;
  timerSubState: string;
  timerUnitFileState: string;
  serviceInstalled: boolean;
  serviceActiveState: string;
  serviceSubState: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  logPath: string;
  summary: string;
  driftDetected: boolean;
  error?: string;
}

interface TtsVoiceRecord {
  id: string;
  name?: string;
  description?: string;
  source?: string;
}

interface ChatProviderStatusRecord {
  name: string;
  status: 'ok' | 'error' | 'unconfigured';
  latencyMs?: number;
  error?: string;
}

interface ChatProviderModelRecord {
  id: string;
  name?: string;
  description?: string;
}

interface MinecraftManualUpdateRecord {
  workloadId: string;
  mode: 'now' | 'minutes' | 'at';
  requestedAt: string;
  runAt: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  delayMinutes: number | null;
  startedAt?: string;
  completedAt?: string;
  message?: string;
  error?: string;
}

interface MinecraftManualUpdateStore {
  version: 1;
  updates: Record<string, MinecraftManualUpdateRecord>;
}

interface DeployTelemetryEntry {
  ts: number;
  msg: string;
}

interface RemoteDeployJobRecord {
  jobId: string;
  workloadId: string;
  status: 'queued' | 'running' | 'success' | 'error';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  message?: string;
  error?: string;
  errorType?: string;
  failedStep?: string;
  deployLog: DeployTelemetryEntry[];
}

interface MinecraftManualUpdateScheduler {
  filePath: string;
  state: MinecraftManualUpdateStore;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  configPath: string;
}

function getRemoteDeployJobsRuntimeDir(buildOutDir: string): string {
  return join(buildOutDir, 'admin-ui-runtime', 'remote-deploy-jobs');
}

function getRemoteDeployJobFilePath(buildOutDir: string, jobId: string): string {
  return join(getRemoteDeployJobsRuntimeDir(buildOutDir), 'jobs', `${encodeURIComponent(jobId)}.json`);
}

function getRemoteDeployLatestFilePath(buildOutDir: string, workloadId: string): string {
  return join(getRemoteDeployJobsRuntimeDir(buildOutDir), 'latest', `${encodeURIComponent(workloadId)}.json`);
}

async function persistRemoteDeployJobRecord(buildOutDir: string, record: RemoteDeployJobRecord): Promise<void> {
  const jobPath = getRemoteDeployJobFilePath(buildOutDir, record.jobId);
  const latestPath = getRemoteDeployLatestFilePath(buildOutDir, record.workloadId);
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  await mkdir(dirname(jobPath), { recursive: true });
  await mkdir(dirname(latestPath), { recursive: true });
  await writeFile(jobPath, payload, 'utf8');
  await writeFile(latestPath, payload, 'utf8');
}

async function loadPersistedRemoteDeployJobRecord(buildOutDir: string, jobId: string): Promise<RemoteDeployJobRecord | null> {
  const filePath = getRemoteDeployJobFilePath(buildOutDir, jobId);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as RemoteDeployJobRecord;
  } catch {
    return null;
  }
}

async function loadLatestPersistedRemoteDeployJobRecord(buildOutDir: string, workloadId: string): Promise<RemoteDeployJobRecord | null> {
  const filePath = getRemoteDeployLatestFilePath(buildOutDir, workloadId);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as RemoteDeployJobRecord;
  } catch {
    return null;
  }
}

function createEmptyMinecraftManualUpdateStore(): MinecraftManualUpdateStore {
  return {
    version: 1,
    updates: {}
  };
}

async function saveMinecraftManualUpdateScheduler(scheduler: MinecraftManualUpdateScheduler): Promise<void> {
  await mkdir(dirname(scheduler.filePath), { recursive: true });
  await writeFile(scheduler.filePath, `${JSON.stringify(scheduler.state, null, 2)}\n`, 'utf8');
}

function clearMinecraftManualUpdateTimer(scheduler: MinecraftManualUpdateScheduler, workloadId: string): void {
  const timer = scheduler.timers.get(workloadId);
  if (timer) {
    clearTimeout(timer);
    scheduler.timers.delete(workloadId);
  }
}

async function executeMinecraftManualUpdate(
  scheduler: MinecraftManualUpdateScheduler,
  workloadId: string
): Promise<MinecraftManualUpdateRecord | null> {
  const record = scheduler.state.updates[workloadId];
  if (!record || record.status !== 'pending') {
    return record || null;
  }

  clearMinecraftManualUpdateTimer(scheduler, workloadId);
  record.status = 'running';
  record.startedAt = new Date().toISOString();
  record.message = 'Running safe update';
  delete record.error;
  await saveMinecraftManualUpdateScheduler(scheduler);

  try {
    const config = await loadGatewayConfig(scheduler.configPath);
    await controlMinecraftWorkload(
      config,
      workloadId,
      'update-if-empty',
      {},
      { dryRun: false, log: () => undefined }
    );
    record.status = 'completed';
    record.completedAt = new Date().toISOString();
    record.message = 'Safe update finished';
  } catch (error) {
    record.status = 'failed';
    record.completedAt = new Date().toISOString();
    record.error = error instanceof Error ? error.message : String(error);
    record.message = 'Safe update failed';
  }

  await saveMinecraftManualUpdateScheduler(scheduler);
  return record;
}

function scheduleMinecraftManualUpdateTimer(
  scheduler: MinecraftManualUpdateScheduler,
  workloadId: string
): void {
  clearMinecraftManualUpdateTimer(scheduler, workloadId);
  const record = scheduler.state.updates[workloadId];
  if (!record || record.status !== 'pending') {
    return;
  }

  const runAtMs = new Date(record.runAt).getTime();
  if (!Number.isFinite(runAtMs)) {
    record.status = 'failed';
    record.completedAt = new Date().toISOString();
    record.error = `Invalid runAt timestamp: ${record.runAt}`;
    void saveMinecraftManualUpdateScheduler(scheduler);
    return;
  }

  const delayMs = Math.max(0, runAtMs - Date.now());
  const timer = setTimeout(() => {
    void executeMinecraftManualUpdate(scheduler, workloadId);
  }, delayMs);
  scheduler.timers.set(workloadId, timer);
}

async function loadMinecraftManualUpdateScheduler(configPath: string, buildOutDir: string): Promise<MinecraftManualUpdateScheduler> {
  const filePath = join(buildOutDir, 'admin-ui-runtime', 'minecraft-manual-updates.json');
  let state = createEmptyMinecraftManualUpdateStore();

  if (existsSync(filePath)) {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<MinecraftManualUpdateStore>;
      if (parsed && parsed.version === 1 && parsed.updates && typeof parsed.updates === 'object') {
        state = {
          version: 1,
          updates: parsed.updates as Record<string, MinecraftManualUpdateRecord>
        };
      }
    } catch {
      state = createEmptyMinecraftManualUpdateStore();
    }
  }

  const scheduler: MinecraftManualUpdateScheduler = {
    filePath,
    state,
    timers: new Map(),
    configPath
  };

  for (const workloadId of Object.keys(state.updates)) {
    const record = state.updates[workloadId];
    if (record?.status === 'pending') {
      scheduleMinecraftManualUpdateTimer(scheduler, workloadId);
    }
  }

  return scheduler;
}

async function queueMinecraftManualUpdate(
  scheduler: MinecraftManualUpdateScheduler,
  workloadId: string,
  mode: 'now' | 'minutes' | 'at',
  runAt: string,
  delayMinutes: number | null
): Promise<MinecraftManualUpdateRecord> {
  clearMinecraftManualUpdateTimer(scheduler, workloadId);
  const record: MinecraftManualUpdateRecord = {
    workloadId,
    mode,
    requestedAt: new Date().toISOString(),
    runAt,
    status: 'pending',
    delayMinutes,
    message: mode === 'now' ? 'Queued to run now' : 'Queued safe update'
  };
  scheduler.state.updates[workloadId] = record;
  await saveMinecraftManualUpdateScheduler(scheduler);

  if (new Date(runAt).getTime() <= Date.now()) {
    await executeMinecraftManualUpdate(scheduler, workloadId);
  } else {
    scheduleMinecraftManualUpdateTimer(scheduler, workloadId);
  }

  return scheduler.state.updates[workloadId];
}

async function cancelMinecraftManualUpdate(
  scheduler: MinecraftManualUpdateScheduler,
  workloadId: string
): Promise<MinecraftManualUpdateRecord | null> {
  const record = scheduler.state.updates[workloadId];
  if (!record || record.status !== 'pending') {
    return null;
  }

  clearMinecraftManualUpdateTimer(scheduler, workloadId);
  record.status = 'cancelled';
  record.completedAt = new Date().toISOString();
  record.message = 'Cancelled pending safe update';
  await saveMinecraftManualUpdateScheduler(scheduler);
  return record;
}

async function runLocalCommandCapture(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      });
    });
  });
}

function parseSystemdShowOutput(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .split('\n')
      .map((line) => {
        const separatorIndex = line.indexOf('=');
        if (separatorIndex <= 0) {
          return null;
        }
        return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
      })
      .filter((entry): entry is [string, string] => Array.isArray(entry))
  );
}

function parseSystemdTimestamp(value: string | undefined): string | null {
  if (!value || value === 'n/a' || value === '0') {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

async function getKulrsActivityRuntimeStatus(config: GatewayConfig): Promise<KulrsActivityRuntimeStatus> {
  const kulrsJob = getAllScheduledJobs(config).find((job) => job.id === 'gateway-api-kulrs-activity');
  if (!kulrsJob) {
    throw new Error('KULRS scheduled job definition is missing');
  }

  const timerName = `${kulrsJob.id}.timer`;
  const serviceName = `${kulrsJob.id}.service`;
  let timerResult: { code: number; stdout: string; stderr: string };
  let serviceResult: { code: number; stdout: string; stderr: string };
  try {
    [timerResult, serviceResult] = await Promise.all([
      runLocalCommandCapture('systemctl', [
        'show',
        timerName,
        '-p', 'LoadState',
        '-p', 'ActiveState',
        '-p', 'SubState',
        '-p', 'UnitFileState',
        '-p', 'NextElapseUSecRealtime',
        '-p', 'LastTriggerUSec'
      ]),
      runLocalCommandCapture('systemctl', [
        'show',
        serviceName,
        '-p', 'LoadState',
        '-p', 'ActiveState',
        '-p', 'SubState'
      ])
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unavailable = /systemctl|ENOENT/i.test(message);
    return {
      jobId: kulrsJob.id,
      configuredEnabled: kulrsJob.enabled,
      timerInstalled: false,
      timerActiveState: 'unavailable',
      timerSubState: 'unavailable',
      timerUnitFileState: 'unavailable',
      serviceInstalled: false,
      serviceActiveState: 'unavailable',
      serviceSubState: 'unavailable',
      nextRunAt: null,
      lastRunAt: null,
      logPath: config.serviceProfiles.gatewayApi.kulrsActivity.cronLogPath,
      summary: 'Host timer status unavailable from this control-plane runtime',
      driftDetected: false,
      ...(unavailable ? {} : { error: message })
    };
  }

  const timerFields = parseSystemdShowOutput(timerResult.stdout);
  const serviceFields = parseSystemdShowOutput(serviceResult.stdout);
  const timerInstalled = timerFields.LoadState ? timerFields.LoadState !== 'not-found' : timerResult.code === 0;
  const serviceInstalled = serviceFields.LoadState ? serviceFields.LoadState !== 'not-found' : serviceResult.code === 0;
  const timerActiveState = timerFields.ActiveState || (timerInstalled ? 'unknown' : 'missing');
  const timerSubState = timerFields.SubState || (timerInstalled ? 'unknown' : 'missing');
  const timerUnitFileState = timerFields.UnitFileState || (timerInstalled ? 'unknown' : 'not-found');
  const serviceActiveState = serviceFields.ActiveState || (serviceInstalled ? 'unknown' : 'missing');
  const serviceSubState = serviceFields.SubState || (serviceInstalled ? 'unknown' : 'missing');
  const nextRunAt = parseSystemdTimestamp(timerFields.NextElapseUSecRealtime);
  const lastRunAt = parseSystemdTimestamp(timerFields.LastTriggerUSec);
  const timerOperational = timerInstalled && (timerActiveState === 'active' || timerUnitFileState === 'enabled');
  const driftDetected = kulrsJob.enabled !== timerOperational;
  const summary = kulrsJob.enabled
    ? timerOperational
      ? 'Configured enabled and timer is active on the host'
      : 'Configured enabled, but the host timer is not active'
    : timerOperational
      ? 'Configured disabled, but the host timer is still active'
      : 'Configured disabled and no active host timer detected';

  const errorParts = [
    timerResult.code !== 0 && timerResult.stderr.trim().length > 0 ? `timer: ${timerResult.stderr.trim()}` : '',
    serviceResult.code !== 0 && serviceResult.stderr.trim().length > 0 ? `service: ${serviceResult.stderr.trim()}` : ''
  ].filter(Boolean);

  return {
    jobId: kulrsJob.id,
    configuredEnabled: kulrsJob.enabled,
    timerInstalled,
    timerActiveState,
    timerSubState,
    timerUnitFileState,
    serviceInstalled,
    serviceActiveState,
    serviceSubState,
    nextRunAt,
    lastRunAt,
    logPath: config.serviceProfiles.gatewayApi.kulrsActivity.cronLogPath,
    summary,
    driftDetected,
    ...(errorParts.length > 0 ? { error: errorParts.join(' | ') } : {})
  };
}

async function getKulrsActivityLogs(
  config: GatewayConfig,
  tailLines = 200
): Promise<{ path: string; exists: boolean; tailLines: number; log: string }> {
  const filePath = config.serviceProfiles.gatewayApi.kulrsActivity.cronLogPath;
  if (!existsSync(filePath)) {
    return {
      path: filePath,
      exists: false,
      tailLines,
      log: ''
    };
  }

  const raw = await readFile(filePath, 'utf8');
  const lines = raw.split('\n').filter((line) => line.length > 0);
  return {
    path: filePath,
    exists: true,
    tailLines,
    log: lines.slice(-tailLines).join('\n')
  };
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  response.setHeader('Pragma', 'no-cache');
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendHtml(response: ServerResponse, html: string): void {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  response.setHeader('Pragma', 'no-cache');
  response.end(html);
}

function sendText(response: ServerResponse, statusCode: number, text: string): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  response.setHeader('Pragma', 'no-cache');
  response.end(text);
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error('Request body too large'));
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function readBodyBuffer(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 25_000_000) {
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function normalizeBasePath(pathValue: string | undefined): string {
  if (!pathValue || pathValue === '/') {
    return '/';
  }
  const withLeadingSlash = pathValue.startsWith('/') ? pathValue : `/${pathValue}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

function adminFaviconDataUri(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <defs>
      <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#6fe4e2"/>
        <stop offset="45%" stop-color="#4bb7d8"/>
        <stop offset="100%" stop-color="#173f78"/>
      </linearGradient>
    </defs>
    <rect width="64" height="64" rx="14" fill="#eef8fb"/>
    <circle cx="32" cy="28" r="21" fill="none" stroke="url(#g)" stroke-width="4.5"/>
    <path d="M12 30c7-7 15-11 20-11s13 4 20 11" fill="none" stroke="#2b8db8" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M17 17c8 7 12 16 15 31M47 17c-8 7-12 16-15 31" fill="none" stroke="#2b8db8" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M19 47 32 33l13 14" fill="none" stroke="#173f78" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M32 23c-6.4 0-11.6 5.2-11.6 11.6v1.1h6.3v-1.1c0-2.9 2.4-5.3 5.3-5.3s5.3 2.4 5.3 5.3v1.1h6.3v-1.1C43.6 28.2 38.4 23 32 23Z" fill="url(#g)"/>
    <path d="M32 32c-1.8 0-3.2 1.4-3.2 3.2v5.5h6.4v-5.5c0-1.8-1.4-3.2-3.2-3.2Z" fill="#ffffff"/>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function getForwardedBasePath(request: IncomingMessage): string {
  const headerValue = request.headers['x-forwarded-prefix'];
  return normalizeBasePath(typeof headerValue === 'string' ? headerValue : undefined);
}

async function detectActiveAppSlot(app: GatewayConfig['apps'][number]): Promise<string> {
  try {
    return await readCurrentSlot(app);
  } catch {
    for (const slotName of ['blue', 'green'] as const) {
      const slot = app.slots[slotName];
      try {
        const resp = await fetch(`http://127.0.0.1:${slot.port}${app.healthPath}`, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          return slotName;
        }
      } catch {
        // try next slot
      }
    }
    return 'unknown';
  }
}

function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } {
  const trimmed = repoUrl.trim();
  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  throw new Error(`Unsupported GitHub repo URL: ${repoUrl}`);
}

function getGitHubDeployToken(config: GatewayConfig): string {
  const envToken = process.env.GITHUB_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  const gatewayApiToken = config.serviceProfiles.gatewayApi.environment.find((entry) => entry.key === 'GITHUB_TOKEN')?.value?.trim();
  if (gatewayApiToken) {
    return gatewayApiToken;
  }

  throw new Error('GitHub deploy token is not configured. Set serviceProfiles.gatewayApi.environment GITHUB_TOKEN.');
}

async function ensureMonitoringReady(config: GatewayConfig): Promise<void> {
  if (!config.monitoring?.enabled) {
    throw new Error('Monitoring is not enabled. Enable it in Monitoring Settings, Save, then Restart.');
  }

  try {
    getPool();
    await runMigrations();
  } catch {
    await initMetrics(config.monitoring);
  }
}

async function triggerManagedAppDeployWorkflow(
  config: GatewayConfig,
  appId: string,
  revision: string | undefined,
  log: (message: string) => void
): Promise<{ workflowUrl?: string; owner: string; repo: string }> {
  const app = config.apps.find((candidate) => candidate.id === appId);
  if (!app) {
    throw new Error(`Unknown app: ${appId}`);
  }

  const token = getGitHubDeployToken(config);
  const { owner, repo } = parseGitHubRepo(app.repoUrl);
  const workflowFile = 'deploy-on-merge.yml';
  const apiBase = 'https://api.github.com';
  const dispatchResponse = await fetch(
    `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
    {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'gateway-control-plane',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        ref: app.defaultRevision,
        inputs: revision ? { revision } : {}
      })
    }
  );

  if (dispatchResponse.status !== 204) {
    const body = await dispatchResponse.text();
    throw new Error(`GitHub workflow dispatch failed for ${owner}/${repo}: ${dispatchResponse.status} ${body || dispatchResponse.statusText}`);
  }

  log(`workflow dispatch accepted for ${owner}/${repo}`);

  await new Promise((resolve) => setTimeout(resolve, 1200));

  const runsResponse = await fetch(
    `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(app.defaultRevision)}&per_page=1`,
    {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'gateway-control-plane',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }
  );

  if (!runsResponse.ok) {
    log(`workflow dispatch succeeded, but workflow run lookup failed with ${runsResponse.status}`);
    return { owner, repo };
  }

  const payload = await runsResponse.json() as { workflow_runs?: Array<{ html_url?: string }> };
  return {
    owner,
    repo,
    workflowUrl: payload.workflow_runs?.[0]?.html_url
  };
}

function createRuntimeSnapshot(
  config: GatewayConfig,
  options: AdminServerOptions,
  startedAtMs: number
): RuntimeSnapshot {
  const startedAt = new Date(startedAtMs).toISOString();
  const uptimeSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  const controlPlaneServicePath = join(
    options.buildOutDir,
    'systemd',
    'control-plane',
    config.gateway.adminUi.serviceName
  );

  const jobs = getAllScheduledJobs(config);

  return {
    startedAt,
    uptimeSeconds,
    host: options.host,
    port: options.port,
    configPath: options.configPath,
    buildOutDir: options.buildOutDir,
    adminRoutePath: config.gateway.adminUi.routePath,
    totalApps: config.apps.length,
    enabledApps: config.apps.filter((app) => app.enabled).length,
    totalJobs: jobs.length,
    enabledJobs: jobs.filter((job) => job.enabled).length,
    totalFeatures: config.features.length,
    enabledFeatures: config.features.filter((feature) => feature.enabled).length,
    generated: {
      buildDirectoryExists: existsSync(options.buildOutDir),
      nginxSiteExists: existsSync(join(options.buildOutDir, 'nginx', 'gateway-site.conf')),
      controlPlaneUnitExists: config.gateway.adminUi.enabled && existsSync(controlPlaneServicePath)
    }
  };
}

function extractPublishedBedrockPort(
  ports: Record<string, unknown> | null | undefined,
  configuredServerPort: number | null
): number | null {
  if (!ports || typeof ports !== 'object') {
    return configuredServerPort;
  }

  const preferredKeys = configuredServerPort
    ? [`${configuredServerPort}/udp`, '19132/udp']
    : ['19132/udp'];
  const availableEntries = Object.entries(ports);

  for (const key of preferredKeys) {
    const bindings = ports[key];
    if (!Array.isArray(bindings) || bindings.length === 0) {
      continue;
    }
    const binding = bindings[0];
    if (binding && typeof binding === 'object' && 'HostPort' in binding) {
      const hostPort = Number(binding.HostPort);
      if (Number.isFinite(hostPort) && hostPort > 0) {
        return hostPort;
      }
    }
  }

  for (const [, bindings] of availableEntries) {
    if (!Array.isArray(bindings) || bindings.length === 0) {
      continue;
    }
    const binding = bindings[0];
    if (binding && typeof binding === 'object' && 'HostPort' in binding) {
      const hostPort = Number(binding.HostPort);
      if (Number.isFinite(hostPort) && hostPort > 0) {
        return hostPort;
      }
    }
  }

  return configuredServerPort;
}

async function buildPiProxyRegistry(config: GatewayConfig): Promise<PiProxyRegistryPayload> {
  const minecraftWorkloads = config.remoteWorkloads.filter(
    (workload) => workload.enabled && workload.kind === 'minecraft-bedrock-server' && workload.minecraft
  );

  const registryServers = (
    await Promise.all(minecraftWorkloads.map(async (workload) => {
      try {
        const status = await getMinecraftWorkloadStatus(config, workload.id);
        if (!status.server.running || !workload.minecraft) {
          return null;
        }

        const node = getWorkerNode(config, workload.nodeId);
        const targetPort = status.server.networkMode === 'host'
          ? status.configuredServerPort
          : extractPublishedBedrockPort(status.server.ports, status.configuredServerPort);

        return {
          workloadId: workload.id,
          nodeId: workload.nodeId,
          description: workload.description,
          serverName: workload.minecraft.serverName,
          worldName: workload.minecraft.worldName,
          motd: workload.minecraft.serverName,
          levelName: workload.minecraft.worldName,
          targetHost: node.host,
          targetPort,
          networkMode: status.server.networkMode || null,
          startedAt: status.server.startedAt || null
        } satisfies PiProxyRegistryServerRecord;
      } catch {
        return null;
      }
    }))
  ).filter((entry): entry is PiProxyRegistryServerRecord => entry !== null);

  return {
    generatedAt: new Date().toISOString(),
    profile: {
      description: config.serviceProfiles.piProxy.description,
      systemdUnitName: config.serviceProfiles.piProxy.systemdUnitName,
      listenHost: config.serviceProfiles.piProxy.listenHost,
      listenPort: config.serviceProfiles.piProxy.listenPort,
      registryPath: config.serviceProfiles.piProxy.registryPath,
      pollIntervalSeconds: config.serviceProfiles.piProxy.pollIntervalSeconds
    },
    servers: registryServers
  };
}

function htmlPage(basePath: string): string {
  // The admin SPA is composed from page/domain modules under
  // `./admin-ui/`. See `./admin-ui/index.ts` for the module boundary map
  // and `docs/admin-ui-architecture.md` for invariants new contributors
  // must preserve.
  return renderAdminPage({
    basePath,
    faviconDataUri: adminFaviconDataUri(),
    defaultWorkflowSeedPath: DEFAULT_WORKFLOW_SEED_PATH,
  });
}


async function loadRequestConfig(request: IncomingMessage): Promise<GatewayConfig> {
  const body = await readBody(request);
  return parseGatewayConfig(JSON.parse(body) as unknown);
}

function getRequestPath(request: IncomingMessage): string {
  const requestUrl = request.url ?? '/';
  const path = requestUrl.split('?')[0] ?? '/';
  if (path === '/__admin') {
    return '/';
  }
  if (path.startsWith('/__admin/')) {
    const normalized = path.slice('/__admin'.length);
    return normalized.length > 0 ? normalized : '/';
  }
  return path;
}

async function proxyGatewayApiRequest(
  config: GatewayConfig,
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown
): Promise<{ status: number; payload: unknown }> {
  if (!config.serviceProfiles.gatewayApi.enabled) {
    throw new Error('gatewayApi service profile is disabled');
  }

  const workflowBaseUrl = normalizeBaseUrl(config.serviceProfiles.gatewayApi.apiBaseUrl);
  return requestJsonUrl(`${workflowBaseUrl}${path}`, method, body, getGatewayApiAuthHeaders(config));
}

async function proxyWorkflowRequest(
  config: GatewayConfig,
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown
): Promise<{ status: number; payload: unknown }> {
  return proxyGatewayApiRequest(config, path, method, body);
}

async function proxyChatPlatformRequest(
  config: GatewayConfig,
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown
): Promise<{ status: number; payload: unknown }> {
  if (!config.serviceProfiles.gatewayChatPlatform.enabled) {
    throw new Error('gatewayChatPlatform service profile is disabled');
  }

  const chatPlatformBaseUrl = normalizeBaseUrl(config.serviceProfiles.gatewayChatPlatform.apiBaseUrl);
  return requestJsonUrl(`${chatPlatformBaseUrl}${path}`, method, body);
}

async function listChatProviders(config: GatewayConfig): Promise<ChatProviderStatusRecord[]> {
  const result = await proxyChatPlatformRequest(config, '/api/providers/status', 'GET');
  const rawProviders =
    result.payload && typeof result.payload === 'object' && Array.isArray((result.payload as { providers?: unknown[] }).providers)
      ? (result.payload as { providers: unknown[] }).providers
      : [];

  return rawProviders
    .filter((provider): provider is Record<string, unknown> => provider !== null && typeof provider === 'object')
    .map((provider) => ({
      name: typeof provider.name === 'string' ? provider.name : 'unknown',
      status:
        provider.status === 'ok' || provider.status === 'error' || provider.status === 'unconfigured'
          ? provider.status
          : 'error',
      latencyMs: typeof provider.latencyMs === 'number' ? provider.latencyMs : undefined,
      error: typeof provider.error === 'string' ? provider.error : undefined
    }));
}

async function listChatProviderModels(config: GatewayConfig, providerName: string): Promise<ChatProviderModelRecord[]> {
  const result = await proxyChatPlatformRequest(config, `/api/providers/${encodeURIComponent(providerName)}/models`, 'GET');
  const rawModels =
    result.payload && typeof result.payload === 'object' && Array.isArray((result.payload as { models?: unknown[] }).models)
      ? (result.payload as { models: unknown[] }).models
      : [];

  return rawModels
    .filter((model): model is Record<string, unknown> => model !== null && typeof model === 'object')
    .map((model) => ({
      id: typeof model.id === 'string' ? model.id : typeof model.name === 'string' ? model.name : JSON.stringify(model),
      name: typeof model.name === 'string' ? model.name : undefined,
      description: typeof model.description === 'string' ? model.description : undefined
    }));
}

async function requestJsonUrl(
  requestUrl: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; payload: unknown }> {
  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  const requestImpl = requestUrl.startsWith('https://') ? (await import('node:https')).request : (await import('node:http')).request;
  const headers: Record<string, string | number> = {
    ...(extraHeaders ?? {})
  };

  if (requestBody) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(requestBody);
  }

  return new Promise((resolve, reject) => {
    const request = requestImpl(
      requestUrl,
      {
        method,
        timeout: 10_000,
        headers: Object.keys(headers).length > 0 ? headers : undefined
      },
      (apiResponse) => {
        const chunks: Buffer[] = [];
        apiResponse.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        });
        apiResponse.on('end', () => {
          const responseText = Buffer.concat(chunks).toString('utf8');
          const payload = responseText.length > 0 ? JSON.parse(responseText) as unknown : null;
          resolve({
            status: apiResponse.statusCode ?? 0,
            payload
          });
        });
      }
    );

    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error(`Timed out: ${requestUrl}`)));
    if (requestBody) {
      request.write(requestBody);
    }
    request.end();
  });
}

function getGatewayApiAuthHeaders(config: GatewayConfig): Record<string, string> | undefined {
  const apiKey = config.serviceProfiles.gatewayApi.environment
    .find((entry) => entry.key === 'GATEWAY_API_KEY')
    ?.value
    ?.trim();

  if (!apiKey) {
    return undefined;
  }

  return {
    'X-API-Key': apiKey
  };
}

async function requestBinaryUrl(
  requestUrl: string,
  method: 'POST' | 'DELETE',
  headers: Record<string, string | number | undefined>,
  body?: Buffer
): Promise<{ status: number; payload: unknown }> {
  const requestImpl = requestUrl.startsWith('https://') ? (await import('node:https')).request : (await import('node:http')).request;

  return new Promise((resolve, reject) => {
    const request = requestImpl(
      requestUrl,
      {
        method,
        timeout: 20_000,
        headers
      },
      (apiResponse) => {
        const chunks: Buffer[] = [];
        apiResponse.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        });
        apiResponse.on('end', () => {
          const responseText = Buffer.concat(chunks).toString('utf8');
          let payload: unknown = null;
          if (responseText.length > 0) {
            try {
              payload = JSON.parse(responseText) as unknown;
            } catch {
              payload = responseText;
            }
          }
          resolve({
            status: apiResponse.statusCode ?? 0,
            payload
          });
        });
      }
    );

    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error(`Timed out: ${requestUrl}`)));
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function normalizeTtsVoice(value: unknown): TtsVoiceRecord {
  if (typeof value === 'string') {
    return { id: value };
  }

  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    const id = typeof candidate.id === 'string'
      ? candidate.id
      : typeof candidate.voice === 'string'
        ? candidate.voice
        : typeof candidate.name === 'string'
          ? candidate.name
          : JSON.stringify(candidate);
    return {
      id,
      name: typeof candidate.name === 'string' ? candidate.name : undefined,
      description: typeof candidate.description === 'string' ? candidate.description : undefined,
      source: typeof candidate.source === 'string' ? candidate.source : undefined
    };
  }

  return { id: String(value) };
}

async function probeTtsRuntime(config: GatewayConfig): Promise<TtsStatusSnapshot> {
  const tts = config.serviceProfiles.gatewayChatPlatform.tts;
  if (!tts.enabled) {
    return {
      healthStatus: null,
      voices: []
    };
  }

  const baseUrl = normalizeBaseUrl(tts.baseUrl);
  const healthResponse = await requestJsonUrl(`${baseUrl}${tts.healthPath}`, 'GET');
  const voicesResponse = await requestJsonUrl(`${baseUrl}${tts.voicesPath}`, 'GET');

  return {
    healthStatus: healthResponse.status,
    voices: voicesResponse.payload
  };
}

async function listTtsVoices(config: GatewayConfig): Promise<TtsVoiceRecord[]> {
  const tts = config.serviceProfiles.gatewayChatPlatform.tts;
  if (!tts.enabled) {
    return [];
  }

  const baseUrl = normalizeBaseUrl(tts.baseUrl);
  const voicesResponse = await requestJsonUrl(`${baseUrl}${tts.voicesPath}`, 'GET');
  if (voicesResponse.status < 200 || voicesResponse.status >= 300) {
    throw new Error(`TTS voices request failed: ${voicesResponse.status}`);
  }

  const rawVoices = Array.isArray(voicesResponse.payload)
    ? voicesResponse.payload
    : Array.isArray((voicesResponse.payload as { voices?: unknown[] } | null)?.voices)
      ? (voicesResponse.payload as { voices: unknown[] }).voices
      : [];
  return rawVoices.map((voice) => normalizeTtsVoice(voice));
}

async function createTtsVoice(
  config: GatewayConfig,
  request: IncomingMessage
): Promise<{ status: number; payload: unknown }> {
  const tts = config.serviceProfiles.gatewayChatPlatform.tts;
  if (!tts.enabled) {
    throw new Error('TTS service is disabled');
  }

  const body = await readBodyBuffer(request);
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.includes('multipart/form-data')) {
    throw new Error('Expected multipart/form-data for voice creation');
  }

  const baseUrl = normalizeBaseUrl(tts.baseUrl);
  return requestBinaryUrl(`${baseUrl}${tts.voicesPath}`, 'POST', {
    'Content-Type': contentType,
    'Content-Length': body.length
  }, body);
}

async function deleteTtsVoice(config: GatewayConfig, voiceId: string): Promise<{ status: number; payload: unknown }> {
  const tts = config.serviceProfiles.gatewayChatPlatform.tts;
  if (!tts.enabled) {
    throw new Error('TTS service is disabled');
  }

  const baseUrl = normalizeBaseUrl(tts.baseUrl);
  return requestBinaryUrl(`${baseUrl}${tts.voicesPath}/${encodeURIComponent(voiceId)}`, 'DELETE', {});
}

export async function startAdminServer(options: AdminServerOptions): Promise<void> {
  const startedAtMs = Date.now();
  const htmlCache = new Map<string, string>();
  const minecraftUpdateScheduler = await loadMinecraftManualUpdateScheduler(options.configPath, options.buildOutDir);
  const remoteDeployJobs = new Map<string, RemoteDeployJobRecord>();
  const latestRemoteDeployJobByWorkload = new Map<string, string>();
  const REMOTE_DEPLOY_JOB_TTL_MS = 6 * 60 * 60 * 1000;
  const queueRemoteDeployJobPersist = (record: RemoteDeployJobRecord): void => {
    void persistRemoteDeployJobRecord(options.buildOutDir, record).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[deploy ${record.workloadId}] Failed to persist deploy job ${record.jobId}: ${message}`);
    });
  };

  const pruneRemoteDeployJobs = (): void => {
    const cutoff = Date.now() - REMOTE_DEPLOY_JOB_TTL_MS;
    for (const [jobId, job] of remoteDeployJobs.entries()) {
      const completedAtMs = job.completedAt ? new Date(job.completedAt).getTime() : null;
      if (completedAtMs !== null && Number.isFinite(completedAtMs) && completedAtMs < cutoff) {
        if (latestRemoteDeployJobByWorkload.get(job.workloadId) === jobId) {
          latestRemoteDeployJobByWorkload.delete(job.workloadId);
        }
        remoteDeployJobs.delete(jobId);
      }
    }
  };

  const startRemoteDeployJob = (workloadId: string, revision?: string): RemoteDeployJobRecord => {
    pruneRemoteDeployJobs();
    const jobId = randomUUID();
    const createdAt = new Date().toISOString();
    const deployLog: DeployTelemetryEntry[] = [];
    const record: RemoteDeployJobRecord = {
      jobId,
      workloadId,
      status: 'queued',
      createdAt,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      deployLog
    };
    remoteDeployJobs.set(jobId, record);
    latestRemoteDeployJobByWorkload.set(workloadId, jobId);
    queueRemoteDeployJobPersist(record);

    void (async () => {
      const t0 = Date.now();
      const logStep = (msg: string): void => {
        deployLog.push({ ts: Date.now() - t0, msg });
        queueRemoteDeployJobPersist(record);
      };

      record.status = 'running';
      record.startedAt = new Date().toISOString();
      queueRemoteDeployJobPersist(record);

      try {
        logStep('loading config');
        const config = await loadGatewayConfig(options.configPath);
        logStep('building artifacts');
        await buildArtifacts(config, options.buildOutDir);
        logStep('deploying workload');
        await deployRemoteWorkload(
          config,
          workloadId,
          options.buildOutDir,
          revision,
          { dryRun: false, log: logStep }
        );
        logStep('done');
        record.status = 'success';
        record.message = `Deployed remote workload ${workloadId}`;
        queueRemoteDeployJobPersist(record);
      } catch (deployError) {
        const msg = deployError instanceof Error ? deployError.message : String(deployError);
        const name = deployError instanceof Error ? deployError.constructor.name : 'unknown';
        logStep('FAILED: ' + msg);
        record.status = 'error';
        record.error = msg;
        record.errorType = name;
        record.failedStep = deployLog.length > 1 ? deployLog[deployLog.length - 2].msg : 'unknown';
        console.error(`[deploy ${workloadId}] Failed at step: ${record.failedStep}`);
        console.error(`[deploy ${workloadId}] ${name}: ${msg}`);
        if (deployError instanceof Error && deployError.stack) {
          console.error(deployError.stack);
        }
      } finally {
        record.completedAt = new Date().toISOString();
        record.durationMs = Date.now() - t0;
        queueRemoteDeployJobPersist(record);
      }
    })();

    return record;
  };

  const server = createServer(async (request, response) => {
    try {
      const path = getRequestPath(request);
      const basePath = getForwardedBasePath(request);

      if (request.method === 'GET' && path === '/') {
        let cached = htmlCache.get(basePath);
        if (!cached) {
          cached = htmlPage(basePath);
          htmlCache.set(basePath, cached);
        }
        sendHtml(response, cached);
        return;
      }

      if (request.method === 'GET' && path === '/healthz') {
        sendText(response, 200, 'ok\n');
        return;
      }

      const workflowIdMatch = path.match(/^\/api\/workflows\/([^/]+)$/);
      const workflowActionMatch = path.match(/^\/api\/workflows\/([^/]+)\/(enable|disable|sleep|resume|run)$/);
      const agentRunMatch = path.match(/^\/api\/chat-platform\/agents\/([^/]+)\/run$/);
      const appDeployMatch = path.match(/^\/api\/apps\/([^/]+)\/deploy$/);
      const remoteWorkloadDeployMatch = path.match(/^\/api\/remote-workloads\/([^/]+)\/deploy$/);
      const remoteWorkloadDeployJobMatch = path.match(/^\/api\/remote-workloads\/([^/]+)\/deploy-jobs\/([^/]+)$/);
      const remoteWorkloadLatestDeployJobMatch = path.match(/^\/api\/remote-workloads\/([^/]+)\/deploy-jobs\/latest$/);
      const remoteWorkloadStatusMatch = path.match(/^\/api\/remote-workloads\/([^/]+)\/status$/);
      const remoteServiceStatusMatch = path.match(/^\/api\/remote-workloads\/([^/]+)\/service-status$/);
      const remoteServiceLogsMatch = path.match(/^\/api\/remote-workloads\/([^/]+)\/service-logs$/);
      const remoteServiceActionMatch = path.match(/^\/api\/remote-workloads\/([^/]+)\/service\/(start|stop|restart)$/);
      const remoteMinecraftActionMatch = path.match(/^\/api\/remote-workloads\/([^/]+)\/minecraft\/(start|stop|restart|broadcast|kick|ban|update-if-empty|force-update)$/);
      const remoteMinecraftUpdateRequestMatch = path.match(/^\/api\/remote-workloads\/([^/]+)\/minecraft\/update-request$/);
      const projectTrackingUpdatesMatch = path.match(/^\/api\/project-tracking\/projects\/([^/]+)\/updates$/);


      if (request.method === 'GET' && path === '/api/config') {
        const config = await loadGatewayConfig(options.configPath);
        sendJson(response, 200, config);
        return;
      }

      if (request.method === 'GET' && path === '/api/runtime') {
        const config = await loadGatewayConfig(options.configPath);
        sendJson(response, 200, createRuntimeSnapshot(config, options, startedAtMs));
        return;
      }

      if (request.method === 'GET' && path === '/api/app-slots') {
        const config = await loadGatewayConfig(options.configPath);
        const slots: Record<string, string> = {};
        for (const app of config.apps) {
          slots[app.id] = await detectActiveAppSlot(app);
        }
        sendJson(response, 200, slots);
        return;
      }

      if (request.method === 'GET' && path === '/api/service-profiles/pi-proxy/status') {
        const config = await loadGatewayConfig(options.configPath);
        sendJson(response, 200, await getPiProxyServiceStatus(config));
        return;
      }

      if (request.method === 'GET' && path === '/api/service-profiles/kulrs-activity/status') {
        const config = await loadGatewayConfig(options.configPath);
        sendJson(response, 200, await getKulrsActivityRuntimeStatus(config));
        return;
      }

      if (request.method === 'GET' && path === '/api/service-profiles/kulrs-activity/logs') {
        const config = await loadGatewayConfig(options.configPath);
        const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
        const tailParam = url.searchParams.get('tail');
        const tailLines = tailParam ? Math.max(20, Math.min(1000, Number.parseInt(tailParam, 10) || 200)) : 200;
        sendJson(response, 200, await getKulrsActivityLogs(config, tailLines));
        return;
      }

      if (request.method === 'POST' && path === '/api/service-profiles/pi-proxy/deploy') {
        const config = await loadGatewayConfig(options.configPath);
        await buildArtifacts(config, options.buildOutDir);
        await deployPiProxyService(config, options.buildOutDir, { dryRun: false, log: () => undefined });
        sendJson(response, 200, { message: `Deployed Pi proxy to node ${config.serviceProfiles.piProxy.nodeId}` });
        return;
      }

      if (request.method === 'POST' && path === '/api/service-profiles/pi-proxy/restart') {
        const config = await loadGatewayConfig(options.configPath);
        await restartPiProxyService(config, { dryRun: false, log: () => undefined });
        sendJson(response, 200, { message: `Restarted Pi proxy service on node ${config.serviceProfiles.piProxy.nodeId}` });
        return;
      }

      if (request.method === 'GET') {
        const config = await loadGatewayConfig(options.configPath);
        if (path === config.serviceProfiles.piProxy.registryPath) {
          if (!config.serviceProfiles.piProxy.enabled) {
            throw new Error('piProxy service profile is disabled');
          }
          sendJson(response, 200, await buildPiProxyRegistry(config));
          return;
        }
      }

      if (request.method === 'GET' && path === '/api/chat-platform/providers/status') {
        const config = await loadGatewayConfig(options.configPath);
        const providers = await listChatProviders(config);
        sendJson(response, 200, { providers });
        return;
      }

      const providerModelsMatch = path.match(/^\/api\/chat-platform\/providers\/([^/]+)\/models$/);
      if (providerModelsMatch && request.method === 'GET') {
        const config = await loadGatewayConfig(options.configPath);
        const providerName = decodeURIComponent(providerModelsMatch[1]);
        const models = await listChatProviderModels(config, providerName);
        sendJson(response, 200, { provider: providerName, models });
        return;
      }

      if (request.method === 'GET' && path === '/api/tts/status') {
        const config = await loadGatewayConfig(options.configPath);
        const status = await probeTtsRuntime(config);
        sendJson(response, 200, status);
        return;
      }

      if (request.method === 'GET' && path === '/api/tts/voices') {
        const config = await loadGatewayConfig(options.configPath);
        const voices = await listTtsVoices(config);
        sendJson(response, 200, { voices });
        return;
      }

      if (request.method === 'POST' && path === '/api/tts/voices') {
        const config = await loadGatewayConfig(options.configPath);
        const result = await createTtsVoice(config, request);
        sendJson(response, result.status, {
          message: 'Created TTS voice',
          result: result.payload
        });
        return;
      }

      const ttsVoiceDeleteMatch = path.match(/^\/api\/tts\/voices\/([^/]+)$/);
      if (ttsVoiceDeleteMatch && request.method === 'DELETE') {
        const config = await loadGatewayConfig(options.configPath);
        const result = await deleteTtsVoice(config, decodeURIComponent(ttsVoiceDeleteMatch[1]));
        if (result.status === 204 || result.payload === null) {
          response.statusCode = result.status;
          response.end();
          return;
        }
        sendJson(response, result.status, result.payload);
        return;
      }

      if (request.method === 'GET' && path === '/api/workflows') {
        const config = await loadGatewayConfig(options.configPath);
        const result = await proxyWorkflowRequest(config, '/api/workflows', 'GET');
        sendJson(response, result.status, result.payload);
        return;
      }

      if (request.method === 'GET' && path === '/api/jobs') {
        const config = await loadGatewayConfig(options.configPath);
        const result = await proxyGatewayApiRequest(config, '/api/jobs', 'GET');
        sendJson(response, result.status, result.payload);
        return;
      }

      if (request.method === 'POST' && path === '/api/workflows') {
        const config = await loadGatewayConfig(options.configPath);
        const body = JSON.parse(await readBody(request)) as unknown;
        const result = await proxyWorkflowRequest(config, '/api/workflows', 'POST', body);
        sendJson(response, result.status, result.payload);
        return;
      }

      if (workflowIdMatch && request.method === 'GET') {
        const config = await loadGatewayConfig(options.configPath);
        const result = await proxyWorkflowRequest(config, path, 'GET');
        sendJson(response, result.status, result.payload);
        return;
      }

      if (workflowIdMatch && request.method === 'PUT') {
        const config = await loadGatewayConfig(options.configPath);
        const body = JSON.parse(await readBody(request)) as unknown;
        const result = await proxyWorkflowRequest(config, path, 'PUT', body);
        sendJson(response, result.status, result.payload);
        return;
      }

      if (workflowIdMatch && request.method === 'DELETE') {
        const config = await loadGatewayConfig(options.configPath);
        const result = await proxyWorkflowRequest(config, path, 'DELETE');
        if (result.payload === null) {
          response.statusCode = result.status;
          response.end();
          return;
        }
        sendJson(response, result.status, result.payload);
        return;
      }

      if (workflowActionMatch && request.method === 'POST') {
        const config = await loadGatewayConfig(options.configPath);
        const body = workflowActionMatch[2] === 'sleep'
          ? JSON.parse(await readBody(request)) as unknown
          : undefined;
        const result = await proxyWorkflowRequest(config, path, 'POST', body);
        sendJson(response, result.status, result.payload);
        return;
      }

      if (request.method === 'POST' && path === '/api/service-profiles/gateway-chat-platform/sync') {
        const config = await loadGatewayConfig(options.configPath);
        await syncServiceProfileRuntime(
          config,
          config.serviceProfiles.gatewayChatPlatform.appId,
          { dryRun: false, log: () => undefined },
          config.serviceProfiles.gatewayChatPlatform.apiBaseUrl
        );
        sendJson(response, 200, { message: 'Synced gateway-chat-platform agents' });
        return;
      }

      if (agentRunMatch && request.method === 'POST') {
        const config = await loadGatewayConfig(options.configPath);
        const body = JSON.parse(await readBody(request)) as AgentRunPayload;
        const result = await runServiceProfileAgent(
          config,
          config.serviceProfiles.gatewayChatPlatform.appId,
          decodeURIComponent(agentRunMatch[1]),
          body,
          { dryRun: false, log: () => undefined },
          config.serviceProfiles.gatewayChatPlatform.apiBaseUrl
        );
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && path === '/api/workflow-seeds/import') {
        const config = await loadGatewayConfig(options.configPath);
        const body = JSON.parse(await readBody(request)) as { filePath?: string };
        const result = await importWorkflowSeed(
          config.serviceProfiles.gatewayApi.apiBaseUrl,
          body.filePath || DEFAULT_WORKFLOW_SEED_PATH,
          { dryRun: false, log: () => undefined },
          getGatewayApiAuthHeaders(config)
        );
        sendJson(response, 200, {
          message: `Imported ${result.operations.length} workflow seed entries from ${result.filePath}`,
          operations: result.operations
        });
        return;
      }

      if (appDeployMatch && request.method === 'POST') {
        const appId = decodeURIComponent(appDeployMatch[1]);
        const deployLog: { ts: number; msg: string }[] = [];
        const t0 = Date.now();
        const logStep = (msg: string) => { deployLog.push({ ts: Date.now() - t0, msg }); };
        try {
          logStep('loading config');
          const config = await loadGatewayConfig(options.configPath);
          logStep('parsing body');
          const body = JSON.parse(await readBody(request) || '{}') as { revision?: string };
          logStep('building artifacts');
          await buildArtifacts(config, options.buildOutDir);
          logStep('dispatching GitHub deploy workflow');
          const workflowResult = await triggerManagedAppDeployWorkflow(
            config,
            appId,
            typeof body.revision === 'string' && body.revision.trim().length > 0 ? body.revision.trim() : undefined,
            logStep
          );
          logStep('done');
          sendJson(response, 200, {
            message: `Triggered deploy workflow for managed app ${appId}`,
            workflowUrl: workflowResult.workflowUrl,
            repository: `${workflowResult.owner}/${workflowResult.repo}`,
            durationMs: Date.now() - t0,
            deployLog
          });
        } catch (deployError) {
          const msg = deployError instanceof Error ? deployError.message : String(deployError);
          const name = deployError instanceof Error ? deployError.constructor.name : 'unknown';
          logStep('FAILED: ' + msg);
          console.error(`[deploy app ${appId}] Failed at step: ${deployLog[deployLog.length - 2]?.msg || '?'}`);
          console.error(`[deploy app ${appId}] ${name}: ${msg}`);
          if (deployError instanceof Error && deployError.stack) {
            console.error(deployError.stack);
          }
          sendJson(response, 400, {
            error: msg,
            failedStep: deployLog.length > 1 ? deployLog[deployLog.length - 2].msg : 'unknown',
            errorType: name,
            durationMs: Date.now() - t0,
            deployLog
          });
        }
        return;
      }

      if (remoteWorkloadDeployMatch && request.method === 'POST') {
        const workloadId = decodeURIComponent(remoteWorkloadDeployMatch[1]);
        const body = JSON.parse(await readBody(request) || '{}') as { revision?: string };
        const job = startRemoteDeployJob(
          workloadId,
          typeof body.revision === 'string' && body.revision.trim().length > 0 ? body.revision.trim() : undefined
        );
        sendJson(response, 202, {
          message: `Queued deploy for remote workload ${workloadId}`,
          jobId: job.jobId,
          status: job.status
        });
        return;
      }

      if (remoteWorkloadDeployJobMatch && request.method === 'GET') {
        const workloadId = decodeURIComponent(remoteWorkloadDeployJobMatch[1]);
        const jobId = decodeURIComponent(remoteWorkloadDeployJobMatch[2]);
        const job = remoteDeployJobs.get(jobId) || await loadPersistedRemoteDeployJobRecord(options.buildOutDir, jobId);
        if (!job || job.workloadId !== workloadId) {
          sendJson(response, 404, { error: `Deploy job not found for remote workload ${workloadId}` });
          return;
        }
        if (!remoteDeployJobs.has(jobId)) {
          remoteDeployJobs.set(jobId, job);
        }
        latestRemoteDeployJobByWorkload.set(workloadId, jobId);
        sendJson(response, 200, job);
        return;
      }

      if (remoteWorkloadLatestDeployJobMatch && request.method === 'GET') {
        const workloadId = decodeURIComponent(remoteWorkloadLatestDeployJobMatch[1]);
        const jobId = latestRemoteDeployJobByWorkload.get(workloadId) || null;
        const job = (jobId ? remoteDeployJobs.get(jobId) || await loadPersistedRemoteDeployJobRecord(options.buildOutDir, jobId) : null)
          || await loadLatestPersistedRemoteDeployJobRecord(options.buildOutDir, workloadId);
        if (!job || job.workloadId !== workloadId) {
          if (jobId) {
            latestRemoteDeployJobByWorkload.delete(workloadId);
          }
          sendJson(response, 404, { error: `No deploy job found for remote workload ${workloadId}` });
          return;
        }
        remoteDeployJobs.set(job.jobId, job);
        latestRemoteDeployJobByWorkload.set(workloadId, job.jobId);
        sendJson(response, 200, job);
        return;
      }

      if (remoteWorkloadStatusMatch && request.method === 'GET') {
        const config = await loadGatewayConfig(options.configPath);
        const status = await getMinecraftWorkloadStatus(
          config,
          decodeURIComponent(remoteWorkloadStatusMatch[1])
        );
        sendJson(response, 200, {
          ...status,
          manualUpdate: minecraftUpdateScheduler.state.updates[decodeURIComponent(remoteWorkloadStatusMatch[1])] || null
        });
        return;
      }

      if (remoteServiceStatusMatch && request.method === 'GET') {
        const config = await loadGatewayConfig(options.configPath);
        const status = await getContainerServiceWorkloadStatus(
          config,
          decodeURIComponent(remoteServiceStatusMatch[1])
        );
        sendJson(response, 200, status);
        return;
      }

      if (remoteServiceLogsMatch && request.method === 'GET') {
        const config = await loadGatewayConfig(options.configPath);
        const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
        const service = url.searchParams.get('service') || undefined;
        const tail = Math.min(Math.max(parseInt(url.searchParams.get('tail') || '100', 10) || 100, 10), 500);
        const logs = await getContainerServiceLogs(config, decodeURIComponent(remoteServiceLogsMatch[1]), service, tail);
        sendJson(response, 200, logs);
        return;
      }

      if (remoteServiceActionMatch && request.method === 'POST') {
        const config = await loadGatewayConfig(options.configPath);
        await controlContainerServiceWorkload(
          config,
          decodeURIComponent(remoteServiceActionMatch[1]),
          remoteServiceActionMatch[2] as 'start' | 'stop' | 'restart',
          { dryRun: false, log: () => undefined }
        );
        sendJson(response, 200, { message: `Container service action completed: ${remoteServiceActionMatch[2]}` });
        return;
      }

      if (remoteMinecraftActionMatch && request.method === 'POST') {
        const config = await loadGatewayConfig(options.configPath);
        const body = JSON.parse(await readBody(request) || '{}') as { message?: string; player?: string; reason?: string };
        await controlMinecraftWorkload(
          config,
          decodeURIComponent(remoteMinecraftActionMatch[1]),
          remoteMinecraftActionMatch[2] as 'start' | 'stop' | 'restart' | 'broadcast' | 'kick' | 'ban' | 'update-if-empty' | 'force-update',
          body,
          { dryRun: false, log: () => undefined }
        );
        sendJson(response, 200, { message: `Minecraft action completed: ${remoteMinecraftActionMatch[2]}` });
        return;
      }

      if (remoteMinecraftUpdateRequestMatch && request.method === 'POST') {
        const workloadId = decodeURIComponent(remoteMinecraftUpdateRequestMatch[1]);
        const body = JSON.parse(await readBody(request) || '{}') as {
          mode?: 'now' | 'minutes' | 'at';
          delayMinutes?: number;
          runAt?: string;
        };
        const mode = body.mode === 'minutes' || body.mode === 'at' ? body.mode : 'now';
        if (mode === 'minutes') {
          const delayMinutes = Number(body.delayMinutes);
          if (!Number.isFinite(delayMinutes) || delayMinutes < 0) {
            throw new Error('delayMinutes must be a non-negative number');
          }
          const record = await queueMinecraftManualUpdate(
            minecraftUpdateScheduler,
            workloadId,
            'minutes',
            new Date(Date.now() + delayMinutes * 60_000).toISOString(),
            delayMinutes
          );
          sendJson(response, 200, { message: `Queued Bedrock update in ${delayMinutes} minute(s)`, manualUpdate: record });
          return;
        }

        if (mode === 'at') {
          if (typeof body.runAt !== 'string' || body.runAt.trim().length === 0) {
            throw new Error('runAt is required for mode=at');
          }
          const runAt = new Date(body.runAt);
          if (Number.isNaN(runAt.getTime())) {
            throw new Error(`Invalid runAt: ${body.runAt}`);
          }
          const record = await queueMinecraftManualUpdate(
            minecraftUpdateScheduler,
            workloadId,
            'at',
            runAt.toISOString(),
            null
          );
          sendJson(response, 200, { message: `Queued Bedrock update for ${runAt.toISOString()}`, manualUpdate: record });
          return;
        }

        const record = await queueMinecraftManualUpdate(
          minecraftUpdateScheduler,
          workloadId,
          'now',
          new Date().toISOString(),
          null
        );
        sendJson(response, 200, { message: 'Triggered Bedrock update now', manualUpdate: record });
        return;
      }

      if (remoteMinecraftUpdateRequestMatch && request.method === 'DELETE') {
        const workloadId = decodeURIComponent(remoteMinecraftUpdateRequestMatch[1]);
        const record = await cancelMinecraftManualUpdate(minecraftUpdateScheduler, workloadId);
        if (!record) {
          sendJson(response, 200, { message: 'No pending Bedrock update to cancel', manualUpdate: null });
          return;
        }
        sendJson(response, 200, { message: 'Cancelled pending Bedrock update', manualUpdate: record });
        return;
      }

      if (request.method === 'POST' && path === '/api/nodes/setup') {
        const body = JSON.parse(await readBody(request)) as NodeSetupRequest;
        if (!body.nodeId || !body.host || !body.adminUser) {
          sendJson(response, 400, { error: 'nodeId, host, and adminUser are required' });
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        const sendEvent = (data: unknown): void => {
          response.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        try {
          await bootstrapWorkerNode(body, (progress) => {
            sendEvent(progress);
          });
        } catch (error) {
          sendEvent({
            step: 'error',
            status: 'error',
            message: error instanceof Error ? error.message : String(error)
          });
        }
        response.end();
        return;
      }

      if (request.method === 'POST' && path === '/api/validate') {
        const config = await loadRequestConfig(request);
        sendJson(response, 200, { message: 'Config is valid', config });
        return;
      }

      if (request.method === 'POST' && path === '/api/restart') {
        sendJson(response, 200, { message: 'Restarting…' });
        setTimeout(() => process.exit(0), 500);
        return;
      }

      if (request.method === 'POST' && path === '/api/config') {
        const config = await loadRequestConfig(request);
        await saveGatewayConfig(options.configPath, config);
        sendJson(response, 200, { message: `Saved ${options.configPath}`, config });
        return;
      }

      if (request.method === 'POST' && path === '/api/personal-assistant/apply') {
        const config = await loadGatewayConfig(options.configPath);
        const profile = config.personalAssistant;
        if (!profile.enabled) {
          throw new Error('personalAssistant.enabled must be true before applying the coach setup');
        }
        if (!config.serviceProfiles.gatewayChatPlatform.enabled) {
          throw new Error('gatewayChatPlatform service profile must be enabled before applying the coach setup');
        }
        if (!config.serviceProfiles.gatewayApi.enabled) {
          throw new Error('gatewayApi service profile must be enabled before applying the coach setup');
        }

        const appliedAt = new Date().toISOString();
        profile.lastAppliedAt = appliedAt;
        const managedAgentIds = upsertManagedAssistantAgents(config, profile);
        await saveGatewayConfig(options.configPath, config);

        const planFile = await writePersonalAssistantPlanFile(profile);
        const workflowSeeds = buildPersonalAssistantWorkflowSeeds(profile);
        const existingWorkflowsResponse = await proxyWorkflowRequest(config, '/api/workflows', 'GET');
        if (existingWorkflowsResponse.status !== 200 || !Array.isArray(existingWorkflowsResponse.payload)) {
          throw new Error('Failed to load existing workflows before applying the coach setup');
        }
        const workflowOperations = planWorkflowSeedImport(existingWorkflowsResponse.payload as WorkflowRecord[], workflowSeeds);
        for (const operation of workflowOperations) {
          const result = operation.type === 'create'
            ? await proxyWorkflowRequest(config, '/api/workflows', 'POST', operation.body)
            : await proxyWorkflowRequest(config, `/api/workflows/${operation.id}`, 'PUT', operation.body);
          if (result.status < 200 || result.status >= 300) {
            throw new Error(`Failed to ${operation.type} workflow ${operation.name}`);
          }
        }

        let syncedProjectCount = 0;
        if (config.monitoring?.enabled) {
          const projectUpserts = buildProjectTrackingUpserts(profile);
          for (const input of projectUpserts) {
            await upsertProjectTrackingProject(input);
          }
          syncedProjectCount = projectUpserts.length;
        }

        await syncServiceProfileRuntime(
          config,
          config.serviceProfiles.gatewayChatPlatform.appId,
          { dryRun: false, log: () => undefined },
          config.serviceProfiles.gatewayChatPlatform.apiBaseUrl
        );

        sendJson(response, 200, {
          message: `Applied ${profile.assistantName} setup`,
          appliedAt,
          managedAgentIds,
          workflowOperations,
          syncedProjectCount,
          monitoringEnabled: Boolean(config.monitoring?.enabled),
          planFile,
          config
        });
        return;
      }

      if (request.method === 'POST' && path === '/api/build') {
        const config = await loadRequestConfig(request);
        await saveGatewayConfig(options.configPath, config);
        await buildArtifacts(config, options.buildOutDir);
        sendJson(response, 200, {
          message: `Saved ${options.configPath} and rendered artifacts into ${options.buildOutDir}`,
          config
        });
        return;
      }

      // ── Monitoring API endpoints ──

      if (request.method === 'GET' && path === '/api/project-tracking/overview') {
        try {
          const config = await loadGatewayConfig(options.configPath);
          if (!config.monitoring?.enabled) {
            sendJson(response, 200, createEmptyProjectTrackingOverview());
            return;
          }
          await ensureMonitoringReady(config);
          sendJson(response, 200, await getProjectTrackingOverview());
        } catch (error) {
          console.warn('[project-tracking] overview unavailable:', error instanceof Error ? error.message : error);
          sendJson(response, 200, createEmptyProjectTrackingOverview());
        }
        return;
      }

      if (request.method === 'POST' && path === '/api/project-tracking/projects') {
        const config = await loadGatewayConfig(options.configPath);
        if (!config.monitoring?.enabled) {
          sendJson(response, 400, { error: 'Monitoring is not enabled. Enable it in Monitoring Settings, Save, then Restart.' });
          return;
        }

        const body = JSON.parse(await readBody(request) || '{}') as {
          projectId?: string;
          name?: string;
          status?: string;
          priority?: string;
          summary?: string;
          nextAction?: string;
          notesRepoPath?: string;
          planFilePath?: string;
          metadata?: Record<string, unknown> | null;
          lastCheckInAt?: string | null;
          milestones?: Array<{
            id?: string;
            title?: string;
            status?: string;
            targetDate?: string | null;
            sortOrder?: number;
            notes?: string;
          }>;
          update?: {
            source?: string;
            kind?: string;
            summary?: string;
            details?: Record<string, unknown> | null;
            createdAt?: string | null;
          };
        };

        if (!body.projectId || !body.name) {
          sendJson(response, 400, { error: 'projectId and name are required' });
          return;
        }

        await ensureMonitoringReady(config);
        await upsertProjectTrackingProject({
          projectId: body.projectId,
          name: body.name,
          status: body.status,
          priority: body.priority,
          summary: body.summary,
          nextAction: body.nextAction,
          notesRepoPath: body.notesRepoPath,
          planFilePath: body.planFilePath,
          metadata: body.metadata,
          lastCheckInAt: body.lastCheckInAt,
          milestones: Array.isArray(body.milestones)
            ? body.milestones
                .filter((milestone) => milestone && typeof milestone.title === 'string' && milestone.title.trim().length > 0)
                .map((milestone, index) => ({
                  id: milestone.id,
                  title: milestone.title!,
                  status: milestone.status,
                  targetDate: milestone.targetDate ?? null,
                  sortOrder: typeof milestone.sortOrder === 'number' ? milestone.sortOrder : index,
                  notes: milestone.notes,
                }))
            : undefined,
          update: body.update?.summary
            ? {
                source: body.update.source,
                kind: body.update.kind,
                summary: body.update.summary,
                details: body.update.details,
                createdAt: body.update.createdAt ?? null,
              }
            : undefined,
        });
        sendJson(response, 200, { message: `Tracked project ${body.projectId} updated` });
        return;
      }

      if (projectTrackingUpdatesMatch && request.method === 'POST') {
        const config = await loadGatewayConfig(options.configPath);
        if (!config.monitoring?.enabled) {
          sendJson(response, 400, { error: 'Monitoring is not enabled. Enable it in Monitoring Settings, Save, then Restart.' });
          return;
        }

        const projectId = decodeURIComponent(projectTrackingUpdatesMatch[1]);
        const body = JSON.parse(await readBody(request) || '{}') as {
          name?: string;
          status?: string;
          priority?: string;
          summary?: string;
          nextAction?: string;
          source?: string;
          kind?: string;
          details?: Record<string, unknown> | null;
          createdAt?: string | null;
          lastCheckInAt?: string | null;
        };

        if (!body.name) {
          sendJson(response, 400, { error: 'name is required' });
          return;
        }

        await ensureMonitoringReady(config);
        await upsertProjectTrackingProject({
          projectId,
          name: body.name,
          status: body.status,
          priority: body.priority,
          summary: body.summary,
          nextAction: body.nextAction,
          lastCheckInAt: body.lastCheckInAt,
          update: body.summary
            ? {
                source: body.source,
                kind: body.kind,
                summary: body.summary,
                details: body.details,
                createdAt: body.createdAt ?? null,
              }
            : undefined,
        });
        sendJson(response, 200, { message: `Tracked project ${projectId} check-in recorded` });
        return;
      }

      if (request.method === 'GET' && path === '/api/monitoring/health') {
        const cached = await getCachedHealthSnapshot();
        if (cached) {
          sendJson(response, 200, cached);
          return;
        }
        // No cached snapshot — try to build one live
        try {
          const config = await loadGatewayConfig(options.configPath);
          if (!config.monitoring?.enabled) {
            sendJson(response, 200, { targets: [], collectedAt: new Date().toISOString() });
            return;
          }
          // Ensure pool is ready
          try { getPool(); } catch {
            await initMetrics(config.monitoring);
          }
          const targets = buildMonitoringTargets(config);
          const snapshot = await buildHealthSnapshot(targets);
          sendJson(response, 200, snapshot);
        } catch {
          sendJson(response, 200, { targets: [], collectedAt: new Date().toISOString() });
        }
        return;
      }

      if (request.method === 'POST' && path === '/api/monitoring/health/check') {
        const config = await loadGatewayConfig(options.configPath);
        if (!config.monitoring?.enabled) {
          sendJson(response, 400, { error: 'Monitoring is not enabled. Enable it in Monitoring Settings, Save, then Restart.' });
          return;
        }
        try {
          await ensureMonitoringReady(config);
        } catch (initErr) {
          sendJson(response, 500, { error: `Failed to connect to monitoring backend: ${initErr instanceof Error ? initErr.message : initErr}` });
          return;
        }
        const targets = buildMonitoringTargets(config);
        const probe = createHealthProbe(config);
        const results = await probe();
        for (const r of results) {
          await recordHealthCheck(r.kind, r.id, r.status, r.responseTimeMs, r.details);
        }
        const snapshot = await buildHealthSnapshot(targets);
        sendJson(response, 200, snapshot);
        return;
      }

      if (request.method === 'GET' && path.startsWith('/api/monitoring/health/history')) {
        const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
        const kind = url.searchParams.get('kind') || '';
        const id = url.searchParams.get('id') || '';
        const hours = parseInt(url.searchParams.get('hours') || '24') || 24;
        if (!kind || !id) {
          sendJson(response, 400, { error: 'kind and id query params required' });
          return;
        }
        const rows = await getHealthHistory(kind, id, hours);
        sendJson(response, 200, { rows });
        return;
      }

      if (request.method === 'GET' && path === '/api/monitoring/benchmarks') {
        const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
        const suiteId = url.searchParams.get('suite') || undefined;
        const runs = await getBenchmarkRuns(suiteId);
        sendJson(response, 200, { runs });
        return;
      }

      if (request.method === 'POST' && path === '/api/monitoring/benchmarks') {
        const body = JSON.parse(await readBody(request)) as {
          suiteId: string; name: string; engine: string;
          config?: Record<string, unknown>; hardware?: string; notes?: string;
        };
        const runId = await createBenchmarkRun(
          body.suiteId, body.name, body.engine,
          body.config || {}, body.hardware || '', body.notes || ''
        );
        sendJson(response, 200, { message: 'Benchmark run created', runId });
        return;
      }

      const benchmarkRunIdMatch = path.match(/^\/api\/monitoring\/benchmarks\/(\d+)$/);

      if (benchmarkRunIdMatch && request.method === 'DELETE') {
        await deleteBenchmarkRun(parseInt(benchmarkRunIdMatch[1]));
        sendJson(response, 200, { message: 'Benchmark run deleted' });
        return;
      }

      if (benchmarkRunIdMatch && request.method === 'POST') {
        const runId = parseInt(benchmarkRunIdMatch[1]);
        const body = JSON.parse(await readBody(request)) as {
          action?: string; testName?: string; metric?: string; value?: number; unit?: string;
        };
        if (body.action === 'finish') {
          await finishBenchmarkRun(runId);
          sendJson(response, 200, { message: 'Benchmark run finished' });
          return;
        }
        if (body.testName && body.metric && body.value !== undefined) {
          await addBenchmarkResult(runId, body.testName, body.metric, body.value, body.unit || '');
          sendJson(response, 200, { message: 'Benchmark result added' });
          return;
        }
        sendJson(response, 400, { error: 'Invalid benchmark action' });
        return;
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // ── Monitoring init ──

  function buildMonitoringTargets(config: GatewayConfig): Array<{ kind: string; id: string; label: string }> {
    const targets: Array<{ kind: string; id: string; label: string }> = [];
    for (const node of config.workerNodes) {
      if (!node.enabled) continue;
      targets.push({ kind: 'node', id: node.id, label: `${node.id} (${node.host})` });
    }
    for (const app of config.apps) {
      if (!app.enabled) continue;
      targets.push({ kind: 'app', id: app.id, label: app.id });
    }
    for (const w of config.remoteWorkloads) {
      if (!w.enabled) continue;
      targets.push({ kind: 'workload', id: w.id, label: `${w.id} (${w.kind})` });
    }
    return targets;
  }

  function createHealthProbe(config: GatewayConfig): HealthProbeFunction {
    return async () => {
      const results: Array<{ kind: string; id: string; label: string; status: string; responseTimeMs: number | null; details: Record<string, unknown> | null }> = [];

      // Probe worker nodes via SSH
      for (const node of config.workerNodes) {
        if (!node.enabled) continue;
        const t0 = Date.now();
        try {
          const { execSync } = await import('node:child_process');
          execSync(`ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -p ${node.sshPort} ${node.sshUser}@${node.host} echo ok`, { timeout: 10_000, stdio: 'pipe' });
          results.push({ kind: 'node', id: node.id, label: `${node.id} (${node.host})`, status: 'healthy', responseTimeMs: Date.now() - t0, details: null });
        } catch {
          results.push({ kind: 'node', id: node.id, label: `${node.id} (${node.host})`, status: 'down', responseTimeMs: Date.now() - t0, details: null });
        }
      }

      // Probe apps via health endpoint (try active slot, fall back to opposite)
      for (const app of config.apps) {
        if (!app.enabled) continue;
        let activeSlot: 'blue' | 'green' = 'blue';
        try { activeSlot = await readCurrentSlot(app); } catch { /* default blue */ }

        // Try active slot first, then opposite (handles container not having /srv/apps mounted)
        const slotsToTry: Array<'blue' | 'green'> = [activeSlot, activeSlot === 'blue' ? 'green' : 'blue'];
        let probed = false;
        for (const slotName of slotsToTry) {
          const slot = app.slots[slotName];
          const url = `http://127.0.0.1:${slot.port}${app.healthPath}`;
          const t0 = Date.now();
          try {
            const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
            results.push({
              kind: 'app', id: app.id, label: app.id,
              status: resp.ok ? 'healthy' : 'degraded',
              responseTimeMs: Date.now() - t0,
              details: { statusCode: resp.status, url, slot: slotName }
            });
            probed = true;
            break;
          } catch {
            // If this was the last slot to try, record the failure
            if (slotName === slotsToTry[slotsToTry.length - 1]) {
              results.push({ kind: 'app', id: app.id, label: app.id, status: 'down', responseTimeMs: Date.now() - t0, details: { url, slot: slotName } });
              probed = true;
            }
            // Otherwise try the next slot
          }
        }
        if (!probed) {
          results.push({ kind: 'app', id: app.id, label: app.id, status: 'down', responseTimeMs: 0, details: null });
        }
      }

      // Probe container-service workloads via their status
      for (const w of config.remoteWorkloads) {
        if (!w.enabled || w.kind !== 'container-service') continue;
        const t0 = Date.now();
        try {
          const status = await getContainerServiceWorkloadStatus(config, w.id);
          // status.service is the primary service status; status.containers is the per-container list (repo-compose)
          const isHealthy = status.service?.running === true;
          results.push({
            kind: 'workload', id: w.id, label: `${w.id} (${w.kind})`,
            status: isHealthy ? 'healthy' : 'degraded',
            responseTimeMs: Date.now() - t0,
            details: { service: status.service, containers: status.containers ?? null }
          });
        } catch {
          results.push({ kind: 'workload', id: w.id, label: `${w.id} (${w.kind})`, status: 'down', responseTimeMs: Date.now() - t0, details: null });
        }
      }

      // Probe minecraft-bedrock-server workloads via their status
      for (const w of config.remoteWorkloads) {
        if (!w.enabled || w.kind !== 'minecraft-bedrock-server') continue;
        const t0 = Date.now();
        try {
          const status = await getMinecraftWorkloadStatus(config, w.id);
          // status.server is the container inspect result with .running and .status
          const isHealthy = status.server?.running === true;
          results.push({
            kind: 'workload', id: w.id, label: `${w.id} (${w.kind})`,
            status: isHealthy ? 'healthy' : 'down',
            responseTimeMs: Date.now() - t0,
            details: { server: status.server, worker: status.worker }
          });
        } catch {
          results.push({ kind: 'workload', id: w.id, label: `${w.id} (${w.kind})`, status: 'down', responseTimeMs: Date.now() - t0, details: null });
        }
      }

      return results;
    };
  }

  // Start monitoring if enabled in config
  try {
    const config = await loadGatewayConfig(options.configPath);
    if (config.monitoring?.enabled) {
      await initMetrics(config.monitoring);
      const probe = createHealthProbe(config);
      startHealthCollector(config.monitoring.healthCheckIntervalSeconds, probe);
      console.log('[monitoring] Health collector started');
    }
  } catch (err) {
    console.error('[monitoring] Failed to initialize:', err instanceof Error ? err.message : err);
  }

  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host, () => {
      console.log(`Gateway admin UI listening on http://${options.host}:${options.port}`);
      resolve();
    });
  });
}
