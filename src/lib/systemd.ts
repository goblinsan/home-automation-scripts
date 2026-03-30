import type { AdminUiSettings, AppConfig, GatewayConfig, ScheduledJobConfig } from './config.ts';

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

export function renderControlPlaneService(adminUi: AdminUiSettings): string {
  const groupLine = adminUi.group ? `Group=${adminUi.group}\n` : '';
  const pathLine = 'Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n';

  return `[Unit]
Description=Gateway control plane admin UI
After=network.target

[Service]
Type=simple
User=${adminUi.user}
${groupLine}${pathLine}WorkingDirectory=${adminUi.workingDirectory}
ExecStart=${adminUi.nodeExecutable} ${adminUi.workingDirectory}/src/cli.ts serve-ui --config ${adminUi.configPath} --host ${adminUi.host} --port ${adminUi.port} --out ${adminUi.buildOutDir}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}
