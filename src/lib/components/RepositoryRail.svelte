<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { onDestroy } from 'svelte';
  import RepoIcon from '$lib/components/RepoIcon.svelte';
  import { navigation } from '$lib/stores/navigation';
  import { repos } from '$lib/stores/repos';

  interface Props {
    currentRepoId?: string | null;
    showAddMode?: boolean;
    currentView?: string;
  }

  let { currentRepoId = null, showAddMode = false, currentView = '' }: Props = $props();

  // Number of changed files per repo path (summed across all its worktrees),
  // shown as a badge on the repo icon.
  let changedCounts = $state<Record<string, number>>({});

  async function refreshChangedCounts() {
    const paths = $repos.list.map((r) => r.path).filter((p): p is string => !!p);
    await Promise.all(
      paths.map(async (path) => {
        try {
          const count = await invoke<number>('get_git_changed_count_all_worktrees', {
            repoPath: path,
          });
          changedCounts[path] = count;
        } catch {
          changedCounts[path] = 0;
        }
      })
    );
  }

  // Refresh on mount / repo-list change, then poll so the badge stays live.
  $effect(() => {
    // Touch the list so the effect re-runs when repos are added/removed.
    void $repos.list.length;
    refreshChangedCounts();
  });

  const pollTimer = setInterval(refreshChangedCounts, 15000);
  onDestroy(() => clearInterval(pollTimer));

  function openRepo(repoId: string | null) {
    navigation.showRepository(repoId);
  }

  function openAddRepo() {
    navigation.showRepositoryAdd();
  }

  function toggleNotion() {
    if (currentView === 'notion') {
      navigation.showSessions();
    } else {
      navigation.showNotion();
    }
  }

  function toggleCockpit() {
    if (currentView === 'cockpit') {
      navigation.showSessions();
    } else {
      navigation.showCockpit();
    }
  }
</script>

<div class="repo-rail">
  <div class="repo-rail-scroll">
    <button
      class="rail-btn"
      class:is-active={currentView === 'cockpit'}
      onclick={toggleCockpit}
      title="Cockpit — conduct the fleet by voice"
    >
      <span class="icon-wrap">
        <svg class="cockpit-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M10 2a2 2 0 00-2 2v5a2 2 0 104 0V4a2 2 0 00-2-2z" />
          <path d="M5.5 8.5a.75.75 0 011.5 0 3 3 0 006 0 .75.75 0 011.5 0 4.5 4.5 0 01-3.75 4.437V15h2a.75.75 0 010 1.5h-5.5a.75.75 0 010-1.5h2v-2.063A4.5 4.5 0 015.5 8.5z" />
        </svg>
      </span>
    </button>
    <button
      class="rail-btn"
      class:is-active={currentView === 'notion'}
      onclick={toggleNotion}
      title="Notion Board"
    >
      <span class="icon-wrap">
        <svg class="notion-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z" />
        </svg>
      </span>
    </button>
    <div class="rail-divider"></div>
    {#each $repos.list as repo (repo.id ?? repo.path)}
      <button
        class="rail-btn"
        class:is-active={currentRepoId === repo.id && !showAddMode}
        onclick={() => openRepo(repo.id ?? null)}
        title={repo.name}
      >
        <span class="icon-wrap">
          <RepoIcon {repo} size="lg" />
          {#if changedCounts[repo.path] > 0}
            <span
              class="change-badge"
              title="{changedCounts[repo.path]} file{changedCounts[repo.path] === 1 ? '' : 's'} changed"
            >
              {changedCounts[repo.path] > 99 ? '99+' : changedCounts[repo.path]}
            </span>
          {/if}
        </span>
      </button>
    {/each}
    <button
      class="rail-btn rail-btn-add"
      class:is-active={showAddMode}
      onclick={openAddRepo}
      title="Add repository"
    >
      <span class="icon-wrap add-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v14m7-7H5" />
        </svg>
      </span>
    </button>
  </div>
</div>

<style>
  .repo-rail {
    width: 3.4rem;
    box-sizing: border-box;
    border-right: 1px solid var(--color-border);
    background: color-mix(in srgb, var(--color-surface-elevated) 72%, transparent);
    display: flex;
    flex-direction: column;
    padding: 0;
    flex-shrink: 0;
    overflow: hidden;
  }

  .repo-rail-scroll {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .rail-btn {
    width: 100%;
    height: 3.25rem;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--color-text-secondary);
    transition:
      color 0.16s ease,
      background 0.16s ease;
  }

  .rail-btn:hover {
    background: color-mix(in srgb, var(--color-surface) 88%, transparent);
    color: var(--color-text-primary);
  }

  .rail-btn:focus-visible {
    outline: none;
    background: color-mix(in srgb, var(--color-accent) 10%, var(--color-surface));
  }

  .rail-btn.is-active {
    background: color-mix(in srgb, var(--color-accent) 14%, var(--color-surface));
    color: var(--color-text-primary);
  }

  .icon-wrap {
    position: relative;
    width: 100%;
    height: 100%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .change-badge {
    position: absolute;
    top: 0.15rem;
    right: 0.55rem;
    min-width: 1.05rem;
    height: 1.05rem;
    padding: 0 0.25rem;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.62rem;
    font-weight: 700;
    line-height: 1;
    color: #1a1205;
    background: rgb(251, 191, 36);
    border: 1px solid var(--color-surface-elevated);
    border-radius: 999px;
    pointer-events: none;
  }

  .add-wrap {
    color: var(--color-text-muted);
  }

  .rail-btn-add svg {
    width: 1.35rem;
    height: 1.35rem;
  }

  .notion-icon {
    width: 1.25rem;
    height: 1.25rem;
  }

  .cockpit-icon {
    width: 1.25rem;
    height: 1.25rem;
  }

  .rail-divider {
    height: 1px;
    margin: 0.15rem 0.6rem;
    background: var(--color-border);
  }
</style>
