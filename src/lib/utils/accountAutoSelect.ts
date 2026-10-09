/**
 * Pace-based account auto-selection (`settings.account_auto_select === 'pace'`).
 *
 * When a new session has no explicitly chosen account, pick the allowed account
 * that is furthest UNDER its usage pace, so load spreads across logins instead
 * of always draining the repo's first account.
 *
 * Score per window = remaining capacity / remaining window time, normalized so
 * 1.0 is exactly on pace, > 1 under pace, < 1 over pace. Unlike the plain
 * used/expected pace ratio this stays stable early in a window (3% used two
 * minutes into a fresh 5h window isn't "5x over pace") and counts a window that
 * is about to reset as plenty of headroom. An account's score is its tighter
 * window (min of 5h and 7d) — the binding constraint.
 *
 * Applies to NEW sessions only: a conversation can only be resumed under the
 * account that created it, and the prompt cache is account-scoped.
 */

import { get } from 'svelte/store';
import { settings, type AgentAccount, type SdkProvider } from '$lib/stores/settings';
import {
  rateLimits,
  codexRateLimits,
  accountRateLimits,
  type RateLimitState,
  type RateLimitWindow,
} from '$lib/stores/rateLimits';
import type { RepoConfig } from '$lib/stores/repos';
import {
  DEFAULT_ACCOUNT_ID,
  allowedAccountsForRepo,
  defaultAccountIdForRepo,
  isDefaultAccountId,
} from './accounts';

const WINDOW_MS = { five_hour: 5 * 3_600_000, seven_day: 168 * 3_600_000 } as const;
/** Cap so a window seconds from reset doesn't dwarf everything else. */
const MAX_HEADROOM = 10;
/** Usage data older than this is treated as unknown. */
const STALE_MS = 15 * 60_000;
/** Score assumed for an account without (fresh) usage data: exactly on pace. */
const UNKNOWN_SCORE = 1;
/** The repo's preferred (first allowed) account is kept unless another beats it by this much. */
const STICKY_MARGIN = 0.15;
/** Launches in the last RECENT_MS cost this much score each — usage data refreshes every few
 *  minutes, so without it a batch of launches would all land on the same account. */
const RECENT_LAUNCH_PENALTY = 0.15;
const RECENT_MS = 10 * 60_000;

export interface AccountScore {
  /** Ranking score after the recent-launch penalty (higher = more headroom). */
  score: number;
  /** Per-window headroom (null = no data for that window). */
  fiveHour: number | null;
  sevenDay: number | null;
  /** No fresh usage data — scored as on pace. */
  unknown: boolean;
  /** Logged out / token expired — never picked unless nothing else is allowed. */
  authExpired: boolean;
}

/** Headroom of one window: remaining% / remaining-time%, 1.0 = on pace. */
export function windowHeadroom(
  w: RateLimitWindow | null | undefined,
  windowMs: number,
  now: number,
): number | null {
  if (!w) return null;
  const remaining = Math.max(0, 100 - w.utilization) / 100;
  if (remaining === 0) return 0;
  const resetMs = w.resets_at ? new Date(w.resets_at).getTime() : NaN;
  // No reset time = no active window (nothing used yet): treat as a fresh window.
  const leftFraction = Number.isNaN(resetMs)
    ? 1
    : Math.max(0, Math.min(1, (resetMs - now) / windowMs));
  return Math.min(MAX_HEADROOM, remaining / Math.max(leftFraction, 1 / MAX_HEADROOM));
}

const recentLaunches = new Map<string, number[]>();

function recentLaunchCount(accountId: string, now: number): number {
  const recent = (recentLaunches.get(accountId) ?? []).filter((t) => now - t < RECENT_MS);
  recentLaunches.set(accountId, recent);
  return recent.length;
}

/** Record that a new session launched on an account (feeds the batch-spreading penalty). */
export function noteAccountLaunch(accountId: string | undefined, provider: 'claude' | 'openai'): void {
  const id = accountId ?? DEFAULT_ACCOUNT_ID[provider === 'openai' ? 'OpenAI' : 'Claude'];
  const now = Date.now();
  recentLaunchCount(id, now);
  recentLaunches.get(id)!.push(now);
}

export function scoreAccount(state: RateLimitState | null | undefined, accountId: string, now = Date.now()): AccountScore {
  const penalty = recentLaunchCount(accountId, now) * RECENT_LAUNCH_PENALTY;
  const authExpired = state?.authExpired ?? false;
  const data = state?.data;
  const fresh = !!data && state?.lastFetched != null && now - state.lastFetched < STALE_MS;
  if (!fresh) {
    return { score: UNKNOWN_SCORE - penalty, fiveHour: null, sevenDay: null, unknown: true, authExpired };
  }
  const fiveHour = windowHeadroom(data.five_hour, WINDOW_MS.five_hour, now);
  const sevenDay = windowHeadroom(data.seven_day, WINDOW_MS.seven_day, now);
  const windows = [fiveHour, sevenDay].filter((h): h is number => h != null);
  const base = windows.length > 0 ? Math.min(...windows) : UNKNOWN_SCORE;
  return { score: base - penalty, fiveHour, sevenDay, unknown: false, authExpired };
}

/**
 * Rank `candidates` (preference order — first = the repo's preferred account) and
 * pick one: the best score wins, but the first candidate is kept unless beaten by
 * more than STICKY_MARGIN, and ties keep candidate order. Auth-expired accounts are
 * skipped while any other candidate exists.
 */
export function pickAccountByPace(
  candidates: AgentAccount[],
  stateFor: (account: AgentAccount) => RateLimitState | null | undefined,
  now = Date.now(),
): { account: AgentAccount | undefined; scores: Map<string, AccountScore> } {
  const scores = new Map<string, AccountScore>();
  for (const a of candidates) scores.set(a.id, scoreAccount(stateFor(a), a.id, now));
  const usable = candidates.filter((a) => !scores.get(a.id)!.authExpired);
  const pool = usable.length > 0 ? usable : candidates;
  const preferred = pool[0];
  if (!preferred) return { account: undefined, scores };
  let best = preferred;
  let bestScore = scores.get(preferred.id)!.score + STICKY_MARGIN;
  for (const a of pool.slice(1)) {
    const s = scores.get(a.id)!.score;
    if (s > bestScore) {
      best = a;
      bestScore = s;
    }
  }
  return { account: best, scores };
}

/** Current rate-limit state of an account (default logins read the provider singletons). */
export function rateLimitStateFor(account: AgentAccount): RateLimitState | null {
  if (isDefaultAccountId(account.id)) {
    return get(account.provider === 'OpenAI' ? codexRateLimits : rateLimits);
  }
  return get(accountRateLimits)[account.id] ?? null;
}

export function isPaceAutoSelectEnabled(): boolean {
  return get(settings).account_auto_select === 'pace';
}

/**
 * The account a NEW session in `repo` should use when none was picked, as a
 * concrete id (machine-login accounts as their reserved `default-*` id). With
 * auto-select off this is the repo's first allowed account.
 */
export function pickAccountIdForRepo(
  accounts: AgentAccount[] | null | undefined,
  repo: RepoConfig | null | undefined,
  provider: SdkProvider,
): string {
  const allowed = allowedAccountsForRepo(accounts, repo, provider);
  if (!isPaceAutoSelectEnabled() || allowed.length < 2) {
    return defaultAccountIdForRepo(accounts, repo, provider) ?? DEFAULT_ACCOUNT_ID[provider];
  }
  return pickAccountByPace(allowed, rateLimitStateFor).account?.id ?? DEFAULT_ACCOUNT_ID[provider];
}

/** Same as `pickAccountIdForRepo`, in the session convention (machine default = undefined). */
export function autoAccountIdForRepo(
  accounts: AgentAccount[] | null | undefined,
  repo: RepoConfig | null | undefined,
  provider: SdkProvider,
): string | undefined {
  const id = pickAccountIdForRepo(accounts, repo, provider);
  return isDefaultAccountId(id) ? undefined : id;
}
