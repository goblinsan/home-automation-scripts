import test from 'node:test';
import assert from 'node:assert/strict';
import { renderControlPlaneService, renderJobService, renderJobTimer } from '../src/lib/systemd.ts';
import type { GatewayConfig } from '../src/lib/config.ts';

const config: GatewayConfig = {
  gateway: {
    serverNames: ['gateway.example.test'],
    nginxSiteOutputPath: '/etc/nginx/sites-available/gateway',
    upstreamDirectory: '/etc/nginx/conf.d/upstreams',
    nginxReloadCommand: 'reload',
    systemdUnitDirectory: '/etc/systemd/system',
    systemdReloadCommand: 'reload-systemd',
    systemdEnableTimerCommand: 'enable-timers',
    adminUi: {
      enabled: true,
      host: '127.0.0.1',
      port: 4173,
      routePath: '/admin/',
      serviceName: 'gateway-control-plane.service',
      workingDirectory: '/opt/gateway-control-plane',
      configPath: '/opt/gateway-control-plane/configs/gateway.config.json',
      buildOutDir: '/opt/gateway-control-plane/generated',
      nodeExecutable: '/usr/bin/node',
      user: 'deploy'
    }
  },
  apps: [
    {
      id: 'chat-router',
      enabled: true,
      repoUrl: 'git@example/chat-router.git',
      defaultRevision: 'main',
      deployRoot: '/srv/apps/chat-router',
      routePath: '/chat/',
      healthPath: '/health',
      upstreamConfPath: '/etc/nginx/conf.d/upstreams/chat-router-active.conf',
      buildCommands: ['npm ci'],
      slots: {
        blue: { port: 3001, startCommand: 'start-blue', stopCommand: 'stop-blue' },
        green: { port: 3002, startCommand: 'start-green', stopCommand: 'stop-green' }
      }
    }
  ],
  scheduledJobs: [
    {
      id: 'refresh-model-catalog',
      appId: 'chat-router',
      enabled: true,
      description: 'Refresh model catalog',
      schedule: '*:0/15',
      workingDirectory: '__CURRENT__',
      execStart: '/usr/bin/bash __CURRENT__/scripts/jobs/refresh-model-catalog.sh',
      user: 'deploy'
    }
  ],
  features: [],
  serviceProfiles: {
    gatewayApi: {
      enabled: false,
      appId: 'chat-router',
      apiBaseUrl: 'http://127.0.0.1:3000',
      envFilePath: '/srv/apps/chat-router/shared/gateway-api.env',
      environment: []
    },
    gatewayChatPlatform: {
      enabled: false,
      appId: 'chat-router',
      apiBaseUrl: 'http://127.0.0.1:3000',
      apiEnvFilePath: '/srv/apps/chat-router/shared/chat-api.env',
      environment: [],
      agents: []
    }
  }
};

test('renderJobService resolves __CURRENT__', () => {
  const output = renderJobService(config, config.apps[0], config.scheduledJobs[0]);
  assert.match(output, /WorkingDirectory=\/srv\/apps\/chat-router\/current/);
  assert.match(output, /ExecStart=\/usr\/bin\/bash \/srv\/apps\/chat-router\/current\/scripts\/jobs\/refresh-model-catalog\.sh/);
});

test('renderJobTimer includes schedule and unit name', () => {
  const output = renderJobTimer(config.scheduledJobs[0]);
  assert.match(output, /OnCalendar=\*:0\/15/);
  assert.match(output, /Unit=refresh-model-catalog\.service/);
});

test('renderControlPlaneService produces a restartable admin ui unit', () => {
  const output = renderControlPlaneService(config.gateway.adminUi);
  assert.match(output, /Description=Gateway control plane admin UI/);
  assert.match(output, /ExecStart=\/usr\/bin\/node \/opt\/gateway-control-plane\/src\/cli\.ts serve-ui/);
  assert.match(output, /--config \/opt\/gateway-control-plane\/configs\/gateway\.config\.json/);
  assert.match(output, /Restart=on-failure/);
});
