/**
 * Turning the Claude Agent SDK's running totals into per-turn deltas.
 *
 * A Claude session is ONE long-lived `query()` (prompts are stream-injected), and
 * the SDK's result message mixes two kinds of fields (verified against SDK 0.3.x
 * with a live multi-turn + resume run, and across ~3,400 archived sessions):
 *
 * - **Running totals for the CLI process:** `total_cost_usd` and `duration_api_ms`.
 *   Each result carries the total so far. A new process (stop + new prompt, app
 *   restart, …) starts again from 0, or from a total restored from the transcript
 *   on resume. That restored total can be stale: it's the last total the CLI
 *   *saved*, which an aborted process never writes.
 * - **Per turn:** `usage.*` tokens, `duration_ms` and `num_turns`.
 *
 * Summing the running totals, as the session store used to do, inflated session
 * costs many times over: per-turn values 4.35 → 12.01 → 12.17 summed to 28.5 when
 * the real spend was 12.17. `SdkSessionUsage.queryUsage[]` still stores the RAW
 * values the SDK reported, so the corrected totals can be rebuilt at any time
 * (on load, for sessions recorded before this fix) with the same function.
 *
 * Codex sessions report 0 for both fields, so every delta is 0 for them.
 */

/** The cumulative fields of one per-turn usage record (`SdkUsage`). */
export interface CumulativeUsageSample {
  totalCostUsd?: number;
  durationApiMs?: number;
}

/** What the previous results of the session left behind. */
export interface CumulativeUsageState {
  /** Last nonzero raw `total_cost_usd` seen. */
  lastCost: number;
  /** Last nonzero raw `duration_api_ms` seen (0 = unknown since the last reset). */
  lastApi: number;
  /** Every nonzero raw cost seen, used to recognise a restored total. */
  seenCosts: number[];
}

export interface CumulativeUsageStep {
  costDelta: number;
  apiDelta: number;
  state: CumulativeUsageState;
}

const EPSILON = 1e-9;

export function emptyCumulativeUsageState(): CumulativeUsageState {
  return { lastCost: 0, lastApi: 0, seenCosts: [] };
}

function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Feed one result's raw running totals in and get this turn's share back.
 *
 * - Both values grow → the same CLI process: the delta is the growth.
 * - Either value shrinks → a new CLI process. The cost then counts in full,
 *   unless it exactly equals a total seen earlier: that's a total restored from
 *   the transcript with nothing spent yet (seen as a zero-work result right after
 *   a resume), so it adds nothing. A restored total that already includes new
 *   spend can't be told apart from a fresh one and is counted in full; this is
 *   rare and only ever over-counts by the restored amount.
 * - An all-zero result (crash/startup error, Codex) carries no information and
 *   leaves the state alone, so the next real total still diffs against the last
 *   real one.
 */
export function stepCumulativeUsage(
  state: CumulativeUsageState,
  sample: CumulativeUsageSample,
): CumulativeUsageStep {
  const cost = finite(sample.totalCostUsd);
  const api = finite(sample.durationApiMs);
  if (cost === 0 && api === 0) {
    return { costDelta: 0, apiDelta: 0, state };
  }

  const apiKnown = api > 0;
  const reset =
    cost < state.lastCost - EPSILON ||
    (apiKnown && state.lastApi > 0 && api < state.lastApi);

  let costDelta: number;
  let apiDelta: number;
  if (!reset) {
    costDelta = Math.max(0, cost - state.lastCost);
    apiDelta = apiKnown ? Math.max(0, api - state.lastApi) : 0;
  } else if (cost > 0 && state.seenCosts.some(c => Math.abs(c - cost) < EPSILON)) {
    costDelta = 0;
    apiDelta = 0;
  } else {
    costDelta = cost;
    apiDelta = api;
  }

  return {
    costDelta,
    apiDelta,
    state: {
      lastCost: cost,
      lastApi: apiKnown ? api : reset ? 0 : state.lastApi,
      seenCosts: cost > 0 ? [...state.seenCosts, cost] : state.seenCosts,
    },
  };
}

/** Replay a session's recorded results to get the state the next one diffs against. */
export function replayCumulativeUsage(samples: readonly CumulativeUsageSample[]): CumulativeUsageState {
  let state = emptyCumulativeUsageState();
  for (const sample of samples) {
    state = stepCumulativeUsage(state, sample).state;
  }
  return state;
}

/**
 * Corrected session totals from raw per-result records (`SdkSessionUsage.queryUsage`).
 * Works for every session ever recorded — old ones whose stored totals summed the
 * running totals, and new ones — since the records themselves were always raw.
 */
export function correctedCumulativeTotals(samples: readonly CumulativeUsageSample[]): {
  totalCostUsd: number;
  totalDurationApiMs: number;
} {
  let state = emptyCumulativeUsageState();
  let totalCostUsd = 0;
  let totalDurationApiMs = 0;
  for (const sample of samples) {
    const step = stepCumulativeUsage(state, sample);
    totalCostUsd += step.costDelta;
    totalDurationApiMs += step.apiDelta;
    state = step.state;
  }
  return { totalCostUsd, totalDurationApiMs: Math.round(totalDurationApiMs) };
}
