import type {
  EnvironmentVariableConfig,
  GatewayApiServiceProfile,
  GatewayChatPlatformServiceProfile
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
  return renderEnvFile(profile.environment);
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
