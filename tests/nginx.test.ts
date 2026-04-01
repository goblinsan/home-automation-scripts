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
      stripRoutePrefix: true,
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

test('renderGatewaySite includes active upstream and route path', () => {
  const output = renderGatewaySite(config);
  assert.match(output, /include \/etc\/nginx\/conf\.d\/upstreams\/chat-router-active\.conf;/);
  assert.match(output, /location \/chat\//);
  assert.match(output, /proxy_pass http:\/\/chat-router_active\//);
  assert.match(output, /proxy_set_header X-Forwarded-Prefix \/chat\//);
});

test('renderGatewaySite includes admin ui route when enabled', () => {
  const output = renderGatewaySite(config);
  assert.match(output, /location = \/admin/);
  assert.match(output, /proxy_pass http:\/\/127\.0\.0\.1:4173\//);
  assert.match(output, /proxy_set_header X-Forwarded-Prefix \/admin\//);
});

test('renderGatewaySite includes dedicated hostname blocks for apps', () => {
  const output = renderGatewaySite(config);
  assert.match(output, /server_name chat\.gateway.example.test;/);
  assert.match(output, /client_header_buffer_size 16k;/);
  assert.match(output, /large_client_header_buffers 4 32k;/);
  assert.match(output, /location \/ \{/);
  assert.match(output, /proxy_pass http:\/\/chat-router_active;/);
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
        hostnames: ['disabled.gateway.example.test'],
        routePath: '/disabled/',
        stripRoutePrefix: false,
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
