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
      /** Model requested in the Task/Agent tool input (may be an alias like "sonnet" or "inherit").
       *  The actual model, when known, comes from SdkSession.subagentModels and takes precedence. */
      taskModel?: string;
    };

// Identity-stable merge of a tool_result with its tool_start's input.
//
// This whole pipeline re-runs from scratch on every store tick (a streaming turn
// emits one event per text delta / tool call). A fresh `{...resultMsg, input}`
// each time gives every completed tool call a NEW object identity, which
// invalidates the props of every rendered message component even though nothing
// about it changed — re-running markdown, re-formatting tool input, and touching
// the DOM for the entire visible window. Cache the merged object per source
// message so a re-run returns the *same* object when the inputs are unchanged,
// which lets the render layer skip untouched items entirely.
//
// Keyed by the raw tool_result object (identity-stable: the store never mutates
// a message in place, it appends), and only reused when the paired `input`
// reference also matches — a running tool's input can land after its result.
const mergedToolCache = new WeakMap<
  SdkMessage,
  { input: Record<string, unknown> | undefined; merged: SdkMessage }
>();

export function mergeToolResult(
  resultMsg: SdkMessage,
  input: Record<string, unknown> | undefined
): SdkMessage {
  const cached = mergedToolCache.get(resultMsg);
  if (cached && cached.input === input) return cached.merged;
  const merged = { ...resultMsg, input };
  mergedToolCache.set(resultMsg, { input, merged });
  return merged;
}

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
          result.push(mergeToolResult(resultMsg, input));
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
          result.push(mergeToolResult(msg, input));
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
        result.push(mergeToolResult(msg, toolInput));
      } else {
        result.push(msg);
      }
    }
  }

  return result;
}

// Re-merge a task block's children. They arrive from buildRenderItems, whose
// input already went through processSdkMessages, so completed tools are merged
// (tool_start replaced by its tool_result carrying the input). Only children
// that are still running remain as tool_starts. This keeps the block's
// historical re-merge semantics, but returns the SAME object for every child
// the pass doesn't actually change — the old `{ ...msg, input }` copies gave
// every completed child a new identity on each event while any sibling tool was
// running, re-rendering the whole subagent transcript.
export function mergeTaskChildren(msgs: SdkMessage[]): SdkMessage[] {
  // If no tool_starts remain, children are fully processed - return as-is.
  // This avoids double-processing which would wipe the already-merged input data.
  if (!msgs.some((m) => m.type === 'tool_start')) return msgs;
  if (!msgs.some((m) => m.toolUseId)) return msgs;

  const toolResults = new Map<string, SdkMessage>();
  const toolInputs = new Map<string, Record<string, unknown>>();
  for (const msg of msgs) {
    if (msg.type === 'tool_result' && msg.toolUseId) toolResults.set(msg.toolUseId, msg);
    if (msg.type === 'tool_start' && msg.toolUseId && msg.input) toolInputs.set(msg.toolUseId, msg.input);
  }

  const outputToolIds = new Set<string>();
  const result: SdkMessage[] = [];
  for (const msg of msgs) {
    if (msg.type === 'tool_start') {
      if (msg.toolUseId && toolResults.has(msg.toolUseId)) {
        result.push(mergeToolResult(toolResults.get(msg.toolUseId)!, toolInputs.get(msg.toolUseId)));
        outputToolIds.add(msg.toolUseId);
      } else {
        result.push(msg);
      }
    } else if (msg.type === 'tool_result') {
      if (!msg.toolUseId || !outputToolIds.has(msg.toolUseId)) {
        // Preserve existing input from pre-merged results (fallback to msg.input)
        const input = msg.toolUseId ? (toolInputs.get(msg.toolUseId) ?? msg.input) : msg.input;
        result.push(input === msg.input ? msg : mergeToolResult(msg, input));
      }
    } else {
      result.push(msg);
    }
  }
  return result;
}

// Base {#each} key for a message row / tool card. A tool call is keyed by its
// toolUseId, NOT its timestamp: when the tool finishes, the rendered object
// becomes the merged tool_result (a different message with the result's
// timestamp), and a timestamp key would remount the card — replaying its
// fade-in and collapsing it if the user had it open. Everything else falls back
// to the timestamp. Not unique on its own (see uniqueKeys).
export function messageRenderKey(m: SdkMessage): string {
  if ((m.type === 'tool_start' || m.type === 'tool_result') && m.toolUseId) {
    return `tool-${m.toolUseId}`;
  }
  return `msg-${m.timestamp}`;
}

// Make base keys collision-free for a keyed {#each}. Timestamps (ms) collide
// within an event burst — parallel tool calls routinely share one — and
// duplicate keys hang Svelte's keyed-each reconciliation (observed as a
// whole-app freeze). The occurrence counter is deterministic because item order
// is stable across recomputes.
export function uniqueKeys<T>(items: readonly T[], baseKey: (item: T) => string): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = baseKey(item);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}

// Task-grouping lookups built from the whole (processed) message stream. Shared
// between the from-scratch buildRenderItems and the incremental builder in
// incrementalRenderPipeline.ts, so both derive task blocks from the same code.
export interface TaskIndex {
  // Maps toolUseId -> task_started system message (used for metadata/description)
  taskStartMap: Map<string, SdkMessage>;
  // Maps toolUseId -> task_completed system message
  taskCompletedMap: Map<string, SdkMessage>;
  // Fallback pairing index: taskId -> task_completed. `tool_use_id` is OPTIONAL on the SDK's
  // task_started/task_notification messages, so a completion can land without one — matching
  // on toolUseId alone then leaves the task block spinning "Running" forever even though the
  // subagent finished (its task_completed is the ONLY authoritative terminal signal; see the
  // effectiveTaskCompleted comment in buildTaskRenderItem). task_id is always present on both,
  // so index it too.
  taskCompletedByTaskId: Map<string, SdkMessage>;
  // Maps toolUseId -> child messages (those with matching parentToolUseId)
  taskChildrenMap: Map<string, SdkMessage[]>;
  // Set of toolUseIds that are task containers (for quick lookup)
  knownTaskToolUseIds: ReadonlySet<string>;
  // toolUseId -> its spawning parent's toolUseId (only for tasks that are nested)
  taskParentId: Map<string, string>;
  // toolUseId -> the Agent/Task tool-call input (for the subagent label)
  taskToolInput: Map<string, Record<string, unknown>>;
  // Each nested subagent's summary, grouped under its immediate parent's toolUseId.
  nestedByParent: Map<string, Map<string, NestedTaskSummary>>;
}

/** Resolve a task block's completion: by toolUseId, else by the started message's taskId. */
export function findTaskCompleted(
  ix: TaskIndex,
  toolUseId: string,
  startMsg?: SdkMessage
): SdkMessage | undefined {
  return (
    ix.taskCompletedMap.get(toolUseId) ??
    (startMsg?.taskId ? ix.taskCompletedByTaskId.get(startMsg.taskId) : undefined)
  );
}

// Collapse nested subagents (a subagent spawned inside another subagent) into
// compact summaries. A subagent's Agent/Task tool call carries a
// parentToolUseId when it was spawned by another subagent; that makes it
// "nested". We fold each nested subagent into a one-line summary (label, tool
// count, run status) shown in its immediate parent, and never render its
// transcript — otherwise a fan-out parent balloons with every child agent's
// full message history. `taskIds` must iterate in knownTaskToolUseIds order.
export function computeNestedByParent(
  ix: TaskIndex,
  taskIds: Iterable<string>
): Map<string, Map<string, NestedTaskSummary>> {
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
    for (const c of ix.taskChildrenMap.get(taskId) || []) {
      if (c.type !== 'tool_start' && c.type !== 'tool_result') continue;
      if (c.toolUseId && ix.knownTaskToolUseIds.has(c.toolUseId)) {
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
  for (const taskId of taskIds) {
    const parentId = ix.taskParentId.get(taskId);
    if (!parentId) continue; // top-level subagent — rendered as a full block
    const startMsg = ix.taskStartMap.get(taskId);
    const completedMsg = findTaskCompleted(ix, taskId, startMsg);
    const input = ix.taskToolInput.get(taskId);
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
  return nestedByParent;
}

// Detect subagent tool calls that render as task blocks.
// Match by tool name ("Agent" async / "Task" legacy) OR by toolUseId being a
// known task container (from task_started, or child parentToolUseId refs in
// Step 2.5).
export function isTaskToolCall(msg: SdkMessage, known: ReadonlySet<string>): boolean {
  return (
    (msg.type === 'tool_start' || msg.type === 'tool_result') &&
    !msg.parentToolUseId &&
    !!msg.toolUseId &&
    (msg.tool === 'Task' || msg.tool === 'Agent' || known.has(msg.toolUseId))
  );
}

// Build the task block for a main-stream subagent tool call (see isTaskToolCall).
export function buildTaskRenderItem(msg: SdkMessage, ix: TaskIndex): RenderItem {
  const toolUseId = msg.toolUseId!;
  const taskStartMsg = ix.taskStartMap.get(toolUseId);
  const taskCompletedMsg = findTaskCompleted(ix, toolUseId, taskStartMsg);
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

  return {
    type: 'task',
    taskStarted: effectiveTaskStarted,
    children: ix.taskChildrenMap.get(toolUseId) || [],
    taskCompleted: effectiveTaskCompleted,
    nestedSummaries: ix.nestedByParent.get(toolUseId),
    taskModel: taskInput?.model as string | undefined,
  };
}

// Representative timestamp for ordering render items (the stream is roughly
// ascending by time). For task blocks, prefer the earliest child timestamp
// (when the subagent actually began emitting) over the task_started system
// message, which the SDK sends only AFTER the task completes.
function itemTimestamp(item: RenderItem): number {
  if (item.type === 'message') return item.message.timestamp;
  if (item.type === 'tool_group') return item.tools[0]?.timestamp ?? 0;
  const childMin = item.children.reduce(
    (min, c) => (c.timestamp < min ? c.timestamp : min),
    Number.POSITIVE_INFINITY,
  );
  return Number.isFinite(childMin) ? childMin : item.taskStarted.timestamp;
}

export interface OrphanTask {
  item: RenderItem;
  anchorTimestamp: number;
}

// Step 6 (collect): orphaned task containers.
// These are task containers detected via parentToolUseId (Step 2.5) or
// task_started (Step 2) that had no matching Task tool call in the main stream
// (e.g. the SDK emitted only the late task_started/task_completed system
// messages plus child messages, but no top-level Task tool_start to anchor on).
// Without this, their children would be filtered from the main stream but
// never displayed in any task block. `taskIds` must iterate in
// knownTaskToolUseIds order (insertion order decides ties in placement).
export function collectOrphanTasks(
  ix: TaskIndex,
  taskIds: Iterable<string>,
  renderedTaskIds: ReadonlySet<string>
): OrphanTask[] {
  const orphans: OrphanTask[] = [];
  for (const taskId of taskIds) {
    if (renderedTaskIds.has(taskId)) continue;
    // Nested subagents are summarized as a compact row inside their parent task
    // (Step 3.5) — never promoted to a standalone top-level block here, which is
    // what used to bloat the view with a whole second agent's transcript.
    if (ix.taskParentId.has(taskId)) continue;
    const children = ix.taskChildrenMap.get(taskId) || [];
    if (children.length === 0 && !ix.taskStartMap.has(taskId) && !ix.taskCompletedMap.has(taskId)) continue;

    const taskStartMsg = ix.taskStartMap.get(taskId);
    const taskCompletedMsg = ix.taskCompletedMap.get(taskId);

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

    orphans.push({
      item: {
        type: 'task',
        taskStarted: effectiveTaskStarted,
        children,
        taskCompleted: taskCompletedMsg,
        nestedSummaries: ix.nestedByParent.get(taskId),
      },
      anchorTimestamp,
    });
  }
  return orphans;
}

// Step 6 (place): insert each orphan at its chronological position rather than
// appending at the end — appending pins a completed subagent below every later
// message, including messages from subsequent turns (a task that ran in turn 1
// shows up at the very bottom under turn 2's replies). Mutates `items`.
export function insertOrphanTasks(items: RenderItem[], orphans: OrphanTask[]): void {
  for (const { item, anchorTimestamp } of orphans) {
    // Place just after the last item that began at or before this task.
    let insertAt = items.findIndex((it) => itemTimestamp(it) > anchorTimestamp);
    if (insertAt < 0) insertAt = items.length;
    items.splice(insertAt, 0, item);
  }
}

// Group messages for rendering based on tool_display_mode setting
// Returns an array of render items: single messages, tool groups, or task blocks
//
// This is the from-scratch reference implementation. The view uses the
// incremental builder (incrementalRenderPipeline.ts), which is tested to
// produce identical output — keep the two in step when changing either.
export function buildRenderItems(messages: SdkMessage[], isGridMode: boolean): RenderItem[] {
  // Filter out internal lifecycle markers that should not render in the chat body.
  const msgs = messages.filter((msg) => msg.type !== 'subagent_stop' && msg.type !== 'done' && msg.type !== 'stopped');

  // Build task grouping data structures.
  // A subagent is anchored on its tool call: the modern async "Agent" tool, or
  // the legacy synchronous "Task" tool. Both arrive immediately when the agent
  // spawns the subagent. task_started/task_completed system messages are folded
  // in for metadata (description, usage) and as a completion signal — see the
  // per-task completion logic in buildTaskRenderItem for why task_completed is
  // authoritative for async agents (their tool_result is only a launch ack).
  const knownTaskToolUseIds = new Set<string>();
  const ix: TaskIndex = {
    taskStartMap: new Map(),
    taskCompletedMap: new Map(),
    taskCompletedByTaskId: new Map(),
    taskChildrenMap: new Map(),
    knownTaskToolUseIds,
    taskParentId: new Map(),
    taskToolInput: new Map(),
    nestedByParent: new Map(),
  };
  const { taskStartMap, taskCompletedMap, taskCompletedByTaskId, taskChildrenMap } = ix;

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
    if (msg.type === 'task_completed') {
      if (msg.toolUseId) taskCompletedMap.set(msg.toolUseId, msg);
      if (msg.taskId) taskCompletedByTaskId.set(msg.taskId, msg);
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

  // Step 3.5: Collapse nested subagents into compact summaries (see
  // computeNestedByParent). Record each Agent/Task call's spawning parent and
  // input first.
  for (const msg of msgs) {
    if (
      (msg.type === 'tool_start' || msg.type === 'tool_result') &&
      (msg.tool === 'Task' || msg.tool === 'Agent') &&
      msg.toolUseId
    ) {
      if (msg.parentToolUseId) ix.taskParentId.set(msg.toolUseId, msg.parentToolUseId);
      if (msg.input && !ix.taskToolInput.has(msg.toolUseId)) ix.taskToolInput.set(msg.toolUseId, msg.input);
    }
  }
  ix.nestedByParent = computeNestedByParent(ix, knownTaskToolUseIds);

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
    if (isTaskToolCall(msg, knownTaskToolUseIds)) {
      // Flush any pending tool group
      if (currentToolGroup.length > 0 && isGridMode) {
        items.push({ type: 'tool_group', tools: [...currentToolGroup] });
        currentToolGroup = [];
      }
      renderedTaskIds.add(msg.toolUseId!);
      items.push(buildTaskRenderItem(msg, ix));
    } else if (isGridMode) {
      const isToolMessage =
        msg.type === 'tool_start' || msg.type === 'tool_result' || msg.type === 'thinking';
      const hasImages = msg.images && msg.images.length > 0;
      if (isToolMessage && !hasImages) {
        currentToolGroup.push(msg);
      } else {
        // Tool results with images render as standalone messages (not in the grid)
        // so SdkMessage can display the images inline
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

  // Step 6: Handle orphaned task containers (see collectOrphanTasks).
  insertOrphanTasks(items, collectOrphanTasks(ix, knownTaskToolUseIds, renderedTaskIds));

  return items;
}

function sameMessageList(a: SdkMessage[], b: SdkMessage[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameNestedSummaries(
  a: Map<string, NestedTaskSummary> | undefined,
  b: Map<string, NestedTaskSummary> | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.size !== b.size) return false;
  for (const [id, sa] of a) {
    const sb = b.get(id);
    if (
      !sb ||
      sb.status !== sa.status ||
      sb.toolCallCount !== sa.toolCallCount ||
      // Usually immutable (they come from the tool input), but a late-arriving
      // task_started can fill in a description without moving the count.
      sb.label !== sa.label ||
      sb.description !== sa.description
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Would these two render items produce identical output?
 *
 * `buildRenderItems` runs from scratch on every store tick and allocates fresh
 * wrapper objects (tool groups, task blocks, synthesized `task_started`
 * messages) even when the underlying messages are untouched. Comparing an item
 * against the previous tick's item at the same key lets the view reuse the old
 * object, so Svelte's keyed each never invalidates that row's props — which is
 * what keeps per-tick cost proportional to what actually changed rather than to
 * the size of the render window.
 *
 * Messages themselves are compared by reference: the store appends, it never
 * mutates a message in place, and `processSdkMessages` now returns identity-
 * stable merged tool results.
 */
export function renderItemsEquivalent(a: RenderItem, b: RenderItem): boolean {
  if (a === b) return true;
  if (a.type !== b.type) return false;

  if (a.type === 'message' && b.type === 'message') {
    return a.message === b.message;
  }

  if (a.type === 'tool_group' && b.type === 'tool_group') {
    return sameMessageList(a.tools, b.tools);
  }

  if (a.type === 'task' && b.type === 'task') {
    if (a.taskCompleted !== b.taskCompleted) {
      // Synthesized completions (legacy sync Task, forced stops) are rebuilt each
      // run, so fall back to comparing the fields the task block actually reads.
      if (!a.taskCompleted || !b.taskCompleted) return false;
      if (
        a.taskCompleted.taskStatus !== b.taskCompleted.taskStatus ||
        a.taskCompleted.summary !== b.taskCompleted.summary ||
        a.taskCompleted.taskUsage !== b.taskCompleted.taskUsage
      ) {
        return false;
      }
    }
    if (a.taskModel !== b.taskModel) return false;
    // `taskStarted` is synthesized/merged per run — compare by value.
    const sa = a.taskStarted;
    const sb = b.taskStarted;
    if (
      sa !== sb &&
      (sa.toolUseId !== sb.toolUseId ||
        sa.taskId !== sb.taskId ||
        sa.timestamp !== sb.timestamp ||
        sa.description !== sb.description ||
        sa.taskType !== sb.taskType)
    ) {
      return false;
    }
    if (!sameMessageList(a.children, b.children)) return false;
    return sameNestedSummaries(a.nestedSummaries, b.nestedSummaries);
  }

  return false;
}
