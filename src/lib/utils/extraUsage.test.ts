// Run: npx tsx --test src/lib/utils/extraUsage.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extraUsageUsable } from './extraUsage';

const extra = (o: Partial<Parameters<typeof extraUsageUsable>[0] & object>) => ({
  is_enabled: true,
  monthly_limit: null,
  used_credits: null,
  utilization: null,
  ...o,
});

test('a zero cap has nothing to spend (what Claude subscription accounts report)', () => {
  assert.equal(extraUsageUsable(extra({ monthly_limit: 0 }), 100), false);
});

test('disabled or missing extra usage is not usable', () => {
  assert.equal(extraUsageUsable(extra({ is_enabled: false, monthly_limit: 5000 }), 100), false);
  assert.equal(extraUsageUsable(null, 100), false);
});

test('credits left under a real cap are usable, a spent cap is not', () => {
  assert.equal(extraUsageUsable(extra({ monthly_limit: 5000, used_credits: 1200 }), 100), true);
  assert.equal(extraUsageUsable(extra({ monthly_limit: 5000, used_credits: 5000 }), 100), false);
});

test('falls back to utilization, then to the switch alone', () => {
  assert.equal(extraUsageUsable(extra({ monthly_limit: 5000, utilization: 40 }), 100), true);
  assert.equal(extraUsageUsable(extra({ utilization: 100 }), 100), false);
  assert.equal(extraUsageUsable(extra({}), 100), true);
});
