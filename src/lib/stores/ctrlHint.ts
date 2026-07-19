// Tracks which hint modifiers (Ctrl/Cmd, Shift, Alt) are being held so the UI
// can overlay hints for modifier-based in-app actions: Ctrl-hotkey hints
// (session numbers, header buttons) and the send-timing badges on Send / quick
// actions / launch profiles (Ctrl = now, Shift = after this session,
// Ctrl+Shift = after repo/worktree, Ctrl+Shift+Alt = next 5h reset).
// A short delay before showing avoids flashing hints during quick combos like
// Ctrl+C or Shift-typed capital letters.

import { derived, writable } from 'svelte/store';

const SHOW_DELAY_MS = 250;

/** Which modifier combo is held (after the show delay). */
export type ModifierCombo = 'none' | 'ctrl' | 'shift' | 'ctrl+shift' | 'ctrl+shift+alt';

const raw = { ctrl: false, shift: false, alt: false };
let visible = false;
let suppressed = false;
let showTimer: ReturnType<typeof setTimeout> | null = null;

const combo = writable<ModifierCombo>('none');

function currentCombo(): ModifierCombo {
  if (raw.ctrl && raw.shift) return raw.alt ? 'ctrl+shift+alt' : 'ctrl+shift';
  if (raw.ctrl) return 'ctrl';
  if (raw.shift) return 'shift';
  return 'none';
}

function publish(): void {
  combo.set(visible && !suppressed ? currentCombo() : 'none');
}

/**
 * Force-hide hint badges regardless of the held modifiers. Used while a
 * hold-Space record-and-send gesture is actively recording: the modifier is
 * still held, but the badge has served its purpose and shouldn't linger over
 * the mic during the recording.
 */
export function setCtrlHintsSuppressed(next: boolean): void {
  if (suppressed === next) return;
  suppressed = next;
  publish();
}

/** The modifier combo held long enough to show hint badges. */
export const modifierCombo = { subscribe: combo.subscribe };

/**
 * True while plain Ctrl/Cmd (no Shift) has been held long enough to show
 * Ctrl-hotkey hints (session number badges, Ctrl-hotkey buttons).
 */
export const ctrlHeld = derived(combo, ($c) => $c === 'ctrl');

function isCtrlKey(event: KeyboardEvent): boolean {
  return event.key === 'Control' || event.key === 'Meta';
}

/** Call from a window keydown handler (safe to call for every keydown). */
export function ctrlHintKeydown(event: KeyboardEvent): void {
  if (isCtrlKey(event)) raw.ctrl = true;
  else if (event.key === 'Shift') raw.shift = true;
  else if (event.key === 'Alt') raw.alt = true;
  else return;

  if (visible) {
    // Already showing — reflect combo changes (e.g. Ctrl → Ctrl+Shift) live.
    publish();
    return;
  }
  if (!showTimer && !event.repeat) {
    showTimer = setTimeout(() => {
      showTimer = null;
      visible = true;
      publish();
    }, SHOW_DELAY_MS);
  }
}

/** Call from a window keyup handler (safe to call for every keyup). */
export function ctrlHintKeyup(event: KeyboardEvent): void {
  if (isCtrlKey(event)) raw.ctrl = false;
  else if (event.key === 'Shift') raw.shift = false;
  else if (event.key === 'Alt') raw.alt = false;
  else return;

  if (!raw.ctrl && !raw.shift && !raw.alt) {
    ctrlHintReset();
  } else if (visible) {
    publish();
  }
}

/** Hide hints immediately (also call on window blur — keyup may never fire). */
export function ctrlHintReset(): void {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  raw.ctrl = false;
  raw.shift = false;
  raw.alt = false;
  visible = false;
  publish();
}
