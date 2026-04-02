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
      },
      {
        id: 'pi-node',
        enabled: true,
        description: 'Raspberry Pi node',
        host: '198.51.100.50',
        sshUser: 'deploy',
        sshPort: 22,
        buildRoot: '/opt/gateway-control-plane',
        stackRoot: '/opt/gateway-control-plane/stacks',
        volumeRoot: '/opt/gateway-control-plane/volumes',
        workerPollIntervalSeconds: 30,
        nodeCommand: '/usr/bin/node',
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
          networkMode: 'host',
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
      },
      piProxy: {
        enabled: true,
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
  const workerDockerfile = await readFile(join(outDir, 'nodes', 'core-node', 'worker', 'Dockerfile'), 'utf8');
  const workerCompose = await readFile(join(outDir, 'nodes', 'core-node', 'worker', 'compose.yml'), 'utf8');
  const minecraftCompose = await readFile(join(outDir, 'nodes', 'core-node', 'workloads', 'bedrock-main', 'compose.yml'), 'utf8');
  const minecraftUpdateScript = await readFile(join(outDir, 'nodes', 'core-node', 'workloads', 'bedrock-main', 'scripts', 'update-if-empty.sh'), 'utf8');
  const minecraftBootstrapScript = await readFile(join(outDir, 'nodes', 'core-node', 'workloads', 'bedrock-main', 'scripts', 'bootstrap-world.sh'), 'utf8');
  const behaviorManifest = await readFile(join(outDir, 'nodes', 'core-node', 'workloads', 'bedrock-main', 'runtime', 'world_behavior_packs.json'), 'utf8');
  const piProxyPackageJson = await readFile(join(outDir, 'nodes', 'pi-node', 'pi-proxy', 'package.json'), 'utf8');
  const piProxyConfig = await readFile(join(outDir, 'nodes', 'pi-node', 'pi-proxy', 'proxy-config.json'), 'utf8');
  const piProxyScript = await readFile(join(outDir, 'nodes', 'pi-node', 'pi-proxy', 'proxy.mjs'), 'utf8');
  const piProxyService = await readFile(join(outDir, 'nodes', 'pi-node', 'pi-proxy', 'systemd', 'bedrock-lan-proxy.service'), 'utf8');

  assert.match(jobCompose, /node jobs\/kulrs_activity\.js/);
  assert.match(jobCompose, /\/runtime:ro/);
  assert.match(jobDockerfile, /FROM node:24-bookworm-slim/);
  assert.match(jobJson, /firebase-test/);
  assert.match(workerConfig, /"\s*runtimeDir": "\/runtime"/);
  assert.match(workerConfig, /"\s*pollIntervalSeconds": 15/);
  assert.match(workerConfig, /"\s*schedule": "\*:0\/30"/);
  assert.match(workerScript, /runScheduledJob/);
  assert.match(workerDockerfile, /FROM docker:28-cli/);
  assert.match(workerDockerfile, /apk add --no-cache nodejs unzip/);
  assert.match(workerCompose, /gateway-worker:/);
  assert.match(workerCompose, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.match(workerCompose, /\/runtime\/worker-config\.json/);
  assert.match(workerScript, /pull server/);
  assert.match(workerScript, /up -d --force-recreate server/);
  assert.match(minecraftCompose, /itzg\/minecraft-bedrock-server:latest/);
  assert.match(minecraftCompose, /network_mode: "host"/);
  assert.doesNotMatch(minecraftCompose, /19132:19132\/udp/);
  assert.match(minecraftCompose, /TEXTUREPACK_REQUIRED/);
  assert.match(minecraftUpdateScript, /send-command list/);
  assert.match(minecraftUpdateScript, /bootstrap-world\.sh/);
  assert.match(minecraftBootstrapScript, /gateway-main\.mcworld/);
  assert.match(minecraftBootstrapScript, /chmod -R a\+rwX/);
  assert.match(behaviorManifest, /11111111-1111-1111-1111-111111111111/);
  assert.doesNotMatch(piProxyPackageJson, /bedrock-protocol/);
  assert.match(piProxyConfig, /http:\/\/192\.168\.0\.200:4173\/api\/minecraft\/server-registry/);
  assert.match(piProxyScript, /import dgram from 'node:dgram'/);
  assert.match(piProxyScript, /created relay session/);
  assert.match(piProxyScript, /received /);
  assert.match(piProxyScript, /relayed /);
  assert.match(piProxyScript, /mode: 'udp-relay'/);
  assert.match(piProxyService, /ExecStart=\/usr\/bin\/node \/opt\/bedrock-lan-proxy\/proxy\.mjs \/opt\/bedrock-lan-proxy\/proxy-config\.json/);
});
