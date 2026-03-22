import test from 'node:test';
import assert from 'node:assert/strict';
import { renderActiveUpstream, renderGatewaySite } from '../src/lib/nginx.ts';
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
  scheduledJobs: [],
  features: []
};

test('renderGatewaySite includes active upstream and route path', () => {
  const output = renderGatewaySite(config);
  assert.match(output, /include \/etc\/nginx\/conf\.d\/upstreams\/chat-router-active\.conf;/);
  assert.match(output, /location \/chat\//);
});

test('renderActiveUpstream renders selected slot port', () => {
  const output = renderActiveUpstream(config.apps[0], 'green');
  assert.match(output, /127\.0\.0\.1:3002/);
});

test('renderGatewaySite skips disabled apps', () => {
  const disabledConfig: GatewayConfig = {
    ...config,
    apps: [
      ...config.apps,
      {
        id: 'disabled-app',
        enabled: false,
        repoUrl: 'git@example/disabled-app.git',
        defaultRevision: 'main',
        deployRoot: '/srv/apps/disabled-app',
        routePath: '/disabled/',
        healthPath: '/health',
        upstreamConfPath: '/etc/nginx/conf.d/upstreams/disabled-app-active.conf',
        buildCommands: ['npm ci'],
        slots: {
          blue: { port: 3101, startCommand: 'start-blue', stopCommand: 'stop-blue' },
          green: { port: 3102, startCommand: 'start-green', stopCommand: 'stop-green' }
        }
      }
    ]
  };

  const output = renderGatewaySite(disabledConfig);
  assert.doesNotMatch(output, /disabled-app_active/);
  assert.doesNotMatch(output, /location \/disabled\//);
});
