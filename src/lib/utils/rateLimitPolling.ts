/**
 * Whether a rate-limit store is due for another fetch.
 *
 * Measured from the later of the last success and the last attempt. `lastFetched` only moves
 * on success, so measuring from it alone made every `fetchIfStale` caller refetch at once
 * during a failure streak, ignoring the backoff (a 429 storm polled every 30 s while logging
 * "next retry in 900s").
 */
export function rateLimitFetchDue(
  lastFetched: number | null,
  lastAttemptAt: number,
  intervalMs: number,
  now: number
): boolean {
  const since = Math.max(lastFetched ?? 0, lastAttemptAt);
  return now - since > intervalMs;
}
