/** Quota exhaustion only. Transient 429 throttles belong to the provider retry loop. */
export function isUsageLimitError(message: string): boolean {
  if (/not (?:your |a )?usage limit|temporarily limiting requests/i.test(message)) return false;
  return /usage[ _]?limit|you(?:'ve| have) (?:hit|reached) (?:your|the) (?:session|weekly|opus|sonnet) limit|rate[ _-]?limit[\s\S]*reset/i.test(message);
}

type PendingUsageLimit = { status: string; resetsAt?: number; utilization?: number };

/**
 * The usage limit to report when a Claude turn ends with a *success* result. The SDK can
 * report a call rejected by the usage limit as a synthetic `error: "rate_limit"` assistant
 * message followed by a success result. If that message was the turn's last main-thread
 * assistant message, the turn was cut off, not finished, so it must park for the reset like
 * the error path. Otherwise (the turn recovered and kept going) a recorded limit is stale.
 */
export function usageLimitAtSuccess(
  pending: PendingUsageLimit | undefined,
  lastMainAssistantWasRateLimit: boolean
): PendingUsageLimit | undefined {
  return lastMainAssistantWasRateLimit ? pending : undefined;
}

export function appServerErrorMessage(error: Record<string, unknown> | undefined): string {
  const message = String(error?.message || 'Turn failed');
  const info = error?.codexErrorInfo;
  // Generated protocol versions use both string and externally tagged variants.
  const kind = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : '';
  return kind?.toLowerCase() === 'usagelimitexceeded' ? `Usage limit exceeded: ${message}` : message;
}
