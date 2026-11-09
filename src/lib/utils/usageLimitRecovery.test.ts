// Run: npx tsx --test src/lib/utils/usageLimitRecovery.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USAGE_LIMIT_CONTINUATION, cutOffBySubagentLimit } from './usageLimitRecovery';

const exhausted = { exhausted: true, window: '5h' as const, resetsAt: 1_000 };

test('subagents silent while the account is exhausted park a continuation for the reset', () => {
  const turn = cutOffBySubagentLimit(3, exhausted, 'claude', 'pt_1', 500);
  assert.deepEqual(turn, {
    id: 'pt_1',
    reason: 'rate_limit',
    provider: 'claude',
    window: '5h',
    resetsAt: 1_000,
    interrupted: true,
    continuation: true,
    retryAttempts: 0,
    prompt: USAGE_LIMIT_CONTINUATION,
    queuedAt: 500,
  });
});

test('a quiet turn with headroom left just finalizes', () => {
  assert.equal(cutOffBySubagentLimit(3, { exhausted: false }, 'claude', 'pt_1', 500), null);
});

test('no stuck subagents means nothing was cut off', () => {
  assert.equal(cutOffBySubagentLimit(0, exhausted, 'claude', 'pt_1', 500), null);
});
