import { get, writable, type Readable } from 'svelte/store';
import { activeSdkSessionId, sdkSessions } from './sdkSessions';
import { activeExecutionId } from './sequenceExecutions';
import { navigation } from './navigation';

/**
 * Browser-style back/forward navigation across viewed SDK sessions.
 *
 * Distinct from the MRU `activationHistory` in sdkSessions (which only answers
 * "what session should I fall back to when this one closes?"). This is a linear
 * history with a cursor: activating a session pushes an entry (truncating any
 * forward history), and back/forward move the cursor without recording a new
 * entry — exactly like a web browser's tab history. Driven by the mouse
 * back/forward buttons (and Alt+Left / Alt+Right) wired up in the main layout.
 */

const MAX_HISTORY = 50;

interface NavState {
  canGoBack: boolean;
  canGoForward: boolean;
}

const navState = writable<NavState>({ canGoBack: false, canGoForward: false });

// Linear stack of session ids the user has navigated through, oldest first.
let entries: string[] = [];
// Index into `entries` of the currently-active session (-1 when empty).
let cursor = -1;
// Set while we programmatically re-activate a session via back/forward so the
// activeSdkSessionId subscription below doesn't treat it as a fresh push.
let navigating = false;

function publish(): void {
  const live = new Set(get(sdkSessions).map((s) => s.id));
  navState.set({
    canGoBack: firstLiveIndex(cursor - 1, -1, live) !== -1,
    canGoForward: firstLiveIndex(cursor + 1, entries.length, live) !== -1,
  });
}

/**
 * Walk `entries` from `start` toward `stop` (exclusive) and return the index of
 * the first still-existing session, or -1. `stop` may be below `start` (walking
 * backward) or above it (walking forward); the step direction is inferred.
 */
function firstLiveIndex(start: number, stop: number, live: Set<string>): number {
  const step = stop > start ? 1 : -1;
  for (let i = start; i !== stop; i += step) {
    if (i < 0 || i >= entries.length) break;
    if (live.has(entries[i])) return i;
  }
  return -1;
}

// Record every genuine (non-back/forward) session activation as a new history
// entry. Runs synchronously inside activeSdkSessionId.set, so the `navigating`
// guard reliably distinguishes our own back/forward navigations.
activeSdkSessionId.subscribe((id) => {
  if (navigating) return;
  if (!id) return; // empty views (no active session) aren't recorded
  if (entries[cursor] === id) return; // re-selecting the current session is a no-op

  entries = entries.slice(0, cursor + 1);
  entries.push(id);
  if (entries.length > MAX_HISTORY) entries = entries.slice(entries.length - MAX_HISTORY);
  cursor = entries.length - 1;
  publish();
});

function navigateTo(id: string): void {
  navigating = true;
  try {
    activeExecutionId.set(null);
    activeSdkSessionId.set(id);
    sdkSessions.markAsRead(id);
    navigation.setView('sessions');
  } finally {
    navigating = false;
  }
  publish();
}

export const sessionNavHistory = {
  subscribe: navState.subscribe as Readable<NavState>['subscribe'],

  /** Navigate to the previous still-existing session in history. */
  goBack(): boolean {
    const live = new Set(get(sdkSessions).map((s) => s.id));
    const target = firstLiveIndex(cursor - 1, -1, live);
    if (target === -1) return false;
    cursor = target;
    navigateTo(entries[cursor]);
    return true;
  },

  /** Navigate to the next still-existing session in history. */
  goForward(): boolean {
    const live = new Set(get(sdkSessions).map((s) => s.id));
    const target = firstLiveIndex(cursor + 1, entries.length, live);
    if (target === -1) return false;
    cursor = target;
    navigateTo(entries[cursor]);
    return true;
  },
};
