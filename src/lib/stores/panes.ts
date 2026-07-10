import { writable, derived, get, type Readable } from 'svelte/store';
import { settings, settingsLoaded } from './settings';

export interface Pane {
  id: string;
  sessionId: string | null;
}

export interface PaneLayoutState {
  panes: Pane[];
  focusedPaneId: string;
}

export const MAX_PANES = 4;

function newPaneId(): string {
  return crypto.randomUUID();
}

function createInitialState(): PaneLayoutState {
  const pane: Pane = { id: newPaneId(), sessionId: null };
  return { panes: [pane], focusedPaneId: pane.id };
}

const store = writable<PaneLayoutState>(createInitialState());

export const paneLayout: Readable<PaneLayoutState> = { subscribe: store.subscribe };

export const visibleSessionIds: Readable<Set<string>> = derived(store, ($state) => {
  const ids = new Set<string>();
  for (const pane of $state.panes) {
    if (pane.sessionId) ids.add(pane.sessionId);
  }
  return ids;
});

// Whether the pane area is actually rendered right now. Pane ASSIGNMENTS persist
// while the user is on other routes/views (settings, usage, repository…), so
// `visibleSessionIds` alone still claims the paned sessions are "being viewed"
// there. SessionPanes flips this on mount/destroy.
const panesOnScreen = writable(false);

export function setSessionPanesOnScreen(onScreen: boolean): void {
  panesOnScreen.set(onScreen);
}

/** Sessions the user can actually SEE right now — empty while the pane area is unmounted. */
export const onScreenSessionIds: Readable<Set<string>> = derived(
  [visibleSessionIds, panesOnScreen],
  ([$ids, $onScreen]) => ($onScreen ? $ids : new Set<string>())
);

export const focusedPaneSessionId: Readable<string | null> = derived(store, ($state) => {
  const pane = $state.panes.find(p => p.id === $state.focusedPaneId);
  return pane?.sessionId ?? null;
});

let hydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
  if (!hydrated) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const state = get(store);
    const assignments = state.panes.map(p => p.sessionId);
    const focused_index = Math.max(0, state.panes.findIndex(p => p.id === state.focusedPaneId));
    const currentSettings = get(settings);
    const pane_layout = { assignments, focused_index };
    settings.update(s => ({ ...s, pane_layout }));
    settings.save({ ...currentSettings, pane_layout });
  }, 500);
}

function setState(next: PaneLayoutState): void {
  store.set(next);
  schedulePersist();
}

function nearestNeighborId(remaining: Pane[], removedIndex: number): string {
  return remaining[Math.min(removedIndex, remaining.length - 1)].id;
}

function assignTo(paneId: string, sessionId: string | null): void {
  const state = get(store);
  const target = state.panes.find(p => p.id === paneId);
  if (!target) return;

  if (sessionId === null) {
    setState({
      panes: state.panes.map(p => (p.id === paneId ? { ...p, sessionId: null } : p)),
      focusedPaneId: paneId,
    });
    return;
  }

  const holder = state.panes.find(p => p.sessionId === sessionId);
  if (holder && holder.id !== paneId) {
    if (state.focusedPaneId !== holder.id) {
      setState({ ...state, focusedPaneId: holder.id });
    }
    return;
  }

  setState({
    panes: state.panes.map(p => (p.id === paneId ? { ...p, sessionId } : p)),
    focusedPaneId: paneId,
  });
}

let unsubLoaded: (() => void) | null = null;
unsubLoaded = settingsLoaded.subscribe((loaded) => {
  if (!loaded || hydrated) return;
  const saved = get(settings).pane_layout;
  if (saved && Array.isArray(saved.assignments) && saved.assignments.length > 0) {
    const panes: Pane[] = saved.assignments
      .slice(0, MAX_PANES)
      .map(sessionId => ({ id: newPaneId(), sessionId: sessionId ?? null }));
    const seen = new Set<string>();
    for (const pane of panes) {
      if (pane.sessionId) {
        if (seen.has(pane.sessionId)) pane.sessionId = null;
        else seen.add(pane.sessionId);
      }
    }
    const focusedIndex = Math.min(Math.max(saved.focused_index ?? 0, 0), panes.length - 1);
    store.set({ panes, focusedPaneId: panes[focusedIndex].id });
  }
  hydrated = true;
  unsubLoaded?.();
  unsubLoaded = null;
});

export const panes = {
  focusPane(paneId: string): void {
    const state = get(store);
    if (state.focusedPaneId === paneId) return;
    if (!state.panes.some(p => p.id === paneId)) return;
    setState({ ...state, focusedPaneId: paneId });
  },

  assignToFocusedPane(sessionId: string | null): void {
    assignTo(get(store).focusedPaneId, sessionId);
  },

  assignToPane(paneId: string, sessionId: string | null): void {
    assignTo(paneId, sessionId);
  },

  splitPane(afterPaneId?: string): string | null {
    const state = get(store);
    if (state.panes.length >= MAX_PANES) return null;
    const anchorId = afterPaneId ?? state.focusedPaneId;
    const anchorIndex = state.panes.findIndex(p => p.id === anchorId);
    const insertAt = anchorIndex === -1 ? state.panes.length : anchorIndex + 1;
    const pane: Pane = { id: newPaneId(), sessionId: null };
    const panes = [...state.panes];
    panes.splice(insertAt, 0, pane);
    setState({ panes, focusedPaneId: pane.id });
    return pane.id;
  },

  closePane(paneId: string): void {
    const state = get(store);
    const index = state.panes.findIndex(p => p.id === paneId);
    if (index === -1) return;

    if (state.panes.length === 1) {
      setState({
        panes: state.panes.map(p => (p.id === paneId ? { ...p, sessionId: null } : p)),
        focusedPaneId: paneId,
      });
      return;
    }

    const panes = state.panes.filter(p => p.id !== paneId);
    let focusedPaneId = state.focusedPaneId;
    if (focusedPaneId === paneId) {
      focusedPaneId = nearestNeighborId(panes, index);
    }
    setState({ panes, focusedPaneId });
  },

  clearSession(sessionId: string): void {
    const state = get(store);
    const index = state.panes.findIndex(p => p.sessionId === sessionId);
    if (index === -1) return;
    const holder = state.panes[index];

    if (state.panes.length === 1) {
      setState({
        panes: [{ ...holder, sessionId: null }],
        focusedPaneId: holder.id,
      });
      return;
    }

    const panes = state.panes.filter(p => p.id !== holder.id);
    let focusedPaneId = state.focusedPaneId;
    if (focusedPaneId === holder.id) {
      focusedPaneId = nearestNeighborId(panes, index);
    }
    setState({ panes, focusedPaneId });
  },

  reconcile(existingSessionIds: string[]): void {
    const state = get(store);
    const existing = new Set(existingSessionIds);
    const remapped = state.panes.map(p => ({
      ...p,
      sessionId: p.sessionId && existing.has(p.sessionId) ? p.sessionId : null,
    }));

    let panes = remapped;
    if (remapped.length > 1 && remapped.every(p => p.sessionId === null)) {
      panes = [remapped[0]];
    }

    let focusedPaneId = state.focusedPaneId;
    if (!panes.some(p => p.id === focusedPaneId)) {
      focusedPaneId = panes[0].id;
    }
    setState({ panes, focusedPaneId });
  },
};
