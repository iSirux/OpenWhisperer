<script lang="ts">
  import { settings, isRepoActive } from '$lib/stores/settings';
  import { isRepoAutoSelectEnabled } from '$lib/utils/llm';
  import RepoIcon from '$lib/components/RepoIcon.svelte';

  interface Props {
    cwd: string;
    onchange: (cwd: string) => void;
    size?: 'sm' | 'md';
  }

  let { cwd, onchange, size = 'sm' }: Props = $props();

  let showDropdown = $state(false);

  const repos = $derived(($settings.repos || []).filter(isRepoActive));
  const autoRepoEnabled = $derived(isRepoAutoSelectEnabled());
  // Treat empty string or '.' as auto mode
  const isAutoMode = $derived(!cwd || cwd === '.');
  const currentRepoName = $derived(() => {
    if (!cwd || cwd === '.') return 'Auto';
    const repo = repos.find(r => r.path === cwd);
    return repo?.name || cwd.split(/[/\\]/).pop() || 'Unknown';
  });

  const sizeClasses = {
    sm: 'px-2 py-1 text-[10px]',
    md: 'px-3 py-1.5 text-xs',
  };

  function handleRepoSelect(path: string) {
    onchange(path);
    showDropdown = false;
  }

  function handleAutoClick() {
    if (autoRepoEnabled) {
      onchange('');
      showDropdown = false;
    } else {
      showDropdown = false;
      window.dispatchEvent(new CustomEvent('open-settings', { detail: { tab: 'llm' } }));
    }
  }

  function handleClickOutside(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (!target.closest('.repo-selector-container')) {
      showDropdown = false;
    }
  }
</script>

<svelte:window onclick={handleClickOutside} />

<div class="repo-selector-container relative">
  <button
    class="flex items-center gap-1.5 {sizeClasses[size]} bg-surface-elevated hover:bg-border rounded font-medium transition-colors"
    onclick={() => showDropdown = !showDropdown}
    title="Select repository"
  >
    {#if isAutoMode && autoRepoEnabled}
      <span class="text-transparent bg-clip-text bg-gradient-to-r from-purple-500 to-amber-500">{currentRepoName()}</span>
    {:else}
      {@const selectedRepo = repos.find(r => r.path === cwd) ?? null}
      <RepoIcon repo={selectedRepo} size="xs" />
      <span class="text-text-primary">{currentRepoName()}</span>
    {/if}
    <svg class="w-3 h-3 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
    </svg>
  </button>

  {#if showDropdown}
    <div class="dropdown absolute bottom-full left-0 mb-1 w-56 bg-surface-elevated border border-border rounded shadow-lg z-50 max-h-64 overflow-y-auto">
      <!-- Auto option -->
      <button
        class="w-full px-3 py-2 text-left text-xs hover:bg-border transition-colors flex items-center justify-between"
        class:bg-gradient-to-r={isAutoMode && autoRepoEnabled}
        class:from-purple-500={isAutoMode && autoRepoEnabled}
        class:to-amber-500={isAutoMode && autoRepoEnabled}
        class:text-white={isAutoMode && autoRepoEnabled}
        onclick={handleAutoClick}
        title={autoRepoEnabled ? "Automatically select repository based on prompt" : "Enable in LLM settings"}
      >
        <span class="flex items-center gap-2">
          <span
            class:text-transparent={autoRepoEnabled && !isAutoMode}
            class:bg-clip-text={autoRepoEnabled && !isAutoMode}
            class:bg-gradient-to-r={autoRepoEnabled && !isAutoMode}
            class:from-purple-500={autoRepoEnabled && !isAutoMode}
            class:to-amber-500={autoRepoEnabled && !isAutoMode}
            class:text-text-muted={!autoRepoEnabled}
          >Auto</span>
          {#if !autoRepoEnabled}
            <span class="text-text-muted text-[10px]">(enable in settings)</span>
          {/if}
        </span>
        {#if isAutoMode && autoRepoEnabled}
          <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
          </svg>
        {/if}
      </button>

      {#if repos.length > 0}
        <div class="border-t border-border"></div>
      {/if}

      {#each repos as repo}
        {@const isSelected = repo.path === cwd}
        <button
          class="w-full px-3 py-2 text-left text-xs hover:bg-border transition-colors flex items-center justify-between"
          class:selected={isSelected}
          onclick={() => handleRepoSelect(repo.path)}
          title={repo.path}
        >
          <div class="flex items-center gap-2 flex-1 min-w-0">
            <RepoIcon repo={repo} size="sm" />
            <div class="flex-1 min-w-0">
              <div class="font-medium truncate">{repo.name}</div>
              {#if repo.description}
                <div class="text-[10px] text-text-muted truncate">{repo.description}</div>
              {/if}
            </div>
          </div>
          {#if isSelected}
            <svg class="w-3 h-3 text-accent flex-shrink-0 ml-2" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
            </svg>
          {/if}
        </button>
      {/each}

      {#if repos.length === 0}
        <div class="px-3 py-2 text-xs text-text-muted">
          No repositories configured
        </div>
      {/if}

      <div class="border-t border-border">
        <button
          class="w-full px-3 py-2 text-left text-xs text-accent hover:bg-border transition-colors"
          onclick={() => {
            showDropdown = false;
            window.dispatchEvent(new CustomEvent('open-settings', { detail: { tab: 'repos' } }));
          }}
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

  .selected {
    background: var(--color-accent);
    color: white;
  }

  .selected:hover {
    background: var(--color-accent);
  }

  .selected .text-text-muted {
    color: rgba(255, 255, 255, 0.7);
  }
</style>
