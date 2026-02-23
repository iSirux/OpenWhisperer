<script lang="ts">
  import type { SdkMessage } from "$lib/stores/sdkSessions";
  import SdkMessageComponent from "./SdkMessage.svelte";

  let {
    taskStarted,
    children,
    taskCompleted,
    copiedMessageId = null,
    onCopy,
    sessionCwd = "",
    sessionModel = "",
  }: {
    taskStarted: SdkMessage;
    children: SdkMessage[];
    taskCompleted?: SdkMessage;
    copiedMessageId?: number | null;
    onCopy: (msg: SdkMessage) => void;
    sessionCwd?: string;
    sessionModel?: string;
  } = $props();

  let isRunning = $derived(!taskCompleted);
  let isCompleted = $derived(taskCompleted?.taskStatus === 'completed');
  let isFailed = $derived(taskCompleted?.taskStatus === 'failed');
  let isStopped = $derived(taskCompleted?.taskStatus === 'stopped');

  let statusText = $derived(
    isRunning ? 'Running' :
    isCompleted ? 'Completed' :
    isFailed ? 'Failed' :
    isStopped ? 'Stopped' :
    taskCompleted?.taskStatus || 'Done'
  );

  // Process children to merge tool_start/tool_result pairs (same logic as SdkView)
  let processedChildren = $derived(() => {
    const msgs = children;
    const result: SdkMessage[] = [];

    // Check if this session has toolUseIds (new format)
    const hasToolUseIds = msgs.some(m => m.toolUseId);

    if (hasToolUseIds) {
      const toolResults = new Map<string, SdkMessage>();
      for (const msg of msgs) {
        if (msg.type === 'tool_result' && msg.toolUseId) {
          toolResults.set(msg.toolUseId, msg);
        }
      }

      const toolInputs = new Map<string, Record<string, unknown>>();
      for (const msg of msgs) {
        if (msg.type === 'tool_start' && msg.toolUseId && msg.input) {
          toolInputs.set(msg.toolUseId, msg.input);
        }
      }

      const outputToolIds = new Set<string>();

      for (const msg of msgs) {
        if (msg.type === 'tool_start') {
          if (msg.toolUseId && toolResults.has(msg.toolUseId)) {
            const resultMsg = toolResults.get(msg.toolUseId)!;
            const input = toolInputs.get(msg.toolUseId);
            result.push({ ...resultMsg, input });
            outputToolIds.add(msg.toolUseId);
          } else {
            result.push(msg);
          }
        } else if (msg.type === 'tool_result') {
          if (!msg.toolUseId || !outputToolIds.has(msg.toolUseId)) {
            const input = msg.toolUseId ? toolInputs.get(msg.toolUseId) : undefined;
            result.push({ ...msg, input });
          }
        } else {
          result.push(msg);
        }
      }
    } else {
      return msgs;
    }

    return result;
  });

  // Format duration nicely
  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}m ${remainingSeconds}s`;
  }
</script>

<div class="task-block" class:task-running={isRunning} class:task-completed={isCompleted} class:task-failed={isFailed} class:task-stopped={isStopped}>
  <details open={isRunning || children.length <= 6}>
    <summary class="task-header">
      <svg class="chevron" viewBox="0 0 16 16" fill="currentColor">
        <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/>
      </svg>
      <div class="task-icon-wrapper">
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.5 3.25c0-.966.784-1.75 1.75-1.75h2.5c.966 0 1.75.784 1.75 1.75v2.5A1.75 1.75 0 0 1 5.75 7.5H5v1.5h.25a1.75 1.75 0 0 1 1.75 1.75v2.5A1.75 1.75 0 0 1 5.25 15h-2.5A1.75 1.75 0 0 1 1 13.25v-2.5C1 9.784 1.784 9 2.75 9H3V7.5h-.25A1.75 1.75 0 0 1 1 5.75v-2.5Zm9.75 0A1.75 1.75 0 0 0 9.5 5v6a1.75 1.75 0 0 0 1.75 1.75h1a.75.75 0 0 1 .75.75v1.19l2.72-2.72a.75.75 0 0 1 .53-.22h.5a.25.25 0 0 0 .25-.25V5a.25.25 0 0 0-.25-.25h-5.5Z"/>
        </svg>
      </div>
      <span class="task-label">Task</span>
      {#if taskStarted.description}
        <span class="task-description">{taskStarted.description}</span>
      {/if}
      {#if taskStarted.taskType}
        <span class="task-type-badge">{taskStarted.taskType}</span>
      {/if}
      <span class="task-status-badge" class:running={isRunning} class:completed={isCompleted} class:failed={isFailed} class:stopped={isStopped}>
        {#if isRunning}
          <span class="spinner"></span>
        {:else if isCompleted}
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
          </svg>
        {:else if isFailed}
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z"/>
          </svg>
        {:else}
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16ZM5.354 4.646l7.5 7.5a.5.5 0 0 1-.708.708l-7.5-7.5a.5.5 0 0 1 .708-.708Z"/>
          </svg>
        {/if}
        {statusText}
      </span>
    </summary>

    <div class="task-children">
      {#each processedChildren() as childMsg (childMsg.timestamp)}
        <SdkMessageComponent
          message={childMsg}
          {copiedMessageId}
          {onCopy}
          {sessionCwd}
          {sessionModel}
        />
      {/each}
    </div>

    {#if taskCompleted}
      <div class="task-footer">
        {#if taskCompleted.summary}
          <div class="task-summary">{taskCompleted.summary}</div>
        {/if}
        {#if taskCompleted.taskUsage}
          <div class="task-usage">
            <span class="usage-item">{taskCompleted.taskUsage.tool_uses} tool calls</span>
            <span class="usage-separator">&middot;</span>
            <span class="usage-item">{taskCompleted.taskUsage.total_tokens.toLocaleString()} tokens</span>
            <span class="usage-separator">&middot;</span>
            <span class="usage-item">{formatDuration(taskCompleted.taskUsage.duration_ms)}</span>
          </div>
        {/if}
      </div>
    {/if}
  </details>
</div>

<style>
  .task-block {
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--color-model-opus) 20%, var(--color-border));
    background: color-mix(in srgb, var(--color-model-opus) 4%, var(--color-surface));
    overflow: hidden;
    animation: fadeIn 0.2s ease-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .task-block.task-failed {
    border-color: color-mix(in srgb, var(--color-error) 30%, var(--color-border));
    background: color-mix(in srgb, var(--color-error) 4%, var(--color-surface));
  }

  .task-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    user-select: none;
    min-height: 2rem;
    list-style: none;
  }

  .task-header::-webkit-details-marker {
    display: none;
  }

  .task-header::marker {
    display: none;
    content: "";
  }

  .chevron {
    width: 14px;
    height: 14px;
    color: var(--color-text-muted);
    flex-shrink: 0;
    transition: transform 0.15s ease;
  }

  details[open] > .task-header > .chevron {
    transform: rotate(90deg);
  }

  .task-icon-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    color: var(--color-model-opus);
    flex-shrink: 0;
  }

  .task-icon-wrapper svg {
    width: 14px;
    height: 14px;
  }

  .task-label {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--color-model-opus);
    flex-shrink: 0;
  }

  .task-description {
    font-size: 0.8rem;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .task-type-badge {
    font-size: 0.65rem;
    padding: 0.0625rem 0.375rem;
    border-radius: 4px;
    background: color-mix(in srgb, var(--color-model-opus) 10%, transparent);
    color: var(--color-model-opus);
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    flex-shrink: 0;
  }

  .task-status-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.025em;
    flex-shrink: 0;
    margin-left: auto;
  }

  .task-status-badge svg {
    width: 12px;
    height: 12px;
  }

  .task-status-badge.running {
    background: color-mix(in srgb, var(--color-model-opus) 15%, transparent);
    color: var(--color-model-opus);
  }

  .task-status-badge.completed {
    background: color-mix(in srgb, var(--color-success) 15%, transparent);
    color: var(--color-success);
  }

  .task-status-badge.failed {
    background: color-mix(in srgb, var(--color-error) 15%, transparent);
    color: var(--color-error);
  }

  .task-status-badge.stopped {
    background: color-mix(in srgb, var(--color-text-muted) 15%, transparent);
    color: var(--color-text-muted);
  }

  .spinner {
    width: 10px;
    height: 10px;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .task-children {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    border-top: 1px solid color-mix(in srgb, var(--color-model-opus) 10%, var(--color-border));
  }

  .task-footer {
    padding: 0.375rem 0.75rem;
    border-top: 1px solid color-mix(in srgb, var(--color-model-opus) 10%, var(--color-border));
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .task-summary {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    line-height: 1.4;
  }

  .task-usage {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.65rem;
    color: var(--color-text-muted);
  }

  .usage-separator {
    color: var(--color-text-muted);
    opacity: 0.5;
  }
</style>
