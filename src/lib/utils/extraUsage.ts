/** The extra-usage fields this check reads (structurally matches `ExtraUsage` in rateLimits). */
export interface ExtraUsageLike {
  is_enabled: boolean;
  monthly_limit: number | null; // cents
  used_credits: number | null; // cents
  utilization: number | null;
}

/**
 * Whether paid extra usage lets an account keep running after its included windows fill.
 * Providers may omit the derived utilization/amount fields, so an enabled switch is usable
 * unless a reported limit proves otherwise. A cap of 0 is such a proof: every Claude
 * subscription account reports `is_enabled: true, monthly_limit: 0` with nothing to spend.
 */
export function extraUsageUsable(extra: ExtraUsageLike | null | undefined, threshold: number): boolean {
  if (!extra?.is_enabled) return false;
  if (extra.monthly_limit != null && extra.monthly_limit <= 0) return false;

  if (extra.monthly_limit != null && extra.used_credits != null) {
    return extra.used_credits < extra.monthly_limit;
  }
  if (extra.utilization != null) {
    return extra.utilization < threshold;
  }

  return true;
}
