import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type Slot = 'blue' | 'green';

export interface AdminUiSettings {
  enabled: boolean;
  host: string;
  port: number;
  routePath: string;
  serviceName: string;
  workingDirectory: string;
  configPath: string;
  buildOutDir: string;
  nodeExecutable: string;
  user: string;
  group?: string;
}

export interface GatewaySettings {
  serverNames: string[];
  nginxSiteOutputPath: string;
  upstreamDirectory: string;
  nginxReloadCommand: string;
  systemdUnitDirectory: string;
  systemdReloadCommand: string;
  systemdEnableTimerCommand: string;
  adminUi: AdminUiSettings;
}

export interface AppSlotConfig {
  port: number;
  startCommand: string;
  stopCommand: string;
}

export interface AppConfig {
  id: string;
  enabled: boolean;
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
  enabled: boolean;
  description: string;
  schedule: string;
  workingDirectory: string;
  execStart: string;
  user: string;
  group?: string;
  environmentFile?: string;
}

export interface FeatureFlagConfig {
  id: string;
  enabled: boolean;
  description: string;
}

export interface EnvironmentVariableConfig {
  key: string;
  value: string;
  secret: boolean;
  description?: string;
}

export interface GatewayApiServiceProfile {
  enabled: boolean;
  appId: string;
  apiBaseUrl: string;
  envFilePath: string;
  environment: EnvironmentVariableConfig[];
}

export interface ChatContextSourceConfig {
  id: string;
  type: 'url' | 'file' | 'database' | 'vector-store';
  location: string;
  description?: string;
}

export interface ChatRoutingPolicyConfig {
  allowedProviders: string[];
  preferredCostClass?: 'free' | 'cheap' | 'premium';
  requiredCapabilities: string[];
}

export interface ChatEndpointConfig {
  baseUrl?: string;
  apiKey?: string;
  modelParams?: Record<string, unknown>;
}

export interface GatewayChatAgentConfig {
  id: string;
  name: string;
  icon: string;
  color: string;
  providerName: string;
  model: string;
  costClass: 'free' | 'cheap' | 'premium';
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  enableReasoning?: boolean;
  enabled: boolean;
  featureFlags: Record<string, boolean>;
  routingPolicy?: ChatRoutingPolicyConfig;
  endpointConfig?: ChatEndpointConfig;
  contextSources: ChatContextSourceConfig[];
}

export interface GatewayChatPlatformServiceProfile {
  enabled: boolean;
  appId: string;
  apiBaseUrl: string;
  apiEnvFilePath: string;
  environment: EnvironmentVariableConfig[];
  agents: GatewayChatAgentConfig[];
}

export interface ServiceProfiles {
  gatewayApi: GatewayApiServiceProfile;
  gatewayChatPlatform: GatewayChatPlatformServiceProfile;
}

export interface GatewayConfig {
  gateway: GatewaySettings;
  apps: AppConfig[];
  scheduledJobs: ScheduledJobConfig[];
  features: FeatureFlagConfig[];
  serviceProfiles: ServiceProfiles;
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

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Expected boolean for ${field}`);
  }
  return value;
}

function assertPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected positive integer for ${field}`);
  }
  return value;
}

function assertNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Expected number for ${field}`);
  }
  return value;
}

function assertBooleanRecord(value: unknown, field: string): Record<string, boolean> {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  const record: Record<string, boolean> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate !== 'boolean') {
      throw new Error(`Expected boolean for ${field}.${key}`);
    }
    record[key] = candidate;
  }
  return record;
}

function assertUnknownRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
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
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
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
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    description: assertString(value.description, `scheduledJobs[${index}].description`),
    schedule: assertString(value.schedule, `scheduledJobs[${index}].schedule`),
    workingDirectory: assertString(value.workingDirectory, `scheduledJobs[${index}].workingDirectory`),
    execStart: assertString(value.execStart, `scheduledJobs[${index}].execStart`),
    user: assertString(value.user, `scheduledJobs[${index}].user`),
    group: typeof value.group === 'string' ? value.group : undefined,
    environmentFile: typeof value.environmentFile === 'string' ? value.environmentFile : undefined
  };
}

function parseFeatureFlagConfig(value: unknown, index: number): FeatureFlagConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for features[${index}]`);
  }

  return {
    id: assertString(value.id, `features[${index}].id`),
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    description: assertString(value.description, `features[${index}].description`)
  };
}

function parseEnvironmentVariableConfig(value: unknown, field: string): EnvironmentVariableConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  return {
    key: assertString(value.key, `${field}.key`),
    value: typeof value.value === 'string' ? value.value : '',
    secret: typeof value.secret === 'boolean' ? value.secret : false,
    description: typeof value.description === 'string' ? value.description : undefined
  };
}

function parseChatRoutingPolicy(value: unknown, field: string): ChatRoutingPolicyConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  const preferredCostClass = value.preferredCostClass;
  if (
    preferredCostClass !== undefined &&
    preferredCostClass !== 'free' &&
    preferredCostClass !== 'cheap' &&
    preferredCostClass !== 'premium'
  ) {
    throw new Error(`Invalid preferredCostClass for ${field}`);
  }

  return {
    allowedProviders: Array.isArray(value.allowedProviders)
      ? assertStringArray(value.allowedProviders, `${field}.allowedProviders`)
      : [],
    preferredCostClass,
    requiredCapabilities: Array.isArray(value.requiredCapabilities)
      ? assertStringArray(value.requiredCapabilities, `${field}.requiredCapabilities`)
      : []
  };
}

function parseChatEndpointConfig(value: unknown, field: string): ChatEndpointConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  return {
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : undefined,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey : undefined,
    modelParams: value.modelParams === undefined ? undefined : assertUnknownRecord(value.modelParams, `${field}.modelParams`)
  };
}

function parseContextSource(value: unknown, field: string): ChatContextSourceConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  const sourceType = value.type;
  if (sourceType !== 'url' && sourceType !== 'file' && sourceType !== 'database' && sourceType !== 'vector-store') {
    throw new Error(`Invalid type for ${field}.type`);
  }

  return {
    id: assertString(value.id, `${field}.id`),
    type: sourceType,
    location: assertString(value.location, `${field}.location`),
    description: typeof value.description === 'string' ? value.description : undefined
  };
}

function parseGatewayChatAgentConfig(value: unknown, field: string): GatewayChatAgentConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  const costClass = value.costClass;
  if (costClass !== 'free' && costClass !== 'cheap' && costClass !== 'premium') {
    throw new Error(`Invalid costClass for ${field}.costClass`);
  }

  return {
    id: assertString(value.id, `${field}.id`),
    name: assertString(value.name, `${field}.name`),
    icon: typeof value.icon === 'string' ? value.icon : '🤖',
    color: typeof value.color === 'string' ? value.color : '#6366f1',
    providerName: assertString(value.providerName, `${field}.providerName`),
    model: assertString(value.model, `${field}.model`),
    costClass,
    systemPrompt: typeof value.systemPrompt === 'string' ? value.systemPrompt : undefined,
    temperature: value.temperature === undefined ? undefined : assertNumber(value.temperature, `${field}.temperature`),
    maxTokens: value.maxTokens === undefined ? undefined : assertPositiveInteger(value.maxTokens, `${field}.maxTokens`),
    enableReasoning: typeof value.enableReasoning === 'boolean' ? value.enableReasoning : false,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    featureFlags: isRecord(value.featureFlags) ? assertBooleanRecord(value.featureFlags, `${field}.featureFlags`) : {},
    routingPolicy: value.routingPolicy === undefined ? undefined : parseChatRoutingPolicy(value.routingPolicy, `${field}.routingPolicy`),
    endpointConfig: value.endpointConfig === undefined ? undefined : parseChatEndpointConfig(value.endpointConfig, `${field}.endpointConfig`),
    contextSources: Array.isArray(value.contextSources)
      ? value.contextSources.map((source, index) => parseContextSource(source, `${field}.contextSources[${index}]`))
      : []
  };
}

function parseGatewayApiServiceProfile(value: unknown): GatewayApiServiceProfile {
  if (value === undefined) {
    return {
      enabled: false,
      appId: 'gateway-api',
      apiBaseUrl: 'http://127.0.0.1:3000',
      envFilePath: '/srv/apps/gateway-api/shared/gateway-api.env',
      environment: []
    };
  }

  if (!isRecord(value)) {
    throw new Error('Expected object for serviceProfiles.gatewayApi');
  }

  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    appId: assertString(value.appId, 'serviceProfiles.gatewayApi.appId'),
    apiBaseUrl: assertString(value.apiBaseUrl, 'serviceProfiles.gatewayApi.apiBaseUrl'),
    envFilePath: assertString(value.envFilePath, 'serviceProfiles.gatewayApi.envFilePath'),
    environment: Array.isArray(value.environment)
      ? value.environment.map((entry, index) => parseEnvironmentVariableConfig(entry, `serviceProfiles.gatewayApi.environment[${index}]`))
      : []
  };
}

function parseGatewayChatPlatformServiceProfile(value: unknown): GatewayChatPlatformServiceProfile {
  if (value === undefined) {
    return {
      enabled: false,
      appId: 'gateway-chat-platform',
      apiBaseUrl: 'http://127.0.0.1:3000',
      apiEnvFilePath: '/srv/apps/gateway-chat-platform/shared/chat-api.env',
      environment: [],
      agents: []
    };
  }

  if (!isRecord(value)) {
    throw new Error('Expected object for serviceProfiles.gatewayChatPlatform');
  }

  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    appId: assertString(value.appId, 'serviceProfiles.gatewayChatPlatform.appId'),
    apiBaseUrl: assertString(value.apiBaseUrl, 'serviceProfiles.gatewayChatPlatform.apiBaseUrl'),
    apiEnvFilePath: assertString(value.apiEnvFilePath, 'serviceProfiles.gatewayChatPlatform.apiEnvFilePath'),
    environment: Array.isArray(value.environment)
      ? value.environment.map((entry, index) => parseEnvironmentVariableConfig(entry, `serviceProfiles.gatewayChatPlatform.environment[${index}]`))
      : [],
    agents: Array.isArray(value.agents)
      ? value.agents.map((agent, index) => parseGatewayChatAgentConfig(agent, `serviceProfiles.gatewayChatPlatform.agents[${index}]`))
      : []
  };
}

function parseAdminUiSettings(value: unknown): AdminUiSettings {
  if (value === undefined) {
    return {
      enabled: false,
      host: '127.0.0.1',
      port: 4173,
      routePath: '/admin/',
      serviceName: 'gateway-control-plane.service',
      workingDirectory: '/opt/gateway-control-plane',
      configPath: '/opt/gateway-control-plane/configs/gateway.config.json',
      buildOutDir: '/opt/gateway-control-plane/generated',
      nodeExecutable: '/usr/bin/node',
      user: 'deploy'
    };
  }

  if (!isRecord(value)) {
    throw new Error('Expected object for gateway.adminUi');
  }

  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    host: assertString(value.host, 'gateway.adminUi.host'),
    port: assertPositiveInteger(value.port, 'gateway.adminUi.port'),
    routePath: assertString(value.routePath, 'gateway.adminUi.routePath'),
    serviceName: assertString(value.serviceName, 'gateway.adminUi.serviceName'),
    workingDirectory: assertString(value.workingDirectory, 'gateway.adminUi.workingDirectory'),
    configPath: assertString(value.configPath, 'gateway.adminUi.configPath'),
    buildOutDir: assertString(value.buildOutDir, 'gateway.adminUi.buildOutDir'),
    nodeExecutable: assertString(value.nodeExecutable, 'gateway.adminUi.nodeExecutable'),
    user: assertString(value.user, 'gateway.adminUi.user'),
    group: typeof value.group === 'string' ? value.group : undefined
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

  if (raw.features !== undefined && !Array.isArray(raw.features)) {
    throw new Error('features must be an array');
  }

  if (raw.serviceProfiles !== undefined && !isRecord(raw.serviceProfiles)) {
    throw new Error('serviceProfiles must be an object');
  }

  const gateway: GatewaySettings = {
    serverNames: assertStringArray(raw.gateway.serverNames, 'gateway.serverNames'),
    nginxSiteOutputPath: assertString(raw.gateway.nginxSiteOutputPath, 'gateway.nginxSiteOutputPath'),
    upstreamDirectory: assertString(raw.gateway.upstreamDirectory, 'gateway.upstreamDirectory'),
    nginxReloadCommand: assertString(raw.gateway.nginxReloadCommand, 'gateway.nginxReloadCommand'),
    systemdUnitDirectory: assertString(raw.gateway.systemdUnitDirectory, 'gateway.systemdUnitDirectory'),
    systemdReloadCommand: assertString(raw.gateway.systemdReloadCommand, 'gateway.systemdReloadCommand'),
    systemdEnableTimerCommand: assertString(raw.gateway.systemdEnableTimerCommand, 'gateway.systemdEnableTimerCommand'),
    adminUi: parseAdminUiSettings(raw.gateway.adminUi)
  };

  const apps = raw.apps.map(parseAppConfig);
  const scheduledJobs = raw.scheduledJobs.map(parseScheduledJobConfig);
  const features = Array.isArray(raw.features) ? raw.features.map(parseFeatureFlagConfig) : [];
  const serviceProfilesRaw = isRecord(raw.serviceProfiles) ? raw.serviceProfiles : {};
  const serviceProfiles: ServiceProfiles = {
    gatewayApi: parseGatewayApiServiceProfile(serviceProfilesRaw.gatewayApi),
    gatewayChatPlatform: parseGatewayChatPlatformServiceProfile(serviceProfilesRaw.gatewayChatPlatform)
  };

  for (const job of scheduledJobs) {
    if (!apps.find((app) => app.id === job.appId)) {
      throw new Error(`scheduled job ${job.id} references unknown app ${job.appId}`);
    }
  }

  if (serviceProfiles.gatewayApi.enabled && !apps.find((app) => app.id === serviceProfiles.gatewayApi.appId)) {
    throw new Error(`service profile gatewayApi references unknown app ${serviceProfiles.gatewayApi.appId}`);
  }

  if (
    serviceProfiles.gatewayChatPlatform.enabled &&
    !apps.find((app) => app.id === serviceProfiles.gatewayChatPlatform.appId)
  ) {
    throw new Error(
      `service profile gatewayChatPlatform references unknown app ${serviceProfiles.gatewayChatPlatform.appId}`
    );
  }

  return { gateway, apps, scheduledJobs, features, serviceProfiles };
}

export async function loadGatewayConfig(configPath: string): Promise<GatewayConfig> {
  const absolutePath = resolve(configPath);
  const fileText = await readFile(absolutePath, 'utf8');
  const parsed = JSON.parse(fileText) as unknown;
  return parseGatewayConfig(parsed);
}

export async function saveGatewayConfig(configPath: string, config: GatewayConfig): Promise<void> {
  const absolutePath = resolve(configPath);
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(absolutePath, serialized, 'utf8');
}

export function getApp(config: GatewayConfig, appId: string): AppConfig {
  const app = config.apps.find((candidate) => candidate.id === appId);
  if (!app) {
    throw new Error(`Unknown app id: ${appId}`);
  }
  if (!app.enabled) {
    throw new Error(`App is disabled: ${appId}`);
  }
  return app;
}

export function getJobsForApp(config: GatewayConfig, appId: string): ScheduledJobConfig[] {
  return config.scheduledJobs.filter((job) => job.appId === appId && job.enabled);
}
