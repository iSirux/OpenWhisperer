/** Stop automatic retries after three rejected continuations; manual retry starts fresh. */
export const MAX_USAGE_LIMIT_RETRIES = 3;
export const USAGE_LIMIT_RETRY_DELAY_MS = 60_000;
export const USAGE_LIMIT_CONTINUATION = 'Continue the unfinished task from where you stopped when the usage limit was reached. Check the existing conversation and completed work, and carry out the remaining steps without repeating completed actions.';

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
