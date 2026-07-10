/**
 * Cockpit voice engine — public surface.
 *
 * The cockpit is the voice-driven fleet-orchestration view
 * (docs/flow-mode-brainstorm-2026-07.md §4.8): mic hot while the view is
 * focused, each utterance parsed by a deterministic grammar and executed
 * against existing stores. Mishears die visibly in the ledger.
 *
 * Typical UI wiring:
 *   import { cockpitController, cockpitMicState, cockpitPartialTranscript,
 *            lastInterpretation, ledger, draft, pendingConfirm,
 *            fleetBriefing, focusedSessionId } from '$lib/cockpit';
 *   onMount(() => { cockpitController.activate(); });
 *   onDestroy(() => { cockpitController.deactivate(); });
 */

// Controller (activate / deactivate / handleUtterance / buildFleetRefs)
export { cockpitController, buildFleetRefs, buildCockpitContext, handleUtterance } from './cockpitController';

// Continuous capture
export {
  cockpitMic,
  cockpitMicState,
  cockpitMicError,
  isCockpitMicListening,
  cockpitPartialTranscript,
  COCKPIT_VOICE_SESSION_ID,
  type CockpitMicState,
} from './cockpitMic';

// Grammar (pure parser + types)
export {
  parseUtterance,
  describeIntent,
  normalizeUtterance,
  wordToNumber,
  type CockpitIntent,
  type CockpitContext,
  type CockpitSessionRef,
  type FocusVia,
} from './commandGrammar';

// State stores + mutators
export {
  cockpitActive,
  focusedSessionId,
  lastInterpretation,
  ledger,
  draft,
  pendingConfirm,
  fleetBriefing,
  dismissedSessionIds,
  appendLedger,
  updateLedger,
  setInterpretation,
  setDraft,
  patchDraftIf,
  clearDraft,
  dismissSessions,
  undismissSession,
  resetTransientState,
  LEDGER_CAP,
  type CockpitInterpretation,
  type LedgerEntry,
  type LedgerStatus,
  type CockpitDraft,
  type CockpitPendingConfirm,
  type FleetBriefing,
  type BriefingBlockedItem,
} from './cockpitStore';

// Executor
export { executeIntent, cancelPendingConfirm, CONFIRM_TIMEOUT_MS } from './intentExecutor';
