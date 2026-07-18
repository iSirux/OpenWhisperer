// The app-wide send-timing modifier map, shared by the Send button, Enter,
// quick-action chips, hold-Space gestures, and the setup view's Start button:
//
//   plain            = the surface's default action (send / append / dictate)
//   Ctrl             = now
//   Shift            = when this session is idle
//   Ctrl+Shift       = when the repo/worktree is idle
//   Ctrl+Shift+Alt   = on the next 5h usage-window reset

/** When a deferred send should fire. */
export type SendTiming = 'now' | 'session_idle' | 'repo_idle' | 'reset_5h';

export interface ModifierLike {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Timing for a send-surface click/keypress (plain and Ctrl both mean "now"). */
export function sendTimingFromEvent(e: ModifierLike): SendTiming {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.shiftKey && e.altKey) return 'reset_5h';
  if (ctrl && e.shiftKey) return 'repo_idle';
  if (e.shiftKey) return 'session_idle';
  return 'now';
}

/**
 * Timing for a hold-Space gesture: null means no send modifiers are held —
 * the gesture is plain dictation (insert at the caret), not a send.
 */
export function spaceSendTimingFromEvent(e: ModifierLike): SendTiming | null {
  if (!e.ctrlKey && !e.metaKey && !e.shiftKey) return null;
  return sendTimingFromEvent(e);
}
