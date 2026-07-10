import { get } from 'svelte/store';
import { isRecording } from '$lib/stores/recording';

/**
 * Hold-Space-to-record for text inputs.
 *
 * The problem: inside a <textarea>/<input>, Space is a normal character, so we
 * can't start recording on the first keydown without breaking typing. The fix
 * (the same one Claude Code's own voice dictation uses) is to *let the space
 * type*, then retract it once the key turns out to be held:
 *
 *   1. Tap Space  -> a single space is typed (normal typing, untouched).
 *   2. Hold Space -> after a short threshold (or the first OS key-repeat,
 *      whichever comes first) we retract the one leaked space, suppress any
 *      further repeat-spaces, and start recording.
 *   3. Release    -> stop, transcribe, and insert the transcript at the caret.
 *
 * The action is pure gesture + insertion — the caller supplies `start`/`stop`
 * so each prompt input can route to its own recording/transcription pipeline.
 */

export type HoldRecordState = 'idle' | 'warmup' | 'recording' | 'transcribing';

export interface HoldSpaceRecordParams {
  /** Master enable (settings.audio.hold_space_to_record_inline). */
  enabled?: boolean;
  /**
   * Extra guard evaluated on the initial Space press. Return false to treat the
   * Space as normal typing (e.g. while already recording/transcribing elsewhere,
   * or while a query is running). Defaults to allowed.
   */
  canStart?: () => boolean;
  /** Begin recording. Awaited before a release is allowed to stop it. */
  start: () => void | Promise<void>;
  /**
   * Stop recording and transcribe. Return the final text to insert at the caret
   * (already cleaned as appropriate), or null/'' to insert nothing.
   */
  stop: () => Promise<string | null>;
  /** Optional lifecycle hook, for component-specific UI. */
  onState?: (state: HoldRecordState) => void;
  /** Hold threshold in ms before a held Space becomes a recording (default 280). */
  thresholdMs?: number;
}

/** Insert `text` at the caret, adding a separating space when joining onto a word. */
export function insertTextAtCaret(
  node: HTMLTextAreaElement | HTMLInputElement,
  text: string
): void {
  const value = node.value;
  const start = node.selectionStart ?? value.length;
  const end = node.selectionEnd ?? start;
  const before = value.slice(0, start);
  const after = value.slice(end);
  // Separate from preceding text unless it already ends in whitespace.
  const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const insert = lead + text;
  node.value = before + insert + after;
  const caret = start + insert.length;
  node.setSelectionRange(caret, caret);
  node.focus();
  // Let Svelte's bind:value + any oninput handlers (autoResize, draft save) react.
  node.dispatchEvent(new Event('input', { bubbles: true }));
}

export function holdSpaceRecord(
  node: HTMLTextAreaElement | HTMLInputElement,
  params: HoldSpaceRecordParams
) {
  let opts = params;
  let phase: HoldRecordState = 'idle';
  let warmupTimer: ReturnType<typeof setTimeout> | null = null;
  /** Caret index where the tap-space landed, so we can retract exactly that one. */
  let leakedSpacePos: number | null = null;
  /** Set once we commit to a recording; blocks overlapping gestures. */
  let busy = false;
  /** Resolves when start() has settled, so a fast release can't stop before start. */
  let startSettled: Promise<void> = Promise.resolve();

  function setState(next: HoldRecordState) {
    phase = next;
    if (next === 'idle') node.removeAttribute('data-hold-recording');
    else node.setAttribute('data-hold-recording', next);
    opts.onState?.(next);
  }

  function clearWarmup() {
    if (warmupTimer !== null) {
      clearTimeout(warmupTimer);
      warmupTimer = null;
    }
  }

  function reset() {
    clearWarmup();
    leakedSpacePos = null;
    busy = false;
    setState('idle');
  }

  function isEligible(e: KeyboardEvent): boolean {
    if (opts.enabled === false) return false;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
    if (e.isComposing) return false;
    // Only engage with a collapsed caret — Space with a selection would replace
    // the selected text, which we could not safely retract.
    if (node.selectionStart === null || node.selectionStart !== node.selectionEnd) {
      return false;
    }
    if (opts.canStart && !opts.canStart()) return false;
    return true;
  }

  async function activate() {
    if (phase !== 'warmup') return;
    clearWarmup();

    // Never start a second concurrent recording. Bail before retracting so the
    // user keeps the space they typed when we can't actually record.
    if (get(isRecording)) {
      reset();
      return;
    }

    // Retract the single space the initial tap inserted.
    if (leakedSpacePos !== null && node.value.charAt(leakedSpacePos) === ' ') {
      const pos = leakedSpacePos;
      node.value = node.value.slice(0, pos) + node.value.slice(pos + 1);
      node.setSelectionRange(pos, pos);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }
    leakedSpacePos = null;

    busy = true;
    setState('recording');
    startSettled = Promise.resolve()
      .then(() => opts.start())
      .catch((err) => {
        console.error('[holdSpaceRecord] Failed to start recording:', err);
        reset();
      });
    await startSettled;
  }

  async function finish() {
    if (phase !== 'recording') return;
    setState('transcribing');
    // Ensure the recorder actually started before we stop it (fast release).
    await startSettled;

    let text: string | null = null;
    try {
      text = await opts.stop();
    } catch (err) {
      console.error('[holdSpaceRecord] Transcription failed:', err);
    }

    if (text && text.trim()) insertTextAtCaret(node, text.trim());
    reset();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.code !== 'Space') return;

    // While a gesture is live, swallow the OS key-repeat so no extra spaces leak.
    if (phase === 'warmup' || phase === 'recording') {
      e.preventDefault();
      // The first key-repeat is a reliable "held" signal — activate immediately
      // rather than waiting out the remaining threshold.
      if (phase === 'warmup' && e.repeat) void activate();
      return;
    }

    // Mid-transcription: let the user keep typing normally, but don't start a
    // new overlapping gesture.
    if (busy) return;

    if (!isEligible(e)) return;

    // Initial tap: let the space type (no preventDefault), then arm the hold
    // timer. selectionStart here is the caret *before* the space is inserted.
    leakedSpacePos = node.selectionStart;
    setState('warmup');
    clearWarmup();
    warmupTimer = setTimeout(() => void activate(), opts.thresholdMs ?? 280);
  }

  function onKeyUp(e: KeyboardEvent) {
    if (e.code !== 'Space') return;
    if (phase === 'recording') {
      void finish();
    } else if (phase === 'warmup') {
      // Released before the threshold — it was a tap. Leave the typed space.
      reset();
    }
  }

  function onBlur() {
    if (phase === 'recording') void finish();
    else if (phase === 'warmup') reset();
  }

  // Cast to EventListener: `node` is a textarea|input union, which defeats TS's
  // keyed addEventListener overload (KeyboardEvent handler on Event listener).
  const keydownListener = onKeyDown as EventListener;
  const keyupListener = onKeyUp as EventListener;
  node.addEventListener('keydown', keydownListener);
  node.addEventListener('keyup', keyupListener);
  node.addEventListener('blur', onBlur);

  return {
    update(next: HoldSpaceRecordParams) {
      opts = next;
    },
    destroy() {
      clearWarmup();
      node.removeEventListener('keydown', keydownListener);
      node.removeEventListener('keyup', keyupListener);
      node.removeEventListener('blur', onBlur);
    },
  };
}
