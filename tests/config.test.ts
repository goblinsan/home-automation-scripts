import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGatewayConfig } from '../src/lib/config.ts';

test('parseGatewayConfig accepts the example shape', () => {
  const config = parseGatewayConfig({
    gateway: {
      serverNames: ['gateway.example.test'],
      nginxSiteOutputPath: '/etc/nginx/sites-available/gateway',
      upstreamDirectory: '/etc/nginx/conf.d/upstreams',
      nginxReloadCommand: 'sudo nginx -t && sudo systemctl reload nginx',
      systemdUnitDirectory: '/etc/systemd/system',
      systemdReloadCommand: 'sudo systemctl daemon-reload',
      systemdEnableTimerCommand: 'sudo systemctl enable --now'
    },
    apps: [
      {
        id: 'chat-router',
        enabled: true,
        repoUrl: 'git@github.com:example/chat-router.git',
        defaultRevision: 'main',
        deployRoot: '/srv/apps/chat-router',
        routePath: '/chat/',
        healthPath: '/health',
        upstreamConfPath: '/etc/nginx/conf.d/upstreams/chat-router-active.conf',
        buildCommands: ['npm ci', 'npm run build'],
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
        execStart: '/usr/bin/bash __CURRENT__/job.sh',
        user: 'deploy'
      }
    ],
    features: [
      {
        id: 'chat-router-public-route',
        enabled: true,
        description: 'Expose the chat router publicly'
      }
    ]
  });

  assert.equal(config.apps[0].id, 'chat-router');
  assert.equal(config.scheduledJobs[0].appId, 'chat-router');
  assert.equal(config.features[0].id, 'chat-router-public-route');
});

test('parseGatewayConfig defaults enabled flags when omitted', () => {
  const config = parseGatewayConfig({
    gateway: {
      serverNames: ['gateway.example.test'],
      nginxSiteOutputPath: '/etc/nginx/sites-available/gateway',
      upstreamDirectory: '/etc/nginx/conf.d/upstreams',
      nginxReloadCommand: 'reload-nginx',
      systemdUnitDirectory: '/etc/systemd/system',
      systemdReloadCommand: 'reload-systemd',
      systemdEnableTimerCommand: 'enable-timers'
    },
    apps: [
      {
        id: 'chat-router',
        repoUrl: 'git@github.com:example/chat-router.git',
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
        execStart: '/usr/bin/bash __CURRENT__/job.sh',
        user: 'deploy'
      }
    ]
  });

  assert.equal(config.apps[0].enabled, true);
  assert.equal(config.scheduledJobs[0].enabled, true);
  assert.deepEqual(config.features, []);
});
