import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  getApp,
  getJobsForApp,
  getRemoteWorkload,
  getWorkerNode,
  type AppConfig,
  type GatewayConfig,
  type RemoteWorkloadConfig,
  type ScheduledJobConfig,
  type Slot,
  type WorkerNodeConfig
} from './config.ts';
import { renderActiveUpstream } from './nginx.ts';
import {
  getRemoteWorkloadDataDir,
  getRemoteWorkloadProjectName,
  getRemoteWorkloadSourceDir,
  getRemoteWorkloadStackDir
} from './remote-workloads.ts';
import { getRemoteWorkerProjectName, getRemoteWorkerRuntimeDir } from './remote-worker.ts';
import {
  renderGatewayApiEnv,
  renderGatewayApiJobChannels,
  renderGatewayChatAgents,
  renderGatewayChatPlatformEnv,
  renderKulrsActivityEnv,
  renderKulrsCredentials
} from './service-profiles.ts';
import { renderControlPlaneService, renderJobService, renderJobTimer } from './systemd.ts';

export interface CommandContext {
  dryRun: boolean;
  log: (message: string) => void;
}

export interface AgentRunPayload {
  prompt: string;
  context?: {
    workflowId?: string;
    source?: string;
    metadata?: Record<string, unknown>;
  };
  delivery?: {
    mode?: string;
    channel?: string;
    to?: string;
  };
}

export interface AgentRunResult {
  agentId: string;
  usedProvider: string;
  model: string;
  content: string;
  latencyMs: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

async function runShell(command: string, cwd: string, context: CommandContext): Promise<void> {
  context.log(`$ ${context.dryRun ? '[dry-run] ' : ''}${command}`);
  if (context.dryRun) {
    return;
  }

  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk).trim();
      if (text) { context.log(text); }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk).trim();
      if (text) { context.log(text); }
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed (${code}): ${command}`));
    });
    child.on('error', reject);
  });
}

async function runShellCapture(
  command: string,
  cwd: string,
  extraEnv?: Record<string, string>,
  timeoutMs?: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: extraEnv ? { ...process.env, ...extraEnv } : undefined });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs)
      : null;
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('exit', (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        code: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr: timedOut
          ? `${stderr}${stderr ? '\n' : ''}Command timed out after ${timeoutMs}ms`
          : stderr
      });
    });
    child.on('error', (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });
  });
}

async function runCommandCapture(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const { spawn } = await import('node:child_process');

  return await new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

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

async function resolveCheckoutRevision(slotDir: string, revision: string, context: CommandContext): Promise<string> {
  if (context.dryRun || revision.startsWith('origin/')) {
    return revision;
  }

  const candidates = [`origin/${revision}`, revision];
  for (const candidate of candidates) {
    const result = await runCommandCapture('git', ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], slotDir);
    if (result.code === 0 && result.stdout.trim().length > 0) {
      return candidate;
    }
  }

  return revision;
}

function resolveAppCommandTokens(app: AppConfig, slot: Slot, slotDir: string, command: string): string {
  return command
    .replaceAll('__APP_ID__', app.id)
    .replaceAll('__SLOT__', slot)
    .replaceAll('__SLOT_DIR__', slotDir)
    .replaceAll('__SLOT_PORT__', String(app.slots[slot].port))
    .replaceAll('__DEPLOY_ROOT__', app.deployRoot)
    .replaceAll('__CURRENT__', join(app.deployRoot, 'current'))
    .replaceAll('__SHARED__', join(app.deployRoot, 'shared'))
    .replaceAll('__HEALTH_PATH__', app.healthPath);
}

async function ensureDirectory(path: string, context: CommandContext): Promise<void> {
  context.log(`${context.dryRun ? '[dry-run] ' : ''}mkdir -p ${path}`);
  if (!context.dryRun) {
    await mkdir(path, { recursive: true });
  }
}

async function installSystemdUnit(
  destinationPath: string,
  contents: string,
  context: CommandContext
): Promise<void> {
  context.log(`${context.dryRun ? '[dry-run] ' : ''}install ${destinationPath}`);
  if (context.dryRun) {
    return;
  }

  const tempPath = join('/tmp', `gateway-control-plane-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.unit`);
  await writeFile(tempPath, contents, 'utf8');

  try {
    await runShell(`sudo mkdir -p ${shellQuote(dirname(destinationPath))}`, process.cwd(), context);
    await runShell(`sudo install -m 0644 ${shellQuote(tempPath)} ${shellQuote(destinationPath)}`, process.cwd(), context);
  } finally {
    await rm(tempPath, { force: true });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function sshTarget(node: WorkerNodeConfig): string {
  return `${node.sshUser}@${node.host}`;
}

function baseSshOptions(node: WorkerNodeConfig): string {
  return [
    '-o BatchMode=yes',
    '-o StrictHostKeyChecking=accept-new',
    '-o ConnectTimeout=10',
    `-o UserKnownHostsFile=${shellQuote(`/tmp/gateway-control-plane-known-hosts-${node.id}`)}`
  ].join(' ');
}

function sshOptions(node: WorkerNodeConfig): string {
  return [`-p ${node.sshPort}`, baseSshOptions(node)].join(' ');
}

function scpOptions(node: WorkerNodeConfig): string {
  return [`-P ${node.sshPort}`, baseSshOptions(node)].join(' ');
}

async function runRemoteShell(node: WorkerNodeConfig, command: string, context: CommandContext): Promise<void> {
  await runShell(`ssh ${sshOptions(node)} ${sshTarget(node)} ${shellQuote(command)}`, process.cwd(), context);
}

async function runRemoteShellCapture(
  node: WorkerNodeConfig,
  command: string,
  timeoutMs?: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await runShellCapture(`ssh ${sshOptions(node)} ${sshTarget(node)} ${shellQuote(command)}`, process.cwd(), undefined, timeoutMs);
}

async function copyDirectoryToRemote(node: WorkerNodeConfig, localDir: string, remoteDir: string, context: CommandContext): Promise<void> {
  await runShell(`scp ${scpOptions(node)} -r ${localDir}/. ${sshTarget(node)}:${remoteDir}/`, process.cwd(), context);
}

export async function readCurrentSlot(app: AppConfig): Promise<Slot> {
  const slotFile = join(app.deployRoot, 'current-slot');
  if (!existsSync(slotFile)) {
    return 'blue';
  }

  const slot = (await readFile(slotFile, 'utf8')).trim();
  if (slot !== 'blue' && slot !== 'green') {
    throw new Error(`Invalid current slot value in ${slotFile}: ${slot}`);
  }
  return slot;
}

export function oppositeSlot(slot: Slot): Slot {
  return slot === 'blue' ? 'green' : 'blue';
}

async function checkoutRevision(app: AppConfig, slot: Slot, revision: string, skipFetch: boolean, context: CommandContext): Promise<string> {
  const slotDir = join(app.deployRoot, slot);
  await ensureDirectory(app.deployRoot, context);
  await ensureDirectory(slotDir, context);

  const gitDir = join(slotDir, '.git');
  if (!existsSync(gitDir)) {
    await runShell(`git clone ${app.repoUrl} ${slotDir}`, process.cwd(), context);
  } else if (!skipFetch) {
    await runShell('git fetch --all --tags --prune', slotDir, context);
  }

  const resolvedRevision = await resolveCheckoutRevision(slotDir, revision, context);
  await runShell(`git checkout --force ${resolvedRevision}`, slotDir, context);
  return slotDir;
}

async function buildSlot(app: AppConfig, slot: Slot, slotDir: string, context: CommandContext): Promise<void> {
  for (const command of app.buildCommands) {
    await runShell(resolveAppCommandTokens(app, slot, slotDir, command), slotDir, context);
  }
}

async function setCurrentPointers(app: AppConfig, slot: Slot, context: CommandContext): Promise<void> {
  const currentPath = join(app.deployRoot, 'current');
  const currentSlotPath = join(app.deployRoot, 'current-slot');
  const targetPath = join(app.deployRoot, slot);

  context.log(`${context.dryRun ? '[dry-run] ' : ''}update current pointers for ${app.id} -> ${slot}`);
  if (context.dryRun) {
    return;
  }

  await rm(currentPath, { force: true, recursive: false }).catch(() => undefined);
  await symlink(targetPath, currentPath);
  await writeFile(currentSlotPath, `${slot}\n`, 'utf8');
}

async function writeActiveUpstream(app: AppConfig, slot: Slot, context: CommandContext): Promise<void> {
  const output = renderActiveUpstream(app, slot);
  context.log(`${context.dryRun ? '[dry-run] ' : ''}write ${app.upstreamConfPath}`);
  if (context.dryRun) {
    return;
  }

  await mkdir(dirname(app.upstreamConfPath), { recursive: true });
  await writeFile(app.upstreamConfPath, output, 'utf8');
}

function httpGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const requestImpl = url.startsWith('https://') ? httpsRequest : httpRequest;
    const request = requestImpl(url, { method: 'GET', timeout: 5_000 }, (response) => {
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error(`Timed out: ${url}`)));
    request.end();
  });
}

function httpJsonRequest(url: string, method: 'POST', body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const requestBody = JSON.stringify(body);
    const requestImpl = url.startsWith('https://') ? httpsRequest : httpRequest;
    const chunks: Buffer[] = [];
    const request = requestImpl(
      url,
      {
        method,
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody)
        }
      },
      (response) => {
        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error(`Timed out: ${url}`)));
    request.write(requestBody);
    request.end();
  });
}

type JsonPostRequest = typeof httpJsonRequest;

export async function smokeTest(url: string, expectedStatus = 200): Promise<void> {
  await smokeTestWithRetry(url, expectedStatus);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function smokeTestWithRetry(
  url: string,
  expectedStatus = 200,
  attempts = 10,
  delayMs = 2_000,
  log?: (message: string) => void
): Promise<void> {
  let lastStatus = 0;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      lastStatus = await httpGet(url);
      if (lastStatus === expectedStatus) {
        return;
      }
      log?.(`Smoke test attempt ${attempt}/${attempts} for ${url}: expected ${expectedStatus}, got ${lastStatus}`);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      log?.(`Smoke test attempt ${attempt}/${attempts} for ${url} failed: ${message}`);
    }

    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  if (lastError) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Smoke test failed for ${url}: ${message}`);
  }

  throw new Error(`Smoke test failed for ${url}: expected ${expectedStatus}, got ${lastStatus}`);
}

async function smokeTestSlot(app: AppConfig, slot: Slot, context: CommandContext): Promise<void> {
  const url = `http://127.0.0.1:${app.slots[slot].port}${app.healthPath}`;
  if (context.dryRun) {
    context.log(`[dry-run] smoke test ${url}`);
    return;
  }
  await smokeTestWithRetry(url, 200, 10, 2_000, context.log);
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

async function writeServiceProfileFile(path: string, contents: string, context: CommandContext): Promise<void> {
  context.log(`${context.dryRun ? '[dry-run] ' : ''}write ${path}`);
  if (context.dryRun) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

export async function installServiceProfileFiles(config: GatewayConfig, appId: string, context: CommandContext): Promise<void> {
  if (config.serviceProfiles.gatewayApi.appId === appId) {
    if (config.serviceProfiles.gatewayApi.enabled) {
      await writeServiceProfileFile(
        config.serviceProfiles.gatewayApi.envFilePath,
        renderGatewayApiEnv(config.serviceProfiles.gatewayApi),
        context
      );
    }
    await writeServiceProfileFile(
      config.serviceProfiles.gatewayApi.jobRuntime.channelsFilePath,
      renderGatewayApiJobChannels(config.serviceProfiles.gatewayApi.jobRuntime),
      context
    );
    await writeServiceProfileFile(
      config.serviceProfiles.gatewayApi.kulrsActivity.envFilePath,
      renderKulrsActivityEnv(config.serviceProfiles.gatewayApi.kulrsActivity),
      context
    );
    await writeServiceProfileFile(
      config.serviceProfiles.gatewayApi.kulrsActivity.credentialsFilePath,
      renderKulrsCredentials(config.serviceProfiles.gatewayApi.kulrsActivity),
      context
    );
  }

  if (config.serviceProfiles.gatewayChatPlatform.enabled && config.serviceProfiles.gatewayChatPlatform.appId === appId) {
    await writeServiceProfileFile(
      config.serviceProfiles.gatewayChatPlatform.apiEnvFilePath,
      renderGatewayChatPlatformEnv(config.serviceProfiles.gatewayChatPlatform),
      context
    );
  }
}

export async function syncServiceProfileRuntime(
  config: GatewayConfig,
  appId: string,
  context: CommandContext,
  baseUrlOverride?: string
): Promise<void> {
  if (!(config.serviceProfiles.gatewayChatPlatform.enabled && config.serviceProfiles.gatewayChatPlatform.appId === appId)) {
    return;
  }

  const baseUrl = normalizeBaseUrl(baseUrlOverride ?? config.serviceProfiles.gatewayChatPlatform.apiBaseUrl);
  const syncUrl = `${baseUrl}/api/agents/manage/sync`;
  const payload = {
    agents: config.serviceProfiles.gatewayChatPlatform.agents
  };

  context.log(
    `${context.dryRun ? '[dry-run] ' : ''}POST ${syncUrl} (${config.serviceProfiles.gatewayChatPlatform.agents.length} agents)`
  );
  if (context.dryRun) {
    return;
  }

  const response = await httpJsonRequest(syncUrl, 'POST', payload);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Agent sync failed for ${syncUrl}: ${response.status} ${response.body}`);
  }
}

export async function runServiceProfileAgent(
  config: GatewayConfig,
  appId: string,
  agentId: string,
  payload: AgentRunPayload,
  context: CommandContext,
  baseUrlOverride?: string,
  requestFn: JsonPostRequest = httpJsonRequest
): Promise<AgentRunResult> {
  if (
    !(
      config.serviceProfiles.gatewayChatPlatform.enabled &&
      config.serviceProfiles.gatewayChatPlatform.appId === appId
    )
  ) {
    throw new Error(`gatewayChatPlatform service profile does not manage app ${appId}`);
  }

  if (!payload.prompt || payload.prompt.trim().length === 0) {
    throw new Error('Agent prompt is required');
  }

  const baseUrl = normalizeBaseUrl(baseUrlOverride ?? config.serviceProfiles.gatewayChatPlatform.apiBaseUrl);
  const runUrl = `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/run`;
  context.log(`${context.dryRun ? '[dry-run] ' : ''}POST ${runUrl}`);

  if (context.dryRun) {
    return {
      agentId,
      usedProvider: 'dry-run',
      model: 'dry-run',
      content: '',
      latencyMs: 0
    };
  }

  const response = await requestFn(runUrl, 'POST', payload);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Agent run failed for ${runUrl}: ${response.status} ${response.body}`);
  }

  return JSON.parse(response.body) as AgentRunResult;
}

export async function installJobs(config: GatewayConfig, appId: string, context: CommandContext): Promise<void> {
  const app = getApp(config, appId);
  const jobs = getJobsForApp(config, appId);
  const timerNames: string[] = [];

  for (const job of jobs) {
    const servicePath = join(config.gateway.systemdUnitDirectory, `${job.id}.service`);
    const timerPath = join(config.gateway.systemdUnitDirectory, `${job.id}.timer`);
    const serviceBody = renderJobService(config, app, job);
    const timerBody = renderJobTimer(job);

    await installSystemdUnit(servicePath, serviceBody, context);
    await installSystemdUnit(timerPath, timerBody, context);

    timerNames.push(`${job.id}.timer`);
  }

  await runShell(config.gateway.systemdReloadCommand, process.cwd(), context);
  if (timerNames.length > 0) {
    await runShell(`${config.gateway.systemdEnableTimerCommand} ${timerNames.join(' ')}`, process.cwd(), context);
  }
}

export async function installControlPlaneService(config: GatewayConfig, context: CommandContext): Promise<void> {
  if (!config.gateway.adminUi.enabled) {
    throw new Error('Admin UI is disabled in gateway.adminUi');
  }

  const servicePath = join(config.gateway.systemdUnitDirectory, config.gateway.adminUi.serviceName);
  const serviceBody = renderControlPlaneService(config.gateway.adminUi);

  await installSystemdUnit(servicePath, serviceBody, context);

  await runShell(config.gateway.systemdReloadCommand, process.cwd(), context);
  await runShell(
    `${config.gateway.systemdEnableTimerCommand} ${config.gateway.adminUi.serviceName}`,
    process.cwd(),
    context
  );
}

export async function deployApp(
  config: GatewayConfig,
  appId: string,
  revision: string | undefined,
  skipFetch: boolean,
  context: CommandContext
): Promise<void> {
  const app = getApp(config, appId);
  const current = await readCurrentSlot(app);
  const target = oppositeSlot(current);
  const revisionToUse = revision ?? app.defaultRevision;
  const slotDir = await checkoutRevision(app, target, revisionToUse, skipFetch, context);

  await buildSlot(app, target, slotDir, context);
  await installServiceProfileFiles(config, appId, context);
  await runShell(resolveAppCommandTokens(app, target, slotDir, app.slots[target].startCommand), slotDir, context);
  await smokeTestSlot(app, target, context);
  await syncServiceProfileRuntime(config, appId, context, `http://127.0.0.1:${app.slots[target].port}`);
  await writeActiveUpstream(app, target, context);
  await runShell(config.gateway.nginxReloadCommand, process.cwd(), context);
  await setCurrentPointers(app, target, context);
  await installJobs(config, appId, context);
}

export async function rollbackApp(config: GatewayConfig, appId: string, context: CommandContext): Promise<void> {
  const app = getApp(config, appId);
  const current = await readCurrentSlot(app);
  const target = oppositeSlot(current);
  const slotDir = join(app.deployRoot, target);

  await installServiceProfileFiles(config, appId, context);
  await runShell(resolveAppCommandTokens(app, target, slotDir, app.slots[target].startCommand), slotDir, context);
  await smokeTestSlot(app, target, context);
  await syncServiceProfileRuntime(config, appId, context, `http://127.0.0.1:${app.slots[target].port}`);
  await writeActiveUpstream(app, target, context);
  await runShell(config.gateway.nginxReloadCommand, process.cwd(), context);
  await setCurrentPointers(app, target, context);
}

export interface MinecraftControlPayload {
  message?: string;
  player?: string;
  reason?: string;
}

export interface RemoteContainerStatus {
  containerName: string;
  exists: boolean;
  status: string;
  running: boolean;
  networkMode?: string;
  startedAt?: string;
  createdAt?: string;
  configuredImage?: string;
  imageId?: string;
  ports?: Record<string, unknown> | null;
  error?: string;
}

export interface MinecraftLogTail {
  requestedLines: number;
  fetchedAt: string | null;
  lines: string[];
  error?: string;
}

export interface MinecraftServerRuntimeStatus {
  bedrockVersion: string | null;
  downloadedVersion: string | null;
  logs: MinecraftLogTail;
}

export interface MinecraftWorkloadStatus {
  workloadId: string;
  nodeId: string;
  configuredServerPort: number | null;
  worker: RemoteContainerStatus;
  server: RemoteContainerStatus;
  serverRuntime: MinecraftServerRuntimeStatus;
  autoUpdate: MinecraftAutoUpdateStatus;
  lastManualUpdateResult: MinecraftActionResult | null;
}

export interface ContainerServiceWorkloadStatus {
  workloadId: string;
  nodeId: string;
  healthCheck?: {
    protocol: string;
    target: string;
    status: 'ok' | 'error' | 'unknown';
    detail: string;
  };
  service: RemoteContainerStatus;
  containers?: { name: string; service: string; state: string; status: string }[];
}

type MinecraftControlAction = 'start' | 'stop' | 'restart' | 'broadcast' | 'kick' | 'ban' | 'update-if-empty' | 'force-update';
type ContainerServiceControlAction = 'start' | 'stop' | 'restart';

export interface MinecraftAutoUpdateStatus {
  status: 'running' | 'disabled' | 'not-deployed' | 'worker-stopped' | 'misconfigured';
  summary: string;
  configuredEnabled: boolean;
  configuredSchedule: string | null;
  workerConfigPresent: boolean;
  workerConfigError?: string;
  registeredInWorker: boolean;
  workerEnabled: boolean;
  workerSchedule: string | null;
  workerTimeZone: string | null;
  workerPollIntervalSeconds: number | null;
  workerStatePresent: boolean;
  workerStateError?: string;
  lastRunAt: string | null;
  lastSlot: string | null;
  nextRunAt: string | null;
  lastResult: MinecraftActionResult | null;
}

export interface MinecraftActionResult {
  action?: string;
  status: string;
  summary: string;
  detail?: string;
  stdout?: string;
  stderr?: string;
  recordedAt?: string;
}

export interface PiProxyRuntimeState {
  updatedAt?: string;
  registryUrl?: string;
  mode?: string;
  lastError?: string | null;
  servers?: Array<{
    workloadId?: string;
    serverName?: string;
    worldName?: string;
    motd?: string;
    levelName?: string;
    targetHost?: string;
    targetPort?: number;
    localPort?: number;
    sessionCount?: number;
    sessions?: Array<{
      client?: string;
      upstreamLocalPort?: number | null;
      createdAt?: string;
      lastClientPacketAt?: string | null;
      lastTargetPacketAt?: string | null;
      clientPackets?: number;
      targetPackets?: number;
      clientBytes?: number;
      targetBytes?: number;
    }>;
  }>;
}

export interface PiProxyServiceStatus {
  enabled: boolean;
  nodeId: string;
  nodeEnabled: boolean;
  installRoot: string;
  systemdUnitName: string;
  registryUrl: string;
  serviceInstalled: boolean;
  managedConfigMatched: boolean;
  activeState: string;
  subState: string;
  unitFileState: string;
  summary: string;
  runtimeState: PiProxyRuntimeState | null;
  workingDirectory?: string;
  execStart?: string;
  error?: string;
}

function getLatestMinecraftActionResult(
  tasks: Record<string, { lastResult?: MinecraftActionResult; lastRunAt?: string }> | undefined,
  keys: string[]
): MinecraftActionResult | null {
  if (!tasks) {
    return null;
  }

  let latest: MinecraftActionResult | null = null;
  let latestTime = 0;

  for (const key of keys) {
    const task = tasks[key];
    const result = task?.lastResult;
    if (!result || typeof result !== 'object') {
      continue;
    }
    const timestamp = Date.parse(result.recordedAt || task.lastRunAt || '');
    const sortableTime = Number.isNaN(timestamp) ? 0 : timestamp;
    if (!latest || sortableTime >= latestTime) {
      latest = result;
      latestTime = sortableTime;
    }
  }

  return latest;
}

function requireRemoteWorkloadEnabled(workload: RemoteWorkloadConfig): void {
  if (!workload.enabled) {
    throw new Error(`Remote workload is disabled: ${workload.id}`);
  }
}

function buildMinecraftComposeCommand(node: WorkerNodeConfig, workload: RemoteWorkloadConfig): string {
  return `${node.dockerComposeCommand} -f ${getRemoteWorkloadStackDir(node, workload)}/compose.yml --project-name ${getRemoteWorkloadProjectName(workload)}`;
}

function buildPiProxyRegistryUrl(config: GatewayConfig): string {
  const profile = config.serviceProfiles.piProxy;
  const baseUrl = normalizeBaseUrl(profile.registryBaseUrl);
  const path = profile.registryPath.startsWith('/') ? profile.registryPath : `/${profile.registryPath}`;
  return `${baseUrl}${path}`;
}

function emptyMinecraftLogTail(requestedLines: number): MinecraftLogTail {
  return {
    requestedLines,
    fetchedAt: null,
    lines: []
  };
}

function emptyMinecraftServerRuntimeStatus(requestedLines: number): MinecraftServerRuntimeStatus {
  return {
    bedrockVersion: null,
    downloadedVersion: null,
    logs: emptyMinecraftLogTail(requestedLines)
  };
}

export function extractLatestBedrockVersion(logOutput: string): string | null {
  let version: string | null = null;
  for (const line of logOutput.split(/\r?\n/u)) {
    const match = line.match(/Version:\s*([0-9][0-9.]*)/u);
    if (match) {
      version = match[1];
    }
  }
  return version;
}

export function extractDownloadedBedrockVersion(logOutput: string): string | null {
  let version: string | null = null;
  for (const line of logOutput.split(/\r?\n/u)) {
    const match = line.match(/Downloading Bedrock server version ([0-9][0-9.]*)/u);
    if (match) {
      version = match[1];
    }
  }
  return version;
}

export function parseRemoteContainerInspectOutput(containerName: string, output: string): RemoteContainerStatus {
  const trimmed = output.trim();
  if (trimmed === '__MISSING__') {
    return {
      containerName,
      exists: false,
      status: 'missing',
      running: false
    };
  }

  const [
    stateJson = '{}',
    portsJson = 'null',
    networkModeJson = 'null',
    configuredImageJson = 'null',
    imageIdJson = 'null',
    createdAtJson = 'null'
  ] = trimmed.split('@@');
  const state = JSON.parse(stateJson) as { Status?: string; Running?: boolean; StartedAt?: string };
  const ports = JSON.parse(portsJson) as Record<string, unknown> | null;
  const networkMode = JSON.parse(networkModeJson) as string | null;
  const configuredImage = JSON.parse(configuredImageJson) as string | null;
  const imageId = JSON.parse(imageIdJson) as string | null;
  const createdAt = JSON.parse(createdAtJson) as string | null;

  return {
    containerName,
    exists: true,
    status: typeof state.Status === 'string' ? state.Status : 'unknown',
    running: Boolean(state.Running),
    networkMode: typeof networkMode === 'string' && networkMode.length > 0 ? networkMode : undefined,
    startedAt: typeof state.StartedAt === 'string' ? state.StartedAt : undefined,
    createdAt: typeof createdAt === 'string' ? createdAt : undefined,
    configuredImage: typeof configuredImage === 'string' ? configuredImage : undefined,
    imageId: typeof imageId === 'string' ? imageId : undefined,
    ports
  };
}

async function bootstrapMinecraftWorld(node: WorkerNodeConfig, workload: RemoteWorkloadConfig, context: CommandContext): Promise<void> {
  await runRemoteShell(node, `chmod +x ${shellQuote(`${getRemoteWorkloadStackDir(node, workload)}/scripts/bootstrap-world.sh`)}`, context);
  await runRemoteShell(node, `${getRemoteWorkloadStackDir(node, workload)}/scripts/bootstrap-world.sh`, context);
}

async function syncRemoteWorkloadFiles(
  node: WorkerNodeConfig,
  workload: RemoteWorkloadConfig,
  outDir: string,
  context: CommandContext
): Promise<void> {
  const localDir = join(outDir, 'nodes', node.id, 'workloads', workload.id);
  if (!existsSync(localDir)) {
    throw new Error(`Missing rendered workload artifacts at ${localDir}. Run build first or use the build command with --out ${outDir}.`);
  }

  const stackDir = getRemoteWorkloadStackDir(node, workload);
  await runRemoteShell(node, `mkdir -p ${shellQuote(stackDir)}`, context);
  await copyDirectoryToRemote(node, localDir, stackDir, context);
}

async function syncRemoteWorkerFiles(node: WorkerNodeConfig, outDir: string, context: CommandContext): Promise<void> {
  const localDir = join(outDir, 'nodes', node.id, 'worker');
  if (!existsSync(localDir)) {
    throw new Error(`Missing rendered worker artifacts at ${localDir}. Run build first or use the build command with --out ${outDir}.`);
  }

  const runtimeDir = getRemoteWorkerRuntimeDir(node);
  await runRemoteShell(node, `mkdir -p ${shellQuote(runtimeDir)}`, context);
  await copyDirectoryToRemote(node, localDir, runtimeDir, context);
}

async function prepareScheduledContainerJobSource(
  node: WorkerNodeConfig,
  workload: RemoteWorkloadConfig,
  revisionOverride: string | undefined,
  context: CommandContext
): Promise<void> {
  const build = workload.kind === 'scheduled-container-job'
    ? workload.job?.build
    : workload.kind === 'container-service'
      ? workload.service?.build
      : undefined;
  if (!build) {
    return;
  }

  const sourceDir = getRemoteWorkloadSourceDir(node, workload);
  const revision = revisionOverride ?? build.defaultRevision;
  const repoUrl = build.repoUrl;

  await runRemoteShell(node, `mkdir -p ${shellQuote(join(sourceDir, '..'))}`, context);
  await runRemoteShell(
    node,
    `[ -d ${shellQuote(join(sourceDir, '.git'))} ] || git clone ${shellQuote(repoUrl)} ${shellQuote(sourceDir)}`,
    context
  );
  await runRemoteShell(node, `git -C ${shellQuote(sourceDir)} fetch --all --tags --prune`, context);
  await runRemoteShell(node, `git -C ${shellQuote(sourceDir)} checkout --force ${shellQuote(revision)}`, context);
  await runRemoteShell(
    node,
    `git -C ${shellQuote(sourceDir)} reset --hard origin/${shellQuote(revision)} 2>/dev/null || true`,
    context
  );
}

async function inspectRemoteContainer(node: WorkerNodeConfig, containerName: string): Promise<RemoteContainerStatus> {
  const inspectCommand = [
    `if ${node.dockerCommand} inspect ${shellQuote(containerName)} >/dev/null 2>&1; then`,
    `${node.dockerCommand} inspect ${shellQuote(containerName)} --format ${shellQuote('{{json .State}}@@{{json .NetworkSettings.Ports}}@@{{json .HostConfig.NetworkMode}}@@{{json .Config.Image}}@@{{json .Image}}@@{{json .Created}}')};`,
    'else',
    `printf '__MISSING__';`,
    'fi'
  ].join('\n');
  const result = await runRemoteShellCapture(node, inspectCommand);
  if (result.code !== 0) {
    return {
      containerName,
      exists: false,
      status: 'error',
      running: false,
      error: result.stderr.trim() || result.stdout.trim() || `inspect failed (${result.code})`
    };
  }

  try {
    return parseRemoteContainerInspectOutput(containerName, result.stdout);
  } catch (error) {
    return {
      containerName,
      exists: false,
      status: 'error',
      running: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function inspectRemoteMinecraftRuntime(
  node: WorkerNodeConfig,
  containerName: string,
  logLineCount = 100
): Promise<MinecraftServerRuntimeStatus> {
  const requestedLines = Number.isFinite(logLineCount) && logLineCount > 0
    ? Math.max(1, Math.floor(logLineCount))
    : 100;
  const versionCommand = [
    `if ${node.dockerCommand} inspect ${shellQuote(containerName)} >/dev/null 2>&1; then`,
    `VERSION="$(${node.dockerCommand} logs ${shellQuote(containerName)} 2>&1 | sed -n 's/.*Version: \\\\{0,1\\\\}\\([0-9][0-9.]*\\).*/\\1/p' | tail -n 1)"`,
    `DOWNLOADED="$(${node.dockerCommand} logs ${shellQuote(containerName)} 2>&1 | sed -n 's/.*Downloading Bedrock server version \\([0-9][0-9.]*\\).*/\\1/p' | tail -n 1)"`,
    `printf '%s@@%s' "$VERSION" "$DOWNLOADED"`,
    'else',
    `printf '__MISSING__';`,
    'fi'
  ].join('\n');
  const logTailCommand = [
    `if ${node.dockerCommand} inspect ${shellQuote(containerName)} >/dev/null 2>&1; then`,
    `${node.dockerCommand} logs --tail ${requestedLines} ${shellQuote(containerName)} 2>&1`,
    'else',
    `printf '__MISSING__';`,
    'fi'
  ].join('\n');
  const [versionResult, logTailResult] = await Promise.all([
    runRemoteShellCapture(node, versionCommand),
    runRemoteShellCapture(node, logTailCommand)
  ]);
  const logs: MinecraftLogTail = {
    requestedLines,
    fetchedAt: new Date().toISOString(),
    lines: []
  };

  if (versionResult.code !== 0) {
    return {
      bedrockVersion: null,
      downloadedVersion: null,
      logs: {
        ...logs,
        error: versionResult.stderr.trim() || versionResult.stdout.trim() || `log inspection failed (${versionResult.code})`
      }
    };
  }

  const versionOutput = versionResult.stdout.trim();
  if (versionOutput === '__MISSING__') {
    return emptyMinecraftServerRuntimeStatus(requestedLines);
  }

  let [bedrockVersion = '', downloadedVersion = ''] = versionOutput.split('@@');
  bedrockVersion = bedrockVersion.trim();
  downloadedVersion = downloadedVersion.trim();

  if (logTailResult.code !== 0) {
    logs.error = logTailResult.stderr.trim() || logTailResult.stdout.trim() || `log tail failed (${logTailResult.code})`;
  } else {
    const logOutput = logTailResult.stdout.trimEnd();
    if (logOutput !== '__MISSING__' && logOutput.length > 0) {
      logs.lines = logOutput.split(/\r?\n/u);
      if (!bedrockVersion) {
        bedrockVersion = extractLatestBedrockVersion(logOutput) || '';
      }
      if (!downloadedVersion) {
        downloadedVersion = extractDownloadedBedrockVersion(logOutput) || '';
      }
    }
  }

  return {
    bedrockVersion: bedrockVersion || null,
    downloadedVersion: downloadedVersion || null,
    logs
  };
}

function getDatePartsForTimeZone(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const values = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function matchesScheduleAtExactSecond(schedule: string, at: Date, timeZone: string): boolean {
  const everyMinutes = /^\*:(\d{1,2})\/(\d{1,2})$/u.exec(schedule);
  if (everyMinutes) {
    const start = Number(everyMinutes[1]);
    const step = Number(everyMinutes[2]);
    const parts = getDatePartsForTimeZone(at, timeZone);
    return parts.second === 0 && parts.minute >= start && (parts.minute - start) % step === 0;
  }

  const daily = /^\*-\*-\* (\d{2}):(\d{2}):(\d{2})$/u.exec(schedule);
  if (daily) {
    const parts = getDatePartsForTimeZone(at, timeZone);
    return (
      parts.hour === Number(daily[1]) &&
      parts.minute === Number(daily[2]) &&
      parts.second === Number(daily[3])
    );
  }

  return false;
}

function findNextScheduledRun(schedule: string | null, timeZone: string | null, now = new Date()): string | null {
  if (!schedule || !timeZone) {
    return null;
  }

  const start = new Date(now.getTime() + 1000);
  start.setMilliseconds(0);

  for (let offsetSeconds = 0; offsetSeconds < 172_800; offsetSeconds += 1) {
    const candidate = new Date(start.getTime() + offsetSeconds * 1000);
    if (matchesScheduleAtExactSecond(schedule, candidate, timeZone)) {
      return candidate.toISOString();
    }
  }

  return null;
}

async function readRemoteJsonFile(
  node: WorkerNodeConfig,
  path: string
): Promise<{ exists: boolean; value: unknown | null; error?: string }> {
  const result = await runRemoteShellCapture(
    node,
    `if [ -f ${shellQuote(path)} ]; then cat ${shellQuote(path)}; else printf '__MISSING__'; fi`
  );

  if (result.code !== 0) {
    return {
      exists: false,
      value: null,
      error: result.stderr.trim() || result.stdout.trim() || `read failed (${result.code})`
    };
  }

  const output = result.stdout.trim();
  if (output === '__MISSING__') {
    return { exists: false, value: null };
  }

  try {
    return {
      exists: true,
      value: JSON.parse(output) as unknown
    };
  } catch (error) {
    return {
      exists: true,
      value: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function readRemoteWorkerTimeZone(node: WorkerNodeConfig, containerName: string): Promise<string | null> {
  const result = await runRemoteShellCapture(
    node,
    `${node.dockerCommand} exec ${shellQuote(containerName)} node -e ${shellQuote("process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')")}`
  );

  if (result.code !== 0) {
    return null;
  }

  const timeZone = result.stdout.trim();
  return timeZone.length > 0 ? timeZone : null;
}

function buildMinecraftAutoUpdateStatus(
  workload: RemoteWorkloadConfig,
  worker: RemoteContainerStatus,
  workerConfigSnapshot: { exists: boolean; value: unknown | null; error?: string },
  workerStateSnapshot: { exists: boolean; value: unknown | null; error?: string },
  workerTimeZone: string | null
): MinecraftAutoUpdateStatus {
  const configuredEnabled = Boolean(workload.minecraft?.autoUpdateEnabled);
  const configuredSchedule = workload.minecraft?.autoUpdateSchedule || null;

  const workerConfig = workerConfigSnapshot.value && typeof workerConfigSnapshot.value === 'object'
    ? workerConfigSnapshot.value as {
      pollIntervalSeconds?: number;
      workloads?: Array<{ id?: string; kind?: string; minecraft?: { autoUpdateEnabled?: boolean; autoUpdateSchedule?: string } }>;
    }
    : null;

  const workerWorkload = Array.isArray(workerConfig?.workloads)
    ? workerConfig.workloads.find((candidate) => candidate?.id === workload.id && candidate?.kind === 'minecraft-bedrock-server')
    : undefined;

  const workerEnabled = Boolean(workerWorkload?.minecraft?.autoUpdateEnabled);
  const workerSchedule = typeof workerWorkload?.minecraft?.autoUpdateSchedule === 'string'
    ? workerWorkload.minecraft.autoUpdateSchedule
    : null;

  const workerState = workerStateSnapshot.value && typeof workerStateSnapshot.value === 'object'
    ? workerStateSnapshot.value as {
      tasks?: Record<string, { lastRunAt?: string; lastSlot?: string; lastResult?: MinecraftActionResult }>;
    }
    : null;
  const workerTask = workerState?.tasks?.[`minecraft-update:${workload.id}`];
  const nextRunAt = findNextScheduledRun(workerSchedule, workerTimeZone);

  if (!configuredEnabled) {
    return {
      status: 'disabled',
      summary: 'Disabled in config',
      configuredEnabled,
      configuredSchedule,
      workerConfigPresent: workerConfigSnapshot.exists,
      workerConfigError: workerConfigSnapshot.error,
      registeredInWorker: Boolean(workerWorkload),
      workerEnabled,
      workerSchedule,
      workerTimeZone,
      workerPollIntervalSeconds: typeof workerConfig?.pollIntervalSeconds === 'number' ? workerConfig.pollIntervalSeconds : null,
      workerStatePresent: workerStateSnapshot.exists,
      workerStateError: workerStateSnapshot.error,
      lastRunAt: typeof workerTask?.lastRunAt === 'string' ? workerTask.lastRunAt : null,
      lastSlot: typeof workerTask?.lastSlot === 'string' ? workerTask.lastSlot : null,
      nextRunAt,
      lastResult: workerTask?.lastResult && typeof workerTask.lastResult === 'object' ? workerTask.lastResult : null
    };
  }

  if (!workerConfigSnapshot.exists || !workerWorkload) {
    return {
      status: 'not-deployed',
      summary: 'Not deployed to gateway-worker',
      configuredEnabled,
      configuredSchedule,
      workerConfigPresent: workerConfigSnapshot.exists,
      workerConfigError: workerConfigSnapshot.error,
      registeredInWorker: Boolean(workerWorkload),
      workerEnabled,
      workerSchedule,
      workerTimeZone,
      workerPollIntervalSeconds: typeof workerConfig?.pollIntervalSeconds === 'number' ? workerConfig.pollIntervalSeconds : null,
      workerStatePresent: workerStateSnapshot.exists,
      workerStateError: workerStateSnapshot.error,
      lastRunAt: typeof workerTask?.lastRunAt === 'string' ? workerTask.lastRunAt : null,
      lastSlot: typeof workerTask?.lastSlot === 'string' ? workerTask.lastSlot : null,
      nextRunAt,
      lastResult: workerTask?.lastResult && typeof workerTask.lastResult === 'object' ? workerTask.lastResult : null
    };
  }

  if (!worker.running) {
    return {
      status: 'worker-stopped',
      summary: 'gateway-worker container is not running',
      configuredEnabled,
      configuredSchedule,
      workerConfigPresent: workerConfigSnapshot.exists,
      workerConfigError: workerConfigSnapshot.error,
      registeredInWorker: true,
      workerEnabled,
      workerSchedule,
      workerTimeZone,
      workerPollIntervalSeconds: typeof workerConfig?.pollIntervalSeconds === 'number' ? workerConfig.pollIntervalSeconds : null,
      workerStatePresent: workerStateSnapshot.exists,
      workerStateError: workerStateSnapshot.error,
      lastRunAt: typeof workerTask?.lastRunAt === 'string' ? workerTask.lastRunAt : null,
      lastSlot: typeof workerTask?.lastSlot === 'string' ? workerTask.lastSlot : null,
      nextRunAt,
      lastResult: workerTask?.lastResult && typeof workerTask.lastResult === 'object' ? workerTask.lastResult : null
    };
  }

  if (!workerEnabled || !workerSchedule) {
    return {
      status: 'misconfigured',
      summary: 'Worker config is missing the auto-update schedule',
      configuredEnabled,
      configuredSchedule,
      workerConfigPresent: workerConfigSnapshot.exists,
      workerConfigError: workerConfigSnapshot.error,
      registeredInWorker: true,
      workerEnabled,
      workerSchedule,
      workerTimeZone,
      workerPollIntervalSeconds: typeof workerConfig?.pollIntervalSeconds === 'number' ? workerConfig.pollIntervalSeconds : null,
      workerStatePresent: workerStateSnapshot.exists,
      workerStateError: workerStateSnapshot.error,
      lastRunAt: typeof workerTask?.lastRunAt === 'string' ? workerTask.lastRunAt : null,
      lastSlot: typeof workerTask?.lastSlot === 'string' ? workerTask.lastSlot : null,
      nextRunAt,
      lastResult: workerTask?.lastResult && typeof workerTask.lastResult === 'object' ? workerTask.lastResult : null
    };
  }

  return {
    status: 'running',
    summary: 'Running in gateway-worker',
    configuredEnabled,
    configuredSchedule,
    workerConfigPresent: workerConfigSnapshot.exists,
    workerConfigError: workerConfigSnapshot.error,
    registeredInWorker: true,
    workerEnabled,
    workerSchedule,
    workerTimeZone,
    workerPollIntervalSeconds: typeof workerConfig?.pollIntervalSeconds === 'number' ? workerConfig.pollIntervalSeconds : null,
    workerStatePresent: workerStateSnapshot.exists,
    workerStateError: workerStateSnapshot.error,
    lastRunAt: typeof workerTask?.lastRunAt === 'string' ? workerTask.lastRunAt : null,
    lastSlot: typeof workerTask?.lastSlot === 'string' ? workerTask.lastSlot : null,
    nextRunAt,
    lastResult: workerTask?.lastResult && typeof workerTask.lastResult === 'object' ? workerTask.lastResult : null
  };
}

async function restartRemoteWorker(node: WorkerNodeConfig, context: CommandContext): Promise<void> {
  const composeCommand = `${node.dockerComposeCommand} -f ${shellQuote(`${getRemoteWorkerRuntimeDir(node)}/compose.yml`)} --project-name ${shellQuote(getRemoteWorkerProjectName(node))}`;
  await runRemoteShell(
    node,
    `${composeCommand} up -d --build gateway-worker`,
    context
  );
}

async function invokeRemoteWorkerControl(
  node: WorkerNodeConfig,
  workloadId: string,
  action: MinecraftControlAction,
  payload: MinecraftControlPayload,
  context: CommandContext
): Promise<void> {
  const composeCommand = `${node.dockerComposeCommand} -f ${shellQuote(`${getRemoteWorkerRuntimeDir(node)}/compose.yml`)} --project-name ${shellQuote(getRemoteWorkerProjectName(node))}`;
  await runRemoteShell(
    node,
    `${composeCommand} run --rm gateway-worker control --config ${shellQuote('/runtime/worker-config.json')} --workload ${shellQuote(workloadId)} --action ${shellQuote(action)} --payload ${shellQuote(JSON.stringify(payload))}`,
    context
  );
}

export async function deployRemoteWorkload(
  config: GatewayConfig,
  workloadId: string,
  outDir: string,
  revisionOverride: string | undefined,
  context: CommandContext
): Promise<void> {
  const workload = getRemoteWorkload(config, workloadId);
  requireRemoteWorkloadEnabled(workload);
  const node = getWorkerNode(config, workload.nodeId);
  const stackDir = getRemoteWorkloadStackDir(node, workload);

  await syncRemoteWorkerFiles(node, outDir, context);
  await syncRemoteWorkloadFiles(node, workload, outDir, context);

  if (workload.kind === 'scheduled-container-job' && workload.job) {
    await prepareScheduledContainerJobSource(node, workload, revisionOverride, context);
    await runRemoteShell(
      node,
      `mkdir -p ${shellQuote(getRemoteWorkloadDataDir(node, workload))} ${shellQuote(`${stackDir}/runtime`)}`,
      context
    );
    if (workload.job.build.strategy === 'generated-node') {
      await runRemoteShell(
        node,
        `cp ${shellQuote(`${stackDir}/Dockerfile`)} ${shellQuote(`${node.buildRoot}/${workload.id}/Dockerfile`)}`,
        context
      );
    }
    await runRemoteShell(
      node,
      `${node.dockerComposeCommand} -f ${shellQuote(`${stackDir}/compose.yml`)} --project-name ${shellQuote(getRemoteWorkloadProjectName(workload))} build runner`,
      context
    );
    await restartRemoteWorker(node, context);
    return;
  }

  if (workload.kind === 'container-service' && workload.service) {
    await runRemoteShell(node, `mkdir -p ${shellQuote(getRemoteWorkloadDataDir(node, workload))}`, context);
    await prepareScheduledContainerJobSource(node, workload, revisionOverride, context);

    if (workload.service.build?.strategy === 'repo-compose') {
      // repo-compose: use the repo's own docker-compose.yml directly
      const sourceDir = getRemoteWorkloadSourceDir(node, workload);
      const composeFile = workload.service.build.composeFile || 'docker-compose.yml';
      // Sync env file to source dir so compose can use env_file or variable substitution
      if (workload.service.environment.length > 0) {
        await runRemoteShell(
          node,
          `cp ${shellQuote(`${stackDir}/service.env`)} ${shellQuote(`${sourceDir}/.env`)}`,
          context
        );
      }
      if (workload.service.autoStart) {
        await runRemoteShell(
          node,
          `${node.dockerComposeCommand} -f ${shellQuote(`${sourceDir}/${composeFile}`)} --project-name ${shellQuote(getRemoteWorkloadProjectName(workload))} up -d --build`,
          context
        );
      }
      return;
    }

    if (workload.service.build?.strategy === 'generated-node') {
      await runRemoteShell(
        node,
        `cp ${shellQuote(`${stackDir}/Dockerfile`)} ${shellQuote(`${node.buildRoot}/${workload.id}/Dockerfile`)}`,
        context
      );
    }
    if (workload.service.autoStart) {
      await runRemoteShell(
        node,
        `${node.dockerComposeCommand} -f ${shellQuote(`${stackDir}/compose.yml`)} --project-name ${shellQuote(getRemoteWorkloadProjectName(workload))} up -d --build service`,
        context
      );
    }
    return;
  }

  if (workload.kind === 'minecraft-bedrock-server' && workload.minecraft) {
    await runRemoteShell(node, `mkdir -p ${shellQuote(`${getRemoteWorkloadDataDir(node, workload)}/data`)}`, context);
    await restartRemoteWorker(node, context);
    if (workload.minecraft.autoStart) {
      await invokeRemoteWorkerControl(node, workload.id, 'start', {}, context);
    }
  }
}

export async function controlMinecraftWorkload(
  config: GatewayConfig,
  workloadId: string,
  action: MinecraftControlAction,
  payload: MinecraftControlPayload,
  context: CommandContext
): Promise<void> {
  const workload = getRemoteWorkload(config, workloadId);
  if (!(workload.kind === 'minecraft-bedrock-server' && workload.minecraft)) {
    throw new Error(`Remote workload ${workloadId} is not a minecraft-bedrock-server workload`);
  }

  const node = getWorkerNode(config, workload.nodeId);
  await invokeRemoteWorkerControl(node, workload.id, action, payload, context);
}

function getServiceComposeCommand(node: WorkerNodeConfig, workload: RemoteWorkloadConfig): string {
  if (workload.service?.build?.strategy === 'repo-compose') {
    const sourceDir = getRemoteWorkloadSourceDir(node, workload);
    const composeFile = workload.service.build.composeFile || 'docker-compose.yml';
    return `${node.dockerComposeCommand} -f ${shellQuote(`${sourceDir}/${composeFile}`)} --project-name ${shellQuote(getRemoteWorkloadProjectName(workload))}`;
  }
  return `${node.dockerComposeCommand} -f ${shellQuote(`${getRemoteWorkloadStackDir(node, workload)}/compose.yml`)} --project-name ${shellQuote(getRemoteWorkloadProjectName(workload))}`;
}

export async function controlContainerServiceWorkload(
  config: GatewayConfig,
  workloadId: string,
  action: ContainerServiceControlAction,
  context: CommandContext
): Promise<void> {
  const workload = getRemoteWorkload(config, workloadId);
  if (!(workload.kind === 'container-service' && workload.service)) {
    throw new Error(`Remote workload ${workloadId} is not a container-service workload`);
  }

  const node = getWorkerNode(config, workload.nodeId);
  const composeCommand = getServiceComposeCommand(node, workload);
  const shellCommand = action === 'start'
    ? `${composeCommand} up -d`
    : action === 'stop'
      ? `${composeCommand} stop`
      : `${composeCommand} restart`;
  await runRemoteShell(node, shellCommand, context);
}

async function probeContainerServiceHealth(
  node: WorkerNodeConfig,
  containerName: string,
  healthCheck: NonNullable<NonNullable<RemoteWorkloadConfig['service']>['healthCheck']>
): Promise<{ protocol: string; target: string; status: 'ok' | 'error' | 'unknown'; detail: string }> {
  const target = healthCheck.protocol === 'http'
    ? `http://127.0.0.1:${healthCheck.port}${healthCheck.path || '/'}`
    : `127.0.0.1:${healthCheck.port}`;
  const command = healthCheck.protocol === 'http'
    ? `if ${node.dockerCommand} inspect ${shellQuote(containerName)} >/dev/null 2>&1; then code="$(curl -sS -o /dev/null -w '%{http_code}' ${shellQuote(target)} || true)"; printf '%s' "$code"; else printf '__MISSING__'; fi`
    : `if ${node.dockerCommand} inspect ${shellQuote(containerName)} >/dev/null 2>&1; then nc -z 127.0.0.1 ${shellQuote(String(healthCheck.port))} >/dev/null 2>&1 && printf 'ok' || printf 'fail'; else printf '__MISSING__'; fi`;
  const result = await runRemoteShellCapture(node, command);
  if (result.code !== 0) {
    return {
      protocol: healthCheck.protocol,
      target,
      status: 'error',
      detail: result.stderr.trim() || result.stdout.trim() || `health probe failed (${result.code})`
    };
  }
  const output = result.stdout.trim();
  if (output === '__MISSING__') {
    return {
      protocol: healthCheck.protocol,
      target,
      status: 'unknown',
      detail: 'Container is missing'
    };
  }
  if (healthCheck.protocol === 'http') {
    const expectedStatus = healthCheck.expectedStatus ?? 200;
    return {
      protocol: healthCheck.protocol,
      target,
      status: output === String(expectedStatus) ? 'ok' : 'error',
      detail: `HTTP ${output || 'unknown'} (expected ${expectedStatus})`
    };
  }
  return {
    protocol: healthCheck.protocol,
    target,
    status: output === 'ok' ? 'ok' : 'error',
    detail: output === 'ok' ? 'TCP probe succeeded' : 'TCP probe failed'
  };
}

export async function getContainerServiceLogs(
  config: GatewayConfig,
  workloadId: string,
  serviceName?: string,
  tailLines = 100
): Promise<{ workloadId: string; service: string; lines: string[] }> {
  const workload = getRemoteWorkload(config, workloadId);
  if (!(workload.kind === 'container-service' && workload.service)) {
    throw new Error(`Remote workload ${workloadId} is not a container-service workload`);
  }
  const node = getWorkerNode(config, workload.nodeId);
  const composeCommand = getServiceComposeCommand(node, workload);
  const svcArg = serviceName ? ` ${shellQuote(serviceName)}` : '';
  const result = await runRemoteShellCapture(
    node,
    `${composeCommand} logs --tail ${tailLines} --no-color${svcArg} 2>&1`,
    60_000
  );
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim()
      || result.stdout.trim()
      || `Timed out fetching logs for ${workloadId}`
    );
  }
  return {
    workloadId,
    service: serviceName || 'all',
    lines: result.stdout.split('\n')
  };
}

export async function getContainerServiceWorkloadStatus(config: GatewayConfig, workloadId: string): Promise<ContainerServiceWorkloadStatus> {
  const workload = getRemoteWorkload(config, workloadId);
  if (!(workload.kind === 'container-service' && workload.service)) {
    throw new Error(`Remote workload ${workloadId} is not a container-service workload`);
  }

  const node = getWorkerNode(config, workload.nodeId);

  if (workload.service.build?.strategy === 'repo-compose') {
    // For repo-compose, check status via docker compose ps
    const composeCommand = getServiceComposeCommand(node, workload);
    const psResult = await runRemoteShellCapture(node, `${composeCommand} ps --format json 2>/dev/null || true`);
    let allRunning = true;
    let anyExists = false;
    const containers: { name: string; service: string; state: string; status: string }[] = [];
    let firstRunningContainer: string | undefined;
    if (psResult.code === 0 && psResult.stdout.trim()) {
      try {
        const lines = psResult.stdout.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          const entry = JSON.parse(line);
          anyExists = true;
          const name = entry.Name || entry.Names || '';
          const svc = entry.Service || '';
          const state = entry.State || '';
          const statusLine = entry.Status || state;
          containers.push({ name, service: svc, state, status: statusLine });
          if (state === 'running') {
            if (!firstRunningContainer) firstRunningContainer = name;
          } else {
            allRunning = false;
          }
        }
      } catch {
        // ps output not parseable, fall through
      }
    }
    if (containers.length === 0) allRunning = false;
    const runningCount = containers.filter(c => c.state === 'running').length;
    const service: RemoteContainerStatus = {
      containerName: `${getRemoteWorkloadProjectName(workload)}`,
      exists: anyExists,
      status: allRunning ? 'running' : anyExists ? `${runningCount}/${containers.length} running` : 'missing',
      running: allRunning
    };
    // Find a container to use for health check probe — prefer one named *nginx*, fall back to first running
    const healthProbeContainer = containers.find(c => c.state === 'running' && c.name.includes('nginx'))?.name
      || firstRunningContainer
      || `${getRemoteWorkloadProjectName(workload)}-nginx-1`;
    const healthCheck = workload.service.healthCheck
      ? await probeContainerServiceHealth(node, healthProbeContainer, workload.service.healthCheck)
      : undefined;

    return {
      workloadId: workload.id,
      nodeId: node.id,
      service,
      containers,
      ...(healthCheck ? { healthCheck } : {})
    };
  }

  const serviceContainerName = `${getRemoteWorkloadProjectName(workload)}-service`;
  const service = await inspectRemoteContainer(node, serviceContainerName);
  const healthCheck = workload.service.healthCheck
    ? await probeContainerServiceHealth(node, serviceContainerName, workload.service.healthCheck)
    : undefined;

  return {
    workloadId: workload.id,
    nodeId: node.id,
    service,
    ...(healthCheck ? { healthCheck } : {})
  };
}

export async function getMinecraftWorkloadStatus(config: GatewayConfig, workloadId: string): Promise<MinecraftWorkloadStatus> {
  const workload = getRemoteWorkload(config, workloadId);
  if (!(workload.kind === 'minecraft-bedrock-server' && workload.minecraft)) {
    throw new Error(`Remote workload ${workloadId} is not a minecraft-bedrock-server workload`);
  }

  const node = getWorkerNode(config, workload.nodeId);
  const workerContainerName = `${getRemoteWorkerProjectName(node)}-service`;
  const serverContainerName = `${getRemoteWorkloadProjectName(workload)}-server`;
  const runtimeDir = getRemoteWorkerRuntimeDir(node);
  const [worker, server, workerConfigSnapshot, workerStateSnapshot] = await Promise.all([
    inspectRemoteContainer(node, workerContainerName),
    inspectRemoteContainer(node, serverContainerName),
    readRemoteJsonFile(node, `${runtimeDir}/worker-config.json`),
    readRemoteJsonFile(node, `${runtimeDir}/worker-state.json`)
  ]);
  const [workerTimeZone, serverRuntime] = await Promise.all([
    worker.running ? readRemoteWorkerTimeZone(node, workerContainerName) : Promise.resolve(null),
    server.exists ? inspectRemoteMinecraftRuntime(node, serverContainerName, 100) : Promise.resolve(emptyMinecraftServerRuntimeStatus(100))
  ]);
  const workerState = workerStateSnapshot.value && typeof workerStateSnapshot.value === 'object'
    ? workerStateSnapshot.value as {
      tasks?: Record<string, { lastResult?: MinecraftActionResult; lastRunAt?: string }>;
    }
    : null;
  const lastManualUpdateResult = getLatestMinecraftActionResult(workerState?.tasks, [
    `minecraft-control:update-if-empty:${workload.id}`,
    `minecraft-control:force-update:${workload.id}`
  ]);

  return {
    workloadId: workload.id,
    nodeId: node.id,
    configuredServerPort: workload.minecraft.serverPort ?? null,
    worker,
    server,
    serverRuntime,
    autoUpdate: buildMinecraftAutoUpdateStatus(workload, worker, workerConfigSnapshot, workerStateSnapshot, workerTimeZone),
    lastManualUpdateResult
  };
}

export async function deployPiProxyService(
  config: GatewayConfig,
  outDir: string,
  context: CommandContext
): Promise<void> {
  const profile = config.serviceProfiles.piProxy;
  if (!profile.enabled) {
    throw new Error('piProxy service profile is disabled');
  }

  const node = getWorkerNode(config, profile.nodeId);
  if (!node.enabled) {
    throw new Error(`Pi proxy node is disabled: ${node.id}`);
  }
  const localDir = join(outDir, 'nodes', node.id, 'pi-proxy');
  if (!existsSync(localDir)) {
    throw new Error(`Missing rendered Pi proxy artifacts at ${localDir}. Run build first.`);
  }

  const systemdUnitDirectory = node.systemdUnitDirectory ?? '/etc/systemd/system';
  const systemdReloadCommand = node.systemdReloadCommand ?? 'sudo systemctl daemon-reload';
  const systemdEnableCommand = node.systemdEnableTimerCommand ?? 'sudo systemctl enable --now';

  await runRemoteShell(
    node,
    `sudo mkdir -p ${shellQuote(profile.installRoot)} && sudo chown -R ${shellQuote(`${node.sshUser}:${node.sshUser}`)} ${shellQuote(profile.installRoot)}`,
    context
  );
  await copyDirectoryToRemote(node, localDir, profile.installRoot, context);
  await runRemoteShell(node, `cd ${shellQuote(profile.installRoot)} && npm install --omit=dev`, context);
  await runRemoteShell(
    node,
    `sudo install -m 0644 ${shellQuote(`${profile.installRoot}/systemd/${profile.systemdUnitName}`)} ${shellQuote(join(systemdUnitDirectory, profile.systemdUnitName))}`,
    context
  );
  await runRemoteShell(node, systemdReloadCommand, context);
  await runRemoteShell(node, `${systemdEnableCommand} ${shellQuote(profile.systemdUnitName)}`, context);
}

export async function restartPiProxyService(config: GatewayConfig, context: CommandContext): Promise<void> {
  const profile = config.serviceProfiles.piProxy;
  if (!profile.enabled) {
    throw new Error('piProxy service profile is disabled');
  }

  const node = getWorkerNode(config, profile.nodeId);
  if (!node.enabled) {
    throw new Error(`Pi proxy node is disabled: ${node.id}`);
  }
  await runRemoteShell(node, `sudo systemctl restart ${shellQuote(profile.systemdUnitName)}`, context);
}

export async function getPiProxyServiceStatus(config: GatewayConfig): Promise<PiProxyServiceStatus> {
  const profile = config.serviceProfiles.piProxy;
  if (!profile.enabled) {
    return {
      enabled: false,
      nodeId: profile.nodeId,
      nodeEnabled: false,
      installRoot: profile.installRoot,
      systemdUnitName: profile.systemdUnitName,
      registryUrl: buildPiProxyRegistryUrl(config),
      serviceInstalled: false,
      managedConfigMatched: false,
      activeState: 'disabled',
      subState: 'disabled',
      unitFileState: 'disabled',
      summary: 'Pi proxy profile is disabled',
      runtimeState: null
    };
  }

  const node = getWorkerNode(config, profile.nodeId);
  if (!node.enabled) {
    return {
      enabled: true,
      nodeId: node.id,
      nodeEnabled: false,
      installRoot: profile.installRoot,
      systemdUnitName: profile.systemdUnitName,
      registryUrl: buildPiProxyRegistryUrl(config),
      serviceInstalled: false,
      managedConfigMatched: false,
      activeState: 'disabled',
      subState: 'disabled',
      unitFileState: 'disabled',
      summary: `Pi proxy node is disabled: ${node.id}`,
      runtimeState: null
    };
  }
  const systemctlResult = await runRemoteShellCapture(
    node,
    [
      `if systemctl show ${shellQuote(profile.systemdUnitName)} >/dev/null 2>&1; then`,
      [
        'systemctl show',
        shellQuote(profile.systemdUnitName),
        '-p LoadState',
        '-p ActiveState',
        '-p SubState',
        '-p UnitFileState',
        '-p WorkingDirectory',
        '-p ExecStart'
      ].join(' ') + ';',
      'else',
      `printf '__MISSING__';`,
      'fi'
    ].join('\n')
  );

  const runtimeStateSnapshot = await readRemoteJsonFile(node, `${profile.installRoot}/proxy-state.json`);
  const runtimeState = runtimeStateSnapshot.value && typeof runtimeStateSnapshot.value === 'object'
    ? runtimeStateSnapshot.value as PiProxyRuntimeState
    : null;

  if (systemctlResult.code !== 0) {
    return {
      enabled: true,
      nodeId: node.id,
      nodeEnabled: node.enabled,
      installRoot: profile.installRoot,
      systemdUnitName: profile.systemdUnitName,
      registryUrl: buildPiProxyRegistryUrl(config),
      serviceInstalled: false,
      managedConfigMatched: false,
      activeState: 'error',
      subState: 'error',
      unitFileState: 'unknown',
      summary: 'Unable to inspect Pi proxy service',
      runtimeState,
      error: systemctlResult.stderr.trim() || systemctlResult.stdout.trim() || 'systemctl failed'
    };
  }

  const output = systemctlResult.stdout.trim();
  if (output === '__MISSING__') {
    return {
      enabled: true,
      nodeId: node.id,
      nodeEnabled: node.enabled,
      installRoot: profile.installRoot,
      systemdUnitName: profile.systemdUnitName,
      registryUrl: buildPiProxyRegistryUrl(config),
      serviceInstalled: false,
      managedConfigMatched: false,
      activeState: 'missing',
      subState: 'missing',
      unitFileState: 'not-found',
      summary: 'Pi proxy service is not installed on the node',
      runtimeState
    };
  }

  const systemdFields = Object.fromEntries(
    output
      .split('\n')
      .map((line) => {
        const separatorIndex = line.indexOf('=');
        if (separatorIndex <= 0) {
          return null;
        }
        return [
          line.slice(0, separatorIndex),
          line.slice(separatorIndex + 1)
        ];
      })
      .filter((entry): entry is [string, string] => Array.isArray(entry))
  );

  const loadState = systemdFields.LoadState || 'unknown';
  const activeState = systemdFields.ActiveState || 'unknown';
  const subState = systemdFields.SubState || 'unknown';
  const unitFileState = systemdFields.UnitFileState || 'unknown';
  const workingDirectory = systemdFields.WorkingDirectory || '';
  const execStart = systemdFields.ExecStart || '';
  const serviceInstalled = loadState !== 'not-found';
  const serverCount = Array.isArray(runtimeState?.servers) ? runtimeState.servers.length : 0;
  const managedConfigMatched = serviceInstalled &&
    workingDirectory.trim() === profile.installRoot &&
    execStart.includes(`${profile.installRoot}/proxy.mjs`) &&
    execStart.includes(`${profile.installRoot}/proxy-config.json`);
  const summary = !serviceInstalled
    ? 'Pi proxy service is not installed on the node'
    : !managedConfigMatched
      ? 'Pi proxy service exists but still points to a different install path'
      : activeState === 'active'
        ? `Pi proxy active with ${serverCount} advertised world(s)`
        : `Pi proxy service state: ${activeState}/${subState}`;

  return {
    enabled: true,
    nodeId: node.id,
    nodeEnabled: node.enabled,
    installRoot: profile.installRoot,
    systemdUnitName: profile.systemdUnitName,
    registryUrl: buildPiProxyRegistryUrl(config),
    serviceInstalled,
    managedConfigMatched,
    activeState,
    subState,
    unitFileState,
    summary,
    runtimeState,
    workingDirectory: workingDirectory || undefined,
    execStart: execStart || undefined
  };
}

// ─── Node bootstrap ────────────────────────────────────────────────────────

export interface NodeSetupRequest {
  nodeId: string;
  host: string;
  sshPort: number;
  adminUser: string;
  adminPassword?: string;
  nodeType: 'general' | 'gpu' | 'pi' | 'custom';
  description: string;
  buildRoot: string;
  stackRoot: string;
  volumeRoot: string;
  workerPollIntervalSeconds: number;
}

export interface NodeSetupStepResult {
  step: string;
  status: 'running' | 'ok' | 'warn' | 'error' | 'complete';
  message: string;
  nodeConfig?: WorkerNodeConfig;
}

export async function bootstrapWorkerNode(
  request: NodeSetupRequest,
  onProgress: (result: NodeSetupStepResult) => void
): Promise<void> {
  const { nodeId, host, sshPort, adminUser, adminPassword, buildRoot, stackRoot, volumeRoot } = request;

  const adminSshOptions = [
    `-p ${sshPort}`,
    '-o ConnectTimeout=10',
    '-o StrictHostKeyChecking=accept-new',
    `-o UserKnownHostsFile=${shellQuote(`/tmp/gateway-control-plane-known-hosts-${nodeId}`)}`
  ].join(' ');

  const adminTarget = `${adminUser}@${host}`;
  const usePassword = typeof adminPassword === 'string' && adminPassword.length > 0;

  // If a password was provided, check for sshpass
  if (usePassword) {
    const sshpassCheck = await runShellCapture('command -v sshpass', process.cwd());
    if (sshpassCheck.code !== 0) {
      onProgress({ step: 'connect', status: 'running', message: 'Installing sshpass...' });
      const installResult = await runShellCapture(
        'sudo apt-get install -y sshpass 2>/dev/null || sudo yum install -y sshpass 2>/dev/null || sudo pacman -S --noconfirm sshpass 2>/dev/null',
        process.cwd()
      );
      const verify = await runShellCapture('command -v sshpass', process.cwd());
      if (verify.code !== 0) {
        onProgress({ step: 'connect', status: 'error', message: 'sshpass is required for password-based SSH but could not be installed. Install it manually on the control-plane host: sudo apt-get install sshpass' });
        return;
      }
    }
  }

  async function sshAdmin(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
    // When using password auth, the same password is likely the sudo password.
    // Wrap with a SUDO_ASKPASS helper so sudo -A works non-interactively.
    const wrappedCommand = usePassword
      ? `export SUDO_ASKPASS_SCRIPT=$(mktemp); printf '#!/bin/sh\\necho %q\\n' '${adminPassword!.replaceAll("'", "'\\''")}' > "$SUDO_ASKPASS_SCRIPT"; chmod 700 "$SUDO_ASKPASS_SCRIPT"; export SUDO_ASKPASS="$SUDO_ASKPASS_SCRIPT"; cleanup() { rm -f "$SUDO_ASKPASS_SCRIPT"; }; trap cleanup EXIT; ${command.replaceAll('sudo ', 'sudo -A ')}`
      : command;
    const sshCmd = usePassword
      ? `sshpass -e ssh -o PubkeyAuthentication=no ${adminSshOptions} ${adminTarget} ${shellQuote(wrappedCommand)}`
      : `ssh ${adminSshOptions} ${adminTarget} ${shellQuote(command)}`;
    return await runShellCapture(
      sshCmd,
      process.cwd(),
      usePassword ? { SSHPASS: adminPassword } : undefined
    );
  }

  // Step 1: Test connectivity
  onProgress({ step: 'connect', status: 'running', message: `Connecting to ${host} as ${adminUser}...` });
  const connectResult = await sshAdmin('echo ok');
  if (connectResult.code !== 0) {
    onProgress({
      step: 'connect',
      status: 'error',
      message: `Cannot connect to ${adminUser}@${host}:${sshPort} — ${connectResult.stderr.trim() || 'connection failed'}`
    });
    return;
  }
  const osResult = await sshAdmin('cat /etc/os-release 2>/dev/null | grep -w ID | head -1 | cut -d= -f2 | tr -d \'"\'');
  const osFamily = osResult.code === 0 ? osResult.stdout.trim() : 'unknown';
  onProgress({ step: 'connect', status: 'ok', message: `Connected to ${host} (OS: ${osFamily})` });

  // Step 2: Create deploy user
  onProgress({ step: 'user', status: 'running', message: 'Creating deploy user...' });
  const userScript = `
    set -e
    if id deploy >/dev/null 2>&1; then
      echo "EXISTS"
    else
      sudo useradd -m -s /bin/bash deploy
      echo "CREATED"
    fi
    if getent group docker >/dev/null 2>&1; then
      sudo usermod -aG docker deploy 2>/dev/null || true
    fi
    SUDOERS_FILE="/etc/sudoers.d/deploy-gateway"
    if [ ! -f "$SUDOERS_FILE" ]; then
      printf '%s\\n' \
        'deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl daemon-reload' \
        'deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl enable *' \
        'deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl disable *' \
        'deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl start *' \
        'deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop *' \
        'deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart *' \
        'deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl status *' | sudo tee "$SUDOERS_FILE" >/dev/null
      sudo chmod 0440 "$SUDOERS_FILE"
      echo "SUDOERS_CREATED"
    else
      echo "SUDOERS_EXISTS"
    fi
  `;
  const userResult = await sshAdmin(userScript);
  if (userResult.code !== 0) {
    onProgress({ step: 'user', status: 'error', message: `Failed to create deploy user: ${userResult.stderr.trim()}` });
    return;
  }
  const userCreated = userResult.stdout.includes('CREATED');
  onProgress({ step: 'user', status: 'ok', message: userCreated ? 'Created deploy user with sudoers' : 'deploy user already exists' });

  // Step 3: Install SSH key for deploy
  onProgress({ step: 'sshkey', status: 'running', message: 'Authorizing control-plane SSH key for deploy user...' });
  const localKeyPaths = [
    join(process.env.HOME || '/root', '.ssh', 'id_ed25519.pub'),
    join(process.env.HOME || '/root', '.ssh', 'id_rsa.pub')
  ];
  let localPubKey = '';
  for (const keyPath of localKeyPaths) {
    try {
      localPubKey = (await readFile(keyPath, 'utf8')).trim();
      break;
    } catch {
      // try next
    }
  }
  if (localPubKey.length === 0) {
    onProgress({ step: 'sshkey', status: 'error', message: 'No SSH public key found at ~/.ssh/id_ed25519.pub or ~/.ssh/id_rsa.pub on the control-plane host' });
    return;
  }

  const keyScript = `
    set -e
    DEPLOY_SSH_DIR="/home/deploy/.ssh"
    AUTHORIZED_KEYS="$DEPLOY_SSH_DIR/authorized_keys"
    sudo mkdir -p "$DEPLOY_SSH_DIR"
    PUBKEY='${localPubKey.replaceAll("'", "'\\''")}'
    if sudo test -f "$AUTHORIZED_KEYS" && sudo grep -qF "$PUBKEY" "$AUTHORIZED_KEYS"; then
      echo "KEY_EXISTS"
    else
      echo "$PUBKEY" | sudo tee -a "$AUTHORIZED_KEYS" >/dev/null
      echo "KEY_ADDED"
    fi
    sudo chmod 700 "$DEPLOY_SSH_DIR"
    sudo chmod 600 "$AUTHORIZED_KEYS"
    sudo chown -R deploy:deploy "$DEPLOY_SSH_DIR"
  `;
  const keyResult = await sshAdmin(keyScript);
  if (keyResult.code !== 0) {
    onProgress({ step: 'sshkey', status: 'error', message: `Failed to install SSH key: ${keyResult.stderr.trim()}` });
    return;
  }
  onProgress({ step: 'sshkey', status: 'ok', message: keyResult.stdout.includes('KEY_ADDED') ? 'SSH key authorized for deploy' : 'SSH key already authorized' });

  // Step 4: Install Docker
  onProgress({ step: 'docker', status: 'running', message: 'Checking Docker installation...' });
  const dockerCheck = await sshAdmin('command -v docker && docker --version');
  if (dockerCheck.code === 0) {
    onProgress({ step: 'docker', status: 'ok', message: `Docker already installed: ${dockerCheck.stdout.trim().split('\n').pop() || 'yes'}` });
  } else {
    onProgress({ step: 'docker', status: 'running', message: 'Installing Docker Engine (this may take a minute)...' });
    const dockerInstall = await sshAdmin('curl -fsSL https://get.docker.com | sudo sh && sudo systemctl enable --now docker && sudo usermod -aG docker deploy');
    if (dockerInstall.code !== 0) {
      onProgress({ step: 'docker', status: 'error', message: `Docker installation failed: ${dockerInstall.stderr.trim().slice(0, 300)}` });
      return;
    }
    onProgress({ step: 'docker', status: 'ok', message: 'Docker installed and started' });
  }

  // Check compose plugin
  const composeCheck = await sshAdmin('docker compose version');
  if (composeCheck.code === 0) {
    onProgress({ step: 'docker', status: 'ok', message: `Docker Compose available: ${composeCheck.stdout.trim()}` });
  } else {
    onProgress({ step: 'docker', status: 'warn', message: 'Docker Compose plugin not detected — you may need to install it manually' });
  }

  // Ensure deploy is in docker group after potential install
  await sshAdmin('sudo usermod -aG docker deploy');

  // Step 5: Create directory structure
  onProgress({ step: 'dirs', status: 'running', message: 'Creating directory structure...' });
  const dirsScript = `
    set -e
    for dir in ${shellQuote(buildRoot)} ${shellQuote(stackRoot)} ${shellQuote(volumeRoot)}; do
      sudo mkdir -p "$dir"
      sudo chown deploy:deploy "$dir"
    done
    echo "DIRS_OK"
  `;
  const dirsResult = await sshAdmin(dirsScript);
  if (dirsResult.code !== 0 || !dirsResult.stdout.includes('DIRS_OK')) {
    onProgress({ step: 'dirs', status: 'error', message: `Failed to create directories: ${dirsResult.stderr.trim()}` });
    return;
  }
  onProgress({ step: 'dirs', status: 'ok', message: `Created ${buildRoot}, ${stackRoot}, ${volumeRoot}` });

  // Step 6: Verify deploy user connectivity
  onProgress({ step: 'verify', status: 'running', message: 'Verifying control-plane can connect as deploy...' });
  const deploySshOpts = [
    `-p ${sshPort}`,
    '-o BatchMode=yes',
    '-o ConnectTimeout=10',
    '-o StrictHostKeyChecking=accept-new',
    `-o UserKnownHostsFile=${shellQuote(`/tmp/gateway-control-plane-known-hosts-${nodeId}`)}`
  ].join(' ');
  const verifyResult = await runShellCapture(
    `ssh ${deploySshOpts} deploy@${host} ${shellQuote('echo ok')}`,
    process.cwd()
  );
  if (verifyResult.code !== 0) {
    onProgress({ step: 'verify', status: 'warn', message: 'deploy user SSH connection failed with BatchMode=yes — the key may need a moment to propagate, or group membership may need a re-login' });
  } else {
    onProgress({ step: 'verify', status: 'ok', message: `deploy@${host}:${sshPort} — key-based SSH working` });
  }

  // Check Docker access as deploy
  const dockerDeployCheck = await runShellCapture(
    `ssh ${deploySshOpts} deploy@${host} ${shellQuote('docker info >/dev/null 2>&1 && echo ok')}`,
    process.cwd()
  );
  if (dockerDeployCheck.code === 0 && dockerDeployCheck.stdout.includes('ok')) {
    onProgress({ step: 'verify', status: 'ok', message: 'deploy user has Docker access' });
  } else {
    onProgress({ step: 'verify', status: 'warn', message: 'deploy user cannot run Docker yet (group membership may require a re-login on the node)' });
  }

  // GPU hint
  if (request.nodeType === 'gpu') {
    onProgress({ step: 'verify', status: 'warn', message: 'GPU node: install the NVIDIA Container Toolkit separately, then restart Docker' });
  }

  // Emit final config block
  const nodeConfig: WorkerNodeConfig = {
    id: nodeId,
    enabled: true,
    description: request.description,
    host,
    sshUser: 'deploy',
    sshPort,
    buildRoot,
    stackRoot,
    volumeRoot,
    workerPollIntervalSeconds: request.workerPollIntervalSeconds,
    nodeCommand: 'node',
    dockerCommand: 'docker',
    dockerComposeCommand: 'docker compose'
  };

  onProgress({ step: 'complete', status: 'complete', message: 'Node setup finished', nodeConfig });
}
