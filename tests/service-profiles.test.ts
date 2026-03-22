import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEnvFile, renderGatewayChatAgents } from '../src/lib/service-profiles.ts';

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
  assert.match(output, /TTS_BASE_URL=http:\/\/192\.168\.0\.111:5000/);
  assert.match(output, /TTS_DEFAULT_VOICE=assistant_v1/);
});
