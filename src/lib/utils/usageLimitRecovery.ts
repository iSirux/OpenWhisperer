// Type-only imports (erased at build; sdkSessions value-imports this module).
import type { RateLimitedState } from '$lib/stores/sdkSessions';
import type { SdkProvider } from '$lib/utils/models';

/** Stop automatic retries after three rejected continuations; manual retry starts fresh. */
export const MAX_USAGE_LIMIT_RETRIES = 3;
export const USAGE_LIMIT_RETRY_DELAY_MS = 60_000;
export const USAGE_LIMIT_CONTINUATION = 'Continue the unfinished task from where you stopped when the usage limit was reached. Check the existing conversation and completed work, and carry out the remaining steps without repeating completed actions.';

/**
 * Background subagents that die on a usage limit send no task_notification, so the parent's
 * deferred completion only ends at the idle watchdog. If the account is still exhausted at
 * that point, the subagents were cut off rather than finished: park a continuation for the
 * reset. Returns null when the turn simply went quiet.
 */
export function cutOffBySubagentLimit(
  stuckSubagents: number,
  exhaustion: { exhausted: boolean; window?: '5h' | '7d'; resetsAt?: number },
  provider: SdkProvider,
  id: string,
  now: number,
): RateLimitedState | null {
  if (stuckSubagents === 0 || !exhaustion.exhausted) return null;
  return {
    id,
    reason: 'rate_limit',
    provider,
    window: exhaustion.window,
    resetsAt: exhaustion.resetsAt,
    interrupted: true,
    continuation: true,
    retryAttempts: 0,
    prompt: USAGE_LIMIT_CONTINUATION,
    queuedAt: now,
  };
}

export function usageLimitReady(
  item: { queuedAt: number; targetStartAt?: number; retryAttempts?: number },
  snapshot: { data: unknown; lastFetched: number | null; consecutiveFailures: number },
  exhausted: boolean,
  now: number,
): boolean {
  if ((item.retryAttempts ?? 0) >= MAX_USAGE_LIMIT_RETRIES) return false;
  const earliest = Math.max(item.queuedAt + USAGE_LIMIT_RETRY_DELAY_MS, item.targetStartAt ?? 0);
  return now >= earliest && snapshot.data != null && snapshot.consecutiveFailures === 0 &&
    snapshot.lastFetched != null && snapshot.lastFetched >= earliest &&
    now - snapshot.lastFetched < 3 * 60_000 && !exhausted;
}
