// Run: npx tsx --test src/lib/utils/rateLimitPolling.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitFetchDue } from './rateLimitPolling';

const MIN = 60_000;

test('never fetched and never tried: due', () => {
  assert.equal(rateLimitFetchDue(null, 0, 3 * MIN, 1_000_000), true);
});

test('fresh success: not due until the interval passes', () => {
  const t = 10 * MIN;
  assert.equal(rateLimitFetchDue(t, t, 3 * MIN, t + 2 * MIN), false);
  assert.equal(rateLimitFetchDue(t, t, 3 * MIN, t + 4 * MIN), true);
});

test('failure streak: waits out the backoff from the last attempt, not the last success', () => {
  const lastOk = 0;
  const lastAttempt = 60 * MIN; // failed 22x; next retry in 900s
  const backoff = 15 * MIN;
  assert.equal(rateLimitFetchDue(lastOk, lastAttempt, backoff, lastAttempt + 30_000), false);
  assert.equal(rateLimitFetchDue(lastOk, lastAttempt, backoff, lastAttempt + 14 * MIN), false);
  assert.equal(rateLimitFetchDue(lastOk, lastAttempt, backoff, lastAttempt + 16 * MIN), true);
});

test('failures before any success still respect the backoff', () => {
  const lastAttempt = 5 * MIN;
  assert.equal(rateLimitFetchDue(null, lastAttempt, 6 * MIN, lastAttempt + 30_000), false);
});
