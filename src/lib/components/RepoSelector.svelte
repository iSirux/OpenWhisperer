<script lang="ts">
  import { repos, isRepoActive } from '$lib/stores/repos';
  import { isRepoAutoSelectEnabled } from '$lib/utils/llm';
  import { repoHeat, sortReposByHeat } from '$lib/stores/repoRecency';
  import RepoIcon from '$lib/components/RepoIcon.svelte';

  interface Props {
    cwd: string;
    onchange: (cwd: string) => void;
    size?: 'sm' | 'md';
    /** How many repos show as one-click buttons before overflowing into the dropdown */
    maxVisible?: number;
    /** What the empty selection means: LLM auto-routing ('auto') or unassigned ('none') */
    emptyOption?: 'auto' | 'none';
    dropdownDirection?: 'up' | 'down';
    /** Optional hint shown at the top of the overflow dropdown (e.g. mid-recording notice) */
    notice?: string;
    /** Override for the "+ Add repository" action (defaults to opening repo settings) */
    onAddRepo?: () => void;
    /** Icon-only visible buttons (no repo name label); name still shown as tooltip */
    compact?: boolean;
  }

  let {
    cwd,
    onchange,
    size = 'sm',
    maxVisible = 4,
    emptyOption = 'auto',
    dropdownDirection = 'up',
    notice,
    onAddRepo,
    compact = true,
  }: Props = $props();

  let showDropdown = $state(false);
  let container: HTMLElement | undefined = $state();

  const activeRepos = $derived(($repos.list || []).filter(isRepoActive));
  const autoRepoEnabled = $derived(isRepoAutoSelectEnabled());
  // Treat empty string or '.' as the empty (Auto/None) selection
  const isEmptySelection = $derived(!cwd || cwd === '.');

  // Live heat: every mounted picker reorders as soon as any repo use is
  // recorded (a pick in any selector, a prompt sent to a session).
  const orderedRepos = $derived(sortReposByHeat(activeRepos, $repoHeat));

  // Most recent repos get one-click buttons; the current selection is always
  // swapped into the visible set so the active button never hides in overflow.
  const visibleRepos = $derived.by(() => {
    const visible = orderedRepos.slice(0, maxVisible);
    if (!isEmptySelection && !visible.some((r) => r.path === cwd)) {
      const selected = orderedRepos.find((r) => r.path === cwd);
      if (selected) {
        if (visible.length >= maxVisible) visible[visible.length - 1] = selected;
        else visible.push(selected);
      }
    }
    return visible;
  });
  const overflowRepos = $derived(orderedRepos.filter((r) => !visibleRepos.includes(r)));

  // cwd pointing outside the configured repos (e.g. a worktree or ad-hoc path)
  const unknownSelectionName = $derived.by(() => {
    if (isEmptySelection || activeRepos.some((r) => r.path === cwd)) return null;
    return cwd.split(/[/\\]/).pop() || cwd;
  });

  const sizeClasses = {
    sm: 'px-2 py-1 text-[10px]',
    md: 'px-3 py-1.5 text-xs',
  };

  function selectRepo(path: string) {
    onchange(path);
    showDropdown = false;
  }

  function handleEmptyClick() {
    if (emptyOption === 'none' || autoRepoEnabled) {
      onchange('');
      showDropdown = false;
    } else {
      showDropdown = false;
      window.dispatchEvent(new CustomEvent('open-settings', { detail: { tab: 'llm' } }));
    }
  }

  function handleAddRepo() {
    showDropdown = false;
    if (onAddRepo) {
      onAddRepo();
    } else {
      window.dispatchEvent(new CustomEvent('open-settings', { detail: { tab: 'repos' } }));
    }
  }

  function handleClickOutside(event: MouseEvent) {
    if (showDropdown && container && !container.contains(event.target as Node)) {
      showDropdown = false;
    }
  }
</script>

<svelte:window onclick={handleClickOutside} />

<div class="repo-selector-container relative inline-block" bind:this={container}>
  <div class="inline-flex items-center gap-0.5 flex-wrap bg-surface-elevated rounded p-0.5">
    <!-- Empty selection: Auto (LLM routing) or None (unassigned) -->
    {#if emptyOption === 'auto'}
      <button
        class="{sizeClasses[size]} rounded font-medium transition-colors {isEmptySelection && autoRepoEnabled
          ? 'bg-gradient-to-r from-purple-500 to-amber-500 text-white'
          : autoRepoEnabled
            ? 'text-transparent bg-clip-text bg-gradient-to-r from-purple-500 to-amber-500 hover:brightness-125'
            : 'text-text-muted hover:bg-border'}"
        onclick={handleEmptyClick}
        title={autoRepoEnabled
          ? 'Automatically select repository based on prompt'
          : 'Auto repo selection is off — click to enable in LLM settings'}
      >
        Auto
      </button>
    {:else}
      <button
        class="{sizeClasses[size]} rounded font-medium transition-colors {isEmptySelection
          ? 'bg-border text-text-primary'
          : 'text-text-muted hover:bg-border'}"
        onclick={handleEmptyClick}
        title="No repository"
      >
        None
      </button>
    {/if}

    {#each visibleRepos as repo (repo.path)}
      {@const isSelected = repo.path === cwd}
      <button
        class="{sizeClasses[size]} rounded font-medium transition-colors flex items-center gap-1.5 {isSelected
          ? 'repo-chip-selected'
          : 'text-text-secondary hover:bg-border hover:text-text-primary'}"
        onclick={() => selectRepo(repo.path)}
        title={compact ? `${repo.name} — ${repo.path}` : repo.path}
      >
        <RepoIcon {repo} size="xs" />
        {#if !compact}
          <span class="max-w-32 truncate">{repo.name}</span>
        {/if}
      </button>
    {/each}

    {#if unknownSelectionName}
      <span
        class="{sizeClasses[size]} rounded font-medium flex items-center gap-1.5 repo-chip-selected"
        title={cwd}
      >
        <span class="max-w-32 truncate">{unknownSelectionName}</span>
      </span>
    {/if}

    <!-- Overflow / more -->
    <button
      class="{sizeClasses[size]} rounded font-medium transition-colors text-text-muted hover:bg-border hover:text-text-primary"
      onclick={() => (showDropdown = !showDropdown)}
      title={overflowRepos.length > 0 ? `${overflowRepos.length} more repositories` : 'More options'}
    >
      {overflowRepos.length > 0 ? `+${overflowRepos.length}` : '⋯'}
    </button>
  </div>

  {#if showDropdown}
    <div
      class="dropdown absolute {dropdownDirection === 'up'
        ? 'bottom-full mb-1'
        : 'top-full mt-1'} left-0 w-56 bg-surface-elevated border border-border rounded shadow-lg z-50 max-h-64 overflow-y-auto"
    >
      {#if notice}
        <div class="px-3 py-2 border-b border-border text-xs text-recording flex items-center gap-2">
          <div class="w-1.5 h-1.5 bg-recording rounded-full animate-pulse flex-shrink-0"></div>
          <span>{notice}</span>
        </div>
      {/if}

      {#each overflowRepos as repo (repo.path)}
        <button
          class="w-full px-3 py-2 text-left text-xs hover:bg-border transition-colors flex items-center gap-2"
          onclick={() => selectRepo(repo.path)}
          title={repo.path}
        >
          <RepoIcon {repo} size="sm" />
          <div class="flex-1 min-w-0">
            <div class="font-medium truncate">{repo.name}</div>
            {#if repo.description}
              <div class="text-[10px] text-text-muted truncate">{repo.description}</div>
            {/if}
          </div>
        </button>
      {/each}

      {#if activeRepos.length === 0}
        <div class="px-3 py-2 text-xs text-text-muted">No repositories configured</div>
      {:else if overflowRepos.length === 0}
        <div class="px-3 py-2 text-xs text-text-muted">All repositories shown</div>
      {/if}

      <div class="border-t border-border">
        <button
          class="w-full px-3 py-2 text-left text-xs text-accent hover:bg-border transition-colors"
          onclick={handleAddRepo}
        >
          + Add repository
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .dropdown {
    scrollbar-width: thin;
  }

  .repo-chip-selected {
    background: var(--color-accent);
    color: white;
  }
</style>
