import { writable, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';

export interface ArchiveEntry {
  id: string;
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
  const currentPage = writable<number>(0);
  const archiveCount = writable<number>(0);

  return {
    entries,
    totalCount,
    isLoading,
    searchQuery,
    filterType,
    currentPage,
    archiveCount,

    /**
     * Load archive entries with optional search and type filter
     */
    async load(query = '', sessionType: string | null = null, page = 0): Promise<void> {
      isLoading.set(true);
      try {
        const result = await invoke<ArchiveSearchResult>('get_archive_entries', {
          query: query || null,
          sessionType: sessionType || null,
          offset: page * PAGE_SIZE,
          limit: PAGE_SIZE,
        });
        entries.set(result.entries);
        totalCount.set(result.totalCount);
        currentPage.set(page);
        searchQuery.set(query);
        filterType.set(sessionType);
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

      isLoading.set(true);
      try {
        const result = await invoke<ArchiveSearchResult>('get_archive_entries', {
          query: query || null,
          sessionType: type || null,
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
  };
}

export const archive = createArchiveStore();
