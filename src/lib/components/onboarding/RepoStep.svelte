<script lang="ts">
  import { onMount } from 'svelte';
  import { repos } from '$lib/stores/repos';

  let newRepoPath = $state('');
  let newRepoName = $state('');
  let adding = $state(false);
  let addError = $state('');

  onMount(() => {
    void repos.load();
  });

  async function browseFolder() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      newRepoPath = selected as string;
      if (!newRepoName) {
        newRepoName = newRepoPath.split(/[/\\]/).pop() || '';
      }
    }
  }

  async function addRepo() {
    const path = newRepoPath.trim();
    const name = newRepoName.trim();
    if (!path || !name) return;
    adding = true;
    addError = '';
    try {
      await repos.addRepo(path, name);
      newRepoPath = '';
      newRepoName = '';
    } catch (e) {
      addError = String(e);
    } finally {
      adding = false;
    }
  }
</script>

<div class="space-y-4">
  {#if $repos.list.length > 0}
    <div class="bg-surface-elevated border border-border rounded-lg divide-y divide-border">
      {#each $repos.list as repo}
        <div class="flex items-center gap-3 p-3">
          <svg class="w-4 h-4 text-success flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path
              fill-rule="evenodd"
              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
              clip-rule="evenodd"
            />
          </svg>
          <div class="min-w-0">
            <p class="text-sm font-medium text-text-primary truncate">{repo.name}</p>
            <p class="text-xs text-text-muted truncate font-mono">{repo.path}</p>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <div class="p-4 bg-surface-elevated border border-border rounded-lg space-y-3">
    <div>
      <label class="block text-sm font-medium text-text-secondary mb-1">Project folder</label>
      <div class="flex gap-2">
        <input
          type="text"
          class="flex-1 min-w-0 px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent font-mono"
          placeholder="C:\path\to\your\project"
          bind:value={newRepoPath}
        />
        <button
          class="px-3 py-2 bg-surface hover:bg-border rounded text-sm transition-colors flex-shrink-0"
          onclick={browseFolder}
        >
          Browse…
        </button>
      </div>
    </div>
    <div>
      <label class="block text-sm font-medium text-text-secondary mb-1">Name</label>
      <input
        type="text"
        class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
        placeholder="my-project"
        bind:value={newRepoName}
      />
    </div>
    <button
      class="px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
      onclick={addRepo}
      disabled={adding || !newRepoPath.trim() || !newRepoName.trim()}
    >
      {adding ? 'Adding…' : 'Add repository'}
    </button>
    {#if addError}
      <p class="text-xs text-error">{addError}</p>
    {/if}
  </div>

  <p class="text-xs text-text-muted">
    You can add more repositories anytime from the rail on the left edge of the app.
  </p>
</div>
