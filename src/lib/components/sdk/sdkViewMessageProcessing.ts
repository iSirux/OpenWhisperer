import type { SdkMessage } from '$lib/stores/sdkSessions';

export type RenderItem =
  | { type: 'message'; message: SdkMessage }
  | { type: 'tool_group'; tools: SdkMessage[] }
  | {
      type: 'task';
      taskStarted: SdkMessage;
      children: SdkMessage[];
      taskCompleted?: SdkMessage;
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

  // Build task grouping data structures
  // The SDK sends task_started system messages AFTER the task completes, so we
  // cannot rely on them for grouping. Instead, we use the Task tool call itself
  // (tool_start/tool_result with tool === "Task") which arrives immediately.
  // task_started/task_completed are merged in for metadata (description, usage).

  // Maps toolUseId -> task_started system message (arrives late, used for metadata)
  const taskStartMap = new Map<string, SdkMessage>();
  // Maps toolUseId -> task_completed system message
  const taskCompletedMap = new Map<string, SdkMessage>();
  // Maps toolUseId -> child messages (those with matching parentToolUseId)
  const taskChildrenMap = new Map<string, SdkMessage[]>();
  // Set of toolUseIds that are task containers (for quick lookup)
  const knownTaskToolUseIds = new Set<string>();

  // Step 1: Find top-level Task tool calls (tool_start or merged tool_result for "Task")
  // These arrive immediately when the agent calls the Task tool, unlike task_started
  for (const msg of msgs) {
    if (
      (msg.type === 'tool_start' || msg.type === 'tool_result') &&
      msg.tool === 'Task' &&
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
    // Detect Task tool calls and render as task blocks.
    // Match by tool name "Task" OR by toolUseId being a known task container
    // (detected via child message parentToolUseId references in Step 2.5).
    const isTaskToolCall =
      (msg.type === 'tool_start' || msg.type === 'tool_result') &&
      !msg.parentToolUseId &&
      msg.toolUseId &&
      (msg.tool === 'Task' || knownTaskToolUseIds.has(msg.toolUseId));

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

      // Build taskCompleted: use real task_completed if available,
      // else if the Task tool has a result (tool_result), it's done
      const effectiveTaskCompleted: SdkMessage | undefined =
        taskCompletedMsg ||
        (msg.type === 'tool_result'
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

  // Step 6: Handle orphaned task containers.
  // These are task containers detected via parentToolUseId (Step 2.5) or
  // task_started (Step 2) that had no matching tool call in the main stream.
  // Without this, their children would be filtered from the main stream but
  // never displayed in any task block.
  for (const taskId of knownTaskToolUseIds) {
    if (renderedTaskIds.has(taskId)) continue;
    const children = taskChildrenMap.get(taskId) || [];
    if (children.length === 0 && !taskStartMap.has(taskId) && !taskCompletedMap.has(taskId)) continue;

    const taskStartMsg = taskStartMap.get(taskId);
    const taskCompletedMsg = taskCompletedMap.get(taskId);

    const effectiveTaskStarted: SdkMessage = taskStartMsg
      ? { ...taskStartMsg }
      : {
          type: 'task_started' as const,
          toolUseId: taskId,
          description: '',
          taskType: undefined,
          taskId: taskId,
          timestamp: children[0]?.timestamp ?? Date.now(),
        };

    items.push({
      type: 'task',
      taskStarted: effectiveTaskStarted,
      children,
      taskCompleted: taskCompletedMsg,
    });
  }

  return items;
}
