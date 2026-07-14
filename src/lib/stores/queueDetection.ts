// =============================================================================
// Smart Queue — provider exhaustion detection
// =============================================================================
//
// This module answers a single question: "is a provider's usage window fully
// exhausted, and if so which window and when does it reset?". It reads ONLY the
// rate-limit stores and settings — it deliberately does NOT import `sdkSessions`
// so that both `sdkSessions.ts` (the gates) and `smartQueue.ts` (the drain
// driver) can depend on it without a circular import.
//
// Threshold is hardcoded at >= 100% utilization per the feature spec.
// =============================================================================

import { get } from 'svelte/store';
import {
  rateLimitData,
  codexRateLimitData,
  accountRateLimits,
  type ProviderRateLimits
} from './rateLimits';
import { settings } from './settings';
import { isDefaultAccountId } from '$lib/utils/accounts';
import type { SdkProvider } from '$lib/utils/models';

export type QueueWindow = '5h' | '7d';

/** Utilization at/above this value counts as a hard rate limit (not configurable). */
const EXHAUSTION_THRESHOLD = 100;

/**
 * Pick the live rate-limit snapshot for a provider (optionally for a specific account).
 * - A configured (non-default) account reads its own window from the `accountRateLimits`
 *   mirror.
 * - Otherwise Codex (OpenAI) waits on its own store; everything else uses Claude's.
 */
function storeForProvider(
  provider: SdkProvider,
  accountId?: string
): ProviderRateLimits | null {
  if (accountId && !isDefaultAccountId(accountId)) {
    return get(accountRateLimits)[accountId]?.data ?? null;
  }
  return provider === 'openai' ? get(codexRateLimitData) : get(rateLimitData);
}

/** Parse an ISO reset timestamp to epoch ms, or undefined if missing/invalid. */
function parseResetMs(iso: string | undefined | null): number | undefined {
  if (!iso) return undefined;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Determine whether the given provider's usage is exhausted.
 * - `five_hour.utilization >= 100` → exhausted on the '5h' window.
 * - `seven_day.utilization >= 100` → exhausted on the '7d' window.
 * - If BOTH windows are exhausted, pick the one whose `resets_at` is LATER
 *   (the window that unblocks us last).
 * Returns `{ exhausted: false }` when the store is null or nothing is exhausted.
 */
export function providerExhaustion(
  provider: SdkProvider,
  accountId?: string
): { exhausted: boolean; window?: QueueWindow; resetsAt?: number } {
  const data = storeForProvider(provider, accountId);
  if (!data) return { exhausted: false };

  const fiveHourExhausted = data.five_hour.utilization >= EXHAUSTION_THRESHOLD;
  const sevenDayExhausted = data.seven_day.utilization >= EXHAUSTION_THRESHOLD;

  if (fiveHourExhausted && sevenDayExhausted) {
    const fiveReset = parseResetMs(data.five_hour.resets_at);
    const sevenReset = parseResetMs(data.seven_day.resets_at);
    // Pick the window that resets LATER (blocks us for longer).
    if ((sevenReset ?? -Infinity) >= (fiveReset ?? -Infinity)) {
      return { exhausted: true, window: '7d', resetsAt: sevenReset };
    }
    return { exhausted: true, window: '5h', resetsAt: fiveReset };
  }

  if (fiveHourExhausted) {
    return { exhausted: true, window: '5h', resetsAt: parseResetMs(data.five_hour.resets_at) };
  }
  if (sevenDayExhausted) {
    return { exhausted: true, window: '7d', resetsAt: parseResetMs(data.seven_day.resets_at) };
  }

  return { exhausted: false };
}

/** True when the smart queue is enabled AND the provider (for this account) is currently exhausted. */
export function shouldQueue(provider: SdkProvider, accountId?: string): boolean {
  return get(settings).queue.enabled && providerExhaustion(provider, accountId).exhausted;
}

/**
 * Live `resets_at` (epoch ms) for a specific window of the provider's store, or
 * undefined if unavailable. Used by the scheduling feature to snapshot a target
 * start time for a fire-and-forget "next window" launch.
 */
export function nextWindowResetAt(
  provider: SdkProvider,
  window: QueueWindow,
  accountId?: string
): number | undefined {
  const data = storeForProvider(provider, accountId);
  if (!data) return undefined;
  return window === '5h'
    ? parseResetMs(data.five_hour.resets_at)
    : parseResetMs(data.seven_day.resets_at);
}
