// Tracks whether the Ctrl (or Cmd) key is being held so the UI can overlay
// hints for Ctrl-based in-app hotkeys (session numbers, header buttons, etc.).
// A short delay before showing avoids flashing hints during quick combos like Ctrl+C.

import { writable } from 'svelte/store';

const SHOW_DELAY_MS = 250;

const held = writable(false);
let showTimer: ReturnType<typeof setTimeout> | null = null;

/** True while Ctrl/Cmd has been held long enough to show hotkey hints. */
export const ctrlHeld = { subscribe: held.subscribe };

function isModifierKey(event: KeyboardEvent): boolean {
  return event.key === 'Control' || event.key === 'Meta';
}

/** Call from a window keydown handler (safe to call for every keydown). */
export function ctrlHintKeydown(event: KeyboardEvent): void {
  if (!isModifierKey(event) || event.repeat || showTimer) return;
  showTimer = setTimeout(() => {
    showTimer = null;
    held.set(true);
  }, SHOW_DELAY_MS);
}

/** Call from a window keyup handler (safe to call for every keyup). */
export function ctrlHintKeyup(event: KeyboardEvent): void {
  if (!isModifierKey(event)) return;
  ctrlHintReset();
}

/** Hide hints immediately (also call on window blur — keyup may never fire). */
export function ctrlHintReset(): void {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  held.set(false);
}
