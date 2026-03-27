import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importWorkflowSeed, planWorkflowSeedImport } from '../src/lib/workflows.ts';

test('planWorkflowSeedImport creates missing workflows and updates matching names', () => {
  const operations = planWorkflowSeedImport(
    [
      {
        id: 'existing-id',
        name: 'training-weekly',
        schedule: '0 7 * * 1',
        target: { type: 'agent-turn', ref: 'bruvie-d' }
      }
    ],
    [
      {
        name: 'training-weekly',
        schedule: '0 7 * * 1',
        target: { type: 'agent-turn', ref: 'bruvie-d' }
      },
      {
        name: 'chief-of-staff-daily',
        schedule: '0 7 * * *',
        target: { type: 'system-event', ref: 'daily-brief' }
      }
    ]
  );

  assert.deepEqual(operations, [
    {
      type: 'update',
      name: 'training-weekly',
      id: 'existing-id',
      body: {
        name: 'training-weekly',
        schedule: '0 7 * * 1',
        target: { type: 'agent-turn', ref: 'bruvie-d' }
      }
    },
    {
      type: 'create',
      name: 'chief-of-staff-daily',
      body: {
        name: 'chief-of-staff-daily',
        schedule: '0 7 * * *',
        target: { type: 'system-event', ref: 'daily-brief' }
      }
    }
  ]);
});

test('importWorkflowSeed creates missing workflows and returns the executed plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-control-plane-'));
  const seedPath = join(root, 'seed.json');
  await writeFile(seedPath, JSON.stringify([
    {
      name: 'daily-brief',
      schedule: '0 7 * * *',
      target: { type: 'gateway-chat-platform.agent-turn', ref: 'bruvie-d' },
      input: { prompt: 'Generate the daily brief.' }
    }
  ]), 'utf8');
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];

  const result = await importWorkflowSeed(
    'http://127.0.0.1:3000',
    seedPath,
    { dryRun: false, log: () => undefined },
    undefined,
    async (_baseUrl, path, method, body) => {
      requests.push({ path, method, body });
      if (path === '/api/workflows' && method === 'GET') {
        return { status: 200, payload: [] };
      }
      if (path === '/api/workflows' && method === 'POST') {
        return { status: 201, payload: { id: 'wf-1' } };
      }
      return { status: 404, payload: { error: 'not found' } };
    }
  );

  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0]?.type, 'create');
  assert.equal(result.operations[0]?.name, 'daily-brief');
  assert.equal(result.filePath, seedPath);
  assert.deepEqual(requests, [
    { path: '/api/workflows', method: 'GET', body: undefined },
    {
      path: '/api/workflows',
      method: 'POST',
      body: {
        name: 'daily-brief',
        schedule: '0 7 * * *',
        target: { type: 'gateway-chat-platform.agent-turn', ref: 'bruvie-d' },
        input: { prompt: 'Generate the daily brief.' }
      }
    }
  ]);
});
