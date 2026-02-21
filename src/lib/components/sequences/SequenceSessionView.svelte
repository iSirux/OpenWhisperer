<script lang="ts">
  import type { SequenceExecution, NodeDefinition } from '$lib/types/sequence';
  import { getStatusString, isTerminal, getProgress, pauseExecution, resumeExecution, cancelExecution } from '$lib/stores/sequenceExecutions';
  import SequenceNodeRow from './SequenceNodeRow.svelte';

  interface Props {
    execution: SequenceExecution;
    nodes: NodeDefinition[];
  }
  let { execution, nodes }: Props = $props();

  let statusStr = $derived(getStatusString(execution.status));
  let progress = $derived(getProgress(execution));
  let terminal = $derived(isTerminal(execution.status));
  let logsExpanded = $state(false);

  let elapsed = $derived.by(() => {
    if (!execution.started_at) return '';
    const start = new Date(execution.started_at).getTime();
    const end = execution.completed_at ? new Date(execution.completed_at).getTime() : Date.now();
    const secs = Math.floor((end - start) / 1000);
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
    return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  });

  // Identify compound nodes (parallel/foreach/loop) for visual grouping
  const COMPOUND_TYPES = new Set(['parallel', 'for_each', 'loop', 'sub_sequence']);
  let isCompoundNode = (type: string) => COMPOUND_TYPES.has(type);

  // Log level color classes
  function logLevelClass(level: string): string {
    switch (level) {
      case 'error': return 'text-red-400';
      case 'warn': return 'text-yellow-400';
      case 'debug': return 'text-gray-500';
      default: return 'text-text-secondary';
    }
  }
</script>

<div class="flex flex-col h-full">
  <!-- Header -->
  <header class="flex items-center justify-between px-4 py-3 border-b border-border bg-surface-elevated">
    <div class="flex items-center gap-3">
      <div class="flex items-center gap-2">
        <svg class="w-5 h-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
        </svg>
        <h2 class="text-lg font-semibold text-text-primary">{execution.sequence_name}</h2>
      </div>
      <!-- Status badge -->
      <span class="px-2 py-0.5 text-xs rounded-full font-medium {statusStr === 'running' ? 'bg-blue-500/20 text-blue-400' : statusStr === 'completed' ? 'bg-green-500/20 text-green-400' : statusStr === 'failed' ? 'bg-red-500/20 text-red-400' : statusStr === 'paused' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-gray-500/20 text-gray-400'}"
      >
        {statusStr}
      </span>
      <!-- Currently running node indicator -->
      {#if execution.current_node_id && !terminal}
        <span class="text-xs text-text-muted">
          Running: {nodes.find(n => n.id === execution.current_node_id)?.name || execution.current_node_id}
        </span>
      {/if}
    </div>

    <div class="flex items-center gap-2">
      <!-- Timing -->
      <span class="text-xs text-text-muted">{elapsed}</span>

      <!-- Progress -->
      <span class="text-xs text-text-muted">{execution.completed_node_ids.length}/{execution.total_nodes}</span>

      <!-- Controls -->
      {#if !terminal}
        {#if statusStr === 'running'}
          <button class="px-2 py-1 text-xs rounded bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 transition-colors"
            onclick={() => pauseExecution(execution.id)}>
            Pause
          </button>
        {:else if statusStr === 'paused'}
          <button class="px-2 py-1 text-xs rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors"
            onclick={() => resumeExecution(execution.id)}>
            Resume
          </button>
        {/if}
        <button class="px-2 py-1 text-xs rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
          onclick={() => cancelExecution(execution.id)}>
          Cancel
        </button>
      {/if}
    </div>
  </header>

  <!-- Progress bar -->
  <div class="h-1 bg-border">
    <div class="h-full bg-accent transition-all duration-300" style="width: {progress}%"></div>
  </div>

  <!-- Node list -->
  <div class="flex-1 overflow-y-auto p-4 space-y-1">
    {#each nodes as node (node.id)}
      {#if isCompoundNode(node.type)}
        <!-- Compound node with visual grouping indicator -->
        <div class="relative">
          <div class="absolute left-1.5 top-8 bottom-0 w-px bg-accent/20"></div>
          <SequenceNodeRow
            {node}
            result={execution.node_results[node.id]}
            isCurrent={execution.current_node_id === node.id}
            executionId={execution.id}
          />
        </div>
      {:else}
        <SequenceNodeRow
          {node}
          result={execution.node_results[node.id]}
          isCurrent={execution.current_node_id === node.id}
          executionId={execution.id}
        />
      {/if}
    {/each}
  </div>

  <!-- Log panel -->
  {#if execution.log.length > 0}
    <div class="border-t border-border">
      <button
        class="w-full flex items-center justify-between px-4 py-1.5 text-xs text-text-muted hover:bg-surface-elevated/50 transition-colors"
        onclick={() => logsExpanded = !logsExpanded}
      >
        <span class="flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5 transition-transform" class:rotate-90={logsExpanded}
            fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
          Logs ({execution.log.length})
        </span>
      </button>
      {#if logsExpanded}
        <div class="max-h-48 overflow-y-auto px-4 pb-2 space-y-0.5">
          {#each execution.log as entry}
            <div class="flex gap-2 text-[11px] font-mono leading-relaxed {logLevelClass(entry.level)}">
              <span class="text-text-muted flex-shrink-0 w-[70px]">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </span>
              {#if entry.node_id}
                <span class="text-accent flex-shrink-0 max-w-[100px] truncate">[{entry.node_id}]</span>
              {/if}
              <span class="break-all">{entry.message}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Footer: usage summary -->
  {#if execution.total_cost > 0}
    <footer class="flex items-center justify-between px-4 py-2 border-t border-border text-xs text-text-muted">
      <span>{execution.total_tokens.input_tokens + execution.total_tokens.output_tokens} tokens</span>
      <span>${execution.total_cost.toFixed(4)}</span>
    </footer>
  {/if}
</div>
