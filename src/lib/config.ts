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
  hostnames: string[];
  routePath: string;
  stripRoutePrefix: boolean;
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

export interface WorkerNodeConfig {
  id: string;
  enabled: boolean;
  description: string;
  host: string;
  sshUser: string;
  sshPort: number;
  buildRoot: string;
  stackRoot: string;
  volumeRoot: string;
  workerPollIntervalSeconds: number;
  nodeCommand: string;
  systemdUnitDirectory?: string;
  systemdReloadCommand?: string;
  systemdEnableTimerCommand?: string;
  dockerCommand: string;
  dockerComposeCommand: string;
}

export interface VolumeMountConfig {
  source: string;
  target: string;
  readOnly: boolean;
}

export interface JsonFileConfig {
  relativePath: string;
  payload: Record<string, unknown>;
  description?: string;
}

export interface ScheduledContainerJobBuildConfig {
  strategy: 'repo-dockerfile' | 'generated-node';
  repoUrl: string;
  defaultRevision: string;
  contextPath: string;
  dockerfilePath?: string;
  packageRoot?: string;
  nodeVersion?: string;
  installCommand?: string;
}

export interface ScheduledContainerJobWorkloadConfig {
  schedule: string;
  timezone: string;
  build: ScheduledContainerJobBuildConfig;
  runCommand: string;
  environment: EnvironmentVariableConfig[];
  volumeMounts: VolumeMountConfig[];
  jsonFiles: JsonFileConfig[];
}

export interface ContainerServicePortConfig {
  published: number;
  target: number;
  protocol: 'tcp' | 'udp';
  hostIp?: string;
}

export interface ContainerServiceHealthCheckConfig {
  protocol: 'http' | 'tcp';
  port: number;
  path?: string;
  expectedStatus?: number;
}

export interface ContainerServiceWorkloadConfig {
  image?: string;
  build?: ScheduledContainerJobBuildConfig;
  networkMode: 'host' | 'bridge';
  restartPolicy: 'unless-stopped' | 'always' | 'no';
  autoStart: boolean;
  runtimeClass: 'default' | 'nvidia';
  command?: string;
  environment: EnvironmentVariableConfig[];
  volumeMounts: VolumeMountConfig[];
  jsonFiles: JsonFileConfig[];
  ports: ContainerServicePortConfig[];
  healthCheck?: ContainerServiceHealthCheckConfig;
}

export interface MinecraftBedrockWorkloadConfig {
  image: string;
  networkMode: 'host' | 'bridge';
  serverName: string;
  worldName: string;
  gameMode: 'survival' | 'creative' | 'adventure';
  difficulty: 'peaceful' | 'easy' | 'normal' | 'hard';
  levelSeed?: string;
  worldSourcePath?: string;
  worldCopyMode: 'if-missing' | 'always';
  allowCheats: boolean;
  onlineMode: boolean;
  maxPlayers: number;
  serverPort: number;
  autoStart: boolean;
  autoUpdateEnabled: boolean;
  autoUpdateSchedule: string;
  texturepackRequired: boolean;
  behaviorPacks: MinecraftBedrockPackConfig[];
  resourcePacks: MinecraftBedrockPackConfig[];
}

export interface MinecraftBedrockPackConfig {
  id: string;
  sourcePath: string;
  manifestUuid: string;
  manifestVersion: number[];
}

export interface RemoteWorkloadConfig {
  id: string;
  enabled: boolean;
  nodeId: string;
  description: string;
  kind: 'scheduled-container-job' | 'container-service' | 'minecraft-bedrock-server';
  job?: ScheduledContainerJobWorkloadConfig;
  service?: ContainerServiceWorkloadConfig;
  minecraft?: MinecraftBedrockWorkloadConfig;
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

export interface KulrsBotCredentialsConfig {
  id: string;
  email: string;
  password: string;
  description?: string;
}

export interface GatewayApiJobChannelConfig {
  id: string;
  type: 'telegram' | 'webhook';
  enabled: boolean;
  description?: string;
  botToken?: string;
  chatId?: string;
  parseMode?: string;
  messageThreadId?: number;
  webhookUrl?: string;
}

export interface GatewayApiJobRuntimeConfig {
  channelsFilePath: string;
  channels: GatewayApiJobChannelConfig[];
}

export interface KulrsActivityConfig {
  enabled: boolean;
  description: string;
  schedule: string;
  workingDirectory: string;
  execStart: string;
  user: string;
  group?: string;
  envFilePath: string;
  credentialsFilePath: string;
  workspaceDir: string;
  timezone: string;
  unsplashAccessKey: string;
  firebaseApiKey: string;
  bots: KulrsBotCredentialsConfig[];
}

export interface GatewayApiServiceProfile {
  enabled: boolean;
  appId: string;
  apiBaseUrl: string;
  envFilePath: string;
  environment: EnvironmentVariableConfig[];
  jobRuntime: GatewayApiJobRuntimeConfig;
  kulrsActivity: KulrsActivityConfig;
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

export interface TextToSpeechServiceConfig {
  enabled: boolean;
  baseUrl: string;
  defaultVoice: string;
  generatePath: string;
  streamPath: string;
  voicesPath: string;
  healthPath: string;
}

export interface GatewayChatPlatformServiceProfile {
  enabled: boolean;
  appId: string;
  apiBaseUrl: string;
  apiEnvFilePath: string;
  environment: EnvironmentVariableConfig[];
  tts: TextToSpeechServiceConfig;
  agents: GatewayChatAgentConfig[];
}

export interface PiProxyServiceProfile {
  enabled: boolean;
  description: string;
  nodeId: string;
  installRoot: string;
  systemdUnitName: string;
  registryBaseUrl: string;
  listenHost: string;
  listenPort: number;
  registryPath: string;
  pollIntervalSeconds: number;
  serviceUser?: string;
  serviceGroup?: string;
}

export interface ServiceProfiles {
  gatewayApi: GatewayApiServiceProfile;
  gatewayChatPlatform: GatewayChatPlatformServiceProfile;
  piProxy: PiProxyServiceProfile;
}

export interface GatewayConfig {
  gateway: GatewaySettings;
  apps: AppConfig[];
  scheduledJobs: ScheduledJobConfig[];
  workerNodes: WorkerNodeConfig[];
  remoteWorkloads: RemoteWorkloadConfig[];
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

function assertNonNegativeIntegerArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'number' || !Number.isInteger(item) || item < 0)) {
    throw new Error(`Expected non-negative integer[] for ${field}`);
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
    hostnames: value.hostnames === undefined ? [] : assertStringArray(value.hostnames, `apps[${index}].hostnames`),
    routePath: assertString(value.routePath, `apps[${index}].routePath`),
    stripRoutePrefix: typeof value.stripRoutePrefix === 'boolean' ? value.stripRoutePrefix : false,
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

function parseWorkerNodeConfig(value: unknown, index: number): WorkerNodeConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for workerNodes[${index}]`);
  }

  return {
    id: assertString(value.id, `workerNodes[${index}].id`),
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    description: typeof value.description === 'string' ? value.description : '',
    host: assertString(value.host, `workerNodes[${index}].host`),
    sshUser: assertString(value.sshUser, `workerNodes[${index}].sshUser`),
    sshPort: value.sshPort === undefined ? 22 : assertPositiveInteger(value.sshPort, `workerNodes[${index}].sshPort`),
    buildRoot: assertString(value.buildRoot, `workerNodes[${index}].buildRoot`),
    stackRoot: assertString(value.stackRoot, `workerNodes[${index}].stackRoot`),
    volumeRoot: assertString(value.volumeRoot, `workerNodes[${index}].volumeRoot`),
    workerPollIntervalSeconds: value.workerPollIntervalSeconds === undefined
      ? 15
      : assertPositiveInteger(value.workerPollIntervalSeconds, `workerNodes[${index}].workerPollIntervalSeconds`),
    nodeCommand: typeof value.nodeCommand === 'string' ? value.nodeCommand : 'node',
    systemdUnitDirectory: typeof value.systemdUnitDirectory === 'string' ? value.systemdUnitDirectory : undefined,
    systemdReloadCommand: typeof value.systemdReloadCommand === 'string' ? value.systemdReloadCommand : undefined,
    systemdEnableTimerCommand: typeof value.systemdEnableTimerCommand === 'string' ? value.systemdEnableTimerCommand : undefined,
    dockerCommand: typeof value.dockerCommand === 'string' ? value.dockerCommand : 'docker',
    dockerComposeCommand: typeof value.dockerComposeCommand === 'string' ? value.dockerComposeCommand : 'docker compose'
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

function parseVolumeMountConfig(value: unknown, field: string): VolumeMountConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  return {
    source: assertString(value.source, `${field}.source`),
    target: assertString(value.target, `${field}.target`),
    readOnly: typeof value.readOnly === 'boolean' ? value.readOnly : false
  };
}

function parseJsonFileConfig(value: unknown, field: string): JsonFileConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  const payload = value.payload;
  if (!isRecord(payload)) {
    throw new Error(`Expected object for ${field}.payload`);
  }

  return {
    relativePath: assertString(value.relativePath, `${field}.relativePath`),
    payload,
    description: typeof value.description === 'string' ? value.description : undefined
  };
}

function parseScheduledContainerJobBuildConfig(value: unknown, field: string): ScheduledContainerJobBuildConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  const strategy = value.strategy;
  if (strategy !== 'repo-dockerfile' && strategy !== 'generated-node') {
    throw new Error(`Invalid strategy for ${field}.strategy`);
  }

  return {
    strategy,
    repoUrl: assertString(value.repoUrl, `${field}.repoUrl`),
    defaultRevision: typeof value.defaultRevision === 'string' ? value.defaultRevision : 'main',
    contextPath: typeof value.contextPath === 'string' ? value.contextPath : '.',
    dockerfilePath: typeof value.dockerfilePath === 'string' ? value.dockerfilePath : undefined,
    packageRoot: typeof value.packageRoot === 'string' ? value.packageRoot : '.',
    nodeVersion: typeof value.nodeVersion === 'string' ? value.nodeVersion : '24',
    installCommand: typeof value.installCommand === 'string' ? value.installCommand : 'npm ci --omit=dev'
  };
}

function parseScheduledContainerJobWorkloadConfig(value: unknown, field: string): ScheduledContainerJobWorkloadConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  return {
    schedule: assertString(value.schedule, `${field}.schedule`),
    timezone: typeof value.timezone === 'string' ? value.timezone : 'America/New_York',
    build: parseScheduledContainerJobBuildConfig(value.build, `${field}.build`),
    runCommand: assertString(value.runCommand, `${field}.runCommand`),
    environment: Array.isArray(value.environment)
      ? value.environment.map((entry, index) => parseEnvironmentVariableConfig(entry, `${field}.environment[${index}]`))
      : [],
    volumeMounts: Array.isArray(value.volumeMounts)
      ? value.volumeMounts.map((entry, index) => parseVolumeMountConfig(entry, `${field}.volumeMounts[${index}]`))
      : [],
    jsonFiles: Array.isArray(value.jsonFiles)
      ? value.jsonFiles.map((entry, index) => parseJsonFileConfig(entry, `${field}.jsonFiles[${index}]`))
      : []
    };
}

function parseContainerServicePortConfig(value: unknown, field: string): ContainerServicePortConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  const protocol = value.protocol;
  if (protocol !== undefined && protocol !== 'tcp' && protocol !== 'udp') {
    throw new Error(`Invalid protocol for ${field}.protocol`);
  }

  return {
    published: assertPositiveInteger(value.published, `${field}.published`),
    target: assertPositiveInteger(value.target, `${field}.target`),
    protocol: protocol === 'udp' ? 'udp' : 'tcp',
    hostIp: typeof value.hostIp === 'string' ? value.hostIp : undefined
  };
}

function parseContainerServiceHealthCheckConfig(value: unknown, field: string): ContainerServiceHealthCheckConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  const protocol = value.protocol;
  if (protocol !== 'http' && protocol !== 'tcp') {
    throw new Error(`Invalid protocol for ${field}.protocol`);
  }

  return {
    protocol,
    port: assertPositiveInteger(value.port, `${field}.port`),
    path: typeof value.path === 'string' ? value.path : undefined,
    expectedStatus: value.expectedStatus === undefined ? undefined : assertPositiveInteger(value.expectedStatus, `${field}.expectedStatus`)
  };
}

function parseContainerServiceWorkloadConfig(value: unknown, field: string): ContainerServiceWorkloadConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  const image = typeof value.image === 'string' ? value.image : undefined;
  const build = value.build === undefined ? undefined : parseScheduledContainerJobBuildConfig(value.build, `${field}.build`);
  if (!image && !build) {
    throw new Error(`Expected ${field}.image or ${field}.build`);
  }

  const restartPolicy = value.restartPolicy;
  if (restartPolicy !== undefined && restartPolicy !== 'unless-stopped' && restartPolicy !== 'always' && restartPolicy !== 'no') {
    throw new Error(`Invalid restartPolicy for ${field}.restartPolicy`);
  }

  const runtimeClass = value.runtimeClass;
  if (runtimeClass !== undefined && runtimeClass !== 'default' && runtimeClass !== 'nvidia') {
    throw new Error(`Invalid runtimeClass for ${field}.runtimeClass`);
  }

  return {
    image,
    build,
    networkMode: value.networkMode === 'host' ? 'host' : 'bridge',
    restartPolicy: restartPolicy === 'always' || restartPolicy === 'no' ? restartPolicy : 'unless-stopped',
    autoStart: typeof value.autoStart === 'boolean' ? value.autoStart : true,
    runtimeClass: runtimeClass === 'nvidia' ? 'nvidia' : 'default',
    command: typeof value.command === 'string' ? value.command : undefined,
    environment: Array.isArray(value.environment)
      ? value.environment.map((entry, index) => parseEnvironmentVariableConfig(entry, `${field}.environment[${index}]`))
      : [],
    volumeMounts: Array.isArray(value.volumeMounts)
      ? value.volumeMounts.map((entry, index) => parseVolumeMountConfig(entry, `${field}.volumeMounts[${index}]`))
      : [],
    jsonFiles: Array.isArray(value.jsonFiles)
      ? value.jsonFiles.map((entry, index) => parseJsonFileConfig(entry, `${field}.jsonFiles[${index}]`))
      : [],
    ports: Array.isArray(value.ports)
      ? value.ports.map((entry, index) => parseContainerServicePortConfig(entry, `${field}.ports[${index}]`))
      : [],
    healthCheck: value.healthCheck === undefined
      ? undefined
      : parseContainerServiceHealthCheckConfig(value.healthCheck, `${field}.healthCheck`)
  };
}

function parseMinecraftBedrockPackConfig(value: unknown, field: string): MinecraftBedrockPackConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  return {
    id: assertString(value.id, `${field}.id`),
    sourcePath: assertString(value.sourcePath, `${field}.sourcePath`),
    manifestUuid: assertString(value.manifestUuid, `${field}.manifestUuid`),
    manifestVersion: value.manifestVersion === undefined
      ? [1, 0, 0]
      : assertNonNegativeIntegerArray(value.manifestVersion, `${field}.manifestVersion`)
  };
}

function parseMinecraftBedrockWorkloadConfig(value: unknown, field: string): MinecraftBedrockWorkloadConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  const gameMode = value.gameMode;
  if (gameMode !== 'survival' && gameMode !== 'creative' && gameMode !== 'adventure') {
    throw new Error(`Invalid gameMode for ${field}.gameMode`);
  }

  const difficulty = value.difficulty;
  if (difficulty !== 'peaceful' && difficulty !== 'easy' && difficulty !== 'normal' && difficulty !== 'hard') {
    throw new Error(`Invalid difficulty for ${field}.difficulty`);
  }

  return {
    image: typeof value.image === 'string' ? value.image : 'itzg/minecraft-bedrock-server:latest',
    networkMode: value.networkMode === 'bridge' ? 'bridge' : 'host',
    serverName: assertString(value.serverName, `${field}.serverName`),
    worldName: assertString(value.worldName, `${field}.worldName`),
    gameMode,
    difficulty,
    levelSeed: typeof value.levelSeed === 'string' ? value.levelSeed : undefined,
    worldSourcePath: typeof value.worldSourcePath === 'string' ? value.worldSourcePath : undefined,
    worldCopyMode: value.worldCopyMode === 'always' ? 'always' : 'if-missing',
    allowCheats: typeof value.allowCheats === 'boolean' ? value.allowCheats : false,
    onlineMode: typeof value.onlineMode === 'boolean' ? value.onlineMode : true,
    maxPlayers: value.maxPlayers === undefined ? 10 : assertPositiveInteger(value.maxPlayers, `${field}.maxPlayers`),
    serverPort: value.serverPort === undefined ? 19132 : assertPositiveInteger(value.serverPort, `${field}.serverPort`),
    autoStart: typeof value.autoStart === 'boolean' ? value.autoStart : true,
    autoUpdateEnabled: typeof value.autoUpdateEnabled === 'boolean' ? value.autoUpdateEnabled : true,
    autoUpdateSchedule: typeof value.autoUpdateSchedule === 'string' ? value.autoUpdateSchedule : '*-*-* 04:00:00',
    texturepackRequired: typeof value.texturepackRequired === 'boolean' ? value.texturepackRequired : false,
    behaviorPacks: Array.isArray(value.behaviorPacks)
      ? value.behaviorPacks.map((entry, index) => parseMinecraftBedrockPackConfig(entry, `${field}.behaviorPacks[${index}]`))
      : [],
    resourcePacks: Array.isArray(value.resourcePacks)
      ? value.resourcePacks.map((entry, index) => parseMinecraftBedrockPackConfig(entry, `${field}.resourcePacks[${index}]`))
      : []
  };
}

function parseRemoteWorkloadConfig(value: unknown, index: number): RemoteWorkloadConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for remoteWorkloads[${index}]`);
  }

  const kind = value.kind;
  if (kind !== 'scheduled-container-job' && kind !== 'container-service' && kind !== 'minecraft-bedrock-server') {
    throw new Error(`Invalid kind for remoteWorkloads[${index}].kind`);
  }

  return {
    id: assertString(value.id, `remoteWorkloads[${index}].id`),
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    nodeId: assertString(value.nodeId, `remoteWorkloads[${index}].nodeId`),
    description: typeof value.description === 'string' ? value.description : '',
    kind,
    job: kind === 'scheduled-container-job'
      ? parseScheduledContainerJobWorkloadConfig(value.job, `remoteWorkloads[${index}].job`)
      : undefined,
    service: kind === 'container-service'
      ? parseContainerServiceWorkloadConfig(value.service, `remoteWorkloads[${index}].service`)
      : undefined,
    minecraft: kind === 'minecraft-bedrock-server'
      ? parseMinecraftBedrockWorkloadConfig(value.minecraft, `remoteWorkloads[${index}].minecraft`)
      : undefined
  };
}

function parseGatewayApiJobChannelConfig(value: unknown, field: string): GatewayApiJobChannelConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  const type = value.type;
  if (type !== 'telegram' && type !== 'webhook') {
    throw new Error(`Invalid type for ${field}.type`);
  }

  return {
    id: assertString(value.id, `${field}.id`),
    type,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    description: typeof value.description === 'string' ? value.description : undefined,
    botToken: typeof value.botToken === 'string' ? value.botToken : undefined,
    chatId: typeof value.chatId === 'string' ? value.chatId : undefined,
    parseMode: typeof value.parseMode === 'string' ? value.parseMode : undefined,
    messageThreadId: value.messageThreadId === undefined ? undefined : assertPositiveInteger(value.messageThreadId, `${field}.messageThreadId`),
    webhookUrl: typeof value.webhookUrl === 'string' ? value.webhookUrl : undefined
  };
}

function parseGatewayApiJobRuntimeConfig(value: unknown, appId: string): GatewayApiJobRuntimeConfig {
  if (value === undefined) {
    return {
      channelsFilePath: `/srv/apps/${appId}/shared/job-channels.json`,
      channels: []
    };
  }

  if (!isRecord(value)) {
    throw new Error('Expected object for serviceProfiles.gatewayApi.jobRuntime');
  }

  return {
    channelsFilePath: typeof value.channelsFilePath === 'string'
      ? value.channelsFilePath
      : `/srv/apps/${appId}/shared/job-channels.json`,
    channels: Array.isArray(value.channels)
      ? value.channels.map((entry, index) =>
          parseGatewayApiJobChannelConfig(entry, `serviceProfiles.gatewayApi.jobRuntime.channels[${index}]`)
        )
      : []
  };
}

function parseKulrsBotCredentialsConfig(value: unknown, field: string): KulrsBotCredentialsConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  return {
    id: assertString(value.id, `${field}.id`),
    email: typeof value.email === 'string' ? value.email : '',
    password: typeof value.password === 'string' ? value.password : '',
    description: typeof value.description === 'string' ? value.description : undefined
  };
}

function parseKulrsActivityConfig(value: unknown, appId: string): KulrsActivityConfig {
  if (value === undefined) {
    return {
      enabled: false,
      description: 'KULRS activity automation',
      schedule: '*:0/5',
      workingDirectory: '__CURRENT__',
      execStart: '/usr/bin/node __CURRENT__/jobs/kulrs_activity.js',
      user: 'deploy',
      envFilePath: '/srv/apps/gateway-api/shared/kulrs-activity.env',
      credentialsFilePath: '/srv/apps/gateway-api/shared/kulrs.json',
      workspaceDir: '/srv/apps/gateway-api/shared/kulrs',
      timezone: 'America/New_York',
      unsplashAccessKey: '',
      firebaseApiKey: '',
      bots: []
    };
  }

  if (!isRecord(value)) {
    throw new Error('Expected object for serviceProfiles.gatewayApi.kulrsActivity');
  }

  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    description: typeof value.description === 'string' ? value.description : 'KULRS activity automation',
    schedule: typeof value.schedule === 'string' ? value.schedule : '*:0/5',
    workingDirectory: typeof value.workingDirectory === 'string' ? value.workingDirectory : '__CURRENT__',
    execStart: typeof value.execStart === 'string'
      ? value.execStart
      : '/usr/bin/node __CURRENT__/jobs/kulrs_activity.js',
    user: typeof value.user === 'string' ? value.user : 'deploy',
    group: typeof value.group === 'string' ? value.group : undefined,
    envFilePath: typeof value.envFilePath === 'string' ? value.envFilePath : `/srv/apps/${appId}/shared/kulrs-activity.env`,
    credentialsFilePath: typeof value.credentialsFilePath === 'string'
      ? value.credentialsFilePath
      : `/srv/apps/${appId}/shared/kulrs.json`,
    workspaceDir: typeof value.workspaceDir === 'string' ? value.workspaceDir : `/srv/apps/${appId}/shared/kulrs`,
    timezone: typeof value.timezone === 'string' ? value.timezone : 'America/New_York',
    unsplashAccessKey: typeof value.unsplashAccessKey === 'string' ? value.unsplashAccessKey : '',
    firebaseApiKey: typeof value.firebaseApiKey === 'string' ? value.firebaseApiKey : '',
    bots: Array.isArray(value.bots)
      ? value.bots.map((entry, index) =>
          parseKulrsBotCredentialsConfig(entry, `serviceProfiles.gatewayApi.kulrsActivity.bots[${index}]`)
        )
      : []
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
      environment: [],
      jobRuntime: parseGatewayApiJobRuntimeConfig(undefined, 'gateway-api'),
      kulrsActivity: parseKulrsActivityConfig(undefined, 'gateway-api')
    };
  }

  if (!isRecord(value)) {
    throw new Error('Expected object for serviceProfiles.gatewayApi');
  }

  const appId = assertString(value.appId, 'serviceProfiles.gatewayApi.appId');
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    appId,
    apiBaseUrl: assertString(value.apiBaseUrl, 'serviceProfiles.gatewayApi.apiBaseUrl'),
    envFilePath: assertString(value.envFilePath, 'serviceProfiles.gatewayApi.envFilePath'),
    environment: Array.isArray(value.environment)
      ? value.environment.map((entry, index) => parseEnvironmentVariableConfig(entry, `serviceProfiles.gatewayApi.environment[${index}]`))
      : [],
    jobRuntime: parseGatewayApiJobRuntimeConfig(value.jobRuntime, appId),
    kulrsActivity: parseKulrsActivityConfig(value.kulrsActivity, appId)
  };
}

function parseTextToSpeechServiceConfig(value: unknown, field: string): TextToSpeechServiceConfig {
  if (value === undefined) {
    return {
      enabled: false,
      baseUrl: 'http://198.51.100.111:5000',
      defaultVoice: 'assistant_v1',
      generatePath: '/tts',
      streamPath: '/tts/stream',
      voicesPath: '/voices',
      healthPath: '/health'
    };
  }

  if (!isRecord(value)) {
    throw new Error(`Expected object for ${field}`);
  }

  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    baseUrl: assertString(value.baseUrl, `${field}.baseUrl`),
    defaultVoice: assertString(value.defaultVoice, `${field}.defaultVoice`),
    generatePath: assertString(value.generatePath, `${field}.generatePath`),
    streamPath: assertString(value.streamPath, `${field}.streamPath`),
    voicesPath: assertString(value.voicesPath, `${field}.voicesPath`),
    healthPath: assertString(value.healthPath, `${field}.healthPath`)
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
      tts: parseTextToSpeechServiceConfig(undefined, 'serviceProfiles.gatewayChatPlatform.tts'),
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
    tts: parseTextToSpeechServiceConfig(value.tts, 'serviceProfiles.gatewayChatPlatform.tts'),
    agents: Array.isArray(value.agents)
      ? value.agents.map((agent, index) => parseGatewayChatAgentConfig(agent, `serviceProfiles.gatewayChatPlatform.agents[${index}]`))
      : []
  };
}

function parsePiProxyServiceProfile(value: unknown): PiProxyServiceProfile {
  if (value === undefined) {
    return {
      enabled: false,
      description: 'Physical Raspberry Pi running the external Bedrock LAN proxy',
      nodeId: 'pi-node',
      installRoot: '/opt/bedrock-lan-proxy',
      systemdUnitName: 'bedrock-lan-proxy.service',
      registryBaseUrl: 'http://127.0.0.1:4173',
      listenHost: '0.0.0.0',
      listenPort: 19132,
      registryPath: '/api/minecraft/server-registry',
      pollIntervalSeconds: 30
    };
  }

  if (!isRecord(value)) {
    throw new Error('Expected object for serviceProfiles.piProxy');
  }

  const registryPath = assertString(value.registryPath, 'serviceProfiles.piProxy.registryPath');
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    description: assertString(value.description, 'serviceProfiles.piProxy.description'),
    nodeId: assertString(value.nodeId, 'serviceProfiles.piProxy.nodeId'),
    installRoot: assertString(value.installRoot, 'serviceProfiles.piProxy.installRoot'),
    systemdUnitName: assertString(value.systemdUnitName, 'serviceProfiles.piProxy.systemdUnitName'),
    registryBaseUrl: assertString(value.registryBaseUrl, 'serviceProfiles.piProxy.registryBaseUrl'),
    listenHost: assertString(value.listenHost, 'serviceProfiles.piProxy.listenHost'),
    listenPort: assertPositiveInteger(value.listenPort, 'serviceProfiles.piProxy.listenPort'),
    registryPath: registryPath.startsWith('/') ? registryPath : `/${registryPath}`,
    pollIntervalSeconds: assertPositiveInteger(
      value.pollIntervalSeconds,
      'serviceProfiles.piProxy.pollIntervalSeconds'
    ),
    serviceUser: typeof value.serviceUser === 'string' ? value.serviceUser : undefined,
    serviceGroup: typeof value.serviceGroup === 'string' ? value.serviceGroup : undefined
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

  if (raw.workerNodes !== undefined && !Array.isArray(raw.workerNodes)) {
    throw new Error('workerNodes must be an array');
  }

  if (raw.remoteWorkloads !== undefined && !Array.isArray(raw.remoteWorkloads)) {
    throw new Error('remoteWorkloads must be an array');
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
  const workerNodes = Array.isArray(raw.workerNodes) ? raw.workerNodes.map(parseWorkerNodeConfig) : [];
  const remoteWorkloads = Array.isArray(raw.remoteWorkloads) ? raw.remoteWorkloads.map(parseRemoteWorkloadConfig) : [];
  const features = Array.isArray(raw.features) ? raw.features.map(parseFeatureFlagConfig) : [];
  const serviceProfilesRaw = isRecord(raw.serviceProfiles) ? raw.serviceProfiles : {};
  const serviceProfiles: ServiceProfiles = {
    gatewayApi: parseGatewayApiServiceProfile(serviceProfilesRaw.gatewayApi),
    gatewayChatPlatform: parseGatewayChatPlatformServiceProfile(serviceProfilesRaw.gatewayChatPlatform),
    piProxy: parsePiProxyServiceProfile(serviceProfilesRaw.piProxy)
  };

  for (const job of scheduledJobs) {
    if (!apps.find((app) => app.id === job.appId)) {
      throw new Error(`scheduled job ${job.id} references unknown app ${job.appId}`);
    }
  }

  for (const workload of remoteWorkloads) {
    if (!workerNodes.find((node) => node.id === workload.nodeId)) {
      throw new Error(`remote workload ${workload.id} references unknown worker node ${workload.nodeId}`);
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

  if (serviceProfiles.piProxy.enabled && !workerNodes.find((node) => node.id === serviceProfiles.piProxy.nodeId)) {
    throw new Error(`service profile piProxy references unknown worker node ${serviceProfiles.piProxy.nodeId}`);
  }

  return { gateway, apps, scheduledJobs, workerNodes, remoteWorkloads, features, serviceProfiles };
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
  return getAllScheduledJobs(config).filter((job) => job.appId === appId && job.enabled);
}

export function getWorkerNode(config: GatewayConfig, nodeId: string): WorkerNodeConfig {
  const node = config.workerNodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new Error(`Unknown worker node id: ${nodeId}`);
  }
  if (!node.enabled) {
    throw new Error(`Worker node is disabled: ${nodeId}`);
  }
  return node;
}

export function getRemoteWorkload(config: GatewayConfig, workloadId: string): RemoteWorkloadConfig {
  const workload = config.remoteWorkloads.find((candidate) => candidate.id === workloadId);
  if (!workload) {
    throw new Error(`Unknown remote workload id: ${workloadId}`);
  }
  return workload;
}

export function getAllScheduledJobs(config: GatewayConfig): ScheduledJobConfig[] {
  const jobs = [...config.scheduledJobs];
  const kulrs = config.serviceProfiles.gatewayApi.kulrsActivity;

  jobs.push({
    id: 'gateway-api-kulrs-activity',
    appId: config.serviceProfiles.gatewayApi.appId,
    enabled: kulrs.enabled,
    description: kulrs.description,
    schedule: kulrs.schedule,
    workingDirectory: kulrs.workingDirectory,
    execStart: kulrs.execStart,
    user: kulrs.user,
    group: kulrs.group,
    environmentFile: kulrs.envFilePath
  });

  return jobs;
}
