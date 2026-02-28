<script lang="ts">
  import type { ArchiveEntry } from '$lib/stores/archive';
  import type { RepoConfig } from '$lib/stores/repos';
  import RepoIcon from './RepoIcon.svelte';
  import { getShortModelName, getModelBadgeBgColor, getModelTextColor } from '$lib/utils/modelColors';

  interface Props {
    entry: ArchiveEntry;
    repo?: RepoConfig | null;
    ondelete: (id: string) => void;
    onrestore: (id: string) => void;
    restoring?: boolean;
  }

  let { entry, repo = null, ondelete, onrestore, restoring = false }: Props = $props();

  function formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
    return date.toLocaleDateString();
  }

  function formatTimestamp(timestamp: number): string {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleString();
  }

  function formatShortTimestamp(timestamp: number): string {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function formatDuration(ms: number): string {
    if (!ms || ms <= 0) return '';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  function formatCost(cost: number | undefined): string {
    if (!cost || cost <= 0) return '';
    if (cost < 0.01) return '<$0.01';
    return `$${cost.toFixed(2)}`;
  }

  function getRepoName(path: string | undefined): string {
    if (!path) return '';
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || '';
  }
  const isRestorable = $derived(entry.sessionType === 'sdk');
</script>

<div class="archive-entry p-3 border-b border-border/50 hover:bg-surface-elevated/50 transition-all group">
  <!-- Header row -->
  <div class="flex items-center justify-between mb-1">
    <div class="flex items-center gap-2 min-w-0 flex-1">
      {#if entry.model}
        <span
          class="px-1.5 py-0.5 text-[10px] font-medium rounded shrink-0"
          style="background-color: {getModelBadgeBgColor(entry.model)}; color: {getModelTextColor(entry.model)};"
        >
          {getShortModelName(entry.model)}
        </span>
      {/if}

      <!-- Date -->
      <span class="text-[10px] text-text-muted shrink-0" title={formatTimestamp(entry.archivedAt)}>
        {formatDate(entry.archivedAt)}
      </span>

      <!-- Duration -->
      {#if entry.durationMs > 0}
        <span class="text-[10px] text-text-muted shrink-0">
          {formatDuration(entry.durationMs)}
        </span>
      {/if}

      <!-- Cost -->
      {#if entry.totalCost && entry.totalCost > 0}
        <span class="text-[10px] text-text-muted shrink-0">
          {formatCost(entry.totalCost)}
        </span>
      {/if}
    </div>

    <!-- Action buttons -->
    <div class="flex items-center gap-1">
      <!-- Restore button (SDK only) -->
      {#if isRestorable}
        <button
          class="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-accent/20 hover:text-accent transition-all shrink-0"
          title="Restore to active sessions"
          disabled={restoring}
          onclick={(e) => {
            e.stopPropagation();
            onrestore(entry.id);
          }}
        >
          {#if restoring}
            <div class="w-3.5 h-3.5 border-2 border-accent/30 border-t-accent rounded-full animate-spin"></div>
          {:else}
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M3 10h10a5 5 0 010 10H9m-6-10l4-4m-4 4l4 4" />
            </svg>
          {/if}
        </button>
      {/if}

      <!-- Delete button -->
      <button
        class="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-error/20 hover:text-error transition-all shrink-0"
        title="Delete from archive"
        onclick={(e) => {
          e.stopPropagation();
          ondelete(entry.id);
        }}
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </button>
    </div>
  </div>

  <!-- Name / prompt -->
  <div class="text-sm text-text-primary truncate">
    {#if entry.name}
      {entry.name}
    {:else if entry.prompt}
      <span class="text-text-secondary">{entry.prompt}</span>
    {:else}
      <span class="text-text-muted italic">No title</span>
    {/if}
  </div>

  <!-- AI summary -->
  {#if entry.summary}
    <div class="mt-1 text-xs text-text-secondary line-clamp-2">
      {entry.summary}
    </div>
  {/if}

  <!-- Repo and metadata -->
  <div class="flex items-center gap-2 mt-1 min-w-0">
    {#if entry.repoPath}
      <div class="flex items-center gap-1.5 min-w-0">
        <RepoIcon repo={repo} size="xs" />
        <span class="text-[10px] text-text-muted truncate">
          {repo?.name ?? getRepoName(entry.repoPath)}
        </span>
      </div>
    {/if}
    {#if entry.messageCount > 0}
      <span class="text-[10px] text-text-muted">
        {entry.messageCount} msg{entry.messageCount !== 1 ? 's' : ''}
      </span>
    {/if}
    <span class="text-[10px] text-text-muted" title={formatTimestamp(entry.archivedAt)}>
      Archived {formatShortTimestamp(entry.archivedAt)}
    </span>
    <span class="text-[10px] text-text-muted" title={formatTimestamp(entry.createdAt)}>
      Created {formatShortTimestamp(entry.createdAt)}
    </span>
    {#if entry.category}
      <span class="text-[10px] text-text-muted px-1 py-0.5 bg-surface-elevated rounded">
        {entry.category}
      </span>
    {/if}
  </div>
</div>
