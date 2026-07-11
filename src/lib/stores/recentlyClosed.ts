import { writable, get } from 'svelte/store';

/**
 * A browser-tab-style stack of recently closed sessions. Sessions are pushed
 * here when they are archived on close (from any close path); Ctrl+Shift+T in
 * the main layout pops the newest and unarchives it back into the active list.
 *
 * Only sessions that were actually archived land here (empty SDK sessions are
 * never archived, so there is nothing to reopen). Entries reference the archive
 * by id, which equals the original session id.
 */
export interface RecentlyClosedEntry {
  id: string;
  sessionType: 'sdk';
}

const MAX_ENTRIES = 25;

export const recentlyClosedSessions = writable<RecentlyClosedEntry[]>([]);

/** Record a just-closed (and archived) session as reopenable. */
export function pushRecentlyClosed(id: string, sessionType: 'sdk'): void {
  recentlyClosedSessions.update((stack) => {
    // Drop any stale reference to the same id, then push to the top.
    const next = stack.filter((e) => e.id !== id);
    next.push({ id, sessionType });
    if (next.length > MAX_ENTRIES) next.shift();
    return next;
  });
}

/** Pop the most-recently closed entry, or null if the stack is empty. */
export function popRecentlyClosed(): RecentlyClosedEntry | null {
  const stack = get(recentlyClosedSessions);
  if (stack.length === 0) return null;
  const entry = stack[stack.length - 1];
  recentlyClosedSessions.set(stack.slice(0, -1));
  return entry;
}
