// Run: npx tsx --test src/lib/utils/usageCost.test.ts
//
// Fixtures are raw (totalCostUsd, durationApiMs) pairs from real Claude results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  correctedCumulativeTotals,
  emptyCumulativeUsageState,
  replayCumulativeUsage,
  stepCumulativeUsage,
} from './usageCost';

const rows = (pairs: Array<[number, number]>) =>
  pairs.map(([totalCostUsd, durationApiMs]) => ({ totalCostUsd, durationApiMs }));

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `expected ${expected}, got ${actual}`);

test('one long-lived query: the last running total is the session total', () => {
  // Live SDK 0.3.284 run: three streamed turns.
  const totals = correctedCumulativeTotals(rows([[0.038543, 2265], [0.0425352, 2932], [0.0449081, 3621]]));
  close(totals.totalCostUsd, 0.0449081);
  assert.equal(totals.totalDurationApiMs, 3621);
});

test('the example from the bug report: 4.35 → 12.01 → 12.17 is 12.17, not 28.5', () => {
  const totals = correctedCumulativeTotals(rows([[4.35, 1000], [12.01, 2000], [12.17, 2100]]));
  close(totals.totalCostUsd, 12.17);
});

test('resume that continues the running total counts only the growth', () => {
  // Same live run, resumed in a new query(): the CLI restored 0.0449081 + 3621 ms.
  const totals = correctedCumulativeTotals(
    rows([[0.038543, 2265], [0.0425352, 2932], [0.0449081, 3621], [0.048196, 4626], [0.0521042, 5606]]),
  );
  close(totals.totalCostUsd, 0.0521042);
  assert.equal(totals.totalDurationApiMs, 5606);
});

test('a new process starting from zero counts its first total in full', () => {
  // Cost shrinks → reset.
  close(correctedCumulativeTotals(rows([[1, 100], [3, 300], [0.5, 50], [0.8, 80]])).totalCostUsd, 3.8);
  // Cost grows past the old total, but the API time shrank → still a reset.
  close(correctedCumulativeTotals(rows([[1, 100_000], [3, 300_000], [4, 20_000]])).totalCostUsd, 7);
});

test('a stale restored total (zero-work result) adds nothing — real session 550eff6b', () => {
  // Query 1 (fresh) → query 2 (resumed, continued 6.8067) → query 3 (resumed from the
  // stale saved 6.8067; query 2 was aborted and never saved its total).
  const q = rows([
    [1.2716, 98597], [2.4418, 253122], [3.062, 394262], [6.1658, 986223], [6.6861, 1102882],
    [6.8067, 1130741], [6.8067, 1130741],
    [8.1933, 1319506], [23.0039, 3228466], [27.6745, 3554724], [41.5813, 4590312],
    [6.8067, 0],
    [9.2149, 1146149], [10.3325, 1213476], [21.0967, 2113459], [32.3083, 3170702], [35.3222, 3272368],
  ]);
  // Stored total under the old summing was 248.78.
  close(correctedCumulativeTotals(q).totalCostUsd, 41.5813 + (35.3222 - 6.8067));
});

test('all-zero results (crash/startup error, Codex) leave the running total alone', () => {
  close(correctedCumulativeTotals(rows([[2, 200], [0, 0], [2.5, 250]])).totalCostUsd, 2.5);
  const codex = correctedCumulativeTotals(rows([[0, 0], [0, 0], [0, 0]]));
  assert.equal(codex.totalCostUsd, 0);
  assert.equal(codex.totalDurationApiMs, 0);
});

test('stepping after a replay matches the batch total', () => {
  const q = rows([[1, 100], [2, 250], [0.4, 40], [1.1, 90]]);
  const state = replayCumulativeUsage(q.slice(0, 3));
  const step = stepCumulativeUsage(state, q[3]);
  close(step.costDelta, 0.7);
  close(correctedCumulativeTotals(q).totalCostUsd, 2 + 1.1);
  assert.deepEqual(stepCumulativeUsage(emptyCumulativeUsageState(), {}).costDelta, 0);
});
