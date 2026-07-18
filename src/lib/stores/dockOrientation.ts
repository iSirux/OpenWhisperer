/**
 * Global orientation preference for the session dock (the resizable pane
 * hosting the PR + validation panels in SdkView): docked on the right
 * (horizontal split, default) or at the bottom (vertical split). Persisted to
 * localStorage like the dock's split ratio (paneforge autoSaveId).
 */
import { writable } from 'svelte/store';

export type DockOrientation = 'bottom' | 'right';

const STORAGE_KEY = 'open-whisperer:session-dock-orientation';

function load(): DockOrientation {
  if (typeof localStorage === 'undefined') return 'right';
  try {
    return localStorage.getItem(STORAGE_KEY) === 'bottom' ? 'bottom' : 'right';
  } catch {
    return 'right';
  }
}

function persist(value: DockOrientation): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* storage unavailable — non-fatal */
  }
}

const store = writable<DockOrientation>(load());

export const dockOrientation = {
  subscribe: store.subscribe,

  set(value: DockOrientation): void {
    store.set(value);
    persist(value);
  },

  toggle(): void {
    store.update((v) => {
      const next: DockOrientation = v === 'bottom' ? 'right' : 'bottom';
      persist(next);
      return next;
    });
  },
};
