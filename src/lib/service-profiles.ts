import type {
  EnvironmentVariableConfig,
  GatewayApiServiceProfile,
  GatewayApiJobRuntimeConfig,
  GatewayChatPlatformServiceProfile,
  KulrsActivityConfig
} from './config.ts';

function escapeEnvValue(value: string): string {
  if (value.length === 0) {
    return '""';
  }
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
}

export function renderEnvFile(environment: EnvironmentVariableConfig[]): string {
  return environment
    .map((entry) => {
      const comment = entry.description ? `# ${entry.description}\n` : '';
      return `${comment}${entry.key}=${escapeEnvValue(entry.value)}`;
    })
    .join('\n')
    .concat(environment.length > 0 ? '\n' : '');
}

export function renderGatewayApiEnv(profile: GatewayApiServiceProfile): string {
  return renderEnvFile([
    ...profile.environment,
    {
      key: 'GATEWAY_JOB_CHANNELS_PATH',
      value: profile.jobRuntime.channelsFilePath,
      secret: false,
      description: 'Path to named delivery channels for gateway job runtime'
    }
  ]);
}

export function renderGatewayApiJobChannels(profile: GatewayApiJobRuntimeConfig): string {
  return `${JSON.stringify({ channels: profile.channels }, null, 2)}\n`;
}

export function renderKulrsActivityEnv(profile: KulrsActivityConfig): string {
  return renderEnvFile([
    {
      key: 'UNSPLASH_ACCESS_KEY',
      value: profile.unsplashAccessKey,
      secret: true,
      description: 'Unsplash access key used for palette inspiration images'
    },
    {
      key: 'KULRS_WORKSPACE_DIR',
      value: profile.workspaceDir,
      secret: false,
      description: 'Shared directory for KULRS activity logs and cache'
    },
    {
      key: 'KULRS_CREDS_PATH',
      value: profile.credentialsFilePath,
      secret: false,
      description: 'Generated credentials JSON consumed by the KULRS cron script'
    },
    {
      key: 'KULRS_TIMEZONE',
      value: profile.timezone,
      secret: false,
      description: 'Timezone used for KULRS run-window gating'
    }
  ]);
}

export function renderKulrsCredentials(profile: KulrsActivityConfig): string {
  const payload: Record<string, unknown> = {
    firebaseApiKey: profile.firebaseApiKey
  };

  for (const bot of profile.bots) {
    if (!bot.id) {
      continue;
    }
    payload[bot.id] = {
      email: bot.email,
      password: bot.password
    };
  }

  return `${JSON.stringify(payload, null, 2)}\n`;
}

function buildGatewayChatPlatformEnvironment(profile: GatewayChatPlatformServiceProfile): EnvironmentVariableConfig[] {
  return [
    ...profile.environment,
    {
      key: 'TTS_ENABLED',
      value: profile.tts.enabled ? 'true' : 'false',
      secret: false,
      description: 'Enable local TTS integration'
    },
    {
      key: 'TTS_BASE_URL',
      value: profile.tts.baseUrl,
      secret: false,
      description: 'Base URL for the local TTS HTTP service'
    },
    {
      key: 'TTS_DEFAULT_VOICE',
      value: profile.tts.defaultVoice,
      secret: false,
      description: 'Default TTS voice id'
    },
    {
      key: 'TTS_GENERATE_PATH',
      value: profile.tts.generatePath,
      secret: false,
      description: 'Relative path for one-shot speech generation'
    },
    {
      key: 'TTS_STREAM_PATH',
      value: profile.tts.streamPath,
      secret: false,
      description: 'Relative path for streamed speech generation'
    },
    {
      key: 'TTS_VOICES_PATH',
      value: profile.tts.voicesPath,
      secret: false,
      description: 'Relative path for listing available voices'
    },
    {
      key: 'TTS_HEALTH_PATH',
      value: profile.tts.healthPath,
      secret: false,
      description: 'Relative path for the TTS health probe'
    }
  ];
}

export function renderGatewayChatPlatformEnv(profile: GatewayChatPlatformServiceProfile): string {
  return renderEnvFile(buildGatewayChatPlatformEnvironment(profile));
}

export function renderGatewayChatAgents(profile: GatewayChatPlatformServiceProfile): string {
  return `${JSON.stringify({ agents: profile.agents }, null, 2)}\n`;
}
