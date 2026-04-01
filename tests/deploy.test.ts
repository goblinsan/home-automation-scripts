import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {
  extractDownloadedBedrockVersion,
  extractLatestBedrockVersion,
  installServiceProfileFiles,
  parseRemoteContainerInspectOutput,
  runServiceProfileAgent,
  smokeTestWithRetry,
  syncServiceProfileRuntime
} from '../src/lib/deploy.ts';
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
        hostnames: ['api.gateway.example.test'],
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
        hostnames: ['chat.gateway.example.test'],
        routePath: '/chat/',
        healthPath: '/api/agents',
        upstreamConfPath: '/etc/nginx/conf.d/upstreams/gateway-chat-platform-active.conf',
        buildCommands: ['pnpm install'],
        slots: {
          blue: { port: 3301, startCommand: 'start-blue', stopCommand: 'stop-blue' },
          green: { port: 3302, startCommand: 'start-green', stopCommand: 'stop-green' }
        }
      }
    ],
    scheduledJobs: [],
    workerNodes: [],
    remoteWorkloads: [],
    features: [],
    serviceProfiles: {
      gatewayApi: {
        enabled: true,
        appId: 'gateway-api',
        apiBaseUrl: 'http://127.0.0.1:3000',
        envFilePath: join(root, 'gateway-api.env'),
        environment: [{ key: 'PORT', value: '3000', secret: false }],
        jobRuntime: {
          channelsFilePath: join(root, 'job-channels.json'),
          channels: [
            {
              id: 'jim-webhook',
              type: 'webhook',
              enabled: true,
              webhookUrl: 'https://example.com/hooks/jim'
            }
          ]
        },
        kulrsActivity: {
          enabled: true,
          description: 'KULRS activity automation',
          schedule: '*:0/5',
          workingDirectory: '__CURRENT__',
          execStart: '/usr/bin/node __CURRENT__/jobs/kulrs_activity.js',
          user: 'deploy',
          envFilePath: join(root, 'kulrs-activity.env'),
          credentialsFilePath: join(root, 'kulrs.json'),
          workspaceDir: join(root, 'kulrs'),
          timezone: 'America/New_York',
          unsplashAccessKey: 'unsplash-test',
          firebaseApiKey: 'firebase-test',
          bots: [
            {
              id: 'mireille',
              email: 'mireille@example.com',
              password: 'secret'
            }
          ]
        }
      },
      gatewayChatPlatform: {
        enabled: true,
        appId: 'gateway-chat-platform',
        apiBaseUrl: 'http://127.0.0.1:3000',
        apiEnvFilePath: join(root, 'chat-api.env'),
        environment: [{ key: 'OPENAI_API_KEY', value: 'sk-test', secret: true }],
        tts: {
          enabled: true,
          baseUrl: 'http://198.51.100.111:5000',
          defaultVoice: 'assistant_v1',
          generatePath: '/tts',
          streamPath: '/tts/stream',
          voicesPath: '/voices',
          healthPath: '/health'
        },
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
      },
      piProxy: {
        enabled: false,
        description: 'Physical Raspberry Pi running the external Bedrock LAN proxy',
        nodeId: 'pi-node',
        installRoot: '/opt/bedrock-lan-proxy',
        systemdUnitName: 'bedrock-lan-proxy.service',
        registryBaseUrl: 'http://198.51.100.200:4173',
        listenHost: '0.0.0.0',
        listenPort: 19132,
        registryPath: '/api/minecraft/server-registry',
        pollIntervalSeconds: 30,
        serviceUser: 'deploy'
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
  assert.match(await readFile(join(root, 'job-channels.json'), 'utf8'), /jim-webhook/);
  assert.match(await readFile(join(root, 'kulrs-activity.env'), 'utf8'), /KULRS_WORKSPACE_DIR=/);
  assert.match(await readFile(join(root, 'kulrs.json'), 'utf8'), /"firebaseApiKey": "firebase-test"/);
  assert.match(await readFile(join(root, 'chat-api.env'), 'utf8'), /OPENAI_API_KEY=sk-test/);
});

test('syncServiceProfileRuntime accepts chat-platform app in dry-run mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-control-plane-'));
  const config = createConfig(root);
  const context = { dryRun: true, log: () => undefined };

  await syncServiceProfileRuntime(config, 'gateway-chat-platform', context, 'http://127.0.0.1:3301');
  assert.equal(config.serviceProfiles.gatewayChatPlatform.agents[0]?.id, 'marvin');
});

test('runServiceProfileAgent posts to the chat-platform agent run endpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-control-plane-'));
  const config = createConfig(root);
  let requestUrl = '';
  let requestBody: unknown;

  const result = await runServiceProfileAgent(
    config,
    'gateway-chat-platform',
    'marvin',
    { prompt: 'status check' },
    { dryRun: false, log: () => undefined },
    'http://127.0.0.1:3301',
    async (url, method, body) => {
      requestUrl = url;
      requestBody = body;
      assert.equal(method, 'POST');
      return {
        status: 200,
        body: JSON.stringify({
          agentId: 'marvin',
          usedProvider: 'lm-studio-a',
          model: 'qwen/qwen3-32b',
          content: 'systems nominal',
          latencyMs: 42,
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15
          }
        })
      };
    }
  );

  assert.equal(requestUrl, 'http://127.0.0.1:3301/api/agents/marvin/run');
  assert.deepEqual(requestBody, { prompt: 'status check' });
  assert.equal(result.agentId, 'marvin');
  assert.equal(result.usedProvider, 'lm-studio-a');
  assert.equal(result.content, 'systems nominal');
});

test('smokeTestWithRetry tolerates startup delays', async (t) => {
  let attempts = 0;
  const server = createServer((_, response) => {
    attempts += 1;
    response.statusCode = attempts >= 3 ? 200 : 503;
    response.end(attempts >= 3 ? 'ok' : 'warming');
  });

  const listenResult = await new Promise<'ok' | NodeJS.ErrnoException>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', (error) => resolve(error));
  });

  if (listenResult !== 'ok') {
    if (listenResult.code === 'EPERM') {
      t.skip('sandbox does not allow binding a local test server');
      return;
    }
    throw listenResult;
  }

  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    await smokeTestWithRetry(`http://127.0.0.1:${address.port}/health`, 200, 4, 10);
    assert.equal(attempts, 3);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

test('parseRemoteContainerInspectOutput includes image metadata', () => {
  const status = parseRemoteContainerInspectOutput(
    'gateway-bedrock-server',
    '{"Status":"running","Running":true,"StartedAt":"2026-04-01T20:00:00Z"}@@{"19132/udp":[{"HostIp":"0.0.0.0","HostPort":"19132"}]}@@"host"@@"itzg/minecraft-bedrock-server:latest"@@"sha256:bedrock123"@@"2026-04-01T19:55:00Z"'
  );

  assert.equal(status.exists, true);
  assert.equal(status.running, true);
  assert.equal(status.networkMode, 'host');
  assert.equal(status.configuredImage, 'itzg/minecraft-bedrock-server:latest');
  assert.equal(status.imageId, 'sha256:bedrock123');
  assert.equal(status.createdAt, '2026-04-01T19:55:00Z');
});

test('extract Bedrock versions from server logs', () => {
  const logs = [
    '[2026-04-01 20:40:10 INFO] Downloading Bedrock server version 1.26.12.3',
    '[2026-04-01 20:40:14 INFO] Version: 1.26.12.3',
    '[2026-04-01 20:40:18 INFO] Server started.',
    '[2026-04-01 20:42:01 INFO] Version: 1.26.12.4'
  ].join('\n');

  assert.equal(extractDownloadedBedrockVersion(logs), '1.26.12.3');
  assert.equal(extractLatestBedrockVersion(logs), '1.26.12.4');
});
