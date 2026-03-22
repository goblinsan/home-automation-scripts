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
