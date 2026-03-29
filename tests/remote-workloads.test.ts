import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArtifacts } from '../src/lib/build.ts';
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
      systemdEnableTimerCommand: 'enable-timers',
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
        stripRoutePrefix: false,
        healthPath: '/health',
        upstreamConfPath: '/etc/nginx/conf.d/upstreams/gateway-api-active.conf',
        buildCommands: ['npm install'],
        slots: {
          blue: { port: 3201, startCommand: 'start-blue', stopCommand: 'stop-blue' },
          green: { port: 3202, startCommand: 'start-green', stopCommand: 'stop-green' }
        }
      }
    ],
    scheduledJobs: [],
    workerNodes: [
      {
        id: 'core-node',
        enabled: true,
        description: 'Core Debian node',
        host: '198.51.100.42',
        sshUser: 'deploy',
        sshPort: 22,
        buildRoot: '/mnt/fast/builds/gateway-workloads',
        stackRoot: '/mnt/storage/docker/stacks/gateway-workloads',
        volumeRoot: '/mnt/storage/docker/volumes/gateway-workloads',
        workerPollIntervalSeconds: 15,
        nodeCommand: 'node',
        systemdUnitDirectory: '/etc/systemd/system',
        systemdReloadCommand: 'sudo systemctl daemon-reload',
        systemdEnableTimerCommand: 'sudo systemctl enable --now',
        dockerCommand: 'docker',
        dockerComposeCommand: 'docker compose'
      }
    ],
    remoteWorkloads: [
      {
        id: 'kulrs-palette',
        enabled: true,
        nodeId: 'core-node',
        description: 'KULRS palette job',
        kind: 'scheduled-container-job',
        job: {
          schedule: '*:0/30',
          timezone: 'America/New_York',
          build: {
            strategy: 'generated-node',
            repoUrl: 'git@example/gateway-api.git',
            defaultRevision: 'main',
            contextPath: '.',
            packageRoot: '.',
            nodeVersion: '24',
            installCommand: 'npm ci --omit=dev'
          },
          runCommand: 'node jobs/kulrs_activity.js',
          environment: [
            { key: 'KULRS_CREDS_PATH', value: '/runtime/kulrs.json', secret: false }
          ],
          volumeMounts: [
            { source: '/mnt/storage/docker/volumes/gateway-workloads/kulrs-palette/workspace', target: '/workspace-data', readOnly: false }
          ],
          jsonFiles: [
            {
              relativePath: 'kulrs.json',
              payload: {
                firebaseApiKey: 'firebase-test',
                mireille: { email: 'mireille@example.com', password: 'secret' }
              }
            }
          ]
        }
      },
      {
        id: 'bedrock-main',
        enabled: true,
        nodeId: 'core-node',
        description: 'Main Bedrock world',
        kind: 'minecraft-bedrock-server',
        minecraft: {
          image: 'itzg/minecraft-bedrock-server:latest',
          serverName: 'Gateway Bedrock',
          worldName: 'gateway-main',
          gameMode: 'survival',
          difficulty: 'normal',
          levelSeed: '12345',
          worldSourcePath: '/mnt/storage/docker/shared/worlds/gateway-main.mcworld',
          worldCopyMode: 'if-missing',
          allowCheats: false,
          onlineMode: true,
          maxPlayers: 10,
          serverPort: 19132,
          autoStart: true,
          autoUpdateEnabled: true,
          autoUpdateSchedule: '*-*-* 04:00:00',
          texturepackRequired: true,
          behaviorPacks: [
            {
              id: 'mob-tweaks',
              sourcePath: '/mnt/storage/docker/shared/bedrock-packs/mob-tweaks-bp',
              manifestUuid: '11111111-1111-1111-1111-111111111111',
              manifestVersion: [1, 0, 0]
            }
          ],
          resourcePacks: [
            {
              id: 'mob-tweaks-rp',
              sourcePath: '/mnt/storage/docker/shared/bedrock-packs/mob-tweaks-rp',
              manifestUuid: '22222222-2222-2222-2222-222222222222',
              manifestVersion: [1, 0, 0]
            }
          ]
        }
      }
    ],
    features: [],
    serviceProfiles: {
      gatewayApi: {
        enabled: false,
        appId: 'gateway-api',
        apiBaseUrl: 'http://127.0.0.1:3000',
        envFilePath: join(root, 'gateway-api.env'),
        environment: [],
        jobRuntime: {
          channelsFilePath: join(root, 'job-channels.json'),
          channels: []
        },
        kulrsActivity: {
          enabled: false,
          description: 'KULRS activity automation',
          schedule: '*:0/5',
          workingDirectory: '__CURRENT__',
          execStart: '/usr/bin/node __CURRENT__/jobs/kulrs_activity.js',
          user: 'deploy',
          envFilePath: join(root, 'kulrs-activity.env'),
          credentialsFilePath: join(root, 'kulrs.json'),
          workspaceDir: join(root, 'kulrs'),
          timezone: 'America/New_York',
          unsplashAccessKey: '',
          firebaseApiKey: '',
          bots: []
        }
      },
      gatewayChatPlatform: {
        enabled: false,
        appId: 'gateway-api',
        apiBaseUrl: 'http://127.0.0.1:3000',
        apiEnvFilePath: join(root, 'chat-api.env'),
        environment: [],
        tts: {
          enabled: false,
          baseUrl: 'http://198.51.100.111:5000',
          defaultVoice: 'assistant_v1',
          generatePath: '/tts',
          streamPath: '/tts/stream',
          voicesPath: '/voices',
          healthPath: '/health'
        },
        agents: []
      }
    }
  };
}

test('buildArtifacts renders remote workload bundles for core nodes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-control-plane-'));
  const outDir = join(root, 'generated');
  const config = createConfig(root);

  await buildArtifacts(config, outDir);

  const jobCompose = await readFile(join(outDir, 'nodes', 'core-node', 'workloads', 'kulrs-palette', 'compose.yml'), 'utf8');
  const jobDockerfile = await readFile(join(outDir, 'nodes', 'core-node', 'workloads', 'kulrs-palette', 'Dockerfile'), 'utf8');
  const jobJson = await readFile(join(outDir, 'nodes', 'core-node', 'workloads', 'kulrs-palette', 'runtime', 'kulrs.json'), 'utf8');
  const workerConfig = await readFile(join(outDir, 'nodes', 'core-node', 'worker', 'worker-config.json'), 'utf8');
  const workerScript = await readFile(join(outDir, 'nodes', 'core-node', 'worker', 'gateway-worker.mjs'), 'utf8');
  const minecraftCompose = await readFile(join(outDir, 'nodes', 'core-node', 'workloads', 'bedrock-main', 'compose.yml'), 'utf8');
  const minecraftUpdateScript = await readFile(join(outDir, 'nodes', 'core-node', 'workloads', 'bedrock-main', 'scripts', 'update-if-empty.sh'), 'utf8');
  const minecraftBootstrapScript = await readFile(join(outDir, 'nodes', 'core-node', 'workloads', 'bedrock-main', 'scripts', 'bootstrap-world.sh'), 'utf8');
  const behaviorManifest = await readFile(join(outDir, 'nodes', 'core-node', 'workloads', 'bedrock-main', 'runtime', 'world_behavior_packs.json'), 'utf8');

  assert.match(jobCompose, /node jobs\/kulrs_activity\.js/);
  assert.match(jobCompose, /\/runtime:ro/);
  assert.match(jobDockerfile, /FROM node:24-bookworm-slim/);
  assert.match(jobJson, /firebase-test/);
  assert.match(workerConfig, /"\s*pollIntervalSeconds": 15/);
  assert.match(workerConfig, /"\s*schedule": "\*:0\/30"/);
  assert.match(workerScript, /runScheduledJob/);
  assert.match(minecraftCompose, /itzg\/minecraft-bedrock-server:latest/);
  assert.match(minecraftCompose, /TEXTUREPACK_REQUIRED/);
  assert.match(minecraftUpdateScript, /send-command list/);
  assert.match(minecraftUpdateScript, /bootstrap-world\.sh/);
  assert.match(minecraftBootstrapScript, /gateway-main\.mcworld/);
  assert.match(behaviorManifest, /11111111-1111-1111-1111-111111111111/);
});
