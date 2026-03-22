import test from 'node:test';
import assert from 'node:assert/strict';
import { planWorkflowSeedImport } from '../src/lib/workflows.ts';

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
