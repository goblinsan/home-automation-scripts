import test from 'node:test';
import assert from 'node:assert/strict';
import { renderJobService, renderJobTimer } from '../src/lib/systemd.ts';
import type { GatewayConfig } from '../src/lib/config.ts';

const config: GatewayConfig = {
  gateway: {
    serverNames: ['gateway.example.test'],
    nginxSiteOutputPath: '/etc/nginx/sites-available/gateway',
    upstreamDirectory: '/etc/nginx/conf.d/upstreams',
    nginxReloadCommand: 'reload',
    systemdUnitDirectory: '/etc/systemd/system',
    systemdReloadCommand: 'reload-systemd',
    systemdEnableTimerCommand: 'enable-timers'
  },
  apps: [
    {
      id: 'chat-router',
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
      description: 'Refresh model catalog',
      schedule: '*:0/15',
      workingDirectory: '__CURRENT__',
      execStart: '/usr/bin/bash __CURRENT__/scripts/jobs/refresh-model-catalog.sh',
      user: 'deploy'
    }
  ]
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

