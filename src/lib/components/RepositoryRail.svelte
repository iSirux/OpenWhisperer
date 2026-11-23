<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { onDestroy } from 'svelte';
  import RepoIcon from '$lib/components/RepoIcon.svelte';
  import { navigation } from '$lib/stores/navigation';
  import { repos } from '$lib/stores/repos';
  import { settings } from '$lib/stores/settings';
  import { modifierCombo } from '$lib/stores/ctrlHint';
  import { createAndActivateNewSession } from '$lib/utils/sessionCreation';

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

  // Ctrl/Cmd+click (or middle-click) starts a new session in that repo
  // instead of opening the repository view.
  function handleRepoClick(event: MouseEvent, repo: { id?: string | null; path: string }) {
    if (suppressClick) return;
    if (event.ctrlKey || event.metaKey) {
      void createAndActivateNewSession(repo.path);
    } else {
      openRepo(repo.id ?? null);
    }
  }

  function handleRepoAuxClick(event: MouseEvent, repo: { path: string }) {
    if (event.button === 1) {
      void createAndActivateNewSession(repo.path);
    }
  }

  // Drag-to-reorder repos within the rail. Pointer-event based rather than HTML5
  // drag-and-drop: Tauri's native file-drop handler (dragDropEnabled, on by
  // default) swallows HTML5 dragover/drop events in the Windows webview.
  const DRAG_THRESHOLD_PX = 5;
  const AUTO_SCROLL_EDGE_PX = 28;

  let scrollEl = $state<HTMLDivElement | null>(null);

  // Index of the repo being dragged (set once the pointer passes the threshold).
  let dragIndex = $state<number | null>(null);
  // Insertion position: the dragged repo would land *before* the repo at this index.
  let dropIndex = $state<number | null>(null);

  let pressIndex: number | null = null;
  let pressY = 0;
  // A completed drag ends with a click on whatever is under the pointer; swallow it.
  let suppressClick = false;

  function handlePointerDown(event: PointerEvent, index: number) {
    if (event.button !== 0) return;
    pressIndex = index;
    pressY = event.clientY;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', cancelDrag);
    window.addEventListener('keydown', handleDragKeydown);
  }

  function computeDropIndex(clientY: number): number {
    const buttons = scrollEl?.querySelectorAll<HTMLElement>('[data-repo-index]') ?? [];
    for (const el of buttons) {
      const rect = el.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return Number(el.dataset.repoIndex);
    }
    return $repos.list.length;
  }

  function autoScroll(clientY: number) {
    if (!scrollEl) return;
    const rect = scrollEl.getBoundingClientRect();
    if (clientY < rect.top + AUTO_SCROLL_EDGE_PX) scrollEl.scrollBy({ top: -12 });
    else if (clientY > rect.bottom - AUTO_SCROLL_EDGE_PX) scrollEl.scrollBy({ top: 12 });
  }

  function handlePointerMove(event: PointerEvent) {
    if (pressIndex === null) return;
    if (dragIndex === null) {
      if (Math.abs(event.clientY - pressY) < DRAG_THRESHOLD_PX) return;
      dragIndex = pressIndex;
      document.body.classList.add('repo-rail-dragging');
    }
    event.preventDefault();
    autoScroll(event.clientY);
    dropIndex = computeDropIndex(event.clientY);
  }

  function handlePointerUp() {
    if (dragIndex !== null && dropIndex !== null) {
      // Dropping at an insertion point after the dragged item shifts down by one
      // once the item is removed from its original position.
      const target = dropIndex > dragIndex ? dropIndex - 1 : dropIndex;
      if (target !== dragIndex) void repos.moveRepo(dragIndex, target);
    }
    if (dragIndex !== null) {
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
    }
    cancelDrag();
  }

  function handleDragKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && dragIndex !== null) {
      event.preventDefault();
      cancelDrag();
    }
  }

  function cancelDrag() {
    pressIndex = null;
    dragIndex = null;
    dropIndex = null;
    document.body.classList.remove('repo-rail-dragging');
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('pointercancel', cancelDrag);
    window.removeEventListener('keydown', handleDragKeydown);
  }

  onDestroy(cancelDrag);

  function openAddRepo() {
    navigation.showRepositoryAdd();
  }

  function toggleBoard() {
    if (currentView === 'board') {
      navigation.showSessions();
    } else {
      navigation.showBoard();
    }
  }

  function toggleSpareTokens() {
    if (currentView === 'sparetokens') {
      navigation.showSessions();
    } else {
      navigation.showSpareTokens();
    }
  }
</script>

<div class="repo-rail">
  <div class="repo-rail-scroll" bind:this={scrollEl}>
    {#if $settings.system.dev_mode}
      <button
        class="rail-btn"
        class:is-active={currentView === 'board'}
        onclick={toggleBoard}
        title="Brainant Board"
      >
        <span class="icon-wrap">
          <svg class="notion-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z" />
          </svg>
        </span>
      </button>
    {/if}
    <button
      class="rail-btn"
      class:is-active={currentView === 'sparetokens'}
      onclick={toggleSpareTokens}
      title="Spare Tokens"
    >
      <span class="icon-wrap">
        <svg class="sparetokens-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <rect x="2" y="7" width="18" height="10" rx="2" stroke-width="2" />
          <path stroke-linecap="round" stroke-width="2" d="M22 10v4" />
          <rect x="5" y="10" width="6" height="4" rx="1" fill="currentColor" stroke="none" />
        </svg>
      </span>
    </button>
    <div class="rail-divider"></div>
    {#each $repos.list as repo, index (repo.id ?? repo.path)}
      <button
        class="rail-btn"
        class:is-active={currentRepoId === repo.id && !showAddMode}
        class:is-dragging={dragIndex === index}
        class:drop-before={dropIndex === index && dragIndex !== null}
        class:drop-after={dropIndex === index + 1 && index === $repos.list.length - 1 && dragIndex !== null}
        data-repo-index={index}
        onpointerdown={(e) => handlePointerDown(e, index)}
        onclick={(e) => handleRepoClick(e, repo)}
        onauxclick={(e) => handleRepoAuxClick(e, repo)}
        title="{repo.name}&#10;Ctrl+Click or Middle-Click: new session{index < 9
          ? `\nCtrl+Shift+${index + 1}: new session`
          : ''}&#10;Drag to reorder"
      >
        {#if index < 9 && $modifierCombo === 'ctrl+shift'}
          <span class="hotkey-number-badge" aria-hidden="true">{index + 1}</span>
        {/if}
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
    position: relative;
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

  /* Ctrl+Shift+number hint, mirrors SessionListItem's Ctrl+number badge. */
  .hotkey-number-badge {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 1.5rem;
    height: 1.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-accent);
    color: white;
    border-radius: 0.375rem;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 0.8rem;
    font-weight: 700;
    z-index: 5;
    pointer-events: none;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
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

  .sparetokens-icon {
    width: 1.35rem;
    height: 1.35rem;
  }

  .rail-btn.is-dragging {
    opacity: 0.4;
  }

  :global(body.repo-rail-dragging),
  :global(body.repo-rail-dragging *) {
    cursor: grabbing !important;
    user-select: none !important;
  }

  .rail-btn.drop-before {
    box-shadow: inset 0 2px 0 0 var(--color-accent);
  }

  .rail-btn.drop-after {
    box-shadow: inset 0 -2px 0 0 var(--color-accent);
  }

  .rail-divider {
    height: 1px;
    margin: 0.15rem 0.6rem;
    background: var(--color-border);
  }
</style>
