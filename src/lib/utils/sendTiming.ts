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

/**
 * Map a send-timing to a session-*launch* schedule. Launch surfaces (pile, Notion,
 * GitHub issues, New Session) have no live session yet, so `session_idle` and
 * `repo_idle` both defer to `'after_sessions'` (worktree scope); `reset_5h` targets
 * the next 5h window; `now` returns undefined (launch immediately).
 */
export function launchScheduleFromTiming(
  timing: SendTiming
): '5h' | '7d' | 'after_sessions' | undefined {
  switch (timing) {
    case 'reset_5h':
      return '5h';
    case 'repo_idle':
    case 'session_idle':
      return 'after_sessions';
    default:
      return undefined;
  }
}

/** Human-readable description of a deferred send timing (for parked-turn UI). */
export function sendTimingLabel(timing: SendTiming): string {
  switch (timing) {
    case 'session_idle':
      return 'Sends when this session is idle';
    case 'repo_idle':
      return 'Sends when the repo is idle';
    case 'reset_5h':
      return 'Sends at the next 5-hour reset';
    default:
      return 'Sends now';
  }
}
