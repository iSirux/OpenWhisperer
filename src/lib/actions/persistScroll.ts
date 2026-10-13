import type { Action } from 'svelte/action';
import { sdkSessions } from '$lib/stores/sdkSessions';

export interface PersistScrollParams {
  sessionId: string;
  /** Scroll area id within the session's dock UI, e.g. `pr:diff`. */
  key: string;
  /** Saved scrollTop for `key` (from `SdkSession.dockUi.scroll`). */
  saved: number | undefined;
}

/** Give up restoring after this — content that never grows that tall won't. */
const RESTORE_WINDOW_MS = 3000;
const SAVE_DEBOUNCE_MS = 250;

/**
 * Remember a scroll container's position in the session's persisted dock UI
 * state and restore it on mount (or when `key` changes, for a container shared
 * by several tabs). Content often renders after mount (a lazily fetched diff,
 * markdown), so the restore keeps retrying as the subtree changes until the
 * position is reachable, the user scrolls, or a short window passes.
 */
export const persistScroll: Action<HTMLElement, PersistScrollParams> = (node, initial) => {
  let params = initial;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTop: number | null = null;
  let observer: MutationObserver | null = null;
  let restoreDeadline = 0;
  let restoreTarget = 0;
  /** Scroll events caused by our own restore aren't user scrolls. */
  let restoring = false;

  function stopRestore() {
    observer?.disconnect();
    observer = null;
  }

  function tryRestore() {
    if (Date.now() > restoreDeadline) return stopRestore();
    restoring = true;
    node.scrollTop = restoreTarget;
    requestAnimationFrame(() => (restoring = false));
    if (Math.abs(node.scrollTop - restoreTarget) <= 1) stopRestore();
  }

  function startRestore(target: number | undefined) {
    stopRestore();
    if (!target) {
      node.scrollTop = 0;
      return;
    }
    restoreTarget = target;
    restoreDeadline = Date.now() + RESTORE_WINDOW_MS;
    requestAnimationFrame(tryRestore);
    observer = new MutationObserver(() => requestAnimationFrame(tryRestore));
    observer.observe(node, { childList: true, subtree: true, characterData: true });
  }

  function onScroll() {
    if (restoring) return;
    // The user took over — don't yank them back when more content lands.
    stopRestore();
    // Captured now: by the time a tab switch flushes, the new tab's content may
    // already have replaced (and clamped) this one.
    pendingTop = Math.round(node.scrollTop);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  }

  /** Write the pending save (also on tab switch / unmount so it isn't lost). */
  function flush() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (pendingTop === null) return;
    sdkSessions.setDockUi(params.sessionId, { scroll: { [params.key]: pendingTop } });
    pendingTop = null;
  }

  node.addEventListener('scroll', onScroll, { passive: true });
  startRestore(params.saved);

  return {
    update(next) {
      const keyChanged = next.key !== params.key || next.sessionId !== params.sessionId;
      if (keyChanged) flush();
      params = next;
      if (keyChanged) startRestore(next.saved);
    },
    destroy() {
      flush();
      stopRestore();
      node.removeEventListener('scroll', onScroll);
    },
  };
};
