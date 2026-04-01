import type { GatewayConfig, RemoteWorkloadConfig, WorkerNodeConfig } from './config.ts';
import {
  getRemoteWorkloadDataDir,
  getRemoteWorkloadProjectName,
  getRemoteWorkloadStackDir
} from './remote-workloads.ts';

export interface RenderedRemoteWorkerFile {
  relativePath: string;
  contents: string;
}

function jsonString(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function getRemoteWorkerRuntimeDir(node: WorkerNodeConfig): string {
  return `${node.stackRoot}/_gateway-worker`;
}

function sanitizeWorkerName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9-]+/g, '-').replaceAll(/^-+|-+$/g, '') || 'worker';
}

export function getRemoteWorkerProjectName(node: WorkerNodeConfig): string {
  return `gateway-worker-${sanitizeWorkerName(node.id)}`;
}

interface WorkerRuntimeMount {
  source: string;
  target: string;
  readOnly: boolean;
}

function addWorkerMount(mounts: Map<string, WorkerRuntimeMount>, source: string | undefined, readOnly: boolean): void {
  if (!source || source.trim().length === 0) {
    return;
  }
  const existing = mounts.get(source);
  if (!existing) {
    mounts.set(source, { source, target: source, readOnly });
    return;
  }
  if (!readOnly) {
    existing.readOnly = false;
  }
}

function collectWorkerRuntimeMounts(config: GatewayConfig, node: WorkerNodeConfig): WorkerRuntimeMount[] {
  const mounts = new Map<string, WorkerRuntimeMount>();
  addWorkerMount(mounts, node.buildRoot, false);
  addWorkerMount(mounts, node.stackRoot, false);
  addWorkerMount(mounts, node.volumeRoot, false);

  for (const workload of config.remoteWorkloads.filter((candidate) => candidate.enabled && candidate.nodeId === node.id)) {
    if (workload.kind !== 'minecraft-bedrock-server' || !workload.minecraft) {
      continue;
    }
    addWorkerMount(mounts, workload.minecraft.worldSourcePath, true);
    for (const pack of workload.minecraft.behaviorPacks) {
      addWorkerMount(mounts, pack.sourcePath, true);
    }
    for (const pack of workload.minecraft.resourcePacks) {
      addWorkerMount(mounts, pack.sourcePath, true);
    }
  }

  return Array.from(mounts.values()).sort((left, right) => left.source.localeCompare(right.source));
}

function renderRemoteWorkerConfig(config: GatewayConfig, node: WorkerNodeConfig): string {
  const workloads = config.remoteWorkloads
    .filter((candidate) => candidate.enabled && candidate.nodeId === node.id)
    .map((workload) => {
      const base = {
        id: workload.id,
        description: workload.description,
        kind: workload.kind,
        stackDir: getRemoteWorkloadStackDir(node, workload),
        dataDir: getRemoteWorkloadDataDir(node, workload),
        composeFile: `${getRemoteWorkloadStackDir(node, workload)}/compose.yml`,
        projectName: getRemoteWorkloadProjectName(workload)
      };

      if (workload.kind === 'scheduled-container-job' && workload.job) {
        return {
          ...base,
          job: {
            schedule: workload.job.schedule,
            timezone: workload.job.timezone
          }
        };
      }

      if (workload.kind === 'minecraft-bedrock-server' && workload.minecraft) {
        return {
          ...base,
          minecraft: {
            autoStart: workload.minecraft.autoStart,
            autoUpdateEnabled: workload.minecraft.autoUpdateEnabled,
            autoUpdateSchedule: workload.minecraft.autoUpdateSchedule,
            bootstrapScript: `${getRemoteWorkloadStackDir(node, workload)}/scripts/bootstrap-world.sh`,
            updateScript: `${getRemoteWorkloadStackDir(node, workload)}/scripts/update-if-empty.sh`
          }
        };
      }

      return base;
    });

  return jsonString({
    version: 1,
    nodeId: node.id,
    runtimeDir: '/runtime',
    pollIntervalSeconds: node.workerPollIntervalSeconds,
    dockerComposeCommand: 'docker compose',
    workloads
  });
}

function renderRemoteWorkerDockerfile(): string {
  return `FROM docker:28-cli
RUN apk add --no-cache nodejs unzip
WORKDIR /app
COPY gateway-worker.mjs ./gateway-worker.mjs
ENTRYPOINT ["node", "/app/gateway-worker.mjs"]
CMD ["run", "--config", "/runtime/worker-config.json"]
`;
}

function renderRemoteWorkerCompose(config: GatewayConfig, node: WorkerNodeConfig): string {
  const runtimeDir = getRemoteWorkerRuntimeDir(node);
  const mounts = [
    '/var/run/docker.sock:/var/run/docker.sock',
    `${runtimeDir}:/runtime`,
    ...collectWorkerRuntimeMounts(config, node).map((mount) =>
      `${mount.source}:${mount.target}${mount.readOnly ? ':ro' : ''}`
    )
  ];

  return [
    'services:',
    '  gateway-worker:',
    '    build:',
    `      context: ${JSON.stringify(runtimeDir)}`,
    `      dockerfile: ${JSON.stringify(`${runtimeDir}/Dockerfile`)}`,
    '    command:',
    `      - ${JSON.stringify('run')}`,
    `      - ${JSON.stringify('--config')}`,
    `      - ${JSON.stringify('/runtime/worker-config.json')}`,
    '    restart: unless-stopped',
    `    container_name: ${JSON.stringify(`${getRemoteWorkerProjectName(node)}-service`)}`,
    '    volumes:',
    ...mounts.map((mount) => `      - ${JSON.stringify(mount)}`),
    ''
  ].join('\n');
}

function renderRemoteWorkerScript(): string {
  return `#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\\\''") + "'";
}

async function readJson(path, fallback) {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\\n', 'utf8');
}

function log(message) {
  console.log(new Date().toISOString() + ' ' + message);
}

async function runShell(command) {
  log('$ ' + command);
  await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-lc', command], { stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error('Command failed (' + code + '): ' + command));
    });
    child.on('error', reject);
  });
}

async function runShellCapture(command) {
  log('$ ' + command);
  return await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-lc', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      process.stderr.write(chunk);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeUpdateResult(status, detail) {
  switch (status) {
    case 'force-updated':
      return detail || 'Force update applied';
    case 'updated-version':
      return detail || 'Server version updated';
    case 'updated':
      return detail || 'Server image updated';
    case 'no-version-change':
      return detail || 'Server restarted, but the version did not change';
    case 'no-image-change':
      return detail || 'No new Bedrock version or image change was detected';
    case 'skipped-player-count-unknown':
      return detail || 'Skipped because player count could not be determined';
    case 'skipped-players-online':
      return detail || 'Skipped because players were online';
    default:
      return detail || 'Safe update finished';
  }
}

function parseMinecraftUpdateResult(stdout, stderr) {
  const combined = [stdout, stderr].filter(Boolean).join('\\n');
  const lines = combined
    .split(/\\r?\\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const statusLine = lines.find((line) => line.startsWith('__GCP_UPDATE_STATUS__ '));
  const detailLine = lines.find((line) => line.startsWith('__GCP_UPDATE_DETAIL__ '));
  const status = statusLine ? statusLine.slice('__GCP_UPDATE_STATUS__ '.length).trim() : 'completed';
  const detail = detailLine ? detailLine.slice('__GCP_UPDATE_DETAIL__ '.length).trim() : '';
  const cleanOutput = (text) => text
    .split(/\\r?\\n/u)
    .filter((line) => !line.startsWith('__GCP_UPDATE_STATUS__ ') && !line.startsWith('__GCP_UPDATE_DETAIL__ '))
    .join('\\n')
    .trim();
  return {
    status,
    summary: summarizeUpdateResult(status, detail),
    detail: detail || undefined,
    stdout: cleanOutput(stdout) || undefined,
    stderr: cleanOutput(stderr) || undefined,
    recordedAt: new Date().toISOString()
  };
}

function buildFailedMinecraftActionResult(action, error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    action,
    status: 'failed',
    summary: message,
    detail: message,
    recordedAt: new Date().toISOString()
  };
}

async function readWorkerState(statePath) {
  return await readJson(statePath, { tasks: {} });
}

async function recordMinecraftActionResult(statePath, key, action, result) {
  const state = await readWorkerState(statePath);
  state.tasks[key] = {
    ...(state.tasks[key] || {}),
    lastRunAt: new Date().toISOString(),
    lastAction: action,
    lastResult: result
  };
  await writeJson(statePath, state);
}

function getDateParts(date, timeZone) {
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

function getSlotForSchedule(schedule, now, timeZone, windowSeconds) {
  const everyMinutes = /^\\*:(\\d{1,2})\\/(\\d{1,2})$/u.exec(schedule);
  if (everyMinutes) {
    const start = Number(everyMinutes[1]);
    const step = Number(everyMinutes[2]);
    const parts = getDateParts(now, timeZone);
    if (parts.second >= windowSeconds || parts.minute < start || (parts.minute - start) % step !== 0) {
      return null;
    }
    const bucket = Math.floor((parts.minute - start) / step);
    return 'interval:' + [parts.year, parts.month, parts.day, parts.hour, bucket].join('-');
  }

  const daily = /^\\*-\\*-\\* (\\d{2}):(\\d{2}):(\\d{2})$/u.exec(schedule);
  if (daily) {
    const targetHour = Number(daily[1]);
    const targetMinute = Number(daily[2]);
    const targetSecond = Number(daily[3]);
    const parts = getDateParts(now, timeZone);
    if (
      parts.hour !== targetHour ||
      parts.minute !== targetMinute ||
      parts.second < targetSecond ||
      parts.second >= targetSecond + windowSeconds
    ) {
      return null;
    }
    return 'daily:' + [parts.year, parts.month, parts.day, targetHour, targetMinute].join('-');
  }

  return null;
}

function buildComposeCommand(config, workload) {
  return config.dockerComposeCommand
    + ' -f ' + shellQuote(workload.composeFile)
    + ' --project-name ' + shellQuote(workload.projectName);
}

async function bootstrapMinecraft(config, workload) {
  if (!workload.minecraft?.bootstrapScript) {
    return;
  }
  await runShell('chmod +x ' + shellQuote(workload.minecraft.bootstrapScript));
  await runShell(shellQuote(workload.minecraft.bootstrapScript));
}

async function runScheduledJob(config, workload) {
  const composeCommand = buildComposeCommand(config, workload);
  await runShell(composeCommand + ' run --rm runner');
}

async function runMinecraftAction(config, workload, action, payload) {
  const composeCommand = buildComposeCommand(config, workload);
  switch (action) {
    case 'start':
      await bootstrapMinecraft(config, workload);
      await runShell(composeCommand + ' pull server');
      await runShell(composeCommand + ' up -d server');
      return {
        action,
        status: 'completed',
        summary: 'Server started',
        recordedAt: new Date().toISOString()
      };
    case 'stop':
      await runShell(composeCommand + ' stop server');
      return {
        action,
        status: 'completed',
        summary: 'Server stopped',
        recordedAt: new Date().toISOString()
      };
    case 'restart':
      await bootstrapMinecraft(config, workload);
      await runShell(composeCommand + ' pull server');
      await runShell(composeCommand + ' up -d --force-recreate server');
      return {
        action,
        status: 'completed',
        summary: 'Server restarted',
        recordedAt: new Date().toISOString()
      };
    case 'update-if-empty':
      if (!workload.minecraft?.updateScript) {
        throw new Error('Update script is not configured for workload ' + workload.id);
      }
      await runShell('chmod +x ' + shellQuote(workload.minecraft.updateScript));
      {
        const updateCommand = shellQuote(workload.minecraft.updateScript);
        const output = await runShellCapture(updateCommand);
        const result = {
          action,
          ...parseMinecraftUpdateResult(output.stdout, output.stderr)
        };
        if (output.code !== 0) {
          const error = new Error(result.summary || 'Safe update failed');
          error.result = result;
          throw error;
        }
        return result;
      }
    case 'force-update':
      if (!workload.minecraft?.updateScript) {
        throw new Error('Update script is not configured for workload ' + workload.id);
      }
      await runShell('chmod +x ' + shellQuote(workload.minecraft.updateScript));
      {
        const updateCommand = 'GCP_BEDROCK_UPDATE_MODE=force ' + shellQuote(workload.minecraft.updateScript);
        const output = await runShellCapture(updateCommand);
        const result = {
          action,
          ...parseMinecraftUpdateResult(output.stdout, output.stderr)
        };
        if (output.code !== 0) {
          const error = new Error(result.summary || 'Force update failed');
          error.result = result;
          throw error;
        }
        return result;
      }
    case 'broadcast': {
      const message = String(payload.message || '').trim();
      if (!message) {
        throw new Error('Broadcast message is required');
      }
      await runShell(composeCommand + ' exec -T server send-command ' + shellQuote('say ' + message));
      return {
        action,
        status: 'completed',
        summary: 'Broadcast sent',
        recordedAt: new Date().toISOString()
      };
    }
    case 'kick':
    case 'ban': {
      const player = String(payload.player || '').trim();
      if (!player) {
        throw new Error(action + ' player is required');
      }
      const reason = String(payload.reason || '').trim();
      const command = reason ? action + ' ' + player + ' ' + reason : action + ' ' + player;
      await runShell(composeCommand + ' exec -T server send-command ' + shellQuote(command));
      return {
        action,
        status: 'completed',
        summary: action + ' command sent for ' + player,
        recordedAt: new Date().toISOString()
      };
    }
    default:
      throw new Error('Unsupported action: ' + action);
  }
}

async function runDueTasks(configPath) {
  const config = await readJson(configPath);
  const statePath = config.runtimeDir + '/worker-state.json';
  const state = await readWorkerState(statePath);
  const pollWindow = Number(config.pollIntervalSeconds) > 0 ? Number(config.pollIntervalSeconds) : 15;
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  for (const workload of config.workloads || []) {
    if (workload.kind === 'scheduled-container-job' && workload.job) {
      const slot = getSlotForSchedule(workload.job.schedule, new Date(), workload.job.timezone || localTimeZone, pollWindow);
      if (slot && state.tasks['job:' + workload.id]?.lastSlot !== slot) {
        log('Running scheduled job ' + workload.id + ' for slot ' + slot);
        await runScheduledJob(config, workload);
        state.tasks['job:' + workload.id] = {
          lastSlot: slot,
          lastRunAt: new Date().toISOString()
        };
        await writeJson(statePath, state);
      }
    }

    if (
      workload.kind === 'minecraft-bedrock-server' &&
      workload.minecraft?.autoUpdateEnabled &&
      workload.minecraft.autoUpdateSchedule
    ) {
      const slot = getSlotForSchedule(workload.minecraft.autoUpdateSchedule, new Date(), localTimeZone, pollWindow);
      if (slot && state.tasks['minecraft-update:' + workload.id]?.lastSlot !== slot) {
        log('Running Bedrock auto-update for ' + workload.id + ' slot ' + slot);
        try {
          const result = await runMinecraftAction(config, workload, 'update-if-empty', {});
          state.tasks['minecraft-update:' + workload.id] = {
            lastSlot: slot,
            lastRunAt: new Date().toISOString(),
            lastAction: 'update-if-empty',
            lastResult: result
          };
          await writeJson(statePath, state);
        } catch (error) {
          state.tasks['minecraft-update:' + workload.id] = {
            lastSlot: slot,
            lastRunAt: new Date().toISOString(),
            lastAction: 'update-if-empty',
            lastResult: error && typeof error === 'object' && 'result' in error
              ? error.result
              : buildFailedMinecraftActionResult('update-if-empty', error)
          };
          await writeJson(statePath, state);
          throw error;
        }
      }
    }
  }
}

async function runLoop(configPath) {
  while (true) {
    try {
      await runDueTasks(configPath);
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      log('Worker loop error: ' + message);
    }
    const config = await readJson(configPath);
    const pollSeconds = Number(config.pollIntervalSeconds) > 0 ? Number(config.pollIntervalSeconds) : 15;
    await sleep(pollSeconds * 1000);
  }
}

async function main() {
  const [command = 'run', ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const configPath = typeof args.config === 'string' ? args.config : './worker-config.json';
  if (command === 'run') {
    await runLoop(configPath);
    return;
  }
  if (command === 'control') {
    const workloadId = typeof args.workload === 'string' ? args.workload : '';
    const action = typeof args.action === 'string' ? args.action : '';
    const payload = typeof args.payload === 'string' ? JSON.parse(args.payload) : {};
    const config = await readJson(configPath);
    const statePath = config.runtimeDir + '/worker-state.json';
    const workload = (config.workloads || []).find((candidate) => candidate.id === workloadId);
    if (!workload) {
      throw new Error('Unknown workload id: ' + workloadId);
    }
    try {
      const result = await runMinecraftAction(config, workload, action, payload);
      await recordMinecraftActionResult(statePath, 'minecraft-control:' + action + ':' + workloadId, action, result);
      console.log('__CONTROL_RESULT__ ' + JSON.stringify(result));
    } catch (error) {
      const result = error && typeof error === 'object' && 'result' in error
        ? error.result
        : buildFailedMinecraftActionResult(action, error);
      await recordMinecraftActionResult(statePath, 'minecraft-control:' + action + ':' + workloadId, action, result);
      console.log('__CONTROL_RESULT__ ' + JSON.stringify(result));
      throw error;
    }
    return;
  }
  throw new Error('Unknown command: ' + command);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
`;
}

export function renderRemoteWorkerFiles(config: GatewayConfig, node: WorkerNodeConfig): RenderedRemoteWorkerFile[] {
  return [
    {
      relativePath: 'worker-config.json',
      contents: renderRemoteWorkerConfig(config, node)
    },
    {
      relativePath: 'gateway-worker.mjs',
      contents: renderRemoteWorkerScript()
    },
    {
      relativePath: 'Dockerfile',
      contents: renderRemoteWorkerDockerfile()
    },
    {
      relativePath: 'compose.yml',
      contents: renderRemoteWorkerCompose(config, node)
    }
  ];
}
