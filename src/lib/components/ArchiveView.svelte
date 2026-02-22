<script lang="ts">
  import { onMount } from 'svelte';
  import { archive } from '$lib/stores/archive';
  import ArchiveEntryItem from './ArchiveEntryItem.svelte';

  interface Props {
    onBack: () => void;
  }

  let { onBack }: Props = $props();

  let searchInput = $state('');
  let activeFilter = $state<string | null>(null);
  let searchTimeout: ReturnType<typeof setTimeout> | null = null;
  let confirmClear = $state(false);

  const entries = archive.entries;
  const totalCount = archive.totalCount;
  const isLoading = archive.isLoading;

  // Derived values
  let hasMore = $derived(($entries?.length ?? 0) < ($totalCount ?? 0));

  function handleSearchInput() {
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      archive.load(searchInput, activeFilter);
    }, 300);
  }

  function setFilter(type: string | null) {
    activeFilter = type;
    archive.load(searchInput, type);
  }

  function handleLoadMore() {
    archive.loadMore();
  }

  async function handleDelete(id: string) {
    await archive.deleteEntry(id);
  }

  async function handleClearAll() {
    await archive.clearAll();
    confirmClear = false;
  }

  onMount(() => {
    archive.load();
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
    <!-- Search input -->
    <div class="relative">
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

    <!-- Filter chips -->
    <div class="flex items-center gap-2">
      <button
        class="px-2.5 py-1 text-xs rounded-full transition-colors {activeFilter === null
          ? 'bg-accent/20 text-accent'
          : 'bg-surface-elevated text-text-muted hover:text-text-primary'}"
        onclick={() => setFilter(null)}
      >
        All
      </button>
      <button
        class="px-2.5 py-1 text-xs rounded-full transition-colors {activeFilter === 'sdk'
          ? 'bg-accent/20 text-accent'
          : 'bg-surface-elevated text-text-muted hover:text-text-primary'}"
        onclick={() => setFilter('sdk')}
      >
        SDK
      </button>
      <button
        class="px-2.5 py-1 text-xs rounded-full transition-colors {activeFilter === 'pty'
          ? 'bg-emerald-500/20 text-emerald-400'
          : 'bg-surface-elevated text-text-muted hover:text-text-primary'}"
        onclick={() => setFilter('pty')}
      >
        PTY
      </button>
      <button
        class="px-2.5 py-1 text-xs rounded-full transition-colors {activeFilter === 'sequence'
          ? 'bg-indigo-500/20 text-indigo-400'
          : 'bg-surface-elevated text-text-muted hover:text-text-primary'}"
        onclick={() => setFilter('sequence')}
      >
        Sequence
      </button>
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
        {#if searchInput || activeFilter}
          <p class="text-sm">No matching archived sessions</p>
          <p class="text-xs mt-1 text-text-muted">Try adjusting your search or filters</p>
        {:else}
          <p class="text-sm">No archived sessions yet</p>
          <p class="text-xs mt-1 text-text-muted">Closed sessions will appear here</p>
        {/if}
      </div>
    {:else}
      {#each $entries as entry (entry.id)}
        <ArchiveEntryItem {entry} ondelete={handleDelete} />
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
