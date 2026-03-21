import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { getApp, getJobsForApp, type AppConfig, type GatewayConfig, type ScheduledJobConfig, type Slot } from './config.ts';
import { renderActiveUpstream } from './nginx.ts';
import { renderJobService, renderJobTimer } from './systemd.ts';

export interface CommandContext {
  dryRun: boolean;
  log: (message: string) => void;
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

async function ensureDirectory(path: string, context: CommandContext): Promise<void> {
  context.log(`${context.dryRun ? '[dry-run] ' : ''}mkdir -p ${path}`);
  if (!context.dryRun) {
    await mkdir(path, { recursive: true });
  }
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

  await runShell(`git checkout --force ${revision}`, slotDir, context);
  return slotDir;
}

async function buildSlot(app: AppConfig, slotDir: string, context: CommandContext): Promise<void> {
  for (const command of app.buildCommands) {
    await runShell(command, slotDir, context);
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

export async function smokeTest(url: string, expectedStatus = 200): Promise<void> {
  const status = await httpGet(url);
  if (status !== expectedStatus) {
    throw new Error(`Smoke test failed for ${url}: expected ${expectedStatus}, got ${status}`);
  }
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

  await buildSlot(app, slotDir, context);
  await runShell(app.slots[target].startCommand, slotDir, context);
  await smokeTest(`http://127.0.0.1:${app.slots[target].port}${app.healthPath}`);
  await writeActiveUpstream(app, target, context);
  await runShell(config.gateway.nginxReloadCommand, process.cwd(), context);
  await setCurrentPointers(app, target, context);
  await installJobs(config, appId, context);
}

export async function rollbackApp(config: GatewayConfig, appId: string, context: CommandContext): Promise<void> {
  const app = getApp(config, appId);
  const current = await readCurrentSlot(app);
  const target = oppositeSlot(current);

  await runShell(app.slots[target].startCommand, join(app.deployRoot, target), context);
  await smokeTest(`http://127.0.0.1:${app.slots[target].port}${app.healthPath}`);
  await writeActiveUpstream(app, target, context);
  await runShell(config.gateway.nginxReloadCommand, process.cwd(), context);
  await setCurrentPointers(app, target, context);
}

