<script lang="ts">
  import type { RepoConfig } from '$lib/stores/repos';
  import RepoIcon from '$lib/components/RepoIcon.svelte';

  interface Props {
    repos: RepoConfig[];
    recommendedIndex: number | null;
    reasoning: string;
    confidence: string;
    onSelect: (index: number) => void;
    onCancel: () => void;
  }

  let { repos, recommendedIndex, reasoning, confidence, onSelect, onCancel }: Props = $props();

  function getConfidenceColor(conf: string): string {
    switch (conf) {
      case 'high':
        return 'text-success';
      case 'medium':
        return 'text-warning';
      case 'low':
        return 'text-error';
      default:
        return 'text-text-muted';
    }
  }
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
  <div class="bg-surface border border-border rounded-lg shadow-xl max-w-md w-full mx-4 max-h-[80vh] flex flex-col">
    <!-- Header -->
    <div class="px-4 py-3 border-b border-border">
      <h2 class="text-lg font-semibold text-text-primary">Select Repository</h2>
      <p class="text-sm text-text-muted mt-1">
        {#if recommendedIndex !== null}
          Suggested: <span class="font-medium text-text-primary">{repos[recommendedIndex]?.name}</span>
          <span class="ml-1 {getConfidenceColor(confidence)}">({confidence} confidence)</span>
        {:else}
          Unable to determine best match
        {/if}
      </p>
      {#if reasoning}
        <p class="text-xs text-text-muted mt-1 italic">{reasoning}</p>
      {/if}
    </div>

    <!-- Repo List -->
    <div class="flex-1 overflow-y-auto p-2">
      <div class="space-y-1">
        {#each repos as repo, index}
          {@const isRecommended = index === recommendedIndex}
          <button
            class="w-full text-left p-3 rounded-lg border-2 transition-all hover:bg-surface-elevated {isRecommended ? 'border-accent bg-accent/5' : 'border-border'}"
            onclick={() => onSelect(index)}
          >
            <div class="flex items-start gap-3">
              <div class="shrink-0 mt-0.5">
                <RepoIcon repo={repo} size="xs" />
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="font-medium text-sm text-text-primary">{repo.name}</span>
                  {#if isRecommended}
                    <span class="text-xs px-1.5 py-0.5 bg-accent/20 text-accent rounded">Suggested</span>
                  {/if}
                </div>
                <div class="text-xs text-text-muted truncate mt-0.5">{repo.path}</div>
                {#if repo.description}
                  <div class="text-xs text-text-secondary mt-1 line-clamp-2">{repo.description}</div>
                {/if}
              </div>
            </div>
          </button>
        {/each}
      </div>
    </div>

    <!-- Footer -->
    <div class="px-4 py-3 border-t border-border flex justify-end gap-2">
      <button
        class="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface-elevated rounded transition-colors"
        onclick={onCancel}
      >
        Cancel
      </button>
      {#if recommendedIndex !== null}
        <button
          class="px-4 py-2 text-sm bg-accent hover:bg-accent-hover text-white rounded transition-colors"
          onclick={() => onSelect(recommendedIndex)}
        >
          Use Suggested
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .line-clamp-2 {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
