<script lang="ts">
  import { tick } from "svelte";
  import type { SdkMessage, EffortLevel } from "$lib/stores/sdkSessions";
  import type { NestedTaskSummary } from "./sdkViewMessageProcessing";
  import { settings } from "$lib/stores/settings";
  import SdkMessageComponent from "./SdkMessage.svelte";
  import SdkToolGrid from "./SdkToolGrid.svelte";

  let {
    taskStarted,
    children,
    taskCompleted,
    nestedSummaries = undefined,
    copiedMessageId = null,
    onCopy,
    sessionCwd = "",
    sessionModel = "",
    sessionEffortLevel = null,
  }: {
    taskStarted: SdkMessage;
    children: SdkMessage[];
    taskCompleted?: SdkMessage;
    nestedSummaries?: Map<string, NestedTaskSummary>;
    copiedMessageId?: number | null;
    onCopy: (msg: SdkMessage) => void;
    sessionCwd?: string;
    sessionModel?: string;
    sessionEffortLevel?: EffortLevel;
  } = $props();

  // Nested subagents (spawned by this subagent) are folded into compact summary
  // rows — we show their tool-call count and run status but never mount their
  // transcript, so a fan-out parent doesn't balloon with child agents' history.
  const isNestedSubagent = (m: SdkMessage): boolean =>
    !!m.toolUseId && !!nestedSummaries?.has(m.toolUseId);

  // Auto-scroll task body to bottom when new children arrive
  let taskBodyEl = $state<HTMLDivElement | null>(null);
  let prevChildCount = $state(0);

  $effect(() => {
    const currentCount = children.length;
    if (currentCount > prevChildCount && taskBodyEl) {
      tick().then(() => {
        if (taskBodyEl) {
          taskBodyEl.scrollTop = taskBodyEl.scrollHeight;
        }
      });
    }
    prevChildCount = currentCount;
  });

  let isRunning = $derived(!taskCompleted);
  let isCompleted = $derived(taskCompleted?.taskStatus === 'completed');
  let isFailed = $derived(taskCompleted?.taskStatus === 'failed');
  let isStopped = $derived(taskCompleted?.taskStatus === 'stopped');

  // Lazy-mount subagent transcripts. Task children (a whole subagent run) mount
  // eagerly even inside a closed <details> — the browser only visually hides
  // them, Svelte still builds every child component. On session switch that's a
  // hidden cost for subagent-heavy sessions. Start completed tasks collapsed and
  // only mount their children when expanded; keep running tasks open so live
  // progress still streams. Initialized once from the mount-time running state,
  // so a task that completes while you're watching stays open.
  // svelte-ignore state_referenced_locally -- intentional one-time capture of the mount-time running state
  let expanded = $state(isRunning);

  let statusText = $derived(
    isRunning ? 'Running' :
    isCompleted ? 'Completed' :
    isFailed ? 'Failed' :
    isStopped ? 'Stopped' :
    taskCompleted?.taskStatus || 'Done'
  );

  // Process children to merge tool_start/tool_result pairs.
  // Children arrive from SdkView's renderItems which already runs processedMessages(),
  // so completed tools are already merged (tool_start replaced by tool_result with input).
  // We only need to re-merge if there are still unmerged tool_start messages (running tools).
  let processedChildren = $derived(() => {
    const msgs = children;

    // If no tool_starts remain, children are fully processed - return as-is.
    // This avoids double-processing which would wipe the already-merged input data.
    const hasToolStarts = msgs.some(m => m.type === 'tool_start');
    if (!hasToolStarts) return msgs;

    // There are still-running tools (tool_start without tool_result) - merge completed pairs
    const result: SdkMessage[] = [];
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
            // Preserve existing input from pre-merged results (fallback to msg.input)
            const input = msg.toolUseId ? (toolInputs.get(msg.toolUseId) ?? msg.input) : msg.input;
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

  // Derive the display label: use taskType if available (e.g. "Explore"), else "Task"
  let taskLabel = $derived(taskStarted.taskType || 'Task');

  // Count this subagent's own tool calls (excluding nested-subagent launchers,
  // which report their own counts on their compact rows).
  let toolCallCount = $derived(
    children.filter(
      m =>
        (m.type === 'tool_start' || m.type === 'tool_result' || m.type === 'thinking') &&
        !isNestedSubagent(m),
    ).length
  );

  let isGridMode = $derived($settings.tool_display_mode === 'grid');

  // Group processed children into render items respecting grid/list setting.
  // Nested subagents become their own compact 'nested_task' item (never grouped
  // into a tool grid, never mounted as a full transcript).
  type ChildRenderItem =
    | { type: 'message'; message: SdkMessage }
    | { type: 'tool_group'; tools: SdkMessage[] }
    | { type: 'nested_task'; summary: NestedTaskSummary };

  let childRenderItems = $derived(() => {
    const msgs = processedChildren();
    if (msgs.length === 0) return [];

    const seenNested = new Set<string>();
    const nestedItem = (m: SdkMessage): ChildRenderItem | null => {
      const summary = nestedSummaries?.get(m.toolUseId!);
      if (!summary || seenNested.has(summary.toolUseId)) return null;
      seenNested.add(summary.toolUseId);
      return { type: 'nested_task', summary };
    };

    if (!isGridMode) {
      const items: ChildRenderItem[] = [];
      for (const m of msgs) {
        if (isNestedSubagent(m)) {
          const it = nestedItem(m);
          if (it) items.push(it);
        } else {
          items.push({ type: 'message', message: m });
        }
      }
      return items;
    }

    // Grid mode: group consecutive tool/thinking messages into tool_groups
    const items: ChildRenderItem[] = [];
    let currentToolGroup: SdkMessage[] = [];
    const flushGroup = () => {
      if (currentToolGroup.length > 0) {
        items.push({ type: 'tool_group', tools: [...currentToolGroup] });
        currentToolGroup = [];
      }
    };

    for (const msg of msgs) {
      if (isNestedSubagent(msg)) {
        flushGroup();
        const it = nestedItem(msg);
        if (it) items.push(it);
        continue;
      }
      const isToolMessage =
        msg.type === 'tool_start' ||
        msg.type === 'tool_result' ||
        msg.type === 'thinking';

      if (isToolMessage) {
        currentToolGroup.push(msg);
      } else {
        flushGroup();
        items.push({ type: 'message', message: msg });
      }
    }

    flushGroup();
    return items;
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
  <details open={expanded} ontoggle={(e) => (expanded = (e.currentTarget as HTMLDetailsElement).open)}>
    <summary class="task-header">
      <svg class="chevron" viewBox="0 0 16 16" fill="currentColor">
        <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/>
      </svg>
      <span class="task-label">{taskLabel}</span>
      {#if taskStarted.description}
        <span class="task-description">{taskStarted.description}</span>
      {/if}
      {#if toolCallCount > 0}
        <span class="task-tool-count">{toolCallCount} tool call{toolCallCount !== 1 ? 's' : ''}</span>
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

    <div class="task-body" bind:this={taskBodyEl}>
      {#if expanded && childRenderItems().length > 0}
        <div class="task-children">
          {#each childRenderItems() as item, index (item.type === 'tool_group' ? `tool-group-${index}` : item.type === 'nested_task' ? `nested-${item.summary.toolUseId}` : item.message.timestamp)}
            {#if item.type === 'tool_group'}
              <div class="task-tool-grid-wrapper">
                <SdkToolGrid tools={item.tools} />
              </div>
            {:else if item.type === 'nested_task'}
              <div
                class="nested-task-row"
                class:running={!item.summary.status}
                class:completed={item.summary.status === 'completed'}
                class:failed={item.summary.status === 'failed'}
                class:stopped={item.summary.status === 'stopped'}
                title={item.summary.description}
              >
                <span class="nested-arrow">&#8627;</span>
                <span class="nested-label">{item.summary.label}</span>
                {#if item.summary.description}
                  <span class="nested-description">{item.summary.description}</span>
                {/if}
                <span class="nested-count">{item.summary.toolCallCount} tool call{item.summary.toolCallCount === 1 ? '' : 's'}</span>
                <span class="nested-status">
                  {#if !item.summary.status}
                    <span class="spinner"></span>Running
                  {:else if item.summary.status === 'completed'}
                    Completed
                  {:else if item.summary.status === 'failed'}
                    Failed
                  {:else if item.summary.status === 'stopped'}
                    Stopped
                  {:else}
                    {item.summary.status}
                  {/if}
                </span>
              </div>
            {:else}
              <SdkMessageComponent
                message={item.message}
                {copiedMessageId}
                {onCopy}
                {sessionCwd}
                {sessionModel}
                {sessionEffortLevel}
              />
            {/if}
          {/each}
        </div>
      {/if}

      {#if taskCompleted?.summary || taskCompleted?.taskUsage}
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
    </div>
  </details>
</div>

<style>
  .task-block {
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--color-model-opus) 20%, var(--color-border));
    background: color-mix(in srgb, var(--color-model-opus) 4%, var(--color-surface));
    overflow: hidden;
    min-width: 0;
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

  .task-tool-count {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
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

  .task-status-badge.running,
  .task-status-badge.completed,
  .task-status-badge.stopped {
    background: color-mix(in srgb, var(--color-model-opus) 15%, transparent);
    color: var(--color-model-opus);
  }

  .task-status-badge.failed {
    background: color-mix(in srgb, var(--color-error) 15%, transparent);
    color: var(--color-error);
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

  .task-body {
    /* Keep a task/subagent ~3-4 tool calls tall, then scroll within it. While
       running it auto-scrolls to the newest child (see the $effect), so this
       reads like a small live tail instead of one subagent eating the viewport. */
    max-height: 11rem;
    overflow-y: auto;
    overflow-x: hidden;
    border-top: 1px solid color-mix(in srgb, var(--color-model-opus) 10%, var(--color-border));
  }

  .task-tool-grid-wrapper {
    max-height: 6.75rem; /* ~2 rows of tool cards */
    overflow-y: auto;
    overflow-x: hidden;
  }

  .task-children {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.5rem 0.75rem 0.5rem 1rem;
    border-left: 2px solid color-mix(in srgb, var(--color-model-opus) 25%, var(--color-border));
    margin-left: 0.75rem;
    min-width: 0;
    background: color-mix(in srgb, var(--color-model-opus) 2%, transparent);
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

  /* Compact row for a nested subagent — count + status only, no transcript. */
  .nested-task-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3125rem 0.5rem;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--color-model-opus) 18%, var(--color-border));
    background: color-mix(in srgb, var(--color-model-opus) 5%, var(--color-surface));
    min-width: 0;
  }

  .nested-task-row.failed {
    border-color: color-mix(in srgb, var(--color-error) 30%, var(--color-border));
    background: color-mix(in srgb, var(--color-error) 5%, var(--color-surface));
  }

  .nested-arrow {
    color: var(--color-text-muted);
    flex-shrink: 0;
    font-size: 0.9rem;
    line-height: 1;
  }

  .nested-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-model-opus);
    flex-shrink: 0;
  }

  .nested-description {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .nested-count {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    flex-shrink: 0;
    margin-left: auto;
  }

  .nested-status {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.0625rem 0.375rem;
    border-radius: 9999px;
    font-size: 0.6rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.025em;
    flex-shrink: 0;
    background: color-mix(in srgb, var(--color-model-opus) 15%, transparent);
    color: var(--color-model-opus);
  }

  .nested-task-row.failed .nested-status {
    background: color-mix(in srgb, var(--color-error) 15%, transparent);
    color: var(--color-error);
  }
</style>
