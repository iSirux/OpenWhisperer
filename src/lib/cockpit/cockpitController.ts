/**
 * Cockpit controller — the thin orchestrator wiring mic → grammar → executor.
 *
 * UI contract:
 * - `cockpitController.activate()` when the cockpit view gains focus,
 *   `deactivate()` when it loses focus/unmounts. The mic is hot only in
 *   between (no wake words, no always-on).
 * - `buildFleetRefs()` is the single source of truth for board membership,
 *   ordering, and the 1-based board numbers — the UI MUST render cards from
 *   it (or replicate it exactly) so spoken numbers match what's on screen.
 * - While active, the controller watches the `recording` store and suspends /
 *   resumes the cockpit mic around regular recordings automatically; the UI
 *   can also drive `cockpitMic.setSuspended()` directly if it needs to.
 * - `open_session` intents call `sdkSessions.selectSession(id)`; navigating
 *   the window to the session view (if the cockpit is a separate route) is
 *   the UI's job — watch `activeSdkSessionId` while the cockpit is active.
 */

import { get } from 'svelte/store';
import { sdkSessions, type SdkSession } from '$lib/stores/sdkSessions';
import { recording } from '$lib/stores/recording';
import { cockpitMic } from './cockpitMic';
import {
  parseUtterance,
  describeIntent,
  type CockpitContext,
  type CockpitSessionRef,
} from './commandGrammar';
import { executeIntent, cancelPendingConfirm } from './intentExecutor';
import {
  cockpitActive,
  focusedSessionId,
  pendingConfirm,
  draft,
  dismissedSessionIds,
  resetTransientState,
  clearDraft,
} from './cockpitStore';

/** Statuses that appear on the cockpit fleet board. */
const BOARD_STATUSES: ReadonlySet<SdkSession['status']> = new Set([
  'prepared',
  'queued',
  'initializing',
  'idle',
  'querying',
  'done',
  'error',
]);

function lastMessageType(session: SdkSession): string | undefined {
  return session.messages.length > 0
    ? session.messages[session.messages.length - 1].type
    : undefined;
}

function isBlocked(session: SdkSession): boolean {
  return !!(
    session.pendingPlanApproval ||
    session.askUserQuestion ||
    session.aiMetadata?.needsInteraction
  );
}

function isDone(session: SdkSession): boolean {
  if (isBlocked(session)) return false;
  if (session.status === 'done') return true;
  if (session.status === 'idle') {
    const last = lastMessageType(session);
    return last === 'done' || last === 'stopped';
  }
  return false;
}

/**
 * Build the addressable fleet board: sessions in board statuses, minus the
 * dismissed ones, ordered by creation time (ascending) for STABLE 1-based
 * numbering — a session keeps its number for its lifetime on the board.
 */
export function buildFleetRefs(): CockpitSessionRef[] {
  const dismissed = get(dismissedSessionIds);
  const sessions = get(sdkSessions)
    .filter((s) => BOARD_STATUSES.has(s.status) && !dismissed.has(s.id))
    .sort((a, b) => a.createdAt - b.createdAt);

  return sessions.map((s, i) => ({
    id: s.id,
    nickname: s.aiMetadata?.nickname,
    name: s.aiMetadata?.name ?? s.cwd.split(/[\\/]/).pop() ?? s.id,
    index: i + 1,
    status: s.status,
    isBlocked: isBlocked(s),
    isDone: isDone(s),
    hasQuestion: !!s.askUserQuestion,
  }));
}

/** Snapshot the parsing context from current store values. */
export function buildCockpitContext(): CockpitContext {
  const sessions = buildFleetRefs();
  let focused = get(focusedSessionId);
  // Drop a stale focus (session left the board).
  if (focused && !sessions.some((s) => s.id === focused)) {
    focused = null;
    focusedSessionId.set(null);
  }
  return {
    sessions,
    focusedSessionId: focused,
    draftActive: get(draft) !== null,
    pendingConfirm: get(pendingConfirm) !== null,
  };
}

/**
 * Handle one finalized utterance: build context, parse, execute.
 * Exposed for the UI (e.g. a typed fallback input) and for tests.
 */
export async function handleUtterance(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const ctx = buildCockpitContext();
  const intent = parseUtterance(trimmed, ctx);
  console.log('[cockpit] utterance:', trimmed, '→', describeIntent(intent, ctx));
  await executeIntent(intent, ctx, trimmed);
}

let unsubscribeRecording: (() => void) | null = null;
let active = false;

/**
 * Activate the cockpit: mark active, wire the mic to the parser, start
 * continuous capture, and auto-suspend around regular recordings.
 */
async function activate(): Promise<void> {
  if (active) return;
  active = true;
  cockpitActive.set(true);

  cockpitMic.onUtterance((text) => {
    void handleUtterance(text);
  });

  // Yield the mic to regular recordings (hotkey / open-mic-triggered), and
  // reclaim it once the recording ends. `processing` (post-stop transcription)
  // no longer holds the mic, so only 'recording' suspends.
  unsubscribeRecording = recording.subscribe(($recording) => {
    if (!active) return;
    void cockpitMic.setSuspended($recording.state === 'recording');
  });

  await cockpitMic.start();
}

/**
 * Deactivate the cockpit: stop capture, clear transient state (pending
 * confirms + draft), keep the ledger for review. Open mic recovery is owned
 * by the existing layout lifecycle effect.
 */
async function deactivate(): Promise<void> {
  if (!active) return;
  active = false;

  if (unsubscribeRecording) {
    unsubscribeRecording();
    unsubscribeRecording = null;
  }
  cockpitMic.onUtterance(null);
  await cockpitMic.stop();

  cancelPendingConfirm();
  clearDraft();
  resetTransientState();
  cockpitActive.set(false);
}

export const cockpitController = {
  activate,
  deactivate,
  handleUtterance,
  buildFleetRefs,
  buildCockpitContext,
};
