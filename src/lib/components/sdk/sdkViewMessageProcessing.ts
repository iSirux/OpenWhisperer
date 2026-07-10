import type { SdkMessage } from '$lib/stores/sdkSessions';

// Compact stand-in for a nested subagent (a subagent spawned by another
// subagent). We track its tool-call count and run status but never render its
// transcript inline — that would bloat a parent task block with a whole second
// agent's worth of messages. Keyed by the nested subagent's toolUseId.
export interface NestedTaskSummary {
  toolUseId: string;
  label: string;
  description: string;
  /** undefined ⇒ still running; else 'completed' | 'failed' | 'stopped' */
  status?: string;
  /** real tool calls across the nested subagent's whole subtree */
  toolCallCount: number;
}

export type RenderItem =
  | { type: 'message'; message: SdkMessage }
  | { type: 'tool_group'; tools: SdkMessage[] }
  | {
      type: 'task';
      taskStarted: SdkMessage;
      children: SdkMessage[];
      taskCompleted?: SdkMessage;
      /** Direct nested subagents of this task, keyed by toolUseId (compact rows). */
      nestedSummaries?: Map<string, NestedTaskSummary>;
    };

// Process messages to merge tool_start/tool_result pairs
// - Skip tool_start if there's a matching tool_result
// - Copy input from tool_start to tool_result for display
// - Completed tools are shown in the order they STARTED, not completed
// - Supports both toolUseId matching (new) and sequential matching (legacy sessions)
export function processSdkMessages(messages: SdkMessage[]): SdkMessage[] {
  const result: SdkMessage[] = [];
  const msgs = messages;

  // Check if this session has toolUseIds (new format) or not (legacy)
  const hasToolUseIds = msgs.some((m) => m.toolUseId);

  if (hasToolUseIds) {
    // NEW FORMAT: Match by toolUseId
    // Build a map of toolUseId -> tool_result message
    const toolResults = new Map<string, SdkMessage>();
    for (const msg of msgs) {
      if (msg.type === 'tool_result' && msg.toolUseId) {
        toolResults.set(msg.toolUseId, msg);
      }
    }

    // Build a map of toolUseId -> input from tool_start
    const toolInputs = new Map<string, Record<string, unknown>>();
    for (const msg of msgs) {
      if (msg.type === 'tool_start' && msg.toolUseId && msg.input) {
        toolInputs.set(msg.toolUseId, msg.input);
      }
    }

    // Track which tool_results we've already output (to avoid duplicates)
    const outputToolIds = new Set<string>();

    for (const msg of msgs) {
      if (msg.type === 'tool_start') {
        // Check if this tool has a result
        if (msg.toolUseId && toolResults.has(msg.toolUseId)) {
          // Tool completed - output the result at the START position (preserving start order)
          const resultMsg = toolResults.get(msg.toolUseId)!;
          const input = toolInputs.get(msg.toolUseId);
          result.push({ ...resultMsg, input });
          outputToolIds.add(msg.toolUseId);
        } else {
          // Tool still running - show tool_start
          result.push(msg);
        }
      } else if (msg.type === 'tool_result') {
        // Skip tool_results here - they're output at tool_start position above
        // (Unless it wasn't matched, which shouldn't happen but handle gracefully)
        if (!msg.toolUseId || !outputToolIds.has(msg.toolUseId)) {
          const input = msg.toolUseId ? toolInputs.get(msg.toolUseId) : undefined;
          result.push({ ...msg, input });
        }
      } else {
        result.push(msg);
      }
    }
  } else {
    // LEGACY FORMAT: Match sequentially by tool name
    // For each tool_start at index i, check if there's a tool_result for the same tool after it
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];

      if (msg.type === 'tool_start') {
        // Look for the next tool_result with the same tool name
        let hasResult = false;
        let resultIndex = -1;
        for (let j = i + 1; j < msgs.length; j++) {
          if (msgs[j].type === 'tool_result' && msgs[j].tool === msg.tool) {
            hasResult = true;
            resultIndex = j;
            break;
          }
          // Stop if we hit another tool_start for the same tool (parallel calls)
          if (msgs[j].type === 'tool_start' && msgs[j].tool === msg.tool) {
            break;
          }
        }
        // Only show tool_start if it doesn't have a result yet
        if (!hasResult) {
          result.push(msg);
        }
      } else if (msg.type === 'tool_result') {
        // Find the matching tool_start to get its input
        let toolInput: Record<string, unknown> | undefined;
        for (let j = i - 1; j >= 0; j--) {
          if (msgs[j].type === 'tool_start' && msgs[j].tool === msg.tool) {
            toolInput = msgs[j].input;
            break;
          }
        }
        result.push({ ...msg, input: toolInput });
      } else {
        result.push(msg);
      }
    }
  }

  return result;
}

// Group messages for rendering based on tool_display_mode setting
// Returns an array of render items: single messages, tool groups, or task blocks
export function buildRenderItems(messages: SdkMessage[], isGridMode: boolean): RenderItem[] {
  // Filter out internal lifecycle markers that should not render in the chat body.
  const msgs = messages.filter((msg) => msg.type !== 'subagent_stop' && msg.type !== 'done' && msg.type !== 'stopped');

  // Build task grouping data structures.
  // A subagent is anchored on its tool call: the modern async "Agent" tool, or
  // the legacy synchronous "Task" tool. Both arrive immediately when the agent
  // spawns the subagent. task_started/task_completed system messages are folded
  // in for metadata (description, usage) and as a completion signal — see the
  // per-task completion logic in Step 5 for why task_completed is authoritative
  // for async agents (their tool_result is only a launch ack, not a result).

  // Maps toolUseId -> task_started system message (used for metadata/description)
  const taskStartMap = new Map<string, SdkMessage>();
  // Maps toolUseId -> task_completed system message
  const taskCompletedMap = new Map<string, SdkMessage>();
  // Maps toolUseId -> child messages (those with matching parentToolUseId)
  const taskChildrenMap = new Map<string, SdkMessage[]>();
  // Set of toolUseIds that are task containers (for quick lookup)
  const knownTaskToolUseIds = new Set<string>();

  // Step 1: Find top-level subagent tool calls (tool_start or merged tool_result).
  // "Agent" is the modern async subagent tool; "Task" is the legacy synchronous
  // one. Anchoring on the tool call here (not just task_started) guarantees the
  // subagent always renders as a task block — important because the async Agent
  // tool_result is internal launch metadata ("Async agent launched
  // successfully...") that must never leak into the chat as a standalone card.
  for (const msg of msgs) {
    if (
      (msg.type === 'tool_start' || msg.type === 'tool_result') &&
      (msg.tool === 'Task' || msg.tool === 'Agent') &&
      !msg.parentToolUseId &&
      msg.toolUseId
    ) {
      knownTaskToolUseIds.add(msg.toolUseId);
      if (!taskChildrenMap.has(msg.toolUseId)) {
        taskChildrenMap.set(msg.toolUseId, []);
      }
    }
  }

  // Step 2: Also register task_started/task_completed for metadata enrichment
  for (const msg of msgs) {
    if (msg.type === 'task_started' && msg.toolUseId) {
      taskStartMap.set(msg.toolUseId, msg);
      // Also register as task container (fallback if Task tool call was missed)
      knownTaskToolUseIds.add(msg.toolUseId);
      if (!taskChildrenMap.has(msg.toolUseId)) {
        taskChildrenMap.set(msg.toolUseId, []);
      }
    }
    if (msg.type === 'task_completed' && msg.toolUseId) {
      taskCompletedMap.set(msg.toolUseId, msg);
    }
  }

  // Step 2.5: Detect task containers from parentToolUseId references.
  // If any message references a parentToolUseId, that parent is a task container
  // even if we didn't see a matching Task tool call (e.g. timing edge cases,
  // persisted sessions with missing properties, or renamed tools).
  for (const msg of msgs) {
    if (msg.parentToolUseId && !knownTaskToolUseIds.has(msg.parentToolUseId)) {
      knownTaskToolUseIds.add(msg.parentToolUseId);
      if (!taskChildrenMap.has(msg.parentToolUseId)) {
        taskChildrenMap.set(msg.parentToolUseId, []);
      }
    }
  }

  // Step 3: Collect child messages into their parent task
  for (const msg of msgs) {
    if (msg.parentToolUseId && knownTaskToolUseIds.has(msg.parentToolUseId)) {
      if (!taskChildrenMap.has(msg.parentToolUseId)) {
        taskChildrenMap.set(msg.parentToolUseId, []);
      }
      taskChildrenMap.get(msg.parentToolUseId)!.push(msg);
    }
  }

  // Step 3.5: Collapse nested subagents (a subagent spawned inside another
  // subagent) into compact summaries. A subagent's Agent/Task tool call carries
  // a parentToolUseId when it was spawned by another subagent; that makes it
  // "nested". We fold each nested subagent into a one-line summary (label, tool
  // count, run status) shown in its immediate parent, and never render its
  // transcript — otherwise a fan-out parent balloons with every child agent's
  // full message history.

  // toolUseId -> its spawning parent's toolUseId (only for tasks that are nested)
  const taskParentId = new Map<string, string>();
  // toolUseId -> the Agent/Task tool-call input (for the subagent label)
  const taskToolInput = new Map<string, Record<string, unknown>>();
  for (const msg of msgs) {
    if (
      (msg.type === 'tool_start' || msg.type === 'tool_result') &&
      (msg.tool === 'Task' || msg.tool === 'Agent') &&
      msg.toolUseId
    ) {
      if (msg.parentToolUseId) taskParentId.set(msg.toolUseId, msg.parentToolUseId);
      if (msg.input && !taskToolInput.has(msg.toolUseId)) taskToolInput.set(msg.toolUseId, msg.input);
    }
  }

  // Count real tool calls across a subagent's whole subtree. Children are already
  // merged (processSdkMessages replaces a completed tool_start with its
  // tool_result), so a tool is one entry of EITHER type — count both, deduped by
  // toolUseId so an unmerged running pair can't double-count. A nested Agent/Task
  // call isn't itself a "tool call": recurse into it so a nested subagent that
  // fans out still contributes its own leaf tool work.
  const subtreeCountCache = new Map<string, number>();
  const countSubtreeTools = (taskId: string, seen: Set<string> = new Set()): number => {
    const cached = subtreeCountCache.get(taskId);
    if (cached !== undefined) return cached;
    if (seen.has(taskId)) return 0; // guard against pathological cycles
    seen.add(taskId);
    let n = 0;
    const counted = new Set<string>();
    for (const c of taskChildrenMap.get(taskId) || []) {
      if (c.type !== 'tool_start' && c.type !== 'tool_result') continue;
      if (c.toolUseId && knownTaskToolUseIds.has(c.toolUseId)) {
        n += countSubtreeTools(c.toolUseId, seen);
      } else if (c.toolUseId) {
        if (!counted.has(c.toolUseId)) {
          counted.add(c.toolUseId);
          n += 1;
        }
      } else {
        n += 1;
      }
    }
    subtreeCountCache.set(taskId, n);
    return n;
  };

  // Group each nested subagent's summary under its immediate parent's toolUseId.
  const nestedByParent = new Map<string, Map<string, NestedTaskSummary>>();
  for (const taskId of knownTaskToolUseIds) {
    const parentId = taskParentId.get(taskId);
    if (!parentId) continue; // top-level subagent — rendered as a full block
    const startMsg = taskStartMap.get(taskId);
    const completedMsg = taskCompletedMap.get(taskId);
    const input = taskToolInput.get(taskId);
    const label =
      (input?.subagent_type as string | undefined) ||
      (startMsg?.taskType && startMsg.taskType !== 'local_agent' ? startMsg.taskType : undefined) ||
      'Agent';
    const description =
      startMsg?.description ||
      (input?.description as string | undefined) ||
      (input?.prompt as string | undefined) ||
      '';
    // The SDK flattens deep subagent output: a sub-subagent's individual tool
    // calls are never emitted with a parentToolUseId pointing back to their
    // launcher, so countSubtreeTools() finds zero children and the row reads
    // "0 tool calls" forever. The task_completed (task_notification) carries the
    // authoritative tool_uses count for the whole subtree, so trust it when the
    // subagent has finished; fall back to the subtree walk only while it's still
    // running (no completion yet).
    const summary: NestedTaskSummary = {
      toolUseId: taskId,
      label,
      description,
      status: completedMsg?.taskStatus,
      toolCallCount: completedMsg?.taskUsage?.tool_uses ?? countSubtreeTools(taskId),
    };
    if (!nestedByParent.has(parentId)) nestedByParent.set(parentId, new Map());
    nestedByParent.get(parentId)!.set(taskId, summary);
  }

  // Step 4: Filter main stream messages
  const mainStreamMsgs = msgs.filter((msg) => {
    // Exclude child messages of tasks
    if (msg.parentToolUseId && knownTaskToolUseIds.has(msg.parentToolUseId)) return false;
    // Exclude task_started (consumed by task block at Task tool position)
    if (msg.type === 'task_started') return false;
    // Exclude task_completed (merged into task render items)
    if (msg.type === 'task_completed') return false;
    // Always exclude subagent_start - it's redundant with task blocks, and when
    // task detection fails it renders as a misleading perpetual "Running" flat line
    if (msg.type === 'subagent_start') return false;
    return true;
  });

  // Track which task containers have been rendered (for orphan detection)
  const renderedTaskIds = new Set<string>();

  // Step 5: Build render items
  const items: RenderItem[] = [];
  let currentToolGroup: SdkMessage[] = [];

  for (const msg of mainStreamMsgs) {
    // Detect subagent tool calls and render as task blocks.
    // Match by tool name ("Agent" async / "Task" legacy) OR by toolUseId being a
    // known task container (from task_started, or child parentToolUseId refs in
    // Step 2.5).
    const isTaskToolCall =
      (msg.type === 'tool_start' || msg.type === 'tool_result') &&
      !msg.parentToolUseId &&
      msg.toolUseId &&
      (msg.tool === 'Task' || msg.tool === 'Agent' || knownTaskToolUseIds.has(msg.toolUseId));

    if (isTaskToolCall) {
      // Flush any pending tool group
      if (currentToolGroup.length > 0 && isGridMode) {
        items.push({ type: 'tool_group', tools: [...currentToolGroup] });
        currentToolGroup = [];
      }

      const toolUseId = msg.toolUseId!;
      const taskStartMsg = taskStartMap.get(toolUseId);
      const taskCompletedMsg = taskCompletedMap.get(toolUseId);
      const taskInput = msg.input as Record<string, unknown> | undefined;

      // Build taskStarted: merge real task_started with tool input data.
      // The SDK's task_type is internal (e.g. "local_agent") - prefer subagent_type from tool input.
      const inputTaskType = taskInput?.subagent_type as string | undefined;
      const inputDescription = (taskInput?.description as string) || (taskInput?.prompt as string) || '';
      const effectiveTaskStarted: SdkMessage = taskStartMsg
        ? {
            ...taskStartMsg,
            taskType: inputTaskType || taskStartMsg.taskType,
            description: taskStartMsg.description || inputDescription,
          }
        : {
            type: 'task_started' as const,
            toolUseId,
            description: inputDescription,
            taskType: inputTaskType,
            taskId: toolUseId,
            timestamp: msg.timestamp,
          };

      // Build taskCompleted. The modern async subagent tool ("Agent") returns
      // its tool_result almost immediately — an "Async agent launched
      // successfully" ack — then keeps running in the background for minutes;
      // its ONLY authoritative terminal signal is the task_completed (SDK
      // task_notification) message. So for it we trust task_completed alone.
      // Treating the early tool_result as "done" is exactly what made every
      // running subagent show as "Completed" the instant it launched.
      //
      // The tool_result⇒done fallback survives only for the legacy *synchronous*
      // "Task" tool, whose tool_result genuinely WAS the completion and which may
      // lack a task_completed in old persisted sessions.
      const isLegacySyncTask = msg.tool === 'Task';
      const effectiveTaskCompleted: SdkMessage | undefined =
        taskCompletedMsg ||
        (isLegacySyncTask && msg.type === 'tool_result'
          ? {
              type: 'task_completed' as const,
              toolUseId,
              taskStatus: 'completed',
              summary: '',
              timestamp: msg.timestamp,
            }
          : undefined);

      renderedTaskIds.add(toolUseId);
      items.push({
        type: 'task',
        taskStarted: effectiveTaskStarted,
        children: taskChildrenMap.get(toolUseId) || [],
        taskCompleted: effectiveTaskCompleted,
        nestedSummaries: nestedByParent.get(toolUseId),
      });
    } else if (isGridMode) {
      const isToolMessage =
        msg.type === 'tool_start' || msg.type === 'tool_result' || msg.type === 'thinking';
      const hasImages = msg.images && msg.images.length > 0;
      if (isToolMessage && !hasImages) {
        currentToolGroup.push(msg);
      } else if (hasImages) {
        // Tool results with images render as standalone messages (not in the grid)
        // so SdkMessage can display the images inline
        if (currentToolGroup.length > 0) {
          items.push({ type: 'tool_group', tools: [...currentToolGroup] });
          currentToolGroup = [];
        }
        items.push({ type: 'message', message: msg });
      } else {
        if (currentToolGroup.length > 0) {
          items.push({ type: 'tool_group', tools: [...currentToolGroup] });
          currentToolGroup = [];
        }
        items.push({ type: 'message', message: msg });
      }
    } else {
      items.push({ type: 'message', message: msg });
    }
  }

  // Flush remaining tool group
  if (currentToolGroup.length > 0 && isGridMode) {
    items.push({ type: 'tool_group', tools: currentToolGroup });
  }

  // Representative timestamp for ordering render items (the stream is roughly
  // ascending by time). For task blocks, prefer the earliest child timestamp
  // (when the subagent actually began emitting) over the task_started system
  // message, which the SDK sends only AFTER the task completes.
  const itemTimestamp = (item: RenderItem): number => {
    if (item.type === 'message') return item.message.timestamp;
    if (item.type === 'tool_group') return item.tools[0]?.timestamp ?? 0;
    const childMin = item.children.reduce(
      (min, c) => (c.timestamp < min ? c.timestamp : min),
      Number.POSITIVE_INFINITY,
    );
    return Number.isFinite(childMin) ? childMin : item.taskStarted.timestamp;
  };

  // Step 6: Handle orphaned task containers.
  // These are task containers detected via parentToolUseId (Step 2.5) or
  // task_started (Step 2) that had no matching Task tool call in the main stream
  // (e.g. the SDK emitted only the late task_started/task_completed system
  // messages plus child messages, but no top-level Task tool_start to anchor on).
  // Without this, their children would be filtered from the main stream but
  // never displayed in any task block.
  //
  // Insert each orphan at its chronological position rather than appending at the
  // end — appending pins a completed subagent below every later message, including
  // messages from subsequent turns (a task that ran in turn 1 shows up at the very
  // bottom under turn 2's replies).
  for (const taskId of knownTaskToolUseIds) {
    if (renderedTaskIds.has(taskId)) continue;
    // Nested subagents are summarized as a compact row inside their parent task
    // (Step 3.5) — never promoted to a standalone top-level block here, which is
    // what used to bloat the view with a whole second agent's transcript.
    if (taskParentId.has(taskId)) continue;
    const children = taskChildrenMap.get(taskId) || [];
    if (children.length === 0 && !taskStartMap.has(taskId) && !taskCompletedMap.has(taskId)) continue;

    const taskStartMsg = taskStartMap.get(taskId);
    const taskCompletedMsg = taskCompletedMap.get(taskId);

    // Anchor at when the task began. task_started/task_completed arrive after the
    // task finishes, so the earliest child timestamp is the truest "start" time.
    const childStart = children.reduce(
      (min, c) => (c.timestamp < min ? c.timestamp : min),
      Number.POSITIVE_INFINITY,
    );
    const anchorTimestamp = Number.isFinite(childStart)
      ? childStart
      : (taskStartMsg?.timestamp ?? taskCompletedMsg?.timestamp ?? Date.now());

    const effectiveTaskStarted: SdkMessage = taskStartMsg
      ? { ...taskStartMsg }
      : {
          type: 'task_started' as const,
          toolUseId: taskId,
          description: '',
          taskType: undefined,
          taskId: taskId,
          timestamp: anchorTimestamp,
        };

    const orphanItem: RenderItem = {
      type: 'task',
      taskStarted: effectiveTaskStarted,
      children,
      taskCompleted: taskCompletedMsg,
      nestedSummaries: nestedByParent.get(taskId),
    };

    // Place just after the last item that began at or before this task.
    let insertAt = items.findIndex((it) => itemTimestamp(it) > anchorTimestamp);
    if (insertAt < 0) insertAt = items.length;
    items.splice(insertAt, 0, orphanItem);
  }

  return items;
}
