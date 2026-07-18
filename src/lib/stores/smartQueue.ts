// =============================================================================
// Smart Queue — drain driver
// =============================================================================
//
// A single global driver that dispatches deferred work once a provider's usage
// window resets (rate-limit queueing), a user-scheduled window boundary passes
// (fire-and-forget scheduling), or every session in the same repo+worktree has
// finished ('after_sessions', Ctrl+click). It owns detection + draining for both
// providers.
//
// Two waiting shapes, one driver:
//   - `status: 'queued'`  → a never-launched session, dispatched via `launchPrepared`.
//   - `rateLimited != null` → a live session with a pending turn to re-send, dispatched
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
import { sdkSessions, hasBusySessionsInScope, type AfterSessionsScope, type QueueReason, type SdkSession } from './sdkSessions';
import { rateLimitData, codexRateLimitData, type ProviderRateLimits } from './rateLimits';
import { providerExhaustion } from './queueDetection';
import { settings } from './settings';
import { playQueueResume } from '$lib/utils/sound';
import type { SdkProvider } from '$lib/utils/models';

/** Providers the queue drives. Codex (OpenAI) waits on its own limits independently. */
const PROVIDERS: SdkProvider[] = ['claude', 'openai'];

/** Time-based tick so scheduled items fire without needing a rate-limit change. */
const TICK_MS = 30_000;

/** A session waiting to be dispatched, normalized from its `queued`/`rateLimited` shape. */
interface PendingItem {
  id: string;
  provider: SdkProvider;
  /** The session's agent account (undefined/`default-*` = machine-default login). */
  accountId?: string;
  reason: QueueReason;
  kind: 'queued' | 'rateLimited';
  /** FIFO ordering key. */
  queuedAt: number;
  /** For scheduled items: the target window-boundary time (epoch ms). */
  targetStartAt?: number;
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

/** Direct read of a provider's rate-limit snapshot — null means "not yet fetched". */
function rateLimitStoreValue(provider: SdkProvider): ProviderRateLimits | null {
  return provider === 'openai' ? get(codexRateLimitData) : get(rateLimitData);
}

/** Normalize a session into a pending item, or null if it isn't waiting. */
function toPendingItem(session: SdkSession): PendingItem | null {
  const provider = providerOf(session);
  if (session.status === 'queued' && session.queueInfo) {
    return {
      id: session.id,
      provider,
      accountId: session.accountId,
      reason: session.queueInfo.reason,
      kind: 'queued',
      queuedAt: session.queueInfo.queuedAt ?? session.createdAt ?? 0,
      targetStartAt: session.queueInfo.targetStartAt,
      cwd: session.cwd,
    };
  }
  if (session.rateLimited) {
    return {
      id: session.id,
      provider,
      accountId: session.accountId,
      reason: session.rateLimited.reason,
      kind: 'rateLimited',
      queuedAt: session.rateLimited.queuedAt ?? session.lastActivityAt ?? 0,
      targetStartAt: session.rateLimited.targetStartAt ?? session.rateLimited.resetsAt,
      cwd: session.cwd,
      scope: session.rateLimited.scope,
    };
  }
  return null;
}

/** All pending items belonging to `provider`, unordered. */
function pendingItemsForProvider(sessions: SdkSession[], provider: SdkProvider): PendingItem[] {
  const items: PendingItem[] = [];
  for (const session of sessions) {
    const item = toPendingItem(session);
    if (item && item.provider === provider) items.push(item);
  }
  return items;
}

/**
 * Is this item ready to dispatch *right now*?
 *
 * - `rate_limit`: ready ONLY IF the provider's rate-limit store is non-null (we
 *   actually know the limit state) AND the provider is no longer exhausted. When
 *   the store is still null (e.g. right after app startup, before the first
 *   rate-limit fetch) we deliberately hold — otherwise every queued session would
 *   false-drain immediately on launch.
 * - `scheduled`: ready IF `now` has passed the snapshot target time AND the
 *   provider isn't exhausted. When the store is null we treat the provider as
 *   not-exhausted (`providerExhaustion` already returns `exhausted: false` for a
 *   null store), honoring the time the user explicitly scheduled.
 * - `after_sessions`: ready once the waited-on scope is idle. Scope `'session'`
 *   (parked follow-ups only) waits on just the own session's running query;
 *   `'worktree'` (the default) waits until no session in the same repo+worktree
 *   (same cwd) is actively working. A never-launched `queued` item excludes itself
 *   from the scope check (it isn't running); a parked follow-up turn does NOT — its
 *   own session may still be mid-query, and the turn should fire only after it finishes.
 */
function isReady(item: PendingItem, now: number, sessions: SdkSession[]): boolean {
  const exhausted = providerExhaustion(item.provider, item.accountId).exhausted;

  if (item.reason === 'rate_limit') {
    if (rateLimitStoreValue(item.provider) == null) return false; // limit state unknown yet
    return !exhausted;
  }

  if (item.reason === 'after_sessions') {
    if (exhausted) return false; // it would only get re-rejected — hold and roll forward
    if (item.kind === 'rateLimited' && item.scope === 'session') {
      const own = sessions.find((s) => s.id === item.id);
      return !!own && own.status !== 'querying' && own.status !== 'initializing';
    }
    const excludeId = item.kind === 'queued' ? item.id : undefined;
    return !item.cwd || !hasBusySessionsInScope(sessions, item.cwd, excludeId);
  }

  // reason === 'scheduled'
  if (item.targetStartAt == null) return false; // nothing to fire against
  if (now <= item.targetStartAt) return false; // not time yet
  return !exhausted; // if exhausted at the scheduled moment, hold and roll forward
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

  // The master toggle governs rate-limit/scheduled queueing. 'after_sessions' items are
  // an explicit per-item user action (Ctrl+click) and dispatch even when the queue is off.
  const queueEnabled = get(settings).queue.enabled;
  const sessionsNow = get(sdkSessions);
  const readyNow = pendingItemsForProvider(sessionsNow, provider).filter(
    (item) =>
      (queueEnabled || item.reason === 'after_sessions') && isReady(item, Date.now(), sessionsNow)
  );
  if (readyNow.length === 0) return; // nothing to do — don't flip the draining flag

  draining[provider] = true;
  refreshDrainingStore();

  try {
    const cfg = get(settings).queue;
    // FIFO by queue time, but hoist explicit `after_sessions` items ahead of
    // reset-driven ones so an "start when idle" dispatch is never held behind a
    // rate-limit stagger delay.
    const ordered = [...readyNow].sort((a, b) => {
      const aImmediate = a.reason === 'after_sessions' ? 0 : 1;
      const bImmediate = b.reason === 'after_sessions' ? 0 : 1;
      if (aImmediate !== bImmediate) return aImmediate - bImmediate;
      return a.queuedAt - b.queuedAt;
    });
    const dispatched = new Set<string>();
    let dispatchedCount = 0;
    // Whether the once-per-drain "after reset" stagger has been applied yet. Only
    // reset-driven items (rate_limit / scheduled) trigger it.
    let appliedAfterResetDelay = false;

    for (const item of ordered) {
      if (dispatched.has(item.id)) continue;

      // Fuzzy stagger applies only to reset-driven items (rate_limit / scheduled),
      // which fire on a usage-window boundary and want to be spread out. An
      // `after_sessions` item is an explicit "start when the repo is idle" action —
      // when the scope is already idle it must dispatch immediately, with no delay.
      if (item.reason !== 'after_sessions') {
        if (!appliedAfterResetDelay) {
          // "After reset" fuzzy delay — once, before the first reset-driven dispatch.
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

      // Re-read the session — it may have been removed, launched, or re-exhausted
      // while we were waiting (this is the graceful roll-forward on re-rejection).
      // For after_sessions items this re-check also serializes same-scope items:
      // dispatching one makes the scope busy, so the next waits for it to finish.
      const freshSessions = get(sdkSessions);
      const current = freshSessions.find((s) => s.id === item.id);
      if (!current) continue;
      const fresh = toPendingItem(current);
      if (!fresh || fresh.provider !== provider) continue;
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
          await sdkSessions.continueRateLimited(item.id);
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
 * Kick a drain pass. The master toggle is applied per item inside `drain` —
 * rate-limit/scheduled items require the queue to be enabled, while
 * `after_sessions` items (explicit per-item user action) always dispatch.
 */
function evaluate(provider: SdkProvider): void {
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

/** Number of sessions currently waiting (queued first-launches + rate-limited turns). */
export const queuedCount = derived(sdkSessions, ($sessions) =>
  $sessions.reduce(
    (count, s) => count + (s.status === 'queued' || s.rateLimited != null ? 1 : 0),
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

  for (const s of $sessions) {
    let target: number | undefined;
    if (s.status === 'queued' && s.queueInfo) {
      target = s.queueInfo.targetStartAt;
    } else if (s.rateLimited) {
      target = s.rateLimited.resetsAt ?? s.rateLimited.targetStartAt;
    }
    if (target == null) continue;

    if (earliestAny == null || target < earliestAny) earliestAny = target;
    if (target >= now && (earliestFuture == null || target < earliestFuture)) {
      earliestFuture = target;
    }
  }

  return earliestFuture ?? earliestAny;
});

/** True while any provider's drain loop is running. */
export const isDraining = derived(drainingStore, ($d) => $d);
