/**
 * Cockpit state stores — plain `svelte/store` primitives shared by the mic,
 * the intent executor, the controller, and (later) the cockpit UI.
 *
 * No side effects beyond store mutation live here; execution logic is in
 * `intentExecutor.ts`, capture in `cockpitMic.ts`.
 */

import { writable, get } from 'svelte/store';
import type { EffortLevel } from '$lib/stores/sdkSessions';
import type { CockpitIntent } from './commandGrammar';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the last utterance was heard as and whether it executed cleanly. */
export interface CockpitInterpretation {
  heard: string;
  intentLabel: string;
  ok: boolean;
  ts: number;
}

export type LedgerStatus = 'ok' | 'rejected' | 'error' | 'pending-confirm' | 'cancelled';

/** One row of the utterance ledger (audit trail; newest first). */
export interface LedgerEntry {
  id: string;
  ts: number;
  /** The raw utterance as heard. */
  heard: string;
  /** Parsed interpretation ("stop → Falcon"). */
  intentLabel: string;
  /** What happened ("query stopped", "didn't catch that", error text…). */
  resultLabel: string;
  status: LedgerStatus;
}

/** A dispatch draft being assembled by voice before launch. */
export interface CockpitDraft {
  /** The (possibly LLM-cleaned) task text that will become the prompt. */
  transcript: string;
  /** Original dictation before cleanup (kept for display/diff). */
  rawTranscript: string;
  /** Selected repo id (voice-set or recommended); undefined = active repo. */
  repoId?: string;
  /** Selected model id; undefined = current default. */
  model?: string;
  /** Selected effort level; undefined = current default. */
  effortLevel?: EffortLevel;
  /** Background enrichment in flight. */
  cleaning: boolean;
  recommendingRepo: boolean;
  recommendingModel: boolean;
  /** Enrichment results as they land (best-effort, informational). */
  wasCleanedUp?: boolean;
  cleanupCorrections?: string[];
  repoRecommendation?: { repoIndex: number; repoName: string; reasoning: string; confidence: string };
  modelRecommendation?: { modelId: string; reasoning: string; effortLevel?: string };
  /** Identity token: enrichment callbacks only apply if the draft is unchanged. */
  createdAt: number;
}

/** A destructive intent parked behind a verbal yes/no with an expiry. */
export interface CockpitPendingConfirm {
  intent: CockpitIntent;
  /** Read-back label shown to the user ("stop → Falcon — say yes to confirm"). */
  label: string;
  expiresAt: number;
  /** Ledger row created for this action; updated in place on resolve/expiry. */
  ledgerId: string;
}

/** One blocked-session line in a fleet briefing. */
export interface BriefingBlockedItem {
  sessionId: string;
  label: string;
  /** Why it's waiting: plan approval, open question, or LLM-detected need. */
  reason: 'plan_approval' | 'question' | 'needs_interaction';
  detail?: string;
}

/** Computed fleet summary exposed for the UI to render (no TTS). */
export interface FleetBriefing {
  kind: 'status' | 'what_needs_me';
  generatedAt: number;
  counts: { running: number; blocked: number; done: number; error: number; total: number };
  blocked: BriefingBlockedItem[];
  /** Recently finished sessions with their one-line outcomes. */
  done: Array<{ sessionId: string; label: string; outcome?: string }>;
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

/** Whether the cockpit view/mode is active (controller sets this). */
export const cockpitActive = writable<boolean>(false);

/** The focus ring — id of the focused session, or null. */
export const focusedSessionId = writable<string | null>(null);

/** Last utterance interpretation (the command-line validity signal). */
export const lastInterpretation = writable<CockpitInterpretation | null>(null);

/** Utterance ledger, newest first, capped at `LEDGER_CAP`. */
export const ledger = writable<LedgerEntry[]>([]);

/** The open dispatch draft, or null. */
export const draft = writable<CockpitDraft | null>(null);

/** Pending destructive-action confirmation, or null. */
export const pendingConfirm = writable<CockpitPendingConfirm | null>(null);

/** Latest computed fleet briefing (status / what-needs-me), or null. */
export const fleetBriefing = writable<FleetBriefing | null>(null);

/**
 * Session ids hidden from the cockpit board by "dismiss the done ones".
 * Cockpit-local (does not touch the sessions store); cleared per-id when a
 * session becomes active again is the UI's call.
 */
export const dismissedSessionIds = writable<Set<string>>(new Set());

// ---------------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------------

export const LEDGER_CAP = 200;

let ledgerCounter = 0;

/** Append a ledger entry (newest first, capped). Returns the entry id. */
export function appendLedger(entry: Omit<LedgerEntry, 'id' | 'ts'> & { ts?: number }): string {
  const id = `led_${Date.now()}_${ledgerCounter++}`;
  const row: LedgerEntry = {
    id,
    ts: entry.ts ?? Date.now(),
    heard: entry.heard,
    intentLabel: entry.intentLabel,
    resultLabel: entry.resultLabel,
    status: entry.status,
  };
  ledger.update((rows) => [row, ...rows].slice(0, LEDGER_CAP));
  return id;
}

/** Patch a ledger entry in place (e.g. pending-confirm → ok/cancelled). */
export function updateLedger(id: string, patch: Partial<Omit<LedgerEntry, 'id'>>): void {
  ledger.update((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
}

/** Record the interpretation of the latest utterance. */
export function setInterpretation(heard: string, intentLabel: string, ok: boolean): void {
  lastInterpretation.set({ heard, intentLabel, ok, ts: Date.now() });
}

/** Replace the dispatch draft (returns it for chaining). */
export function setDraft(next: CockpitDraft | null): CockpitDraft | null {
  draft.set(next);
  return next;
}

/**
 * Patch the current draft only if it is still the same draft instance
 * (identified by `createdAt`) — guards async enrichment against a draft that
 * was cancelled or replaced mid-flight.
 */
export function patchDraftIf(createdAt: number, patch: Partial<CockpitDraft>): boolean {
  const current = get(draft);
  if (!current || current.createdAt !== createdAt) return false;
  draft.set({ ...current, ...patch });
  return true;
}

/** Clear the draft. */
export function clearDraft(): void {
  draft.set(null);
}

/** Add session ids to the dismissed set. */
export function dismissSessions(ids: string[]): void {
  dismissedSessionIds.update((set) => {
    const next = new Set(set);
    for (const id of ids) next.add(id);
    return next;
  });
}

/** Un-dismiss (e.g. when a session becomes active again). */
export function undismissSession(id: string): void {
  dismissedSessionIds.update((set) => {
    if (!set.has(id)) return set;
    const next = new Set(set);
    next.delete(id);
    return next;
  });
}

/** Reset transient cockpit state (used on deactivate; ledger is kept). */
export function resetTransientState(): void {
  pendingConfirm.set(null);
  lastInterpretation.set(null);
  fleetBriefing.set(null);
}
