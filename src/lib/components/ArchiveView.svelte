<script lang="ts">
  import { onMount } from 'svelte';
  import { archive } from '$lib/stores/archive';
  import { navigation } from '$lib/stores/navigation';
  import { repos, type RepoConfig } from '$lib/stores/repos';
  import RepoIcon from './RepoIcon.svelte';
  import ArchiveEntryItem from './ArchiveEntryItem.svelte';

  interface Props {
    onBack: () => void;
  }

  let { onBack }: Props = $props();

  let searchInput = $state('');
  let selectedRepoPath = $state<string | null>(null);
  let repoMenuOpen = $state(false);
  let searchTimeout: ReturnType<typeof setTimeout> | null = null;
  let confirmClear = $state(false);
  let restoringId = $state<string | null>(null);

  const entries = archive.entries;
  const totalCount = archive.totalCount;
  const isLoading = archive.isLoading;

  // Derived values
  let hasMore = $derived(($entries?.length ?? 0) < ($totalCount ?? 0));
  let allRepos = $derived($repos.list);
  let selectedRepo = $derived(
    selectedRepoPath
      ? allRepos.find((repo) => normalizePath(repo.path) === normalizePath(selectedRepoPath!)) ?? null
      : null,
  );

  function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').toLowerCase();
  }

  function loadArchive(page = 0) {
    archive.load(searchInput, null, selectedRepoPath, page);
  }

  function handleSearchInput() {
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      loadArchive();
    }, 300);
  }

  function setRepoFilter(repoPath: string | null) {
    selectedRepoPath = repoPath;
    repoMenuOpen = false;
    loadArchive();
  }

  function resolveRepo(repoPath: string | undefined): RepoConfig | null {
    if (!repoPath) return null;
    const normalized = normalizePath(repoPath);
    return allRepos.find((repo) => normalizePath(repo.path) === normalized) ?? null;
  }

  function handleLoadMore() {
    archive.loadMore();
  }

  async function handleDelete(id: string) {
    await archive.deleteEntry(id);
  }

  async function handleRestore(id: string) {
    if (restoringId) return;
    restoringId = id;
    try {
      const result = await archive.unarchiveEntry(id);
      if (result) {
        navigation.showSessions();
      }
    } catch (error) {
      console.error('[archive] Failed to restore entry:', error);
    } finally {
      restoringId = null;
    }
  }

  async function handleClearAll() {
    await archive.clearAll();
    confirmClear = false;
  }

  onMount(() => {
    repos.load();
    loadArchive();
    return () => {
      if (searchTimeout) clearTimeout(searchTimeout);
    };
  });
</script>

<div class="flex flex-col h-full">
  <!-- Header -->
  <div class="flex items-center justify-between p-4 border-b border-border">
    <div class="flex items-center gap-3">
      <button
        class="p-1.5 rounded hover:bg-surface-elevated transition-colors text-text-secondary hover:text-text-primary"
        title="Back to sessions"
        onclick={onBack}
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <div class="flex items-center gap-2">
        <svg class="w-5 h-5 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
        </svg>
        <h2 class="text-lg font-semibold text-text-primary">Archive</h2>
        {#if $totalCount > 0}
          <span class="text-sm text-text-muted">({$totalCount})</span>
        {/if}
      </div>
    </div>

    <!-- Clear all button -->
    {#if $totalCount > 0}
      {#if confirmClear}
        <div class="flex items-center gap-2">
          <span class="text-xs text-text-muted">Clear all?</span>
          <button
            class="px-2 py-1 text-xs text-error border border-error/30 hover:bg-error/10 rounded transition-colors"
            onclick={handleClearAll}
          >
            Yes, clear
          </button>
          <button
            class="px-2 py-1 text-xs text-text-muted hover:text-text-primary transition-colors"
            onclick={() => (confirmClear = false)}
          >
            Cancel
          </button>
        </div>
      {:else}
        <button
          class="px-2 py-1 text-xs text-text-muted hover:text-error transition-colors"
          title="Clear entire archive"
          onclick={() => (confirmClear = true)}
        >
          Clear all
        </button>
      {/if}
    {/if}
  </div>

  <!-- Search and filters -->
  <div class="p-3 border-b border-border space-y-2">
    <div class="flex items-center gap-2">
      <!-- Search input -->
      <div class="relative flex-1">
        <svg
          class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          placeholder="Search archived sessions..."
          class="w-full pl-10 pr-3 py-2 bg-surface-elevated text-text-primary text-sm rounded-lg border border-border focus:border-accent focus:outline-none transition-colors"
          bind:value={searchInput}
          oninput={handleSearchInput}
        />
      </div>

      <!-- Repository picker -->
      <div class="relative">
        <button
          class="flex items-center gap-2 px-2.5 py-2 bg-surface-elevated text-text-primary text-xs rounded-lg border border-border hover:border-accent/40 transition-colors"
          title="Filter by repository"
          onclick={() => (repoMenuOpen = !repoMenuOpen)}
        >
          <RepoIcon repo={selectedRepo} size="xs" />
          <span class="max-w-36 truncate">{selectedRepo?.name ?? 'All repositories'}</span>
          <svg class="w-3.5 h-3.5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {#if repoMenuOpen}
          <div class="absolute right-0 mt-1 w-64 bg-surface border border-border rounded-lg shadow-lg z-20 p-1 max-h-64 overflow-y-auto">
            <button
              class="w-full text-left px-2 py-1.5 rounded text-xs transition-colors flex items-center gap-2 {selectedRepoPath === null
                ? 'bg-accent/10 text-accent'
                : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary'}"
              onclick={() => setRepoFilter(null)}
            >
              <RepoIcon repo={null} size="xs" />
              <span>All repositories</span>
            </button>
            {#each allRepos as repo (repo.id ?? repo.path)}
              <button
                class="w-full text-left px-2 py-1.5 rounded text-xs transition-colors flex items-center gap-2 {selectedRepoPath !== null && normalizePath(selectedRepoPath) === normalizePath(repo.path)
                  ? 'bg-accent/10 text-accent'
                  : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary'}"
                onclick={() => setRepoFilter(repo.path)}
              >
                <RepoIcon {repo} size="xs" />
                <span class="truncate">{repo.name}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- Entry list -->
  <div class="flex-1 overflow-y-auto">
    {#if $isLoading && (!$entries || $entries.length === 0)}
      <div class="p-8 text-center text-text-muted text-sm">
        <div class="inline-block w-5 h-5 border-2 border-text-muted/30 border-t-accent rounded-full animate-spin mb-2"></div>
        <p>Loading archive...</p>
      </div>
    {:else if !$entries || $entries.length === 0}
      <div class="p-8 text-center text-text-muted">
        <svg class="w-10 h-10 mx-auto mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
            d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
        </svg>
        {#if searchInput || selectedRepoPath}
          <p class="text-sm">No matching archived sessions</p>
          <p class="text-xs mt-1 text-text-muted">Try adjusting your search or repository filter</p>
        {:else}
          <p class="text-sm">No archived sessions yet</p>
          <p class="text-xs mt-1 text-text-muted">Closed sessions will appear here</p>
        {/if}
      </div>
    {:else}
      {#each $entries as entry (entry.id)}
        <ArchiveEntryItem
          {entry}
          repo={resolveRepo(entry.repoPath)}
          ondelete={handleDelete}
          onrestore={handleRestore}
          restoring={restoringId === entry.id}
        />
      {/each}

      <!-- Load more / status -->
      <div class="p-3 text-center">
        {#if $isLoading}
          <div class="inline-block w-4 h-4 border-2 border-text-muted/30 border-t-accent rounded-full animate-spin"></div>
        {:else if hasMore}
          <button
            class="px-4 py-2 text-sm text-accent hover:bg-accent/10 rounded-lg transition-colors"
            onclick={handleLoadMore}
          >
            Load more ({$entries.length} of {$totalCount})
          </button>
        {:else}
          <span class="text-xs text-text-muted">
            Showing all {$totalCount} archived session{$totalCount !== 1 ? 's' : ''}
          </span>
        {/if}
      </div>
    {/if}
  </div>
</div>
