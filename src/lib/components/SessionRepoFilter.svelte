<script lang="ts">
  import { repos, isRepoActive, type RepoConfig } from '$lib/stores/repos';
  import { repoHeat, sortReposByHeat } from '$lib/stores/repoRecency';
  import {
    sessionRepoFilter,
    toggleRepoFilter,
    clearRepoFilter,
    repoFilterKey,
    reposWithSessions,
  } from '$lib/stores/sessionRepoFilter';
  import RepoIcon from '$lib/components/RepoIcon.svelte';
  import type { DisplaySession } from '$lib/types/session';

  interface Props {
    /** The (unfiltered) session list; only repos with sessions get a chip */
    sessions: DisplaySession[];
  }

  let { sessions }: Props = $props();

  let showDropdown = $state(false);
  let container: HTMLElement | undefined = $state();
  let rowWidth = $state(0);

  const activeRepos = $derived(($repos.list || []).filter(isRepoActive));
  const selectedKeys = $derived(new Set($sessionRepoFilter));
  // Only repos that actually own a session in the list are offered — plus any
  // still-selected repo whose last session closed, so it can be untoggled.
  const availableRepos = $derived.by(() => {
    const open = new Set(reposWithSessions(sessions, activeRepos));
    return activeRepos.filter((r) => open.has(r) || selectedKeys.has(repoFilterKey(r)));
  });
  const orderedRepos = $derived(sortReposByHeat(availableRepos, $repoHeat));

  // Fill the full row width with one-click icon chips; the rest overflows
  // into the dropdown. Widths match the rendered chip sizes below.
  const ALL_CHIP_WIDTH = 36;
  const MORE_CHIP_WIDTH = 34;
  const REPO_CHIP_WIDTH = 30; // icon chip incl. gap
  const maxVisible = $derived(
    Math.max(1, Math.floor((rowWidth - ALL_CHIP_WIDTH - MORE_CHIP_WIDTH) / REPO_CHIP_WIDTH))
  );

  // Hottest repos get the visible chips, but selected repos are promoted so an
  // active filter never hides entirely in the overflow.
  const visibleRepos = $derived.by(() => {
    const visible = orderedRepos.slice(0, maxVisible);
    const promoted = orderedRepos.filter(
      (r) => selectedKeys.has(repoFilterKey(r)) && !visible.includes(r)
    );
    for (const repo of promoted) {
      if (visible.length < maxVisible) {
        visible.push(repo);
        continue;
      }
      for (let i = visible.length - 1; i >= 0; i--) {
        if (!selectedKeys.has(repoFilterKey(visible[i]))) {
          visible[i] = repo;
          break;
        }
      }
    }
    return visible;
  });
  const overflowRepos = $derived(orderedRepos.filter((r) => !visibleRepos.includes(r)));
  const overflowSelectedCount = $derived(
    overflowRepos.filter((r) => selectedKeys.has(repoFilterKey(r))).length
  );

  function isSelected(repo: RepoConfig): boolean {
    return selectedKeys.has(repoFilterKey(repo));
  }

  function handleClickOutside(event: MouseEvent) {
    if (showDropdown && container && !container.contains(event.target as Node)) {
      showDropdown = false;
    }
  }
</script>

<svelte:window onclick={handleClickOutside} />

{#if availableRepos.length > 1 || selectedKeys.size > 0}
  <div class="relative border-b border-border" bind:this={container}>
    <div
      class="flex items-center gap-0.5 px-1.5 py-1 overflow-hidden"
      bind:clientWidth={rowWidth}
      role="group"
      aria-label="Filter sessions by repository"
    >
      <button
        class="px-2 py-1 text-[10px] rounded font-medium transition-colors shrink-0 {selectedKeys.size === 0
          ? 'bg-border text-text-primary'
          : 'text-text-muted hover:bg-border hover:text-text-primary'}"
        onclick={clearRepoFilter}
        title="Show sessions from all repositories"
      >
        All
      </button>

      {#each visibleRepos as repo (repo.path)}
        <button
          class="px-2 py-1 rounded transition-colors shrink-0 flex items-center {isSelected(repo)
            ? 'filter-chip-selected'
            : 'text-text-secondary hover:bg-border hover:text-text-primary'}"
          onclick={() => toggleRepoFilter(repoFilterKey(repo))}
          title={isSelected(repo)
            ? `${repo.name} — click to remove from filter`
            : `${repo.name} — click to show only these sessions`}
          aria-pressed={isSelected(repo)}
        >
          <RepoIcon {repo} size="xs" />
        </button>
      {/each}

      {#if overflowRepos.length > 0}
        <button
          class="px-2 py-1 text-[10px] rounded font-medium transition-colors shrink-0 relative {overflowSelectedCount > 0
            ? 'text-accent hover:bg-border'
            : 'text-text-muted hover:bg-border hover:text-text-primary'}"
          onclick={() => (showDropdown = !showDropdown)}
          title="{overflowRepos.length} more repositories{overflowSelectedCount > 0
            ? ` (${overflowSelectedCount} in filter)`
            : ''}"
        >
          +{overflowRepos.length}
        </button>
      {/if}
    </div>

    {#if showDropdown}
      <div
        class="dropdown absolute top-full mt-1 left-1.5 right-1.5 bg-surface-elevated border border-border rounded shadow-lg z-50 max-h-64 overflow-y-auto"
      >
        {#each overflowRepos as repo (repo.path)}
          <button
            class="w-full px-3 py-2 text-left text-xs hover:bg-border transition-colors flex items-center gap-2"
            onclick={() => toggleRepoFilter(repoFilterKey(repo))}
            title={repo.path}
            aria-pressed={isSelected(repo)}
          >
            <RepoIcon {repo} size="sm" />
            <span class="flex-1 min-w-0 font-medium truncate">{repo.name}</span>
            {#if isSelected(repo)}
              <svg class="w-3.5 h-3.5 text-accent shrink-0" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .dropdown {
    scrollbar-width: thin;
  }

  .filter-chip-selected {
    background: var(--color-accent);
    color: white;
  }
</style>
