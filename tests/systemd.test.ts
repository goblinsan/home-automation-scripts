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
      hostnames: ['chat.gateway.example.test'],
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
  workerNodes: [],
  remoteWorkloads: [],
  features: [],
  serviceProfiles: {
    gatewayApi: {
      enabled: false,
      appId: 'chat-router',
      apiBaseUrl: 'http://127.0.0.1:3000',
      envFilePath: '/srv/apps/chat-router/shared/gateway-api.env',
      environment: [],
      jobRuntime: {
        channelsFilePath: '/srv/apps/chat-router/shared/job-channels.json',
        channels: []
      },
      kulrsActivity: {
        enabled: false,
        description: 'KULRS activity automation',
        schedule: '*:0/5',
        workingDirectory: '__CURRENT__',
        execStart: '/usr/bin/node __CURRENT__/jobs/kulrs_activity.js',
        user: 'deploy',
        envFilePath: '/srv/apps/chat-router/shared/kulrs-activity.env',
        credentialsFilePath: '/srv/apps/chat-router/shared/kulrs.json',
        workspaceDir: '/srv/apps/chat-router/shared/kulrs',
        timezone: 'America/New_York',
        unsplashAccessKey: '',
        firebaseApiKey: '',
        bots: []
      }
    },
    gatewayChatPlatform: {
      enabled: false,
      appId: 'chat-router',
      apiBaseUrl: 'http://127.0.0.1:3000',
      apiEnvFilePath: '/srv/apps/chat-router/shared/chat-api.env',
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
  assert.match(output, /Environment=PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/);
  assert.match(output, /ExecStart=\/usr\/bin\/node \/opt\/gateway-control-plane\/src\/cli\.ts serve-ui/);
  assert.match(output, /--config \/opt\/gateway-control-plane\/configs\/gateway\.config\.json/);
  assert.match(output, /Restart=on-failure/);
});
