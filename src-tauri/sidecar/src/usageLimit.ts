/** Quota exhaustion only. Transient 429 throttles belong to the provider retry loop. */
export function isUsageLimitError(message: string): boolean {
  if (/not (?:your |a )?usage limit|temporarily limiting requests/i.test(message)) return false;
  return /usage[ _]?limit|you(?:'ve| have) (?:hit|reached) (?:your|the) (?:session|weekly|opus|sonnet) limit|rate[ _-]?limit[\s\S]*reset/i.test(message);
}

export function appServerErrorMessage(error: Record<string, unknown> | undefined): string {
  const message = String(error?.message || 'Turn failed');
  const info = error?.codexErrorInfo;
  // Generated protocol versions use both string and externally tagged variants.
  const kind = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : '';
  return kind?.toLowerCase() === 'usagelimitexceeded' ? `Usage limit exceeded: ${message}` : message;
}
