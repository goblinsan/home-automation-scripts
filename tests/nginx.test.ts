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
  scheduledJobs: []
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

