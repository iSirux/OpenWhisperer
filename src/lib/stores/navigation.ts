import { writable } from 'svelte/store';

/**
 * Navigation store to persist view state across route changes.
 * This prevents the main page from resetting to 'start' when navigating
 * back from /usage or /sessions-view.
 */

export type MainView = 'sessions' | 'settings' | 'start' | 'sequences';

function createNavigationStore() {
  const { subscribe, set, update } = writable<{
    mainView: MainView;
    settingsTab: string;
  }>({
    mainView: 'start',
    settingsTab: 'general',
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
     * Set the settings tab (for when returning to settings)
     */
    setSettingsTab(tab: string) {
      update(state => ({ ...state, settingsTab: tab }));
    },

    /**
     * Show settings with a specific tab
     */
    showSettings(tab?: string) {
      update(state => ({
        ...state,
        mainView: 'settings',
        settingsTab: tab ?? state.settingsTab,
      }));
    },

    /**
     * Show sessions view
     */
    showSessions() {
      set({ mainView: 'sessions', settingsTab: 'general' });
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
     * Reset to initial state (used on first launch)
     */
    reset() {
      set({ mainView: 'start', settingsTab: 'general' });
    },
  };
}

export const navigation = createNavigationStore();
