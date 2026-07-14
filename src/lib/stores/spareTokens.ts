/**
 * Spare Tokens — store + auto-mode driver.
 *
 * Owns the persisted, frontend-only state for the Spare Tokens feature (the
 * auto-mode master toggle, aggressiveness, and per-library-item auto state) and
 * the opt-in autonomous driver that fires pinned read-only prompts when there's
 * expiring rate-limit headroom that would otherwise go unused.
 *
 * State is persisted as one opaque JSON blob via the `load_spare_tokens` /
 * `save_spare_tokens` Tauri commands (the backend stores the string as-is —
 * the frontend owns the schema). Both are tolerated to be missing on a stale
 * dev binary: a load failure/null just leaves defaults in place, and a save
 * failure is logged and swallowed.
 *
 * The auto driver mirrors `startSmartQueue()` in `smartQueue.ts`: it subscribes
 * to both rate-limit stores plus a periodic tick, holds the first evaluation
 * until the stores have had a chance to hydrate, fires at most one item per
 * evaluation, and never runs a second auto session while one is still busy. The
 * one-at-a-time cadence plus the 3-minute rate-limit poll forms the feedback
 * loop that decides whether to keep spending.
 */

import { writable, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';

import {
  rateLimitData,
  codexRateLimitData,
  calculatePace,
  formatTimeRemaining,
  type ProviderRateLimits,
} from './rateLimits';
import { repos, findRepoById } from './repos';
import { sdkSessions, hasBusySessionsInScope } from './sdkSessions';
import { isFinishedStatus } from '$lib/utils/sessionStatus';
import { launchSession, snapshotLaunchConfigForRepo } from '$lib/utils/sessionLaunch';
import { SPARE_TOKENS_PREAMBLE, SPARE_TOKENS_LIBRARY } from '$lib/spareTokens/library';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpareTokensAggressiveness = 'conservative' | 'normal' | 'aggressive';

export interface SpareTokensItemState {
  autoEnabled: boolean;
  /** Repositories this prompt runs against (one session per repo). */
  repoIds: string[];
  lastRunAt: number | null;
  /**
   * Per-repo `resets_at` ISO of the window that justified the last auto run,
   * keyed by repo id — auto mode fires each repo at most once per window.
   */
  lastRunWindows: Record<string, string>;
  lastRunSessionId: string | null;
}

export interface SpareTokensState {
  /** Auto-mode master toggle. */
  enabled: boolean;
  aggressiveness: SpareTokensAggressiveness;
  /** Per-library-item auto state, keyed by prompt id. */
  items: Record<string, SpareTokensItemState>;
}

function defaultState(): SpareTokensState {
  return { enabled: false, aggressiveness: 'normal', items: {} };
}

function defaultItemState(): SpareTokensItemState {
  return {
    autoEnabled: false,
    repoIds: [],
    lastRunAt: null,
    lastRunWindows: {},
    lastRunSessionId: null,
  };
}

/** Legacy single-repo shape (pre multi-select) still found in persisted state. */
interface LegacyItemFields {
  repoId?: string | null;
  lastRunWindow?: string | null;
}

function normalizeItemState(raw: Partial<SpareTokensItemState> & LegacyItemFields): SpareTokensItemState {
  const repoIds = raw.repoIds ?? (raw.repoId ? [raw.repoId] : []);
  const lastRunWindows =
    raw.lastRunWindows ??
    (raw.repoId && raw.lastRunWindow ? { [raw.repoId]: raw.lastRunWindow } : {});
  return {
    autoEnabled: raw.autoEnabled ?? false,
    repoIds,
    lastRunAt: raw.lastRunAt ?? null,
    lastRunWindows,
    lastRunSessionId: raw.lastRunSessionId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Burn evaluation
// ---------------------------------------------------------------------------

export type BurnTier = 'prime' | 'okay' | null;

export interface BurnEvaluation {
  tier: BurnTier;
  window: '5h' | '7d' | null;
  reason: string;
}

interface BurnThresholds {
  /** Minutes-until-reset ceiling for the 7d "prime" window. */
  w7Minutes: number;
  /** 7d utilization ceiling for "prime". */
  u7: number;
  /** Minutes-until-reset ceiling for the 5h "okay" window. */
  w5Minutes: number;
  /** 5h utilization ceiling for "okay". */
  u5: number;
  /** 7d utilization guard for "okay" (don't burn 5h leftovers if the week is tight). */
  u7guard: number;
  /** 7d pace-ratio ceiling for "okay" (only burn if the week is under-used). */
  p: number;
}

const BURN_THRESHOLDS: Record<SpareTokensAggressiveness, BurnThresholds> = {
  conservative: { w7Minutes: 12 * 60, u7: 75, w5Minutes: 45, u5: 70, u7guard: 80, p: 0.9 },
  normal: { w7Minutes: 24 * 60, u7: 85, w5Minutes: 90, u5: 85, u7guard: 90, p: 1.0 },
  aggressive: { w7Minutes: 36 * 60, u7: 92, w5Minutes: 150, u5: 95, u7guard: 95, p: 1.15 },
};

const SEVEN_DAY_HOURS = 24 * 7;

/** Minutes from `now` until an ISO reset timestamp; null if missing/unparseable. */
function minutesUntil(isoTimestamp: string | undefined, now: number): number | null {
  if (!isoTimestamp) return null;
  const resetTime = new Date(isoTimestamp).getTime();
  if (Number.isNaN(resetTime)) return null;
  return (resetTime - now) / 60_000;
}

/**
 * Decide whether now is a good time to spend spare capacity for a provider.
 *
 * - `prime` (7d expiring): the 7d window is close to reset and well under its
 *   cap — that capacity is about to evaporate, so spending is effectively free.
 * - `okay` (5h leftover): the 5h window is close to reset with headroom, the 7d
 *   window isn't tight, and the week is running under pace.
 * - `prime` wins if both match.
 */
export function evaluateBurn(
  limits: ProviderRateLimits | null,
  aggressiveness: SpareTokensAggressiveness,
  now: number = Date.now()
): BurnEvaluation {
  if (!limits) return { tier: null, window: null, reason: 'Rate-limit data not loaded yet' };

  const t = BURN_THRESHOLDS[aggressiveness];
  const sevenDay = limits.seven_day;
  const fiveHour = limits.five_hour;
  const min7 = minutesUntil(sevenDay?.resets_at, now);
  const min5 = minutesUntil(fiveHour?.resets_at, now);
  const paceRatio = sevenDay?.resets_at
    ? calculatePace(sevenDay.utilization, sevenDay.resets_at, SEVEN_DAY_HOURS).paceRatio
    : 1;

  // prime — expiring 7d capacity
  if (min7 != null && min7 > 0 && min7 <= t.w7Minutes && sevenDay.utilization <= t.u7) {
    return {
      tier: 'prime',
      window: '7d',
      reason: `7d window resets in ${formatTimeRemaining(sevenDay.resets_at)} with ${Math.round(sevenDay.utilization)}% used — spending expiring capacity`,
    };
  }

  // okay — leftover 5h capacity while the week is under-used
  if (
    min5 != null &&
    min5 > 0 &&
    min5 <= t.w5Minutes &&
    fiveHour.utilization <= t.u5 &&
    sevenDay.utilization <= t.u7guard &&
    paceRatio <= t.p
  ) {
    return {
      tier: 'okay',
      window: '5h',
      reason: `5h window resets in ${formatTimeRemaining(fiveHour.resets_at)} with ${Math.round(fiveHour.utilization)}% used and the week under pace — burning leftover capacity`,
    };
  }

  // Not a burn window — explain the closest miss.
  let reason: string;
  if (min7 != null && min7 > 0 && min7 <= t.w7Minutes && sevenDay.utilization > t.u7) {
    reason = `7d window resets soon but ${Math.round(sevenDay.utilization)}% is already used — not enough expiring headroom`;
  } else if (paceRatio > t.p) {
    reason = `Week is ahead of pace (${paceRatio.toFixed(2)}×) — holding auto runs to protect daytime capacity`;
  } else {
    reason = 'No expiring headroom to spend right now';
  }
  return { tier: null, window: null, reason };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function createSpareTokensStore() {
  const { subscribe, set, update } = writable<SpareTokensState>(defaultState());

  let loaded = false;
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;

  function schedulePersist() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(persist, 500);
  }

  async function persist() {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    try {
      await invoke('save_spare_tokens', { data: JSON.stringify(get({ subscribe })) });
    } catch (error) {
      // Command may not exist yet in a stale dev binary — don't spam, just note.
      console.error('[spareTokens] Failed to save state:', error);
    }
  }

  async function load() {
    try {
      const raw = await invoke<string | null | undefined>('load_spare_tokens');
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SpareTokensState>;
        const items: Record<string, SpareTokensItemState> = {};
        for (const [id, item] of Object.entries(parsed.items ?? {})) {
          items[id] = normalizeItemState(item);
        }
        set({
          enabled: parsed.enabled ?? false,
          aggressiveness: parsed.aggressiveness ?? 'normal',
          items,
        });
      }
      loaded = true;
    } catch (error) {
      console.error('[spareTokens] Failed to load state:', error);
    }
  }

  function setEnabled(v: boolean) {
    update((s) => ({ ...s, enabled: v }));
    schedulePersist();
  }

  function setAggressiveness(v: SpareTokensAggressiveness) {
    update((s) => ({ ...s, aggressiveness: v }));
    schedulePersist();
  }

  function updateItem(promptId: string, patch: Partial<SpareTokensItemState>) {
    update((s) => {
      const existing = s.items[promptId] ?? defaultItemState();
      return { ...s, items: { ...s.items, [promptId]: { ...existing, ...patch } } };
    });
    schedulePersist();
  }

  /**
   * Launch a library item immediately against every selected repository (one
   * session per repo), ignoring burn tiers and the active-auto guard. Records
   * lastRun* (without touching `lastRunWindows`, since no window justified it).
   * Returns the new session ids (empty if nothing could launch).
   */
  async function runNow(
    promptId: string,
    opts?: { repoIds?: string[] }
  ): Promise<string[]> {
    const prompt = SPARE_TOKENS_LIBRARY.find((p) => p.id === promptId);
    if (!prompt) return [];

    const state = get({ subscribe });
    const repoIds = opts?.repoIds ?? state.items[promptId]?.repoIds ?? [];
    const reposList = get(repos).list;

    const sessionIds: string[] = [];
    for (const repoId of repoIds) {
      const repo = findRepoById(reposList, repoId);
      if (!repo) continue;

      const cfg = snapshotLaunchConfigForRepo(repo);
      try {
        sessionIds.push(
          await launchSession({
            prompt: `${SPARE_TOKENS_PREAMBLE}\n\n${prompt.prompt}`,
            repo,
            model: cfg.model,
            effortLevel: cfg.effortLevel,
            provider: cfg.provider,
            useWorktree: !prompt.readOnly,
            branchNameHint: prompt.title,
            tag: { spareTokens: { promptId, auto: false } },
          })
        );
      } catch (error) {
        console.error('[spareTokens] runNow launch failed:', error);
      }
    }
    if (sessionIds.length === 0) return [];

    updateItem(promptId, {
      lastRunAt: Date.now(),
      lastRunSessionId: sessionIds[sessionIds.length - 1],
    });
    return sessionIds;
  }

  return {
    subscribe,
    load,
    isLoaded: () => loaded,
    setEnabled,
    setAggressiveness,
    updateItem,
    runNow,
  };
}

export const spareTokens = createSpareTokensStore();

// ---------------------------------------------------------------------------
// Auto driver
// ---------------------------------------------------------------------------

/** ~30s startup delay before the first evaluation so the stores hydrate. */
const FIRST_EVAL_DELAY_MS = 30_000;
/** Periodic re-evaluation cadence. */
const TICK_MS = 60_000;

/** The session id of the currently in-flight auto run, or null. */
let activeAutoSessionId: string | null = null;
/** Re-entrancy guard: a rate-limit poll and the tick can kick concurrently. */
let evaluating = false;

/**
 * One evaluation pass: bail unless dev mode + auto enabled, hold while an auto
 * session is still busy, then fire at most one eligible item.
 */
async function evaluateAuto(): Promise<void> {
  if (evaluating) return;
  evaluating = true;
  try {
    await evaluateAutoInner();
  } finally {
    evaluating = false;
  }
}

async function evaluateAutoInner(): Promise<void> {
  const state = get(spareTokens);
  if (!state.enabled) return;

  const sessions = get(sdkSessions);

  // Hold while the last auto session is still busy; clear the guard once it's
  // gone or has reached a finished status.
  if (activeAutoSessionId) {
    const active = sessions.find((x) => x.id === activeAutoSessionId);
    if (active && !isFinishedStatus(active.status)) return;
    activeAutoSessionId = null;
  }

  const reposList = get(repos).list;
  const now = Date.now();

  for (const prompt of SPARE_TOKENS_LIBRARY) {
    const itemState = state.items[prompt.id];
    if (!itemState?.autoEnabled) continue;
    if (!prompt.readOnly) continue; // write items are never auto-fired

    for (const repoId of itemState.repoIds) {
      const repo = findRepoById(reposList, repoId);
      if (!repo) continue;

      const cfg = snapshotLaunchConfigForRepo(repo);
      const limits = cfg.provider === 'openai' ? get(codexRateLimitData) : get(rateLimitData);
      const burn = evaluateBurn(limits, state.aggressiveness, now);
      if (burn.tier === null || burn.window === null) continue;

      const windowResetsAt =
        burn.window === '7d' ? limits?.seven_day.resets_at : limits?.five_hour.resets_at;
      // Already ran this repo for this exact window — wait until it resets.
      if (windowResetsAt && itemState.lastRunWindows[repoId] === windowResetsAt) continue;

      // Never compete with the user's live work in this repo scope.
      if (hasBusySessionsInScope(sessions, repo.path)) continue;

      try {
        const sessionId = await launchSession({
          prompt: `${SPARE_TOKENS_PREAMBLE}\n\n${prompt.prompt}`,
          repo,
          model: cfg.model,
          effortLevel: cfg.effortLevel,
          provider: cfg.provider,
          tag: { spareTokens: { promptId: prompt.id, auto: true } },
        });
        spareTokens.updateItem(prompt.id, {
          lastRunAt: Date.now(),
          lastRunWindows: windowResetsAt
            ? { ...itemState.lastRunWindows, [repoId]: windowResetsAt }
            : itemState.lastRunWindows,
          lastRunSessionId: sessionId,
        });
        activeAutoSessionId = sessionId;
      } catch (error) {
        console.error('[spareTokens] auto launch failed:', error);
      }

      return; // at most one session per evaluation
    }
  }
}

let started = false;
let currentTeardown: (() => void) | null = null;

/**
 * Start the auto driver. Idempotent — a second call while running is a no-op
 * that returns the same teardown. Subscribes to both rate-limit stores and a
 * 60s tick; the first evaluation is delayed ~30s so the stores can hydrate.
 */
export function startSpareTokens(): () => void {
  if (started && currentTeardown) return currentTeardown;
  started = true;

  let firstEvalReady = false;
  const kick = () => {
    if (firstEvalReady) void evaluateAuto();
  };

  // Rate-limit changes (auto-poll ~every 3 min) → re-evaluate.
  const unsubClaude = rateLimitData.subscribe(() => kick());
  const unsubCodex = codexRateLimitData.subscribe(() => kick());

  let firstEvalTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  if (typeof window !== 'undefined') {
    firstEvalTimer = setTimeout(() => {
      firstEvalReady = true;
      void evaluateAuto();
    }, FIRST_EVAL_DELAY_MS);
    intervalId = setInterval(kick, TICK_MS);
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
    if (firstEvalTimer != null) clearTimeout(firstEvalTimer);
    if (intervalId != null) clearInterval(intervalId);
  };

  return currentTeardown;
}
