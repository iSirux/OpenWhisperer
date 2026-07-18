import { get } from 'svelte/store';
import { isRecording, recording } from '$lib/stores/recording';
import { spaceSendTimingFromEvent, type SendTiming } from '$lib/utils/sendTiming';

/** Default minimum total hold (ms) below which a hold is treated as a plain space. */
export const DEFAULT_MIN_HOLD_MS = 500;

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
 * A hold that's over the warmup threshold but still short in TOTAL time
 * (released before `minHoldMs`) is treated as a fumbled tap, not a recording:
 * the in-flight recording is discarded (never transcribed, never sent) and the
 * retracted space is put back, so a quick hold just types a regular space.
 *
 * When a hold cannot become a recording (guard declined, another recording or
 * transcription in flight), the key-repeat is still suppressed so the hold
 * types at most the one tap-space instead of a stream of spaces.
 *
 * An optional send variant (`send`) runs the same gesture through a different
 * pipeline whose stop() consumes the recording itself (e.g. transcribe-and-send)
 * — nothing is inserted at the caret. It engages when the app-wide send-timing
 * modifiers are held with Space (Ctrl = now, Shift = when this session is idle,
 * Ctrl+Shift = when the repo/worktree is idle, Ctrl+Shift+Alt = next 5h reset;
 * see `utils/sendTiming.ts`), with the timing locked in on the initial press and
 * passed to start/stop. Without it, modified Space is left untouched as
 * deliberate typing.
 *
 * The action is pure gesture + insertion — the caller supplies `start`/`stop`
 * so each prompt input can route to its own recording/transcription pipeline.
 */

export type HoldRecordState = 'idle' | 'warmup' | 'recording' | 'transcribing';

export interface HoldSpaceSendParams {
  /** Extra guard evaluated on the initial press (same contract as `canStart`). */
  canStart?: () => boolean;
  /** Begin recording. Awaited before a release is allowed to stop it. */
  start: (timing: SendTiming) => void | Promise<void>;
  /**
   * Stop recording and consume the result itself (e.g. transcribe and send with
   * the given timing). Nothing is inserted at the caret.
   */
  stop: (timing: SendTiming) => void | Promise<void>;
}

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
  /**
   * Minimum TOTAL hold in ms (press → release) for the recording to be kept.
   * A shorter hold is discarded and typed as a plain space (default 500).
   */
  minHoldMs?: number;
  /**
   * Optional modifier+Space variant routed to a pipeline that consumes the
   * recording itself (record-and-send with a timing) instead of inserting at
   * the caret.
   */
  send?: HoldSpaceSendParams;
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
  /** Caret index of the space we retracted on activate, so a too-short hold can restore it. */
  let retractedSpacePos: number | null = null;
  /** Timestamp of the initial Space press, to measure total hold time. */
  let pressStartedAt = 0;
  /** Set once we commit to a recording; blocks overlapping gestures. */
  let busy = false;
  /** Which pipeline this gesture drives, locked in on the initial press:
   *  null = plain dictation, otherwise the send timing from the held modifiers. */
  let sendTiming: SendTiming | null = null;
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
    retractedSpacePos = null;
    busy = false;
    setState('idle');
  }

  /** Put back the single space we retracted on activate (too-short hold = plain space). */
  function reinsertRetractedSpace() {
    if (retractedSpacePos === null) return;
    const pos = Math.min(retractedSpacePos, node.value.length);
    node.value = node.value.slice(0, pos) + ' ' + node.value.slice(pos);
    node.setSelectionRange(pos + 1, pos + 1);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * Which gesture the held modifier combo maps to: 'plain' (no modifiers) for
   * dictation, a SendTiming for the send variant, or null when the combo is
   * deliberate typing / not configured (e.g. Alt+Space, send combo without a
   * `send` pipeline).
   */
  function comboVariant(e: KeyboardEvent): 'plain' | SendTiming | null {
    if (opts.enabled === false) return null;
    const timing = spaceSendTimingFromEvent(e);
    if (timing !== null) return opts.send ? timing : null;
    return e.altKey ? null : 'plain';
  }

  function isEligible(e: KeyboardEvent, variant: 'plain' | SendTiming): boolean {
    if (e.isComposing) return false;
    // Only engage with a collapsed caret — Space with a selection would replace
    // the selected text, which we could not safely retract.
    if (node.selectionStart === null || node.selectionStart !== node.selectionEnd) {
      return false;
    }
    const guard = variant !== 'plain' ? opts.send?.canStart : opts.canStart;
    if (guard && !guard()) return false;
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

    // Retract the single space the initial tap inserted. Remember where it was
    // so a too-short hold can restore it and read as a plain space.
    retractedSpacePos = null;
    if (leakedSpacePos !== null && node.value.charAt(leakedSpacePos) === ' ') {
      const pos = leakedSpacePos;
      node.value = node.value.slice(0, pos) + node.value.slice(pos + 1);
      node.setSelectionRange(pos, pos);
      node.dispatchEvent(new Event('input', { bubbles: true }));
      retractedSpacePos = pos;
    }
    leakedSpacePos = null;

    busy = true;
    setState('recording');
    const timing = sendTiming;
    startSettled = Promise.resolve()
      .then(() => (timing !== null ? opts.send!.start(timing) : opts.start()))
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

    // The send variant consumes the recording itself — nothing to insert.
    if (sendTiming !== null) {
      try {
        await opts.send?.stop(sendTiming);
      } catch (err) {
        console.error('[holdSpaceRecord] Send-variant stop failed:', err);
      }
      reset();
      return;
    }

    let text: string | null = null;
    try {
      text = await opts.stop();
    } catch (err) {
      console.error('[holdSpaceRecord] Transcription failed:', err);
    }

    if (text && text.trim()) insertTextAtCaret(node, text.trim());
    reset();
  }

  /**
   * The hold was over the warmup threshold but short in total time — treat it as
   * a fumbled tap: discard the recording (never transcribe or send it) and put
   * the retracted space back so the gesture reads as a plain space.
   */
  async function discardShortHold() {
    if (phase !== 'recording') return;
    // Ensure the recorder actually started before we stop it (fast release).
    await startSettled;
    try {
      await recording.cancelRecording();
    } catch (err) {
      console.error('[holdSpaceRecord] Failed to discard short hold:', err);
    }
    reinsertRetractedSpace();
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

    // A held Space that couldn't become a gesture (mid-transcription, another
    // recording active, guard declined) must not spray key-repeat spaces into
    // the input — the initial tap already typed one; swallow the repeats.
    // Combos that never engage (e.g. Alt+Space, a send combo with no send
    // pipeline) are left alone as deliberate typing.
    const variant = comboVariant(e);
    if (e.repeat && variant !== null) {
      e.preventDefault();
      return;
    }

    // Mid-transcription: let the user keep typing normally, but don't start a
    // new overlapping gesture.
    if (busy) return;

    if (variant === null || !isEligible(e, variant)) return;

    // Initial tap: let the space type (no preventDefault), then arm the hold
    // timer. selectionStart here is the caret *before* the space is inserted.
    sendTiming = variant === 'plain' ? null : variant;
    leakedSpacePos = node.selectionStart;
    pressStartedAt = Date.now();
    setState('warmup');
    clearWarmup();
    warmupTimer = setTimeout(() => void activate(), opts.thresholdMs ?? 280);
  }

  /** Released/blurred too soon after recording began — discard it as a plain space. */
  function tooShort(): boolean {
    return Date.now() - pressStartedAt < (opts.minHoldMs ?? DEFAULT_MIN_HOLD_MS);
  }

  function onKeyUp(e: KeyboardEvent) {
    if (e.code !== 'Space') return;
    if (phase === 'recording') {
      if (tooShort()) void discardShortHold();
      else void finish();
    } else if (phase === 'warmup') {
      // Released before the threshold — it was a tap. Leave the typed space.
      reset();
    }
  }

  function onBlur() {
    if (phase === 'recording') {
      if (tooShort()) void discardShortHold();
      else void finish();
    } else if (phase === 'warmup') reset();
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
