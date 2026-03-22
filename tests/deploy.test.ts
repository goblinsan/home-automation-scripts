import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installServiceProfileFiles, syncServiceProfileRuntime } from '../src/lib/deploy.ts';
import type { GatewayConfig } from '../src/lib/config.ts';

function createConfig(root: string): GatewayConfig {
  return {
    gateway: {
      serverNames: ['gateway.example.test'],
      nginxSiteOutputPath: '/etc/nginx/sites-available/gateway',
      upstreamDirectory: '/etc/nginx/conf.d/upstreams',
      nginxReloadCommand: 'reload',
      systemdUnitDirectory: '/etc/systemd/system',
      systemdReloadCommand: 'reload-systemd',
      systemdEnableTimerCommand: 'enable',
      adminUi: {
        enabled: false,
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
        id: 'gateway-api',
        enabled: true,
        repoUrl: 'git@example/gateway-api.git',
        defaultRevision: 'main',
        deployRoot: '/srv/apps/gateway-api',
        routePath: '/api/',
        healthPath: '/health',
        upstreamConfPath: '/etc/nginx/conf.d/upstreams/gateway-api-active.conf',
        buildCommands: ['npm install'],
        slots: {
          blue: { port: 3201, startCommand: 'start-blue', stopCommand: 'stop-blue' },
          green: { port: 3202, startCommand: 'start-green', stopCommand: 'stop-green' }
        }
      },
      {
        id: 'gateway-chat-platform',
        enabled: true,
        repoUrl: 'git@example/gateway-chat-platform.git',
        defaultRevision: 'main',
        deployRoot: '/srv/apps/gateway-chat-platform',
        routePath: '/chat/',
        healthPath: '/api/health',
        upstreamConfPath: '/etc/nginx/conf.d/upstreams/gateway-chat-platform-active.conf',
        buildCommands: ['pnpm install'],
        slots: {
          blue: { port: 3301, startCommand: 'start-blue', stopCommand: 'stop-blue' },
          green: { port: 3302, startCommand: 'start-green', stopCommand: 'stop-green' }
        }
      }
    ],
    scheduledJobs: [],
    features: [],
    serviceProfiles: {
      gatewayApi: {
        enabled: true,
        appId: 'gateway-api',
        apiBaseUrl: 'http://127.0.0.1:3000',
        envFilePath: join(root, 'gateway-api.env'),
        environment: [{ key: 'PORT', value: '3000', secret: false }]
      },
      gatewayChatPlatform: {
        enabled: true,
        appId: 'gateway-chat-platform',
        apiBaseUrl: 'http://127.0.0.1:3000',
        apiEnvFilePath: join(root, 'chat-api.env'),
        environment: [{ key: 'OPENAI_API_KEY', value: 'sk-test', secret: true }],
        agents: [
          {
            id: 'marvin',
            name: 'Marvin',
            icon: '🤖',
            color: '#6366f1',
            providerName: 'lm-studio-a',
            model: 'qwen/qwen3-32b',
            costClass: 'free',
            enabled: true,
            featureFlags: {},
            contextSources: []
          }
        ]
      }
    }
  };
}

test('installServiceProfileFiles writes env files for matching apps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-control-plane-'));
  const config = createConfig(root);
  const context = { dryRun: false, log: () => undefined };

  await installServiceProfileFiles(config, 'gateway-api', context);
  await installServiceProfileFiles(config, 'gateway-chat-platform', context);

  assert.match(await readFile(join(root, 'gateway-api.env'), 'utf8'), /PORT=3000/);
  assert.match(await readFile(join(root, 'chat-api.env'), 'utf8'), /OPENAI_API_KEY=sk-test/);
});

test('syncServiceProfileRuntime accepts chat-platform app in dry-run mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-control-plane-'));
  const config = createConfig(root);
  const context = { dryRun: true, log: () => undefined };

  await syncServiceProfileRuntime(config, 'gateway-chat-platform', context, 'http://127.0.0.1:3301');
  assert.equal(config.serviceProfiles.gatewayChatPlatform.agents[0]?.id, 'marvin');
});
