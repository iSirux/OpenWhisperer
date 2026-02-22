<script lang="ts">
  import type { ArchiveEntry } from '$lib/stores/archive';
  import { getShortModelName, getModelBadgeBgColor, getModelTextColor } from '$lib/utils/modelColors';

  interface Props {
    entry: ArchiveEntry;
    ondelete: (id: string) => void;
  }

  let { entry, ondelete }: Props = $props();

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

  function getTypeBadge(type: string): { label: string; class: string } {
    switch (type) {
      case 'sdk':
        return { label: 'SDK', class: 'bg-accent/20 text-accent' };
      case 'pty':
        return { label: 'PTY', class: 'bg-emerald-500/20 text-emerald-400' };
      case 'sequence':
        return { label: 'Sequence', class: 'bg-indigo-500/20 text-indigo-400' };
      default:
        return { label: type, class: 'bg-text-muted/20 text-text-muted' };
    }
  }

  const typeBadge = $derived(getTypeBadge(entry.sessionType));
</script>

<div class="archive-entry p-3 border-b border-border/50 hover:bg-surface-elevated/50 transition-all group">
  <!-- Header row -->
  <div class="flex items-center justify-between mb-1">
    <div class="flex items-center gap-2 min-w-0 flex-1">
      <!-- Type badge -->
      <span class="px-1.5 py-0.5 text-[10px] font-medium rounded shrink-0 {typeBadge.class}">
        {typeBadge.label}
      </span>

      <!-- Model badge (SDK only) -->
      {#if entry.model && entry.sessionType === 'sdk'}
        <span
          class="px-1.5 py-0.5 text-[10px] font-medium rounded shrink-0"
          style="background-color: {getModelBadgeBgColor(entry.model)}; color: {getModelTextColor(entry.model)};"
        >
          {getShortModelName(entry.model)}
        </span>
      {/if}

      <!-- Date -->
      <span class="text-[10px] text-text-muted shrink-0">
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

  <!-- Repo and message count -->
  <div class="flex items-center gap-2 mt-1">
    {#if entry.repoPath}
      <span class="text-[10px] text-text-muted truncate">
        {getRepoName(entry.repoPath)}
      </span>
    {/if}
    {#if entry.messageCount > 0}
      <span class="text-[10px] text-text-muted">
        {entry.messageCount} msg{entry.messageCount !== 1 ? 's' : ''}
      </span>
    {/if}
    {#if entry.category}
      <span class="text-[10px] text-text-muted px-1 py-0.5 bg-surface-elevated rounded">
        {entry.category}
      </span>
    {/if}
  </div>
</div>
