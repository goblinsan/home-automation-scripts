import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderEnvFile,
  renderGatewayApiJobChannels,
  renderGatewayChatAgents,
  renderKulrsActivityEnv,
  renderKulrsCredentials
} from '../src/lib/service-profiles.ts';

test('renderEnvFile serializes environment entries with comments and escaping', () => {
  const output = renderEnvFile([
    {
      key: 'PORT',
      value: '3000',
      secret: false,
      description: 'Service port'
    },
    {
      key: 'OPENAI_API_KEY',
      value: 'sk-test value',
      secret: true
    }
  ]);

  assert.match(output, /# Service port/);
  assert.match(output, /PORT=3000/);
  assert.match(output, /OPENAI_API_KEY="sk-test value"/);
});

test('renderGatewayApiEnv includes derived job runtime settings', async () => {
  const { renderGatewayApiEnv } = await import('../src/lib/service-profiles.ts');
  const output = renderGatewayApiEnv({
    enabled: true,
    appId: 'gateway-api',
    apiBaseUrl: 'http://127.0.0.1:3000',
    envFilePath: '/srv/apps/gateway-api/shared/gateway-api.env',
    environment: [],
    jobRuntime: {
      channelsFilePath: '/srv/apps/gateway-api/shared/job-channels.json',
      channels: []
    },
    kulrsActivity: {
      enabled: false,
      description: 'KULRS activity automation',
      schedule: '*:0/5',
      workingDirectory: '__CURRENT__',
      execStart: '/usr/bin/node __CURRENT__/jobs/kulrs_activity.js',
      user: 'deploy',
      envFilePath: '/srv/apps/gateway-api/shared/kulrs-activity.env',
      credentialsFilePath: '/srv/apps/gateway-api/shared/kulrs.json',
      workspaceDir: '/srv/apps/gateway-api/shared/kulrs',
      timezone: 'America/New_York',
      unsplashAccessKey: '',
      firebaseApiKey: '',
      bots: []
    }
  });

  assert.match(output, /GATEWAY_JOB_CHANNELS_PATH=\/srv\/apps\/gateway-api\/shared\/job-channels\.json/);
});

test('renderGatewayChatAgents emits sync payload shape', () => {
  const output = renderGatewayChatAgents({
    enabled: true,
    appId: 'gateway-chat-platform',
    apiBaseUrl: 'http://127.0.0.1:3000',
    apiEnvFilePath: '/srv/apps/gateway-chat-platform/shared/chat-api.env',
    environment: [],
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
  });

  assert.match(output, /"agents"/);
  assert.match(output, /"marvin"/);
});

test('renderGatewayChatPlatformEnv includes derived local tts settings', async () => {
  const { renderGatewayChatPlatformEnv } = await import('../src/lib/service-profiles.ts');
  const output = renderGatewayChatPlatformEnv({
    enabled: true,
    appId: 'gateway-chat-platform',
    apiBaseUrl: 'http://127.0.0.1:3000',
    apiEnvFilePath: '/srv/apps/gateway-chat-platform/shared/chat-api.env',
    environment: [],
    tts: {
      enabled: true,
      baseUrl: 'http://198.51.100.111:5000',
      defaultVoice: 'assistant_v1',
      generatePath: '/tts',
      streamPath: '/tts/stream',
      voicesPath: '/voices',
      healthPath: '/health'
    },
    agents: []
  });

  assert.match(output, /TTS_ENABLED=true/);
  assert.match(output, /TTS_BASE_URL=http:\/\/198\.51\.100\.111:5000/);
  assert.match(output, /TTS_DEFAULT_VOICE=assistant_v1/);
});

test('renderKulrsActivityEnv exposes derived runtime settings', () => {
  const output = renderKulrsActivityEnv({
    enabled: true,
    description: 'KULRS activity automation',
    schedule: '*:0/5',
    workingDirectory: '__CURRENT__',
    execStart: '/usr/bin/node __CURRENT__/jobs/kulrs_activity.js',
    user: 'deploy',
    envFilePath: '/srv/apps/gateway-api/shared/kulrs-activity.env',
    credentialsFilePath: '/srv/apps/gateway-api/shared/kulrs.json',
    workspaceDir: '/srv/apps/gateway-api/shared/kulrs',
    timezone: 'America/New_York',
    unsplashAccessKey: 'unsplash-test',
    firebaseApiKey: 'firebase-test',
    bots: []
  });

  assert.match(output, /UNSPLASH_ACCESS_KEY=unsplash-test/);
  assert.match(output, /KULRS_WORKSPACE_DIR=\/srv\/apps\/gateway-api\/shared\/kulrs/);
  assert.match(output, /KULRS_CREDS_PATH=\/srv\/apps\/gateway-api\/shared\/kulrs\.json/);
});

test('renderGatewayApiJobChannels emits named channel config JSON', () => {
  const output = renderGatewayApiJobChannels({
    channelsFilePath: '/srv/apps/gateway-api/shared/job-channels.json',
    channels: [
      {
        id: 'jim-telegram',
        type: 'telegram',
        enabled: true,
        botToken: 'telegram-token',
        chatId: '12345'
      }
    ]
  });

  assert.match(output, /"channels"/);
  assert.match(output, /"jim-telegram"/);
  assert.match(output, /"telegram"/);
});

test('renderKulrsCredentials emits the legacy kulrs.json shape', () => {
  const output = renderKulrsCredentials({
    enabled: true,
    description: 'KULRS activity automation',
    schedule: '*:0/5',
    workingDirectory: '__CURRENT__',
    execStart: '/usr/bin/node __CURRENT__/jobs/kulrs_activity.js',
    user: 'deploy',
    envFilePath: '/srv/apps/gateway-api/shared/kulrs-activity.env',
    credentialsFilePath: '/srv/apps/gateway-api/shared/kulrs.json',
    workspaceDir: '/srv/apps/gateway-api/shared/kulrs',
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
  });

  assert.match(output, /"firebaseApiKey": "firebase-test"/);
  assert.match(output, /"mireille"/);
  assert.match(output, /"email": "mireille@example.com"/);
});
