import { writable, derived } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { usageStats } from './usageStats';
import { saveSessionsToDisk } from './sessionPersistence';

export type SessionStatus = 'Starting' | 'Running' | 'Completed' | 'Failed';

// Track all event listeners for proper cleanup
const sessionCloseListeners = new Map<string, UnlistenFn>();
let mainUnlisten: UnlistenFn | null = null;

export interface TerminalSession {
  id: string;
  repo_path: string;
  prompt: string;
  status: SessionStatus;
  created_at: number;
}

function createSessionsStore() {
  const { subscribe, set, update } = writable<TerminalSession[]>([]);

  return {
    subscribe,
    set,
    update,

    async load() {
      try {
        const sessions = await invoke<TerminalSession[]>('get_terminal_sessions');
        set(sessions);
      } catch (error) {
        console.error('Failed to load sessions:', error);
      }
    },

    async createSession(prompt: string): Promise<string> {
      try {
        console.log('sessions.createSession called with prompt:', prompt);
        const sessionId = await invoke<string>('create_terminal_session', { prompt });
        console.log('Backend returned session ID:', sessionId);
        await this.load();
        console.log('Sessions reloaded');

        // Track PTY session for usage stats
        usageStats.trackSession('pty', 'claude-cli', undefined);

        return sessionId;
      } catch (error) {
        console.error('Failed to create session:', error);
        throw error;
      }
    },

    async createInteractiveSession(): Promise<string> {
      try {
        console.log('sessions.createInteractiveSession called');
        const sessionId = await invoke<string>('create_interactive_session');
        console.log('Backend returned interactive session ID:', sessionId);
        await this.load();

        // Track interactive PTY session for usage stats
        usageStats.trackSession('pty', 'claude-cli-interactive', undefined);

        return sessionId;
      } catch (error) {
        console.error('Failed to create interactive session:', error);
        throw error;
      }
    },

    async closeSession(sessionId: string) {
      try {
        // Capture session data for archiving before removing
        let sessionToArchive: TerminalSession | undefined;
        subscribe(sessions => {
          sessionToArchive = sessions.find(s => s.id === sessionId);
        })();

        await invoke('close_terminal', { sessionId });
        update((sessions) => sessions.filter((s) => s.id !== sessionId));
        // Clean up the event listener for this session
        this.cleanupSessionListener(sessionId);

        // Archive the session
        if (sessionToArchive) {
          try {
            const { terminalSessionToPersisted } = await import('./sessionPersistence');
            const persisted = terminalSessionToPersisted(sessionToArchive);
            await invoke('archive_terminal_session', { session: persisted });
            // Trim archive to configured max
            const { get: getStore } = await import('svelte/store');
            const { settings: settingsStore } = await import('./settings');
            const currentSettings = getStore(settingsStore);
            await invoke('trim_archive', {
              maxEntries: currentSettings.session_persistence?.max_archived_sessions ?? 500,
            });
            // Refresh archive count for sidebar
            const { archive } = await import('./archive');
            archive.refreshCount();
          } catch (archiveError) {
            console.error('[sessions] Failed to archive session:', archiveError);
          }
        }

        // Save to disk so the closed session is removed from persistence
        await saveSessionsToDisk();
      } catch (error) {
        console.error('Failed to close session:', error);
        throw error;
      }
    },

    async writeToSession(sessionId: string, data: string) {
      try {
        await invoke('write_to_terminal', { sessionId, data });
      } catch (error) {
        console.error('Failed to write to session:', error);
        throw error;
      }
    },

    async resizeSession(sessionId: string, rows: number, cols: number) {
      try {
        await invoke('resize_terminal', { sessionId, rows, cols });
      } catch (error) {
        console.error('Failed to resize session:', error);
        throw error;
      }
    },

    updateSession(sessionId: string, updates: Partial<TerminalSession>) {
      update((sessions) =>
        sessions.map((s) => (s.id === sessionId ? { ...s, ...updates } : s))
      );
    },

    async setupListeners() {
      // Clean up any existing main listener before setting up new one
      if (mainUnlisten) {
        mainUnlisten();
        mainUnlisten = null;
      }

      mainUnlisten = await listen<TerminalSession>('session-created', async (event) => {
        update((sessions) => [...sessions, event.payload]);

        // Set up listener for this session's completion
        const sessionId = event.payload.id;

        // Clean up any existing listener for this session (shouldn't happen, but be safe)
        if (sessionCloseListeners.has(sessionId)) {
          sessionCloseListeners.get(sessionId)!();
          sessionCloseListeners.delete(sessionId);
        }

        const unlisten = await listen(`terminal-closed-${sessionId}`, () => {
          update((sessions) =>
            sessions.map((s) =>
              s.id === sessionId ? { ...s, status: 'Completed' as SessionStatus } : s
            )
          );

          // Clean up this listener after it fires (session closed = no more events)
          if (sessionCloseListeners.has(sessionId)) {
            sessionCloseListeners.get(sessionId)!();
            sessionCloseListeners.delete(sessionId);
          }
        });

        sessionCloseListeners.set(sessionId, unlisten);
      });
    },

    cleanupSessionListener(sessionId: string) {
      if (sessionCloseListeners.has(sessionId)) {
        sessionCloseListeners.get(sessionId)!();
        sessionCloseListeners.delete(sessionId);
      }
    },

    cleanupAllListeners() {
      // Clean up all session-specific listeners
      for (const unlisten of sessionCloseListeners.values()) {
        unlisten();
      }
      sessionCloseListeners.clear();

      // Clean up main listener
      if (mainUnlisten) {
        mainUnlisten();
        mainUnlisten = null;
      }
    },

    async init() {
      await this.load();
      await this.setupListeners();
    },
  };
}

export const sessions = createSessionsStore();

export const activeSessionId = writable<string | null>(null);

export const activeSession = derived(
  [sessions, activeSessionId],
  ([$sessions, $activeSessionId]) => {
    return $sessions.find((s) => s.id === $activeSessionId) || null;
  }
);

export const runningSessions = derived(sessions, ($sessions) => {
  return $sessions.filter((s) => s.status === 'Running');
});
