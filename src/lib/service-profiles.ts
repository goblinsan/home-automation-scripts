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

export function renderGatewayChatPlatformEnv(profile: GatewayChatPlatformServiceProfile): string {
  return renderEnvFile(profile.environment);
}

export function renderGatewayChatAgents(profile: GatewayChatPlatformServiceProfile): string {
  return `${JSON.stringify({ agents: profile.agents }, null, 2)}\n`;
}
