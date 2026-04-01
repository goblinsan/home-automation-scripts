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
  context.log(`${context.dryRun ? '[dry-run] ' : ''}${command}`);
  if (context.dryRun) {
    return;
  }

  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: 'inherit' });
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

async function runShellCapture(command: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('exit', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
    child.on('error', reject);
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

async function runRemoteShellCapture(node: WorkerNodeConfig, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return await runShellCapture(`ssh ${sshOptions(node)} ${sshTarget(node)} ${shellQuote(command)}`, process.cwd());
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

    context.log(`${context.dryRun ? '[dry-run] ' : ''}install ${servicePath}`);
    context.log(`${context.dryRun ? '[dry-run] ' : ''}install ${timerPath}`);
    if (!context.dryRun) {
      await mkdir(dirname(servicePath), { recursive: true });
      await writeFile(servicePath, serviceBody, 'utf8');
      await writeFile(timerPath, timerBody, 'utf8');
    }

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

  context.log(`${context.dryRun ? '[dry-run] ' : ''}install ${servicePath}`);
  if (!context.dryRun) {
    await mkdir(dirname(servicePath), { recursive: true });
    await writeFile(servicePath, serviceBody, 'utf8');
  }

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
  ports?: Record<string, unknown> | null;
  error?: string;
}

export interface MinecraftWorkloadStatus {
  workloadId: string;
  nodeId: string;
  configuredServerPort: number | null;
  worker: RemoteContainerStatus;
  server: RemoteContainerStatus;
  autoUpdate: MinecraftAutoUpdateStatus;
  lastManualUpdateResult: MinecraftActionResult | null;
}

type MinecraftControlAction = 'start' | 'stop' | 'restart' | 'broadcast' | 'kick' | 'ban' | 'update-if-empty' | 'force-update';

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
  if (!(workload.kind === 'scheduled-container-job' && workload.job)) {
    return;
  }

  const sourceDir = getRemoteWorkloadSourceDir(node, workload);
  const revision = revisionOverride ?? workload.job.build.defaultRevision;
  const repoUrl = workload.job.build.repoUrl;

  await runRemoteShell(node, `mkdir -p ${shellQuote(join(sourceDir, '..'))}`, context);
  await runRemoteShell(
    node,
    `[ -d ${shellQuote(join(sourceDir, '.git'))} ] || git clone ${shellQuote(repoUrl)} ${shellQuote(sourceDir)}`,
    context
  );
  await runRemoteShell(node, `git -C ${shellQuote(sourceDir)} fetch --all --tags --prune`, context);
  await runRemoteShell(node, `git -C ${shellQuote(sourceDir)} checkout --force ${shellQuote(revision)}`, context);
}

async function inspectRemoteContainer(node: WorkerNodeConfig, containerName: string): Promise<RemoteContainerStatus> {
  const inspectCommand = [
    `if ${node.dockerCommand} inspect ${shellQuote(containerName)} >/dev/null 2>&1; then`,
    `${node.dockerCommand} inspect ${shellQuote(containerName)} --format ${shellQuote('{{json .State}}@@{{json .NetworkSettings.Ports}}@@{{.HostConfig.NetworkMode}}')};`,
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

  const output = result.stdout.trim();
  if (output === '__MISSING__') {
    return {
      containerName,
      exists: false,
      status: 'missing',
      running: false
    };
  }

  const [stateJson = '{}', portsJson = 'null', networkMode = ''] = output.split('@@');
  try {
    const state = JSON.parse(stateJson) as { Status?: string; Running?: boolean; StartedAt?: string };
    const ports = JSON.parse(portsJson) as Record<string, unknown> | null;
    return {
      containerName,
      exists: true,
      status: typeof state.Status === 'string' ? state.Status : 'unknown',
      running: Boolean(state.Running),
      networkMode: networkMode || undefined,
      startedAt: typeof state.StartedAt === 'string' ? state.StartedAt : undefined,
      ports
    };
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
  const workerTimeZone = worker.running ? await readRemoteWorkerTimeZone(node, workerContainerName) : null;
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
