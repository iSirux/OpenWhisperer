import { writable } from 'svelte/store';

/**
 * Navigation store for the main page's internal view state.
 * Only used for views rendered within the main page (sessions, start, sequence execution).
 *
 * Settings, sequences management, usage, and sessions-view all use SvelteKit routing
 * (/settings, /sequences, /usage, /sessions-view) rather than internal navigation.
 */

export type MainView = 'sessions' | 'start' | 'sequences' | 'archive' | 'repository' | 'notion';

interface NavigationState {
  mainView: MainView;
  selectedRepoId: string | null;
  repositoryAddMode: boolean;
}

function createNavigationStore() {
  const { subscribe, set, update } = writable<NavigationState>({
    mainView: 'start',
    selectedRepoId: null,
    repositoryAddMode: false,
  });

  return {
    subscribe,

    /**
     * Set the current main view
     */
    setView(view: MainView) {
      update((state) => ({
        ...state,
        mainView: view,
        repositoryAddMode: view === 'repository' ? state.repositoryAddMode : false,
      }));
    },

    /**
     * Show sessions view
     */
    showSessions() {
      update((state) => ({ ...state, mainView: 'sessions', repositoryAddMode: false }));
    },

    /**
     * Show start view
     */
    showStart() {
      update((state) => ({ ...state, mainView: 'start', repositoryAddMode: false }));
    },

    /**
     * Show sequence execution view
     */
    showSequences() {
      update((state) => ({ ...state, mainView: 'sequences', repositoryAddMode: false }));
    },

    /**
     * Show archive view
     */
    showArchive() {
      update((state) => ({ ...state, mainView: 'archive', repositoryAddMode: false }));
    },

    showNotion() {
      update((state) => ({ ...state, mainView: 'notion', repositoryAddMode: false }));
    },

    showRepository(repoId: string | null | undefined) {
      update((state) => ({
        ...state,
        mainView: 'repository',
        selectedRepoId: repoId === undefined ? state.selectedRepoId : repoId,
        repositoryAddMode: false,
      }));
    },

    showRepositoryAdd() {
      update((state) => ({
        ...state,
        mainView: 'repository',
        repositoryAddMode: true,
      }));
    },

    /**
     * Reset to initial state (used on first launch)
     */
    reset() {
      set({ mainView: 'start', selectedRepoId: null, repositoryAddMode: false });
    },
  };
}

export const navigation = createNavigationStore();
