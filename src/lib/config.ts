import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type Slot = 'blue' | 'green';

export interface GatewaySettings {
  serverNames: string[];
  nginxSiteOutputPath: string;
  upstreamDirectory: string;
  nginxReloadCommand: string;
  systemdUnitDirectory: string;
  systemdReloadCommand: string;
  systemdEnableTimerCommand: string;
}

export interface AppSlotConfig {
  port: number;
  startCommand: string;
  stopCommand: string;
}

export interface AppConfig {
  id: string;
  repoUrl: string;
  defaultRevision: string;
  deployRoot: string;
  routePath: string;
  healthPath: string;
  upstreamConfPath: string;
  buildCommands: string[];
  slots: Record<Slot, AppSlotConfig>;
}

export interface ScheduledJobConfig {
  id: string;
  appId: string;
  description: string;
  schedule: string;
  workingDirectory: string;
  execStart: string;
  user: string;
  group?: string;
  environmentFile?: string;
}

export interface GatewayConfig {
  gateway: GatewaySettings;
  apps: AppConfig[];
  scheduledJobs: ScheduledJobConfig[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected non-empty string for ${field}`);
  }
  return value;
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`Expected string[] for ${field}`);
  }
  return value;
}

function assertSlotConfig(value: unknown, field: string): AppSlotConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  const port = value.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
    throw new Error(`Expected positive integer port for ${field}.port`);
  }

  return {
    port,
    startCommand: assertString(value.startCommand, `${field}.startCommand`),
    stopCommand: assertString(value.stopCommand, `${field}.stopCommand`)
  };
}

function parseAppConfig(value: unknown, index: number): AppConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for apps[${index}]`);
  }

  if (!isRecord(value.slots)) {
    throw new Error(`Expected object for apps[${index}].slots`);
  }

  return {
    id: assertString(value.id, `apps[${index}].id`),
    repoUrl: assertString(value.repoUrl, `apps[${index}].repoUrl`),
    defaultRevision: assertString(value.defaultRevision, `apps[${index}].defaultRevision`),
    deployRoot: assertString(value.deployRoot, `apps[${index}].deployRoot`),
    routePath: assertString(value.routePath, `apps[${index}].routePath`),
    healthPath: assertString(value.healthPath, `apps[${index}].healthPath`),
    upstreamConfPath: assertString(value.upstreamConfPath, `apps[${index}].upstreamConfPath`),
    buildCommands: assertStringArray(value.buildCommands, `apps[${index}].buildCommands`),
    slots: {
      blue: assertSlotConfig(value.slots.blue, `apps[${index}].slots.blue`),
      green: assertSlotConfig(value.slots.green, `apps[${index}].slots.green`)
    }
  };
}

function parseScheduledJobConfig(value: unknown, index: number): ScheduledJobConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for scheduledJobs[${index}]`);
  }

  return {
    id: assertString(value.id, `scheduledJobs[${index}].id`),
    appId: assertString(value.appId, `scheduledJobs[${index}].appId`),
    description: assertString(value.description, `scheduledJobs[${index}].description`),
    schedule: assertString(value.schedule, `scheduledJobs[${index}].schedule`),
    workingDirectory: assertString(value.workingDirectory, `scheduledJobs[${index}].workingDirectory`),
    execStart: assertString(value.execStart, `scheduledJobs[${index}].execStart`),
    user: assertString(value.user, `scheduledJobs[${index}].user`),
    group: typeof value.group === 'string' ? value.group : undefined,
    environmentFile: typeof value.environmentFile === 'string' ? value.environmentFile : undefined
  };
}

export function parseGatewayConfig(raw: unknown): GatewayConfig {
  if (!isRecord(raw)) {
    throw new Error('Gateway config must be an object');
  }

  if (!isRecord(raw.gateway)) {
    throw new Error('gateway must be an object');
  }

  if (!Array.isArray(raw.apps) || raw.apps.length === 0) {
    throw new Error('apps must be a non-empty array');
  }

  if (!Array.isArray(raw.scheduledJobs)) {
    throw new Error('scheduledJobs must be an array');
  }

  const gateway: GatewaySettings = {
    serverNames: assertStringArray(raw.gateway.serverNames, 'gateway.serverNames'),
    nginxSiteOutputPath: assertString(raw.gateway.nginxSiteOutputPath, 'gateway.nginxSiteOutputPath'),
    upstreamDirectory: assertString(raw.gateway.upstreamDirectory, 'gateway.upstreamDirectory'),
    nginxReloadCommand: assertString(raw.gateway.nginxReloadCommand, 'gateway.nginxReloadCommand'),
    systemdUnitDirectory: assertString(raw.gateway.systemdUnitDirectory, 'gateway.systemdUnitDirectory'),
    systemdReloadCommand: assertString(raw.gateway.systemdReloadCommand, 'gateway.systemdReloadCommand'),
    systemdEnableTimerCommand: assertString(raw.gateway.systemdEnableTimerCommand, 'gateway.systemdEnableTimerCommand')
  };

  const apps = raw.apps.map(parseAppConfig);
  const scheduledJobs = raw.scheduledJobs.map(parseScheduledJobConfig);

  for (const job of scheduledJobs) {
    if (!apps.find((app) => app.id === job.appId)) {
      throw new Error(`scheduled job ${job.id} references unknown app ${job.appId}`);
    }
  }

  return { gateway, apps, scheduledJobs };
}

export async function loadGatewayConfig(configPath: string): Promise<GatewayConfig> {
  const absolutePath = resolve(configPath);
  const fileText = await readFile(absolutePath, 'utf8');
  const parsed = JSON.parse(fileText) as unknown;
  return parseGatewayConfig(parsed);
}

export function getApp(config: GatewayConfig, appId: string): AppConfig {
  const app = config.apps.find((candidate) => candidate.id === appId);
  if (!app) {
    throw new Error(`Unknown app id: ${appId}`);
  }
  return app;
}

export function getJobsForApp(config: GatewayConfig, appId: string): ScheduledJobConfig[] {
  return config.scheduledJobs.filter((job) => job.appId === appId);
}

