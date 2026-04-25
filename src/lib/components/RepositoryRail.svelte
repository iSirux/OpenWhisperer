<script lang="ts">
  import RepoIcon from '$lib/components/RepoIcon.svelte';
  import { navigation } from '$lib/stores/navigation';
  import { repos } from '$lib/stores/repos';

  interface Props {
    currentRepoId?: string | null;
    showAddMode?: boolean;
    currentView?: string;
  }

  let { currentRepoId = null, showAddMode = false, currentView = '' }: Props = $props();

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
</script>

<div class="repo-rail">
  <div class="repo-rail-scroll">
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
    width: 100%;
    height: 100%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
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

  .rail-divider {
    height: 1px;
    margin: 0.15rem 0.6rem;
    background: var(--color-border);
  }
</style>
