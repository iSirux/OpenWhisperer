<script lang="ts">
  import { get } from 'svelte/store';
  import type { NodeDefinition, NodeResult } from '$lib/types/sequence';
  import { approveNode, rejectNode, retryNode, activeExecutionId, executions } from '$lib/stores/sequenceExecutions';
  import { sdkSessions, activeSdkSessionId } from '$lib/stores/sdkSessions';

  interface Props {
    node: NodeDefinition;
    result?: NodeResult;
    isCurrent: boolean;
    executionId: string;
  }
  let { node, result, isCurrent, executionId }: Props = $props();

  let status = $derived(result?.status ?? 'pending');
  let expanded = $state(false);

  // A prompt node's captured, resumable run can be reopened as a real SDK session.
  let sessionCapture = $derived(node.type === 'prompt' ? result?.session : undefined);
  let canOpenSession = $derived(!!sessionCapture?.sdk_session_id);

  function openSession() {
    if (!sessionCapture?.sdk_session_id) return;
    const exec = get(executions).find((e) => e.id === executionId);
    const id = sdkSessions.openSequenceNodeSession({
      executionId,
      nodeId: node.id,
      sequenceName: exec?.sequence_name,
      nodeName: node.name || node.id,
      capture: sessionCapture,
      durationMs: result?.duration_ms,
      tokens: result?.tokens,
      cost: result?.cost,
    });
    if (!id) return;
    activeExecutionId.set(null);
    activeSdkSessionId.set(id);
    sdkSessions.markAsRead(id);
    window.dispatchEvent(new CustomEvent('switch-to-sessions'));
  }

  // Status icons
  let statusIcon = $derived.by(() => {
    switch (status) {
      case 'pending': return '\u25CB';
      case 'running': return '\u25CF';
      case 'completed': return '\u2713';
      case 'failed': return '\u2717';
      case 'skipped': return '\u2298';
      case 'waiting_approval': return '\u23F8';
      case 'retrying': return '\u21BB';
      default: return '\u25CB';
    }
  });

  let nodeTypeLabel = $derived.by(() => {
    return node.type?.replace(/_/g, ' ') ?? 'unknown';
  });

  // Node type badge classes by category
  const AI_NODES = new Set(['prompt', 'route']);
  const GIT_NODES = new Set(['git_branch', 'git_worktree', 'git_commit', 'git_push', 'git_checkout', 'git_merge', 'git_pull', 'git_stash']);
  const GITHUB_NODES = new Set(['github_pr', 'github_pr_wait', 'github_pr_merge']);
  const CONTROL_NODES = new Set(['approval', 'wait', 'loop', 'parallel', 'for_each']);
  const ACTION_NODES = new Set(['script', 'notify', 'delay', 'file', 'http', 'transform']);

  let typeBadgeClasses = $derived.by(() => {
    const t = node.type;
    if (AI_NODES.has(t)) return 'bg-blue-500/15 text-blue-400';
    if (GIT_NODES.has(t)) return 'bg-green-500/15 text-green-400';
    if (GITHUB_NODES.has(t)) return 'bg-purple-500/15 text-purple-400';
    if (CONTROL_NODES.has(t)) return 'bg-yellow-500/15 text-yellow-400';
    if (ACTION_NODES.has(t)) return 'bg-orange-500/15 text-orange-400';
    return 'bg-surface-elevated text-text-muted';
  });

  // Loop iteration info from output
  let loopIterationText = $derived.by(() => {
    if (!result?.output || typeof result.output !== 'object') return '';
    const out = result.output as Record<string, unknown>;
    if (out.current_iteration != null && out.max_iterations != null) {
      return `Iteration ${out.current_iteration}/${out.max_iterations}`;
    }
    if (out.iterations != null) {
      return `${out.iterations} iterations`;
    }
    if (out.iteration != null) {
      return `Iteration ${out.iteration}`;
    }
    return '';
  });

  // Route branch display from output
  let routeBranchText = $derived.by(() => {
    if (node.type !== 'route' || status !== 'completed') return '';
    if (!result?.output || typeof result.output !== 'object') return '';
    const out = result.output as Record<string, unknown>;
    const aiTag = out.ai_classified ? ' (AI)' : '';
    if (out.branch) return `Branch: ${out.branch}${aiTag}`;
    if (out.selected_branch) return `Branch: ${out.selected_branch}${aiTag}`;
    if (Array.isArray(out.branches)) return `Branches: ${(out.branches as string[]).join(', ')}${aiTag}`;
    return '';
  });

  // ForEach progress info
  let foreachProgressText = $derived.by(() => {
    if (node.type !== 'for_each') return '';
    if (!result?.output || typeof result.output !== 'object') return '';
    const out = result.output as Record<string, unknown>;
    const processed = out.items_processed as number | undefined;
    const failed = out.items_failed as number | undefined;
    if (processed != null) {
      const failText = failed && failed > 0 ? ` (${failed} failed)` : '';
      return `${processed} items${failText}`;
    }
    return '';
  });

  // Parallel branches status
  let parallelBranchInfo = $derived.by(() => {
    if (node.type !== 'parallel') return '';
    if (!result?.output || typeof result.output !== 'object') return '';
    const out = result.output as Record<string, unknown>;
    if (out.strategy && out.branches && typeof out.branches === 'object') {
      const branchCount = Object.keys(out.branches as object).length;
      const completed = (out.completed as number | undefined);
      if (completed != null) {
        return `${completed}/${branchCount} (${out.strategy})`;
      }
      return `${branchCount} branches (${out.strategy})`;
    }
    return '';
  });

  // Loop progress bar data
  let loopProgress = $derived.by(() => {
    if (node.type !== 'loop') return null;
    if (!result?.output || typeof result.output !== 'object') return null;
    const out = result.output as Record<string, unknown>;
    const iterations = out.iterations as number | undefined;
    const total = (node as unknown as { max_iterations?: number }).max_iterations;
    if (iterations != null && total) {
      return { current: iterations, max: total, percent: Math.round((iterations / total) * 100) };
    }
    return null;
  });

  // PR URL from output (for GitHub nodes)
  let prUrl = $derived.by(() => {
    if (!GITHUB_NODES.has(node.type)) return '';
    if (!result?.output || typeof result.output !== 'object') return '';
    const out = result.output as Record<string, unknown>;
    if (typeof out.pr_url === 'string') return out.pr_url;
    if (typeof out.url === 'string') return out.url;
    return '';
  });

  // Wait node polling indicator
  let isWaitPolling = $derived(
    (node.type === 'wait' || node.type === 'github_pr_wait') && status === 'running'
  );
</script>

<div class="rounded border transition-colors {isCurrent ? 'border-accent bg-accent/5' : 'border-border'}">
  <!-- Row header -->
  <button
    class="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-surface-elevated/50 transition-colors"
    onclick={() => expanded = !expanded}
  >
    <!-- Status icon -->
    <span class="text-sm w-5 text-center flex-shrink-0"
      class:text-text-muted={status === 'pending'}
      class:text-blue-400={status === 'running'}
      class:text-green-400={status === 'completed'}
      class:text-red-400={status === 'failed'}
      class:text-yellow-400={status === 'waiting_approval' || status === 'retrying'}
      class:text-gray-500={status === 'skipped'}
    >
      {#if status === 'running'}
        <span class="inline-block animate-pulse">{'\u25CF'}</span>
      {:else}
        {statusIcon}
      {/if}
    </span>

    <!-- Node name -->
    <span class="flex-1 text-sm text-text-primary truncate">
      {node.name || node.id}
    </span>

    <!-- Type badge -->
    <span class="px-1.5 py-0.5 text-[10px] rounded uppercase tracking-wider {typeBadgeClasses}">
      {nodeTypeLabel}
    </span>

    <!-- Loop iteration info -->
    {#if loopIterationText}
      <span class="text-[10px] text-yellow-400/80">{loopIterationText}</span>
    {/if}

    <!-- Route branch info -->
    {#if routeBranchText}
      <span class="text-[10px] text-blue-400/80">{routeBranchText}</span>
    {/if}

    <!-- ForEach progress -->
    {#if foreachProgressText}
      <span class="text-[10px] text-orange-400/80">{foreachProgressText}</span>
    {/if}

    <!-- Parallel branch info -->
    {#if parallelBranchInfo}
      <span class="text-[10px] text-cyan-400/80">{parallelBranchInfo}</span>
    {/if}

    <!-- Loop progress bar -->
    {#if loopProgress && status === 'running'}
      <div class="flex items-center gap-1.5">
        <div class="w-16 h-1.5 bg-surface-elevated rounded-full overflow-hidden">
          <div class="h-full bg-yellow-400/60 rounded-full transition-all" style="width:{loopProgress.percent}%"></div>
        </div>
        <span class="text-[10px] text-yellow-400/80">{loopProgress.current}/{loopProgress.max}</span>
      </div>
    {/if}

    <!-- Wait polling indicator -->
    {#if isWaitPolling}
      <span class="flex items-center gap-1 text-[10px] text-blue-400">
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></span>
        Polling...
      </span>
    {/if}

    <!-- Duration -->
    {#if result?.duration_ms}
      <span class="text-xs text-text-muted">
        {result.duration_ms < 1000 ? `${result.duration_ms}ms` : `${(result.duration_ms / 1000).toFixed(1)}s`}
      </span>
    {/if}

    <!-- Cost -->
    {#if result?.cost}
      <span class="text-xs text-text-muted">${result.cost.toFixed(4)}</span>
    {/if}

    <!-- Expand arrow -->
    <svg class="w-4 h-4 text-text-muted transition-transform" class:rotate-90={expanded}
      fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
    </svg>
  </button>

  <!-- Expanded content -->
  {#if expanded}
    <div class="px-3 pb-3 border-t border-border/50">
      {#if result?.error}
        <div class="mt-2 p-2 rounded bg-red-500/10 text-red-400 text-xs font-mono whitespace-pre-wrap">
          {result.error}
        </div>
        {#if status === 'failed'}
          <div class="mt-2">
            <button
              class="px-3 py-1 text-xs rounded bg-orange-500/20 text-orange-400 hover:bg-orange-500/30 transition-colors"
              onclick={() => retryNode(executionId, node.id)}>
              Retry
            </button>
          </div>
        {/if}
      {/if}

      {#if prUrl}
        <div class="mt-2 flex items-center gap-1.5 text-xs">
          <svg class="w-3.5 h-3.5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
          </svg>
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="text-purple-400 hover:text-purple-300 underline underline-offset-2 truncate"
            onclick={(e) => e.stopPropagation()}
          >
            {prUrl}
          </a>
        </div>
      {/if}

      <!-- Token usage for AI nodes -->
      {#if result?.tokens && AI_NODES.has(node.type)}
        <div class="mt-2 flex items-center gap-3 text-[11px] text-text-muted">
          <span class="text-blue-400/80">{result.tokens.input_tokens} in</span>
          <span class="text-green-400/80">{result.tokens.output_tokens} out</span>
          {#if result.tokens.cache_read > 0}
            <span class="text-cyan-400/80">{result.tokens.cache_read} cached</span>
          {/if}
          {#if result.cost}
            <span class="text-amber-400/80">${result.cost.toFixed(4)}</span>
          {/if}
        </div>
      {/if}

      {#if canOpenSession}
        <div class="mt-2">
          <button
            class="px-3 py-1 text-xs rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors inline-flex items-center gap-1.5"
            onclick={openSession}
            title="Open this prompt's run as a resumable session in the main view"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.9A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            Open session
          </button>
        </div>
      {/if}

      {#if result?.output}
        <div class="mt-2 p-2 rounded bg-surface-elevated text-text-secondary text-xs font-mono whitespace-pre-wrap max-h-64 overflow-y-auto">
          {typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2)}
        </div>
      {/if}

      {#if status === 'waiting_approval'}
        <div class="mt-2 flex items-center gap-2">
          <button
            class="px-3 py-1 text-xs rounded bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors"
            onclick={() => approveNode(executionId, node.id)}>
            Approve
          </button>
          <button
            class="px-3 py-1 text-xs rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
            onclick={() => rejectNode(executionId, node.id)}>
            Reject
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>
