import { writable, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';

export interface ArchiveEntry {
  id: string;
  /** 'pty' only appears in legacy archives; those entries can no longer be restored */
  sessionType: 'sdk' | 'pty' | 'sequence';
  name?: string;
  summary?: string;
  category?: string;
  prompt?: string;
  model?: string;
  repoPath?: string;
  status: string;
  createdAt: number;
  archivedAt: number;
  durationMs: number;
  totalCost?: number;
  messageCount: number;
}

export interface ArchiveSearchResult {
  entries: ArchiveEntry[];
  totalCount: number;
}

const PAGE_SIZE = 50;

function createArchiveStore() {
  const entries = writable<ArchiveEntry[]>([]);
  const totalCount = writable<number>(0);
  const isLoading = writable<boolean>(false);
  const searchQuery = writable<string>('');
  const filterType = writable<string | null>(null);
  const filterRepoPath = writable<string | null>(null);
  const currentPage = writable<number>(0);
  const archiveCount = writable<number>(0);
  let hasLoaded = false;

  return {
    entries,
    totalCount,
    isLoading,
    searchQuery,
    filterType,
    filterRepoPath,
    currentPage,
    archiveCount,

    /**
     * Load archive entries with optional search and type filter
     */
    async load(
      query = '',
      sessionType: string | null = null,
      repoPath: string | null = null,
      page = 0,
    ): Promise<void> {
      isLoading.set(true);
      try {
        const result = await invoke<ArchiveSearchResult>('get_archive_entries', {
          query: query || null,
          sessionType: sessionType || null,
          repoPath: repoPath || null,
          offset: page * PAGE_SIZE,
          limit: PAGE_SIZE,
        });
        entries.set(result.entries);
        totalCount.set(result.totalCount);
        currentPage.set(page);
        searchQuery.set(query);
        filterType.set(sessionType);
        filterRepoPath.set(repoPath);
        hasLoaded = true;
      } catch (error) {
        console.error('[archive] Failed to load entries:', error);
      } finally {
        isLoading.set(false);
      }
    },

    /**
     * Load the next page of results (append to existing)
     */
    async loadMore(): Promise<void> {
      const page = get(currentPage);
      const query = get(searchQuery);
      const type = get(filterType);
      const repoPath = get(filterRepoPath);

      isLoading.set(true);
      try {
        const result = await invoke<ArchiveSearchResult>('get_archive_entries', {
          query: query || null,
          sessionType: type || null,
          repoPath: repoPath || null,
          offset: (page + 1) * PAGE_SIZE,
          limit: PAGE_SIZE,
        });
        entries.update(existing => [...existing, ...result.entries]);
        totalCount.set(result.totalCount);
        currentPage.set(page + 1);
      } catch (error) {
        console.error('[archive] Failed to load more entries:', error);
      } finally {
        isLoading.set(false);
      }
    },

    /**
     * Get full session data for an archived entry
     */
    async getEntryData(id: string): Promise<unknown> {
      return invoke('get_archive_entry_data', { id });
    },

    /**
     * Unarchive a session: restore it from archive back to the active session list.
     * Returns the session id and type for navigation, or null if not restorable.
     */
    async unarchiveEntry(id: string): Promise<{ id: string; sessionType: string } | null> {
      const result = await invoke<{ sessionData: unknown; sessionType: string }>('unarchive_entry', { id });

      if (result.sessionType === 'sdk') {
        const { persistedToSdkSession, saveSessionsToDisk } = await import('./sessionPersistence');
        const { sdkSessions, activeSdkSessionId } = await import('./sdkSessions');

        const restored = persistedToSdkSession(result.sessionData as Parameters<typeof persistedToSdkSession>[0]);

        // Ensure restored session has a stable status
        if (restored.status === 'querying' || restored.status === 'initializing') {
          restored.status = 'idle';
        }

        // Add to live SDK sessions (guard against duplicates, use get+set since store doesn't expose update)
        const currentSessions = get(sdkSessions);
        if (!currentSessions.some(s => s.id === restored.id)) {
          sdkSessions.set([restored, ...currentSessions]);
        }
        activeSdkSessionId.set(restored.id);

        // Update local archive state
        entries.update(e => e.filter(entry => entry.id !== id));
        totalCount.update(n => n - 1);
        archiveCount.update(n => Math.max(0, n - 1));

        await saveSessionsToDisk();
        return { id, sessionType: result.sessionType };
      } else {
        console.warn(`[archive] Cannot restore session type: ${result.sessionType}`);
        return null;
      }
    },

    /**
     * Delete a single archived entry
     */
    async deleteEntry(id: string): Promise<void> {
      await invoke('delete_archive_entry', { id });
      entries.update(e => e.filter(entry => entry.id !== id));
      totalCount.update(n => n - 1);
      archiveCount.update(n => Math.max(0, n - 1));
    },

    /**
     * Clear the entire archive
     */
    async clearAll(): Promise<void> {
      await invoke('clear_archive');
      entries.set([]);
      totalCount.set(0);
      archiveCount.set(0);
    },

    /**
     * Refresh the archive count (for sidebar display)
     */
    async refreshCount(): Promise<void> {
      try {
        const count = await invoke<number>('get_archive_count');
        archiveCount.set(count);
      } catch (error) {
        console.error('[archive] Failed to get count:', error);
      }
    },

    /**
     * Refresh archive count and list (if archive has been loaded in this session)
     */
    async refresh(): Promise<void> {
      await invoke<number>('get_archive_count')
        .then((count) => archiveCount.set(count))
        .catch((error) => console.error('[archive] Failed to get count:', error));
      if (!hasLoaded) return;
      const query = get(searchQuery);
      const type = get(filterType);
      const repoPath = get(filterRepoPath);
      isLoading.set(true);
      try {
        const result = await invoke<ArchiveSearchResult>('get_archive_entries', {
          query: query || null,
          sessionType: type || null,
          repoPath: repoPath || null,
          offset: 0,
          limit: PAGE_SIZE,
        });
        entries.set(result.entries);
        totalCount.set(result.totalCount);
        currentPage.set(0);
      } catch (error) {
        console.error('[archive] Failed to refresh entries:', error);
      } finally {
        isLoading.set(false);
      }
    },
  };
}

export const archive = createArchiveStore();
