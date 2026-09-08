// =============================================================================
// Smart Queue — drain driver
// =============================================================================
//
// A single global driver that dispatches deferred work once a provider's usage
// window resets (rate-limit queueing), a scheduled moment passes — a user-picked
// window boundary or a custom wall-clock time (native scheduling) — or every session
// in the same repo+worktree has finished ('after_sessions', Ctrl+click). It owns
// detection + draining for both providers.
//
// Policy: the `queue.enabled` master toggle gates ONLY the automatic `rate_limit`
// reason. `scheduled` and `after_sessions` are explicit per-item user actions and
// always dispatch, without the fuzzy stagger delays.
//
// Two waiting shapes, one driver:
//   - `status: 'queued'`  → a never-launched session, dispatched via `launchPrepared`.
//   - `parkedTurns[]`      → a live session's pending turns to send, each dispatched
//                              via `continueRateLimited` (covers mid-run rejection,
//                              deferred follow-ups, and scheduled turns).
//
// This module imports `sdkSessions` (unlike `queueDetection.ts`, which deliberately
// does not) and reads exhaustion state from `queueDetection.ts` to avoid a circular
// import between the gates and the driver.
//
// App-runtime code, so `Date.now()` / `Math.random()` / timers are all fair game.
// =============================================================================

import { derived, get, writable } from 'svelte/store';
import { sdkSessions, hasBusySessionsInScope, parkedTurnsOf, type AfterSessionsScope, type QueueReason, type SdkSession } from './sdkSessions';
import { rateLimitData, codexRateLimitData, rateLimits, codexRateLimits, accountRateLimits, rateLimitStoreForAccount } from './rateLimits';
import { isDefaultAccountId } from '$lib/utils/accounts';
import { usageLimitReady, MAX_USAGE_LIMIT_RETRIES, USAGE_LIMIT_RETRY_DELAY_MS } from '$lib/utils/usageLimitRecovery';
import { providerExhaustion } from './queueDetection';
import { settings } from './settings';
import { playQueueResume } from '$lib/utils/sound';
import type { SdkProvider } from '$lib/utils/models';

/** Providers the queue drives. Codex (OpenAI) waits on its own limits independently. */
const PROVIDERS: SdkProvider[] = ['claude', 'openai'];

/** Time-based tick so scheduled items fire without needing a rate-limit change. */
const TICK_MS = 30_000;

/** A waiting item, normalized from a session's `queued` status or one of its parked turns. */
interface PendingItem {
  id: string;
  /** For a `rateLimited` item: which parked turn on that session this is. */
  turnId?: string;
  provider: SdkProvider;
  /** The session's agent account (undefined/`default-*` = machine-default login). */
  accountId?: string;
  reason: QueueReason;
  kind: 'queued' | 'rateLimited';
  /** FIFO ordering key. */
  queuedAt: number;
  /** For scheduled items: when to fire (epoch ms) — a window boundary or a custom time. */
  targetStartAt?: number;
  retryAttempts?: number;
  /** For after_sessions items: the repo/worktree scope to wait on (the session's cwd). */
  cwd?: string;
  /** For after_sessions rateLimited items: wait on just the own session, or the whole cwd scope. */
  scope?: AfterSessionsScope;
}

// -----------------------------------------------------------------------------
// Internal draining state (powers the `isDraining` derived store)
// -----------------------------------------------------------------------------

const draining: Record<SdkProvider, boolean> = { claude: false, openai: false };
const drainingStore = writable<boolean>(false);

function refreshDrainingStore(): void {
  drainingStore.set(PROVIDERS.some((p) => draining[p]));
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Random delay in `[minSecs, maxSecs]` expressed in ms (order-tolerant, clamped ≥ 0). */
function randomDelayMs(minSecs: number, maxSecs: number): number {
  const lo = Math.max(0, Math.min(minSecs, maxSecs));
  const hi = Math.max(0, Math.max(minSecs, maxSecs));
  const secs = lo + Math.random() * (hi - lo);
  return Math.round(secs * 1000);
}

/** The provider a session belongs to (defaulting to Claude when unset). */
function providerOf(session: SdkSession): SdkProvider {
  return (session.provider ?? 'claude') as SdkProvider;
}

function snapshotFor(item: PendingItem) {
  return item.accountId && !isDefaultAccountId(item.accountId)
    ? get(accountRateLimits)[item.accountId]
    : get(item.provider === 'openai' ? codexRateLimits : rateLimits);
}

/**
 * Normalize a session into its pending items (possibly several: a session can hold
 * more than one parked turn, each with its own trigger). Empty if it isn't waiting.
 */
function toPendingItems(session: SdkSession): PendingItem[] {
  const provider = providerOf(session);
  if (session.status === 'queued' && session.queueInfo) {
    return [
      {
        id: session.id,
        provider,
        accountId: session.accountId,
        reason: session.queueInfo.reason,
        kind: 'queued',
        queuedAt: session.queueInfo.queuedAt ?? session.createdAt ?? 0,
        targetStartAt: session.queueInfo.targetStartAt,
        cwd: session.cwd,
      },
    ];
  }
  return parkedTurnsOf(session).map((turn) => ({
    id: session.id,
    turnId: turn.id,
    provider,
    accountId: session.accountId,
    reason: turn.reason,
    kind: 'rateLimited' as const,
    queuedAt: turn.queuedAt ?? session.lastActivityAt ?? 0,
    targetStartAt: turn.targetStartAt ?? turn.resetsAt,
    retryAttempts: turn.retryAttempts,
    cwd: session.cwd,
    scope: turn.scope,
  }));
}

/** Re-read a single item's live state, or null if it's gone (dispatched/cancelled). */
function refreshPendingItem(sessions: SdkSession[], item: PendingItem): PendingItem | null {
  const session = sessions.find((s) => s.id === item.id);
  if (!session) return null;
  const items = toPendingItems(session);
  return items.find((i) => i.turnId === item.turnId && i.kind === item.kind) ?? null;
}

/** All pending items belonging to `provider`, unordered. */
function pendingItemsForProvider(sessions: SdkSession[], provider: SdkProvider): PendingItem[] {
  const items: PendingItem[] = [];
  for (const session of sessions) {
    for (const item of toPendingItems(session)) {
      if (item.provider === provider) items.push(item);
    }
  }
  return items;
}

/**
 * Is this item ready to dispatch *right now*?
 *
 * - `rate_limit`: wait for the reset/cooldown and a successful account-specific
 *   usage fetch after that boundary. All applicable windows must be available.
 *   Missing/stale data and the automatic retry cap keep the item parked.
 * - `scheduled`: ready as soon as `now` passes the target time — a user-picked
 *   window boundary or an arbitrary wall-clock time (native scheduling). Exhaustion
 *   is deliberately NOT checked: the user asked for this moment, and holding here
 *   would silently slip the send with no visible reason. If the provider does reject
 *   it, the send path re-parks the turn as `rate_limit`, which then drains at the
 *   real reset — a visible, self-correcting roll-forward.
 * - `after_sessions`: ready once the waited-on scope is idle. Scope `'session'`
 *   (parked follow-ups only) waits on just the own session's running query;
 *   `'worktree'` (the default) waits until no session in the same repo+worktree
 *   (same cwd) is actively working. A never-launched `queued` item excludes itself
 *   from the scope check (it isn't running); a parked follow-up turn does NOT — its
 *   own session may still be mid-query, and the turn should fire only after it finishes.
 *
 * Across ALL reasons, a parked turn additionally waits for its own session to go idle:
 * dispatching into a running query would interrupt the agent mid-work, which is never
 * what "send this later" meant (and matches how native message schedules behave).
 */
function isReady(item: PendingItem, now: number, sessions: SdkSession[]): boolean {
  const exhausted = providerExhaustion(item.provider, item.accountId).exhausted;

  if (item.kind === 'rateLimited') {
    const own = sessions.find((s) => s.id === item.id);
    if (!own || own.status === 'querying' || own.status === 'initializing') return false;
  }

  if (item.reason === 'rate_limit') {
    const snapshot = snapshotFor(item);
    return snapshot != null && usageLimitReady(item, snapshot, exhausted, now);
  }

  if (item.reason === 'after_sessions') {
    if (exhausted) return false; // it would only get re-rejected — hold and roll forward
    // Scope 'session' is fully covered by the own-session idle check above.
    if (item.kind === 'rateLimited' && item.scope === 'session') return true;
    const excludeId = item.kind === 'queued' ? item.id : undefined;
    return !item.cwd || !hasBusySessionsInScope(sessions, item.cwd, excludeId);
  }

  // reason === 'scheduled'
  if (item.targetStartAt == null) return false; // nothing to fire against
  return now > item.targetStartAt; // fire at the scheduled moment, exhausted or not
}

// -----------------------------------------------------------------------------
// Drain loop
// -----------------------------------------------------------------------------

/**
 * Dispatch every ready item for `provider`, FIFO by `queuedAt`, honoring the
 * configured fuzzy delays. Guarded per provider so overlapping triggers coalesce.
 */
async function drain(provider: SdkProvider): Promise<void> {
  // Re-entrancy guard (synchronous up to the first await, so this is race-free).
  if (draining[provider]) return;

  // The master toggle governs ONLY automatic rate-limit queueing (the "retry my rejected
  // turns for me" behavior). `scheduled` (a picked window boundary or wall-clock time) and
  // `after_sessions` (Ctrl+click) are explicit per-item user actions — the user asked for
  // this specific dispatch, so it happens even when the queue is switched off.
  const queueEnabled = get(settings).queue.enabled;
  const sessionsNow = get(sdkSessions);
  const readyNow = pendingItemsForProvider(sessionsNow, provider).filter(
    (item) =>
      (queueEnabled || item.reason !== 'rate_limit') && isReady(item, Date.now(), sessionsNow)
  );
  if (readyNow.length === 0) return; // nothing to do — don't flip the draining flag

  draining[provider] = true;
  refreshDrainingStore();

  try {
    const cfg = get(settings).queue;
    // FIFO by queue time, but hoist the user-driven items (`scheduled` / `after_sessions`)
    // ahead of rate-limit ones so an "at 09:00" or "when idle" dispatch is never held
    // behind a rate-limit stagger delay.
    const ordered = [...readyNow].sort((a, b) => {
      const aImmediate = a.reason !== 'rate_limit' ? 0 : 1;
      const bImmediate = b.reason !== 'rate_limit' ? 0 : 1;
      if (aImmediate !== bImmediate) return aImmediate - bImmediate;
      return a.queuedAt - b.queuedAt;
    });
    const dispatched = new Set<string>();
    let dispatchedCount = 0;
    // Whether the once-per-drain "after reset" stagger has been applied yet. Only
    // rate_limit items trigger it.
    let appliedAfterResetDelay = false;

    for (const item of ordered) {
      if (dispatched.has(item.id)) continue;

      // Fuzzy stagger applies only to `rate_limit` items: those all pile up on the same
      // usage-window boundary and want to be spread out. The user-driven reasons dispatch
      // with no delay — a `scheduled` item fires at the moment the user picked (09:00 means
      // 09:00, not 09:00 plus a random minute), and an `after_sessions` item is an explicit
      // "start when the repo is idle" action that must go the instant the scope frees up.
      if (item.reason === 'rate_limit') {
        if (!appliedAfterResetDelay) {
          // "After reset" fuzzy delay — once, before the first rate-limit dispatch.
          if (cfg.fuzzy_delay_after_reset) {
            await sleep(
              randomDelayMs(
                cfg.fuzzy_delay_after_reset_min_secs,
                cfg.fuzzy_delay_after_reset_max_secs
              )
            );
          }
          appliedAfterResetDelay = true;
        } else if (dispatchedCount > 0 && cfg.fuzzy_delay_between_runs) {
          // "Between runs" fuzzy delay — before every dispatch after the first.
          await sleep(
            randomDelayMs(
              cfg.fuzzy_delay_between_runs_min_secs,
              cfg.fuzzy_delay_between_runs_max_secs
            )
          );
        }
      }

      // Re-read the item — its session may have been removed, launched, or re-exhausted
      // while we were waiting (this is the graceful roll-forward on re-rejection), and
      // the turn itself may have been cancelled. For after_sessions items this re-check
      // also serializes same-scope items: dispatching one makes the scope busy, so the
      // next waits for it to finish.
      const freshSessions = get(sdkSessions);
      const fresh = refreshPendingItem(freshSessions, item);
      if (!fresh || fresh.provider !== provider) continue;
      if (!started || (fresh.reason === 'rate_limit' && !get(settings).queue.enabled)) continue;
      if (!isReady(fresh, Date.now(), freshSessions)) continue;

      // Reset sound on the first *actual* dispatch of this cycle.
      if (dispatchedCount === 0) {
        try {
          playQueueResume();
        } catch {
          /* sound is best-effort */
        }
      }

      dispatched.add(item.id);
      dispatchedCount++;

      try {
        if (fresh.kind === 'queued') {
          await sdkSessions.launchPrepared(item.id);
        } else {
          await sdkSessions.continueRateLimited(item.id, item.turnId, true);
        }
      } catch (err) {
        // One bad dispatch must not abort the rest of the drain.
        console.error(`[SmartQueue] Failed to dispatch ${fresh.kind} session ${item.id}:`, err);
      }
    }
  } finally {
    draining[provider] = false;
    refreshDrainingStore();
  }
}

/**
 * Kick a drain pass. The master toggle is applied per item inside `drain` — only
 * `rate_limit` items require the queue to be enabled; `scheduled` and `after_sessions`
 * items (explicit per-item user actions) always dispatch.
 */
const lastRefreshAttempt = new Map<string, number>();

function evaluate(provider: SdkProvider): void {
  if (!started) return;
  // Refresh the correct account after the reset, even when its old snapshot still
  // says 100%. Throttle failures and coalesce sessions sharing an account.
  if (get(settings).queue.enabled) {
    const now = Date.now();
    for (const item of pendingItemsForProvider(get(sdkSessions), provider)) {
      if (item.reason !== 'rate_limit' || (item.retryAttempts ?? 0) >= MAX_USAGE_LIMIT_RETRIES) continue;
      const earliest = Math.max(item.queuedAt + USAGE_LIMIT_RETRY_DELAY_MS, item.targetStartAt ?? 0);
      if (now < earliest) continue;
      const key = `${provider}:${item.accountId ?? 'default'}`;
      const snapshot = snapshotFor(item);
      if (snapshot?.loading || now - (lastRefreshAttempt.get(key) ?? 0) < TICK_MS) continue;
      if (snapshot?.lastFetched != null && snapshot.lastFetched >= earliest && now - snapshot.lastFetched < TICK_MS) continue;
      lastRefreshAttempt.set(key, now);
      void rateLimitStoreForAccount(item.accountId, provider).fetch();
    }
  }
  void drain(provider);
}

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

let started = false;
let currentTeardown: (() => void) | null = null;

/**
 * Start the driver: subscribe to both rate-limit stores, the sessions store, and
 * a periodic tick, then return a teardown function. Idempotent — a second call
 * while running is a no-op that returns the same teardown.
 */
export function startSmartQueue(): () => void {
  if (started && currentTeardown) return currentTeardown;
  started = true;

  // Rate-limit changes (auto-poll ~every 3 min) → re-evaluate the matching provider.
  const unsubClaude = rateLimitData.subscribe(() => evaluate('claude'));
  const unsubCodex = codexRateLimitData.subscribe(() => evaluate('openai'));
  const unsubAccounts = accountRateLimits.subscribe(() => {
    for (const p of PROVIDERS) evaluate(p);
  });
  const unsubSettings = settings.subscribe(() => {
    for (const p of PROVIDERS) evaluate(p);
  });

  // Newly-queued items should be considered promptly. Coalesce the flood of store
  // updates during streaming into a single evaluation per microtask.
  let sessionsEvalScheduled = false;
  const unsubSessions = sdkSessions.subscribe(() => {
    if (sessionsEvalScheduled) return;
    sessionsEvalScheduled = true;
    queueMicrotask(() => {
      sessionsEvalScheduled = false;
      for (const p of PROVIDERS) evaluate(p);
    });
  });

  // Time-based tick so `scheduled` items fire without a rate-limit change.
  let intervalId: ReturnType<typeof setInterval> | null = null;
  if (typeof window !== 'undefined') {
    intervalId = setInterval(() => {
      for (const p of PROVIDERS) evaluate(p);
    }, TICK_MS);
  }

  currentTeardown = () => {
    if (!started) return;
    started = false;
    currentTeardown = null;
    unsubAccounts();
    unsubSettings();
    lastRefreshAttempt.clear();
    try {
      unsubClaude();
    } catch {
      /* ignore */
    }
    try {
      unsubCodex();
    } catch {
      /* ignore */
    }
    try {
      unsubSessions();
    } catch {
      /* ignore */
    }
    if (intervalId != null) clearInterval(intervalId);
  };

  return currentTeardown;
}

// -----------------------------------------------------------------------------
// Derived stores for the UI
// -----------------------------------------------------------------------------

/** Number of waiting items (queued first-launches + every parked turn). */
export const queuedCount = derived(sdkSessions, ($sessions) =>
  $sessions.reduce(
    (count, s) => count + (s.status === 'queued' ? 1 : 0) + parkedTurnsOf(s).length,
    0
  )
);

/**
 * The earliest upcoming reset/target time (epoch ms) among pending items, or
 * undefined when nothing is waiting. Prefers future boundaries but falls back to
 * the soonest boundary overall (which the UI renders as "now").
 */
export const nextQueueResetAt = derived(sdkSessions, ($sessions) => {
  const now = Date.now();
  let earliestFuture: number | undefined;
  let earliestAny: number | undefined;

  const consider = (target: number | undefined) => {
    if (target == null) return;
    if (earliestAny == null || target < earliestAny) earliestAny = target;
    if (target >= now && (earliestFuture == null || target < earliestFuture)) {
      earliestFuture = target;
    }
  };

  for (const s of $sessions) {
    if (s.status === 'queued' && s.queueInfo) {
      consider(s.queueInfo.targetStartAt);
      continue;
    }
    // `targetStartAt` first (same precedence as `toPendingItems` and RateLimitBanner):
    // it's what the driver actually fires on, and a custom-time schedule has no `resetsAt`.
    for (const turn of parkedTurnsOf(s)) consider(turn.targetStartAt ?? turn.resetsAt);
  }

  return earliestFuture ?? earliestAny;
});

/** True while any provider's drain loop is running. */
export const isDraining = derived(drainingStore, ($d) => $d);
