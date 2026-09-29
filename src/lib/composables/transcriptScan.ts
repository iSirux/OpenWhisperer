// Incremental transcript scans for the session list.
//
// The sidebar re-derives every session's display row on each store update, i.e.
// on every stream event of ANY session. The per-session facts it needs (live
// subagents, todo progress, first user prompt, latest assistant text) used to be
// full O(n) scans of transcripts that reach thousands of messages. They are all
// left folds over the message array, so we keep the fold state per session id
// and, when the new array extends the previously scanned one, fold only the
// appended tail. The store never mutates messages in place (it rebuilds arrays),
// so object identity tells us which prefix is unchanged.
//
// Kept free of runtime `$lib` imports so it can be exercised with plain node.

import type { SdkMessage } from '$lib/stores/sdkSessions';

export interface TranscriptSummary {
  /** Agent types of subagents started but not yet stopped in the current turn. */
  liveSubagentTypes: string[];
  /** Todo/task progress (TaskCreate/TaskUpdate, else the latest TodoWrite snapshot). */
  todoProgress: { completed: number; total: number } | undefined;
  /** `content` of the first `user` message (undefined when absent or empty). */
  firstUserContent: string | undefined;
  /** Content of the latest non-empty assistant `text` message. */
  latestText: string | undefined;
}

interface ScanState {
  /** The array this state was folded over (for identity/anchor checks). */
  messages: readonly SdkMessage[];
  // Live subagents (reset at each done/stopped turn boundary): agentId -> agentType
  live: Map<string, string>;
  // Task tools
  hasTaskTools: boolean;
  created: number;
  statusById: Map<string, string>;
  // Legacy TodoWrite: the most recent non-empty snapshot
  legacyTodo: { completed: number; total: number } | undefined;
  // First user message
  foundFirstUser: boolean;
  firstUserContent: string | undefined;
  latestText: string | undefined;
  /** Summary for `messages`, built lazily and reused while the array is unchanged. */
  summary: TranscriptSummary | null;
}

function emptyState(): ScanState {
  return {
    messages: [],
    live: new Map(),
    hasTaskTools: false,
    created: 0,
    statusById: new Map(),
    legacyTodo: undefined,
    foundFirstUser: false,
    firstUserContent: undefined,
    latestText: undefined,
    summary: null,
  };
}

/** Fold `messages[from..]` into `state` (mutates `state`). */
function foldFrom(state: ScanState, messages: readonly SdkMessage[], from: number): void {
  for (let i = from; i < messages.length; i++) {
    const msg = messages[i];
    switch (msg.type) {
      case 'done':
      case 'stopped':
        state.live.clear();
        break;
      case 'subagent_start':
        state.live.set(msg.agentId || `#${state.live.size}`, msg.agentType || 'Agent');
        break;
      case 'subagent_stop':
        if (msg.agentId) state.live.delete(msg.agentId);
        break;
      case 'user':
        if (!state.foundFirstUser) {
          state.foundFirstUser = true;
          state.firstUserContent = msg.content;
        }
        break;
      case 'text':
        if (msg.content) state.latestText = msg.content;
        break;
      case 'tool_start': {
        if (!msg.input) break;
        if (msg.tool === 'TaskCreate') {
          state.hasTaskTools = true;
          state.created++;
        } else if (msg.tool === 'TaskUpdate') {
          state.hasTaskTools = true;
          const taskId = msg.input.taskId;
          const status = msg.input.status;
          if (typeof taskId === 'string' && typeof status === 'string') {
            state.statusById.set(taskId, status);
          }
        } else if (msg.tool === 'TodoWrite') {
          const todos = msg.input.todos as Array<{ status: string }> | undefined;
          if (todos && Array.isArray(todos) && todos.length > 0) {
            const completed = todos.filter(t => t.status === 'completed').length;
            state.legacyTodo = { completed, total: todos.length };
          }
        }
        break;
      }
    }
  }
  state.messages = messages;
  state.summary = null;
}

/**
 * Whether a message contributes to the fold. A differing tail made only of
 * irrelevant messages (thinking, tool results, notifications, ...) can be
 * swapped out without invalidating the state.
 */
function isRelevant(msg: SdkMessage): boolean {
  switch (msg.type) {
    case 'done':
    case 'stopped':
    case 'subagent_start':
    case 'subagent_stop':
    case 'user':
      return true;
    case 'text':
      return !!msg.content;
    case 'tool_start':
      return !!msg.input &&
        (msg.tool === 'TaskCreate' || msg.tool === 'TaskUpdate' || msg.tool === 'TodoWrite');
    default:
      return false;
  }
}

/**
 * Index from which `next` must be folded onto a state built from `prev`, or -1
 * when the state is invalid and a full rescan is needed.
 */
function resumeIndex(prev: readonly SdkMessage[], next: readonly SdkMessage[]): number {
  const prevLen = prev.length;
  if (prevLen === 0) return 0;
  // Fast path — pure append: the last scanned message sits at the same index,
  // plus a couple of anchors to catch wholesale array replacement.
  if (
    next.length >= prevLen &&
    next[prevLen - 1] === prev[prevLen - 1] &&
    next[0] === prev[0] &&
    next[prevLen >> 1] === prev[prevLen >> 1]
  ) {
    return prevLen;
  }
  // Something before the old end was replaced, removed or truncated (thinking-end
  // replaces its entry, reactivation slices a trailing 'done', ghost turns are
  // relocated). Find the common prefix; if everything past it in the old array
  // was irrelevant to the fold, the state still describes that prefix.
  const limit = Math.min(prevLen, next.length);
  let common = 0;
  while (common < limit && next[common] === prev[common]) common++;
  for (let i = common; i < prevLen; i++) {
    if (isRelevant(prev[i])) return -1;
  }
  return common;
}

function buildSummary(state: ScanState): TranscriptSummary {
  let todoProgress: TranscriptSummary['todoProgress'];
  if (state.hasTaskTools) {
    let completed = 0;
    let deleted = 0;
    for (const status of state.statusById.values()) {
      if (status === 'deleted') deleted++;
      else if (status === 'completed') completed++;
    }
    const total = Math.max(0, state.created - deleted);
    todoProgress = total === 0 ? undefined : { completed: Math.min(completed, total), total };
  } else {
    todoProgress = state.legacyTodo;
  }
  return {
    liveSubagentTypes: [...state.live.values()],
    todoProgress,
    firstUserContent: state.firstUserContent,
    latestText: state.latestText,
  };
}

/** Full (non-incremental) scan — the reference implementation. */
export function scanTranscriptFull(messages: readonly SdkMessage[]): TranscriptSummary {
  const state = emptyState();
  foldFrom(state, messages, 0);
  return buildSummary(state);
}

const scanStates = new Map<string, ScanState>();

/**
 * Summary of `messages` for the session `key`, folding only what was appended
 * since the last call for that key when possible. Returns the identical summary
 * object while the array is unchanged.
 */
export function scanTranscript(key: string, messages: readonly SdkMessage[]): TranscriptSummary {
  let state = scanStates.get(key);
  if (!state) {
    state = emptyState();
    scanStates.set(key, state);
    foldFrom(state, messages, 0);
  } else if (state.messages !== messages) {
    const from = resumeIndex(state.messages, messages);
    if (from < 0) {
      state = emptyState();
      scanStates.set(key, state);
      foldFrom(state, messages, 0);
    } else {
      foldFrom(state, messages, from);
    }
  }
  return (state.summary ??= buildSummary(state));
}

/** Drop scan state for sessions that no longer exist. */
export function pruneTranscriptScans(liveKeys: ReadonlySet<string>): void {
  for (const key of scanStates.keys()) {
    if (!liveKeys.has(key)) scanStates.delete(key);
  }
}
