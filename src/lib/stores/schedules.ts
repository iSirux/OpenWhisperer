/**
 * Native scheduling — Schedule entity store + fire driver.
 *
 * A Schedule is a durable rule that *spawns* work when it fires: either a brand
 * new SDK session in a repo, or a follow-up turn on an existing session. Unlike
 * the Smart Queue's parked items (a one-shot custom time rides those rails), a
 * schedule is never consumed — a recurring rule keeps rolling forward and a
 * managed one-shot simply ends with `nextFireAt = null`.
 *
 * Schedules are persisted to their own file via the `get_schedules` /
 * `save_schedules` Tauri commands (frontend owns the schema — the backend stores
 * opaque JSON), mirroring the pile.
 *
 * The local PC wall clock is the source of truth (same policy as the sequences
 * scheduler): all recurrence math runs in local time via `Date`, so DST shifts
 * are handled naturally.
 */

import { writable, derived, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';

import { repos, findRepoById } from './repos';
import {
  sdkSessions,
  hasBusySessionsInScope,
  type EffortLevel,
  type SdkMessage,
  type SdkSession,
} from './sdkSessions';
import { providerExhaustion } from './queueDetection';
import { launchSession, createSessionQueue } from '$lib/utils/sessionLaunch';
import { formatScheduleTarget } from '$lib/utils/duration';
import { evaluateScheduledTurn, type RunErrorClass } from '$lib/utils/scheduleRunOutcome';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // JS Date convention, 0 = Sunday

export interface ScheduleTime { hour: number; minute: number }

export type RecurrencePattern =
  | { kind: 'daily' }
  | { kind: 'weekly'; days: Weekday[]; everyNWeeks?: number } // everyNWeeks >= 2 for biweekly etc.
  | { kind: 'monthly'; day: number | 'last' }                 // 1..28 or 'last'
  | { kind: 'interval'; everyNDays: number };

export interface RecurrenceRule {
  time: ScheduleTime;
  pattern: RecurrencePattern;
  endAt?: number;    // stop after this epoch ms
  maxRuns?: number;  // stop after N runs
}

export type ScheduleSpec =
  | { kind: 'at'; at: number }                 // managed one-shot
  | { kind: 'recurring'; rule: RecurrenceRule };

export interface ScheduleSessionTarget {
  kind: 'session';
  repoId: string;                 // concrete — NEVER auto-repo (no user present at fire time)
  model: string;                  // may be the Auto model id; accept LLM latency/fallback
  effortLevel: EffortLevel;
  provider: 'claude' | 'openai';
  accountId?: string;
  useWorktree: boolean;
  /** Run in this existing worktree (absolute path) instead of the main checkout. Ignored
   *  when `useWorktree` is set. If the directory is gone at fire time the run falls back
   *  to the main repo path (deliberate — see docs/cli-scheduling-spec.md). */
  worktreePath?: string;
  systemPrompt?: string;
}

export interface ScheduleMessageTarget {
  kind: 'message';
  sessionId: string;
  ifSessionGone: 'skip' | 'launch_new';
  /** Snapshot taken at creation so 'launch_new' can fall back when the session is gone. */
  fallback?: {
    repoId: string;
    model: string;
    effortLevel: EffortLevel;
    provider: 'claude' | 'openai';
    accountId?: string;
    worktreePath?: string;
  };
  action?: 'compact';             // reuse the existing parked-turn compact action
}

export interface ScheduleRun {
  /** Stable id so the outcome watcher can update this entry once the turn settles.
   *  Absent on runs recorded before outcome tracking existed (and on skipped runs). */
  id?: string;
  at: number;
  /** 'ok' means launched/sent and — once the first turn settled — not seen failing.
   *  A run whose first turn ends in an API/auth error is flipped to 'failed'. */
  status: 'ok' | 'failed' | 'skipped' | 'deferred'; // deferred = launched but parked (rate limit)
  sessionId?: string;
  /** Raw error text (launch exception, or the agent's error output). */
  error?: string;
  /** Short remark: a failure reason ("Login expired (OAuth)", "API overloaded (529)") and/or
   *  a non-fatal note ("worktree gone, ran in main repo"), joined with " · ". */
  note?: string;
  /** Automatic-retry state of a failed run (transient errors only, one retry). */
  retry?: 'pending' | 'sent' | 'skipped';
  /** When the pending retry is due / was sent (epoch ms). */
  retryAt?: number;
  /** On an automatic retry run: the `id` of the failed run it re-sends. */
  retryOf?: string;
}

export interface Schedule {
  id: string;                     // crypto.randomUUID()
  label: string;                  // auto-derived from prompt (first ~60 chars) if empty at save
  enabled: boolean;               // pause/resume
  target: ScheduleSessionTarget | ScheduleMessageTarget;
  prompt: string;
  when: ScheduleSpec;
  /** Session targets only: after fire time, hold until the target repo scope is idle
   *  (hasBusySessionsInScope). Message targets ALWAYS implicitly wait for their session
   *  to be idle. */
  waitForIdle: boolean;
  catchUp: 'skip' | 'run_once';   // missed while app closed; default 'run_once'
  createdAt: number;              // also the anchor for everyNWeeks alignment
  nextFireAt: number | null;      // computed + persisted; null = spent one-shot / ended recurrence
  lastRunAt?: number;
  runCount: number;
  history: ScheduleRun[];         // newest first, capped at 20
  /** Who created it: the `ow` CLI (an agent) or the app UI (absent). */
  source?: 'cli';
}

/** The fields a caller must supply when creating a schedule; the rest are derived. */
export type NewSchedule = Pick<Schedule, 'target' | 'prompt' | 'when'> &
  Partial<Omit<Schedule, 'id' | 'createdAt' | 'runCount' | 'history'>>;

/** Newest-first history cap per schedule. */
const MAX_HISTORY = 20;

/** How often the driver re-evaluates (same cadence as the Smart Queue tick). */
const TICK_MS = 30_000;

// ---------------------------------------------------------------------------
// Recurrence math (pure — no store access, no side effects)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Local midnight of the day `ts` falls in. */
function startOfDay(ts: number | Date): Date {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Local Monday-midnight of the week `ts` falls in (weeks start Monday). */
function startOfWeek(ts: number | Date): Date {
  const d = startOfDay(ts);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/** Whole days from `a` to `b`, computed on local midnights so DST can't skew it. */
function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/** Non-negative modulo (JS `%` keeps the sign of the dividend). */
function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** `day` at the rule's wall-clock time, local. */
function atTime(day: Date, time: ScheduleTime): number {
  const d = new Date(day);
  d.setHours(clamp(time?.hour ?? 0, 0, 23), clamp(time?.minute ?? 0, 0, 59), 0, 0);
  return d.getTime();
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/**
 * Next fire time (epoch ms) strictly after `after`, or null when the schedule is
 * spent (one-shot in the past, past `endAt`, or `maxRuns` reached).
 *
 * `anchor` is the schedule's `createdAt` — it aligns the `everyNWeeks` week
 * phase and the `everyNDays` day phase. `runCount` is the schedule's current run
 * count, needed only to honour `maxRuns`.
 *
 * Pure local-time date math: every candidate is built with `new Date()` +
 * `setHours`, so DST transitions resolve the same way the user's clock does.
 */
export function computeNextFire(
  spec: ScheduleSpec,
  after: number,
  anchor: number,
  runCount = 0
): number | null {
  if (spec.kind === 'at') {
    return spec.at > after ? spec.at : null;
  }

  const rule = spec.rule;
  if (rule.maxRuns != null && runCount >= rule.maxRuns) return null;

  const candidate = nextOccurrence(rule, after, anchor);
  if (candidate == null) return null;
  if (rule.endAt != null && candidate > rule.endAt) return null;
  return candidate;
}

/** First occurrence of the rule's pattern strictly after `after` (ignores end conditions). */
function nextOccurrence(rule: RecurrenceRule, after: number, anchor: number): number | null {
  const pattern = rule.pattern;
  const from = startOfDay(after);

  if (pattern.kind === 'daily') {
    for (let i = 0; i <= 1; i++) {
      const day = new Date(from);
      day.setDate(day.getDate() + i);
      const ts = atTime(day, rule.time);
      if (ts > after) return ts;
    }
    return null;
  }

  if (pattern.kind === 'interval') {
    const every = Math.max(1, Math.floor(pattern.everyNDays || 1));
    const anchorDay = startOfDay(anchor);
    // Within `every` days of today there is always a phase-matching day; +1 covers
    // the case where today matches but its wall-clock time has already passed.
    for (let i = 0; i <= every; i++) {
      const day = new Date(from);
      day.setDate(day.getDate() + i);
      if (mod(daysBetween(anchorDay, day), every) !== 0) continue;
      const ts = atTime(day, rule.time);
      if (ts > after) return ts;
    }
    return null;
  }

  if (pattern.kind === 'weekly') {
    const days = (pattern.days ?? []).filter((d) => d >= 0 && d <= 6);
    if (days.length === 0) return null; // no weekday selected — nothing to fire
    const every = Math.max(1, Math.floor(pattern.everyNWeeks || 1));
    const anchorWeek = startOfWeek(anchor);
    // Scan a full phase cycle plus one week so a matching weekday is always found.
    const horizon = 7 * every + 7;
    for (let i = 0; i <= horizon; i++) {
      const day = new Date(from);
      day.setDate(day.getDate() + i);
      if (!days.includes(day.getDay() as Weekday)) continue;
      const weeksSince = Math.floor(daysBetween(anchorWeek, startOfWeek(day)) / 7);
      if (mod(weeksSince, every) !== 0) continue;
      const ts = atTime(day, rule.time);
      if (ts > after) return ts;
    }
    return null;
  }

  // monthly — day 1..28, or the last calendar day of the month
  const base = new Date(after);
  for (let i = 0; i <= 13; i++) {
    const year = base.getFullYear();
    const month = base.getMonth() + i;
    const dayOfMonth =
      pattern.day === 'last'
        ? new Date(year, month + 1, 0).getDate() // day 0 of next month = last of this one
        : clamp(pattern.day, 1, 28);
    const ts = atTime(new Date(year, month, dayOfMonth), rule.time);
    if (ts > after) return ts;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Human-readable summaries
// ---------------------------------------------------------------------------

/** Weekday labels in JS `Date.getDay()` order (index 0 = Sunday). */
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Monday-first display order for weekday chips and summaries. */
export const WEEKDAY_ORDER: Weekday[] = [1, 2, 3, 4, 5, 6, 0];

/** "09:00" for a rule's wall-clock time. */
function formatRuleTime(time: ScheduleTime | undefined): string {
  const hour = clamp(time?.hour ?? 0, 0, 23);
  const minute = clamp(time?.minute ?? 0, 0, 59);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 1 → "1st", 2 → "2nd", 23 → "23rd". */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** "Mon, Thu" — Monday-first, with the common sets collapsed to a word. */
function describeWeekdays(days: Weekday[]): string {
  const set = new Set(days);
  if (set.size === 7) return 'Every day';
  const isWeekdays = [1, 2, 3, 4, 5].every((d) => set.has(d as Weekday)) && set.size === 5;
  if (isWeekdays) return 'Weekdays';
  if (set.size === 2 && set.has(0) && set.has(6)) return 'Weekends';
  return WEEKDAY_ORDER.filter((d) => set.has(d))
    .map((d) => WEEKDAY_LABELS[d])
    .join(', ');
}

/**
 * One-line human summary of a schedule's timing, e.g.
 * "Weekdays 09:00" · "Every 2 weeks · Mon, Thu 08:30" · "1st of month 10:00" ·
 * "Once · Fri 09:00". Used by the schedules list and the session badges.
 */
export function describeScheduleSpec(spec: ScheduleSpec, nowMs: number = Date.now()): string {
  if (spec.kind === 'at') return `Once · ${formatScheduleTarget(spec.at, nowMs)}`;

  const rule = spec.rule;
  const time = formatRuleTime(rule.time);
  const pattern = rule.pattern;

  if (pattern.kind === 'daily') return `Daily ${time}`;

  if (pattern.kind === 'interval') {
    const every = Math.max(1, Math.floor(pattern.everyNDays || 1));
    return every === 1 ? `Daily ${time}` : `Every ${every} days ${time}`;
  }

  if (pattern.kind === 'weekly') {
    const days = (pattern.days ?? []).filter((d) => d >= 0 && d <= 6);
    const dayLabel = days.length === 0 ? 'No days selected' : describeWeekdays(days);
    const every = Math.max(1, Math.floor(pattern.everyNWeeks || 1));
    if (every > 1) return `Every ${every} weeks · ${dayLabel} ${time}`;
    return `${dayLabel} ${time}`;
  }

  const day = pattern.day === 'last' ? 'Last day' : ordinal(clamp(pattern.day, 1, 28));
  return `${day} of month ${time}`;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** First ~60 characters of the prompt, used when the user leaves the label empty. */
function deriveLabel(prompt: string): string {
  const flat = (prompt || '').replace(/\s+/g, ' ').trim();
  if (!flat) return 'Untitled schedule';
  return flat.length > 60 ? `${flat.slice(0, 60).trimEnd()}…` : flat;
}

/** Pattern kinds `computeNextFire` / `describeScheduleSpec` know how to walk. */
const PATTERN_KINDS = ['daily', 'weekly', 'monthly', 'interval'];

/**
 * Is this stored `when` structurally walkable? Both the recurrence math and the
 * human summaries dereference `rule.pattern.kind` without guards, so a truncated or
 * hand-edited spec has to be rejected here rather than thrown from a `$derived`.
 * Everything *inside* the pattern is already tolerated (missing time, out-of-range
 * day, NaN interval all clamp to sane defaults).
 */
export function isValidScheduleSpec(when: ScheduleSpec | undefined): when is ScheduleSpec {
  if (!when || typeof when !== 'object') return false;
  if (when.kind === 'at') return Number.isFinite(when.at);
  if (when.kind !== 'recurring') return false;
  const rule = when.rule;
  if (!rule || typeof rule !== 'object') return false;
  return !!rule.pattern && PATTERN_KINDS.includes(rule.pattern.kind);
}

/**
 * Fill in every field a persisted schedule may be missing (older writes, hand-edited
 * files). Mirrors the tolerant `normalizeItemState` pattern in `spareTokens.ts`.
 */
function normalizeSchedule(raw: Partial<Schedule>): Schedule | null {
  if (!raw || typeof raw !== 'object' || !raw.target || !isValidScheduleSpec(raw.when)) return null;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
  return {
    ...(raw.source === 'cli' ? { source: 'cli' as const } : {}),
    id: raw.id ?? crypto.randomUUID(),
    label: (typeof raw.label === 'string' ? raw.label.trim() : '') || deriveLabel(prompt),
    enabled: raw.enabled ?? true,
    target: raw.target,
    prompt,
    when: raw.when,
    waitForIdle: raw.waitForIdle ?? false,
    catchUp: raw.catchUp ?? 'run_once',
    createdAt: raw.createdAt ?? Date.now(),
    nextFireAt: raw.nextFireAt ?? null,
    lastRunAt: raw.lastRunAt,
    runCount: raw.runCount ?? 0,
    // Drop malformed rows rather than letting one of them break every surface that
    // renders the history list.
    history: Array.isArray(raw.history)
      ? raw.history
          .filter((r) => !!r && typeof r === 'object')
          .slice(0, MAX_HISTORY)
          // A retry timer doesn't survive a restart: a run still waiting on one was
          // never retried, so say so rather than showing "retrying" forever.
          .map((r) => (r.retry === 'pending' ? { ...r, retry: 'skipped' as const } : r))
      : [],
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function createSchedulesStore() {
  const { subscribe, set, update } = writable<Schedule[]>([]);

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
    // Never write before a successful load: if `get_schedules` failed, the store
    // is empty and a save here would replace schedules.json with that empty list.
    if (!loaded) return;
    try {
      await invoke('save_schedules', { items: get({ subscribe }) });
    } catch (error) {
      console.error('[schedules] Failed to save schedules:', error);
    }
  }

  async function load() {
    try {
      const raw = await invoke<unknown[]>('get_schedules');
      const items: Schedule[] = [];
      for (const entry of raw ?? []) {
        // Isolate per item: one unreadable row must not abort the whole load. An
        // aborted load leaves the store empty, and the next mutation persists that
        // empty list over a perfectly good file.
        try {
          const item = normalizeSchedule(entry as Partial<Schedule>);
          if (!item) continue;
          // A stored `nextFireAt` of null means the value was never computed (or the
          // rule was edited elsewhere) — recompute it. `computeNextFire` returns null
          // again for a genuinely spent one-shot, so this is safe for both spec kinds.
          // A past-due value is deliberately left alone: the driver's catch-up pass
          // owns that decision (`catchUp: 'run_once' | 'skip'`).
          if (item.enabled && item.nextFireAt == null) {
            item.nextFireAt = computeNextFire(item.when, Date.now(), item.createdAt, item.runCount);
          }
          items.push(item);
        } catch (error) {
          console.error('[schedules] Skipping unreadable schedule:', error, entry);
        }
      }
      set(items);
      loaded = true;
    } catch (error) {
      console.error('[schedules] Failed to load schedules:', error);
    }
  }

  function getSchedule(id: string): Schedule | undefined {
    return get({ subscribe }).find((s) => s.id === id);
  }

  function add(partial: NewSchedule): Schedule {
    // `createdAt` doubles as the recurrence anchor, so it is always "now" —
    // callers can't backdate a schedule into a different everyNWeeks phase.
    const createdAt = Date.now();
    const item: Schedule = {
      ...(partial.source ? { source: partial.source } : {}),
      id: crypto.randomUUID(),
      label: partial.label?.trim() || deriveLabel(partial.prompt),
      enabled: partial.enabled ?? true,
      target: partial.target,
      prompt: partial.prompt,
      when: partial.when,
      waitForIdle: partial.waitForIdle ?? false,
      catchUp: partial.catchUp ?? 'run_once',
      createdAt,
      nextFireAt:
        partial.nextFireAt ?? computeNextFire(partial.when, Date.now(), createdAt, 0),
      lastRunAt: partial.lastRunAt,
      runCount: 0,
      history: [],
    };
    update((items) => [...items, item]);
    schedulePersist();
    return item;
  }

  /**
   * Patch a schedule. Changing the timing rule (or re-enabling a spent one)
   * recomputes `nextFireAt` from now so the change takes effect immediately.
   */
  function updateSchedule(id: string, patch: Partial<Schedule>) {
    update((items) =>
      items.map((s) => {
        if (s.id !== id) return s;
        const next = { ...s, ...patch };
        if (patch.label !== undefined) next.label = patch.label.trim() || deriveLabel(next.prompt);
        const timingChanged = patch.when !== undefined;
        const reEnabled = patch.enabled === true && !s.enabled;
        if (patch.nextFireAt === undefined && (timingChanged || reEnabled)) {
          next.nextFireAt = computeNextFire(next.when, Date.now(), next.createdAt, next.runCount);
        }
        return next;
      })
    );
    schedulePersist();
  }

  function remove(id: string) {
    update((items) => items.filter((s) => s.id !== id));
    schedulePersist();
  }

  /** Clone a schedule as a fresh, never-run copy (new id/anchor, empty history). */
  function duplicate(id: string): Schedule | null {
    const source = getSchedule(id);
    if (!source) return null;
    const createdAt = Date.now();
    const copy: Schedule = {
      ...source,
      id: crypto.randomUUID(),
      label: `${source.label} (copy)`,
      createdAt,
      nextFireAt: computeNextFire(source.when, createdAt, createdAt, 0),
      lastRunAt: undefined,
      runCount: 0,
      history: [],
    };
    update((items) => [...items, copy]);
    schedulePersist();
    return copy;
  }

  function setEnabled(id: string, enabled: boolean) {
    updateSchedule(id, { enabled });
  }

  /**
   * Skip the upcoming occurrence: advance past it and record a `skipped` run.
   * Does NOT count toward `runCount` / `maxRuns` — nothing actually ran.
   */
  function skipNext(id: string) {
    const source = getSchedule(id);
    if (!source || source.nextFireAt == null) return;
    const skippedAt = source.nextFireAt;
    // Search forward from `now` when the skipped occurrence is already past due (held by
    // `waitForIdle`, or missed while the app was closed) — advancing from `skippedAt` alone
    // could land on another past occurrence, which the driver would fire on the next tick.
    const from = Math.max(skippedAt, Date.now());
    update((items) =>
      items.map((s) =>
        s.id === id
          ? {
              ...s,
              nextFireAt: computeNextFire(s.when, from, s.createdAt, s.runCount),
              history: [{ at: skippedAt, status: 'skipped' as const }, ...s.history].slice(
                0,
                MAX_HISTORY
              ),
            }
          : s
      )
    );
    schedulePersist();
  }

  /**
   * Driver-facing: consume the current occurrence *before* firing it, so a
   * failure can never stall the series. Bumps `runCount`/`lastRunAt` and rolls
   * `nextFireAt` forward (null for a spent one-shot / ended recurrence).
   */
  function markFired(id: string, at: number) {
    update((items) =>
      items.map((s) => {
        if (s.id !== id) return s;
        const runCount = s.runCount + 1;
        return {
          ...s,
          lastRunAt: at,
          runCount,
          nextFireAt: computeNextFire(s.when, at, s.createdAt, runCount),
        };
      })
    );
    schedulePersist();
  }

  /** Driver-facing: advance past a missed occurrence without running it. */
  function markMissed(id: string, at: number) {
    update((items) =>
      items.map((s) =>
        s.id === id
          ? {
              ...s,
              nextFireAt: computeNextFire(s.when, at, s.createdAt, s.runCount),
              history: [{ at, status: 'skipped' as const }, ...s.history].slice(0, MAX_HISTORY),
            }
          : s
      )
    );
    schedulePersist();
  }

  /** Driver-facing: prepend a run to the schedule's history (newest first, capped). */
  function recordRun(id: string, run: ScheduleRun) {
    update((items) =>
      items.map((s) =>
        s.id === id ? { ...s, history: [run, ...s.history].slice(0, MAX_HISTORY) } : s
      )
    );
    schedulePersist();
  }

  /** Driver-facing: patch one history entry by its `id` (no-op if it was evicted/deleted). */
  function updateRun(id: string, runId: string, patch: Partial<ScheduleRun>) {
    let changed = false;
    update((items) =>
      items.map((s) => {
        if (s.id !== id || !s.history.some((r) => r.id === runId)) return s;
        changed = true;
        return { ...s, history: s.history.map((r) => (r.id === runId ? { ...r, ...patch } : r)) };
      })
    );
    if (changed) schedulePersist();
  }

  /** A history entry by id. */
  function getRun(id: string, runId: string): ScheduleRun | undefined {
    return getSchedule(id)?.history.find((r) => r.id === runId);
  }

  /**
   * Fire a schedule right now, out of band: does NOT count toward `maxRuns` and
   * ignores the idle hold (it's an explicit user action). A *future* `nextFireAt`
   * is left untouched — but a due/past-due occurrence (held by `waitForIdle`, or
   * missed while the app was closed) is consumed by advancing past it, otherwise
   * the driver would fire the same occurrence again on the next tick. The run is
   * still recorded in the history. Returns the session id the run targeted/launched.
   */
  async function runNow(id: string): Promise<string | null> {
    const schedule = getSchedule(id);
    if (!schedule) return null;
    if (schedule.nextFireAt != null && schedule.nextFireAt <= Date.now()) {
      update((items) =>
        items.map((s) =>
          s.id === id
            ? { ...s, nextFireAt: computeNextFire(s.when, Date.now(), s.createdAt, s.runCount) }
            : s
        )
      );
      schedulePersist();
    }
    return fireSchedule(schedule);
  }

  return {
    subscribe,
    load,
    isLoaded: () => loaded,
    getSchedule,
    add,
    update: updateSchedule,
    remove,
    duplicate,
    setEnabled,
    skipNext,
    runNow,
    // Driver-facing bookkeeping (used by startSchedules below)
    markFired,
    markMissed,
    recordRun,
    updateRun,
    getRun,
  };
}

export const schedules = createSchedulesStore();

// ---------------------------------------------------------------------------
// Derived stores for the UI
// ---------------------------------------------------------------------------

/** Enabled schedules with a pending fire time, soonest first. */
export const upcomingSchedules = derived(schedules, ($items) =>
  $items
    .filter((s) => s.enabled && s.nextFireAt != null)
    .sort((a, b) => (a.nextFireAt ?? 0) - (b.nextFireAt ?? 0))
);

/** Earliest upcoming fire time (epoch ms), or null when nothing is scheduled. */
export const nextScheduleFireAt = derived(
  upcomingSchedules,
  ($upcoming) => $upcoming[0]?.nextFireAt ?? null
);

/** How many schedules are armed (enabled *and* still have an occurrence ahead). */
export const enabledScheduleCount = derived(upcomingSchedules, ($upcoming) => $upcoming.length);

/** Total number of schedules (armed or not) — drives the sidebar tab count. */
export const scheduleCount = derived(schedules, ($items) => $items.length);

/** Currently selected schedule (shown in the main pane, mirrors `selectedPileItemId`). */
export const selectedScheduleId = writable<string | null>(null);

export const selectedSchedule = derived(
  [schedules, selectedScheduleId],
  ([$items, $id]) => ($id ? $items.find((s) => s.id === $id) ?? null : null)
);

/** The newest run that actually happened (skipped occurrences never ran). */
export function lastRealRun(schedule: Schedule): ScheduleRun | undefined {
  return schedule.history.find((r) => r.status !== 'skipped');
}

/**
 * One-line remark for a history row: the failure reason / note plus the automatic
 * retry state, e.g. "API overloaded (529) · retrying at 07:05" or
 * "Automatic retry · Login expired (OAuth)".
 */
export function describeRunNote(run: ScheduleRun): string | undefined {
  const parts: string[] = [];
  if (run.retryOf) parts.push('Automatic retry');
  if (run.note) parts.push(run.note);
  else if (run.error) parts.push(run.error);
  if (run.retry === 'pending') {
    const at = run.retryAt
      ? new Date(run.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : null;
    parts.push(at ? `retrying at ${at}` : 'retrying');
  } else if (run.retry === 'sent') {
    parts.push('retried');
  } else if (run.retry === 'skipped') {
    parts.push('not retried');
  }
  return parts.length ? parts.join(' · ') : undefined;
}

// ---------------------------------------------------------------------------
// Schedule context notice
// ---------------------------------------------------------------------------

/**
 * `<system-message>` block telling the agent that the turn was started by a
 * schedule rather than typed by a user just now: the recurrence pattern, which run
 * this is, and when the neighbouring runs are/were.
 *
 * Always attached — it is factual provenance, not a preference, so there is no
 * setting for it. Deliberately descriptive ONLY: it carries no behavioural
 * instructions, so an agent on a scheduled run behaves exactly like an interactive
 * one.
 *
 * Must be called with the schedule as it looked BEFORE the fire was booked (both
 * `markFired` and `runNow` clone via `update`, so the object the driver captured is
 * pre-advance): `runCount` is the number of completed runs and `history[0]` is the
 * previous one. The *upcoming* fire time is re-read from the store, where it has
 * already rolled forward past this occurrence.
 */
function buildScheduleNotice(schedule: Schedule): string {
  const now = Date.now();
  const recurring = schedule.when.kind === 'recurring';
  const lines: string[] = [
    `This prompt was started automatically by a ${recurring ? 'recurring ' : ''}scheduled task in OpenWhisperer. No user typed it just now.`,
    '',
    `Schedule: "${schedule.label}"`,
  ];

  if (recurring) {
    lines.push(
      `Pattern: ${describeScheduleSpec(schedule.when, now)} — this is run #${schedule.runCount + 1}`
    );

    // Skipped occurrences never ran, so the newest non-skipped entry is the last
    // run that actually happened.
    const previous = schedule.history.find((r) => r.status !== 'skipped');
    if (previous) {
      const failed = previous.status === 'failed';
      const reason = failed ? (previous.note ? `failed: ${previous.note}` : 'failed') : '';
      lines.push(
        `Previous run: ${formatScheduleTarget(previous.at, now)}${reason ? ` (${reason})` : ''}`
      );
    }

    const nextFireAt = schedules.getSchedule(schedule.id)?.nextFireAt;
    if (nextFireAt != null && nextFireAt > now) {
      lines.push(`Next run: ${formatScheduleTarget(nextFireAt, now)}`);
    }
  }

  return `<system-message>\n${lines.join('\n')}\n</system-message>`;
}

// ---------------------------------------------------------------------------
// Firing pipeline
// ---------------------------------------------------------------------------

/**
 * Session launches all go through one module-level queue so a same-tick pileup
 * (several schedules due at 09:00) starts sequentially with a stagger instead of
 * hammering git/the sidecar.
 */
const launchQueue = createSessionQueue();

// ---------------------------------------------------------------------------
// First-turn outcome tracking
// ---------------------------------------------------------------------------
//
// A run is recorded when its session launches / its turn is sent, but the agent
// turn can still fail (an expired login, a 529). Each fired run is watched until
// its first turn settles; a failure flips the history entry to `failed` with a
// short reason. Transient errors get ONE automatic retry into the same session
// after RETRY_DELAY_MS; everything else (auth above all) raises a system
// notification instead. Nothing here is persisted beyond the history entry: an app
// restart mid-turn leaves the run as recorded, and a pending retry is dropped
// (`normalizeSchedule` marks it 'skipped').

/** Delay before the one automatic retry of a transiently failed run. */
const RETRY_DELAY_MS = 5 * 60_000;

/** Give up watching a turn after this long (covers a Smart-Queue-parked launch + a long turn). */
const WATCH_TIMEOUT_MS = 24 * 60 * 60_000;

/** Coalesce failure notifications: a 07:00 pileup of expired-login runs → one toast. */
const NOTIFY_COALESCE_MS = 30_000;

interface RunWatch {
  scheduleId: string;
  runId: string;
  sessionId: string;
  /** Session message count just before the turn went out (0 for a fresh session). */
  base: number;
  prompt: string;
  action?: 'compact';
  /** Send-time schedule notice the original turn carried (message targets only — a
   *  session target's notice rides the session's system prompt and stays in force). */
  scheduleNotice?: string;
  allowRetry: boolean;
}

function joinNotes(...notes: Array<string | undefined>): string | undefined {
  const parts = notes.filter((n): n is string => !!n && !!n.trim());
  return parts.length ? parts.join(' · ') : undefined;
}

function truncateError(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function countUserTurns(messages: SdkMessage[]): number {
  let n = 0;
  for (const m of messages) if (m.type === 'user' && !m.queued) n++;
  return n;
}

/**
 * Descriptive framing for the automatic retry — like the schedule notice itself, no
 * behavioural instructions. Extends the original notice when the turn had one.
 */
function buildRetryNotice(original: string | undefined, reason: string): string {
  const line = `This is an automatic retry: the previous attempt at this scheduled prompt ended with a transient error (${reason}). Anything that attempt already did is above in this conversation.`;
  const closing = '\n</system-message>';
  if (original && original.endsWith(closing)) {
    return `${original.slice(0, -closing.length)}\n\n${line}${closing}`;
  }
  return `<system-message>\n${line}${closing}`;
}

let pendingFailureNotices: Array<{ label: string; error: Pick<RunErrorClass, 'kind' | 'note'> }> = [];
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

/** Queue a system notification for a scheduled run that failed for good. */
function notifyRunFailure(label: string, error: Pick<RunErrorClass, 'kind' | 'note'>): void {
  pendingFailureNotices.push({ label, error });
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => void flushFailureNotices(), NOTIFY_COALESCE_MS);
}

async function flushFailureNotices(): Promise<void> {
  const items = pendingFailureNotices;
  pendingFailureNotices = [];
  notifyTimer = null;
  if (items.length === 0) return;
  const title =
    items.length === 1
      ? `Scheduled run failed: ${items[0].label}`
      : `${items.length} scheduled runs failed`;
  const reasons = [...new Set(items.map((i) => i.error.note))].join(', ');
  const auth = items.some((i) => i.error.kind === 'auth');
  const body = auth ? `${reasons} — log in again in Settings → Accounts.` : reasons;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === 'granted';
    if (granted) sendNotification({ title, body });
  } catch (error) {
    console.warn('[schedules] Failed to send failure notification:', error);
  }
}

/**
 * Watch a fired run's first turn until it settles, the session goes away, or
 * WATCH_TIMEOUT_MS passes, then reconcile the history entry with what happened.
 * Call it once the turn has been handed to the session (after `launchSession` /
 * `sendPrompt` resolved), so the turn's user message is already in place.
 */
function watchRunOutcome(watch: RunWatch): void {
  let finished = false;
  let unsubscribe: (() => void) | null = null;
  let lastMessages: SdkMessage[] | undefined;
  let lastStatus: string | undefined;
  let lastParked: unknown;

  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    unsubscribe?.();
  };
  const timer = setTimeout(finish, WATCH_TIMEOUT_MS);

  unsubscribe = sdkSessions.subscribe((sessions) => {
    if (finished) return;
    const session = sessions.find((s) => s.id === watch.sessionId);
    // Closed / archived: leave the run as recorded.
    if (!session) return finish();
    // Store writes for OTHER sessions wake us too — only re-evaluate on a change here.
    if (
      session.messages === lastMessages &&
      session.status === lastStatus &&
      session.parkedTurns === lastParked
    ) {
      return;
    }
    lastMessages = session.messages;
    lastStatus = session.status;
    lastParked = session.parkedTurns;

    const outcome = evaluateScheduledTurn(session, watch.base);
    if (outcome.state === 'pending') return;
    finish();
    // Settle outside the subscriber: it writes to stores and may schedule a retry.
    const userTurns = countUserTurns(session.messages);
    queueMicrotask(() => settleRun(watch, outcome, userTurns));
  });
  // The first (synchronous) call may already have settled before `unsubscribe` existed.
  if (finished) unsubscribe();
}

function settleRun(
  watch: RunWatch,
  outcome: ReturnType<typeof evaluateScheduledTurn>,
  userTurnsAtSettle: number
): void {
  const run = schedules.getRun(watch.scheduleId, watch.runId);
  if (!run) return; // schedule deleted or the entry aged out of the history

  if (outcome.state === 'deferred') {
    if (run.status === 'ok') {
      schedules.updateRun(watch.scheduleId, watch.runId, {
        status: 'deferred',
        note: joinNotes(run.note, outcome.note),
      });
    }
    return;
  }
  if (outcome.state !== 'failed') return; // ok / stopped by the user

  const { error } = outcome;
  const patch: Partial<ScheduleRun> = {
    status: 'failed',
    note: joinNotes(run.note, error.note),
    error: truncateError(outcome.detail),
  };
  console.warn(`[schedules] Scheduled run failed (${error.kind}: ${error.note}) — session ${watch.sessionId}`);

  if (error.retryable && watch.allowRetry) {
    const retryAt = Date.now() + RETRY_DELAY_MS;
    schedules.updateRun(watch.scheduleId, watch.runId, { ...patch, retry: 'pending', retryAt });
    setTimeout(() => void retryRun(watch, error, userTurnsAtSettle), RETRY_DELAY_MS);
    return;
  }

  schedules.updateRun(watch.scheduleId, watch.runId, patch);
  const label = schedules.getSchedule(watch.scheduleId)?.label ?? 'Schedule';
  notifyRunFailure(label, error);
}

/** The one automatic retry of a transiently failed run: re-send into the same session. */
async function retryRun(watch: RunWatch, error: RunErrorClass, userTurnsAtFailure: number): Promise<void> {
  const run = schedules.getRun(watch.scheduleId, watch.runId);
  if (!run || run.retry !== 'pending') return;

  const session = get(sdkSessions).find((s) => s.id === watch.sessionId);
  // Don't retry over the user: the session is gone, busy, or someone already
  // continued it by hand (e.g. typed "keep going") since the failure.
  if (
    !session ||
    session.status === 'queued' ||
    isSessionBusy(session) ||
    countUserTurns(session.messages) > userTurnsAtFailure
  ) {
    schedules.updateRun(watch.scheduleId, watch.runId, { retry: 'skipped' });
    return;
  }

  const retryRunId = crypto.randomUUID();
  const base = session.messages.length;
  const at = Date.now();
  schedules.updateRun(watch.scheduleId, watch.runId, { retry: 'sent', retryAt: at });
  schedules.recordRun(watch.scheduleId, {
    id: retryRunId,
    at,
    status: 'ok',
    sessionId: watch.sessionId,
    retryOf: watch.runId,
  });

  try {
    if (watch.action === 'compact') {
      await sdkSessions.compactSession(watch.sessionId);
    } else {
      await sdkSessions.sendPrompt(watch.sessionId, watch.prompt, undefined, {
        systemNotice: buildRetryNotice(watch.scheduleNotice, error.note),
      });
    }
  } catch (sendError) {
    console.error('[schedules] Automatic retry could not be sent:', sendError);
    schedules.updateRun(watch.scheduleId, retryRunId, {
      status: 'failed',
      note: 'Retry could not be sent',
      error: truncateError(String(sendError)),
    });
    notifyRunFailure(schedules.getSchedule(watch.scheduleId)?.label ?? 'Schedule', error);
    return;
  }

  watchRunOutcome({ ...watch, runId: retryRunId, base, allowRetry: false });
}

/** Statuses a message target can be delivered to. Busy sessions are held earlier. */
function isMessageTargetUsable(session: SdkSession): boolean {
  return session.status === 'idle' || session.status === 'done' || session.status === 'error';
}

/** Is this session mid-turn (so a scheduled message must wait rather than interleave)? */
function isSessionBusy(session: SdkSession): boolean {
  return session.status === 'querying' || session.status === 'initializing';
}

/**
 * Launch a fresh session for a schedule. Used both by session targets and by a
 * message target's `launch_new` fallback. Records the run and returns the new
 * session id (null on failure).
 */
async function launchForSchedule(
  schedule: Schedule,
  config: {
    repoId: string;
    model: string;
    effortLevel: EffortLevel;
    provider: 'claude' | 'openai';
    accountId?: string;
    useWorktree?: boolean;
    worktreePath?: string;
    systemPrompt?: string;
  }
): Promise<string | null> {
  const at = Date.now();
  const runId = crypto.randomUUID();
  const repo = findRepoById(get(repos).list, config.repoId);
  if (!repo) {
    schedules.recordRun(schedule.id, {
      id: runId,
      at,
      status: 'failed',
      error: 'Repository no longer exists',
      note: 'Repository no longer exists',
    });
    notifyRunFailure(schedule.label, { kind: 'other', note: 'Repository no longer exists' });
    return null;
  }

  // An existing-worktree target whose directory vanished falls back to the main
  // checkout (user decision for CLI-created schedules — the alternative is a run
  // that silently never happens). The fallback is recorded on the run.
  let worktreePath = config.useWorktree ? undefined : config.worktreePath;
  let note: string | undefined;
  if (worktreePath) {
    const exists = await invoke<boolean>('path_is_dir', { path: worktreePath }).catch(() => false);
    if (!exists) {
      note = `Worktree ${worktreePath} is gone; ran in the main repository instead`;
      worktreePath = undefined;
    }
  }

  // Snapshot exhaustion at fire time: the launch still goes ahead (the
  // `startSetupSession` gate parks it as a `rate_limit` queued session and the
  // Smart Queue drains it at reset), but the run is recorded as `deferred`.
  const exhausted = providerExhaustion(config.provider, config.accountId).exhausted;

  // A fresh session per fire, so the schedule context rides the (invisible) system
  // prompt rail: appended to Claude's preset, prepended to the first Codex turn.
  const systemPrompt = [buildScheduleNotice(schedule), config.systemPrompt?.trim()]
    .filter(Boolean)
    .join('\n\n');

  try {
    const sessionId = await launchSession({
      prompt: schedule.prompt,
      repo,
      model: config.model,
      effortLevel: config.effortLevel,
      provider: config.provider,
      accountId: config.accountId,
      useWorktree: config.useWorktree,
      worktreePath,
      branchNameHint: schedule.label,
      systemPrompt,
      tag: { schedule: { id: schedule.id, label: schedule.label } },
      // Unattended runs must never silently fall back to editing the main repo.
      onWorktreeError: 'fail',
    });
    const parked = get(sdkSessions).find((s) => s.id === sessionId)?.status === 'queued';
    schedules.recordRun(schedule.id, {
      id: runId,
      at,
      status: exhausted || parked ? 'deferred' : 'ok',
      sessionId,
      ...(note ? { note } : {}),
    });
    // The launch only means the session started — follow its first turn (including
    // one the Smart Queue parked and sends later) so a failed turn isn't left as "ok".
    // The schedule notice rides the session's system prompt, so a retry needs none.
    watchRunOutcome({
      scheduleId: schedule.id,
      runId,
      sessionId,
      base: 0,
      prompt: schedule.prompt,
      allowRetry: true,
    });
    return sessionId;
  } catch (error) {
    console.error('[schedules] Launch failed:', error);
    schedules.recordRun(schedule.id, {
      id: runId,
      at,
      status: 'failed',
      error: truncateError(String(error)),
      note: joinNotes(note, 'Launch failed'),
    });
    notifyRunFailure(schedule.label, { kind: 'other', note: 'Launch failed' });
    return null;
  }
}

/** Deliver a scheduled turn to an existing session (or fall back per `ifSessionGone`). */
async function runMessageTarget(schedule: Schedule): Promise<string | null> {
  const target = schedule.target as ScheduleMessageTarget;
  const session = get(sdkSessions).find((s) => s.id === target.sessionId);

  if (!session || !isMessageTargetUsable(session)) {
    if (target.ifSessionGone === 'launch_new' && target.fallback) {
      return launchForSchedule(schedule, target.fallback);
    }
    schedules.recordRun(schedule.id, {
      at: Date.now(),
      status: 'skipped',
      error: 'Target session is gone',
    });
    return null;
  }

  const at = Date.now();
  const runId = crypto.randomUUID();
  // Where this turn begins in the transcript — the outcome watcher only looks past it.
  const base = session.messages.length;
  // A compaction turn carries no prompt of its own — nothing to frame.
  const notice = target.action === 'compact' ? undefined : buildScheduleNotice(schedule);
  try {
    if (target.action === 'compact') {
      await sdkSessions.compactSession(target.sessionId);
    } else {
      // Mid-session: no system-prompt rail exists, so the notice rides the sent
      // prompt (send-time only — the transcript keeps the user's prompt verbatim).
      await sdkSessions.sendPrompt(target.sessionId, schedule.prompt, undefined, {
        systemNotice: notice,
      });
    }
    schedules.recordRun(schedule.id, { id: runId, at, status: 'ok', sessionId: target.sessionId });
    watchRunOutcome({
      scheduleId: schedule.id,
      runId,
      sessionId: target.sessionId,
      base,
      prompt: schedule.prompt,
      action: target.action,
      scheduleNotice: notice,
      allowRetry: true,
    });
    return target.sessionId;
  } catch (error) {
    console.error('[schedules] Scheduled message failed:', error);
    schedules.recordRun(schedule.id, {
      id: runId,
      at,
      status: 'failed',
      sessionId: target.sessionId,
      error: truncateError(String(error)),
      note: 'Could not send the message',
    });
    notifyRunFailure(schedule.label, { kind: 'other', note: 'Could not send the message' });
    return null;
  }
}

/** Run a schedule's target now (no bookkeeping — callers advance the series first). */
async function fireSchedule(schedule: Schedule): Promise<string | null> {
  if (schedule.target.kind === 'session') {
    return launchForSchedule(schedule, schedule.target);
  }
  return runMessageTarget(schedule);
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/**
 * Should this schedule hold instead of firing right now?
 *
 * - Session target with `waitForIdle`: hold while any session in the target
 *   repo's scope is still working.
 * - Message target: ALWAYS holds while its own session is mid-turn, so a
 *   scheduled follow-up is never injected into a running turn.
 *
 * A hold does not advance the schedule — it is re-checked on the next tick.
 */
function isHeld(schedule: Schedule, sessions: SdkSession[]): boolean {
  if (schedule.target.kind === 'message') {
    const sessionId = schedule.target.sessionId;
    const session = sessions.find((s) => s.id === sessionId);
    return !!session && isSessionBusy(session);
  }
  if (!schedule.waitForIdle) return false;
  const repo = findRepoById(get(repos).list, schedule.target.repoId);
  if (!repo) return false; // missing repo — let it fire and fail with a clear reason
  // Scope = the cwd the run will use: the target's existing worktree, else the main checkout.
  const scope = (!schedule.target.useWorktree && schedule.target.worktreePath) || repo.path;
  return hasBusySessionsInScope(sessions, scope);
}

/** Re-entrancy guard: the tick and the startup pass can overlap. */
let evaluating = false;

/**
 * One evaluation pass over every due schedule.
 *
 * Order per schedule: idle hold → advance unconditionally → fire. Advancing
 * before firing is deliberate: a failed run must never stall the series, and all
 * occurrences missed while the app was closed coalesce into a single fire.
 */
async function evaluateSchedules(): Promise<void> {
  if (evaluating) return;
  evaluating = true;
  try {
    const now = Date.now();
    const due = get(schedules).filter(
      (s) => s.enabled && s.nextFireAt != null && now >= s.nextFireAt
    );

    const launches: Array<() => Promise<void>> = [];
    for (const schedule of due) {
      // Re-read the sessions each iteration: a message target fired earlier in this
      // same pass has already put its session into `querying`, and a snapshot taken
      // before the loop would still show it idle — sending a second scheduled turn
      // straight into the running one.
      if (isHeld(schedule, get(sdkSessions))) continue;
      schedules.markFired(schedule.id, now);
      if (schedule.target.kind === 'session') {
        launches.push(async () => {
          await fireSchedule(schedule);
        });
      } else {
        await fireSchedule(schedule);
      }
    }

    // Same-tick pileup: stagger the session launches so they don't all start at once.
    if (launches.length > 0) launchQueue.enqueue(launches, { stagger: true });
  } catch (error) {
    console.error('[schedules] Evaluation failed:', error);
  } finally {
    evaluating = false;
  }
}

/**
 * Startup catch-up: schedules whose fire time passed while the app was closed.
 * `catchUp: 'skip'` advances past them with a `skipped` history entry; the
 * `'run_once'` default is left for the regular evaluation, which fires them once
 * (all missed occurrences coalesced) and rolls forward to the next future slot.
 */
function catchUpMissed(): void {
  const now = Date.now();
  for (const schedule of get(schedules)) {
    if (!schedule.enabled || schedule.nextFireAt == null) continue;
    if (schedule.nextFireAt >= now) continue;
    if (schedule.catchUp === 'skip') schedules.markMissed(schedule.id, now);
  }
}

/**
 * Evaluate due schedules right away instead of waiting for the next 30 s tick.
 * Used after adding a schedule that is already due (e.g. `ow run --same-session`,
 * which parks a follow-up that should go out as soon as the session is idle).
 */
export function evaluateSchedulesNow(): Promise<void> {
  return evaluateSchedules();
}

let started = false;
let currentTeardown: (() => void) | null = null;

/**
 * Start the schedule driver: catch up on anything missed while the app was
 * closed, evaluate immediately, then re-evaluate every 30 s. Idempotent — a
 * second call while running is a no-op that returns the same teardown.
 *
 * Call once from `(main)/+layout.svelte`, after `schedules.load()`.
 */
export function startSchedules(): () => void {
  if (started && currentTeardown) return currentTeardown;
  started = true;

  catchUpMissed();
  void evaluateSchedules();

  let intervalId: ReturnType<typeof setInterval> | null = null;
  if (typeof window !== 'undefined') {
    intervalId = setInterval(() => void evaluateSchedules(), TICK_MS);
  }

  currentTeardown = () => {
    if (!started) return;
    started = false;
    currentTeardown = null;
    if (intervalId != null) clearInterval(intervalId);
  };

  return currentTeardown;
}
