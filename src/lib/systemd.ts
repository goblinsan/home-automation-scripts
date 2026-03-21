import type { AppConfig, GatewayConfig, ScheduledJobConfig } from './config.ts';

function resolveJobToken(app: AppConfig, value: string): string {
  return value.replaceAll('__CURRENT__', `${app.deployRoot}/current`);
}

export function renderJobService(config: GatewayConfig, app: AppConfig, job: ScheduledJobConfig): string {
  const environmentLine = job.environmentFile
    ? `EnvironmentFile=${job.environmentFile}\n`
    : '';
  const groupLine = job.group ? `Group=${job.group}\n` : '';

  return `[Unit]
Description=${job.description}

[Service]
Type=oneshot
User=${job.user}
${groupLine}${environmentLine}WorkingDirectory=${resolveJobToken(app, job.workingDirectory)}
ExecStart=${resolveJobToken(app, job.execStart)}
`;
}

export function renderJobTimer(job: ScheduledJobConfig): string {
  return `[Unit]
Description=${job.description}

[Timer]
OnCalendar=${job.schedule}
Persistent=true
Unit=${job.id}.service

[Install]
WantedBy=timers.target
`;
}

