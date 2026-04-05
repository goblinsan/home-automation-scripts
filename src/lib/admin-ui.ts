import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { buildArtifacts } from './build.ts';
import { getAllScheduledJobs, getWorkerNode, loadGatewayConfig, parseGatewayConfig, saveGatewayConfig, type GatewayConfig } from './config.ts';
import {
  bootstrapWorkerNode,
  controlContainerServiceWorkload,
  controlMinecraftWorkload,
  getContainerServiceWorkloadStatus,
  deployPiProxyService,
  deployRemoteWorkload,
  getMinecraftWorkloadStatus,
  getPiProxyServiceStatus,
  restartPiProxyService,
  runServiceProfileAgent,
  syncServiceProfileRuntime,
  type AgentRunPayload,
  type AgentRunResult,
  type NodeSetupRequest
} from './deploy.ts';
import { DEFAULT_WORKFLOW_SEED_PATH, importWorkflowSeed } from './workflows.ts';

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

interface MinecraftManualUpdateScheduler {
  filePath: string;
  state: MinecraftManualUpdateStore;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  configPath: string;
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
  const [timerResult, serviceResult] = await Promise.all([
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
    summary,
    driftDetected,
    ...(errorParts.length > 0 ? { error: errorParts.join(' | ') } : {})
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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="gateway-base-path" content="${basePath}" />
  <title>Gateway Config Admin</title>
  <link rel="icon" type="image/svg+xml" href="${adminFaviconDataUri()}" />
  <style>
    :root {
      color-scheme: light;
      --bg: #eef3f1;
      --panel: #ffffff;
      --line: #cfdad7;
      --text: #173336;
      --muted: #5f7578;
      --accent: #6c9894;
      --accent-soft: rgba(108, 152, 148, 0.12);
      --accent-strong: #103235;
      --sidebar: #6c9894;
      --sidebar-soft: rgba(255, 255, 255, 0.14);
      --highlight: #6f99a7;
      --danger: #8f3030;
      --ok: #2e6961;
      --shadow: rgba(16, 50, 53, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "Helvetica Neue", "Segoe UI", sans-serif;
      background:
        linear-gradient(180deg, #f3f6f5 0%, var(--bg) 100%);
      color: var(--text);
    }
    header {
      padding: 20px 28px 16px;
      border-bottom: 1px solid rgba(16, 50, 53, 0.12);
      background:
        linear-gradient(90deg, #6c9894 0%, #6f99a7 56%, #103235 100%);
      color: #f5fbfa;
    }
    h1, h2, h3 { margin: 0 0 10px; font-weight: 600; }
    p { margin: 0 0 10px; color: var(--muted); }
    .section-note { margin-top: 10px; font-size: 0.92rem; }
    main {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 18px;
      padding: 28px;
      align-items: start;
      max-width: 1460px;
      margin: 0 auto;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 2px;
      padding: 24px;
      box-shadow: 0 12px 32px var(--shadow);
    }
    .editor-panel { order: 1; }
    .toolbar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    button {
      border: 1px solid rgba(16, 50, 53, 0.42);
      background: var(--panel);
      color: var(--text);
      border-radius: 0;
      padding: 11px 16px;
      font: inherit;
      cursor: pointer;
      transition: opacity 120ms ease, transform 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
    }
    button.button-tapped,
    button:active {
      transform: translateY(1px);
      opacity: 0.82;
    }
    button:disabled,
    button.is-busy {
      cursor: progress;
      opacity: 0.52;
      filter: grayscale(0.3);
      background: #e7eceb;
      border-color: rgba(16, 50, 53, 0.16);
      color: rgba(22, 51, 54, 0.72);
    }
    button.primary {
      background: var(--accent-strong);
      border-color: var(--accent-strong);
      color: #fff;
    }
    button.primary:hover:not(:disabled) {
      background: #184247;
      border-color: #184247;
    }
    button.danger {
      border-color: var(--danger);
      color: var(--danger);
    }
    .section-list {
      display: grid;
      gap: 16px;
      margin-top: 18px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 0;
      padding: 18px;
      background: #fff;
    }
    .row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-top: 12px;
    }
    label {
      display: grid;
      gap: 6px;
      font-size: 14px;
      color: var(--muted);
    }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 0;
      padding: 10px 12px;
      font: inherit;
      background: white;
      color: var(--text);
    }
    textarea {
      min-height: 96px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text);
    }
    .check input {
      width: auto;
    }
    .pill {
      display: inline-block;
      border-radius: 0;
      padding: 3px 8px;
      background: rgba(108, 152, 148, 0.14);
      color: #27555a;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 10px;
    }
    #status {
      min-height: 0;
      font-size: 13px;
      color: #163336;
      border: 1px solid rgba(16, 50, 53, 0.18);
      background: rgba(255, 255, 255, 0.96);
      padding: 10px 12px;
      width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .status-ok {
      color: #163336;
      border-color: rgba(16, 50, 53, 0.18);
    }
    .status-error {
      color: #7c1f1f;
      border-color: rgba(143, 48, 48, 0.65);
      background: rgba(255, 235, 235, 0.96);
    }
    .status-progress {
      color: #6c4a00;
      border-color: rgba(183, 128, 0, 0.45);
      background: rgba(255, 246, 220, 0.98);
    }
    .action-dock {
      position: fixed;
      right: 18px;
      bottom: 18px;
      width: min(420px, calc(100vw - 36px));
      display: grid;
      gap: 10px;
      z-index: 999;
      pointer-events: none;
    }
    .action-dock > * {
      pointer-events: auto;
    }
    .action-dock-header {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 8px;
    }
    .action-dock-toggle {
      padding: 6px 10px;
      font-size: 12px;
      background: rgba(255, 255, 255, 0.96);
    }
    .action-feed {
      border: 1px solid rgba(16, 50, 53, 0.18);
      background: rgba(255, 255, 255, 0.96);
      box-shadow: 0 12px 28px rgba(17, 30, 38, 0.16);
      max-height: 220px;
      overflow: auto;
    }
    .action-feed.is-collapsed {
      display: none;
    }
    .action-feed-empty {
      margin: 0;
      padding: 12px;
      font-size: 13px;
      color: var(--muted);
    }
    .action-entry {
      padding: 10px 12px;
      border-top: 1px solid rgba(16, 50, 53, 0.08);
      background: rgba(255, 255, 255, 0.96);
    }
    .action-entry:first-child {
      border-top: 0;
    }
    .action-entry strong {
      display: block;
      margin-bottom: 4px;
      font-size: 13px;
    }
    .action-entry time {
      display: block;
      font-size: 11px;
      color: var(--muted);
    }
    .action-entry.error strong {
      color: #7c1f1f;
    }
    .action-entry.progress strong {
      color: #8b5d00;
    }
    .inline-action-output {
      border: 1px solid var(--line);
      background: #fcfcfa;
      padding: 12px;
      font-size: 14px;
    }
    .inline-action-output.is-error {
      border-color: rgba(143, 48, 48, 0.45);
      background: #fff3f3;
    }
    .inline-action-output.is-progress {
      border-color: rgba(183, 128, 0, 0.35);
      background: #fff8e6;
    }
    .inline-action-output strong {
      display: block;
      margin-bottom: 6px;
    }
    .log-output {
      margin: 12px 0 0;
      padding: 12px;
      border: 1px solid var(--line);
      background: #f7faf8;
      font-family: "SFMono-Regular", ui-monospace, monospace;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 320px;
      overflow: auto;
    }
    .aside-stack {
      order: 2;
      display: grid;
      gap: 18px;
    }
    .header-shell {
      display: grid;
      gap: 18px;
    }
    .header-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      flex-wrap: wrap;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .header-row h1,
    .header-row p {
      color: inherit;
    }
    .header-row p {
      color: rgba(245, 251, 250, 0.78);
      max-width: 760px;
    }
    .top-tab-nav {
      display: grid;
      grid-template-columns: repeat(5, minmax(132px, 1fr));
      gap: 8px;
      padding-bottom: 2px;
      width: min(1380px, 100%);
      margin: 0 auto;
    }
    .top-tab-nav .tab-button {
      width: 100%;
      min-width: 0;
      text-align: center;
      border: 1px solid transparent;
      background: transparent;
      color: rgba(245, 251, 250, 0.88);
      padding: 12px 18px;
      font-size: 15px;
      white-space: nowrap;
    }
    .top-tab-nav .tab-button:hover,
    .top-tab-nav .tab-button.active {
      background: #ffffff;
      color: var(--accent-strong);
      border-color: #ffffff;
    }
    .sub-tab-nav {
      display: flex;
      gap: 6px;
      margin-bottom: 18px;
      border-bottom: 2px solid var(--border);
      padding-bottom: 0;
    }
    .sub-tab-nav .sub-tab-button {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--muted);
      padding: 10px 18px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      margin-bottom: -2px;
      white-space: nowrap;
    }
    .sub-tab-nav .sub-tab-button:hover {
      color: var(--fg);
    }
    .sub-tab-nav .sub-tab-button.active {
      color: var(--accent-strong);
      border-bottom-color: var(--accent-strong);
    }
    .sub-tab-panel { display: none; }
    .sub-tab-panel.active { display: block; }
    .nav-card {
      background: linear-gradient(180deg, var(--sidebar) 0%, #214c44 100%);
      color: #f3f7f5;
      border-color: rgba(255, 255, 255, 0.08);
      min-height: 320px;
    }
    .nav-card p,
    .nav-card h2 {
      color: inherit;
    }
    .nav-card p {
      opacity: 0.76;
    }
    .tab-nav {
      display: grid;
      gap: 10px;
      margin-top: 22px;
    }
    .tab-button {
      width: 100%;
      text-align: left;
      border: 0;
      background: transparent;
      color: rgba(255, 255, 255, 0.82);
      border-radius: 0;
      padding: 14px 16px;
      font: inherit;
      font-size: 16px;
    }
    .tab-button:hover,
    .tab-button.active {
      background: var(--sidebar-soft);
      color: white;
    }
    .tab-panel[hidden] {
      display: none !important;
    }
    .split-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-top: 12px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 0;
      padding: 12px;
      background: white;
      position: relative;
      overflow: hidden;
    }
    .metric::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 5px;
      background: linear-gradient(90deg, #1f5f56 0%, var(--accent) 100%);
    }
    .metric:nth-child(3n)::before {
      background: linear-gradient(90deg, var(--highlight) 0%, #ffce45 100%);
    }
    .metric strong {
      display: block;
      font-size: 30px;
      margin-bottom: 4px;
    }
    .meta-list {
      display: grid;
      gap: 8px;
      margin-top: 12px;
      font-size: 14px;
      color: var(--muted);
      word-break: break-word;
    }
    .hint-list {
      display: grid;
      gap: 6px;
      color: var(--muted);
    }
    .section-card {
      padding: 0;
      overflow: hidden;
    }
    .section-card summary {
      list-style: none;
      cursor: pointer;
      padding: 18px;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
    }
    .section-card summary::-webkit-details-marker {
      display: none;
    }
    .section-card summary::after {
      content: "+";
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 20px;
      line-height: 1;
      margin-top: 2px;
    }
    .section-card[open] summary::after {
      content: "−";
    }
    .section-card summary p {
      margin-bottom: 0;
    }
    .section-card .section-body {
      border-top: 1px solid var(--line);
      padding: 18px;
      background: #fcfcfa;
    }
    .section-card .section-body > :first-child {
      margin-top: 0;
    }
    .section-card .section-body .card {
      background: #fff;
    }
    .section-summary-copy {
      display: grid;
      gap: 6px;
    }
    .section-summary-copy h3 {
      margin-bottom: 0;
    }
    .section-summary-copy p {
      font-size: 14px;
    }
    .card-quiet {
      background: #fcfcfa;
    }
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      grid-auto-rows: 1fr;
      gap: 16px;
      margin-top: 18px;
    }
    .overview-card {
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-height: 180px;
    }
    .overview-card strong {
      font-size: 20px;
      font-weight: 600;
    }
    .overview-card p {
      flex: 1 1 auto;
    }
    .overview-card button {
      width: 100%;
      margin-top: auto;
    }
    .disclosure-card > summary {
      display: block;
      padding-bottom: 12px;
      margin-bottom: 14px;
      border-bottom: 1px solid var(--line);
    }
    .disclosure-card {
      margin-top: 20px;
    }
    .disclosure-card .row:first-of-type {
      margin-top: 16px;
    }
    details:not(.section-card) > summary {
      list-style: none;
      cursor: pointer;
      user-select: none;
    }
    details:not(.section-card) > summary::-webkit-details-marker {
      display: none;
    }
    details:not(.section-card) > summary::before {
      content: "+";
      display: inline-block;
      width: 16px;
      margin-right: 8px;
      color: var(--muted);
    }
    details[open]:not(.section-card) > summary::before {
      content: "−";
    }
    .aside-stack > details.panel {
      padding: 18px 20px;
    }
    @media (max-width: 980px) {
      .action-dock {
        left: 12px;
        right: 12px;
        bottom: 12px;
        width: auto;
      }
      main { grid-template-columns: 1fr; }
      .editor-panel { order: 1; }
      .aside-stack { order: 2; }
      .header-row { align-items: stretch; }
      .top-tab-nav {
        display: flex;
        overflow-x: auto;
        width: 100%;
      }
      .top-tab-nav .tab-button {
        min-width: max-content;
      }
      .overview-grid {
        grid-template-columns: 1fr;
      }
    }

    .wizard-dialog {
      border: none;
      border-radius: 10px;
      padding: 0;
      max-width: 640px;
      width: 90vw;
      max-height: 85vh;
      box-shadow: 0 8px 32px var(--shadow);
      background: #fff;
      color: var(--text);
    }
    .wizard-dialog::backdrop {
      background: rgba(16, 50, 53, .45);
    }
    .wizard-content {
      display: flex;
      flex-direction: column;
      max-height: 85vh;
    }
    .wizard-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--line);
      background: #fff;
    }
    .wizard-header h2 {
      margin: 0;
      font-size: 1.15rem;
      color: var(--text);
    }
    .wizard-close {
      background: none;
      border: none;
      font-size: 1.5rem;
      cursor: pointer;
      color: var(--muted);
      padding: 0 .25rem;
      line-height: 1;
    }
    .wizard-close:hover {
      color: var(--text);
    }
    .wizard-step {
      padding: 1.25rem;
      overflow-y: auto;
      background: #fff;
    }
    .wizard-desc {
      margin: 0 0 1rem;
      color: var(--muted);
    }
    .wizard-form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: .75rem;
    }
    .wizard-field {
      display: flex;
      flex-direction: column;
      gap: .25rem;
    }
    .wizard-field span {
      font-size: .85rem;
      font-weight: 600;
      color: var(--text);
    }
    .wizard-field small {
      font-weight: 400;
      color: var(--muted);
    }
    .wizard-field input,
    .wizard-field select {
      padding: .4rem .5rem;
      border: 1px solid var(--line);
      border-radius: 0;
      background: white;
      color: var(--text);
      font-size: .9rem;
    }
    .wizard-field input:focus,
    .wizard-field select:focus {
      outline: 2px solid var(--accent);
      outline-offset: -1px;
    }
    .wizard-actions {
      display: flex;
      justify-content: flex-end;
      gap: .5rem;
      padding-top: 1rem;
    }
    .wizard-btn-primary,
    .wizard-btn-secondary {
      padding: .5rem 1.25rem;
      border-radius: 0;
      border: 1px solid var(--line);
      cursor: pointer;
      font-size: .9rem;
    }
    .wizard-btn-primary {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
      font-weight: 600;
    }
    .wizard-btn-primary:disabled {
      opacity: .5;
      cursor: not-allowed;
    }
    .wizard-btn-secondary {
      background: #fff;
      color: var(--text);
    }
    .wizard-btn-secondary:hover {
      background: var(--bg);
    }
    .wizard-preset-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: .75rem;
      margin-bottom: 1rem;
    }
    .wizard-preset-card {
      border: 2px solid var(--line);
      border-radius: 0;
      padding: 1rem;
      cursor: pointer;
      background: #fff;
      text-align: left;
      transition: border-color .15s;
    }
    .wizard-preset-card:hover {
      border-color: var(--accent);
    }
    .wizard-preset-card.selected {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    .wizard-preset-card strong {
      display: block;
      color: var(--text);
      margin-bottom: .25rem;
    }
    .wizard-preset-card small {
      color: var(--muted);
      font-size: .8rem;
    }
    .svc-catalog-card {
      border: 2px solid var(--line);
      border-radius: 0;
      padding: 1rem;
      cursor: pointer;
      background: #fff;
      text-align: left;
      transition: border-color .15s;
    }
    .svc-catalog-card:hover {
      border-color: var(--accent);
    }
    .svc-catalog-card.selected {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    .svc-catalog-card strong {
      display: block;
      color: var(--text);
      margin-bottom: .25rem;
    }
    .svc-catalog-card small {
      color: var(--muted);
      font-size: .8rem;
    }
    .wizard-form-grid {
      display: flex;
      flex-direction: column;
      gap: .75rem;
      max-height: 55vh;
      overflow-y: auto;
      padding-right: .5rem;
    }
    .wizard-field {
      display: flex;
      flex-direction: column;
      gap: .2rem;
    }
    .wizard-label {
      font-weight: 600;
      font-size: .85rem;
      color: var(--text);
    }
    .wizard-field input,
    .wizard-field select {
      padding: .45rem .6rem;
      border: 1px solid var(--line);
      font-size: .85rem;
      font-family: inherit;
      background: #fff;
      color: var(--text);
    }
    .wizard-field input:focus,
    .wizard-field select:focus {
      outline: 2px solid var(--accent);
      outline-offset: -1px;
    }
    .wizard-hint {
      font-size: .75rem;
      color: var(--muted);
    }
    .wizard-log-line.success { color: #1a7a4c; }
    .wizard-log-line.error { color: #c0392b; }
    .wizard-log-line.info { color: var(--muted); }
    .wizard-log {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: .82rem;
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: 0;
      padding: .75rem 1rem;
      min-height: 200px;
      max-height: 50vh;
      overflow-y: auto;
      line-height: 1.6;
      color: var(--text);
    }
    .wizard-log-entry {
      display: flex;
      align-items: flex-start;
      gap: .5rem;
      padding: .15rem 0;
      color: var(--text);
    }
    .wizard-log-icon {
      flex-shrink: 0;
      width: 1.2em;
      text-align: center;
    }
    .wiz-running .wizard-log-icon { color: var(--highlight); }
    .wiz-ok .wizard-log-icon { color: var(--ok); }
    .wiz-warn .wizard-log-icon { color: #b8860b; }
    .wiz-error .wizard-log-icon { color: var(--danger); }
    .wiz-complete .wizard-log-icon { color: var(--ok); }
    button.primary-action {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
      font-weight: 600;
    }
  </style>
</head>
<body>
  <header>
    <div class="header-shell">
      <div class="header-row">
        <div>
          <h1>Gateway Config Admin</h1>
          <p>Configure gateway services, agents, workflows, and deployment state from one control surface.</p>
        </div>
        <div class="header-actions">
          <button id="refreshButton">Refresh</button>
          <button id="saveButton" class="primary">Save</button>
        </div>
      </div>
      <nav class="top-tab-nav" aria-label="Sections">
        <button class="tab-button active" data-tab="overview">Dashboard</button>
        <button class="tab-button" data-tab="services">Services</button>
        <button class="tab-button" data-tab="agents">Agents &amp; Automations</button>
        <button class="tab-button" data-tab="infra">Infrastructure</button>
        <button class="tab-button" data-tab="settings">Settings</button>
      </nav>
    </div>
  </header>
  <main>
    <section class="panel editor-panel">
      <div class="split-actions">
        <div>
          <h2>Config Workspace</h2>
          <p>Use the tabs above to focus one config area at a time. Changes stay in memory until you save.</p>
        </div>
      </div>

      <!-- ═══ INFRASTRUCTURE TAB ═══ -->
      <div class="tab-panel" data-tab-panel="infra" hidden>
      <nav class="sub-tab-nav" data-sub-group="infra">
        <button class="sub-tab-button active" data-sub-tab="infra-gateway">Gateway</button>
        <button class="sub-tab-button" data-sub-tab="infra-nodes">Nodes</button>
        <button class="sub-tab-button" data-sub-tab="infra-minecraft">Minecraft</button>
      </nav>

      <div class="sub-tab-panel active" data-sub-tab-panel="infra-gateway">
      <details class="card section-card" open>
        <summary>
          <div class="section-summary-copy">
            <span class="pill">Gateway</span>
            <h3>Gateway Server Settings</h3>
            <p>Core host-level control-plane paths and reload commands.</p>
          </div>
        </summary>
        <div class="section-body">
          <div class="row">
            <label>Server Names (comma separated)
              <input id="gatewayServerNames" />
            </label>
            <label>nginx Site Output
              <input id="nginxSiteOutputPath" />
            </label>
            <label>Upstream Directory
              <input id="upstreamDirectory" />
            </label>
            <label>nginx Reload Command
              <input id="nginxReloadCommand" />
            </label>
            <label>systemd Unit Directory
              <input id="systemdUnitDirectory" />
            </label>
            <label>systemd Reload Command
              <input id="systemdReloadCommand" />
            </label>
            <label>Enable Timer Command
              <input id="systemdEnableTimerCommand" />
            </label>
          </div>
        </div>
      </details>

      <details class="card section-card">
        <summary>
          <div class="section-summary-copy">
            <span class="pill">Admin UI</span>
            <h3>Control-Plane Web App</h3>
            <p>Bind settings and service details for the admin interface itself.</p>
          </div>
        </summary>
        <div class="section-body">
          <div class="row">
            <label class="check"><input id="adminUiEnabled" type="checkbox" /> Enabled</label>
            <label>Bind Host
              <input id="adminUiHost" />
            </label>
            <label>Bind Port
              <input id="adminUiPort" type="number" />
            </label>
            <label>Gateway Route Path
              <input id="adminUiRoutePath" />
            </label>
            <label>Service Name
              <input id="adminUiServiceName" />
            </label>
            <label>Working Directory
              <input id="adminUiWorkingDirectory" />
            </label>
            <label>Config Path
              <input id="adminUiConfigPath" />
            </label>
            <label>Build Output Directory
              <input id="adminUiBuildOutDir" />
            </label>
            <label>Node Executable
              <input id="adminUiNodeExecutable" />
            </label>
            <label>User
              <input id="adminUiUser" />
            </label>
            <label>Group
              <input id="adminUiGroup" />
            </label>
          </div>
        </div>
      </details>
      </div>

      <div class="sub-tab-panel" data-sub-tab-panel="infra-nodes">
      <div class="section-list">
        <div class="card card-quiet">
          <div>
            <span class="pill">Nodes</span>
            <h3>Worker Nodes and Remote Container Jobs</h3>
            <p>Use this tab to define remote nodes like your core-node and generic container workloads. Minecraft has its own dedicated tab.</p>
          </div>
        </div>
        <details class="card section-card" open>
          <summary>
            <div class="section-summary-copy">
              <span class="pill">Node Setup</span>
              <h3>Add New Node</h3>
              <p>Walk through the guided wizard to provision a new remote machine and register it with the control plane.</p>
            </div>
          </summary>
          <div class="section-body">
            <div class="toolbar">
              <button id="openNodeSetupWizardButton" class="primary-action">Setup New Node</button>
            </div>
          </div>
        </details>
        <details class="card section-card" open>
          <summary>
            <div class="section-summary-copy">
              <span class="pill">Nodes</span>
              <h3>Worker Nodes</h3>
              <p>SSH targets and runtime settings for remote workload execution.</p>
            </div>
          </summary>
          <div class="section-body">
            <div class="split-actions">
              <div></div>
              <button id="addWorkerNodeButton">Add Worker Node</button>
            </div>
            <div id="workerNodesContainer" class="section-list"></div>
          </div>
        </details>
        <details class="card section-card">
          <summary>
            <div class="section-summary-copy">
              <span class="pill">Remote Workloads</span>
              <h3>Container Jobs + Services + Bedrock Servers</h3>
              <p>Generic remote workloads. Use services for long-running APIs, jobs for scheduled runs, and the Bedrock tab for Minecraft-specific controls.</p>
            </div>
          </summary>
          <div class="section-body">
            <div class="split-actions">
              <div></div>
              <div class="toolbar">
                <button id="openServiceDeployWizardButton" class="primary-action">Deploy a Service</button>
                <button id="addRemoteWorkloadButton">Add Container Job</button>
                <button id="addContainerServiceWorkloadButton">Add Container Service</button>
                <button id="addBedrockWorkloadButton">Add Bedrock Server</button>
              </div>
            </div>
            <div id="remoteWorkloadsContainer" class="section-list"></div>
          </div>
        </details>
      </div>
      </div>

      <div class="sub-tab-panel" data-sub-tab-panel="infra-minecraft">
      <details class="card section-card" open>
        <summary>
          <div class="section-summary-copy">
            <span class="pill">Bedrock</span>
            <h3>Minecraft Bedrock Servers</h3>
            <p>Launch, configure, update, and administer Bedrock servers on worker nodes.</p>
          </div>
        </summary>
        <div class="section-body">
          <div class="split-actions">
            <div>
              <p>Use <strong>Apply Server</strong> to save the config and push the latest server bundle to the node.</p>
            </div>
            <div class="toolbar">
              <button id="addBedrockServerButton">Add Bedrock Server</button>
            </div>
          </div>
          <div id="bedrockServersContainer" class="section-list"></div>
        </div>
      </details>
      </div>

      </div>

      <!-- ═══ SERVICES TAB ═══ -->
      <div class="tab-panel" data-tab-panel="services" hidden>
      <nav class="sub-tab-nav" data-sub-group="services">
        <button class="sub-tab-button active" data-sub-tab="svc-remote">Remote Services</button>
        <button class="sub-tab-button" data-sub-tab="svc-profiles">Service Profiles</button>
        <button class="sub-tab-button" data-sub-tab="svc-deploy">Apps &amp; Deploys</button>
        <button class="sub-tab-button" data-sub-tab="svc-jobs">Host Jobs</button>
        <button class="sub-tab-button" data-sub-tab="svc-features">Feature Flags</button>
      </nav>

      <div class="sub-tab-panel active" data-sub-tab-panel="svc-remote">
        <div class="card card-quiet">
          <div class="split-actions">
            <div>
              <span class="pill">Deploy</span>
              <h3>Remote Container Services</h3>
              <p>Deploy and manage containerised services on your worker nodes. The wizard walks you through picking a service, configuring it, and deploying — all in one step.</p>
            </div>
            <div class="toolbar">
              <button id="openServiceDeployWizardButtonSvc" class="primary-action">Deploy a Service</button>
            </div>
          </div>
        </div>
        <div id="remoteServicesOverview" class="section-list"></div>
      </div>

      <div class="sub-tab-panel" data-sub-tab-panel="svc-profiles">
      <details class="card section-card" open>
        <summary>
          <div class="section-summary-copy">
            <span class="pill">gateway-api</span>
            <h3>Runtime Profile</h3>
            <p>Env files, job channels, and KULRS runtime wiring for <code>gateway-api</code>.</p>
          </div>
        </summary>
        <div class="section-body">
          <div class="split-actions">
            <div></div>
            <div class="toolbar">
              <button id="addGatewayApiEnvButton">Add Env Var</button>
              <button id="addGatewayApiChannelButton">Add Channel</button>
              <button id="addKulrsBotButton">Add KULRS Bot</button>
            </div>
          </div>
          <div class="row">
            <label class="check"><input id="gatewayApiProfileEnabled" type="checkbox" /> Enabled</label>
            <label>Managed App
              <select id="gatewayApiProfileAppId"></select>
            </label>
            <label>Workflow API Base URL
              <input id="gatewayApiProfileApiBaseUrl" />
            </label>
            <label>Env File Path
              <input id="gatewayApiProfileEnvFilePath" />
            </label>
          </div>
          <div id="gatewayApiEnvContainer" class="section-list"></div>
          <details class="card section-card">
            <summary>
              <div class="section-summary-copy">
                <span class="pill">Jobs</span>
                <h3>Job Runtime Channels</h3>
                <p>Named delivery channels for <code>gateway-jobs.run</code>.</p>
              </div>
            </summary>
            <div class="section-body">
              <div class="row">
                <label>Channels File Path
                  <input id="gatewayApiJobChannelsFilePath" />
                </label>
              </div>
              <div id="gatewayApiJobChannelsContainer" class="section-list"></div>
            </div>
          </details>
          <details class="card section-card">
            <summary>
              <div class="section-summary-copy">
                <span class="pill">KULRS</span>
                <h3>Activity Job</h3>
                <p>Generated job files, credentials, schedule, and runtime details for KULRS.</p>
              </div>
            </summary>
            <div class="section-body">
              <div class="row">
                <label class="check"><input id="kulrsEnabled" type="checkbox" /> Enabled</label>
                <label>Schedule
                  <input id="kulrsSchedule" />
                </label>
                <label>User
                  <input id="kulrsUser" />
                </label>
                <label>Group
                  <input id="kulrsGroup" />
                </label>
                <label>Timezone
                  <input id="kulrsTimezone" />
                </label>
              </div>
              <div class="row">
                <label>Env File Path
                  <input id="kulrsEnvFilePath" />
                </label>
                <label>Credentials File Path
                  <input id="kulrsCredentialsFilePath" />
                </label>
                <label>Workspace Dir
                  <input id="kulrsWorkspaceDir" />
                </label>
              </div>
              <div class="row">
                <label>Working Directory
                  <input id="kulrsWorkingDirectory" />
                </label>
                <label>ExecStart
                  <input id="kulrsExecStart" />
                </label>
              </div>
              <label>Description
                <input id="kulrsDescription" />
              </label>
              <div id="kulrsStatus" class="meta-list"></div>
              <div class="row">
                <label>Firebase API Key
                  <input id="kulrsFirebaseApiKey" type="password" />
                </label>
                <label>Unsplash Access Key
                  <input id="kulrsUnsplashAccessKey" type="password" />
                </label>
              </div>
              <div id="kulrsBotsContainer" class="section-list"></div>
            </div>
          </details>
        </div>
      </details>

      <details class="card section-card">
        <summary>
          <div class="section-summary-copy">
            <span class="pill">gateway-chat-platform</span>
            <h3>Runtime Profile</h3>
            <p>Chat API env wiring, provider sync, and local TTS settings.</p>
          </div>
        </summary>
        <div class="section-body">
          <div class="split-actions">
            <div></div>
            <div class="toolbar">
              <button id="addGatewayChatEnvButton">Add Env Var</button>
            </div>
          </div>
          <div class="row">
            <label class="check"><input id="gatewayChatProfileEnabled" type="checkbox" /> Enabled</label>
            <label>Managed App
              <select id="gatewayChatProfileAppId"></select>
            </label>
            <label>Chat API Base URL
              <input id="gatewayChatProfileApiBaseUrl" />
            </label>
            <label>API Env File Path
              <input id="gatewayChatProfileEnvFilePath" />
            </label>
          </div>
          <div class="section-list">
            <div class="card card-quiet">
              <p>Environment</p>
              <div id="gatewayChatEnvContainer" class="section-list"></div>
            </div>
            <div class="card card-quiet">
              <p>Chat Inbox / Redis</p>
              <div class="row">
                <label>Redis URL
                  <input id="gatewayChatRedisUrl" placeholder="redis://198.51.100.200:6379" />
                </label>
                <label>Default User Id
                  <input id="gatewayChatDefaultUserId" placeholder="me" />
                </label>
                <label>Default Channel Id
                  <input id="gatewayChatDefaultChannelId" placeholder="coach" />
                </label>
              </div>
              <p class="section-note">Scheduled prompts use these defaults unless a workflow overrides its own inbox scope.</p>
            </div>
            <details class="card section-card">
              <summary>
                <div class="section-summary-copy">
                  <span class="pill">TTS</span>
                  <h3>Local TTS Service</h3>
                  <p>Voice generation settings, health checks, and managed voice entries.</p>
                </div>
              </summary>
              <div class="section-body">
                <div class="split-actions">
                  <div></div>
                  <div class="toolbar">
                    <button id="checkTtsButton">Check TTS</button>
                    <button id="reloadTtsVoicesButton">Reload Voices</button>
                  </div>
                </div>
                <div class="row">
                  <label class="check"><input id="gatewayChatTtsEnabled" type="checkbox" /> Enabled</label>
                  <label>TTS Base URL
                    <input id="gatewayChatTtsBaseUrl" />
                  </label>
                  <label>Default Voice
                    <input id="gatewayChatTtsDefaultVoice" />
                  </label>
                  <label>Generate Path
                    <input id="gatewayChatTtsGeneratePath" />
                  </label>
                  <label>Stream Path
                    <input id="gatewayChatTtsStreamPath" />
                  </label>
                  <label>Voices Path
                    <input id="gatewayChatTtsVoicesPath" />
                  </label>
                  <label>Health Path
                    <input id="gatewayChatTtsHealthPath" />
                  </label>
                </div>
                <div id="ttsStatus" class="meta-list"></div>
                <div class="split-actions">
                  <div>
                    <p>Voices</p>
                  </div>
                </div>
                <div id="ttsVoicesContainer" class="section-list"></div>
                <div class="card">
                  <div class="split-actions">
                    <div>
                      <span class="pill">Create Voice</span>
                      <h4>New Voice</h4>
                    </div>
                    <button id="createTtsVoiceButton" class="primary">Create Voice</button>
                  </div>
                  <div class="row">
                    <label>Name
                      <input id="ttsCreateVoiceName" />
                    </label>
                    <label>Description
                      <input id="ttsCreateVoiceDescription" />
                    </label>
                    <label>Source
                      <input id="ttsCreateVoiceSource" value="recorded" />
                    </label>
                    <label>Reference Audio
                      <input id="ttsCreateVoiceFile" type="file" accept="audio/*,.wav,.mp3,.m4a" />
                    </label>
                  </div>
                  <label>Transcript
                    <textarea id="ttsCreateVoiceTranscript" placeholder="Required by local-tts-service for voice creation. Provide the spoken text from the reference audio."></textarea>
                  </label>
                </div>
              </div>
            </details>
          </div>
        </div>
      </details>

      <details class="card section-card">
        <summary>
          <div class="section-summary-copy">
            <span class="pill">pi-proxy</span>
            <h3>Bedrock LAN Proxy</h3>
            <p>External Raspberry Pi proxy contract for Xbox LAN discovery and Bedrock server transfer targets.</p>
          </div>
        </summary>
        <div class="section-body">
          <div class="split-actions">
            <div>
              <p class="section-note">This profile manages the Pi-hosted <code>bedrock-lan-proxy.service</code> over SSH and keeps its advertised worlds aligned with the live Bedrock registry.</p>
            </div>
            <div class="toolbar">
              <button id="refreshPiProxyStatusButton">Check Service</button>
              <button id="deployPiProxyButton" class="primary">Deploy Proxy</button>
              <button id="restartPiProxyButton">Restart Proxy</button>
              <button id="refreshPiProxyRegistryButton">Refresh Registry</button>
            </div>
          </div>
          <div class="row">
            <label class="check"><input id="piProxyEnabled" type="checkbox" /> Enabled</label>
            <label>Managed Node
              <select id="piProxyNodeId"></select>
            </label>
            <label>Description
              <input id="piProxyDescription" />
            </label>
            <label>Install Root
              <input id="piProxyInstallRoot" />
            </label>
            <label>Systemd Unit
              <input id="piProxySystemdUnitName" />
            </label>
            <label>Registry Base URL
              <input id="piProxyRegistryBaseUrl" />
            </label>
          </div>
          <div class="row">
            <label>Listen Host
              <input id="piProxyListenHost" />
            </label>
            <label>Listen Port
              <input id="piProxyListenPort" type="number" min="1" />
            </label>
            <label>Service User
              <input id="piProxyServiceUser" />
            </label>
            <label>Service Group
              <input id="piProxyServiceGroup" />
            </label>
          </div>
          <div class="row">
            <label>Registry Path
              <input id="piProxyRegistryPath" />
            </label>
            <label>Poll Interval Seconds
              <input id="piProxyPollIntervalSeconds" type="number" min="1" />
            </label>
            <label>Registry URL
              <input id="piProxyRegistryUrlPreview" readonly />
            </label>
          </div>
          <div id="piProxyServiceMeta" class="meta-list"></div>
          <div id="piProxyRegistryMeta" class="meta-list"></div>
          <div id="piProxyActionOutput" class="inline-action-output"><strong>Action Output</strong><div>No Pi proxy actions yet.</div></div>
          <div id="piProxyRegistryContainer" class="section-list"></div>
        </div>
      </details>

      </div>

      <div class="sub-tab-panel" data-sub-tab-panel="svc-deploy">
        <details class="card section-card" open>
          <summary>
            <div class="section-summary-copy">
              <span class="pill">Apps</span>
              <h3>Managed Apps</h3>
              <p>Git-based services deployed by the control-plane.</p>
            </div>
          </summary>
          <div class="section-body">
            <div class="split-actions">
              <div></div>
              <button id="addAppButton">Add App</button>
            </div>
            <div id="appsContainer" class="section-list"></div>
          </div>
        </details>
      </div>

      <div class="sub-tab-panel" data-sub-tab-panel="svc-jobs">
        <details class="card section-card" open>
          <summary>
            <div class="section-summary-copy">
              <span class="pill">Jobs</span>
              <h3>Host Scheduled Jobs</h3>
              <p>Host-level scheduled commands tied to an app deployment.</p>
            </div>
          </summary>
          <div class="section-body">
            <div class="split-actions">
              <div></div>
              <button id="addJobButton">Add Job</button>
            </div>
            <div id="jobsContainer" class="section-list"></div>
          </div>
        </details>
      </div>

      <div class="sub-tab-panel" data-sub-tab-panel="svc-features">
        <details class="card section-card" open>
          <summary>
            <div class="section-summary-copy">
              <span class="pill">Features</span>
              <h3>Feature Flags</h3>
              <p>Optional deployment toggles and feature switches.</p>
            </div>
          </summary>
          <div class="section-body">
            <div class="split-actions">
              <div></div>
              <button id="addFeatureButton">Add Feature</button>
            </div>
            <div id="featuresContainer" class="section-list"></div>
          </div>
        </details>
      </div>

      </div>

      <!-- ═══ SETTINGS TAB ═══ -->
      <div class="tab-panel" data-tab-panel="settings" hidden>
      <nav class="sub-tab-nav" data-sub-group="settings">
        <button class="sub-tab-button active" data-sub-tab="settings-creds">Credentials</button>
        <button class="sub-tab-button" data-sub-tab="settings-json">Advanced JSON</button>
      </nav>

      <div class="sub-tab-panel active" data-sub-tab-panel="settings-creds">
      <div class="section-list">
        <div class="card card-quiet">
          <div class="split-actions">
            <div>
              <span class="pill">Secrets</span>
              <h3>Credentials, Keys, and Secret Env Vars</h3>
              <p>Use this tab when you need to manage API keys, bot tokens, passwords, webhooks, or other sensitive values. This is the credential-focused view of the same config.</p>
            </div>
          </div>
        </div>
        <details class="card section-card" open>
          <summary>
            <div class="section-summary-copy">
              <span class="pill">gateway-api</span>
              <h3>Secret Env Vars</h3>
              <p>Passwords, tokens, and private env vars for <code>gateway-api</code>.</p>
            </div>
          </summary>
          <div class="section-body">
            <div class="split-actions">
              <div></div>
              <button id="addGatewayApiSecretButton">Add Secret Env Var</button>
            </div>
            <div id="gatewayApiSecretsContainer" class="section-list"></div>
          </div>
        </details>
        <details class="card section-card">
          <summary>
            <div class="section-summary-copy">
              <span class="pill">Delivery</span>
              <h3>Job Delivery Channels</h3>
              <p>Credentials used when jobs send to Telegram or webhooks.</p>
            </div>
          </summary>
          <div class="section-body">
            <div class="split-actions">
              <div></div>
              <button id="addGatewayApiSecretChannelButton">Add Channel</button>
            </div>
            <div id="gatewayApiSecretChannelsContainer" class="section-list"></div>
          </div>
        </details>
        <details class="card section-card">
          <summary>
            <div class="section-summary-copy">
              <span class="pill">KULRS</span>
              <h3>KULRS Credentials</h3>
              <p>Firebase, Unsplash, and per-bot credentials for palette generation.</p>
            </div>
          </summary>
          <div class="section-body">
            <div class="split-actions">
              <div></div>
              <button id="addKulrsSecretBotButton">Add KULRS Bot</button>
            </div>
            <div class="row">
              <label>Firebase API Key
                <input id="kulrsFirebaseApiKeySecrets" type="password" />
              </label>
              <label>Unsplash Access Key
                <input id="kulrsUnsplashAccessKeySecrets" type="password" />
              </label>
            </div>
            <div id="kulrsSecretBotsContainer" class="section-list"></div>
          </div>
        </details>
        <details class="card section-card">
          <summary>
            <div class="section-summary-copy">
              <span class="pill">gateway-chat-platform</span>
              <h3>Secret Env Vars</h3>
              <p>Model-provider and runtime secret env vars for chat services.</p>
            </div>
          </summary>
          <div class="section-body">
            <div class="split-actions">
              <div></div>
              <button id="addGatewayChatSecretButton">Add Secret Env Var</button>
            </div>
            <div id="gatewayChatSecretsContainer" class="section-list"></div>
          </div>
        </details>
      </div>
      </div>

      <div class="sub-tab-panel" data-sub-tab-panel="settings-json">
        <div class="split-actions">
          <div>
            <h3>Advanced JSON</h3>
            <p>Exact config file representation. Use this only when the guided tabs are not enough.</p>
          </div>
          <button id="applyRawButton">Apply Raw JSON</button>
        </div>
        <textarea id="rawJson" spellcheck="false" style="width: 100%; min-height: 600px; font-family: monospace; font-size: 13px;"></textarea>
      </div>

      </div>

      <!-- ═══ AGENTS & AUTOMATIONS TAB ═══ -->
      <div class="tab-panel" data-tab-panel="agents" hidden>
      <nav class="sub-tab-nav" data-sub-group="agents">
        <button class="sub-tab-button active" data-sub-tab="agents-list">Agents</button>
        <button class="sub-tab-button" data-sub-tab="agents-workflows">Workflows</button>
      </nav>

      <div class="sub-tab-panel active" data-sub-tab-panel="agents-list">
      <details class="card section-card" open>
        <summary>
          <div class="section-summary-copy">
            <span class="pill">Agents</span>
            <h3>Configured Chat Agents</h3>
            <p>Only these agents are synced into <code>gateway-chat-platform</code>.</p>
          </div>
        </summary>
        <div class="section-body">
          <div class="split-actions">
            <div></div>
            <div class="toolbar">
              <button id="addGatewayChatAgentButton">Add Agent</button>
              <button id="syncGatewayChatAgentsButtonSecondary">Sync Agents</button>
            </div>
          </div>
          <div id="gatewayChatAgentsContainer" class="section-list"></div>
        </div>
      </details>
      </div>

      <div class="sub-tab-panel" data-sub-tab-panel="agents-workflows">
      <details class="card section-card">
        <summary>
          <div class="section-summary-copy">
            <span class="pill">Catalog</span>
            <h3>Automation Job Catalog</h3>
            <p>Available refs for <code>target.type = gateway-jobs.run</code>.</p>
          </div>
        </summary>
        <div class="section-body">
          <div class="split-actions">
            <div></div>
            <button id="reloadJobsButton">Reload Jobs</button>
          </div>
          <div id="jobsCatalogContainer" class="section-list"></div>
        </div>
      </details>
      <details class="card section-card" open>
        <summary>
          <div class="section-summary-copy">
            <span class="pill">Automations</span>
            <h3>Scheduled Workflows</h3>
            <p>API-level automations stored and executed by <code>gateway-api</code>.</p>
          </div>
        </summary>
        <div class="section-body">
          <div class="split-actions">
            <div></div>
            <div class="toolbar">
              <button id="reloadWorkflowsButton">Reload Workflows</button>
              <button id="addWorkflowButton">Add Workflow</button>
            </div>
          </div>
          <div id="workflowsContainer" class="section-list"></div>
        </div>
      </details>
      </div>

      </div>

      <!-- ═══ DASHBOARD TAB ═══ -->
      <div class="tab-panel" data-tab-panel="overview">
      <div class="card card-quiet">
        <div class="split-actions">
          <div>
            <span class="pill">Start Here</span>
            <h3>What Goes Where</h3>
            <p>This UI manages several different systems. Use the sections below as the map.</p>
          </div>
        </div>
        <div class="overview-grid">
          <div class="card overview-card">
            <strong>Services</strong>
            <p>Service profiles, env files, delivery channels, TTS wiring, app deployments, and feature flags.</p>
            <button data-open-tab="services">Open Services</button>
          </div>
          <div class="card overview-card">
            <strong>Agents &amp; Automations</strong>
            <p>Chat agents, scheduled workflows, and agentic job records.</p>
            <button data-open-tab="agents">Open Agents</button>
          </div>
          <div class="card overview-card">
            <strong>Infrastructure</strong>
            <p>Gateway settings, worker nodes, remote workloads, and Minecraft server admin.</p>
            <button data-open-tab="infra">Open Infrastructure</button>
          </div>
          <div class="card overview-card">
            <strong>Settings</strong>
            <p>Credentials, API keys, bot tokens, secrets, and the raw config JSON editor.</p>
            <button data-open-tab="settings">Open Settings</button>
          </div>
        </div>
      </div>
      <details class="card section-card">
        <summary>
          <div class="section-summary-copy">
            <span class="pill">Tools</span>
            <h3>Agent and Workflow Utilities</h3>
            <p>Secondary utilities for imports, sync, and agent test runs.</p>
          </div>
        </summary>
        <div class="section-body">
        <div class="split-actions">
          <div></div>
          <div class="toolbar">
            <button id="syncGatewayChatAgentsButton">Sync Agents</button>
            <button id="importWorkflowSeedButton">Import Workflow Seed</button>
          </div>
        </div>
        <div class="row">
          <label>Workflow Seed File
            <input id="workflowSeedPath" />
          </label>
          <label>Agent
            <select id="agentRunAgentId"></select>
          </label>
        </div>
        <label>Prompt
          <textarea id="agentRunPrompt">Give me a short readiness check in character, then confirm the local model route is working.</textarea>
        </label>
        <div class="row">
          <label>Context JSON
            <textarea id="agentRunContext">{}</textarea>
          </label>
          <label>Delivery JSON
            <textarea id="agentRunDelivery">{}</textarea>
          </label>
        </div>
        <div class="toolbar">
          <button id="runAgentButton" class="primary">Run Agent</button>
        </div>
        <div id="agentRunResult" class="meta-list"></div>
        </div>
      </details>
      </div>

    </section>

    <aside class="aside-stack">
      <section class="panel">
        <div class="split-actions">
          <div>
            <h2>Runtime</h2>
            <p>Health and control-plane state from the live server process.</p>
          </div>
          <button id="refreshRuntimeButtonSecondary">Refresh</button>
        </div>
        <div id="runtimeSummary" class="metric-grid"></div>
        <div id="runtimeMeta" class="meta-list"></div>
      </section>
      <details class="panel" open>
        <summary><strong>Definitions</strong></summary>
        <div class="hint-list" style="margin-top: 14px;">
          <p><strong>Apps</strong> are git-based services deployed by the control-plane.</p>
          <p><strong>Jobs</strong> are host scheduled commands attached to an app deployment.</p>
          <p><strong>Automations</strong> are workflow records stored and run by <code>gateway-api</code>.</p>
          <p><strong>Runtime</strong> is where service profiles and generated env/runtime files are configured.</p>
          <p><strong>Secrets</strong> is the credential-focused view for keys, passwords, tokens, and secret env vars.</p>
          <p><strong>Nodes</strong> defines remote worker nodes plus generic remote jobs, services, and Bedrock workloads.</p>
          <p><strong>Minecraft</strong> is the dedicated Bedrock administration surface.</p>
          <p><strong>Pi Proxy</strong> manages the Raspberry Pi Bedrock LAN proxy service and its live registry wiring for Xbox-visible worlds.</p>
        </div>
      </details>
    </aside>
  </main>

  <dialog id="nodeSetupWizard" class="wizard-dialog">
    <div class="wizard-content">
      <div class="wizard-header">
        <h2>Setup New Node</h2>
        <button id="closeNodeSetupWizardButton" class="wizard-close">&times;</button>
      </div>

      <div id="wizardStepPreset" class="wizard-step">
        <p class="wizard-desc">What kind of node are you setting up?</p>
        <div class="wizard-preset-grid">
          <button class="wizard-preset-card" data-preset="general">
            <strong>General Linux Node</strong>
            <small>Standard Docker worker with <code>/srv/builds</code>, <code>/srv/stacks</code>, <code>/srv/volumes</code> roots.</small>
          </button>
          <button class="wizard-preset-card" data-preset="gpu">
            <strong>GPU Compute Node</strong>
            <small>Docker + NVIDIA runtime for LLM, STT, and CV APIs.</small>
          </button>
          <button class="wizard-preset-card" data-preset="pi">
            <strong>Raspberry Pi Edge</strong>
            <small>Lighter edge node for proxy-style services.</small>
          </button>
          <button class="wizard-preset-card" data-preset="custom">
            <strong>Custom</strong>
            <small>Set all paths and options manually.</small>
          </button>
        </div>
        <div class="wizard-actions">
          <button id="wizPresetCancelButton" class="wizard-btn-secondary">Cancel</button>
          <button id="wizPresetNextButton" class="wizard-btn-primary" disabled>Next</button>
        </div>
      </div>

      <div id="wizardStepForm" class="wizard-step" hidden>
        <p class="wizard-desc">Enter the connection details and verify the directory paths for this node.</p>
        <div class="wizard-form-grid">
          <label class="wizard-field">
            <span>Node ID <small>(short name)</small></span>
            <input id="wizNodeId" placeholder="e.g. gpu-01, edge-pi" />
          </label>
          <label class="wizard-field">
            <span>Host <small>(IP or hostname)</small></span>
            <input id="wizHost" placeholder="e.g. 192.168.1.50" />
          </label>
          <label class="wizard-field">
            <span>SSH Port</span>
            <input id="wizSshPort" type="number" value="22" />
          </label>
          <label class="wizard-field">
            <span>Your SSH username on target</span>
            <input id="wizAdminUser" placeholder="e.g. jim" />
          </label>
          <label class="wizard-field">
            <span>Password <small>(for initial SSH — not stored)</small></span>
            <input id="wizAdminPassword" type="password" placeholder="leave blank if key auth works" />
          </label>
          <label class="wizard-field">
            <span>Description</span>
            <input id="wizDescription" placeholder="e.g. Main Docker worker" />
          </label>
          <label class="wizard-field">
            <span>Poll Interval <small>(seconds)</small></span>
            <input id="wizPollInterval" type="number" value="15" />
          </label>
          <label class="wizard-field">
            <span>Build Root</span>
            <input id="wizBuildRoot" value="/srv/builds" />
          </label>
          <label class="wizard-field">
            <span>Stack Root</span>
            <input id="wizStackRoot" value="/srv/stacks" />
          </label>
          <label class="wizard-field">
            <span>Volume Root</span>
            <input id="wizVolumeRoot" value="/srv/volumes" />
          </label>
        </div>
        <div class="wizard-actions">
          <button id="wizFormBackButton" class="wizard-btn-secondary">Back</button>
          <button id="wizStartSetupButton" class="wizard-btn-primary">Start Setup</button>
        </div>
      </div>

      <div id="wizardStepProgress" class="wizard-step" hidden>
        <div id="wizProgressLog" class="wizard-log"></div>
        <div id="wizardStepActions" class="wizard-actions" hidden>
          <button id="wizAddToConfigButton" class="wizard-btn-primary" hidden>Add Node to Config</button>
          <button id="wizCloseFinishedButton" class="wizard-btn-secondary" hidden>Close</button>
        </div>
      </div>
    </div>
  </dialog>

  <dialog id="serviceDeployWizard" class="wizard-dialog">
    <div class="wizard-content">
      <div class="wizard-header">
        <h2>Deploy a Service</h2>
        <button id="closeSvcWizardButton" class="wizard-close">&times;</button>
      </div>

      <div id="svcStepCatalog" class="wizard-step">
        <p class="wizard-desc">Choose a service to deploy to one of your worker nodes.</p>
        <div class="wizard-preset-grid">
          <button class="svc-catalog-card" data-svc="stt-service">
            <strong>Speech to Text</strong>
            <small>GPU-accelerated transcription API + UI powered by faster-whisper. Drag-and-drop audio, language detection, word timestamps.</small>
          </button>
          <button class="svc-catalog-card" data-svc="container-service">
            <strong>Custom Container Service</strong>
            <small>Deploy any Docker image as a long-running service with health checks, ports, and volume mounts.</small>
          </button>
          <button class="svc-catalog-card" data-svc="container-job">
            <strong>Scheduled Container Job</strong>
            <small>Build and run a containerised task on a cron schedule (e.g. data pipelines, backups).</small>
          </button>
        </div>
        <div class="wizard-actions">
          <button id="svcCatalogCancelBtn" class="wizard-btn-secondary">Cancel</button>
          <button id="svcCatalogNextBtn" class="wizard-btn-primary" disabled>Next</button>
        </div>
      </div>

      <div id="svcStepConfig" class="wizard-step" hidden>
        <p class="wizard-desc" id="svcConfigDesc">Configure the service for your node.</p>
        <div id="svcConfigFields" class="wizard-form-grid"></div>
        <div class="wizard-actions">
          <button id="svcConfigBackBtn" class="wizard-btn-secondary">Back</button>
          <button id="svcConfigDeployBtn" class="wizard-btn-primary">Save &amp; Deploy</button>
        </div>
      </div>

      <div id="svcStepDeploy" class="wizard-step" hidden>
        <div id="svcDeployLog" class="wizard-log"></div>
        <div id="svcDeployActions" class="wizard-actions" hidden>
          <button id="svcDeployCloseBtn" class="wizard-btn-secondary">Close</button>
        </div>
      </div>
    </div>
  </dialog>

  <div class="action-dock">
    <div class="action-dock-header">
      <button id="toggleActionFeedButton" class="action-dock-toggle">Hide History</button>
    </div>
    <div id="status" class="status-ok">Current</div>
    <div id="actionFeed" class="action-feed">
      <p class="action-feed-empty">No recent actions.</p>
    </div>
  </div>
  <script>
    const state = {
      config: null,
      runtime: null,
      workflows: [],
      jobsCatalog: [],
      minecraftStatuses: {},
      remoteServiceStatuses: {},
      chatProviders: [],
      providerModels: {},
      ttsStatus: null,
      ttsVoices: [],
      piProxyRegistry: null,
      piProxyStatus: null,
      kulrsActivityStatus: null,
      actionFeedCollapsed: false,
      agentRun: {
        agentId: '',
        prompt: 'Give me a short readiness check in character, then confirm the local model route is working.',
        contextJson: '{}',
        deliveryJson: '{}',
        workflowSeedPath: '${DEFAULT_WORKFLOW_SEED_PATH}',
        result: null
      },
      activeTab: 'overview'
    };
    function normalizeClientBasePath(pathValue) {
      if (!pathValue || pathValue === '/') {
        return '/';
      }
      if (pathValue.endsWith('/')) {
        return pathValue;
      }
      const lastSlash = pathValue.lastIndexOf('/');
      if (lastSlash <= 0) {
        return pathValue + '/';
      }
      const tail = pathValue.slice(lastSlash + 1);
      return tail.includes('.') ? pathValue.slice(0, lastSlash + 1) : pathValue + '/';
    }

    function resolveClientBasePath() {
      const metaBasePath = document.querySelector('meta[name="gateway-base-path"]')?.content || '/';
      if (metaBasePath && metaBasePath !== '/') {
        return normalizeClientBasePath(metaBasePath);
      }
      return normalizeClientBasePath(window.location.pathname || '/');
    }

    const basePath = resolveClientBasePath();
    let actionFeedCollapseTimer = null;

    function applyActionFeedVisibility() {
      const feed = document.getElementById('actionFeed');
      const toggle = document.getElementById('toggleActionFeedButton');
      if (!feed || !toggle) {
        return;
      }
      feed.classList.toggle('is-collapsed', state.actionFeedCollapsed);
      toggle.textContent = state.actionFeedCollapsed ? 'Show History' : 'Hide History';
    }

    function scheduleActionFeedAutoCollapse() {
      if (actionFeedCollapseTimer) {
        clearTimeout(actionFeedCollapseTimer);
      }
      actionFeedCollapseTimer = setTimeout(() => {
        state.actionFeedCollapsed = true;
        applyActionFeedVisibility();
      }, 5000);
    }

    function pushActionFeed(message, kind = 'ok') {
      const feed = document.getElementById('actionFeed');
      if (!feed) {
        return;
      }
      state.actionFeedCollapsed = false;
      applyActionFeedVisibility();
      const empty = feed.querySelector('.action-feed-empty');
      if (empty) {
        empty.remove();
      }
      const entry = document.createElement('div');
      entry.className = 'action-entry ' + (kind === 'error' ? 'error' : kind === 'progress' ? 'progress' : 'ok');
      const title = document.createElement('strong');
      title.textContent = message;
      const time = document.createElement('time');
      time.textContent = new Date().toLocaleTimeString();
      entry.appendChild(title);
      entry.appendChild(time);
      feed.prepend(entry);
      while (feed.children.length > 8) {
        feed.removeChild(feed.lastElementChild);
      }
    }

    function setStatus(message, kind = 'ok', options = {}) {
      const status = document.getElementById('status');
      status.textContent = message;
      status.title = message;
      status.className = kind === 'error' ? 'status-error' : kind === 'progress' ? 'status-progress' : 'status-ok';
      if (kind === 'progress' || kind === 'error') {
        if (actionFeedCollapseTimer) {
          clearTimeout(actionFeedCollapseTimer);
        }
        state.actionFeedCollapsed = false;
        applyActionFeedVisibility();
      } else {
        scheduleActionFeedAutoCollapse();
      }
      if (options.log !== false) {
        pushActionFeed(message, kind);
      }
    }

    async function withBusyButton(button, pendingLabel, task) {
      if (!button) {
        return await task();
      }
      const originalLabel = button.dataset.originalLabel || button.textContent || '';
      button.dataset.originalLabel = originalLabel;
      const lockedWidth = button.offsetWidth;
      if (lockedWidth > 0) {
        button.style.width = lockedWidth + 'px';
      }
      button.disabled = true;
      button.classList.add('is-busy');
      button.setAttribute('aria-busy', 'true');
      if (pendingLabel) {
        button.textContent = pendingLabel;
      }
      try {
        return await task();
      } finally {
        button.disabled = false;
        button.classList.remove('is-busy');
        button.removeAttribute('aria-busy');
        button.textContent = originalLabel;
        button.style.removeProperty('width');
      }
    }

    function setLocalActionOutput(container, message, kind = 'ok') {
      if (!container) {
        return;
      }
      container.className = 'inline-action-output' + (kind === 'error' ? ' is-error' : kind === 'progress' ? ' is-progress' : '');
      container.innerHTML = '<strong>Action Output</strong><div>' + escapeHtml(message) + '</div><div>' + escapeHtml(new Date().toLocaleString()) + '</div>';
    }

    function joinBase(path) {
      const normalizedPath = path.startsWith('/api/') ? '/__admin' + path : path;
      if (basePath === '/') {
        return normalizedPath.startsWith('/') ? normalizedPath : \`/\${normalizedPath}\`;
      }
      const normalizedBase = basePath.endsWith('/') ? basePath : \`\${basePath}/\`;
      const relativePath = normalizedPath.startsWith('/') ? normalizedPath.slice(1) : normalizedPath;
      return \`\${normalizedBase}\${relativePath}\`;
    }

    function syncRawJson() {
      document.getElementById('rawJson').value = JSON.stringify(state.config, null, 2);
    }

    function renderActiveTab() {
      document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.tabPanel !== state.activeTab;
      });
      document.querySelectorAll('.top-tab-nav .tab-button').forEach((button) => {
        button.classList.toggle('active', button.dataset.tab === state.activeTab);
      });
    }

    function switchSubTab(groupName, subTabId) {
      const group = document.querySelector('[data-sub-group="' + groupName + '"]');
      if (!group) return;
      const parent = group.parentElement;
      parent.querySelectorAll('.sub-tab-panel').forEach((panel) => {
        panel.classList.toggle('active', panel.dataset.subTabPanel === subTabId);
      });
      group.querySelectorAll('.sub-tab-button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.subTab === subTabId);
      });
    }

    function updateGatewayField(key, value) {
      state.config.gateway[key] = value;
      syncRawJson();
    }

    function updateAdminUiField(key, value) {
      state.config.gateway.adminUi[key] = value;
      syncRawJson();
    }

    function appOptions(selectedAppId) {
      return state.config.apps.map((app) => \`<option value="\${app.id}" \${app.id === selectedAppId ? 'selected' : ''}>\${app.id || '(unset app id)'}</option>\`).join('');
    }

    function findEnvironmentEntry(environment, key) {
      return environment.find((entry) => entry.key === key);
    }

    function getEnvironmentValue(environment, key, fallback = '') {
      return findEnvironmentEntry(environment, key)?.value || fallback;
    }

    function upsertEnvironmentEntry(environment, key, value, description, secret = false) {
      const existing = findEnvironmentEntry(environment, key);
      if (!value) {
        const index = environment.findIndex((entry) => entry.key === key);
        if (index >= 0) {
          environment.splice(index, 1);
        }
        return;
      }
      if (existing) {
        existing.value = value;
        existing.secret = secret;
        existing.description = description;
        return;
      }
      environment.push({ key, value, secret, description });
    }

    function renderEnvironmentList(containerId, environment, onRemove) {
      const container = document.getElementById(containerId);
      container.innerHTML = '';
      environment.forEach((entry, index) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${entry.key || 'new-env-var'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label>Key<input data-field="key" value="\${entry.key}" /></label>
            <label>Value<input data-field="value" value="\${entry.value}" /></label>
            <label class="check"><input type="checkbox" data-field="secret" \${entry.secret ? 'checked' : ''} /> Secret</label>
          </div>
          <label>Description<input data-field="description" value="\${entry.description || ''}" /></label>
        \`;

        element.querySelector('.danger').addEventListener('click', () => onRemove(index));
        element.querySelectorAll('input').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          input.addEventListener(isCheckbox ? 'change' : 'input', () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            entry[field] = isCheckbox ? input.checked : input.value;
            if (field === 'description' && !input.value) {
              delete entry.description;
            }
            if (isCheckbox) {
              renderSecrets();
            }
            syncRawJson();
          });
        });
        container.appendChild(element);
      });
    }

    function renderSecretEnvironmentList(containerId, environment, onAddSecret, onRenderFullProfile) {
      const container = document.getElementById(containerId);
      container.innerHTML = '';
      const secrets = environment
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.secret);

      if (secrets.length === 0) {
        container.innerHTML = '<div>No secret env vars configured yet.</div>';
        return;
      }

      secrets.forEach(({ entry, index }) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${entry.key || 'new-secret-env-var'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label>Key<input data-field="key" value="\${entry.key}" /></label>
            <label>Value<input type="password" data-field="value" value="\${entry.value}" /></label>
            <label class="check"><input type="checkbox" data-field="secret" \${entry.secret ? 'checked' : ''} /> Secret</label>
          </div>
          <label>Description<input data-field="description" value="\${entry.description || ''}" /></label>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          environment.splice(index, 1);
          onRenderFullProfile();
          renderSecrets();
          syncRawJson();
        });

        element.querySelectorAll('input').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          input.addEventListener(isCheckbox ? 'change' : 'input', () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            entry[field] = isCheckbox ? input.checked : input.value;
            if (field === 'description' && !input.value) {
              delete entry.description;
            }
            if (isCheckbox) {
              onRenderFullProfile();
              renderSecrets();
            }
            syncRawJson();
          });
        });

        container.appendChild(element);
      });
    }

    function parseJsonField(value, fallback) {
      if (!value.trim()) {
        return fallback;
      }
      return JSON.parse(value);
    }

    function createWorkflowDraft() {
      return {
        id: '',
        name: '',
        enabled: true,
        schedule: '*/15 * * * *',
        sleepUntil: null,
        target: { type: 'shell', ref: '' },
        input: {},
        secrets: [],
        timeoutSeconds: undefined,
        retryPolicy: {},
        lastRunAt: null,
        lastStatus: 'idle',
        lastError: null,
        createdAt: '',
        updatedAt: '',
        __draft: true
      };
    }

    function parseOptionalJsonText(value) {
      const trimmed = value.trim();
      if (!trimmed || trimmed === '{}' || trimmed === 'null') {
        return undefined;
      }
      return JSON.parse(trimmed);
    }

    function configuredAgents() {
      if (!state.config) {
        return [];
      }
      return state.config.serviceProfiles.gatewayChatPlatform.agents || [];
    }

    function normalizeTtsVoice(voice) {
      if (typeof voice === 'string') {
        return { id: voice };
      }

      if (voice && typeof voice === 'object') {
        const id = typeof voice.id === 'string'
          ? voice.id
          : typeof voice.voice === 'string'
            ? voice.voice
            : typeof voice.name === 'string'
              ? voice.name
              : JSON.stringify(voice);
        return {
          id,
          name: typeof voice.name === 'string' ? voice.name : undefined,
          description: typeof voice.description === 'string' ? voice.description : undefined,
          source: typeof voice.source === 'string' ? voice.source : undefined
        };
      }

      return { id: String(voice) };
    }

    function normalizedTtsVoices() {
      return Array.isArray(state.ttsVoices) ? state.ttsVoices.map((voice) => normalizeTtsVoice(voice)) : [];
    }

    function normalizedChatProviders() {
      return Array.isArray(state.chatProviders) ? state.chatProviders.filter((provider) => provider.status !== 'unconfigured') : [];
    }

    function firstAvailableProviderName() {
      const providers = normalizedChatProviders();
      return providers[0]?.name || '';
    }

    function providerOptions(currentProviderName) {
      const providers = normalizedChatProviders();
      const knownProviders = [...providers];
      if (currentProviderName && !knownProviders.some((provider) => provider.name === currentProviderName)) {
        knownProviders.unshift({ name: currentProviderName, status: 'ok' });
      }
      const options = [];
      if (!currentProviderName) {
        options.push('<option value="" selected disabled>Select provider</option>');
      }
      return options.concat(
        knownProviders
          .map((provider) => \`<option value="\${provider.name}" \${provider.name === currentProviderName ? 'selected' : ''}>\${provider.name}</option>\`)
      ).join('');
    }

    function normalizeModel(model) {
      if (!model || typeof model !== 'object') {
        return { id: String(model || '') };
      }
      return {
        id: typeof model.id === 'string' ? model.id : typeof model.name === 'string' ? model.name : JSON.stringify(model),
        name: typeof model.name === 'string' ? model.name : undefined
      };
    }

    function modelOptions(providerName, currentModel) {
      const rawModels = Array.isArray(state.providerModels?.[providerName]) ? state.providerModels[providerName] : [];
      const knownModels = rawModels.map((model) => normalizeModel(model));
      if (currentModel && !knownModels.some((model) => model.id === currentModel)) {
        knownModels.unshift({ id: currentModel, name: currentModel });
      }
      const options = [];
      if (!currentModel) {
        options.push(\`<option value="" selected \${providerName ? '' : 'disabled'}>\${providerName ? 'Select model' : 'Choose provider first'}</option>\`);
      }
      return options.concat(
        knownModels
          .map((model) => \`<option value="\${model.id}" \${model.id === currentModel ? 'selected' : ''}>\${model.name || model.id}</option>\`)
      ).join('');
    }

    function firstAvailableModelId(providerName) {
      const rawModels = Array.isArray(state.providerModels?.[providerName]) ? state.providerModels[providerName] : [];
      const knownModels = rawModels.map((model) => normalizeModel(model)).filter((model) => model.id);
      return knownModels[0]?.id || '';
    }

    function ensureAgentProviderAndModel(agent) {
      if (!agent.providerName) {
        agent.providerName = firstAvailableProviderName();
      }
      if (!agent.model && agent.providerName) {
        agent.model = firstAvailableModelId(agent.providerName);
      }
    }

    function getAgentChatTemplate(agent) {
      return agent.endpointConfig?.modelParams?.chatTemplate || '';
    }

    function setAgentChatTemplate(agent, chatTemplate) {
      if (!chatTemplate) {
        if (agent.endpointConfig?.modelParams && typeof agent.endpointConfig.modelParams === 'object') {
          delete agent.endpointConfig.modelParams.chatTemplate;
          if (Object.keys(agent.endpointConfig.modelParams).length === 0) {
            delete agent.endpointConfig.modelParams;
          }
        }
        if (agent.endpointConfig && Object.keys(agent.endpointConfig).length === 0) {
          delete agent.endpointConfig;
        }
        return;
      }

      agent.endpointConfig = agent.endpointConfig || {};
      agent.endpointConfig.modelParams = agent.endpointConfig.modelParams || {};
      agent.endpointConfig.modelParams.chatTemplate = chatTemplate;
    }

    function ensureAgentRunDefaults() {
      const agents = configuredAgents();
      if (agents.length === 0) {
        state.agentRun.agentId = '';
        return;
      }
      if (!agents.some((agent) => agent.id === state.agentRun.agentId)) {
        state.agentRun.agentId = (agents.find((agent) => agent.enabled) || agents[0]).id;
      }
    }

    function getAgentVoiceId(agent) {
      return agent.endpointConfig?.modelParams?.ttsVoiceId || state.config.serviceProfiles.gatewayChatPlatform.tts.defaultVoice || '';
    }

    function setAgentVoiceId(agent, voiceId) {
      if (!voiceId) {
        if (agent.endpointConfig?.modelParams && typeof agent.endpointConfig.modelParams === 'object') {
          delete agent.endpointConfig.modelParams.ttsVoiceId;
          if (Object.keys(agent.endpointConfig.modelParams).length === 0) {
            delete agent.endpointConfig.modelParams;
          }
        }
        if (agent.endpointConfig && Object.keys(agent.endpointConfig).length === 0) {
          delete agent.endpointConfig;
        }
        return;
      }

      agent.endpointConfig = agent.endpointConfig || {};
      agent.endpointConfig.modelParams = agent.endpointConfig.modelParams || {};
      agent.endpointConfig.modelParams.ttsVoiceId = voiceId;
    }

    function renderGatewayApiProfile() {
      const profile = state.config.serviceProfiles.gatewayApi;
      document.getElementById('gatewayApiProfileEnabled').checked = profile.enabled;
      document.getElementById('gatewayApiProfileAppId').innerHTML = appOptions(profile.appId);
      document.getElementById('gatewayApiProfileApiBaseUrl').value = profile.apiBaseUrl;
      document.getElementById('gatewayApiProfileEnvFilePath').value = profile.envFilePath;
      renderEnvironmentList('gatewayApiEnvContainer', profile.environment, (index) => {
        profile.environment.splice(index, 1);
        renderGatewayApiProfile();
        renderSecrets();
        syncRawJson();
      });
    }

    function renderGatewayApiJobRuntimeProfile() {
      const runtime = state.config.serviceProfiles.gatewayApi.jobRuntime;
      document.getElementById('gatewayApiJobChannelsFilePath').value = runtime.channelsFilePath;

      const container = document.getElementById('gatewayApiJobChannelsContainer');
      container.innerHTML = '';
      if (runtime.channels.length === 0) {
        container.innerHTML = '<div>No delivery channels configured yet.</div>';
        return;
      }

      runtime.channels.forEach((channel, index) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${channel.id || 'new-channel'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${channel.enabled ? 'checked' : ''} /> Enabled</label>
            <label>Channel Id<input data-field="id" value="\${channel.id}" /></label>
            <label>Type
              <select data-field="type">
                <option value="telegram" \${channel.type === 'telegram' ? 'selected' : ''}>telegram</option>
                <option value="webhook" \${channel.type === 'webhook' ? 'selected' : ''}>webhook</option>
              </select>
            </label>
            <label>Description<input data-field="description" value="\${channel.description || ''}" /></label>
          </div>
          <div class="row">
            <label>Telegram Bot Token<input type="password" data-field="botToken" value="\${channel.botToken || ''}" /></label>
            <label>Telegram Chat Id<input data-field="chatId" value="\${channel.chatId || ''}" /></label>
            <label>Parse Mode<input data-field="parseMode" value="\${channel.parseMode || ''}" /></label>
            <label>Thread Id<input type="number" data-field="messageThreadId" value="\${channel.messageThreadId ?? ''}" /></label>
          </div>
          <div class="row">
            <label>Webhook URL<input data-field="webhookUrl" value="\${channel.webhookUrl || ''}" /></label>
          </div>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          runtime.channels.splice(index, 1);
          renderGatewayApiJobRuntimeProfile();
          renderSecrets();
          syncRawJson();
        });

        element.querySelectorAll('input, select').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          const isSelect = input.tagName === 'SELECT';
          const eventName = isCheckbox || isSelect ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            if (field === 'enabled') {
              channel.enabled = input.checked;
            } else if (field === 'messageThreadId') {
              channel.messageThreadId = input.value ? Number(input.value) : undefined;
              if (!input.value) {
                delete channel.messageThreadId;
              }
            } else {
              channel[field] = input.value;
              if ((field === 'description' || field === 'botToken' || field === 'chatId' || field === 'parseMode' || field === 'webhookUrl') && !input.value) {
                delete channel[field];
              }
            }
            if (isCheckbox || isSelect || field === 'type') {
              renderSecrets();
            }
            syncRawJson();
          });
        });

        container.appendChild(element);
      });
    }

    function renderKulrsActivityProfile() {
      const kulrs = state.config.serviceProfiles.gatewayApi.kulrsActivity;
      document.getElementById('kulrsEnabled').checked = kulrs.enabled;
      document.getElementById('kulrsSchedule').value = kulrs.schedule;
      document.getElementById('kulrsUser').value = kulrs.user;
      document.getElementById('kulrsGroup').value = kulrs.group || '';
      document.getElementById('kulrsTimezone').value = kulrs.timezone;
      document.getElementById('kulrsEnvFilePath').value = kulrs.envFilePath;
      document.getElementById('kulrsCredentialsFilePath').value = kulrs.credentialsFilePath;
      document.getElementById('kulrsWorkspaceDir').value = kulrs.workspaceDir;
      document.getElementById('kulrsWorkingDirectory').value = kulrs.workingDirectory;
      document.getElementById('kulrsExecStart').value = kulrs.execStart;
      document.getElementById('kulrsDescription').value = kulrs.description;
      document.getElementById('kulrsFirebaseApiKey').value = kulrs.firebaseApiKey;
      document.getElementById('kulrsUnsplashAccessKey').value = kulrs.unsplashAccessKey;
      const statusMeta = document.getElementById('kulrsStatus');
      if (!state.kulrsActivityStatus) {
        statusMeta.innerHTML = '<div><strong>Runtime Status:</strong> not checked yet</div>';
      } else if (state.kulrsActivityStatus.error) {
        statusMeta.innerHTML = [
          '<div><strong>Runtime Status:</strong> error</div>',
          '<div><strong>Detail:</strong> ' + escapeHtml(state.kulrsActivityStatus.error) + '</div>'
        ].join('');
      } else {
        statusMeta.innerHTML = [
          '<div><strong>Config Enabled:</strong> ' + escapeHtml(state.kulrsActivityStatus.configuredEnabled ? 'yes' : 'no') + '</div>',
          '<div><strong>Timer State:</strong> ' + escapeHtml(state.kulrsActivityStatus.timerActiveState + '/' + state.kulrsActivityStatus.timerSubState) + '</div>',
          '<div><strong>Timer Installed:</strong> ' + escapeHtml(state.kulrsActivityStatus.timerInstalled ? 'yes' : 'no') + '</div>',
          '<div><strong>Timer Unit File:</strong> ' + escapeHtml(state.kulrsActivityStatus.timerUnitFileState || 'unknown') + '</div>',
          '<div><strong>Last Run:</strong> ' + escapeHtml(formatTimestamp(state.kulrsActivityStatus.lastRunAt)) + '</div>',
          '<div><strong>Next Run:</strong> ' + escapeHtml(formatTimestamp(state.kulrsActivityStatus.nextRunAt)) + '</div>',
          '<div><strong>Drift:</strong> ' + escapeHtml(state.kulrsActivityStatus.driftDetected ? 'yes' : 'no') + '</div>',
          '<div><strong>Summary:</strong> ' + escapeHtml(state.kulrsActivityStatus.summary || 'unknown') + '</div>'
        ].join('');
      }

      const container = document.getElementById('kulrsBotsContainer');
      container.innerHTML = '';
      if (kulrs.bots.length === 0) {
        container.innerHTML = '<div>No KULRS bot credentials configured yet.</div>';
        return;
      }

      kulrs.bots.forEach((bot, index) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${bot.id || 'new-kulrs-bot'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label>Bot Id<input data-field="id" value="\${bot.id}" /></label>
            <label>Email<input data-field="email" value="\${bot.email}" /></label>
            <label>Password<input type="password" data-field="password" value="\${bot.password}" /></label>
          </div>
          <label>Description<input data-field="description" value="\${bot.description || ''}" /></label>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          kulrs.bots.splice(index, 1);
          renderKulrsActivityProfile();
          renderSecrets();
          syncRawJson();
        });

        element.querySelectorAll('input').forEach((input) => {
          input.addEventListener('input', () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            bot[field] = input.value;
            if (field === 'description' && !input.value) {
              delete bot.description;
            }
            syncRawJson();
          });
        });

        container.appendChild(element);
      });
    }

    function renderGatewayChatPlatformProfile() {
      const profile = state.config.serviceProfiles.gatewayChatPlatform;
      document.getElementById('gatewayChatProfileEnabled').checked = profile.enabled;
      document.getElementById('gatewayChatProfileAppId').innerHTML = appOptions(profile.appId);
      document.getElementById('gatewayChatProfileApiBaseUrl').value = profile.apiBaseUrl;
      document.getElementById('gatewayChatProfileEnvFilePath').value = profile.apiEnvFilePath;
      document.getElementById('gatewayChatRedisUrl').value = getEnvironmentValue(profile.environment, 'REDIS_URL');
      document.getElementById('gatewayChatDefaultUserId').value = getEnvironmentValue(profile.environment, 'CHAT_DEFAULT_USER_ID', 'me');
      document.getElementById('gatewayChatDefaultChannelId').value = getEnvironmentValue(profile.environment, 'CHAT_DEFAULT_CHANNEL_ID', 'coach');
      document.getElementById('gatewayChatTtsEnabled').checked = profile.tts.enabled;
      document.getElementById('gatewayChatTtsBaseUrl').value = profile.tts.baseUrl;
      document.getElementById('gatewayChatTtsDefaultVoice').value = profile.tts.defaultVoice;
      document.getElementById('gatewayChatTtsGeneratePath').value = profile.tts.generatePath;
      document.getElementById('gatewayChatTtsStreamPath').value = profile.tts.streamPath;
      document.getElementById('gatewayChatTtsVoicesPath').value = profile.tts.voicesPath;
      document.getElementById('gatewayChatTtsHealthPath').value = profile.tts.healthPath;
      renderEnvironmentList('gatewayChatEnvContainer', profile.environment, (index) => {
        profile.environment.splice(index, 1);
        renderGatewayChatPlatformProfile();
        renderSecrets();
        syncRawJson();
      });

      const ttsStatus = document.getElementById('ttsStatus');
      if (!state.ttsStatus) {
        ttsStatus.innerHTML = '<div>TTS status not checked yet.</div>';
      } else {
        const voices = Array.isArray(state.ttsStatus.voices)
          ? state.ttsStatus.voices.map((voice) => {
              if (typeof voice === 'string') {
                return voice;
              }
              if (voice && typeof voice === 'object' && 'id' in voice) {
                return String(voice.id);
              }
              return JSON.stringify(voice);
            }).join(', ')
          : JSON.stringify(state.ttsStatus.voices);
        ttsStatus.innerHTML = [
          \`<div><strong>Health:</strong> \${state.ttsStatus.healthStatus === null ? 'disabled' : state.ttsStatus.healthStatus}</div>\`,
          \`<div><strong>Voices:</strong> \${voices || 'none reported'}</div>\`
        ].join('');
      }

      const ttsVoicesContainer = document.getElementById('ttsVoicesContainer');
      const voices = normalizedTtsVoices();
      if (voices.length === 0) {
        ttsVoicesContainer.innerHTML = '<div>No voices loaded yet.</div>';
      } else {
        ttsVoicesContainer.innerHTML = '';
        voices.forEach((voice) => {
          const element = document.createElement('div');
          element.className = 'card';
          element.innerHTML = \`
            <div class="split-actions">
              <div><strong>\${voice.name || voice.id}</strong></div>
              <button class="danger" data-action="delete-voice">Delete</button>
            </div>
            <div class="meta-list">
              <div><strong>ID:</strong> \${voice.id}</div>
              <div><strong>Description:</strong> \${voice.description || 'none'}</div>
              <div><strong>Source:</strong> \${voice.source || 'unknown'}</div>
            </div>
          \`;
          element.querySelector('[data-action="delete-voice"]').addEventListener('click', async () => {
            try {
              await requestJson('DELETE', \`/api/tts/voices/\${encodeURIComponent(voice.id)}\`);
              await fetchTtsVoices();
              setStatus(\`Deleted voice \${voice.id}\`);
            } catch (error) {
              setStatus(error.message, 'error');
            }
          });
          ttsVoicesContainer.appendChild(element);
        });
      }

      const agentsContainer = document.getElementById('gatewayChatAgentsContainer');
      agentsContainer.innerHTML = '';
      const voiceOptions = normalizedTtsVoices();
      profile.agents.forEach((agent, index) => {
        ensureAgentProviderAndModel(agent);
        const currentVoiceId = getAgentVoiceId(agent);
        const currentChatTemplate = getAgentChatTemplate(agent);
        const knownVoices = [...voiceOptions];
        if (currentVoiceId && !knownVoices.some((voice) => voice.id === currentVoiceId)) {
          knownVoices.unshift({ id: currentVoiceId, name: currentVoiceId });
        }
        const voiceSelectOptions = knownVoices
          .map((voice) => \`<option value="\${voice.id}" \${voice.id === currentVoiceId ? 'selected' : ''}>\${voice.name || voice.id}</option>\`)
          .join('');
        const providerSelectOptions = providerOptions(agent.providerName);
        const modelSelectOptions = modelOptions(agent.providerName, agent.model);
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${agent.name || agent.id || 'new-agent'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${agent.enabled ? 'checked' : ''} /> Enabled</label>
            <label>Agent Id<input data-field="id" value="\${agent.id}" /></label>
            <label>Name<input data-field="name" value="\${agent.name}" /></label>
            <label>Icon<input data-field="icon" value="\${agent.icon}" /></label>
            <label>Color<input data-field="color" value="\${agent.color}" /></label>
            <label>Provider
              <select data-field="providerName">
                \${providerSelectOptions}
              </select>
            </label>
            <label>Model
              <select data-field="model">
                \${modelSelectOptions}
              </select>
            </label>
            <label>Chat Template
              <select data-field="chatTemplate">
                <option value="" \${!currentChatTemplate ? 'selected' : ''}>(provider default)</option>
                <option value="llama3" \${currentChatTemplate === 'llama3' ? 'selected' : ''}>llama3</option>
              </select>
            </label>
            <label>Voice
              <select data-field="ttsVoiceId">
                <option value="">(use default)</option>
                \${voiceSelectOptions}
              </select>
            </label>
            <label>Cost Class
              <select data-field="costClass">
                <option value="free" \${agent.costClass === 'free' ? 'selected' : ''}>free</option>
                <option value="cheap" \${agent.costClass === 'cheap' ? 'selected' : ''}>cheap</option>
                <option value="premium" \${agent.costClass === 'premium' ? 'selected' : ''}>premium</option>
              </select>
            </label>
            <label>Temperature<input type="number" step="0.1" data-field="temperature" value="\${agent.temperature ?? ''}" /></label>
            <label>Max Tokens<input type="number" data-field="maxTokens" value="\${agent.maxTokens ?? ''}" /></label>
            <label class="check"><input type="checkbox" data-field="enableReasoning" \${agent.enableReasoning ? 'checked' : ''} /> Reasoning</label>
          </div>
          <label>System Prompt<textarea data-field="systemPrompt">\${agent.systemPrompt || ''}</textarea></label>
          <label>Feature Flags JSON<textarea data-field="featureFlags">\${JSON.stringify(agent.featureFlags || {}, null, 2)}</textarea></label>
          <label>Routing Policy JSON<textarea data-field="routingPolicy">\${JSON.stringify(agent.routingPolicy || {}, null, 2)}</textarea></label>
          <label>Endpoint Config JSON<textarea data-field="endpointConfig">\${JSON.stringify(agent.endpointConfig || {}, null, 2)}</textarea></label>
          <label>Context Sources JSON<textarea data-field="contextSources">\${JSON.stringify(agent.contextSources || [], null, 2)}</textarea></label>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          profile.agents.splice(index, 1);
          renderGatewayChatPlatformProfile();
          syncRawJson();
        });

        element.querySelectorAll('input, select, textarea').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          const isSelect = input.tagName === 'SELECT';
          const eventName = isCheckbox || isSelect ? 'change' : 'input';
          input.addEventListener(eventName, async () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            if (field === 'enabled' || field === 'enableReasoning') {
              agent[field] = input.checked;
            } else if (field === 'temperature' || field === 'maxTokens') {
              agent[field] = input.value ? Number(input.value) : undefined;
              if (!input.value) {
                delete agent[field];
              }
            } else if (field === 'featureFlags') {
              agent.featureFlags = parseJsonField(input.value, {});
            } else if (field === 'routingPolicy') {
              const value = parseJsonField(input.value, {});
              agent.routingPolicy = Object.keys(value).length > 0 ? value : undefined;
              if (!agent.routingPolicy) delete agent.routingPolicy;
            } else if (field === 'endpointConfig') {
              const value = parseJsonField(input.value, {});
              agent.endpointConfig = Object.keys(value).length > 0 ? value : undefined;
              if (!agent.endpointConfig) delete agent.endpointConfig;
            } else if (field === 'contextSources') {
              agent.contextSources = parseJsonField(input.value, []);
            } else if (field === 'ttsVoiceId') {
              setAgentVoiceId(agent, input.value);
            } else if (field === 'chatTemplate') {
              setAgentChatTemplate(agent, input.value);
              renderGatewayChatPlatformProfile();
            } else if (field === 'systemPrompt') {
              agent.systemPrompt = input.value || undefined;
              if (!input.value) delete agent.systemPrompt;
            } else if (field === 'providerName') {
              agent.providerName = input.value;
              await fetchChatProviderModels(agent.providerName);
              agent.model = firstAvailableModelId(agent.providerName);
              renderGatewayChatPlatformProfile();
            } else {
              agent[field] = input.value;
            }
            syncRawJson();
          });
        });

        agentsContainer.appendChild(element);
      });
    }

    function renderWorkflows() {
      const container = document.getElementById('workflowsContainer');
      container.innerHTML = '';
      if (state.workflows.length === 0) {
        container.innerHTML = '<p>No workflows yet.</p>';
        return;
      }

      state.workflows.forEach((workflow, index) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div>
              <strong>\${workflow.name || 'new-workflow'}</strong>
              <p>Status: \${workflow.lastStatus || 'idle'} | Enabled: \${workflow.enabled ? 'yes' : 'no'}</p>
            </div>
            <div class="toolbar">
              <button data-action="save" class="primary">\${workflow.__draft ? 'Create' : 'Save'}</button>
              <button data-action="run">Run</button>
              <button data-action="toggle">\${workflow.enabled ? 'Disable' : 'Enable'}</button>
              <button data-action="sleep">Sleep</button>
              <button data-action="resume">Resume</button>
              <button data-action="delete" class="danger">Delete</button>
            </div>
          </div>
          <div class="row">
            <label>Name<input data-field="name" value="\${workflow.name || ''}" /></label>
            <label>Schedule<input data-field="schedule" value="\${workflow.schedule || ''}" /></label>
            <label>Target Type<input data-field="target.type" value="\${workflow.target?.type || ''}" /></label>
            <label>Target Ref<input data-field="target.ref" value="\${workflow.target?.ref || ''}" /></label>
            <label>Timeout Seconds<input type="number" data-field="timeoutSeconds" value="\${workflow.timeoutSeconds ?? ''}" /></label>
            <label>Sleep Until<input data-field="sleepUntil" value="\${workflow.sleepUntil || ''}" placeholder="2026-04-01T00:00:00Z" /></label>
          </div>
          <label>Secrets (comma separated)<input data-field="secrets" value="\${(workflow.secrets || []).join(', ')}" /></label>
          <label>Input JSON<textarea data-field="input">\${JSON.stringify(workflow.input || {}, null, 2)}</textarea></label>
          <label>Retry Policy JSON<textarea data-field="retryPolicy">\${JSON.stringify(workflow.retryPolicy || {}, null, 2)}</textarea></label>
          <div class="meta-list">
            <div><strong>ID:</strong> \${workflow.id || 'not created yet'}</div>
            <div><strong>Last Run:</strong> \${workflow.lastRunAt || 'never'}</div>
            <div><strong>Last Error:</strong> \${workflow.lastError || 'none'}</div>
            <div><strong>Updated:</strong> \${workflow.updatedAt || 'not saved yet'}</div>
          </div>
        \`;

        element.querySelectorAll('input, textarea').forEach((input) => {
          input.addEventListener('input', () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            if (field === 'target.type') {
              workflow.target.type = input.value;
            } else if (field === 'target.ref') {
              workflow.target.ref = input.value;
            } else if (field === 'timeoutSeconds') {
              workflow.timeoutSeconds = input.value ? Number(input.value) : undefined;
              if (!input.value) {
                delete workflow.timeoutSeconds;
              }
            } else if (field === 'secrets') {
              workflow.secrets = input.value.split(',').map((item) => item.trim()).filter(Boolean);
            } else if (field === 'input') {
              workflow.input = parseJsonField(input.value, {});
            } else if (field === 'retryPolicy') {
              const value = parseJsonField(input.value, {});
              workflow.retryPolicy = Object.keys(value).length > 0 ? value : undefined;
              if (!workflow.retryPolicy) {
                delete workflow.retryPolicy;
              }
            } else if (field === 'sleepUntil') {
              workflow.sleepUntil = input.value || null;
            } else {
              workflow[field] = input.value;
            }
          });
        });

        element.querySelector('[data-action="save"]').addEventListener('click', async () => {
          try {
            const body = {
              name: workflow.name,
              schedule: workflow.schedule,
              target: workflow.target,
              enabled: workflow.enabled,
              input: workflow.input,
              secrets: workflow.secrets,
              timeoutSeconds: workflow.timeoutSeconds,
              retryPolicy: workflow.retryPolicy
            };
            if (workflow.__draft) {
              await requestJson('POST', '/api/workflows', body);
            } else {
              await requestJson('PUT', \`/api/workflows/\${workflow.id}\`, body);
            }
            await fetchWorkflows();
            setStatus(\`Workflow \${workflow.__draft ? 'created' : 'saved'}\`);
          } catch (error) {
            setStatus(error.message, 'error');
          }
        });

        element.querySelector('[data-action="run"]').addEventListener('click', async () => {
          if (!workflow.id) {
            setStatus('Create the workflow before running it', 'error');
            return;
          }
          try {
            await requestJson('POST', \`/api/workflows/\${workflow.id}/run\`);
            await fetchWorkflows();
            setStatus('Workflow run triggered');
          } catch (error) {
            setStatus(error.message, 'error');
          }
        });

        element.querySelector('[data-action="toggle"]').addEventListener('click', async () => {
          if (!workflow.id) {
            workflow.enabled = !workflow.enabled;
            renderWorkflows();
            return;
          }
          try {
            await requestJson('POST', \`/api/workflows/\${workflow.id}/\${workflow.enabled ? 'disable' : 'enable'}\`);
            await fetchWorkflows();
            setStatus(\`Workflow \${workflow.enabled ? 'disabled' : 'enabled'}\`);
          } catch (error) {
            setStatus(error.message, 'error');
          }
        });

        element.querySelector('[data-action="sleep"]').addEventListener('click', async () => {
          if (!workflow.sleepUntil) {
            setStatus('Set a future Sleep Until timestamp first', 'error');
            return;
          }
          if (!workflow.id) {
            setStatus('Create the workflow before sleeping it', 'error');
            return;
          }
          try {
            await requestJson('POST', \`/api/workflows/\${workflow.id}/sleep\`, { until: workflow.sleepUntil });
            await fetchWorkflows();
            setStatus('Workflow sleep updated');
          } catch (error) {
            setStatus(error.message, 'error');
          }
        });

        element.querySelector('[data-action="resume"]').addEventListener('click', async () => {
          if (!workflow.id) {
            workflow.sleepUntil = null;
            workflow.lastStatus = 'idle';
            renderWorkflows();
            return;
          }
          try {
            await requestJson('POST', \`/api/workflows/\${workflow.id}/resume\`);
            await fetchWorkflows();
            setStatus('Workflow resumed');
          } catch (error) {
            setStatus(error.message, 'error');
          }
        });

        element.querySelector('[data-action="delete"]').addEventListener('click', async () => {
          try {
            if (workflow.__draft) {
              state.workflows.splice(index, 1);
              renderWorkflows();
              return;
            }
            await requestJson('DELETE', \`/api/workflows/\${workflow.id}\`);
            await fetchWorkflows();
            setStatus('Workflow deleted');
          } catch (error) {
            setStatus(error.message, 'error');
          }
        });

        container.appendChild(element);
      });
    }

    function renderJobCatalog() {
      const container = document.getElementById('jobsCatalogContainer');
      container.innerHTML = '';

      if (!state.config || !state.config.serviceProfiles.gatewayApi.enabled) {
        container.innerHTML = '<p>gateway-api service profile is disabled.</p>';
        return;
      }

      if (state.jobsCatalog.length === 0) {
        container.innerHTML = '<p>No catalog jobs reported by gateway-api.</p>';
        return;
      }

      state.jobsCatalog.forEach((job) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div>
              <strong>\${job.name || job.id}</strong>
              <p>\${job.description || 'No description provided.'}</p>
            </div>
          </div>
          <div class="meta-list">
            <div><strong>Job Id:</strong> \${job.id}</div>
            <div><strong>Target Type:</strong> gateway-jobs.run</div>
            <div><strong>Target Ref:</strong> \${job.id}</div>
          </div>
        \`;
        container.appendChild(element);
      });
    }

    function renderAutomation() {
      ensureAgentRunDefaults();
      const agentOptions = configuredAgents()
        .map((agent) => \`<option value="\${agent.id}" \${agent.id === state.agentRun.agentId ? 'selected' : ''}>\${agent.name || agent.id}</option>\`)
        .join('');
      document.getElementById('workflowSeedPath').value = state.agentRun.workflowSeedPath;
      document.getElementById('agentRunAgentId').innerHTML = agentOptions || '<option value="">No agents configured</option>';
      document.getElementById('agentRunPrompt').value = state.agentRun.prompt;
      document.getElementById('agentRunContext').value = state.agentRun.contextJson;
      document.getElementById('agentRunDelivery').value = state.agentRun.deliveryJson;

      const resultContainer = document.getElementById('agentRunResult');
      if (!state.agentRun.result) {
        resultContainer.innerHTML = '<div>No agent run yet.</div>';
        return;
      }

      const result = state.agentRun.result;
      resultContainer.innerHTML = [
        \`<div><strong>Agent:</strong> \${result.agentId}</div>\`,
        \`<div><strong>Provider:</strong> \${result.usedProvider}</div>\`,
        \`<div><strong>Model:</strong> \${result.model}</div>\`,
        \`<div><strong>Latency:</strong> \${result.latencyMs}ms</div>\`,
        result.usage
          ? \`<div><strong>Tokens:</strong> \${result.usage.promptTokens} prompt / \${result.usage.completionTokens} completion / \${result.usage.totalTokens} total</div>\`
          : '<div><strong>Tokens:</strong> not reported</div>',
        \`<div><strong>Content:</strong><br />\${result.content.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div>\`
      ].join('');
    }

    function renderRuntime() {
      const runtimeSummary = document.getElementById('runtimeSummary');
      const runtimeMeta = document.getElementById('runtimeMeta');
      if (!state.runtime) {
        runtimeSummary.innerHTML = '';
        runtimeMeta.innerHTML = '<div>Runtime data not loaded</div>';
        return;
      }

      const runtime = state.runtime;
      runtimeSummary.innerHTML = [
        ['Enabled Apps', \`\${runtime.enabledApps}/\${runtime.totalApps}\`],
        ['Enabled Jobs', \`\${runtime.enabledJobs}/\${runtime.totalJobs}\`],
        ['Enabled Features', \`\${runtime.enabledFeatures}/\${runtime.totalFeatures}\`],
        ['Uptime (s)', String(runtime.uptimeSeconds)]
      ].map(([label, value]) => \`<div class="metric"><strong>\${value}</strong><span>\${label}</span></div>\`).join('');

      runtimeMeta.innerHTML = [
        \`<div><strong>Started:</strong> \${runtime.startedAt}</div>\`,
        \`<div><strong>Config:</strong> \${runtime.configPath}</div>\`,
        \`<div><strong>Build Dir:</strong> \${runtime.buildOutDir}</div>\`,
        \`<div><strong>Gateway Route:</strong> \${runtime.adminRoutePath}</div>\`,
        \`<div><strong>Build Output Present:</strong> \${runtime.generated.buildDirectoryExists ? 'yes' : 'no'}</div>\`,
        \`<div><strong>nginx Site Generated:</strong> \${runtime.generated.nginxSiteExists ? 'yes' : 'no'}</div>\`,
        \`<div><strong>Control-Plane Unit Generated:</strong> \${runtime.generated.controlPlaneUnitExists ? 'yes' : 'no'}</div>\`
      ].join('');
    }

    function renderApps() {
      const container = document.getElementById('appsContainer');
      container.innerHTML = '';
      state.config.apps.forEach((app, index) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div>
              <strong>\${app.id || 'new-app'}</strong>
            </div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${app.enabled ? 'checked' : ''} /> Enabled</label>
            <label>App Id<input data-field="id" value="\${app.id}" /></label>
            <label>Repo URL<input data-field="repoUrl" value="\${app.repoUrl}" /></label>
            <label>Default Revision<input data-field="defaultRevision" value="\${app.defaultRevision}" /></label>
            <label>Deploy Root<input data-field="deployRoot" value="\${app.deployRoot}" /></label>
            <label>Hostnames (comma separated)<input data-field="hostnames" value="\${(app.hostnames || []).join(', ')}" /></label>
            <label>Route Path<input data-field="routePath" value="\${app.routePath}" /></label>
            <label>Health Path<input data-field="healthPath" value="\${app.healthPath}" /></label>
            <label>Upstream Conf Path<input data-field="upstreamConfPath" value="\${app.upstreamConfPath}" /></label>
            <label>Blue Port<input type="number" data-slot="blue" data-field="port" value="\${app.slots.blue.port}" /></label>
            <label>Blue Start Command<input data-slot="blue" data-field="startCommand" value="\${app.slots.blue.startCommand}" /></label>
            <label>Blue Stop Command<input data-slot="blue" data-field="stopCommand" value="\${app.slots.blue.stopCommand}" /></label>
            <label>Green Port<input type="number" data-slot="green" data-field="port" value="\${app.slots.green.port}" /></label>
            <label>Green Start Command<input data-slot="green" data-field="startCommand" value="\${app.slots.green.startCommand}" /></label>
            <label>Green Stop Command<input data-slot="green" data-field="stopCommand" value="\${app.slots.green.stopCommand}" /></label>
          </div>
          <label>Build Commands (one per line)<textarea data-field="buildCommands">\${app.buildCommands.join('\\n')}</textarea></label>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          state.config.apps.splice(index, 1);
          render();
        });

        element.querySelectorAll('input, textarea').forEach((input) => {
          input.addEventListener('input', () => {
            const slot = input.dataset.slot;
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            if (slot) {
              state.config.apps[index].slots[slot][field] = field === 'port' ? Number(input.value) : input.value;
            } else if (field === 'enabled') {
              state.config.apps[index].enabled = input.checked;
            } else if (field === 'hostnames') {
              state.config.apps[index].hostnames = input.value.split(',').map((item) => item.trim()).filter(Boolean);
            } else if (field === 'buildCommands') {
              state.config.apps[index].buildCommands = input.value.split('\\n').map((item) => item.trim()).filter(Boolean);
            } else {
              state.config.apps[index][field] = input.value;
            }
            syncRawJson();
          });
          if (input.type === 'checkbox') {
            input.addEventListener('change', () => {
              state.config.apps[index].enabled = input.checked;
              syncRawJson();
            });
          }
        });

        container.appendChild(element);
      });
    }

    function renderJobs() {
      const container = document.getElementById('jobsContainer');
      container.innerHTML = '';
      state.config.scheduledJobs.forEach((job, index) => {
        const appOptions = state.config.apps.map((app) => \`<option value="\${app.id}" \${app.id === job.appId ? 'selected' : ''}>\${app.id}</option>\`).join('');
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${job.id || 'new-job'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${job.enabled ? 'checked' : ''} /> Enabled</label>
            <label>Job Id<input data-field="id" value="\${job.id}" /></label>
            <label>App<select data-field="appId">\${appOptions}</select></label>
            <label>Schedule<input data-field="schedule" value="\${job.schedule}" /></label>
            <label>User<input data-field="user" value="\${job.user}" /></label>
            <label>Group<input data-field="group" value="\${job.group || ''}" /></label>
            <label>Environment File<input data-field="environmentFile" value="\${job.environmentFile || ''}" /></label>
          </div>
          <label>Description<input data-field="description" value="\${job.description}" /></label>
          <label>Working Directory<input data-field="workingDirectory" value="\${job.workingDirectory}" /></label>
          <label>ExecStart<input data-field="execStart" value="\${job.execStart}" /></label>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          state.config.scheduledJobs.splice(index, 1);
          render();
        });

        element.querySelectorAll('input, select').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          const eventName = isCheckbox ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            state.config.scheduledJobs[index][field] = isCheckbox ? input.checked : input.value;
            if (field === 'group' || field === 'environmentFile') {
              if (!input.value) {
                delete state.config.scheduledJobs[index][field];
              }
            }
            syncRawJson();
          });
        });

        container.appendChild(element);
      });
    }

    function renderPiProxyProfile() {
      const profile = state.config.serviceProfiles.piProxy;
      document.getElementById('piProxyNodeId').innerHTML = workerNodeOptions(profile.nodeId);
      document.getElementById('piProxyEnabled').checked = profile.enabled;
      document.getElementById('piProxyDescription').value = profile.description;
      document.getElementById('piProxyInstallRoot').value = profile.installRoot;
      document.getElementById('piProxySystemdUnitName').value = profile.systemdUnitName;
      document.getElementById('piProxyRegistryBaseUrl').value = profile.registryBaseUrl;
      document.getElementById('piProxyListenHost').value = profile.listenHost;
      document.getElementById('piProxyListenPort').value = String(profile.listenPort);
      document.getElementById('piProxyServiceUser').value = profile.serviceUser || '';
      document.getElementById('piProxyServiceGroup').value = profile.serviceGroup || '';
      document.getElementById('piProxyRegistryPath').value = profile.registryPath;
      document.getElementById('piProxyPollIntervalSeconds').value = String(profile.pollIntervalSeconds);
      const normalizedBaseUrl = profile.registryBaseUrl.endsWith('/') ? profile.registryBaseUrl.slice(0, -1) : profile.registryBaseUrl;
      document.getElementById('piProxyRegistryUrlPreview').value = normalizedBaseUrl + (profile.registryPath.startsWith('/') ? profile.registryPath : '/' + profile.registryPath);

      const serviceMeta = document.getElementById('piProxyServiceMeta');
      const meta = document.getElementById('piProxyRegistryMeta');
      const container = document.getElementById('piProxyRegistryContainer');
      const actionOutput = document.getElementById('piProxyActionOutput');

      if (!state.piProxyStatus) {
        serviceMeta.innerHTML = '<div><strong>Service:</strong> status not checked yet</div>';
      } else if (state.piProxyStatus.error) {
        serviceMeta.innerHTML = [
          '<div><strong>Service:</strong> error</div>',
          '<div><strong>Detail:</strong> ' + escapeHtml(state.piProxyStatus.error) + '</div>'
        ].join('');
      } else {
        const runtimeServers = Array.isArray(state.piProxyStatus.runtimeState?.servers)
          ? state.piProxyStatus.runtimeState.servers.length
          : 0;
        serviceMeta.innerHTML = [
          '<div><strong>Node:</strong> ' + escapeHtml(state.piProxyStatus.nodeId || profile.nodeId || 'unset') + '</div>',
          '<div><strong>Service State:</strong> ' + escapeHtml(state.piProxyStatus.activeState + '/' + state.piProxyStatus.subState) + '</div>',
          '<div><strong>Installed:</strong> ' + escapeHtml(state.piProxyStatus.serviceInstalled ? 'yes' : 'no') + '</div>',
          '<div><strong>Advertised Locally:</strong> ' + escapeHtml(String(runtimeServers)) + '</div>',
          '<div><strong>Summary:</strong> ' + escapeHtml(state.piProxyStatus.summary || 'unknown') + '</div>'
        ].join('');
      }

      if (!profile.enabled) {
        meta.innerHTML = '<div><strong>Status:</strong> disabled</div>';
        serviceMeta.innerHTML = '<div><strong>Service:</strong> disabled</div>';
        container.innerHTML = '<div class="card card-quiet">Enable the Pi proxy profile to expose the Bedrock registry endpoint.</div>';
        return;
      }

      if (!state.piProxyRegistry) {
        meta.innerHTML = '<div><strong>Status:</strong> registry not loaded yet</div>';
        container.innerHTML = '<div class="card card-quiet">Use <strong>Refresh Registry</strong> to inspect the live Bedrock registry.</div>';
        return;
      }

      if (state.piProxyRegistry.error) {
        meta.innerHTML = '<div><strong>Status:</strong> error</div>';
        container.innerHTML = '<div class="card card-quiet">' + escapeHtml(state.piProxyRegistry.error) + '</div>';
        return;
      }

      const generatedAt = formatTimestamp(state.piProxyRegistry.generatedAt);
      const servers = Array.isArray(state.piProxyRegistry.servers) ? state.piProxyRegistry.servers : [];
      meta.innerHTML = [
        '<div><strong>Generated:</strong> ' + escapeHtml(generatedAt) + '</div>',
        '<div><strong>Available Worlds:</strong> ' + escapeHtml(String(servers.length)) + '</div>',
        '<div><strong>Proxy Unit:</strong> ' + escapeHtml(profile.systemdUnitName) + '</div>'
      ].join('');

      if (servers.length === 0) {
        container.innerHTML = '<div class="card card-quiet">No running Bedrock worlds are currently available for LAN advertisement.</div>';
        return;
      }

      container.innerHTML = '';
      servers.forEach((server) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = [
          '<div class="split-actions">',
          '<div><strong>' + escapeHtml(server.serverName || server.workloadId) + '</strong></div>',
          '<div class="pill">' + escapeHtml(server.worldName || 'world') + '</div>',
          '</div>',
          '<div class="meta-list">',
          '<div><strong>MOTD:</strong> ' + escapeHtml(server.motd || server.serverName || '') + '</div>',
          '<div><strong>Level Name:</strong> ' + escapeHtml(server.levelName || server.worldName || '') + '</div>',
          '<div><strong>Relay Target:</strong> ' + escapeHtml(server.targetHost + ':' + String(server.targetPort || 'unknown')) + '</div>',
          '<div><strong>Node:</strong> ' + escapeHtml(server.nodeId) + '</div>',
          '<div><strong>Network Mode:</strong> ' + escapeHtml(server.networkMode || 'unknown') + '</div>',
          '<div><strong>Started:</strong> ' + escapeHtml(formatTimestamp(server.startedAt)) + '</div>',
          '</div>'
        ].join('');
        container.appendChild(element);
      });
    }

    function renderSecrets() {
      renderSecretEnvironmentList(
        'gatewayApiSecretsContainer',
        state.config.serviceProfiles.gatewayApi.environment,
        () => undefined,
        renderGatewayApiProfile
      );
      renderGatewayApiSecretsChannels();
      renderKulrsSecrets();
      renderSecretEnvironmentList(
        'gatewayChatSecretsContainer',
        state.config.serviceProfiles.gatewayChatPlatform.environment,
        () => undefined,
        renderGatewayChatPlatformProfile
      );
    }

    function renderGatewayApiSecretsChannels() {
      const runtime = state.config.serviceProfiles.gatewayApi.jobRuntime;
      const container = document.getElementById('gatewayApiSecretChannelsContainer');
      container.innerHTML = '';

      if (runtime.channels.length === 0) {
        container.innerHTML = '<div>No delivery channels configured yet.</div>';
        return;
      }

      runtime.channels.forEach((channel, index) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${channel.id || 'new-channel'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${channel.enabled ? 'checked' : ''} /> Enabled</label>
            <label>Channel Id<input data-field="id" value="\${channel.id}" /></label>
            <label>Type
              <select data-field="type">
                <option value="telegram" \${channel.type === 'telegram' ? 'selected' : ''}>telegram</option>
                <option value="webhook" \${channel.type === 'webhook' ? 'selected' : ''}>webhook</option>
              </select>
            </label>
          </div>
          <div class="row">
            <label>Telegram Bot Token<input type="password" data-field="botToken" value="\${channel.botToken || ''}" /></label>
            <label>Telegram Chat Id<input data-field="chatId" value="\${channel.chatId || ''}" /></label>
            <label>Webhook URL<input type="password" data-field="webhookUrl" value="\${channel.webhookUrl || ''}" /></label>
          </div>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          runtime.channels.splice(index, 1);
          renderGatewayApiJobRuntimeProfile();
          renderSecrets();
          syncRawJson();
        });

        element.querySelectorAll('input, select').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          const eventName = isCheckbox || input.tagName === 'SELECT' ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            if (field === 'enabled') {
              channel.enabled = input.checked;
            } else {
              channel[field] = input.value;
              if ((field === 'botToken' || field === 'chatId' || field === 'webhookUrl') && !input.value) {
                delete channel[field];
              }
            }
            if (isCheckbox || input.tagName === 'SELECT') {
              renderGatewayApiJobRuntimeProfile();
              renderSecrets();
            }
            syncRawJson();
          });
        });

        container.appendChild(element);
      });
    }

    function renderKulrsSecrets() {
      const kulrs = state.config.serviceProfiles.gatewayApi.kulrsActivity;
      document.getElementById('kulrsFirebaseApiKeySecrets').value = kulrs.firebaseApiKey;
      document.getElementById('kulrsUnsplashAccessKeySecrets').value = kulrs.unsplashAccessKey;

      const container = document.getElementById('kulrsSecretBotsContainer');
      container.innerHTML = '';
      if (kulrs.bots.length === 0) {
        container.innerHTML = '<div>No KULRS bot credentials configured yet.</div>';
        return;
      }

      kulrs.bots.forEach((bot, index) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${bot.id || 'new-kulrs-bot'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label>Bot Id<input data-field="id" value="\${bot.id}" /></label>
            <label>Email<input data-field="email" value="\${bot.email}" /></label>
            <label>Password<input type="password" data-field="password" value="\${bot.password}" /></label>
          </div>
          <label>Description<input data-field="description" value="\${bot.description || ''}" /></label>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          kulrs.bots.splice(index, 1);
          renderKulrsActivityProfile();
          renderSecrets();
          syncRawJson();
        });

        element.querySelectorAll('input').forEach((input) => {
          input.addEventListener('input', () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            bot[field] = input.value;
            if (field === 'description' && !input.value) {
              delete bot.description;
            }
            syncRawJson();
          });
        });

        container.appendChild(element);
      });
    }

    function renderFeatures() {
      const container = document.getElementById('featuresContainer');
      container.innerHTML = '';
      state.config.features.forEach((feature, index) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${feature.id || 'new-feature'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${feature.enabled ? 'checked' : ''} /> Enabled</label>
            <label>Feature Id<input data-field="id" value="\${feature.id}" /></label>
          </div>
          <label>Description<input data-field="description" value="\${feature.description}" /></label>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          state.config.features.splice(index, 1);
          render();
        });

        element.querySelectorAll('input').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          input.addEventListener(isCheckbox ? 'change' : 'input', () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            state.config.features[index][field] = isCheckbox ? input.checked : input.value;
            syncRawJson();
          });
        });

        container.appendChild(element);
      });
    }

    function workerNodeOptions(selectedNodeId) {
      if (state.config.workerNodes.length === 0) {
        return '<option value="">No worker nodes configured</option>';
      }
      return state.config.workerNodes
        .map((node) => \`<option value="\${node.id}" \${node.id === selectedNodeId ? 'selected' : ''}>\${node.id || '(unset node id)'}</option>\`)
        .join('');
    }

    function firstWorkerNodeId() {
      const namedNode = state.config.workerNodes.find((node) => typeof node.id === 'string' && node.id.trim().length > 0);
      return namedNode ? namedNode.id : '';
    }

    function nextWorkerNodeId() {
      if (!state.config.workerNodes.some((node) => node.id === 'core-node')) {
        return 'core-node';
      }
      let index = 1;
      while (state.config.workerNodes.some((node) => node.id === \`worker-node-\${index}\`)) {
        index += 1;
      }
      return \`worker-node-\${index}\`;
    }

    function nextAvailableSpecificNodeId(baseId) {
      const normalized = slugifyIdentifier(baseId) || nextWorkerNodeId();
      if (!state.config.workerNodes.some((node) => node.id === normalized)) {
        return normalized;
      }
      let index = 2;
      while (state.config.workerNodes.some((node) => node.id === \`\${normalized}-\${index}\`)) {
        index += 1;
      }
      return \`\${normalized}-\${index}\`;
    }

    function ensureRemoteWorkloadNodeId(workload) {
      if (typeof workload.nodeId === 'string' && workload.nodeId.trim().length > 0) {
        return workload.nodeId;
      }
      const fallbackNodeId = firstWorkerNodeId();
      if (!fallbackNodeId) {
        throw new Error('Add a worker node in Nodes first. Give it a Node Id and host, then come back to Minecraft.');
      }
      workload.nodeId = fallbackNodeId;
      return fallbackNodeId;
    }

    function normalizeRemoteWorkloadNodeIds() {
      state.config.remoteWorkloads.forEach((workload) => {
        if (!workload.nodeId) {
          const fallbackNodeId = firstWorkerNodeId();
          if (fallbackNodeId) {
            workload.nodeId = fallbackNodeId;
          }
        }
      });
    }

    function createDefaultMinecraftPack() {
      return {
        id: '',
        sourcePath: '',
        manifestUuid: '',
        manifestVersion: [1, 0, 0]
      };
    }

    function createDefaultMinecraftConfig() {
      return {
        image: 'itzg/minecraft-bedrock-server:latest',
        networkMode: 'host',
        serverName: '',
        worldName: '',
        gameMode: 'survival',
        difficulty: 'normal',
        worldCopyMode: 'if-missing',
        allowCheats: false,
        onlineMode: true,
        maxPlayers: 10,
        serverPort: 19132,
        autoStart: true,
        autoUpdateEnabled: true,
        autoUpdateSchedule: '*-*-* 04:00:00',
        texturepackRequired: false,
        behaviorPacks: [],
        resourcePacks: []
      };
    }

    function createDefaultBedrockWorkload() {
      return {
        id: '',
        enabled: true,
        nodeId: firstWorkerNodeId(),
        description: '',
        kind: 'minecraft-bedrock-server',
        minecraft: createDefaultMinecraftConfig()
      };
    }

    function createDefaultRemoteJobWorkload() {
      return {
        id: '',
        enabled: true,
        nodeId: firstWorkerNodeId(),
        description: '',
        kind: 'scheduled-container-job',
        job: {
          schedule: '*-*-* 03:00:00',
          timezone: 'America/New_York',
          build: {
            strategy: 'generated-node',
            repoUrl: '',
            defaultRevision: 'main',
            contextPath: '.',
            packageRoot: '.',
            nodeVersion: '24',
            installCommand: 'npm ci --omit=dev'
          },
          runCommand: '',
          environment: [],
          volumeMounts: [],
          jsonFiles: []
        }
      };
    }

    function createDefaultContainerServiceWorkload() {
      return {
        id: '',
        enabled: true,
        nodeId: firstWorkerNodeId(),
        description: '',
        kind: 'container-service',
        service: {
          image: '',
          networkMode: 'bridge',
          restartPolicy: 'unless-stopped',
          autoStart: true,
          runtimeClass: 'default',
          command: '',
          environment: [],
          volumeMounts: [],
          jsonFiles: [],
          ports: [],
          healthCheck: {
            protocol: 'http',
            port: 8000,
            path: '/health',
            expectedStatus: 200
          }
        }
      };
    }

    function createWorkerNodePreset(kind) {
      if (kind === 'gpu') {
        return {
          id: nextAvailableSpecificNodeId('gpu-node'),
          enabled: true,
          description: 'GPU compute worker',
          host: '',
          sshUser: 'deploy',
          sshPort: 22,
          buildRoot: '/data/docker/builds',
          stackRoot: '/data/docker/stacks',
          volumeRoot: '/data/docker/volumes',
          workerPollIntervalSeconds: 15,
          nodeCommand: '/usr/bin/node',
          systemdUnitDirectory: '/etc/systemd/system',
          systemdReloadCommand: 'sudo systemctl daemon-reload',
          systemdEnableTimerCommand: 'sudo systemctl enable --now',
          dockerCommand: 'docker',
          dockerComposeCommand: 'docker compose'
        };
      }

      if (kind === 'pi') {
        return {
          id: nextAvailableSpecificNodeId('pi-node'),
          enabled: true,
          description: 'Raspberry Pi edge worker',
          host: '',
          sshUser: 'deploy',
          sshPort: 22,
          buildRoot: '/opt/builds',
          stackRoot: '/opt/stacks',
          volumeRoot: '/opt/volumes',
          workerPollIntervalSeconds: 30,
          nodeCommand: '/usr/bin/node',
          systemdUnitDirectory: '/etc/systemd/system',
          systemdReloadCommand: 'sudo systemctl daemon-reload',
          systemdEnableTimerCommand: 'sudo systemctl enable --now',
          dockerCommand: 'docker',
          dockerComposeCommand: 'docker compose'
        };
      }

      return {
        id: nextWorkerNodeId(),
        enabled: true,
        description: 'Remote worker node',
        host: '',
        sshUser: 'deploy',
        sshPort: 22,
        buildRoot: '/srv/builds',
        stackRoot: '/srv/stacks',
        volumeRoot: '/srv/volumes',
        workerPollIntervalSeconds: 15,
        nodeCommand: '/usr/bin/node',
        systemdUnitDirectory: '/etc/systemd/system',
        systemdReloadCommand: 'sudo systemctl daemon-reload',
        systemdEnableTimerCommand: 'sudo systemctl enable --now',
        dockerCommand: 'docker',
        dockerComposeCommand: 'docker compose'
      };
    }

    function appendWorkerNode(node) {
      state.config.workerNodes.push(node);
      normalizeRemoteWorkloadNodeIds();
      renderWorkerNodes();
      renderRemoteWorkloads();
      renderBedrockServers();
      renderPiProxyProfile();
      syncRawJson();
    }

    function createSttTranscriptWorkload() {
      return {
        id: 'stt-transcript',
        enabled: true,
        nodeId: firstWorkerNodeId(),
        description: 'GPU-backed transcript API using Insanely Fast Whisper',
        kind: 'container-service',
        service: {
          image: 'yoeven/insanely-fast-whisper-api:latest',
          networkMode: 'bridge',
          restartPolicy: 'unless-stopped',
          autoStart: true,
          runtimeClass: 'nvidia',
          environment: [
            {
              key: 'ADMIN_KEY',
              value: '',
              secret: true,
              description: 'Optional admin token for the API'
            }
          ],
          volumeMounts: [],
          jsonFiles: [],
          ports: [
            { published: 9001, target: 9000, protocol: 'tcp' }
          ],
          healthCheck: {
            protocol: 'tcp',
            port: 9001
          }
        }
      };
    }

    function createSttDiarizationWorkload() {
      return {
        id: 'stt-diarization',
        enabled: true,
        nodeId: firstWorkerNodeId(),
        description: 'GPU-backed transcript + speaker diarization API using Insanely Fast Whisper',
        kind: 'container-service',
        service: {
          image: 'yoeven/insanely-fast-whisper-api:latest',
          networkMode: 'bridge',
          restartPolicy: 'unless-stopped',
          autoStart: true,
          runtimeClass: 'nvidia',
          environment: [
            {
              key: 'HF_TOKEN',
              value: '',
              secret: true,
              description: 'Required for pyannote diarization models'
            },
            {
              key: 'ADMIN_KEY',
              value: '',
              secret: true,
              description: 'Optional admin token for the API'
            }
          ],
          volumeMounts: [],
          jsonFiles: [],
          ports: [
            { published: 9002, target: 9000, protocol: 'tcp' }
          ],
          healthCheck: {
            protocol: 'tcp',
            port: 9002
          }
        }
      };
    }

    function parsePackVersion(value) {
      const trimmed = value.trim();
      if (!trimmed) {
        return [1, 0, 0];
      }
      return trimmed.split('.').map((part) => Number(part.trim())).filter((part) => Number.isInteger(part) && part >= 0);
    }

    function slugifyIdentifier(value) {
      return String(value || '')
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, '-')
        .replaceAll(/^-+|-+$/g, '');
    }

    function deriveBedrockWorkloadId(minecraft) {
      const base = slugifyIdentifier(minecraft.worldName || minecraft.serverName || 'server');
      return \`bedrock-\${base || 'server'}\`;
    }

    function deriveBedrockDescription(minecraft) {
      const label = minecraft.serverName || minecraft.worldName || 'server';
      return \`Minecraft Bedrock server: \${label}\`;
    }

    function applyBedrockIdentityDefaults(workload, previousMinecraft, nextMinecraft) {
      const previousId = deriveBedrockWorkloadId(previousMinecraft || {});
      const nextId = deriveBedrockWorkloadId(nextMinecraft || {});
      if (!workload.id || workload.id === previousId) {
        workload.id = nextId;
      }

      const previousDescription = deriveBedrockDescription(previousMinecraft || {});
      const nextDescription = deriveBedrockDescription(nextMinecraft || {});
      if (!workload.description || workload.description === previousDescription) {
        workload.description = nextDescription;
      }
    }

    function renderWorkerNodes() {
      const container = document.getElementById('workerNodesContainer');
      container.innerHTML = '';
      if (state.config.workerNodes.length === 0) {
        container.innerHTML = '<p>No worker nodes configured yet.</p>';
        return;
      }

      state.config.workerNodes.forEach((node, index) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${node.id || 'new-worker-node'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${node.enabled ? 'checked' : ''} /> Enabled</label>
            <label>Node Id<input data-field="id" value="\${node.id}" /></label>
            <label>Description<input data-field="description" value="\${node.description || ''}" /></label>
            <label>Host<input data-field="host" value="\${node.host}" /></label>
            <label>SSH User<input data-field="sshUser" value="\${node.sshUser}" /></label>
            <label>SSH Port<input type="number" data-field="sshPort" value="\${node.sshPort}" /></label>
          </div>
          <div class="row">
            <label>Build Root<input data-field="buildRoot" value="\${node.buildRoot}" /></label>
            <label>Stack Root<input data-field="stackRoot" value="\${node.stackRoot}" /></label>
            <label>Volume Root<input data-field="volumeRoot" value="\${node.volumeRoot}" /></label>
            <label>Worker Poll Seconds<input type="number" data-field="workerPollIntervalSeconds" value="\${node.workerPollIntervalSeconds || 15}" /></label>
          </div>
          <div class="row">
            <label>Node Command<input data-field="nodeCommand" value="\${node.nodeCommand || 'node'}" /></label>
            <label>systemd Unit Directory<input data-field="systemdUnitDirectory" value="\${node.systemdUnitDirectory || ''}" placeholder="/etc/systemd/system" /></label>
            <label>systemd Reload Command<input data-field="systemdReloadCommand" value="\${node.systemdReloadCommand || ''}" placeholder="sudo systemctl daemon-reload" /></label>
            <label>systemd Enable Timer Command<input data-field="systemdEnableTimerCommand" value="\${node.systemdEnableTimerCommand || ''}" placeholder="sudo systemctl enable --now" /></label>
          </div>
          <div class="row">
            <label>Docker Command<input data-field="dockerCommand" value="\${node.dockerCommand}" /></label>
            <label>Docker Compose Command<input data-field="dockerComposeCommand" value="\${node.dockerComposeCommand}" /></label>
          </div>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          state.config.workerNodes.splice(index, 1);
          renderWorkerNodes();
          renderRemoteWorkloads();
          renderBedrockServers();
          renderPiProxyProfile();
          syncRawJson();
        });

        element.querySelectorAll('input').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          input.addEventListener(isCheckbox ? 'change' : 'input', () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            node[field] = isCheckbox ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
            if (
              (field === 'systemdUnitDirectory' || field === 'systemdReloadCommand' || field === 'systemdEnableTimerCommand') &&
              !input.value.trim()
            ) {
              delete node[field];
            }
            if (isCheckbox) {
              renderRemoteWorkloads();
              renderBedrockServers();
            }
            renderPiProxyProfile();
            syncRawJson();
          });
        });

        container.appendChild(element);
      });
    }

    function renderRemoteWorkloads() {
      renderRemoteServicesOverview();
      const container = document.getElementById('remoteWorkloadsContainer');
      container.innerHTML = '';
      if (state.config.remoteWorkloads.length === 0) {
        container.innerHTML = '<p>No remote workloads configured yet.</p>';
        return;
      }

      state.config.remoteWorkloads.forEach((workload, index) => {
        const isJob = workload.kind === 'scheduled-container-job';
        const isService = workload.kind === 'container-service';
        const isMinecraft = workload.kind === 'minecraft-bedrock-server';
        const job = workload.job || {
          schedule: '*-*-* 03:00:00',
          timezone: 'America/New_York',
          build: {
            strategy: 'generated-node',
            repoUrl: '',
            defaultRevision: 'main',
            contextPath: '.',
            packageRoot: '.',
            nodeVersion: '24',
            installCommand: 'npm ci --omit=dev'
          },
          runCommand: '',
          environment: [],
          volumeMounts: [],
          jsonFiles: []
        };
        const service = workload.service || createDefaultContainerServiceWorkload().service;
        const minecraft = workload.minecraft || {
          image: 'itzg/minecraft-bedrock-server:latest',
          serverName: '',
          worldName: '',
          gameMode: 'survival',
          difficulty: 'normal',
          worldCopyMode: 'if-missing',
          allowCheats: false,
          onlineMode: true,
          maxPlayers: 10,
          serverPort: 19132,
          autoStart: true,
          autoUpdateEnabled: true,
          autoUpdateSchedule: '*-*-* 04:00:00',
          texturepackRequired: false,
          behaviorPacks: [],
          resourcePacks: []
        };
        const serviceStatus = workload.id ? state.remoteServiceStatuses[workload.id] : null;
        const serviceSummary = describeContainerStatus(serviceStatus?.service);
        const serviceHealthSummary = describeServiceHealthCheck(serviceStatus?.healthCheck);
        const servicePortSummary = serviceStatus
          ? formatPortMappings(serviceStatus.service?.ports, serviceStatus.service?.networkMode)
          : 'not checked yet';
        const serviceConfiguredImage = serviceStatus?.service?.configuredImage || service.image || 'build-only workload';
        const serviceImageId = serviceStatus?.service?.imageId || 'not checked yet';
        const serviceCreatedLine = serviceStatus?.service?.createdAt
          ? '<p><strong>Created:</strong> ' + formatTimestamp(serviceStatus.service.createdAt) + '</p>'
          : '';
        const serviceStartedLine = serviceStatus?.service?.startedAt
          ? '<p><strong>Started:</strong> ' + formatTimestamp(serviceStatus.service.startedAt) + '</p>'
          : '';
        const serviceErrorLine = serviceStatus?.service?.error
          ? '<p><strong>Service Error:</strong> ' + escapeHtml(serviceStatus.service.error) + '</p>'
          : '';
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div>
              <strong>\${workload.id || 'new-remote-workload'}</strong>
              <p>\${workload.description || 'Remote containerized workload'}</p>
            </div>
            <div class="toolbar">
              <button data-action="deploy">Deploy</button>
              <button data-action="remove" class="danger">Remove</button>
            </div>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${workload.enabled ? 'checked' : ''} /> Enabled</label>
            <label>Workload Id<input data-field="id" value="\${workload.id}" /></label>
            <label>Description<input data-field="description" value="\${workload.description || ''}" /></label>
            <label>Node<select data-field="nodeId">\${workerNodeOptions(workload.nodeId)}</select></label>
            <label>Kind
              <select data-field="kind">
                <option value="scheduled-container-job" \${isJob ? 'selected' : ''}>scheduled-container-job</option>
                <option value="container-service" \${isService ? 'selected' : ''}>container-service</option>
                <option value="minecraft-bedrock-server" \${isMinecraft ? 'selected' : ''}>minecraft-bedrock-server</option>
              </select>
            </label>
            <label>Deploy Revision<input data-control="deployRevision" placeholder="optional sha/tag" /></label>
          </div>
          \${isJob ? \`
            <div class="card">
              <span class="pill">Container Job</span>
              <div class="row">
                <label>Schedule<input data-job-field="schedule" value="\${job.schedule}" /></label>
                <label>Timezone<input data-job-field="timezone" value="\${job.timezone}" /></label>
                <label>Build Strategy
                  <select data-job-build-field="strategy">
                    <option value="generated-node" \${job.build.strategy === 'generated-node' ? 'selected' : ''}>generated-node</option>
                    <option value="repo-dockerfile" \${job.build.strategy === 'repo-dockerfile' ? 'selected' : ''}>repo-dockerfile</option>
                  </select>
                </label>
                <label>Repo URL<input data-job-build-field="repoUrl" value="\${job.build.repoUrl}" /></label>
                <label>Default Revision<input data-job-build-field="defaultRevision" value="\${job.build.defaultRevision}" /></label>
                <label>Context Path<input data-job-build-field="contextPath" value="\${job.build.contextPath}" /></label>
              </div>
              <div class="row">
                <label>Dockerfile Path<input data-job-build-field="dockerfilePath" value="\${job.build.dockerfilePath || ''}" /></label>
                <label>Package Root<input data-job-build-field="packageRoot" value="\${job.build.packageRoot || ''}" /></label>
                <label>Node Version<input data-job-build-field="nodeVersion" value="\${job.build.nodeVersion || ''}" /></label>
                <label>Install Command<input data-job-build-field="installCommand" value="\${job.build.installCommand || ''}" /></label>
              </div>
              <label>Run Command<input data-job-field="runCommand" value="\${job.runCommand}" /></label>
              <label>Environment JSON<textarea data-job-json="environment">\${JSON.stringify(job.environment || [], null, 2)}</textarea></label>
              <label>Volume Mounts JSON<textarea data-job-json="volumeMounts">\${JSON.stringify(job.volumeMounts || [], null, 2)}</textarea></label>
              <label>Runtime JSON Files<textarea data-job-json="jsonFiles">\${JSON.stringify(job.jsonFiles || [], null, 2)}</textarea></label>
            </div>
          \` : isService ? \`
            <div class="card">
              <div class="split-actions">
                <div>
                  <span class="pill">Container Service</span>
                  <p><strong>Status:</strong> \${serviceSummary}</p>
                  <p><strong>Network Mode:</strong> \${serviceStatus?.service?.networkMode || service.networkMode}</p>
                  <p><strong>Ports:</strong> \${servicePortSummary}</p>
                  <p><strong>Image:</strong> \${formatInlineValue(serviceConfiguredImage)}</p>
                  <p><strong>Image ID:</strong> \${formatInlineValue(serviceImageId)}</p>
                  <p><strong>Health:</strong> \${escapeHtml(serviceHealthSummary)}</p>
                  \${serviceCreatedLine}
                  \${serviceStartedLine}
                  \${serviceErrorLine}
                </div>
                <div class="toolbar">
                  <button data-action="service-refresh-status">Refresh Status</button>
                  <button data-action="service-start">Start</button>
                  <button data-action="service-stop">Stop</button>
                  <button data-action="service-restart">Restart</button>
                </div>
              </div>
              <div class="row">
                <label>Image<input data-service-field="image" value="\${service.image || ''}" placeholder="ghcr.io/example/service:latest" /></label>
                <label>Network Mode
                  <select data-service-field="networkMode">
                    <option value="bridge" \${service.networkMode === 'bridge' ? 'selected' : ''}>bridge</option>
                    <option value="host" \${service.networkMode === 'host' ? 'selected' : ''}>host</option>
                  </select>
                </label>
                <label>Restart Policy
                  <select data-service-field="restartPolicy">
                    <option value="unless-stopped" \${service.restartPolicy === 'unless-stopped' ? 'selected' : ''}>unless-stopped</option>
                    <option value="always" \${service.restartPolicy === 'always' ? 'selected' : ''}>always</option>
                    <option value="no" \${service.restartPolicy === 'no' ? 'selected' : ''}>no</option>
                  </select>
                </label>
                <label>Runtime Class
                  <select data-service-field="runtimeClass">
                    <option value="default" \${service.runtimeClass === 'default' ? 'selected' : ''}>default</option>
                    <option value="nvidia" \${service.runtimeClass === 'nvidia' ? 'selected' : ''}>nvidia</option>
                  </select>
                </label>
              </div>
              <div class="row">
                <label class="check"><input type="checkbox" data-service-field="autoStart" \${service.autoStart ? 'checked' : ''} /> Auto Start On Deploy</label>
                <label>Command<input data-service-field="command" value="\${service.command || ''}" placeholder="python app.py --host 0.0.0.0 --port 8000" /></label>
              </div>
              <label>Build JSON<textarea data-service-json="build">\${service.build ? JSON.stringify(service.build, null, 2) : ''}</textarea></label>
              <label>Environment JSON<textarea data-service-json="environment">\${JSON.stringify(service.environment || [], null, 2)}</textarea></label>
              <label>Volume Mounts JSON<textarea data-service-json="volumeMounts">\${JSON.stringify(service.volumeMounts || [], null, 2)}</textarea></label>
              <label>Runtime JSON Files<textarea data-service-json="jsonFiles">\${JSON.stringify(service.jsonFiles || [], null, 2)}</textarea></label>
              <label>Ports JSON<textarea data-service-json="ports">\${JSON.stringify(service.ports || [], null, 2)}</textarea></label>
              <label>Health Check JSON<textarea data-service-json="healthCheck">\${service.healthCheck ? JSON.stringify(service.healthCheck, null, 2) : ''}</textarea></label>
            </div>
          \` : \`
            <div class="card">
              <span class="pill">Bedrock</span>
              <p>Use the Bedrock tab for the streamlined server controls and pack management workflow.</p>
              <div class="row">
                <label>Image<input data-mc-field="image" value="\${minecraft.image}" /></label>
                <label>Server Name<input data-mc-field="serverName" value="\${minecraft.serverName}" /></label>
                <label>World Name<input data-mc-field="worldName" value="\${minecraft.worldName}" /></label>
                <label>Game Mode
                  <select data-mc-field="gameMode">
                    <option value="survival" \${minecraft.gameMode === 'survival' ? 'selected' : ''}>survival</option>
                    <option value="creative" \${minecraft.gameMode === 'creative' ? 'selected' : ''}>creative</option>
                    <option value="adventure" \${minecraft.gameMode === 'adventure' ? 'selected' : ''}>adventure</option>
                  </select>
                </label>
                <label>Difficulty
                  <select data-mc-field="difficulty">
                    <option value="peaceful" \${minecraft.difficulty === 'peaceful' ? 'selected' : ''}>peaceful</option>
                    <option value="easy" \${minecraft.difficulty === 'easy' ? 'selected' : ''}>easy</option>
                    <option value="normal" \${minecraft.difficulty === 'normal' ? 'selected' : ''}>normal</option>
                    <option value="hard" \${minecraft.difficulty === 'hard' ? 'selected' : ''}>hard</option>
                  </select>
                </label>
                <label>Seed<input data-mc-field="levelSeed" value="\${minecraft.levelSeed || ''}" /></label>
                <label>World Source Path<input data-mc-field="worldSourcePath" value="\${minecraft.worldSourcePath || ''}" placeholder="/mnt/storage/docker/shared/worlds/existing-world or .mcworld" /></label>
              </div>
              <div class="row">
                <label>World Copy Mode
                  <select data-mc-field="worldCopyMode">
                    <option value="if-missing" \${minecraft.worldCopyMode === 'if-missing' ? 'selected' : ''}>if-missing</option>
                    <option value="always" \${minecraft.worldCopyMode === 'always' ? 'selected' : ''}>always</option>
                  </select>
                </label>
                <label>Max Players<input type="number" data-mc-field="maxPlayers" value="\${minecraft.maxPlayers}" /></label>
                <label>Server Port<input type="number" data-mc-field="serverPort" value="\${minecraft.serverPort}" /></label>
                <label>Auto Update Schedule<input data-mc-field="autoUpdateSchedule" value="\${minecraft.autoUpdateSchedule}" /></label>
              </div>
              <div class="row">
                <label class="check"><input type="checkbox" data-mc-field="allowCheats" \${minecraft.allowCheats ? 'checked' : ''} /> Allow Cheats</label>
                <label class="check"><input type="checkbox" data-mc-field="onlineMode" \${minecraft.onlineMode ? 'checked' : ''} /> Online Mode</label>
                <label class="check"><input type="checkbox" data-mc-field="autoStart" \${minecraft.autoStart ? 'checked' : ''} /> Auto Start</label>
                <label class="check"><input type="checkbox" data-mc-field="autoUpdateEnabled" \${minecraft.autoUpdateEnabled ? 'checked' : ''} /> Auto Update</label>
                <label class="check"><input type="checkbox" data-mc-field="texturepackRequired" \${minecraft.texturepackRequired ? 'checked' : ''} /> Require Resource Packs</label>
              </div>
              <label>Behavior Packs JSON<textarea data-mc-json="behaviorPacks">\${JSON.stringify(minecraft.behaviorPacks || [], null, 2)}</textarea></label>
              <label>Resource Packs JSON<textarea data-mc-json="resourcePacks">\${JSON.stringify(minecraft.resourcePacks || [], null, 2)}</textarea></label>
              <div class="row">
                <label>Broadcast Message<input data-control="broadcastMessage" placeholder="Server message" /></label>
                <label>Player<input data-control="player" placeholder="player name" /></label>
                <label>Reason<input data-control="reason" placeholder="optional reason" /></label>
              </div>
              <div class="toolbar">
                <button data-action="mc-start">Start</button>
                <button data-action="mc-stop">Stop</button>
                <button data-action="mc-restart">Restart</button>
                <button data-action="mc-update">Update If Empty</button>
                <button data-action="mc-broadcast">Broadcast</button>
                <button data-action="mc-kick">Kick</button>
                <button data-action="mc-ban">Ban</button>
              </div>
            </div>
          \`}
        \`;

        element.querySelector('[data-action="remove"]').addEventListener('click', () => {
          state.config.remoteWorkloads.splice(index, 1);
          delete state.remoteServiceStatuses[workload.id];
          delete state.minecraftStatuses[workload.id];
          renderRemoteWorkloads();
          renderBedrockServers();
          syncRawJson();
        });

        element.querySelector('[data-action="deploy"]').addEventListener('click', async () => {
          try {
            ensureRemoteWorkloadNodeId(workload);
            const workloadId = workload.id;
            await persistConfigState();
            const revision = element.querySelector('[data-control="deployRevision"]').value.trim();
            await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workloadId)}/deploy\`, revision ? { revision } : {});
            if (workload.kind === 'container-service') {
              await refreshContainerServiceStatus(workloadId, { silent: true });
              renderRemoteWorkloads();
            }
            setStatus(\`Deployed remote workload \${workloadId}\`);
          } catch (error) {
            setStatus(error.message, 'error');
          }
        });

        element.querySelectorAll('input[data-field], select[data-field]').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          const eventName = isCheckbox || input.tagName === 'SELECT' ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            const field = input.dataset.field;
            if (!field) return;
            workload[field] = isCheckbox ? input.checked : input.value;
            if (field === 'kind') {
              if (input.value === 'scheduled-container-job') {
                workload.job = job;
                delete workload.service;
                delete workload.minecraft;
              } else if (input.value === 'container-service') {
                workload.service = service;
                delete workload.job;
                delete workload.minecraft;
              } else {
                workload.minecraft = minecraft;
                delete workload.job;
                delete workload.service;
              }
              renderRemoteWorkloads();
              renderBedrockServers();
            } else if (workload.kind === 'minecraft-bedrock-server') {
              renderBedrockServers();
            }
            syncRawJson();
          });
        });

        element.querySelectorAll('input[data-job-field], select[data-job-build-field], input[data-job-build-field]').forEach((input) => {
          input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => {
            workload.job = workload.job || job;
            if (input.dataset.jobField) {
              workload.job[input.dataset.jobField] = input.value;
            }
            if (input.dataset.jobBuildField) {
              workload.job.build[input.dataset.jobBuildField] = input.value;
            }
            syncRawJson();
          });
        });

        element.querySelectorAll('textarea[data-job-json]').forEach((textarea) => {
          textarea.addEventListener('change', () => {
            try {
              workload.job = workload.job || job;
              workload.job[textarea.dataset.jobJson] = parseJsonField(textarea.value, []);
              syncRawJson();
            } catch (error) {
              setStatus(error.message, 'error');
            }
          });
        });

        element.querySelectorAll('input[data-service-field], select[data-service-field]').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          const eventName = isCheckbox || input.tagName === 'SELECT' ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            workload.service = workload.service || createDefaultContainerServiceWorkload().service;
            const field = input.dataset.serviceField;
            if (!field) return;
            if (isCheckbox) {
              workload.service[field] = input.checked;
            } else {
              workload.service[field] = input.value || undefined;
              if (!input.value) delete workload.service[field];
            }
            syncRawJson();
          });
        });

        element.querySelectorAll('textarea[data-service-json]').forEach((textarea) => {
          textarea.addEventListener('change', () => {
            try {
              workload.service = workload.service || createDefaultContainerServiceWorkload().service;
              const field = textarea.dataset.serviceJson;
              if (!field) return;
              if (field === 'build' || field === 'healthCheck') {
                const parsed = parseOptionalJsonText(textarea.value);
                if (parsed === undefined) {
                  delete workload.service[field];
                } else {
                  workload.service[field] = parsed;
                }
              } else {
                workload.service[field] = parseJsonField(textarea.value, []);
              }
              syncRawJson();
            } catch (error) {
              setStatus(error.message, 'error');
            }
          });
        });

        element.querySelectorAll('input[data-mc-field], select[data-mc-field]').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          const eventName = isCheckbox || input.tagName === 'SELECT' ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            workload.minecraft = workload.minecraft || minecraft;
            const field = input.dataset.mcField;
            if (!field) return;
            if (isCheckbox) {
              workload.minecraft[field] = input.checked;
            } else if (input.type === 'number') {
              workload.minecraft[field] = Number(input.value);
            } else {
              workload.minecraft[field] = input.value || undefined;
              if (!input.value) delete workload.minecraft[field];
            }
            renderBedrockServers();
            syncRawJson();
          });
        });

        element.querySelectorAll('textarea[data-mc-json]').forEach((textarea) => {
          textarea.addEventListener('change', () => {
            try {
              workload.minecraft = workload.minecraft || minecraft;
              workload.minecraft[textarea.dataset.mcJson] = parseJsonField(textarea.value, []);
              renderBedrockServers();
              syncRawJson();
            } catch (error) {
              setStatus(error.message, 'error');
            }
          });
        });

        if (workload.kind === 'container-service') {
          const controlServiceAction = async (action) => {
            await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workload.id)}/service/\${action}\`, {});
            return await refreshContainerServiceStatus(workload.id);
          };

          [
            ['service-start', 'start'],
            ['service-stop', 'stop'],
            ['service-restart', 'restart']
          ].forEach(([buttonAction, action]) => {
            element.querySelector(\`[data-action="\${buttonAction}"]\`).addEventListener('click', async () => {
              try {
                await controlServiceAction(action);
                setStatus(\`Container service action completed: \${action}\`);
              } catch (error) {
                setStatus(error.message, 'error');
              }
            });
          });

          element.querySelector('[data-action="service-refresh-status"]').addEventListener('click', async () => {
            try {
              const refreshed = await refreshContainerServiceStatus(workload.id);
              setStatus('Container service status refreshed: ' + describeContainerStatus(refreshed.service));
            } catch (error) {
              setStatus(error.message, 'error');
            }
          });
        }

        if (workload.kind === 'minecraft-bedrock-server') {
          const controlAction = async (action) => {
            const message = element.querySelector('[data-control="broadcastMessage"]').value.trim();
            const player = element.querySelector('[data-control="player"]').value.trim();
            const reason = element.querySelector('[data-control="reason"]').value.trim();
            const body = {
              ...(message ? { message } : {}),
              ...(player ? { player } : {}),
              ...(reason ? { reason } : {})
            };
            await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workload.id)}/minecraft/\${action}\`, body);
          };

          [
            ['mc-start', 'start'],
            ['mc-stop', 'stop'],
            ['mc-restart', 'restart'],
            ['mc-update', 'update-if-empty'],
            ['mc-broadcast', 'broadcast'],
            ['mc-kick', 'kick'],
            ['mc-ban', 'ban']
          ].forEach(([buttonAction, action]) => {
            element.querySelector(\`[data-action="\${buttonAction}"]\`).addEventListener('click', async () => {
              try {
                await controlAction(action);
                setStatus(\`Minecraft action completed: \${action}\`);
              } catch (error) {
                setStatus(error.message, 'error');
              }
            });
          });
        }

        container.appendChild(element);
      });
    }

    function renderRemoteServicesOverview() {
      const container = document.getElementById('remoteServicesOverview');
      if (!container) return;
      const services = state.config.remoteWorkloads.filter(w => w.kind === 'container-service');
      if (services.length === 0) {
        container.innerHTML = '<p class="wizard-hint" style="padding:.75rem">No container services deployed yet. Click <strong>Deploy a Service</strong> above to get started.</p>';
        return;
      }
      container.innerHTML = '';
      services.forEach(svc => {
        const status = state.remoteServiceStatuses[svc.id];
        const statusLabel = status ? (status.running ? 'Running' : 'Stopped') : 'Unknown';
        const statusCls = status ? (status.running ? 'success' : 'error') : '';
        const node = state.config.workerNodes.find(n => n.id === svc.nodeId);
        const nodeLabel = node ? svc.nodeId + ' (' + node.host + ')' : svc.nodeId || 'unassigned';
        const ports = (svc.service && svc.service.ports || []).map(p => p.published + ':' + p.target).join(', ') || 'none';
        const card = document.createElement('div');
        card.className = 'card card-quiet';
        card.innerHTML = '<div class="split-actions"><div>' +
          '<strong>' + svc.id + '</strong>' +
          (svc.description ? ' &mdash; ' + svc.description : '') +
          '<br><small>Node: ' + nodeLabel + ' &bull; Ports: ' + ports + ' &bull; Status: <span class="' + statusCls + '">' + statusLabel + '</span></small>' +
          '</div></div>';
        container.appendChild(card);
      });
    }

    function renderBedrockServers() {
      const container = document.getElementById('bedrockServersContainer');
      container.innerHTML = '';
      if (!firstWorkerNodeId()) {
        container.innerHTML = '<div class="card"><strong>Worker Node Required</strong><p>Add a worker node in the <strong>Nodes</strong> tab first. Set a Node Id and host, then come back here to create a Bedrock server.</p></div>';
        return;
      }
      const workloads = state.config.remoteWorkloads.filter((workload) => workload.kind === 'minecraft-bedrock-server');
      if (workloads.length === 0) {
        container.innerHTML = '<p>No Bedrock servers configured yet.</p>';
        return;
      }

      workloads.forEach((workload) => {
        const minecraft = workload.minecraft || createDefaultMinecraftConfig();
        const minecraftStatus = state.minecraftStatuses[workload.id];
        const autoUpdate = minecraftStatus?.autoUpdate;
        const autoUpdateStatus = describeAutoUpdateStatus(autoUpdate);
        const manualUpdate = minecraftStatus?.manualUpdate;
        const lastManualUpdateResult = minecraftStatus?.lastManualUpdateResult;
        const workerSummary = describeContainerStatus(minecraftStatus?.worker);
        const serverSummary = describeContainerStatus(minecraftStatus?.server);
        const portSummary = minecraftStatus
          ? formatPortMappings(minecraftStatus.server?.ports, minecraftStatus.server?.networkMode)
          : 'not checked yet';
        const configuredImageSummary = minecraftStatus?.server?.configuredImage || minecraft.image;
        const imageIdSummary = minecraftStatus?.server?.imageId || 'not checked yet';
        const bedrockVersionSummary = minecraftStatus?.serverRuntime?.bedrockVersion || 'not detected yet';
        const downloadedVersionSummary = minecraftStatus?.serverRuntime?.downloadedVersion || null;
        const createdLine = minecraftStatus?.server?.createdAt
          ? '<p><strong>Created:</strong> ' + formatTimestamp(minecraftStatus.server.createdAt) + '</p>'
          : '';
        const startedLine = minecraftStatus?.server?.startedAt
          ? '<p><strong>Started:</strong> ' + formatTimestamp(minecraftStatus.server.startedAt) + '</p>'
          : '';
        const workerErrorLine = minecraftStatus?.worker?.error
          ? '<p><strong>Worker Error:</strong> ' + minecraftStatus.worker.error + '</p>'
          : '';
        const serverErrorLine = minecraftStatus?.server?.error
          ? '<p><strong>Server Error:</strong> ' + minecraftStatus.server.error + '</p>'
          : '';
        const autoUpdateWorkerConfigErrorLine = autoUpdate?.workerConfigError
          ? '<p><strong>Worker Config Error:</strong> ' + autoUpdate.workerConfigError + '</p>'
          : '';
        const autoUpdateWorkerStateErrorLine = autoUpdate?.workerStateError
          ? '<p><strong>Worker State Error:</strong> ' + autoUpdate.workerStateError + '</p>'
          : '';
        const downloadedVersionLine = downloadedVersionSummary
          ? '<p><strong>Last Downloaded Version:</strong> ' + escapeHtml(downloadedVersionSummary) + '</p>'
          : '';
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div>
              <strong>\${minecraft.serverName || workload.id || 'new-bedrock-server'}</strong>
              <p>\${workload.description || 'Minecraft Bedrock server on a worker node'}</p>
              <p>For a new server, fill out the basic fields below and click <strong>Apply Server</strong>. That saves the config and updates the node in one step.</p>
            </div>
            <div class="toolbar">
              <button data-action="apply" class="primary">Apply Server</button>
            </div>
          </div>
          <div class="card">
            <div class="split-actions">
              <div>
                <span class="pill">Live Status</span>
                <p><strong>Worker:</strong> \${workerSummary}</p>
                <p><strong>Server:</strong> \${serverSummary}</p>
                <p><strong>Network Mode:</strong> \${minecraftStatus?.server?.networkMode || minecraft.networkMode}</p>
                <p><strong>Configured Port:</strong> \${minecraftStatus?.configuredServerPort || minecraft.serverPort}</p>
                <p><strong>Docker Port Mapping:</strong> \${portSummary}</p>
                <p><strong>Configured Image:</strong> \${formatInlineValue(minecraft.image)}</p>
                <p><strong>Container Image:</strong> \${formatInlineValue(configuredImageSummary)}</p>
                <p><strong>Image ID:</strong> \${formatInlineValue(imageIdSummary)}</p>
                <p><strong>Bedrock Version:</strong> \${formatInlineValue(bedrockVersionSummary)}</p>
                \${downloadedVersionLine}
                \${createdLine}
                \${startedLine}
                \${workerErrorLine}
                \${serverErrorLine}
              </div>
              <div class="toolbar">
                <button data-action="refresh-status">Refresh Status</button>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="split-actions">
              <div>
                <span class="pill">Auto Update</span>
                <p><strong>Status:</strong> \${autoUpdateStatus.label}</p>
                <p>\${autoUpdateStatus.detail}</p>
                <p><strong>Configured Schedule:</strong> \${minecraft.autoUpdateEnabled ? (minecraft.autoUpdateSchedule || 'missing') : 'disabled'}</p>
                <p><strong>Worker Schedule:</strong> \${autoUpdate?.workerSchedule || 'not deployed'}</p>
                <p><strong>Worker Timezone:</strong> \${autoUpdate?.workerTimeZone || 'unknown'}</p>
                <p><strong>Worker Poll Interval:</strong> \${autoUpdate?.workerPollIntervalSeconds ? autoUpdate.workerPollIntervalSeconds + 's' : 'unknown'}</p>
                <p><strong>Last Scheduled Check:</strong> \${formatTimestamp(autoUpdate?.lastRunAt)}</p>
                <p><strong>Next Scheduled Check:</strong> \${formatTimestamp(autoUpdate?.nextRunAt)}</p>
                \${renderMinecraftActionResult(autoUpdate?.lastResult, 'No scheduled update result recorded yet.')}
                \${autoUpdateWorkerConfigErrorLine}
                \${autoUpdateWorkerStateErrorLine}
              </div>
            </div>
          </div>
          <div class="row">
            <label>Server Name<input data-mc-field="serverName" value="\${minecraft.serverName}" placeholder="Gateway Bedrock" /></label>
            <label>World Name<input data-mc-field="worldName" value="\${minecraft.worldName}" placeholder="gateway-main" /></label>
            <label>Game Mode
              <select data-mc-field="gameMode">
                <option value="survival" \${minecraft.gameMode === 'survival' ? 'selected' : ''}>survival</option>
                <option value="creative" \${minecraft.gameMode === 'creative' ? 'selected' : ''}>creative</option>
                <option value="adventure" \${minecraft.gameMode === 'adventure' ? 'selected' : ''}>adventure</option>
              </select>
            </label>
            <label>Difficulty
              <select data-mc-field="difficulty">
                <option value="peaceful" \${minecraft.difficulty === 'peaceful' ? 'selected' : ''}>peaceful</option>
                <option value="easy" \${minecraft.difficulty === 'easy' ? 'selected' : ''}>easy</option>
                <option value="normal" \${minecraft.difficulty === 'normal' ? 'selected' : ''}>normal</option>
                <option value="hard" \${minecraft.difficulty === 'hard' ? 'selected' : ''}>hard</option>
              </select>
            </label>
          </div>
          <details class="card disclosure-card">
            <summary><strong>Advanced Options</strong></summary>
            <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${workload.enabled ? 'checked' : ''} /> Enabled</label>
            <label>Workload Id<input data-field="id" value="\${workload.id}" /></label>
            <label>Description<input data-field="description" value="\${workload.description || ''}" /></label>
            <label>Node<select data-field="nodeId">\${workerNodeOptions(workload.nodeId)}</select></label>
            <label>Image<input data-mc-field="image" value="\${minecraft.image}" /></label>
            <label>Deploy Revision<input data-control="deployRevision" placeholder="optional sha/tag" /></label>
            </div>
            <div class="row">
              <label>Seed<input data-mc-field="levelSeed" value="\${minecraft.levelSeed || ''}" /></label>
            <label>World Source Path<input data-mc-field="worldSourcePath" value="\${minecraft.worldSourcePath || ''}" placeholder="/mnt/storage/docker/shared/worlds/existing-world or .mcworld" /></label>
            <label>Network Mode
              <select data-mc-field="networkMode">
                <option value="host" \${minecraft.networkMode === 'host' ? 'selected' : ''}>host (recommended for Xbox LAN)</option>
                <option value="bridge" \${minecraft.networkMode === 'bridge' ? 'selected' : ''}>bridge</option>
              </select>
            </label>
            <label>World Copy Mode
              <select data-mc-field="worldCopyMode">
                <option value="if-missing" \${minecraft.worldCopyMode === 'if-missing' ? 'selected' : ''}>if-missing</option>
                <option value="always" \${minecraft.worldCopyMode === 'always' ? 'selected' : ''}>always</option>
              </select>
            </label>
            <label>Max Players<input type="number" data-mc-field="maxPlayers" value="\${minecraft.maxPlayers}" /></label>
            <label>Server Port<input type="number" data-mc-field="serverPort" value="\${minecraft.serverPort}" /></label>
            <label>Auto Update Schedule<input data-mc-field="autoUpdateSchedule" value="\${minecraft.autoUpdateSchedule}" /></label>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-mc-field="allowCheats" \${minecraft.allowCheats ? 'checked' : ''} /> Allow Cheats</label>
            <label class="check"><input type="checkbox" data-mc-field="onlineMode" \${minecraft.onlineMode ? 'checked' : ''} /> Online Mode</label>
            <label class="check"><input type="checkbox" data-mc-field="autoStart" \${minecraft.autoStart ? 'checked' : ''} /> Auto Start</label>
            <label class="check"><input type="checkbox" data-mc-field="autoUpdateEnabled" \${minecraft.autoUpdateEnabled ? 'checked' : ''} /> Auto Update</label>
            <label class="check"><input type="checkbox" data-mc-field="texturepackRequired" \${minecraft.texturepackRequired ? 'checked' : ''} /> Require Resource Packs</label>
          </div>
          <div class="card">
            <div class="split-actions">
              <div>
                <span class="pill">Behavior Packs</span>
                <p>Bedrock behavior packs or add-on logic packages.</p>
              </div>
              <button data-action="add-behavior-pack">Add Behavior Pack</button>
            </div>
            <div data-pack-container="behavior"></div>
          </div>
          <div class="card">
            <div class="split-actions">
              <div>
                <span class="pill">Resource Packs</span>
                <p>Textures, sounds, and client-side content packs.</p>
              </div>
              <button data-action="add-resource-pack">Add Resource Pack</button>
            </div>
            <div data-pack-container="resource"></div>
          </div>
          <div class="toolbar">
            <button data-action="remove" class="danger">Remove Server</button>
          </div>
          </details>
          <div class="card">
            <div class="split-actions">
              <div>
                <span class="pill">Server Controls</span>
                <p>Use these after the server has been applied at least once.</p>
              </div>
            </div>
            <div class="toolbar">
              <button data-action="start">Start</button>
              <button data-action="stop">Stop</button>
              <button data-action="restart">Restart</button>
              <button data-action="redeploy">Redeploy</button>
            </div>
            <div class="row">
              <label>Broadcast Message<input data-control="broadcastMessage" placeholder="Server message" /></label>
              <label>Player<input data-control="player" placeholder="player name" /></label>
              <label>Reason<input data-control="reason" placeholder="optional reason" /></label>
            </div>
            <div class="toolbar">
              <button data-action="broadcast">Broadcast</button>
              <button data-action="kick">Kick</button>
              <button data-action="ban">Ban</button>
            </div>
          </div>
          <div class="inline-action-output" data-action-output>
            <strong>Action Output</strong>
            <div>No recent action output for this server.</div>
          </div>
          <div class="card">
            <div class="split-actions">
              <div>
                <span class="pill">Manual Update</span>
                <p>Manual updates use the safe <code>update-if-empty</code> path and will skip if players are online.</p>
                <p><strong>Override:</strong> <code>Force Update</code> bypasses the player-count safety gate.</p>
                <p><strong>Current Queue State:</strong> \${describeManualUpdate(manualUpdate)}</p>
                \${renderMinecraftActionResult(lastManualUpdateResult, 'No manual update result recorded yet.')}
              </div>
            </div>
            <div class="toolbar">
              <button data-action="update-now">Update Now</button>
              <button data-action="force-update-now" class="danger">Force Update</button>
              <button data-action="cancel-scheduled-update" \${manualUpdate?.status === 'pending' ? '' : 'disabled'}>Cancel Pending Update</button>
            </div>
            <div class="row">
              <label>Update In Minutes<input type="number" min="0" step="1" data-control="updateDelayMinutes" value="\${manualUpdate?.status === 'pending' && manualUpdate.mode === 'minutes' && manualUpdate.delayMinutes !== null ? manualUpdate.delayMinutes : 15}" /></label>
              <label>Update At Time<input type="datetime-local" data-control="updateAt" value="\${formatDateTimeLocalValue(manualUpdate?.status === 'pending' && manualUpdate.mode === 'at' ? manualUpdate.runAt : undefined)}" /></label>
            </div>
            <div class="toolbar">
              <button data-action="schedule-update-delay">Schedule In Minutes</button>
              <button data-action="schedule-update-at">Schedule At Time</button>
            </div>
          </div>
          <details class="card disclosure-card">
            <summary><strong>Server Log Tail</strong></summary>
            <p>Use this to confirm the Bedrock version the container actually announced and to inspect recent startup or handshake errors.</p>
            \${renderMinecraftLogTail(minecraftStatus?.serverRuntime?.logs)}
          </details>
        \`;

        const packSpecs = [
          ['behavior', minecraft.behaviorPacks || []],
          ['resource', minecraft.resourcePacks || []]
        ];
        packSpecs.forEach(([packType, packs]) => {
          const packContainer = element.querySelector(\`[data-pack-container="\${packType}"]\`);
          if (packs.length === 0) {
            packContainer.innerHTML = '<p>No packs configured.</p>';
            return;
          }
          packs.forEach((pack, packIndex) => {
            const packCard = document.createElement('div');
            packCard.className = 'card';
            packCard.innerHTML = \`
              <div class="split-actions">
                <div><strong>\${pack.id || 'new-pack'}</strong></div>
                <button class="danger" data-action="remove-pack" data-pack-type="\${packType}" data-pack-index="\${packIndex}">Remove</button>
              </div>
              <div class="row">
                <label>Pack Id<input data-pack-type="\${packType}" data-pack-index="\${packIndex}" data-pack-field="id" value="\${pack.id || ''}" /></label>
                <label>Source Path<input data-pack-type="\${packType}" data-pack-index="\${packIndex}" data-pack-field="sourcePath" value="\${pack.sourcePath || ''}" placeholder="/mnt/storage/docker/shared/bedrock-packs/example" /></label>
                <label>Manifest UUID<input data-pack-type="\${packType}" data-pack-index="\${packIndex}" data-pack-field="manifestUuid" value="\${pack.manifestUuid || ''}" /></label>
                <label>Manifest Version<input data-pack-type="\${packType}" data-pack-index="\${packIndex}" data-pack-field="manifestVersion" value="\${(pack.manifestVersion || [1, 0, 0]).join('.')}" /></label>
              </div>
            \`;
            packContainer.appendChild(packCard);
          });
        });

        const remoteIndex = state.config.remoteWorkloads.findIndex((candidate) => candidate === workload);
        const actionOutput = element.querySelector('[data-action-output]');
        setLocalActionOutput(
          actionOutput,
          summarizeMinecraftActionResult(
            lastManualUpdateResult || autoUpdate?.lastResult,
            'No recent action output for this server.'
          )
        );
        const updateMinecraftField = (field, value, removeWhenEmpty = false, shouldRerender = false) => {
          const targetWorkload = state.config.remoteWorkloads[remoteIndex];
          targetWorkload.minecraft = targetWorkload.minecraft || createDefaultMinecraftConfig();
          const previousMinecraft = { ...targetWorkload.minecraft };
          targetWorkload.minecraft[field] = value;
          if (removeWhenEmpty && (value === '' || value === undefined)) {
            delete targetWorkload.minecraft[field];
          }
          if (field === 'serverName' || field === 'worldName') {
            applyBedrockIdentityDefaults(targetWorkload, previousMinecraft, targetWorkload.minecraft);
          }
          if (shouldRerender) {
            renderRemoteWorkloads();
          }
          syncRawJson();
        };

        element.querySelector('[data-action="remove"]').addEventListener('click', () => {
          state.config.remoteWorkloads.splice(remoteIndex, 1);
          delete state.minecraftStatuses[workload.id];
          renderRemoteWorkloads();
          renderBedrockServers();
          syncRawJson();
        });

        const deployBedrockWorkload = async () => {
          const targetWorkload = state.config.remoteWorkloads[remoteIndex];
          targetWorkload.minecraft = targetWorkload.minecraft || createDefaultMinecraftConfig();
          applyBedrockIdentityDefaults(targetWorkload, targetWorkload.minecraft, targetWorkload.minecraft);
          ensureRemoteWorkloadNodeId(targetWorkload);
          renderRemoteWorkloads();
          renderBedrockServers();
          syncRawJson();
          const workloadId = targetWorkload.id;
          await persistConfigState();
          const revision = element.querySelector('[data-control="deployRevision"]').value.trim();
          await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workloadId)}/deploy\`, revision ? { revision } : {});
          await refreshMinecraftStatus(workloadId);
          return workloadId;
        };

        element.querySelector('[data-action="apply"]').addEventListener('click', async () => {
          const button = element.querySelector('[data-action="apply"]');
          await withBusyButton(button, 'Applying…', async () => {
            try {
              setLocalActionOutput(actionOutput, 'Applying Bedrock server configuration to the worker node…', 'progress');
              const workloadId = await deployBedrockWorkload();
              setLocalActionOutput(actionOutput, 'Applied Bedrock server ' + workloadId + '.', 'ok');
              setStatus(\`Applied Bedrock server \${workloadId}\`);
            } catch (error) {
              setLocalActionOutput(actionOutput, error.message, 'error');
              setStatus(error.message, 'error');
            }
          });
        });

        element.querySelector('[data-action="redeploy"]').addEventListener('click', async () => {
          const button = element.querySelector('[data-action="redeploy"]');
          await withBusyButton(button, 'Redeploying…', async () => {
            try {
              setLocalActionOutput(actionOutput, 'Redeploying Bedrock server and remote gateway-worker…', 'progress');
              const workloadId = await deployBedrockWorkload();
              setLocalActionOutput(actionOutput, 'Redeployed Bedrock server ' + workloadId + '.', 'ok');
              setStatus(\`Redeployed Bedrock server \${workloadId}\`);
            } catch (error) {
              setLocalActionOutput(actionOutput, error.message, 'error');
              setStatus(error.message, 'error');
            }
          });
        });

        element.querySelector('[data-action="refresh-status"]').addEventListener('click', async () => {
          const button = element.querySelector('[data-action="refresh-status"]');
          await withBusyButton(button, 'Refreshing…', async () => {
            try {
              setLocalActionOutput(actionOutput, 'Refreshing Bedrock runtime details…', 'progress');
              const refreshed = await refreshMinecraftStatus(workload.id);
              setLocalActionOutput(
                actionOutput,
                'Refreshed Bedrock status. Version: '
                  + (refreshed.serverRuntime?.bedrockVersion || 'unknown')
                  + '. Image: '
                  + (refreshed.server?.configuredImage || minecraft.image)
                  + '.',
                'ok'
              );
              setStatus('Refreshed Bedrock status for ' + workload.id);
            } catch (error) {
              setLocalActionOutput(actionOutput, error.message, 'error');
              setStatus(error.message, 'error');
            }
          });
        });

        [
          ['start', 'start'],
          ['stop', 'stop'],
          ['restart', 'restart']
        ].forEach(([buttonAction, action]) => {
          element.querySelector(\`[data-action="\${buttonAction}"]\`).addEventListener('click', async () => {
            const button = element.querySelector(\`[data-action="\${buttonAction}"]\`);
            await withBusyButton(button, 'Working…', async () => {
              try {
                setLocalActionOutput(actionOutput, 'Running ' + action + '…', 'progress');
                await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workload.id)}/minecraft/\${action}\`, {});
                const refreshed = await refreshMinecraftStatus(workload.id);
                setLocalActionOutput(actionOutput, 'Bedrock action completed: ' + action + '. Worker: ' + describeContainerStatus(refreshed.worker) + '. Server: ' + describeContainerStatus(refreshed.server) + '.', 'ok');
                setStatus(\`Bedrock action completed: \${action}\`);
              } catch (error) {
                setLocalActionOutput(actionOutput, error.message, 'error');
                setStatus(error.message, 'error');
              }
            });
          });
        });

        element.querySelector('[data-action="update-now"]').addEventListener('click', async () => {
          const button = element.querySelector('[data-action="update-now"]');
          await withBusyButton(button, 'Updating…', async () => {
            try {
              setLocalActionOutput(actionOutput, 'Running safe Bedrock update…', 'progress');
              await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workload.id)}/minecraft/update-request\`, {
                mode: 'now'
              });
              const refreshed = await refreshMinecraftStatus(workload.id);
              setLocalActionOutput(actionOutput, summarizeMinecraftActionResult(refreshed.lastManualUpdateResult, 'Safe Bedrock update finished.'), 'ok');
              setStatus('Queued Bedrock update now');
            } catch (error) {
              setLocalActionOutput(actionOutput, error.message, 'error');
              setStatus(error.message, 'error');
            }
          });
        });

        element.querySelector('[data-action="force-update-now"]').addEventListener('click', async () => {
          const button = element.querySelector('[data-action="force-update-now"]');
          await withBusyButton(button, 'Forcing…', async () => {
            try {
              setLocalActionOutput(actionOutput, 'Running forced Bedrock update…', 'progress');
              await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workload.id)}/minecraft/force-update\`, {});
              const refreshed = await refreshMinecraftStatus(workload.id);
              setLocalActionOutput(actionOutput, summarizeMinecraftActionResult(refreshed.lastManualUpdateResult, 'Forced Bedrock update finished.'), 'ok');
              setStatus('Forced Bedrock update completed');
            } catch (error) {
              setLocalActionOutput(actionOutput, error.message, 'error');
              setStatus(error.message, 'error');
            }
          });
        });

        element.querySelector('[data-action="schedule-update-delay"]').addEventListener('click', async () => {
          const button = element.querySelector('[data-action="schedule-update-delay"]');
          await withBusyButton(button, 'Scheduling…', async () => {
            try {
              const delayMinutes = Number(element.querySelector('[data-control="updateDelayMinutes"]').value);
              if (!Number.isFinite(delayMinutes) || delayMinutes < 0) {
                throw new Error('Update delay must be a non-negative number of minutes');
              }
              setLocalActionOutput(actionOutput, 'Scheduling Bedrock update in ' + delayMinutes + ' minute(s)…', 'progress');
              await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workload.id)}/minecraft/update-request\`, {
                mode: 'minutes',
                delayMinutes
              });
              const refreshed = await refreshMinecraftStatus(workload.id);
              setLocalActionOutput(actionOutput, describeManualUpdate(refreshed.manualUpdate), 'ok');
              setStatus(\`Queued Bedrock update in \${delayMinutes} minute(s)\`);
            } catch (error) {
              setLocalActionOutput(actionOutput, error.message, 'error');
              setStatus(error.message, 'error');
            }
          });
        });

        element.querySelector('[data-action="schedule-update-at"]').addEventListener('click', async () => {
          const button = element.querySelector('[data-action="schedule-update-at"]');
          await withBusyButton(button, 'Scheduling…', async () => {
            try {
              const rawValue = element.querySelector('[data-control="updateAt"]').value;
              if (!rawValue) {
                throw new Error('Pick a date and time first');
              }
              const runAt = new Date(rawValue);
              if (Number.isNaN(runAt.getTime())) {
                throw new Error(\`Invalid update time: \${rawValue}\`);
              }
              setLocalActionOutput(actionOutput, 'Scheduling Bedrock update for ' + runAt.toLocaleString() + '…', 'progress');
              await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workload.id)}/minecraft/update-request\`, {
                mode: 'at',
                runAt: runAt.toISOString()
              });
              const refreshed = await refreshMinecraftStatus(workload.id);
              setLocalActionOutput(actionOutput, describeManualUpdate(refreshed.manualUpdate), 'ok');
              setStatus(\`Queued Bedrock update for \${runAt.toLocaleString()}\`);
            } catch (error) {
              setLocalActionOutput(actionOutput, error.message, 'error');
              setStatus(error.message, 'error');
            }
          });
        });

        element.querySelector('[data-action="cancel-scheduled-update"]').addEventListener('click', async () => {
          const button = element.querySelector('[data-action="cancel-scheduled-update"]');
          await withBusyButton(button, 'Cancelling…', async () => {
            try {
              setLocalActionOutput(actionOutput, 'Cancelling pending Bedrock update…', 'progress');
              await requestJson('DELETE', \`/api/remote-workloads/\${encodeURIComponent(workload.id)}/minecraft/update-request\`);
              const refreshed = await refreshMinecraftStatus(workload.id);
              setLocalActionOutput(actionOutput, describeManualUpdate(refreshed.manualUpdate), 'ok');
              setStatus('Cancelled pending Bedrock update');
            } catch (error) {
              setLocalActionOutput(actionOutput, error.message, 'error');
              setStatus(error.message, 'error');
            }
          });
        });

        ['broadcast', 'kick', 'ban'].forEach((action) => {
          element.querySelector(\`[data-action="\${action}"]\`).addEventListener('click', async () => {
            const button = element.querySelector(\`[data-action="\${action}"]\`);
            await withBusyButton(button, 'Working…', async () => {
              try {
                const message = element.querySelector('[data-control="broadcastMessage"]').value.trim();
                const player = element.querySelector('[data-control="player"]').value.trim();
                const reason = element.querySelector('[data-control="reason"]').value.trim();
                setLocalActionOutput(actionOutput, 'Running ' + action + '…', 'progress');
                await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workload.id)}/minecraft/\${action}\`, {
                  ...(message ? { message } : {}),
                  ...(player ? { player } : {}),
                  ...(reason ? { reason } : {})
                });
                await refreshMinecraftStatus(workload.id);
                setLocalActionOutput(actionOutput, 'Bedrock action completed: ' + action + '.', 'ok');
                setStatus(\`Bedrock action completed: \${action}\`);
              } catch (error) {
                setLocalActionOutput(actionOutput, error.message, 'error');
                setStatus(error.message, 'error');
              }
            });
          });
        });

        element.querySelectorAll('input[data-field], select[data-field]').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          const eventName = isCheckbox || input.tagName === 'SELECT' ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            state.config.remoteWorkloads[remoteIndex][field] = isCheckbox ? input.checked : input.value;
            if (isCheckbox || input.tagName === 'SELECT') {
              renderRemoteWorkloads();
            }
            syncRawJson();
          });
        });

        element.querySelectorAll('input[data-mc-field], select[data-mc-field]').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          const eventName = isCheckbox || input.tagName === 'SELECT' ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            const field = input.dataset.mcField;
            if (!field) {
              return;
            }
            if (isCheckbox) {
              updateMinecraftField(field, input.checked, false, true);
              return;
            }
            if (input.type === 'number') {
              updateMinecraftField(field, Number(input.value));
              return;
            }
            updateMinecraftField(field, input.value || undefined, true, input.tagName === 'SELECT');
          });
        });

        element.querySelector('[data-action="add-behavior-pack"]').addEventListener('click', () => {
          state.config.remoteWorkloads[remoteIndex].minecraft = state.config.remoteWorkloads[remoteIndex].minecraft || createDefaultMinecraftConfig();
          state.config.remoteWorkloads[remoteIndex].minecraft.behaviorPacks.push(createDefaultMinecraftPack());
          renderRemoteWorkloads();
          renderBedrockServers();
          syncRawJson();
        });
        element.querySelector('[data-action="add-resource-pack"]').addEventListener('click', () => {
          state.config.remoteWorkloads[remoteIndex].minecraft = state.config.remoteWorkloads[remoteIndex].minecraft || createDefaultMinecraftConfig();
          state.config.remoteWorkloads[remoteIndex].minecraft.resourcePacks.push(createDefaultMinecraftPack());
          renderRemoteWorkloads();
          renderBedrockServers();
          syncRawJson();
        });

        element.querySelectorAll('[data-pack-field]').forEach((input) => {
          const eventName = input.tagName === 'SELECT' ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            const packType = input.dataset.packType;
            const packIndex = Number(input.dataset.packIndex);
            const field = input.dataset.packField;
            if (!packType || !field || !Number.isInteger(packIndex)) {
              return;
            }
            const key = packType === 'behavior' ? 'behaviorPacks' : 'resourcePacks';
            const targetPack = state.config.remoteWorkloads[remoteIndex].minecraft[key][packIndex];
            if (field === 'manifestVersion') {
              targetPack.manifestVersion = parsePackVersion(input.value);
            } else {
              targetPack[field] = input.value;
            }
            syncRawJson();
          });
        });

        element.querySelectorAll('[data-action="remove-pack"]').forEach((button) => {
          button.addEventListener('click', () => {
            const packType = button.dataset.packType;
            const packIndex = Number(button.dataset.packIndex);
            if (!packType || !Number.isInteger(packIndex)) {
              return;
            }
            const key = packType === 'behavior' ? 'behaviorPacks' : 'resourcePacks';
            state.config.remoteWorkloads[remoteIndex].minecraft[key].splice(packIndex, 1);
            renderRemoteWorkloads();
            renderBedrockServers();
            syncRawJson();
          });
        });

        container.appendChild(element);
      });
    }

    function renderGateway() {
      document.getElementById('gatewayServerNames').value = state.config.gateway.serverNames.join(', ');
      document.getElementById('nginxSiteOutputPath').value = state.config.gateway.nginxSiteOutputPath;
      document.getElementById('upstreamDirectory').value = state.config.gateway.upstreamDirectory;
      document.getElementById('nginxReloadCommand').value = state.config.gateway.nginxReloadCommand;
      document.getElementById('systemdUnitDirectory').value = state.config.gateway.systemdUnitDirectory;
      document.getElementById('systemdReloadCommand').value = state.config.gateway.systemdReloadCommand;
      document.getElementById('systemdEnableTimerCommand').value = state.config.gateway.systemdEnableTimerCommand;
      document.getElementById('adminUiEnabled').checked = state.config.gateway.adminUi.enabled;
      document.getElementById('adminUiHost').value = state.config.gateway.adminUi.host;
      document.getElementById('adminUiPort').value = String(state.config.gateway.adminUi.port);
      document.getElementById('adminUiRoutePath').value = state.config.gateway.adminUi.routePath;
      document.getElementById('adminUiServiceName').value = state.config.gateway.adminUi.serviceName;
      document.getElementById('adminUiWorkingDirectory').value = state.config.gateway.adminUi.workingDirectory;
      document.getElementById('adminUiConfigPath').value = state.config.gateway.adminUi.configPath;
      document.getElementById('adminUiBuildOutDir').value = state.config.gateway.adminUi.buildOutDir;
      document.getElementById('adminUiNodeExecutable').value = state.config.gateway.adminUi.nodeExecutable;
      document.getElementById('adminUiUser').value = state.config.gateway.adminUi.user;
      document.getElementById('adminUiGroup').value = state.config.gateway.adminUi.group || '';
    }

    function render() {
      renderGateway();
      renderGatewayApiProfile();
      renderGatewayApiJobRuntimeProfile();
      renderKulrsActivityProfile();
      renderGatewayChatPlatformProfile();
      renderPiProxyProfile();
      renderSecrets();
      renderJobCatalog();
      renderWorkflows();
      renderWorkerNodes();
      renderRemoteWorkloads();
      renderBedrockServers();
      renderAutomation();
      renderApps();
      renderJobs();
      renderFeatures();
      renderRuntime();
      syncRawJson();
      renderActiveTab();
    }

    async function fetchConfig() {
      const response = await fetch(joinBase('/api/config'));
      if (!response.ok) {
        throw new Error(await response.text());
      }
      state.config = await response.json();
      render();
      setStatus('Current', 'ok', { log: false });
    }

    async function loadTabData(tab, options = {}) {
      const settled = await Promise.allSettled((() => {
        switch (tab) {
          case 'infra':
            return [
              fetchRuntime(),
              refreshAllRemoteServiceStatuses({ silent: true }),
              refreshAllMinecraftStatuses({ silent: true, skipRegistry: true }),
              fetchPiProxyStatus({ silent: true })
            ];
          case 'services':
            return [
              fetchRuntime(),
              fetchKulrsActivityStatus(),
              fetchTtsVoices(),
              fetchChatProviders()
            ];
          case 'agents':
            return [
              fetchTtsVoices(),
              fetchChatProviders(),
              fetchWorkflows(),
              fetchJobsCatalog(),
              fetchRuntime()
            ];
          default:
            return [fetchRuntime()];
        }
      })());

      if (options.silent) {
        return settled;
      }

      const failures = settled
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
      if (failures.length > 0) {
        setStatus(failures[0], 'error');
      }
      return settled;
    }

    async function fetchRuntime() {
      const response = await fetch(joinBase('/api/runtime'));
      if (!response.ok) {
        throw new Error(await response.text());
      }
      state.runtime = await response.json();
      renderRuntime();
    }

    async function fetchKulrsActivityStatus() {
      if (!state.config) {
        state.kulrsActivityStatus = null;
        renderKulrsActivityProfile();
        return null;
      }
      try {
        state.kulrsActivityStatus = await requestJson('GET', '/api/service-profiles/kulrs-activity/status');
      } catch (error) {
        state.kulrsActivityStatus = { error: error.message };
      }
      renderKulrsActivityProfile();
      return state.kulrsActivityStatus;
    }

    async function fetchWorkflows() {
      if (state.config && !state.config.serviceProfiles.gatewayApi.enabled) {
        state.workflows = [];
        renderWorkflows();
        return;
      }
      const response = await fetch(joinBase('/api/workflows'));
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load workflows');
      }
      state.workflows = Array.isArray(data) ? data : [];
      renderWorkflows();
    }

    async function fetchJobsCatalog() {
      if (!state.config || !state.config.serviceProfiles.gatewayApi.enabled) {
        state.jobsCatalog = [];
        renderJobCatalog();
        return;
      }

      const data = await requestJson('GET', '/api/jobs');
      state.jobsCatalog = Array.isArray(data?.jobs) ? data.jobs : [];
      renderJobCatalog();
    }

    async function fetchTtsVoices() {
      if (!state.config || !state.config.serviceProfiles.gatewayChatPlatform.tts.enabled) {
        state.ttsVoices = [];
        renderGatewayChatPlatformProfile();
        return;
      }
      const data = await requestJson('GET', '/api/tts/voices');
      state.ttsVoices = Array.isArray(data?.voices) ? data.voices : [];
      renderGatewayChatPlatformProfile();
    }

    async function fetchChatProviderModels(providerName) {
      if (!providerName || !state.config || !state.config.serviceProfiles.gatewayChatPlatform.enabled) {
        return;
      }
      const data = await requestJson('GET', \`/api/chat-platform/providers/\${encodeURIComponent(providerName)}/models\`);
      state.providerModels[providerName] = Array.isArray(data?.models) ? data.models : [];
    }

    async function fetchChatProviders() {
      if (!state.config || !state.config.serviceProfiles.gatewayChatPlatform.enabled) {
        state.chatProviders = [];
        state.providerModels = {};
        renderGatewayChatPlatformProfile();
        return;
      }
      const data = await requestJson('GET', '/api/chat-platform/providers/status');
      state.chatProviders = Array.isArray(data?.providers) ? data.providers : [];
      state.providerModels = {};
      await Promise.all(
        normalizedChatProviders().map((provider) =>
          fetchChatProviderModels(provider.name).catch(() => {
            state.providerModels[provider.name] = [];
          })
        )
      );
      renderGatewayChatPlatformProfile();
    }

    async function requestJson(method, url, body) {
      const response = await fetch(joinBase(url), {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const data = response.status === 204 ? null : await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'Request failed');
      }
      return data;
    }

    function describeContainerStatus(container) {
      if (!container) {
        return 'unknown';
      }
      if (container.error) {
        return 'error';
      }
      if (!container.exists) {
        return 'missing';
      }
      if (container.running) {
        return 'running';
      }
      return container.status || 'stopped';
    }

    function formatTimestamp(value) {
      if (!value) {
        return 'not yet';
      }
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return value;
      }
      return date.toLocaleString();
    }

    function formatDateTimeLocalValue(value) {
      const date = value ? new Date(value) : new Date();
      if (Number.isNaN(date.getTime())) {
        return '';
      }
      const pad = (input) => String(input).padStart(2, '0');
      return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate())
      ].join('-') + 'T' + [pad(date.getHours()), pad(date.getMinutes())].join(':');
    }

    function describeAutoUpdateStatus(autoUpdate) {
      if (!autoUpdate) {
        return {
          label: 'unknown',
          detail: 'Auto-update status has not been checked yet.'
        };
      }

      switch (autoUpdate.status) {
        case 'running':
          return {
            label: 'running',
            detail: 'The update schedule is deployed to gateway-worker and the worker container is running.'
          };
        case 'disabled':
          return {
            label: 'disabled',
            detail: 'Auto-update is disabled in config.'
          };
        case 'not-deployed':
          return {
            label: 'not deployed',
            detail: 'This Bedrock workload is not present in the deployed gateway-worker config yet. Apply or redeploy the server.'
          };
        case 'worker-stopped':
          return {
            label: 'worker stopped',
            detail: 'The gateway-worker container is not running, so no schedule is being evaluated.'
          };
        case 'misconfigured':
          return {
            label: 'misconfigured',
            detail: 'The worker config for this Bedrock server is missing the auto-update schedule.'
          };
        default:
          return {
            label: autoUpdate.status || 'unknown',
            detail: autoUpdate.summary || 'Unknown auto-update state.'
          };
      }
    }

    function describeManualUpdate(record) {
      if (!record) {
        return 'No manual update queued.';
      }
      if (record.status === 'pending') {
        return 'Queued for ' + formatTimestamp(record.runAt) + '.';
      }
      if (record.status === 'running') {
        return 'Running now.';
      }
      if (record.status === 'completed') {
        return 'Last manual update ran at ' + formatTimestamp(record.completedAt || record.startedAt || record.runAt) + '.';
      }
      if (record.status === 'cancelled') {
        return 'Last queued manual update was cancelled.';
      }
      return 'Last manual update failed: ' + (record.error || 'unknown error');
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function formatInlineValue(value, empty = 'not yet') {
      if (value === null || value === undefined || value === '') {
        return empty;
      }
      return escapeHtml(String(value));
    }

    function renderMinecraftLogTail(logs) {
      if (!logs) {
        return '<p>Log tail has not been checked yet.</p>';
      }
      const lineCount = Number.isFinite(logs.requestedLines) ? logs.requestedLines : 100;
      const fetchedLine = logs.fetchedAt
        ? '<p><strong>Fetched:</strong> ' + escapeHtml(formatTimestamp(logs.fetchedAt)) + '</p>'
        : '';
      const errorLine = logs.error
        ? '<p><strong>Log Error:</strong> ' + escapeHtml(logs.error) + '</p>'
        : '';
      const lines = Array.isArray(logs.lines) ? logs.lines : [];
      const body = lines.length > 0
        ? '<pre class="log-output">' + escapeHtml(lines.join('\\n')) + '</pre>'
        : '<p>No server log lines were returned.</p>';
      return [
        '<p><strong>Window:</strong> last ' + escapeHtml(String(lineCount)) + ' lines</p>',
        fetchedLine,
        errorLine,
        body
      ].join('');
    }

    function renderMinecraftActionResult(result, emptyMessage) {
      if (!result) {
        return '<p>' + emptyMessage + '</p>';
      }
      const detailLine = result.detail
        ? '<p><strong>Detail:</strong> ' + escapeHtml(result.detail) + '</p>'
        : '';
      const stdoutBlock = result.stdout
        ? '<details><summary>Command Output</summary><pre>' + escapeHtml(result.stdout) + '</pre></details>'
        : '';
      const stderrBlock = result.stderr
        ? '<details><summary>Command Errors</summary><pre>' + escapeHtml(result.stderr) + '</pre></details>'
        : '';
      return [
        '<p><strong>Status:</strong> ' + escapeHtml(result.status || 'unknown') + '</p>',
        '<p><strong>Summary:</strong> ' + escapeHtml(result.summary || 'No summary') + '</p>',
        '<p><strong>Recorded:</strong> ' + escapeHtml(formatTimestamp(result.recordedAt)) + '</p>',
        detailLine,
        stdoutBlock,
        stderrBlock
      ].join('');
    }

    function summarizeMinecraftActionResult(result, fallback) {
      if (!result) {
        return fallback;
      }
      const parts = [result.summary || fallback];
      if (result.detail && result.detail !== result.summary) {
        parts.push(result.detail);
      }
      if (result.recordedAt) {
        parts.push('Recorded ' + formatTimestamp(result.recordedAt));
      }
      return parts.join(' | ');
    }

    function formatPortMappings(ports, networkMode) {
      if (networkMode === 'host') {
        return 'host network';
      }
      if (!ports || typeof ports !== 'object') {
        return 'none';
      }
      const entries = Object.entries(ports);
      if (entries.length === 0) {
        return 'none';
      }
      return entries.map(([containerPort, bindings]) => {
        if (!Array.isArray(bindings) || bindings.length === 0) {
          return containerPort + ' unpublished';
        }
        const mapped = bindings
          .map((binding) => binding && typeof binding === 'object'
            ? [binding.HostIp || '0.0.0.0', binding.HostPort || '?'].join(':')
            : '?')
          .join(', ');
        return containerPort + ' -> ' + mapped;
      }).join('; ');
    }

    function describeServiceHealthCheck(healthCheck) {
      if (!healthCheck) {
        return 'not configured';
      }
      const target = healthCheck.target || 'unknown target';
      const detail = healthCheck.detail || 'no detail';
      if (healthCheck.status === 'ok') {
        return 'ok | ' + target + ' | ' + detail;
      }
      if (healthCheck.status === 'error') {
        return 'error | ' + target + ' | ' + detail;
      }
      return 'unknown | ' + target + ' | ' + detail;
    }

    async function refreshContainerServiceStatus(workloadId, options = {}) {
      const status = await requestJson('GET', '/api/remote-workloads/' + encodeURIComponent(workloadId) + '/service-status');
      state.remoteServiceStatuses[workloadId] = status;
      if (!options.silent) {
        renderRemoteWorkloads();
      }
      return status;
    }

    async function refreshAllRemoteServiceStatuses(options = {}) {
      const workloads = state.config
        ? state.config.remoteWorkloads.filter((workload) => workload.kind === 'container-service' && workload.id)
        : [];
      await Promise.all(workloads.map(async (workload) => {
        try {
          await refreshContainerServiceStatus(workload.id, { silent: true });
        } catch (error) {
          const message = error && typeof error === 'object' && 'message' in error ? error.message : String(error);
          state.remoteServiceStatuses[workload.id] = {
            workloadId: workload.id,
            nodeId: workload.nodeId,
            service: {
              containerName: workload.id + '-service',
              exists: false,
              status: 'error',
              running: false,
              error: message
            }
          };
        }
      }));
      if (!options.silent) {
        renderRemoteWorkloads();
      }
    }

    async function refreshMinecraftStatus(workloadId, options = {}) {
      const status = await requestJson('GET', '/api/remote-workloads/' + encodeURIComponent(workloadId) + '/status');
      state.minecraftStatuses[workloadId] = status;
      if (!options.silent) {
        renderBedrockServers();
        renderPiProxyProfile();
      }
      return status;
    }

    async function fetchPiProxyRegistry(options = {}) {
      if (!state.config || !state.config.serviceProfiles.piProxy.enabled) {
        state.piProxyRegistry = null;
        renderPiProxyProfile();
        return null;
      }

      try {
        state.piProxyRegistry = await requestJson('GET', state.config.serviceProfiles.piProxy.registryPath);
        renderPiProxyProfile();
        if (!options.silent) {
          const serverCount = Array.isArray(state.piProxyRegistry.servers) ? state.piProxyRegistry.servers.length : 0;
          setStatus('Loaded Pi proxy registry (' + serverCount + ' worlds)');
        }
        return state.piProxyRegistry;
      } catch (error) {
        state.piProxyRegistry = {
          error: error.message
        };
        renderPiProxyProfile();
        if (!options.silent) {
          setStatus(error.message, 'error');
        }
        return null;
      }
    }

    async function fetchPiProxyStatus(options = {}) {
      if (!state.config || !state.config.serviceProfiles.piProxy.enabled) {
        state.piProxyStatus = null;
        renderPiProxyProfile();
        return null;
      }

      try {
        state.piProxyStatus = await requestJson('GET', '/api/service-profiles/pi-proxy/status');
        renderPiProxyProfile();
        if (!options.silent) {
          setStatus(state.piProxyStatus.summary || 'Loaded Pi proxy status');
        }
        return state.piProxyStatus;
      } catch (error) {
        state.piProxyStatus = { error: error.message };
        renderPiProxyProfile();
        if (!options.silent) {
          setStatus(error.message, 'error');
        }
        return null;
      }
    }

    async function refreshAllMinecraftStatuses(options = {}) {
      const workloads = state.config
        ? state.config.remoteWorkloads.filter((workload) => workload.kind === 'minecraft-bedrock-server' && workload.id)
        : [];
      await Promise.all(workloads.map(async (workload) => {
        try {
          await refreshMinecraftStatus(workload.id, { silent: true, skipRegistry: true });
        } catch (error) {
          const message = error && typeof error === 'object' && 'message' in error ? error.message : String(error);
          state.minecraftStatuses[workload.id] = {
            workloadId: workload.id,
            nodeId: workload.nodeId,
            configuredServerPort: workload.minecraft?.serverPort || null,
            worker: { containerName: 'gateway-worker', exists: false, status: 'error', running: false, error: message },
            server: { containerName: workload.id + '-server', exists: false, status: 'error', running: false, error: message }
          };
        }
      }));
      if (!options.silent) {
        renderBedrockServers();
        renderPiProxyProfile();
      }
    }

    async function persistConfigState() {
      normalizeRemoteWorkloadNodeIds();
      const result = await requestJson('POST', '/api/config', state.config);
      state.config = result.config;
      render();
      await loadTabData(state.activeTab, { silent: true });
      return result;
    }

    async function syncConfiguredAgents() {
      await requestJson('POST', '/api/service-profiles/gateway-chat-platform/sync');
      setStatus('Chat agents synced to gateway-chat-platform');
    }

    document.querySelectorAll('.top-tab-nav .tab-button').forEach((button) => {
      button.addEventListener('click', async () => {
        state.activeTab = button.dataset.tab || 'overview';
        render();
        await loadTabData(state.activeTab);
      });
    });

    document.querySelectorAll('.sub-tab-nav .sub-tab-button').forEach((button) => {
      button.addEventListener('click', () => {
        const group = button.closest('.sub-tab-nav').dataset.subGroup;
        switchSubTab(group, button.dataset.subTab);
      });
    });

    document.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) {
        return;
      }
      button.classList.add('button-tapped');
      setTimeout(() => button.classList.remove('button-tapped'), 180);
    }, true);

    document.getElementById('toggleActionFeedButton').addEventListener('click', () => {
      state.actionFeedCollapsed = !state.actionFeedCollapsed;
      if (actionFeedCollapseTimer) {
        clearTimeout(actionFeedCollapseTimer);
        actionFeedCollapseTimer = null;
      }
      applyActionFeedVisibility();
    });

    document.querySelectorAll('[data-open-tab]').forEach((button) => {
      button.addEventListener('click', async () => {
        state.activeTab = button.dataset.openTab || 'overview';
        render();
        await loadTabData(state.activeTab);
      });
    });

    document.getElementById('gatewayServerNames').addEventListener('input', (event) => {
      updateGatewayField('serverNames', event.target.value.split(',').map((item) => item.trim()).filter(Boolean));
    });
    ['nginxSiteOutputPath', 'upstreamDirectory', 'nginxReloadCommand', 'systemdUnitDirectory', 'systemdReloadCommand', 'systemdEnableTimerCommand'].forEach((id) => {
      document.getElementById(id).addEventListener('input', (event) => updateGatewayField(id, event.target.value));
    });
    [
      ['adminUiEnabled', 'enabled', 'checkbox'],
      ['adminUiHost', 'host'],
      ['adminUiPort', 'port', 'number'],
      ['adminUiRoutePath', 'routePath'],
      ['adminUiServiceName', 'serviceName'],
      ['adminUiWorkingDirectory', 'workingDirectory'],
      ['adminUiConfigPath', 'configPath'],
      ['adminUiBuildOutDir', 'buildOutDir'],
      ['adminUiNodeExecutable', 'nodeExecutable'],
      ['adminUiUser', 'user'],
      ['adminUiGroup', 'group']
    ].forEach(([id, key, kind]) => {
      const element = document.getElementById(id);
      element.addEventListener(kind === 'checkbox' ? 'change' : 'input', (event) => {
        const target = event.target;
        if (kind === 'checkbox') {
          updateAdminUiField(key, target.checked);
          return;
        }
        if (kind === 'number') {
          updateAdminUiField(key, Number(target.value));
          return;
        }
        updateAdminUiField(key, target.value);
        if (key === 'group' && !target.value) {
          delete state.config.gateway.adminUi.group;
          syncRawJson();
        }
      });
    });
    [
      ['gatewayApiProfileEnabled', 'enabled', 'checkbox'],
      ['gatewayApiProfileAppId', 'appId'],
      ['gatewayApiProfileApiBaseUrl', 'apiBaseUrl'],
      ['gatewayApiProfileEnvFilePath', 'envFilePath'],
    ].forEach(([id, key, kind]) => {
      const element = document.getElementById(id);
      element.addEventListener(kind === 'checkbox' ? 'change' : 'input', (event) => {
        const target = event.target;
        state.config.serviceProfiles.gatewayApi[key] = kind === 'checkbox' ? target.checked : target.value;
        renderSecrets();
        syncRawJson();
      });
    });
    [
      ['gatewayApiJobChannelsFilePath', 'channelsFilePath']
    ].forEach(([id, key]) => {
      const element = document.getElementById(id);
      element.addEventListener('input', (event) => {
        state.config.serviceProfiles.gatewayApi.jobRuntime[key] = event.target.value;
        renderSecrets();
        syncRawJson();
      });
    });
    [
      ['kulrsEnabled', 'enabled', 'checkbox'],
      ['kulrsSchedule', 'schedule'],
      ['kulrsUser', 'user'],
      ['kulrsGroup', 'group'],
      ['kulrsTimezone', 'timezone'],
      ['kulrsEnvFilePath', 'envFilePath'],
      ['kulrsCredentialsFilePath', 'credentialsFilePath'],
      ['kulrsWorkspaceDir', 'workspaceDir'],
      ['kulrsWorkingDirectory', 'workingDirectory'],
      ['kulrsExecStart', 'execStart'],
      ['kulrsDescription', 'description'],
      ['kulrsFirebaseApiKey', 'firebaseApiKey'],
      ['kulrsUnsplashAccessKey', 'unsplashAccessKey'],
    ].forEach(([id, key, kind]) => {
      const element = document.getElementById(id);
      element.addEventListener(kind === 'checkbox' ? 'change' : 'input', (event) => {
        const target = event.target;
        state.config.serviceProfiles.gatewayApi.kulrsActivity[key] = kind === 'checkbox' ? target.checked : target.value;
        if (key === 'group' && !target.value) {
          delete state.config.serviceProfiles.gatewayApi.kulrsActivity.group;
        }
        renderSecrets();
        syncRawJson();
      });
    });
    [
      ['gatewayChatProfileEnabled', 'enabled', 'checkbox'],
      ['gatewayChatProfileAppId', 'appId'],
      ['gatewayChatProfileApiBaseUrl', 'apiBaseUrl'],
      ['gatewayChatProfileEnvFilePath', 'apiEnvFilePath'],
    ].forEach(([id, key, kind]) => {
      const element = document.getElementById(id);
      element.addEventListener(kind === 'checkbox' ? 'change' : 'input', (event) => {
        const target = event.target;
        state.config.serviceProfiles.gatewayChatPlatform[key] = kind === 'checkbox' ? target.checked : target.value;
        renderSecrets();
        syncRawJson();
      });
    });
    [
      ['gatewayChatRedisUrl', 'REDIS_URL', 'Redis backing store for scheduled chat inbox messages'],
      ['gatewayChatDefaultUserId', 'CHAT_DEFAULT_USER_ID', 'Default user scope for scheduled chat inbox messages'],
      ['gatewayChatDefaultChannelId', 'CHAT_DEFAULT_CHANNEL_ID', 'Default inbox channel for scheduled chat inbox messages'],
    ].forEach(([id, key, description]) => {
      const element = document.getElementById(id);
      element.addEventListener('input', (event) => {
        upsertEnvironmentEntry(
          state.config.serviceProfiles.gatewayChatPlatform.environment,
          key,
          event.target.value.trim(),
          description,
          false
        );
        renderSecrets();
        syncRawJson();
      });
    });
    [
      ['gatewayChatTtsEnabled', 'enabled', 'checkbox'],
      ['gatewayChatTtsBaseUrl', 'baseUrl'],
      ['gatewayChatTtsDefaultVoice', 'defaultVoice'],
      ['gatewayChatTtsGeneratePath', 'generatePath'],
      ['gatewayChatTtsStreamPath', 'streamPath'],
      ['gatewayChatTtsVoicesPath', 'voicesPath'],
      ['gatewayChatTtsHealthPath', 'healthPath'],
    ].forEach(([id, key, kind]) => {
      const element = document.getElementById(id);
      element.addEventListener(kind === 'checkbox' ? 'change' : 'input', (event) => {
        const target = event.target;
        state.config.serviceProfiles.gatewayChatPlatform.tts[key] = kind === 'checkbox' ? target.checked : target.value;
        syncRawJson();
      });
    });
    [
      ['piProxyEnabled', 'enabled', 'checkbox'],
      ['piProxyNodeId', 'nodeId'],
      ['piProxyDescription', 'description'],
      ['piProxyInstallRoot', 'installRoot'],
      ['piProxySystemdUnitName', 'systemdUnitName'],
      ['piProxyRegistryBaseUrl', 'registryBaseUrl'],
      ['piProxyListenHost', 'listenHost'],
      ['piProxyListenPort', 'listenPort', 'number'],
      ['piProxyServiceUser', 'serviceUser'],
      ['piProxyServiceGroup', 'serviceGroup'],
      ['piProxyRegistryPath', 'registryPath'],
      ['piProxyPollIntervalSeconds', 'pollIntervalSeconds', 'number'],
    ].forEach(([id, key, kind]) => {
      const element = document.getElementById(id);
      const eventName = kind === 'checkbox' || element.tagName === 'SELECT' ? 'change' : 'input';
      element.addEventListener(eventName, (event) => {
        const target = event.target;
        if (kind === 'checkbox') {
          state.config.serviceProfiles.piProxy[key] = target.checked;
        } else if (kind === 'number') {
          state.config.serviceProfiles.piProxy[key] = Number(target.value);
        } else if (key === 'registryPath') {
          state.config.serviceProfiles.piProxy[key] = target.value.startsWith('/') ? target.value : '/' + target.value;
        } else if ((key === 'serviceUser' || key === 'serviceGroup') && !target.value.trim()) {
          delete state.config.serviceProfiles.piProxy[key];
        } else {
          state.config.serviceProfiles.piProxy[key] = target.value;
        }
        renderPiProxyProfile();
        syncRawJson();
      });
    });

    document.getElementById('refreshPiProxyStatusButton').addEventListener('click', async () => {
      const button = document.getElementById('refreshPiProxyStatusButton');
      const actionOutput = document.getElementById('piProxyActionOutput');
      await withBusyButton(button, 'Checking…', async () => {
        try {
          setLocalActionOutput(actionOutput, 'Checking Pi proxy service status…', 'progress');
          const status = await fetchPiProxyStatus();
          setLocalActionOutput(actionOutput, status?.summary || 'Loaded Pi proxy status.', 'ok');
        } catch (error) {
          setLocalActionOutput(actionOutput, error.message, 'error');
        }
      });
    });

    document.getElementById('deployPiProxyButton').addEventListener('click', async () => {
      const button = document.getElementById('deployPiProxyButton');
      const actionOutput = document.getElementById('piProxyActionOutput');
      await withBusyButton(button, 'Deploying…', async () => {
        try {
          setLocalActionOutput(actionOutput, 'Saving config and deploying the managed Pi proxy…', 'progress');
          await persistConfigState();
          const result = await requestJson('POST', '/api/service-profiles/pi-proxy/deploy');
          await Promise.all([fetchPiProxyStatus({ silent: true }), fetchPiProxyRegistry({ silent: true })]);
          renderPiProxyProfile();
          setLocalActionOutput(actionOutput, result.message || 'Pi proxy deployed.', 'ok');
          setStatus(result.message || 'Pi proxy deployed');
        } catch (error) {
          setLocalActionOutput(actionOutput, error.message, 'error');
          setStatus(error.message, 'error');
        }
      });
    });

    document.getElementById('restartPiProxyButton').addEventListener('click', async () => {
      const button = document.getElementById('restartPiProxyButton');
      const actionOutput = document.getElementById('piProxyActionOutput');
      await withBusyButton(button, 'Restarting…', async () => {
        try {
          setLocalActionOutput(actionOutput, 'Restarting Pi proxy service…', 'progress');
          const result = await requestJson('POST', '/api/service-profiles/pi-proxy/restart');
          await fetchPiProxyStatus({ silent: true });
          renderPiProxyProfile();
          setLocalActionOutput(actionOutput, result.message || 'Pi proxy restarted.', 'ok');
          setStatus(result.message || 'Pi proxy restarted');
        } catch (error) {
          setLocalActionOutput(actionOutput, error.message, 'error');
          setStatus(error.message, 'error');
        }
      });
    });

    document.getElementById('refreshPiProxyRegistryButton').addEventListener('click', async () => {
      const button = document.getElementById('refreshPiProxyRegistryButton');
      const actionOutput = document.getElementById('piProxyActionOutput');
      await withBusyButton(button, 'Refreshing…', async () => {
        try {
          setLocalActionOutput(actionOutput, 'Refreshing Bedrock registry for the Pi proxy…', 'progress');
          const payload = await fetchPiProxyRegistry();
          const serverCount = Array.isArray(payload?.servers) ? payload.servers.length : 0;
          setLocalActionOutput(actionOutput, 'Loaded Pi proxy registry with ' + serverCount + ' world(s).', 'ok');
        } catch (error) {
          setLocalActionOutput(actionOutput, error.message, 'error');
        }
      });
    });

    document.getElementById('saveButton').addEventListener('click', async () => {
      const button = document.getElementById('saveButton');
      await withBusyButton(button, 'Saving…', async () => {
        try {
          const result = await requestJson('POST', '/api/build', state.config);
          state.config = result.config;
          render();
          await loadTabData(state.activeTab, { silent: true });
          setStatus(result.message || 'Saved');
        } catch (error) {
          setStatus(error.message, 'error');
        }
      });
    });

    document.getElementById('refreshButton').addEventListener('click', async () => {
      const button = document.getElementById('refreshButton');
      await withBusyButton(button, 'Refreshing…', async () => {
        try {
          await fetchConfig();
          await loadTabData(state.activeTab, { silent: true });
          setStatus('Current', 'ok', { log: false });
        } catch (error) {
          setStatus(error.message, 'error');
        }
      });
    });
    document.getElementById('refreshRuntimeButtonSecondary').addEventListener('click', async () => {
      const button = document.getElementById('refreshRuntimeButtonSecondary');
      await withBusyButton(button, 'Refreshing…', async () => {
        try {
          await fetchRuntime();
          setStatus('Runtime refreshed');
        } catch (error) {
          setStatus(error.message, 'error');
        }
      });
    });
    document.getElementById('reloadWorkflowsButton').addEventListener('click', async () => {
      try {
        await fetchWorkflows();
        setStatus('Workflows reloaded');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
    document.getElementById('reloadJobsButton').addEventListener('click', async () => {
      try {
        await fetchJobsCatalog();
        setStatus('Job catalog reloaded');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });

    document.getElementById('applyRawButton').addEventListener('click', () => {
      try {
        state.config = JSON.parse(document.getElementById('rawJson').value);
        render();
        setStatus('Raw JSON applied');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });

    document.getElementById('addAppButton').addEventListener('click', () => {
      state.config.apps.push({
        id: '',
        enabled: true,
        repoUrl: '',
        defaultRevision: 'main',
        deployRoot: '',
        hostnames: [],
        routePath: '/',
        healthPath: '/health',
        upstreamConfPath: '',
        buildCommands: [],
        slots: {
          blue: { port: 3001, startCommand: '', stopCommand: '' },
          green: { port: 3002, startCommand: '', stopCommand: '' }
        }
      });
      render();
    });

    document.getElementById('addJobButton').addEventListener('click', () => {
      state.config.scheduledJobs.push({
        id: '',
        appId: state.config.apps[0]?.id || '',
        enabled: true,
        description: '',
        schedule: '*:0/15',
        workingDirectory: '__CURRENT__',
        execStart: '',
        user: 'deploy'
      });
      render();
    });

    document.getElementById('addFeatureButton').addEventListener('click', () => {
      state.config.features.push({
        id: '',
        enabled: true,
        description: ''
      });
      render();
    });
    document.getElementById('addWorkerNodeButton').addEventListener('click', () => {
      appendWorkerNode(createWorkerNodePreset('general'));
    });

    // ─── Node Setup Wizard ────────────────────────────────────────────
    (function initNodeSetupWizard() {
      const dialog = document.getElementById('nodeSetupWizard');
      const presetStep = document.getElementById('wizardStepPreset');
      const formStep = document.getElementById('wizardStepForm');
      const progressStep = document.getElementById('wizardStepProgress');
      const progressLog = document.getElementById('wizProgressLog');
      const actionsRow = document.getElementById('wizardStepActions');
      const addToConfigBtn = document.getElementById('wizAddToConfigButton');
      const closeFinishedBtn = document.getElementById('wizCloseFinishedButton');

      const fields = {
        nodeId: document.getElementById('wizNodeId'),
        host: document.getElementById('wizHost'),
        sshPort: document.getElementById('wizSshPort'),
        adminUser: document.getElementById('wizAdminUser'),
        adminPassword: document.getElementById('wizAdminPassword'),
        description: document.getElementById('wizDescription'),
        buildRoot: document.getElementById('wizBuildRoot'),
        stackRoot: document.getElementById('wizStackRoot'),
        volumeRoot: document.getElementById('wizVolumeRoot'),
        pollInterval: document.getElementById('wizPollInterval')
      };

      const presetCards = document.querySelectorAll('.wizard-preset-card');
      const presetNextBtn = document.getElementById('wizPresetNextButton');

      const presets = {
        general: {
          buildRoot: '/srv/builds',
          stackRoot: '/srv/stacks',
          volumeRoot: '/srv/volumes',
          description: 'Standard Docker worker node',
          pollInterval: 15
        },
        gpu: {
          buildRoot: '/data/docker/builds',
          stackRoot: '/data/docker/stacks',
          volumeRoot: '/data/docker/volumes',
          description: 'Docker + NVIDIA GPU worker for LLM/STT/CV APIs',
          pollInterval: 15
        },
        pi: {
          buildRoot: '/opt/builds',
          stackRoot: '/opt/stacks',
          volumeRoot: '/opt/volumes',
          description: 'Raspberry Pi edge node',
          pollInterval: 30
        },
        custom: {
          buildRoot: '',
          stackRoot: '',
          volumeRoot: '',
          description: '',
          pollInterval: 15
        }
      };

      let selectedPreset = null;
      let pendingNodeConfig = null;

      presetCards.forEach(card => {
        card.addEventListener('click', () => {
          presetCards.forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
          selectedPreset = card.dataset.preset;
          presetNextBtn.disabled = false;
        });
      });

      function applyPreset(presetName) {
        const preset = presets[presetName] || presets.custom;
        fields.buildRoot.value = preset.buildRoot;
        fields.stackRoot.value = preset.stackRoot;
        fields.volumeRoot.value = preset.volumeRoot;
        fields.description.value = preset.description;
        fields.pollInterval.value = preset.pollInterval;
      }

      function showStep(step) {
        presetStep.hidden = step !== 'preset';
        formStep.hidden = step !== 'form';
        progressStep.hidden = step !== 'progress';
        actionsRow.hidden = true;
        addToConfigBtn.hidden = true;
        closeFinishedBtn.hidden = true;
      }

      function openWizard() {
        selectedPreset = null;
        presetCards.forEach(c => c.classList.remove('selected'));
        presetNextBtn.disabled = true;
        progressLog.innerHTML = '';
        pendingNodeConfig = null;
        showStep('preset');
        dialog.showModal();
      }

      function closeWizard() {
        dialog.close();
      }

      const statusIcons = {
        running: '&#9679;',
        ok: '&#10003;',
        warn: '&#9888;',
        error: '&#10007;',
        complete: '&#10003;'
      };

      function appendLogEntry(data) {
        const entry = document.createElement('div');
        entry.className = 'wizard-log-entry wiz-' + (data.status || 'running');
        const icon = document.createElement('span');
        icon.className = 'wizard-log-icon';
        icon.innerHTML = statusIcons[data.status] || statusIcons.running;
        const msg = document.createElement('span');
        msg.textContent = data.message || '';
        entry.appendChild(icon);
        entry.appendChild(msg);
        progressLog.appendChild(entry);
        progressLog.scrollTop = progressLog.scrollHeight;
      }

      async function startSetup() {
        const nodeId = fields.nodeId.value.trim();
        const host = fields.host.value.trim();
        const adminUser = fields.adminUser.value.trim();
        if (!nodeId || !host || !adminUser) {
          setStatus('Node ID, Host, and Admin User are required', 'error');
          return;
        }

        formStep.hidden = true;
        showStep('progress');
        progressLog.innerHTML = '';

        const payload = {
          nodeId: nodeId,
          host: host,
          sshPort: Number(fields.sshPort.value) || 22,
          adminUser: adminUser,
          adminPassword: fields.adminPassword.value || '',
          nodeType: selectedPreset || 'general',
          description: fields.description.value.trim(),
          buildRoot: fields.buildRoot.value.trim(),
          stackRoot: fields.stackRoot.value.trim(),
          volumeRoot: fields.volumeRoot.value.trim(),
          workerPollIntervalSeconds: Number(fields.pollInterval.value) || 15
        };

        setStatus('Setting up node ' + nodeId + '...', 'progress');
        pushActionFeed('Node setup started for ' + nodeId, 'progress');

        try {
          const response = await fetch(joinBase('/api/nodes/setup'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  appendLogEntry(data);
                  if (data.status === 'complete' && data.nodeConfig) {
                    pendingNodeConfig = data.nodeConfig;
                  }
                  if (data.status === 'error') {
                    pushActionFeed('Node setup failed: ' + data.message, 'error');
                  }
                } catch (e) {
                  // skip malformed events
                }
              }
            }
          }
        } catch (err) {
          appendLogEntry({ status: 'error', message: 'Connection error: ' + err.message });
          pushActionFeed('Node setup connection error', 'error');
        }

        actionsRow.hidden = false;
        closeFinishedBtn.hidden = false;
        if (pendingNodeConfig) {
          addToConfigBtn.hidden = false;
          setStatus('Node ' + nodeId + ' setup complete', 'ok');
          pushActionFeed('Node ' + nodeId + ' setup complete');
        } else {
          // Collect errors from the wizard log and surface them in the action feed
          const errorEntries = progressLog.querySelectorAll('.wiz-error');
          const errorMessages = [];
          errorEntries.forEach(entry => {
            const text = entry.textContent.replace(/^[^\s]\s*/, '').trim();
            if (text) errorMessages.push(text);
          });
          if (errorMessages.length > 0) {
            errorMessages.forEach(msg => pushActionFeed('Node setup: ' + msg, 'error'));
            setStatus('Node setup failed — ' + errorMessages.length + ' error(s) shown in activity feed below', 'error');
          } else {
            pushActionFeed('Node setup failed — no node config was returned', 'error');
            setStatus('Node setup had issues — see activity feed below', 'error');
          }
        }
      }

      document.getElementById('openNodeSetupWizardButton').addEventListener('click', openWizard);
      document.getElementById('closeNodeSetupWizardButton').addEventListener('click', closeWizard);
      document.getElementById('wizPresetCancelButton').addEventListener('click', closeWizard);
      document.getElementById('wizPresetNextButton').addEventListener('click', () => {
        if (!selectedPreset) return;
        applyPreset(selectedPreset);
        showStep('form');
      });
      document.getElementById('wizFormBackButton').addEventListener('click', () => {
        showStep('preset');
      });
      document.getElementById('wizStartSetupButton').addEventListener('click', startSetup);
      document.getElementById('wizCloseFinishedButton').addEventListener('click', closeWizard);
      document.getElementById('wizAddToConfigButton').addEventListener('click', () => {
        if (!pendingNodeConfig) return;
        const existing = state.config.workerNodes.findIndex(n => n.id === pendingNodeConfig.id);
        if (existing >= 0) {
          state.config.workerNodes[existing] = pendingNodeConfig;
        } else {
          state.config.workerNodes.push(pendingNodeConfig);
        }
        normalizeRemoteWorkloadNodeIds();
        renderWorkerNodes();
        renderRemoteWorkloads();
        renderBedrockServers();
        renderPiProxyProfile();
        syncRawJson();
        closeWizard();
        setStatus('Saving node ' + pendingNodeConfig.id + '…');
        persistConfigState().then(() => {
          setStatus('Node ' + pendingNodeConfig.id + ' saved', 'ok');
          pushActionFeed('Node ' + pendingNodeConfig.id + ' added and saved');
        }).catch(() => {
          setStatus('Node added to config but save failed — click Save to retry', 'error');
        });
      });

      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) closeWizard();
      });
    })();
    // ─── End Node Setup Wizard ────────────────────────────────────────

    document.getElementById('addRemoteWorkloadButton').addEventListener('click', () => {
      state.config.remoteWorkloads.push(createDefaultRemoteJobWorkload());
      renderRemoteWorkloads();
      renderBedrockServers();
      syncRawJson();
    });
    document.getElementById('addContainerServiceWorkloadButton').addEventListener('click', () => {
      state.config.remoteWorkloads.push(createDefaultContainerServiceWorkload());
      renderRemoteWorkloads();
      renderBedrockServers();
      syncRawJson();
    });
    // ─── Service Deploy Wizard ──────────────────────────────────────
    (function initServiceDeployWizard() {
      const dialog = document.getElementById('serviceDeployWizard');
      let selectedSvc = '';
      let createdWorkloadId = '';

      function openSvcWizard() {
        if (!firstWorkerNodeId()) {
          state.activeTab = 'infra';
          render();
          switchSubTab('infra', 'infra-nodes');
          setStatus('Add a worker node first in Nodes, then come back here to deploy a service.', 'error');
          return;
        }
        selectedSvc = '';
        createdWorkloadId = '';
        document.getElementById('svcCatalogNextBtn').disabled = true;
        dialog.querySelectorAll('.svc-catalog-card').forEach(c => c.classList.remove('selected'));
        showSvcStep('catalog');
        dialog.showModal();
      }

      function closeSvcWizard() {
        dialog.close();
      }

      function showSvcStep(step) {
        document.getElementById('svcStepCatalog').hidden = step !== 'catalog';
        document.getElementById('svcStepConfig').hidden = step !== 'config';
        document.getElementById('svcStepDeploy').hidden = step !== 'deploy';
      }

      // ── Catalog step ──
      dialog.querySelectorAll('.svc-catalog-card').forEach(card => {
        card.addEventListener('click', () => {
          dialog.querySelectorAll('.svc-catalog-card').forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
          selectedSvc = card.dataset.svc;
          document.getElementById('svcCatalogNextBtn').disabled = false;
        });
      });

      // ── Config step – builds form dynamically based on selection ──
      function buildConfigForm() {
        const container = document.getElementById('svcConfigFields');
        container.innerHTML = '';

        const nodes = state.config.workerNodes;
        const defaultNode = firstWorkerNodeId();

        if (selectedSvc === 'stt-service') {
          document.getElementById('svcConfigDesc').textContent = 'Configure Speech-to-Text service for your GPU node.';
          container.innerHTML = \`
            <label class="wizard-field">
              <span class="wizard-label">Target Node</span>
              <select id="svcFieldNode">\${nodes.map(n => '<option value="' + n.id + '"' + (n.id === defaultNode ? ' selected' : '') + '>' + n.id + ' (' + n.host + ')' + '</option>').join('')}</select>
              <span class="wizard-hint">The worker node where this service will be deployed.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Workload ID</span>
              <input id="svcFieldId" type="text" value="stt-service" />
              <span class="wizard-hint">Unique identifier for this workload. Keep it short and lowercase.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Git Repo URL</span>
              <input id="svcFieldRepo" type="text" value="https://github.com/goblinsan/stt-service.git" />
              <span class="wizard-hint">The repo will be cloned and built on the node. Uses docker-compose to bring up the stack.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Published Port</span>
              <input id="svcFieldPort" type="number" value="5101" />
              <span class="wizard-hint">Exposed port for the STT API + UI (nginx entry point).</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Data Directory</span>
              <input id="svcFieldDataDir" type="text" value="/data/stt-service" />
              <span class="wizard-hint">Host path for persistent data (model cache, uploaded files).</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Whisper Model Size</span>
              <select id="svcFieldModel">
                <option value="tiny">tiny – fastest, lowest accuracy</option>
                <option value="base">base – fast, decent accuracy</option>
                <option value="small">small – good balance</option>
                <option value="medium" selected>medium – recommended for RTX 4060</option>
                <option value="large-v3">large-v3 – best accuracy, needs 6+ GB VRAM</option>
              </select>
              <span class="wizard-hint">Larger models are more accurate but use more GPU memory.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Description</span>
              <input id="svcFieldDesc" type="text" value="Speech-to-Text transcription API + web UI" />
            </label>
          \`;
        } else if (selectedSvc === 'container-service') {
          document.getElementById('svcConfigDesc').textContent = 'Configure a custom container service.';
          container.innerHTML = \`
            <label class="wizard-field">
              <span class="wizard-label">Target Node</span>
              <select id="svcFieldNode">\${nodes.map(n => '<option value="' + n.id + '"' + (n.id === defaultNode ? ' selected' : '') + '>' + n.id + ' (' + n.host + ')' + '</option>').join('')}</select>
              <span class="wizard-hint">The worker node where this service will run.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Workload ID</span>
              <input id="svcFieldId" type="text" value="" placeholder="my-service" />
              <span class="wizard-hint">Unique name for this workload (lowercase, hyphens ok).</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Docker Image</span>
              <input id="svcFieldImage" type="text" value="" placeholder="nginx:latest" />
              <span class="wizard-hint">The Docker image to pull and run.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Published Port</span>
              <input id="svcFieldPort" type="number" value="8080" />
              <span class="wizard-hint">Host port to expose.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Container Port</span>
              <input id="svcFieldTargetPort" type="number" value="80" />
              <span class="wizard-hint">Port inside the container to forward to.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">GPU Required</span>
              <select id="svcFieldGpu">
                <option value="no" selected>No</option>
                <option value="yes">Yes (NVIDIA runtime)</option>
              </select>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Description</span>
              <input id="svcFieldDesc" type="text" value="" placeholder="Describe the service" />
            </label>
          \`;
        } else if (selectedSvc === 'container-job') {
          document.getElementById('svcConfigDesc').textContent = 'Configure a scheduled container job.';
          container.innerHTML = \`
            <label class="wizard-field">
              <span class="wizard-label">Target Node</span>
              <select id="svcFieldNode">\${nodes.map(n => '<option value="' + n.id + '"' + (n.id === defaultNode ? ' selected' : '') + '>' + n.id + ' (' + n.host + ')' + '</option>').join('')}</select>
              <span class="wizard-hint">The worker node where this job will execute.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Workload ID</span>
              <input id="svcFieldId" type="text" value="" placeholder="my-job" />
              <span class="wizard-hint">Unique name for this workload.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Docker Image</span>
              <input id="svcFieldImage" type="text" value="" placeholder="alpine:latest" />
              <span class="wizard-hint">The Docker image used for each run.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Command</span>
              <input id="svcFieldCommand" type="text" value="" placeholder="echo hello" />
              <span class="wizard-hint">Command to execute inside the container.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Schedule (cron)</span>
              <input id="svcFieldCron" type="text" value="0 * * * *" />
              <span class="wizard-hint">Cron expression for how often to run (default: every hour).</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Description</span>
              <input id="svcFieldDesc" type="text" value="" placeholder="Describe the job" />
            </label>
          \`;
        }
      }

      // ── Save & Deploy – constructs the workload config and triggers deploy ──
      async function saveAndDeploy() {
        const nodeId = document.getElementById('svcFieldNode').value;
        const workloadId = (document.getElementById('svcFieldId').value || '').trim();
        const desc = (document.getElementById('svcFieldDesc') || {}).value || '';

        if (!workloadId) {
          setStatus('Workload ID is required', 'error');
          return;
        }
        if (state.config.remoteWorkloads.some(w => w.id === workloadId)) {
          setStatus('A workload with ID "' + workloadId + '" already exists', 'error');
          return;
        }

        let workload;

        if (selectedSvc === 'stt-service') {
          const port = parseInt(document.getElementById('svcFieldPort').value, 10) || 5101;
          const dataDir = document.getElementById('svcFieldDataDir').value || '/data/stt-service';
          const model = document.getElementById('svcFieldModel').value || 'medium';
          const repo = document.getElementById('svcFieldRepo').value || '';

          workload = {
            id: workloadId,
            enabled: true,
            nodeId: nodeId,
            description: desc,
            kind: 'container-service',
            service: {
              build: {
                strategy: 'repo-compose',
                repoUrl: repo,
                defaultRevision: 'main',
                contextPath: '.',
              },
              networkMode: 'bridge',
              restartPolicy: 'unless-stopped',
              autoStart: true,
              runtimeClass: 'nvidia',
              command: '',
              environment: [
                { key: 'STT_MODEL_SIZE', value: model, secret: false, description: 'faster-whisper model size' },
                { key: 'HOST_PORT', value: String(port), secret: false, description: 'Published port for nginx entry point' },
                { key: 'STT_MODEL_DIR', value: dataDir + '/models', secret: false, description: 'Host path for cached whisper models' }
              ],
              volumeMounts: [],
              jsonFiles: [],
              ports: [
                { published: port, target: 80, protocol: 'tcp' }
              ],
              healthCheck: {
                protocol: 'http',
                port: port,
                path: '/api/health',
                expectedStatus: 200
              }
            }
          };
        } else if (selectedSvc === 'container-service') {
          const port = parseInt(document.getElementById('svcFieldPort').value, 10) || 8080;
          const targetPort = parseInt(document.getElementById('svcFieldTargetPort').value, 10) || 80;
          const image = document.getElementById('svcFieldImage').value || '';
          const gpu = document.getElementById('svcFieldGpu').value === 'yes';

          if (!image) {
            setStatus('Docker image is required', 'error');
            return;
          }

          workload = {
            id: workloadId,
            enabled: true,
            nodeId: nodeId,
            description: desc,
            kind: 'container-service',
            service: {
              image: image,
              networkMode: 'bridge',
              restartPolicy: 'unless-stopped',
              autoStart: true,
              runtimeClass: gpu ? 'nvidia' : 'default',
              command: '',
              environment: [],
              volumeMounts: [],
              jsonFiles: [],
              ports: [
                { published: port, target: targetPort, protocol: 'tcp' }
              ],
              healthCheck: null
            }
          };
        } else if (selectedSvc === 'container-job') {
          const image = document.getElementById('svcFieldImage').value || '';
          const command = document.getElementById('svcFieldCommand').value || '';
          const cron = document.getElementById('svcFieldCron').value || '0 * * * *';

          workload = {
            id: workloadId,
            enabled: true,
            nodeId: nodeId,
            description: desc,
            kind: 'scheduled-container-job',
            job: {
              schedule: cron,
              timezone: 'America/New_York',
              build: {
                strategy: 'generated-node',
                repoUrl: '',
                defaultRevision: 'main',
                contextPath: '.',
                packageRoot: '.',
                nodeVersion: '24',
                installCommand: 'npm ci --omit=dev'
              },
              runCommand: command,
              environment: [],
              volumeMounts: [],
              jsonFiles: []
            }
          };
        }

        if (!workload) return;

        // show deploy step
        showSvcStep('deploy');
        const log = document.getElementById('svcDeployLog');
        const actions = document.getElementById('svcDeployActions');
        log.innerHTML = '';
        actions.hidden = true;
        createdWorkloadId = workloadId;

        function appendLog(text, cls) {
          const line = document.createElement('div');
          line.className = 'wizard-log-line' + (cls ? ' ' + cls : '');
          line.textContent = text;
          log.appendChild(line);
          log.scrollTop = log.scrollHeight;
        }

        appendLog('Adding workload to config…');
        state.config.remoteWorkloads.push(workload);
        renderRemoteWorkloads();
        renderBedrockServers();
        syncRawJson();

        try {
          appendLog('Saving configuration…');
          await persistConfigState();
          appendLog('Configuration saved ✓', 'success');

          appendLog('Starting deploy of ' + workloadId + '…');
          const result = await requestJson('POST', '/api/remote-workloads/' + encodeURIComponent(workloadId) + '/deploy', {});
          appendLog(result.message || 'Deploy completed ✓', 'success');
          appendLog('');
          appendLog('Service deployed successfully!', 'success');
          pushActionFeed('Deployed service ' + workloadId);
        } catch (err) {
          appendLog('Deploy failed: ' + (err.message || err), 'error');
          appendLog('');
          appendLog('The workload config has been saved. You can retry the deploy from the workload card.', 'info');
        }

        actions.hidden = false;
      }

      // ── Wire events ──
      document.getElementById('openServiceDeployWizardButton').addEventListener('click', openSvcWizard);
      document.getElementById('openServiceDeployWizardButtonSvc').addEventListener('click', openSvcWizard);
      document.getElementById('closeSvcWizardButton').addEventListener('click', closeSvcWizard);
      document.getElementById('svcCatalogCancelBtn').addEventListener('click', closeSvcWizard);
      document.getElementById('svcCatalogNextBtn').addEventListener('click', () => {
        if (!selectedSvc) return;
        buildConfigForm();
        showSvcStep('config');
      });
      document.getElementById('svcConfigBackBtn').addEventListener('click', () => showSvcStep('catalog'));
      document.getElementById('svcConfigDeployBtn').addEventListener('click', saveAndDeploy);
      document.getElementById('svcDeployCloseBtn').addEventListener('click', () => {
        closeSvcWizard();
        if (createdWorkloadId) {
          refreshContainerServiceStatus(createdWorkloadId).catch(() => {});
        }
      });
      dialog.addEventListener('cancel', closeSvcWizard);
    })();
    // ─── End Service Deploy Wizard ────────────────────────────────────

    const addBedrockServerWorkload = () => {
      if (!firstWorkerNodeId()) {
        state.activeTab = 'infra';
        render();
        switchSubTab('infra', 'infra-nodes');
        setStatus('Add a worker node first. Set a Node Id and host in Nodes, then come back to Minecraft.', 'error');
        return;
      }
      state.config.remoteWorkloads.push(createDefaultBedrockWorkload());
      renderRemoteWorkloads();
      renderBedrockServers();
      syncRawJson();
    };
    document.getElementById('addBedrockWorkloadButton').addEventListener('click', addBedrockServerWorkload);
    document.getElementById('addBedrockServerButton').addEventListener('click', addBedrockServerWorkload);
    document.getElementById('addGatewayApiEnvButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayApi.environment.push({
        key: '',
        value: '',
        secret: false
      });
      renderGatewayApiProfile();
      renderSecrets();
      syncRawJson();
    });
    document.getElementById('addGatewayApiChannelButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayApi.jobRuntime.channels.push({
        id: '',
        type: 'telegram',
        enabled: true
      });
      renderGatewayApiJobRuntimeProfile();
      renderSecrets();
      syncRawJson();
    });
    document.getElementById('addKulrsBotButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayApi.kulrsActivity.bots.push({
        id: '',
        email: '',
        password: ''
      });
      renderKulrsActivityProfile();
      renderSecrets();
      syncRawJson();
    });
    document.getElementById('addGatewayChatEnvButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayChatPlatform.environment.push({
        key: '',
        value: '',
        secret: false
      });
      renderGatewayChatPlatformProfile();
      renderSecrets();
      syncRawJson();
    });
    document.getElementById('addGatewayApiSecretButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayApi.environment.push({
        key: '',
        value: '',
        secret: true
      });
      renderGatewayApiProfile();
      renderSecrets();
      syncRawJson();
    });
    document.getElementById('addGatewayApiSecretChannelButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayApi.jobRuntime.channels.push({
        id: '',
        type: 'telegram',
        enabled: true
      });
      renderGatewayApiJobRuntimeProfile();
      renderSecrets();
      syncRawJson();
    });
    document.getElementById('addKulrsSecretBotButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayApi.kulrsActivity.bots.push({
        id: '',
        email: '',
        password: ''
      });
      renderKulrsActivityProfile();
      renderSecrets();
      syncRawJson();
    });
    document.getElementById('addGatewayChatSecretButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayChatPlatform.environment.push({
        key: '',
        value: '',
        secret: true
      });
      renderGatewayChatPlatformProfile();
      renderSecrets();
      syncRawJson();
    });
    ['kulrsFirebaseApiKeySecrets', 'kulrsUnsplashAccessKeySecrets'].forEach((id) => {
      document.getElementById(id).addEventListener('input', (event) => {
        const target = event.target;
        const key = id === 'kulrsFirebaseApiKeySecrets' ? 'firebaseApiKey' : 'unsplashAccessKey';
        state.config.serviceProfiles.gatewayApi.kulrsActivity[key] = target.value;
        renderKulrsActivityProfile();
        renderSecrets();
        syncRawJson();
      });
    });
    document.getElementById('addGatewayChatAgentButton').addEventListener('click', () => {
      state.activeTab = 'agents';
      const providerName = firstAvailableProviderName();
      state.config.serviceProfiles.gatewayChatPlatform.agents.push({
        id: '',
        name: '',
        icon: '🤖',
        color: '#6366f1',
        providerName,
        model: firstAvailableModelId(providerName),
        costClass: 'free',
        enabled: true,
        featureFlags: {},
        contextSources: []
      });
      renderGatewayChatPlatformProfile();
      renderActiveTab();
      syncRawJson();
    });
    document.getElementById('addWorkflowButton').addEventListener('click', () => {
      state.workflows.unshift(createWorkflowDraft());
      renderWorkflows();
    });
    document.getElementById('workflowSeedPath').addEventListener('input', (event) => {
      state.agentRun.workflowSeedPath = event.target.value;
    });
    document.getElementById('agentRunAgentId').addEventListener('input', (event) => {
      state.agentRun.agentId = event.target.value;
    });
    document.getElementById('agentRunPrompt').addEventListener('input', (event) => {
      state.agentRun.prompt = event.target.value;
    });
    document.getElementById('agentRunContext').addEventListener('input', (event) => {
      state.agentRun.contextJson = event.target.value;
    });
    document.getElementById('agentRunDelivery').addEventListener('input', (event) => {
      state.agentRun.deliveryJson = event.target.value;
    });
    document.getElementById('syncGatewayChatAgentsButton').addEventListener('click', async () => {
      try {
        await syncConfiguredAgents();
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
    document.getElementById('syncGatewayChatAgentsButtonSecondary').addEventListener('click', async () => {
      try {
        await syncConfiguredAgents();
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
    document.getElementById('checkTtsButton').addEventListener('click', async () => {
      try {
        state.ttsStatus = await requestJson('GET', '/api/tts/status');
        await fetchTtsVoices();
        renderGatewayChatPlatformProfile();
        setStatus('TTS status refreshed');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
    document.getElementById('reloadTtsVoicesButton').addEventListener('click', async () => {
      try {
        await fetchTtsVoices();
        setStatus('TTS voices reloaded');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
    document.getElementById('createTtsVoiceButton').addEventListener('click', async () => {
      try {
        const fileInput = document.getElementById('ttsCreateVoiceFile');
        const file = fileInput.files && fileInput.files[0];
        if (!file) {
          throw new Error('Choose a reference audio file first');
        }
        const transcript = document.getElementById('ttsCreateVoiceTranscript').value.trim();
        if (!transcript) {
          throw new Error('Provide the spoken transcript for the reference audio');
        }

        const formData = new FormData();
        formData.append('reference_audio', file);
        formData.append('name', document.getElementById('ttsCreateVoiceName').value);
        formData.append('description', document.getElementById('ttsCreateVoiceDescription').value);
        formData.append('source', document.getElementById('ttsCreateVoiceSource').value || 'recorded');
        formData.append('transcript', transcript);

        const response = await fetch(joinBase('/api/tts/voices'), {
          method: 'POST',
          body: formData
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result?.error || 'Failed to create voice');
        }
        document.getElementById('ttsCreateVoiceName').value = '';
        document.getElementById('ttsCreateVoiceDescription').value = '';
        document.getElementById('ttsCreateVoiceSource').value = 'recorded';
        document.getElementById('ttsCreateVoiceTranscript').value = '';
        fileInput.value = '';
        await fetchTtsVoices();
        setStatus(result.message || 'Voice created');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
    document.getElementById('importWorkflowSeedButton').addEventListener('click', async () => {
      try {
        const result = await requestJson('POST', '/api/workflow-seeds/import', {
          filePath: state.agentRun.workflowSeedPath
        });
        await fetchWorkflows();
        setStatus(result.message || 'Workflow seed imported');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
    document.getElementById('runAgentButton').addEventListener('click', async () => {
      try {
        if (!state.agentRun.agentId) {
          throw new Error('Choose an agent first');
        }
        const context = parseOptionalJsonText(state.agentRun.contextJson);
        const delivery = parseOptionalJsonText(state.agentRun.deliveryJson);
        state.agentRun.result = await requestJson('POST', \`/api/chat-platform/agents/\${encodeURIComponent(state.agentRun.agentId)}/run\`, {
          prompt: state.agentRun.prompt,
          ...(context ? { context } : {}),
          ...(delivery ? { delivery } : {})
        });
        renderAutomation();
        setStatus(\`Agent run completed for \${state.agentRun.agentId}\`);
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });

    document.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!button || button.disabled || button.dataset.tab || button.dataset.openTab) {
        return;
      }
      const label = (button.textContent || '').trim();
      if (!label) {
        return;
      }
      setStatus('Working: ' + label, 'progress', { log: true });
    }, true);

    fetchConfig()
      .then(() => loadTabData(state.activeTab, { silent: true }))
      .catch((error) => setStatus(error.message, 'error'));
    applyActionFeedVisibility();
    setInterval(() => {
      fetchRuntime().catch(() => undefined);
    }, 15000);
    setInterval(() => {
      if (state.activeTab === 'infra') {
        refreshAllRemoteServiceStatuses({ silent: true }).catch(() => undefined);
      }
    }, 30000);
    setInterval(() => {
      if (state.activeTab === 'infra') {
        refreshAllMinecraftStatuses({ silent: true, skipRegistry: true }).catch(() => undefined);
      }
    }, 60000);
  </script>
</body>
</html>`;
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
  const minecraftUpdateScheduler = await loadMinecraftManualUpdateScheduler(options.configPath, options.buildOutDir);
  const server = createServer(async (request, response) => {
    try {
      const path = getRequestPath(request);
      const basePath = getForwardedBasePath(request);
      const workflowIdMatch = path.match(/^\/api\/workflows\/([^/]+)$/);
      const workflowActionMatch = path.match(/^\/api\/workflows\/([^/]+)\/(enable|disable|sleep|resume|run)$/);
      const agentRunMatch = path.match(/^\/api\/chat-platform\/agents\/([^/]+)\/run$/);
      const remoteWorkloadDeployMatch = path.match(/^\/api\/remote-workloads\/([^/]+)\/deploy$/);
      const remoteWorkloadStatusMatch = path.match(/^\/api\/remote-workloads\/([^/]+)\/status$/);
      const remoteServiceStatusMatch = path.match(/^\/api\/remote-workloads\/([^/]+)\/service-status$/);
      const remoteServiceActionMatch = path.match(/^\/api\/remote-workloads\/([^/]+)\/service\/(start|stop|restart)$/);
      const remoteMinecraftActionMatch = path.match(/^\/api\/remote-workloads\/([^/]+)\/minecraft\/(start|stop|restart|broadcast|kick|ban|update-if-empty|force-update)$/);
      const remoteMinecraftUpdateRequestMatch = path.match(/^\/api\/remote-workloads\/([^/]+)\/minecraft\/update-request$/);

      if (request.method === 'GET' && path === '/') {
        sendHtml(response, htmlPage(basePath));
        return;
      }

      if (request.method === 'GET' && path === '/healthz') {
        sendText(response, 200, 'ok\n');
        return;
      }

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

      if (remoteWorkloadDeployMatch && request.method === 'POST') {
        const config = await loadGatewayConfig(options.configPath);
        const body = JSON.parse(await readBody(request) || '{}') as { revision?: string };
        await buildArtifacts(config, options.buildOutDir);
        await deployRemoteWorkload(
          config,
          decodeURIComponent(remoteWorkloadDeployMatch[1]),
          options.buildOutDir,
          typeof body.revision === 'string' && body.revision.trim().length > 0 ? body.revision.trim() : undefined,
          { dryRun: false, log: () => undefined }
        );
        sendJson(response, 200, { message: `Deployed remote workload ${decodeURIComponent(remoteWorkloadDeployMatch[1])}` });
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

      if (request.method === 'POST' && path === '/api/config') {
        const config = await loadRequestConfig(request);
        await saveGatewayConfig(options.configPath, config);
        sendJson(response, 200, { message: `Saved ${options.configPath}`, config });
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

      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host, () => {
      console.log(`Gateway admin UI listening on http://${options.host}:${options.port}`);
      resolve();
    });
  });
}
