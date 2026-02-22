import { writable } from 'svelte/store';

/**
 * Navigation store for the main page's internal view state.
 * Only used for views rendered within the main page (sessions, start, sequence execution).
 *
 * Settings, sequences management, usage, and sessions-view all use SvelteKit routing
 * (/settings, /sequences, /usage, /sessions-view) rather than internal navigation.
 */

export type MainView = 'sessions' | 'start' | 'sequences' | 'archive';

interface NavigationState {
  mainView: MainView;
}

function createNavigationStore() {
  const { subscribe, set, update } = writable<NavigationState>({
    mainView: 'start',
  });

  return {
    subscribe,

    /**
     * Set the current main view
     */
    setView(view: MainView) {
      update(state => ({ ...state, mainView: view }));
    },

    /**
     * Show sessions view
     */
    showSessions() {
      set({ mainView: 'sessions' });
    },

    /**
     * Show start view
     */
    showStart() {
      update(state => ({ ...state, mainView: 'start' }));
    },

    /**
     * Show sequence execution view
     */
    showSequences() {
      update(state => ({ ...state, mainView: 'sequences' }));
    },

    /**
     * Show archive view
     */
    showArchive() {
      update(state => ({ ...state, mainView: 'archive' }));
    },

    /**
     * Reset to initial state (used on first launch)
     */
    reset() {
      set({ mainView: 'start' });
    },
  };
}

export const navigation = createNavigationStore();
