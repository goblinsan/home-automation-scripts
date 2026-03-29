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
    runtimeDir: getRemoteWorkerRuntimeDir(node),
    pollIntervalSeconds: node.workerPollIntervalSeconds,
    dockerComposeCommand: node.dockerComposeCommand,
    workloads
  });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      await runShell(composeCommand + ' up -d server');
      return;
    case 'stop':
      await runShell(composeCommand + ' stop server');
      return;
    case 'restart':
      await bootstrapMinecraft(config, workload);
      await runShell(composeCommand + ' restart server');
      return;
    case 'update-if-empty':
      if (!workload.minecraft?.updateScript) {
        throw new Error('Update script is not configured for workload ' + workload.id);
      }
      await runShell('chmod +x ' + shellQuote(workload.minecraft.updateScript));
      await runShell(shellQuote(workload.minecraft.updateScript));
      return;
    case 'broadcast': {
      const message = String(payload.message || '').trim();
      if (!message) {
        throw new Error('Broadcast message is required');
      }
      await runShell(composeCommand + ' exec -T server send-command ' + shellQuote('say ' + message));
      return;
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
      return;
    }
    default:
      throw new Error('Unsupported action: ' + action);
  }
}

async function runDueTasks(configPath) {
  const config = await readJson(configPath);
  const statePath = config.runtimeDir + '/worker-state.json';
  const state = await readJson(statePath, { tasks: {} });
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
        await runMinecraftAction(config, workload, 'update-if-empty', {});
        state.tasks['minecraft-update:' + workload.id] = {
          lastSlot: slot,
          lastRunAt: new Date().toISOString()
        };
        await writeJson(statePath, state);
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
    const workload = (config.workloads || []).find((candidate) => candidate.id === workloadId);
    if (!workload) {
      throw new Error('Unknown workload id: ' + workloadId);
    }
    await runMinecraftAction(config, workload, action, payload);
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
    }
  ];
}
