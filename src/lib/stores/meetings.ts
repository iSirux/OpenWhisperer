/**
 * Meeting Mode store.
 *
 * Capture, segmentation and transcription run in Rust (`meeting_*` commands,
 * workstream C); this store mirrors that state (active meeting, delayed
 * transcript, input levels), and owns the **act layer**:
 *
 * - **Triage driver** — every `meeting.triage_interval_minutes` (and once more
 *   after the meeting is done) the not-yet-triaged transcript lines (plus ~30 s
 *   of already-triaged context) are sent to `meeting_triage`; the returned ops
 *   become meeting items (actionable → review list, optional auto-pile) or
 *   journal items (non-actionable), or add sightings to existing ones.
 * - **Consolidation** — after `done`, `meeting_consolidate` merges duplicates,
 *   rewrites titles/details and writes the meeting summary.
 *
 * Meeting items are persisted per meeting via `meeting_save_items` (opaque JSON,
 * this module owns the schema). Meeting speech never reaches voice commands or
 * wake words: transcripts arrive only through `meeting-transcript` events and
 * are never fed into the dictation pipeline. Open mic is kept off while a
 * meeting is active (gate in `useOpenMic`).
 */

import { writable, derived, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { settings, type MeetingConfig } from './settings';
import { repos, activeRepo, findRepoById, isRepoActive } from './repos';
import { pile } from './pile';
import { journal, toJournalCategory, type JournalOccurrence } from './journal';
import { overlay } from './overlay';
import { isRecording } from './recording';
import { navigation } from './navigation';
import type { EffortLevel } from './sdkSessions';
import { resolveTier } from '$lib/utils/autoModelTiers';

// ---------------------------------------------------------------------------
// Backend contract types (workstream C / A) — snake_case
// ---------------------------------------------------------------------------

export type MeetingStatus = 'recording' | 'paused' | 'finalizing' | 'done' | 'interrupted';

export interface MeetingMeta {
  id: string;
  title: string;
  started_at: number;
  ended_at: number | null;
  status: MeetingStatus;
  repo_id: string | null;
  auto_repo: boolean;
  context: string | null;
  summary: string | null;
  sources: { mic: boolean; system: boolean; system_target: 'all' | 'process' };
  segment_count: number;
  pending_segments: number;
  failed_segments: number;
  duration_secs: number;
}

export interface TranscriptLine {
  seg_id: string;
  t0: number;
  t1: number;
  /** 'me' | 'them' | 'them:<label>' */
  speaker: string;
  text: string;
  status: 'pending' | 'ok' | 'error';
  error?: string | null;
}

export interface MeetingStartOptions {
  title: string | null;
  repo_id: string | null;
  auto_repo: boolean;
  context: string | null;
  vocabulary: string[] | null;
}

type TriageCategory =
  | 'bug'
  | 'task'
  | 'investigate'
  | 'question'
  | 'feedback'
  | 'idea'
  | 'decision'
  | 'note';

interface TriageOp {
  op: 'new' | 'update';
  id: string | null;
  category: TriageCategory | null;
  title: string | null;
  detail: string | null;
  quote: string;
  t0: string;
  complexity: number | null;
  confidence: number | null;
  repo_id: string | null;
}

interface MeetingTriageResult {
  ops: TriageOp[];
}

interface MeetingConsolidateResult {
  summary: string;
  merges: { keep_id: string; merge_ids: string[] }[];
  updates: { id: string; title: string; detail: string; category: string }[];
}

// ---------------------------------------------------------------------------
// Meeting items (items.json — frontend-owned)
// ---------------------------------------------------------------------------

export type MeetingItemCategory = TriageCategory;
export type MeetingItemStatus = 'new' | 'piled' | 'journaled' | 'dismissed';

export const MEETING_CATEGORIES: MeetingItemCategory[] = [
  'bug',
  'task',
  'investigate',
  'question',
  'feedback',
  'idea',
  'decision',
  'note',
];
const ACTIONABLE_CATEGORIES: ReadonlySet<string> = new Set(['bug', 'task', 'investigate', 'question']);

export function isActionableCategory(category: string): boolean {
  return ACTIONABLE_CATEGORIES.has(category);
}

export interface MeetingOccurrence {
  quote: string;
  t0: number;
  t1: number;
  speaker: string;
  seg_id: string | null;
}

export interface MeetingItem {
  id: string;
  category: MeetingItemCategory;
  title: string;
  detail: string;
  complexity: number | null;
  confidence: number | null;
  repo_id: string | null;
  occurrences: MeetingOccurrence[];
  status: MeetingItemStatus;
  pile_item_id: string | null;
  journal_item_id: string | null;
  created_at: number;
  updated_at: number;
  /** Set when consolidation merged this item into another */
  merged_into?: string | null;
  /** Set once the user edited title/detail — triage/consolidation stop rewriting them */
  edited?: boolean;
}

/** On-disk shape of `items.json`. */
interface MeetingItemsFile {
  version: 1;
  items: MeetingItem[];
  /** Transcript segments already sent to triage */
  triaged_seg_ids: string[];
  last_triage_at: number | null;
  consolidated_at: number | null;
}

// ---------------------------------------------------------------------------
// Store state
// ---------------------------------------------------------------------------

export interface MeetingRuntime {
  meta: MeetingMeta;
  /** Epoch ms when `meta` was last received (live-clock base) */
  metaAt: number;
  /** null = not loaded yet */
  transcript: TranscriptLine[] | null;
  items: MeetingItem[];
  itemsLoaded: boolean;
  /**
   * Non-null when items.json failed to load. Saves (and triage /
   * consolidation, which would write) are blocked for this meeting so the
   * empty in-memory state never overwrites the file on disk.
   */
  itemsLoadError: string | null;
  triagedSegIds: string[];
  lastTriageAt: number | null;
  consolidatedAt: number | null;
  triageRunning: boolean;
  triageError: string | null;
  consolidating: boolean;
  consolidateError: string | null;
}

export interface MeetingErrorEntry {
  meeting_id: string;
  message: string;
  seg_id: string | null;
  at: number;
}

interface MeetingsState {
  list: MeetingMeta[];
  listLoaded: boolean;
  activeId: string | null;
  /** Meeting open in the Meeting view (null = home: start panel + past meetings) */
  selectedId: string | null;
  runtimes: Record<string, MeetingRuntime>;
  level: { mic: number; system: number };
  errors: MeetingErrorEntry[];
  starting: boolean;
  startError: string | null;
}

const LIVE_STATUSES: ReadonlySet<MeetingStatus> = new Set(['recording', 'paused', 'finalizing']);
const TRIAGE_OVERLAP_SECS = 30;
/** Soft cap on transcript characters per triage call (the backend has no truncation). */
const TRIAGE_CHUNK_CHARS = 16_000;
const TRIAGE_TICK_MS = 10_000;
const CONSENT_STORAGE_KEY = 'openwhisperer.meeting.consentAcknowledged';

const DEFAULT_MEETING_CONFIG: MeetingConfig = {
  capture_mic: true,
  capture_system: true,
  system_target: 'process',
  system_process_names: ['Discord.exe', 'Teams.exe', 'ms-teams.exe'],
  mic_device: null,
  vad_threshold: 0.015,
  silence_hangover_ms: 1200,
  max_segment_secs: 90,
  transcription_provider: null,
  transcription_model: null,
  triage_interval_minutes: 3,
  auto_pile: false,
  auto_pile_min_confidence: 0.85,
  default_auto_repo: false,
  retention_days: 30,
};

/** Current meeting config merged over defaults (tolerates an older backend). */
export function meetingConfig(): MeetingConfig {
  return { ...DEFAULT_MEETING_CONFIG, ...(get(settings).meeting ?? {}) };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Seconds → "HH:MM:SS". */
export function formatMeetingTime(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** "HH:MM:SS" / "MM:SS" / numeric seconds → seconds (NaN when unparseable). */
export function parseMeetingTime(value: string | number | null | undefined): number {
  if (typeof value === 'number') return value;
  if (!value) return NaN;
  const parts = String(value).trim().split(':').map((p) => Number(p));
  if (parts.some((p) => Number.isNaN(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** 'me' → "Me", 'them' → "Them", 'them:A' → "Them (A)". */
export function speakerLabel(speaker: string | null | undefined): string {
  if (!speaker) return '';
  if (speaker === 'me') return 'Me';
  if (speaker === 'them') return 'Them';
  if (speaker.startsWith('them:')) return `Them (${speaker.slice(5)})`;
  return speaker;
}

function formatTranscriptLines(lines: TranscriptLine[]): string {
  return lines
    .map((l) => `[${formatMeetingTime(l.t0)} ${l.speaker}] ${l.text.trim()}`)
    .join('\n');
}

/** Live recording duration of a meeting (seconds), ticking while recording. */
export function liveDurationSecs(rt: MeetingRuntime | undefined, now: number): number {
  if (!rt) return 0;
  const base = rt.meta.duration_secs || 0;
  return rt.meta.status === 'recording' ? base + Math.max(0, (now - rt.metaAt) / 1000) : base;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function normalizeCategory(value: string | null | undefined): MeetingItemCategory | null {
  if (!value) return null;
  const v = value.toLowerCase().trim();
  return (MEETING_CATEGORIES as string[]).includes(v) ? (v as MeetingItemCategory) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map a triage mention to the transcript line it most likely came from. */
function locateMention(
  quote: string,
  secs: number,
  lines: TranscriptLine[]
): MeetingOccurrence {
  const okLines = lines.filter((l) => l.status === 'ok');
  const distance = (l: TranscriptLine) =>
    Number.isNaN(secs) ? 0 : secs < l.t0 ? l.t0 - secs : secs > l.t1 ? secs - l.t1 : 0;

  const needle = normalizeText(quote).slice(0, 40);
  let candidates = needle
    ? okLines.filter((l) => normalizeText(l.text).includes(needle))
    : [];
  if (candidates.length === 0) candidates = okLines;

  let best: TranscriptLine | null = null;
  for (const line of candidates) {
    if (!best || distance(line) < distance(best)) best = line;
  }
  if (!best) {
    const t = Number.isNaN(secs) ? 0 : secs;
    return { quote: quote.trim(), t0: t, t1: t, speaker: 'them', seg_id: null };
  }
  return {
    quote: quote.trim() || best.text.trim(),
    t0: best.t0,
    t1: best.t1,
    speaker: best.speaker,
    seg_id: best.seg_id,
  };
}

function addOccurrenceDeduped(list: MeetingOccurrence[], occ: MeetingOccurrence): MeetingOccurrence[] {
  const dup = list.some(
    (o) => (o.seg_id ?? '') === (occ.seg_id ?? '') && o.quote.trim() === occ.quote.trim()
  );
  return dup ? list : [...list, occ].sort((a, b) => a.t0 - b.t0);
}

function toJournalOccurrence(meetingId: string, occ: MeetingOccurrence): JournalOccurrence {
  return {
    meetingId,
    quote: occ.quote,
    t0: occ.t0,
    t1: occ.t1,
    speaker: occ.speaker,
    segId: occ.seg_id ?? undefined,
    at: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Consent (first-use notice)
// ---------------------------------------------------------------------------

function readConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export const meetingConsentAcknowledged = writable<boolean>(
  typeof localStorage !== 'undefined' ? readConsent() : false
);

export function acknowledgeMeetingConsent() {
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, '1');
  } catch {
    /* ignore */
  }
  meetingConsentAcknowledged.set(true);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function createMeetingsStore() {
  const store = writable<MeetingsState>({
    list: [],
    listLoaded: false,
    activeId: null,
    selectedId: null,
    runtimes: {},
    level: { mic: 0, system: 0 },
    errors: [],
    starting: false,
    startError: null,
  });
  const { subscribe, update } = store;

  /** Meetings whose final triage + consolidation should run once they reach `done`. */
  const postProcessPending = new Set<string>();
  const postProcessRunning = new Set<string>();
  /** Done meetings already checked for missed post-processing this app run. */
  const recoveryChecked = new Set<string>();
  /** In-flight triage per meeting (resolves to the number of lines triaged). */
  const triageInFlight = new Map<string, Promise<number>>();
  /** Debounced triage for segments retried after the meeting was done. */
  const lateTriageTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Status-event ordering. Every mutation in the backend emits a
   * `meeting-status` event before the command that caused it returns, so a
   * command response (or a list/get snapshot) is stale whenever a status
   * event for that meeting arrived after the command was issued — the events
   * (which arrive in order) already carry equal-or-newer state.
   */
  let metaEventCounter = 0;
  const lastMetaEventSeq = new Map<string, number>();
  function isStaleSnapshot(id: string, issuedAtSeq: number): boolean {
    return (lastMetaEventSeq.get(id) ?? 0) > issuedAtSeq;
  }

  /** Transcript lines that arrive while a `meeting_get` is in flight. */
  const transcriptLoads = new Map<string, number>();
  const bufferedLines = new Map<string, Map<string, TranscriptLine>>();

  /** One in-flight items.json save per meeting; `dirty` coalesces requests. */
  const saveSlots = new Map<string, { running: Promise<void> | null; dirty: boolean }>();

  function state(): MeetingsState {
    return get(store);
  }

  function runtime(id: string): MeetingRuntime | undefined {
    return state().runtimes[id];
  }

  function patchRuntime(id: string, patch: Partial<MeetingRuntime>) {
    update((s) => {
      const rt = s.runtimes[id];
      if (!rt) return s;
      return { ...s, runtimes: { ...s.runtimes, [id]: { ...rt, ...patch } } };
    });
  }

  function ensureRuntime(meta: MeetingMeta, opts: { freshTranscript?: boolean } = {}) {
    update((s) => {
      const existing = s.runtimes[meta.id];
      const rt: MeetingRuntime = existing
        ? { ...existing, meta, metaAt: Date.now() }
        : {
            meta,
            metaAt: Date.now(),
            transcript: opts.freshTranscript ? [] : null,
            items: [],
            itemsLoaded: !!opts.freshTranscript,
            itemsLoadError: null,
            triagedSegIds: [],
            lastTriageAt: null,
            consolidatedAt: null,
            triageRunning: false,
            triageError: null,
            consolidating: false,
            consolidateError: null,
          };
      return { ...s, runtimes: { ...s.runtimes, [meta.id]: rt } };
    });
  }

  function upsertListMeta(meta: MeetingMeta) {
    update((s) => {
      const exists = s.list.some((m) => m.id === meta.id);
      const list = exists
        ? s.list.map((m) => (m.id === meta.id ? meta : m))
        : [meta, ...s.list];
      list.sort((a, b) => b.started_at - a.started_at);
      return { ...s, list };
    });
  }

  // -------------------------------------------------------------------------
  // Overlay indicator
  // -------------------------------------------------------------------------

  let lastOverlayKey = '';
  function syncOverlay() {
    const s = state();
    const rt = s.activeId ? s.runtimes[s.activeId] : undefined;
    const live = rt && (rt.meta.status === 'recording' || rt.meta.status === 'paused');
    const key = live ? `${rt!.meta.id}:${rt!.meta.status}:${rt!.metaAt}` : '';
    if (key === lastOverlayKey) return;
    lastOverlayKey = key;
    void overlay.setMeetingInfo(
      live
        ? {
            meetingId: rt!.meta.id,
            title: rt!.meta.title,
            status: rt!.meta.status as 'recording' | 'paused',
            durationSecs: rt!.meta.duration_secs || 0,
            baseAt: rt!.metaAt,
          }
        : null,
      { dictationActive: get(isRecording) }
    );
  }

  // -------------------------------------------------------------------------
  // Backend status / events
  // -------------------------------------------------------------------------

  type MetaSource =
    | 'event'
    | {
        /** `metaEventCounter` when the command was issued */
        commandSeq: number;
        /** finalize legitimately moves interrupted/done → finalizing */
        allowRevive?: boolean;
      };

  const TERMINAL_STATUSES: ReadonlySet<MeetingStatus> = new Set(['done', 'interrupted']);

  function applyMeta(meta: MeetingMeta, source: MetaSource = 'event') {
    if (source === 'event') {
      lastMetaEventSeq.set(meta.id, ++metaEventCounter);
    } else {
      // A `done` event can beat the stop/finalize response; never let the
      // older response revive the meeting (that would block new starts).
      if (isStaleSnapshot(meta.id, source.commandSeq)) return;
      const current = runtime(meta.id)?.meta.status;
      if (
        current &&
        TERMINAL_STATUSES.has(current) &&
        LIVE_STATUSES.has(meta.status) &&
        !source.allowRevive
      ) {
        return;
      }
    }
    ensureRuntime(meta);
    upsertListMeta(meta);
    update((s) => {
      let activeId = s.activeId;
      if (LIVE_STATUSES.has(meta.status)) activeId = meta.id;
      else if (activeId === meta.id) activeId = null;
      return { ...s, activeId };
    });
    if (meta.status === 'finalizing') postProcessPending.add(meta.id);
    syncOverlay();
    if (meta.status === 'done' && postProcessPending.has(meta.id)) {
      postProcessPending.delete(meta.id);
      void postProcess(meta.id);
    }
  }

  /**
   * Merge a newer sighting of a line into `map`: the later status wins,
   * except that a finished `ok` line is never regressed to `pending` (the
   * pending event of a retry can be older than the snapshot that has its
   * result).
   */
  function mergeLine(map: Map<string, TranscriptLine>, line: TranscriptLine) {
    const existing = map.get(line.seg_id);
    if (existing && existing.status === 'ok' && line.status === 'pending') return;
    map.set(line.seg_id, line);
  }

  function applyTranscriptLine(meetingId: string, line: TranscriptLine) {
    // A load is in flight: its snapshot may predate this line — keep it so
    // the load merges it instead of replacing it away.
    if ((transcriptLoads.get(meetingId) ?? 0) > 0) {
      let buf = bufferedLines.get(meetingId);
      if (!buf) {
        buf = new Map();
        bufferedLines.set(meetingId, buf);
      }
      mergeLine(buf, line);
    }
    const rt = runtime(meetingId);
    if (!rt || rt.transcript === null) return; // loaded fully on open
    const prev = rt.transcript.find((l) => l.seg_id === line.seg_id);
    const others = rt.transcript.filter((l) => l.seg_id !== line.seg_id);
    const transcript = [...others, line].sort((a, b) => a.t0 - b.t0);
    patchRuntime(meetingId, { transcript });
    maybeScheduleLateTriage(meetingId, prev, line);
  }

  /**
   * A segment retried on a `done` meeting that flips to ok would never be
   * triaged (rolling triage only runs while live). Schedule a debounced
   * triage for it; `runTriage` waits for any triage already in flight.
   */
  function maybeScheduleLateTriage(meetingId: string, prev: TranscriptLine | undefined, line: TranscriptLine) {
    if (line.status !== 'ok' || !line.text.trim()) return;
    if (prev?.status === 'ok') return;
    const rt = runtime(meetingId);
    if (!rt || rt.meta.status !== 'done') return;
    if (rt.triagedSegIds.includes(line.seg_id)) return;
    const existing = lateTriageTimers.get(meetingId);
    if (existing) clearTimeout(existing);
    lateTriageTimers.set(
      meetingId,
      setTimeout(() => {
        lateTriageTimers.delete(meetingId);
        void runTriage(meetingId, { final: true });
      }, 5_000)
    );
  }

  async function refreshList() {
    const seq = metaEventCounter;
    try {
      const fetched = await invoke<MeetingMeta[]>('meeting_list');
      update((s) => {
        // Status events that arrived during the call are newer than the list.
        const byId = new Map(s.list.map((m) => [m.id, m]));
        const list = fetched.map((m) =>
          isStaleSnapshot(m.id, seq) ? (s.runtimes[m.id]?.meta ?? byId.get(m.id) ?? m) : m
        );
        for (const m of s.list) {
          if (!list.some((x) => x.id === m.id) && isStaleSnapshot(m.id, seq)) list.push(m);
        }
        list.sort((a, b) => b.started_at - a.started_at);
        return { ...s, list, listLoaded: true };
      });
      for (const meta of fetched) {
        if (state().runtimes[meta.id] && !isStaleSnapshot(meta.id, seq)) ensureRuntime(meta);
      }
      void recoverPostProcessing();
    } catch (error) {
      console.error('[meetings] Failed to list meetings:', error);
      update((s) => ({ ...s, listLoaded: true }));
    }
  }

  /** Load a meeting's transcript + items (idempotent unless `force`). */
  async function ensureLoaded(id: string, force = false) {
    const rt = runtime(id);
    if (rt && rt.transcript !== null && rt.itemsLoaded && !rt.itemsLoadError && !force) return;
    const seq = metaEventCounter;
    transcriptLoads.set(id, (transcriptLoads.get(id) ?? 0) + 1);
    let loaded: { meta: MeetingMeta; transcript: TranscriptLine[] };
    try {
      loaded = await invoke<{ meta: MeetingMeta; transcript: TranscriptLine[] }>('meeting_get', { id });
    } catch (error) {
      console.error('[meetings] Failed to load meeting', id, error);
      endTranscriptLoad(id);
      return;
    }
    // Merge: disk snapshot, plus anything only in memory, plus lines that
    // arrived while the call was in flight (see `mergeLine`).
    const map = new Map(loaded.transcript.map((l) => [l.seg_id, l]));
    for (const l of runtime(id)?.transcript ?? []) if (!map.has(l.seg_id)) map.set(l.seg_id, l);
    for (const l of bufferedLines.get(id)?.values() ?? []) mergeLine(map, l);
    endTranscriptLoad(id);

    if (!isStaleSnapshot(id, seq)) {
      ensureRuntime(loaded.meta);
      upsertListMeta(loaded.meta);
    } else if (!runtime(id)) {
      ensureRuntime(loaded.meta);
    }
    patchRuntime(id, { transcript: [...map.values()].sort((a, b) => a.t0 - b.t0) });
    // Items in memory are authoritative once loaded (a forced reload only
    // refreshes the transcript, so in-flight item edits aren't clobbered).
    const after = runtime(id);
    if (!after?.itemsLoaded || after.itemsLoadError) await loadItems(id);
  }

  function endTranscriptLoad(id: string) {
    const n = (transcriptLoads.get(id) ?? 1) - 1;
    if (n <= 0) {
      transcriptLoads.delete(id);
      bufferedLines.delete(id);
    } else {
      transcriptLoads.set(id, n);
    }
  }

  async function loadItems(id: string) {
    try {
      const raw = await invoke<unknown>('meeting_get_items', { id });
      let file: Partial<MeetingItemsFile> = {};
      if (Array.isArray(raw)) file = { items: raw as MeetingItem[] };
      else if (raw && typeof raw === 'object') file = raw as Partial<MeetingItemsFile>;
      patchRuntime(id, {
        items: (file.items ?? []).map((item) => ({
          ...item,
          occurrences: item.occurrences ?? [],
          pile_item_id: item.pile_item_id ?? null,
          journal_item_id: item.journal_item_id ?? null,
        })),
        itemsLoaded: true,
        itemsLoadError: null,
        triagedSegIds: file.triaged_seg_ids ?? [],
        lastTriageAt: file.last_triage_at ?? null,
        consolidatedAt: file.consolidated_at ?? null,
      });
    } catch (error) {
      console.error('[meetings] Failed to load meeting items', id, error);
      // Keep itemsLoaded (the UI isn't stuck "loading") but flag the failure:
      // saves stay blocked so the empty state never overwrites items.json.
      patchRuntime(id, { itemsLoaded: true, itemsLoadError: errorMessage(error) });
    }
  }

  /** Retry a failed items.json load (UI "Retry" on the load-error banner). */
  async function retryLoadItems(id: string) {
    await loadItems(id);
  }

  async function writeItems(id: string) {
    const rt = runtime(id);
    if (!rt || !rt.itemsLoaded || rt.itemsLoadError) return;
    const file: MeetingItemsFile = {
      version: 1,
      items: rt.items,
      triaged_seg_ids: rt.triagedSegIds,
      last_triage_at: rt.lastTriageAt,
      consolidated_at: rt.consolidatedAt,
    };
    try {
      await invoke('meeting_save_items', { id, items: file });
    } catch (error) {
      console.error('[meetings] Failed to save meeting items', id, error);
    }
  }

  /**
   * Save items.json. Serialized per meeting: at most one write in flight;
   * requests made meanwhile coalesce into one follow-up write that reads the
   * latest state when it runs. Resolves once a write covering the state at
   * call time has finished.
   */
  function persistItems(id: string): Promise<void> {
    let slot = saveSlots.get(id);
    if (!slot) {
      slot = { running: null, dirty: false };
      saveSlots.set(id, slot);
    }
    slot.dirty = true;
    if (!slot.running) {
      const s = slot;
      s.running = (async () => {
        try {
          while (s.dirty) {
            s.dirty = false;
            await writeItems(id);
          }
        } finally {
          s.running = null;
        }
      })();
    }
    return slot.running!;
  }

  function setItems(id: string, mutate: (items: MeetingItem[]) => MeetingItem[]) {
    const rt = runtime(id);
    if (!rt) return;
    patchRuntime(id, { items: mutate(rt.items) });
    void persistItems(id);
  }

  // -------------------------------------------------------------------------
  // Lifecycle commands
  // -------------------------------------------------------------------------

  async function start(opts: MeetingStartOptions): Promise<MeetingMeta | null> {
    if (state().activeId) return runtime(state().activeId!)?.meta ?? null;
    update((s) => ({ ...s, starting: true, startError: null }));
    const seq = metaEventCounter;
    try {
      const meta = await invoke<MeetingMeta>('meeting_start', { opts });
      // A status event may have created the runtime first (without a
      // transcript) — keep its (newer) meta, just mark it fresh.
      const created = runtime(meta.id);
      if (!created) ensureRuntime(meta, { freshTranscript: true });
      else if (created.transcript === null) {
        patchRuntime(meta.id, { transcript: [], itemsLoaded: true, itemsLoadError: null });
      }
      update((s) => ({ ...s, selectedId: meta.id }));
      applyMeta(meta, { commandSeq: seq });
      void persistItems(meta.id);
      return meta;
    } catch (error) {
      console.error('[meetings] Failed to start meeting:', error);
      update((s) => ({ ...s, startError: errorMessage(error) }));
      return null;
    } finally {
      update((s) => ({ ...s, starting: false }));
    }
  }

  /** Defaults for a quick start (hotkey): active repo or auto-repo per settings. */
  function defaultStartOptions(): MeetingStartOptions {
    const cfg = meetingConfig();
    const repo = get(activeRepo);
    const autoRepo = cfg.default_auto_repo || !repo;
    return {
      title: null,
      repo_id: autoRepo ? null : (repo?.id ?? null),
      auto_repo: autoRepo,
      context: null,
      vocabulary: !autoRepo && repo?.vocabulary?.length ? repo.vocabulary : null,
    };
  }

  async function stop(id?: string) {
    const target = id ?? state().activeId;
    if (!target) return;
    postProcessPending.add(target);
    const seq = metaEventCounter;
    try {
      const meta = await invoke<MeetingMeta>('meeting_stop', { id: target });
      applyMeta(meta, { commandSeq: seq });
    } catch (error) {
      console.error('[meetings] Failed to stop meeting:', error);
      pushError(target, `Stop failed: ${errorMessage(error)}`, null);
    }
  }

  async function pause(id?: string) {
    const target = id ?? state().activeId;
    if (!target) return;
    const seq = metaEventCounter;
    try {
      applyMeta(await invoke<MeetingMeta>('meeting_pause', { id: target }), { commandSeq: seq });
    } catch (error) {
      pushError(target, `Pause failed: ${errorMessage(error)}`, null);
    }
  }

  async function resume(id?: string) {
    const target = id ?? state().activeId;
    if (!target) return;
    const seq = metaEventCounter;
    try {
      applyMeta(await invoke<MeetingMeta>('meeting_resume', { id: target }), { commandSeq: seq });
    } catch (error) {
      pushError(target, `Resume failed: ${errorMessage(error)}`, null);
    }
  }

  /** Finalize an interrupted meeting: transcribe leftovers, then triage + consolidate. */
  async function finalize(id: string) {
    postProcessPending.add(id);
    const seq = metaEventCounter;
    try {
      const meta = await invoke<MeetingMeta>('meeting_finalize', { id });
      applyMeta(meta, { commandSeq: seq, allowRevive: true });
    } catch (error) {
      postProcessPending.delete(id);
      pushError(id, `Finalize failed: ${errorMessage(error)}`, null);
    }
  }

  async function remove(id: string): Promise<boolean> {
    try {
      await invoke('meeting_delete', { id });
      const timer = lateTriageTimers.get(id);
      if (timer) clearTimeout(timer);
      lateTriageTimers.delete(id);
      saveSlots.delete(id);
      update((s) => {
        const { [id]: _removed, ...runtimes } = s.runtimes;
        return {
          ...s,
          list: s.list.filter((m) => m.id !== id),
          runtimes,
          selectedId: s.selectedId === id ? null : s.selectedId,
        };
      });
      return true;
    } catch (error) {
      pushError(id, `Delete failed: ${errorMessage(error)}`, null);
      return false;
    }
  }

  async function updateMeta(id: string, patch: { title?: string; summary?: string; repo_id?: string | null; context?: string | null }) {
    const seq = metaEventCounter;
    try {
      applyMeta(await invoke<MeetingMeta>('meeting_update', { id, patch }), { commandSeq: seq });
    } catch (error) {
      pushError(id, `Update failed: ${errorMessage(error)}`, null);
    }
  }

  async function retrySegment(id: string, segId: string) {
    try {
      await invoke('meeting_retry_segment', { id, segId, seg_id: segId });
      const rt = runtime(id);
      if (rt?.transcript) {
        patchRuntime(id, {
          transcript: rt.transcript.map((l) =>
            l.seg_id === segId ? { ...l, status: 'pending', error: null } : l
          ),
        });
      }
    } catch (error) {
      pushError(id, `Retry failed: ${errorMessage(error)}`, segId);
    }
  }

  function pushError(meetingId: string, message: string, segId: string | null) {
    update((s) => ({
      ...s,
      errors: [{ meeting_id: meetingId, message, seg_id: segId, at: Date.now() }, ...s.errors].slice(0, 30),
    }));
  }

  function clearErrors(meetingId: string) {
    update((s) => ({ ...s, errors: s.errors.filter((e) => e.meeting_id !== meetingId) }));
  }

  /**
   * Hotkey toggle. Stopping is always allowed; starting requires the
   * first-use consent notice to have been acknowledged — otherwise the
   * Meeting view opens so the user sees it (meetings never start silently).
   */
  async function toggleFromHotkey() {
    const activeId = state().activeId;
    if (activeId) {
      const status = runtime(activeId)?.meta.status;
      if (status === 'recording' || status === 'paused') await stop(activeId);
      return;
    }
    if (!get(meetingConsentAcknowledged)) {
      openHome();
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        await win.show();
        await win.setFocus();
      } catch {
        /* ignore */
      }
      return;
    }
    await start(defaultStartOptions());
  }

  // -------------------------------------------------------------------------
  // Navigation helpers
  // -------------------------------------------------------------------------

  /** The Meeting view lives on the main page; leave other routes (settings, usage…). */
  function ensureMainRoute() {
    if (typeof window !== 'undefined' && window.location.pathname !== '/') {
      void import('$app/navigation').then(({ goto }) => goto('/'));
    }
  }

  function openHome() {
    update((s) => ({ ...s, selectedId: s.activeId ?? null }));
    navigation.showMeeting();
    ensureMainRoute();
  }

  function openMeeting(id: string | null) {
    update((s) => ({ ...s, selectedId: id }));
    navigation.showMeeting();
    ensureMainRoute();
    if (id) void ensureLoaded(id);
  }

  // -------------------------------------------------------------------------
  // Triage
  // -------------------------------------------------------------------------

  function nextTriageAt(id: string): number | null {
    const rt = runtime(id);
    if (!rt) return null;
    const intervalMs = Math.max(1, meetingConfig().triage_interval_minutes || 3) * 60_000;
    return (rt.lastTriageAt ?? rt.meta.started_at) + intervalMs;
  }

  function hasUntriagedLines(rt: MeetingRuntime): boolean {
    if (!rt.transcript) return false;
    const triaged = new Set(rt.triagedSegIds);
    return rt.transcript.some((l) => l.status === 'ok' && l.text.trim() && !triaged.has(l.seg_id));
  }

  function buildJournalContext(meta: MeetingMeta, items: MeetingItem[]) {
    const linked = new Set(items.map((i) => i.journal_item_id).filter(Boolean) as string[]);
    const candidates = journal.openItemsForRepo(meta.auto_repo ? null : meta.repo_id);
    const ids = new Set(candidates.map((j) => j.id));
    // Journal items this meeting already produced always stay addressable.
    for (const jid of linked) {
      if (!ids.has(jid)) {
        const j = journal.getItem(jid);
        if (j && j.status === 'open') candidates.push(j);
      }
    }
    return candidates.map((j) => ({ id: `j:${j.id}`, category: j.category, title: j.title }));
  }

  function reposContext(meta: MeetingMeta) {
    if (!meta.auto_repo) return null;
    return get(repos)
      .list.filter(isRepoActive)
      .map((r) => ({ id: r.id ?? '', name: r.name, description: r.description ?? '' }))
      .filter((r) => r.id);
  }

  function meetingContextText(meta: MeetingMeta): string | null {
    const parts: string[] = [];
    if (meta.title) parts.push(`Meeting: ${meta.title}`);
    if (!meta.auto_repo && meta.repo_id) {
      const repo = findRepoById(get(repos).list, meta.repo_id);
      if (repo) parts.push(`Repository: ${repo.name}${repo.description ? ` — ${repo.description}` : ''}`);
    }
    if (meta.context?.trim()) parts.push(meta.context.trim());
    return parts.length ? parts.join('\n') : null;
  }

  /**
   * Triage all transcript lines not yet sent (plus ~30 s of already-triaged
   * context before each chunk). `final` runs even if the interval hasn't
   * elapsed (used after the meeting is done).
   */
  async function runTriage(id: string, opts: { final?: boolean } = {}): Promise<number> {
    const inFlight = triageInFlight.get(id);
    if (inFlight) {
      // A rolling triage just skips; a final pass waits for it, then triages
      // whatever it didn't cover (e.g. the closing lines of the meeting).
      if (!opts.final) return 0;
      const done = await inFlight.catch(() => 0);
      return done + (await runTriage(id, opts));
    }
    const p = doTriage(id, opts);
    triageInFlight.set(id, p);
    try {
      return await p;
    } finally {
      if (triageInFlight.get(id) === p) triageInFlight.delete(id);
    }
  }

  /** Triage body; returns the number of transcript lines triaged. */
  async function doTriage(id: string, opts: { final?: boolean }): Promise<number> {
    await ensureLoaded(id);
    let rt = runtime(id);
    if (!rt || !rt.transcript) return 0;
    if (rt.itemsLoadError) return 0; // results couldn't be saved
    const triaged = new Set(rt.triagedSegIds);
    const okLines = rt.transcript
      .filter((l) => l.status === 'ok' && l.text.trim())
      .sort((a, b) => a.t0 - b.t0);
    const fresh = okLines.filter((l) => !triaged.has(l.seg_id));
    if (fresh.length === 0) {
      patchRuntime(id, { lastTriageAt: Date.now() });
      return 0;
    }

    patchRuntime(id, { triageRunning: true, triageError: null });
    let triagedCount = 0;
    try {
      // Chunk fresh lines by character budget.
      const chunks: TranscriptLine[][] = [];
      let current: TranscriptLine[] = [];
      let size = 0;
      for (const line of fresh) {
        const len = line.text.length + 24;
        if (current.length > 0 && size + len > TRIAGE_CHUNK_CHARS) {
          chunks.push(current);
          current = [];
          size = 0;
        }
        current.push(line);
        size += len;
      }
      if (current.length) chunks.push(current);

      for (const chunk of chunks) {
        rt = runtime(id)!;
        const chunkStart = chunk[0].t0;
        const chunkIds = new Set(chunk.map((l) => l.seg_id));
        const doneIds = new Set(rt.triagedSegIds);
        const context = okLines.filter(
          (l) =>
            !chunkIds.has(l.seg_id) &&
            doneIds.has(l.seg_id) &&
            l.t1 > chunkStart - TRIAGE_OVERLAP_SECS &&
            l.t0 < chunkStart
        );
        const windowLines = [...context, ...chunk].sort((a, b) => a.t0 - b.t0);
        const meta = rt.meta;
        const openItems = rt.items.filter((i) => i.status !== 'dismissed' && i.status !== 'journaled');
        const request = {
          transcript: formatTranscriptLines(windowLines),
          items: openItems.map((i) => ({ id: i.id, category: i.category, title: i.title })),
          journal_items: buildJournalContext(meta, rt.items),
          repos: reposContext(meta),
          context: meetingContextText(meta),
        };
        const result = await invoke<MeetingTriageResult>('meeting_triage', { request });
        applyTriageOps(id, result?.ops ?? [], rt.transcript ?? []);
        const after = runtime(id)!;
        patchRuntime(id, {
          triagedSegIds: [...new Set([...after.triagedSegIds, ...chunkIds])],
        });
        triagedCount += chunk.length;
        await persistItems(id);
      }
      patchRuntime(id, { lastTriageAt: Date.now() });
      await persistItems(id);
      console.log(`[meetings] Triage done for ${id} (${fresh.length} lines${opts.final ? ', final' : ''})`);
    } catch (error) {
      console.error('[meetings] Triage failed:', error);
      // Don't hot-loop on a failing LLM: wait a full interval before retrying.
      patchRuntime(id, { triageError: errorMessage(error), lastTriageAt: Date.now() });
    } finally {
      patchRuntime(id, { triageRunning: false });
    }
    return triagedCount;
  }

  function applyTriageOps(meetingId: string, ops: TriageOp[], lines: TranscriptLine[]) {
    const rt = runtime(meetingId);
    if (!rt) return;
    const meta = rt.meta;
    const cfg = meetingConfig();
    const repoList = get(repos).list;
    let items = [...rt.items];
    const toAutoPile: string[] = [];
    const now = Date.now();

    for (const op of ops) {
      if (!op || (op.op !== 'new' && op.op !== 'update')) continue;
      const occ = locateMention(op.quote ?? '', parseMeetingTime(op.t0), lines);

      if (op.op === 'update' && op.id) {
        if (op.id.startsWith('j:')) {
          const jid = op.id.slice(2);
          if (journal.getItem(jid)) {
            journal.addOccurrence(jid, toJournalOccurrence(meetingId, occ), op.detail);
            // Mirror the sighting onto this meeting's item linked to it, if any.
            items = items.map((i) =>
              i.journal_item_id === jid
                ? { ...i, occurrences: addOccurrenceDeduped(i.occurrences, occ), updated_at: now }
                : i
            );
            continue;
          }
        } else {
          const idx = items.findIndex((i) => i.id === op.id);
          if (idx >= 0) {
            const existing = items[idx];
            items[idx] = {
              ...existing,
              // Never clobber a user-edited detail; just add the sighting.
              detail: op.detail?.trim() && !existing.edited ? op.detail : existing.detail,
              occurrences: addOccurrenceDeduped(existing.occurrences, occ),
              updated_at: now,
            };
            if (existing.journal_item_id) {
              journal.addOccurrence(existing.journal_item_id, toJournalOccurrence(meetingId, occ), op.detail);
            }
            continue;
          }
        }
        // Unknown id: fall through and treat it as new when it carries enough.
      }

      const category = normalizeCategory(op.category);
      const title = op.title?.trim();
      if (!category || !title) continue;

      let repoId: string | null = meta.repo_id;
      if (meta.auto_repo) {
        repoId = op.repo_id && findRepoById(repoList, op.repo_id) ? op.repo_id : null;
      }

      const item: MeetingItem = {
        id: `itm_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        category,
        title,
        detail: op.detail?.trim() ?? '',
        complexity: typeof op.complexity === 'number' ? op.complexity : null,
        confidence: typeof op.confidence === 'number' ? op.confidence : null,
        repo_id: repoId,
        occurrences: [occ],
        status: 'new',
        pile_item_id: null,
        journal_item_id: null,
        created_at: now,
        updated_at: now,
      };

      if (isActionableCategory(category)) {
        if (cfg.auto_pile && (item.confidence ?? 0) >= cfg.auto_pile_min_confidence) {
          toAutoPile.push(item.id);
        }
      } else {
        const j = journal.add({
          category: toJournalCategory(category),
          title: item.title,
          detail: item.detail,
          repoId: repoId ?? undefined,
          occurrences: [toJournalOccurrence(meetingId, occ)],
          meetingItemId: item.id,
        });
        item.status = 'journaled';
        item.journal_item_id = j.id;
      }
      items.push(item);
    }

    patchRuntime(meetingId, { items });
    if (toAutoPile.length) sendToPile(meetingId, toAutoPile);
  }

  // -------------------------------------------------------------------------
  // Consolidation
  // -------------------------------------------------------------------------

  async function consolidate(id: string) {
    await ensureLoaded(id);
    const rt = runtime(id);
    if (!rt || rt.consolidating || !rt.transcript || rt.itemsLoadError) return;
    const okLines = rt.transcript.filter((l) => l.status === 'ok' && l.text.trim());
    if (okLines.length === 0) {
      // Nothing to consolidate — record it so launch recovery doesn't retry.
      if (rt.meta.status === 'done' && !rt.consolidatedAt) {
        patchRuntime(id, { consolidatedAt: Date.now() });
        await persistItems(id);
      }
      return;
    }

    patchRuntime(id, { consolidating: true, consolidateError: null });
    try {
      const request = {
        transcript: formatTranscriptLines(okLines),
        items: rt.items
          .filter((i) => i.status !== 'dismissed')
          .map((i) => ({
            id: i.id,
            category: i.category,
            title: i.title,
            detail: i.detail,
            sightings: i.occurrences.length,
          })),
        context: meetingContextText(rt.meta),
      };
      const result = await invoke<MeetingConsolidateResult>('meeting_consolidate', { request });
      applyConsolidation(id, result);
      if (result?.summary?.trim()) {
        await updateMeta(id, { summary: result.summary });
      }
      patchRuntime(id, { consolidatedAt: Date.now() });
      await persistItems(id);
    } catch (error) {
      console.error('[meetings] Consolidation failed:', error);
      patchRuntime(id, { consolidateError: errorMessage(error) });
    } finally {
      patchRuntime(id, { consolidating: false });
    }
  }

  function applyConsolidation(meetingId: string, result: MeetingConsolidateResult) {
    const rt = runtime(meetingId);
    if (!rt || !result) return;
    let items = [...rt.items];
    const now = Date.now();
    const byId = (iid: string) => items.findIndex((i) => i.id === iid);

    for (const merge of result.merges ?? []) {
      const keepIdx = byId(merge.keep_id);
      if (keepIdx < 0 || items[keepIdx].status === 'dismissed') continue;
      for (const mid of merge.merge_ids ?? []) {
        if (mid === merge.keep_id) continue;
        const mIdx = byId(mid);
        if (mIdx < 0) continue;
        const merged = items[mIdx];
        // A piled item already left the review list — never fold it away.
        if (merged.status === 'piled' || merged.status === 'dismissed') continue;
        const keep = items[keepIdx];
        let occurrences = keep.occurrences;
        for (const occ of merged.occurrences) occurrences = addOccurrenceDeduped(occurrences, occ);
        items[keepIdx] = { ...keep, occurrences, updated_at: now };
        if (keep.journal_item_id) {
          for (const occ of merged.occurrences) {
            journal.addOccurrence(keep.journal_item_id, toJournalOccurrence(meetingId, occ));
          }
        }
        // Retire a journal item that only this meeting item produced.
        if (merged.journal_item_id && merged.journal_item_id !== keep.journal_item_id) {
          const j = journal.getItem(merged.journal_item_id);
          if (j && j.meetingItemId === merged.id && j.occurrences.every((o) => o.meetingId === meetingId)) {
            journal.setStatus(j.id, 'dismissed');
          }
        }
        items[mIdx] = { ...merged, status: 'dismissed', merged_into: keep.id, updated_at: now };
      }
    }

    for (const upd of result.updates ?? []) {
      const idx = byId(upd.id);
      if (idx < 0) continue;
      const item = items[idx];
      const category = normalizeCategory(upd.category) ?? item.category;
      // User-edited title/detail are kept; the category may still be refined.
      items[idx] = {
        ...item,
        title: item.edited ? item.title : upd.title?.trim() || item.title,
        detail: item.edited ? item.detail : upd.detail?.trim() || item.detail,
        category,
        updated_at: now,
      };
      if (item.journal_item_id) {
        const j = journal.getItem(item.journal_item_id);
        if (j && j.meetingItemId === item.id) {
          journal.updateItemIfUnedited(j.id, {
            title: items[idx].title,
            detail: items[idx].detail,
            ...(isActionableCategory(category) ? {} : { category: toJournalCategory(category) }),
          });
        }
      }
    }

    patchRuntime(meetingId, { items });
  }

  /** Final triage pass + consolidation after the meeting reached `done`. */
  async function postProcess(id: string) {
    if (postProcessRunning.has(id)) return;
    postProcessRunning.add(id);
    const timer = lateTriageTimers.get(id);
    if (timer) {
      clearTimeout(timer); // the final triage below covers it
      lateTriageTimers.delete(id);
    }
    try {
      await ensureLoaded(id, true);
      // Final pass: waits for an in-flight rolling triage, then triages the
      // remaining (closing) lines — consolidation must see all of them.
      const triaged = await runTriage(id, { final: true });
      const rt = runtime(id);
      // Re-consolidate only when something changed (launch recovery may
      // re-run this for an already-consolidated meeting).
      if (rt && (!rt.consolidatedAt || triaged > 0)) await consolidate(id);
    } finally {
      postProcessRunning.delete(id);
    }
  }

  /**
   * Post-processing is only tracked in memory, so a quit/reload between
   * `done` and consolidation would lose it. Once per app run, check each
   * `done` meeting and run `postProcess` if it was never consolidated or has
   * ok lines that were never triaged. Sequential, to keep the LLM load low.
   */
  async function recoverPostProcessing() {
    for (const meta of state().list) {
      if (meta.status !== 'done' || recoveryChecked.has(meta.id)) continue;
      recoveryChecked.add(meta.id);
      if (postProcessRunning.has(meta.id)) continue;
      try {
        if (!runtime(meta.id)) ensureRuntime(meta);
        let rt = runtime(meta.id);
        if (rt && (!rt.itemsLoaded || rt.itemsLoadError)) await loadItems(meta.id);
        rt = runtime(meta.id);
        if (!rt || rt.itemsLoadError) continue;
        // Cheap pre-check before loading the transcript: ok segments on disk
        // vs segments recorded as triaged (empty-text lines are never
        // triaged, so this over-approximates; postProcess is a no-op then).
        const okSegments = Math.max(0, meta.segment_count - meta.pending_segments - meta.failed_segments);
        const maybeUntriaged = rt.triagedSegIds.length < okSegments;
        if (!rt.consolidatedAt || maybeUntriaged) {
          await ensureLoaded(meta.id);
          const loaded = runtime(meta.id);
          if (loaded && (!loaded.consolidatedAt || hasUntriagedLines(loaded))) {
            console.log('[meetings] Resuming post-processing for', meta.id);
            await postProcess(meta.id);
          }
        }
      } catch (error) {
        console.error('[meetings] Post-processing recovery failed for', meta.id, error);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Item actions
  // -------------------------------------------------------------------------

  function buildPilePrompt(item: MeetingItem): string {
    const quotes = item.occurrences
      .slice(0, 5)
      .map((o) => `> ${o.quote} — ${speakerLabel(o.speaker)} @ ${formatMeetingTime(o.t0)}`)
      .join('\n');
    return [
      item.title,
      item.detail,
      item.occurrences.length
        ? `From a meeting (${item.category}, mentioned ${item.occurrences.length}×):\n${quotes}`
        : '',
    ]
      .filter((p) => p && p.trim())
      .join('\n\n');
  }

  function tierFor(complexity: number | null): { model?: string; effortLevel?: EffortLevel; reasoning?: string } {
    if (complexity == null) return {};
    try {
      const resolved = resolveTier(complexity, get(settings));
      return {
        model: resolved.model,
        effortLevel: resolved.effort ?? null,
        reasoning: `Auto · complexity ${complexity} (meeting triage)`,
      };
    } catch (error) {
      console.error('[meetings] resolveTier failed:', error);
      return {};
    }
  }

  function sendToPile(meetingId: string, itemIds: string[]) {
    const rt = runtime(meetingId);
    if (!rt) return;
    const now = Date.now();
    const created = new Map<string, string>();
    for (const iid of itemIds) {
      const item = rt.items.find((i) => i.id === iid);
      if (!item || item.status === 'piled') continue;
      const first = item.occurrences[0];
      const tier = tierFor(item.complexity);
      // Fixed-repo meetings pin every item to the meeting's repo; auto-repo
      // meetings use triage's pick or leave it empty (never the active repo).
      const repoId = item.repo_id ?? (rt.meta.auto_repo ? null : rt.meta.repo_id);
      const pileId = pile.addTextItem({
        transcript: buildPilePrompt(item),
        title: item.title,
        category: item.category,
        repoId: repoId ?? undefined,
        repoReasoning: repoId ? 'From meeting' : undefined,
        model: tier.model,
        effortLevel: tier.effortLevel,
        modelReasoning: tier.reasoning,
        source: {
          kind: 'meeting',
          meeting_id: meetingId,
          item_id: item.id,
          quote: first?.quote ?? '',
          t0: first?.t0 ?? 0,
          t1: first?.t1 ?? 0,
          seg_id: first?.seg_id ?? undefined,
          speaker: first?.speaker,
        },
      });
      created.set(iid, pileId);
    }
    if (created.size === 0) return;
    setItems(meetingId, (items) =>
      items.map((i) =>
        created.has(i.id) ? { ...i, status: 'piled', pile_item_id: created.get(i.id)!, updated_at: now } : i
      )
    );
  }

  function sendToJournal(meetingId: string, itemIds: string[]) {
    const rt = runtime(meetingId);
    if (!rt) return;
    const now = Date.now();
    const linked = new Map<string, string>();
    for (const iid of itemIds) {
      const item = rt.items.find((i) => i.id === iid);
      if (!item || item.status === 'journaled') continue;
      let jid = item.journal_item_id;
      if (jid && journal.getItem(jid)) {
        journal.setStatus(jid, 'open');
      } else {
        jid = journal.add({
          category: toJournalCategory(item.category),
          title: item.title,
          detail: item.detail,
          repoId: item.repo_id ?? undefined,
          occurrences: item.occurrences.map((o) => toJournalOccurrence(meetingId, o)),
          meetingItemId: item.id,
        }).id;
      }
      linked.set(iid, jid);
    }
    setItems(meetingId, (items) =>
      items.map((i) =>
        linked.has(i.id)
          ? { ...i, status: 'journaled', journal_item_id: linked.get(i.id)!, updated_at: now }
          : i
      )
    );
  }

  function setItemStatus(meetingId: string, itemIds: string[], status: 'new' | 'dismissed') {
    const ids = new Set(itemIds);
    const now = Date.now();
    setItems(meetingId, (items) =>
      items.map((i) => (ids.has(i.id) ? { ...i, status, updated_at: now } : i))
    );
  }

  function editItem(
    meetingId: string,
    itemId: string,
    patch: Partial<Pick<MeetingItem, 'title' | 'detail' | 'category' | 'repo_id' | 'complexity'>>
  ) {
    const now = Date.now();
    setItems(meetingId, (items) =>
      items.map((i) => {
        if (i.id !== itemId) return i;
        // A real title/detail change marks the item user-edited: triage
        // updates and consolidation then leave those fields alone.
        const edited =
          i.edited ||
          (patch.title !== undefined && patch.title !== i.title) ||
          (patch.detail !== undefined && patch.detail !== i.detail);
        return { ...i, ...patch, ...(edited ? { edited: true } : {}), updated_at: now };
      })
    );
  }

  // -------------------------------------------------------------------------
  // Clips
  // -------------------------------------------------------------------------

  /** Read a segment WAV as a playable blob URL (caller revokes). */
  async function readClipUrl(meetingId: string, segId: string): Promise<string | null> {
    try {
      const raw = await invoke<number[] | ArrayBuffer | Uint8Array>('meeting_read_segment_audio', {
        id: meetingId,
        segId,
        seg_id: segId,
      });
      const bytes =
        raw instanceof Uint8Array
          ? raw
          : raw instanceof ArrayBuffer
            ? new Uint8Array(raw)
            : new Uint8Array(raw as number[]);
      return URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/wav' }));
    } catch (error) {
      console.error('[meetings] Failed to read segment audio:', error);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Driver
  // -------------------------------------------------------------------------

  function tick() {
    const s = state();
    // Live meeting: rolling triage on the interval.
    if (s.activeId) {
      const rt = s.runtimes[s.activeId];
      if (rt && (rt.meta.status === 'recording' || rt.meta.status === 'paused') && !rt.triageRunning) {
        const due = nextTriageAt(rt.meta.id);
        if (due != null && Date.now() >= due && hasUntriagedLines(rt)) {
          void runTriage(rt.meta.id);
        }
      }
    }
  }

  /** Start listeners + the triage driver. Call once from the main layout. */
  function startMeetings(): () => void {
    const unlisteners: Promise<UnlistenFn>[] = [
      listen<MeetingMeta>('meeting-status', (e) => applyMeta(e.payload)),
      listen<{ meeting_id: string; line: TranscriptLine }>('meeting-transcript', (e) =>
        applyTranscriptLine(e.payload.meeting_id, e.payload.line)
      ),
      listen<{ meeting_id: string; mic: number; system: number }>('meeting-level', (e) => {
        if (e.payload.meeting_id !== state().activeId) return;
        update((s) => ({ ...s, level: { mic: e.payload.mic, system: e.payload.system } }));
      }),
      listen<{ meeting_id: string; message: string; seg_id: string | null }>('meeting-error', (e) =>
        pushError(e.payload.meeting_id, e.payload.message, e.payload.seg_id ?? null)
      ),
      // Overlay indicator buttons (emitted from the overlay window)
      listen('meeting-overlay-stop', () => void stop()),
      listen('meeting-overlay-open', async () => {
        openHome();
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const win = getCurrentWindow();
          await win.show();
          await win.unminimize();
          await win.setFocus();
        } catch {
          /* ignore */
        }
      }),
    ];

    void (async () => {
      await refreshList();
      try {
        const seq = metaEventCounter;
        const active = await invoke<MeetingMeta | null>('meeting_active');
        if (active) {
          applyMeta(active, { commandSeq: seq });
          await ensureLoaded(active.id, true);
        }
      } catch (error) {
        console.error('[meetings] Failed to query active meeting:', error);
      }
    })();

    const timer = setInterval(tick, TRIAGE_TICK_MS);
    // Keep the overlay's paused/recording state honest if dictation toggled it.
    const unsubRecording = isRecording.subscribe(() => {
      lastOverlayKey = '';
      if (state().activeId) syncOverlay();
    });

    return () => {
      clearInterval(timer);
      unsubRecording();
      for (const p of unlisteners) p.then((fn) => fn()).catch(() => {});
    };
  }

  return {
    subscribe,
    startMeetings,
    refreshList,
    ensureLoaded,
    retryLoadItems,
    start,
    defaultStartOptions,
    stop,
    pause,
    resume,
    finalize,
    remove,
    updateMeta,
    retrySegment,
    clearErrors,
    toggleFromHotkey,
    openHome,
    openMeeting,
    nextTriageAt,
    runTriage,
    consolidate,
    sendToPile,
    sendToJournal,
    dismiss: (meetingId: string, itemIds: string[]) => setItemStatus(meetingId, itemIds, 'dismissed'),
    restore: (meetingId: string, itemIds: string[]) => setItemStatus(meetingId, itemIds, 'new'),
    editItem,
    readClipUrl,
    tierFor,
  };
}

export const meetings = createMeetingsStore();

/** The live meeting (recording / paused / finalizing), if any. */
export const activeMeeting = derived(meetings, ($m) =>
  $m.activeId ? ($m.runtimes[$m.activeId]?.meta ?? null) : null
);

/**
 * True while a meeting is capturing audio (recording or paused). Gates open
 * mic (see `useOpenMic`) — wake words must never run on meeting speech.
 */
export const isMeetingActive = derived(
  activeMeeting,
  ($a) => !!$a && ($a.status === 'recording' || $a.status === 'paused')
);

export const MEETING_CATEGORY_STYLE: Record<MeetingItemCategory, { label: string; cls: string }> = {
  bug: { label: 'Bug', cls: 'bg-red-500/15 text-red-400' },
  task: { label: 'Task', cls: 'bg-emerald-500/15 text-emerald-400' },
  investigate: { label: 'Investigate', cls: 'bg-amber-500/15 text-amber-400' },
  question: { label: 'Question', cls: 'bg-sky-500/15 text-sky-400' },
  feedback: { label: 'Feedback', cls: 'bg-sky-500/15 text-sky-300' },
  idea: { label: 'Idea', cls: 'bg-violet-500/15 text-violet-400' },
  decision: { label: 'Decision', cls: 'bg-emerald-500/15 text-emerald-300' },
  note: { label: 'Note', cls: 'bg-surface text-text-secondary' },
};
