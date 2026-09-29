import type { SdkMessage } from '$lib/stores/sdkSessions';
import {
  processSdkMessages,
  mergeToolResult,
  isTaskToolCall,
  buildTaskRenderItem,
  computeNestedByParent,
  collectOrphanTasks,
  insertOrphanTasks,
  type RenderItem,
  type TaskIndex,
} from './sdkViewMessageProcessing';

// Incremental versions of the SdkView message pipeline
// (processSdkMessages → buildRenderItems, plus the fork-support index lookup).
//
// The from-scratch functions re-walk the whole transcript on every store tick —
// a dozen passes and thousands of Map operations per event on a 5–9k message
// session, for every visible pane. These builders keep their state between
// calls and only process what changed. The store never mutates a message in
// place, so "what changed" is found by comparing element references against the
// previous input (a pointer scan, far cheaper than one real pass):
//
//  - pure appends (the overwhelming majority of events),
//  - a few in-place replacements (thinking-end closes a thinking entry; a tool
//    result turns a running tool_start slot into the merged result),
//  - a trailing removal (reactivateOnActivity drops the last 'done').
//
// Anything else — forks, truncation of real content, restore, replacements that
// touch task bookkeeping — falls back to a full rebuild. The output is required
// to be IDENTICAL to the from-scratch functions; incrementalRenderPipeline.test.ts
// checks that against randomized event streams. Every builder is safe to call
// with any sequence of inputs: each call diffs against the previous one.

// Past this many in-place replacements a from-scratch pass is simpler and no slower.
const MAX_REPLACEMENTS = 64;

/** Indices i < min(prev, next length) where the element changed; null past the limit. */
function changedIndices(prev: SdkMessage[], next: SdkMessage[]): number[] | null {
  const out: number[] = [];
  const m = Math.min(prev.length, next.length);
  for (let i = 0; i < m; i++) {
    if (prev[i] !== next[i]) {
      out.push(i);
      if (out.length > MAX_REPLACEMENTS) return null;
    }
  }
  return out;
}

const isToolMsg = (m: SdkMessage) => m.type === 'tool_start' || m.type === 'tool_result';

// ---------------------------------------------------------------------------
// processSdkMessages
// ---------------------------------------------------------------------------

// A message that processSdkMessages passes straight through and that can't
// influence any other output slot: not a tool call, carries no toolUseId.
const isInert = (m: SdkMessage) => !isToolMsg(m) && !m.toolUseId;

function allInert(msgs: SdkMessage[], from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (!isInert(msgs[i])) return false;
  return true;
}

// Output slot kinds. Each input message produces at most one slot, in order.
const SLOT_PLAIN = 0; // the message itself
const SLOT_START = 1; // tool_start with id: its merged result once one exists
const SLOT_RESULT = 2; // standalone tool_result with id (no tool_start before it)
const SLOT_RESULT_NOID = 3; // tool_result without id

// How often each builder took the incremental path vs a from-scratch rebuild
// (a same-reference input counts as neither). Read by the tests.
export interface BuildStats {
  full: number;
  incremental: number;
}

export interface SdkMessageProcessor {
  update(messages: SdkMessage[]): SdkMessage[];
  readonly stats: BuildStats;
}

/**
 * Incremental `processSdkMessages`. Equivalence with the full pass rests on two
 * facts: the full pass's per-slot output depends only on the slot's own message
 * plus the final `toolResults` / `toolInputs` maps (which appends only extend),
 * and "is this tool_result already shown at its tool_start" is positional (a
 * tool_start with the same id appears earlier in the array), so appends never
 * change it for existing slots. Legacy sessions (no toolUseIds anywhere) match
 * tools by lookahead, so they only take the incremental path for inert changes.
 */
export function createSdkMessageProcessor(): SdkMessageProcessor {
  let input: SdkMessage[] | null = null;
  let output: SdkMessage[] = [];
  let legacy = false;
  const stats: BuildStats = { full: 0, incremental: 0 };

  // Per input index: slot index, or -1 when the message produced no slot.
  let inSlot: number[] = [];
  // Per slot: source message and kind.
  let slotMsg: SdkMessage[] = [];
  let slotKind: number[] = [];
  let toolResults = new Map<string, SdkMessage>();
  let toolInputs = new Map<string, Record<string, unknown>>();
  let startSeen = new Set<string>();
  // Slots whose value depends on a given toolUseId's result/input.
  let slotsById = new Map<string, number[]>();

  function addSlot(i: number, msg: SdkMessage, kind: number, id?: string) {
    const s = slotMsg.length;
    inSlot[i] = s;
    slotMsg.push(msg);
    slotKind.push(kind);
    if (id) {
      const list = slotsById.get(id);
      if (list) list.push(s);
      else slotsById.set(id, [s]);
    }
  }

  function appendOne(msg: SdkMessage, i: number, dirty: Set<string>) {
    const id = msg.toolUseId;
    if (msg.type === 'tool_start') {
      if (!id) return addSlot(i, msg, SLOT_PLAIN);
      startSeen.add(id);
      if (msg.input) {
        toolInputs.set(id, msg.input);
        dirty.add(id);
      }
      addSlot(i, msg, SLOT_START, id);
    } else if (msg.type === 'tool_result') {
      if (!id) return addSlot(i, msg, SLOT_RESULT_NOID);
      toolResults.set(id, msg);
      dirty.add(id);
      // Shown at its tool_start's position when one came earlier.
      if (startSeen.has(id)) inSlot[i] = -1;
      else addSlot(i, msg, SLOT_RESULT, id);
    } else {
      addSlot(i, msg, SLOT_PLAIN);
    }
  }

  function slotValue(s: number): SdkMessage {
    const msg = slotMsg[s];
    switch (slotKind[s]) {
      case SLOT_START: {
        const result = toolResults.get(msg.toolUseId!);
        return result ? mergeToolResult(result, toolInputs.get(msg.toolUseId!)) : msg;
      }
      case SLOT_RESULT:
        return mergeToolResult(msg, toolInputs.get(msg.toolUseId!));
      case SLOT_RESULT_NOID:
        return mergeToolResult(msg, undefined);
      default:
        return msg;
    }
  }

  /** Fill slots from `firstNew` on, and refresh older slots tied to a dirty id. */
  function finalize(out: SdkMessage[], firstNew: number, dirty: Set<string>): SdkMessage[] {
    for (let s = firstNew; s < slotMsg.length; s++) out[s] = slotValue(s);
    for (const id of dirty) {
      const list = slotsById.get(id);
      if (!list) continue;
      for (const s of list) if (s < firstNew) out[s] = slotValue(s);
    }
    return out;
  }

  function rebuild(msgs: SdkMessage[]): SdkMessage[] {
    stats.full++;
    inSlot = [];
    slotMsg = [];
    slotKind = [];
    toolResults = new Map();
    toolInputs = new Map();
    startSeen = new Set();
    slotsById = new Map();
    legacy = !msgs.some((m) => m.toolUseId);
    if (legacy) {
      output = processSdkMessages(msgs);
      return output;
    }
    const dirty = new Set<string>();
    for (let i = 0; i < msgs.length; i++) appendOne(msgs[i], i, dirty);
    output = finalize([], 0, dirty);
    return output;
  }

  function update(msgs: SdkMessage[]): SdkMessage[] {
    if (msgs === input) return output;
    const prev = input;
    input = msgs;
    if (!prev) return rebuild(msgs);

    const p = prev.length;
    const n = msgs.length;
    const replaced = changedIndices(prev, msgs);
    if (!replaced) return rebuild(msgs);
    if (replaced.length === 0 && n === p) return output;
    const d = replaced.length > 0 ? replaced[0] : Math.min(p, n);

    // Strategy A: everything from the first change on is dropped and re-appended.
    // Valid when the dropped messages are inert (covers appends, the trailing
    // 'done' swap, and a replacement near the end).
    if (allInert(prev, d, p) && (!legacy || allInert(msgs, d, n))) {
      stats.incremental++;
      if (legacy) {
        // Inert messages map 1:1 onto the last output slots and don't affect the
        // lookahead matching of tool calls.
        const out = output.slice(0, output.length - (p - d));
        for (let i = d; i < n; i++) out.push(msgs[i]);
        output = out;
        return output;
      }
      const keep = d < p ? inSlot[d] : slotMsg.length;
      slotMsg.length = keep;
      slotKind.length = keep;
      inSlot.length = d;
      const dirty = new Set<string>();
      for (let i = d; i < n; i++) appendOne(msgs[i], i, dirty);
      output = finalize(output.slice(0, keep), keep, dirty);
      return output;
    }

    // Strategy B: inert-for-inert replacements in place (a thinking entry closing
    // mid-array), then plain appends.
    if (!legacy && n >= p && replaced.every((i) => isInert(prev[i]) && isInert(msgs[i]))) {
      stats.incremental++;
      const out = output.slice();
      for (const i of replaced) {
        const s = inSlot[i];
        slotMsg[s] = msgs[i];
        out[s] = msgs[i];
      }
      const firstNew = slotMsg.length;
      const dirty = new Set<string>();
      for (let i = p; i < n; i++) appendOne(msgs[i], i, dirty);
      output = finalize(out, firstNew, dirty);
      return output;
    }

    return rebuild(msgs);
  }

  return { update, stats };
}

// ---------------------------------------------------------------------------
// buildRenderItems
// ---------------------------------------------------------------------------

const FILTERED_TYPES = new Set(['subagent_stop', 'done', 'stopped']);
// Never rendered in the main stream; consumed by task bookkeeping instead.
const META_TYPES = new Set(['task_started', 'task_completed', 'subagent_start']);

const isTaskTool = (m: SdkMessage) => isToolMsg(m) && (m.tool === 'Task' || m.tool === 'Agent');

export interface RenderItemsBuilder {
  update(processed: SdkMessage[], isGridMode: boolean): RenderItem[];
  readonly stats: BuildStats;
}

/**
 * Incremental `buildRenderItems`, fed the (processed) messages.
 *
 * State mirrors the full build's steps: the task index (maps + the insertion
 * order of knownTaskToolUseIds, tracked per registration step so it can be
 * reproduced exactly), the main-stream message list, and a checkpoint per
 * main-stream position recording how many render items had been emitted and
 * where the open tool group started — so Step 5 can resume from any position
 * instead of from the top. Task blocks read global maps, so whenever task
 * bookkeeping changes every task block is rebuilt (there are only tens) and
 * orphan placement is redone; plain chat traffic touches neither.
 */
export function createRenderItemsBuilder(): RenderItemsBuilder {
  let input: SdkMessage[] | null = null;
  let grid = false;
  let output: RenderItem[] = [];
  const stats: BuildStats = { full: 0, incremental: 0 };

  let known = new Set<string>();
  // First-appearance order per registration step (Step 1 / Step 2 / Step 2.5);
  // concatenated with dedupe this reproduces the full build's Set order.
  let step1 = new Set<string>();
  let step2 = new Set<string>();
  let step25 = new Set<string>();
  let ix: TaskIndex = emptyIndex(known);

  // Per processed index: main-stream index / position in its parent's children (or -1).
  let pMain: number[] = [];
  let pChild: number[] = [];
  let main: SdkMessage[] = [];
  // First main-stream index of a top-level tool call per toolUseId: where Step 5
  // must resume if that id later turns out to be a task container.
  let mainToolFirst = new Map<string, number>();
  // cpItems[j] / cpGroup[j]: items emitted / open group start before main[j]
  // (index main.length = before the final flush).
  let cpItems: number[] = [0];
  let cpGroup: number[] = [-1];
  let mainItems: RenderItem[] = [];
  // Task items emitted by Step 5: item index + anchoring main-stream index.
  let taskRefItem: number[] = [];
  let taskRefMain: number[] = [];

  // Per-update scratch.
  let restart = Infinity;
  let tasksDirty = false;
  let newlyKnown: string[] = [];
  let copied = new Set<string>();

  function emptyIndex(knownSet: Set<string>): TaskIndex {
    return {
      taskStartMap: new Map(),
      taskCompletedMap: new Map(),
      taskCompletedByTaskId: new Map(),
      taskChildrenMap: new Map(),
      knownTaskToolUseIds: knownSet,
      taskParentId: new Map(),
      taskToolInput: new Map(),
      nestedByParent: new Map(),
    };
  }

  function orderedKnown(): string[] {
    const out = [...step1];
    for (const id of step2) if (!step1.has(id)) out.push(id);
    for (const id of step25) if (!step1.has(id) && !step2.has(id)) out.push(id);
    return out;
  }

  function register(id: string, step: Set<string>) {
    if (step.has(id)) return;
    step.add(id);
    tasksDirty = true;
    if (!known.has(id)) {
      known.add(id);
      newlyKnown.push(id);
      if (!ix.taskChildrenMap.has(id)) ix.taskChildrenMap.set(id, []);
    }
  }

  // Children arrays are shared with previously returned task items (and compared
  // by reference downstream), so copy one before its first change per update.
  function childrenForWrite(parent: string): SdkMessage[] {
    let list = ix.taskChildrenMap.get(parent)!;
    if (!copied.has(parent)) {
      list = list.slice();
      ix.taskChildrenMap.set(parent, list);
      copied.add(parent);
    }
    return list;
  }

  function isPlainMain(m: SdkMessage): boolean {
    return (
      !m.parentToolUseId &&
      !META_TYPES.has(m.type) &&
      !isTaskTool(m) &&
      !(isToolMsg(m) && m.toolUseId && known.has(m.toolUseId))
    );
  }

  function isPlainChild(m: SdkMessage): boolean {
    return !!m.parentToolUseId && m.type !== 'task_started' && m.type !== 'task_completed' && !isTaskTool(m);
  }

  function append(msg: SdkMessage, i: number) {
    pMain[i] = -1;
    pChild[i] = -1;
    if (FILTERED_TYPES.has(msg.type)) return;
    const id = msg.toolUseId;
    const parent = msg.parentToolUseId;
    const taskTool = isTaskTool(msg);

    // Step 1
    if (taskTool && !parent && id) register(id, step1);
    // Step 2
    if (msg.type === 'task_started' && id) {
      ix.taskStartMap.set(id, msg);
      register(id, step2);
      tasksDirty = true;
    }
    if (msg.type === 'task_completed') {
      if (id) ix.taskCompletedMap.set(id, msg);
      if (msg.taskId) ix.taskCompletedByTaskId.set(msg.taskId, msg);
      tasksDirty = true;
    }
    // Step 2.5
    if (parent) register(parent, step25);
    // Step 3.5
    if (taskTool && id) {
      if (parent) ix.taskParentId.set(id, parent);
      if (msg.input && !ix.taskToolInput.has(id)) ix.taskToolInput.set(id, msg.input);
      tasksDirty = true;
    }

    if (parent) {
      // Step 3
      const list = childrenForWrite(parent);
      pChild[i] = list.length;
      list.push(msg);
      tasksDirty = true;
    } else if (!META_TYPES.has(msg.type)) {
      // Step 4: main stream
      const j = main.length;
      main.push(msg);
      pMain[i] = j;
      if (isToolMsg(msg) && id && !mainToolFirst.has(id)) mainToolFirst.set(id, j);
      if (j < restart) restart = j;
    }
  }

  /** Swap `o` for `n` at processed index i without touching bookkeeping order. */
  function replace(i: number, o: SdkMessage, n: SdkMessage): boolean {
    const oFiltered = FILTERED_TYPES.has(o.type);
    const nFiltered = FILTERED_TYPES.has(n.type);
    if (oFiltered || nFiltered) return oFiltered && nFiltered;
    if (pMain[i] >= 0) {
      if (!isPlainMain(o) || !isPlainMain(n)) return false;
      if (o.toolUseId !== n.toolUseId || isToolMsg(o) !== isToolMsg(n)) return false;
      const j = pMain[i];
      main[j] = n;
      if (j < restart) restart = j;
      return true;
    }
    if (pChild[i] >= 0) {
      if (n.parentToolUseId !== o.parentToolUseId || !isPlainChild(o) || !isPlainChild(n)) return false;
      childrenForWrite(o.parentToolUseId!)[pChild[i]] = n;
      tasksDirty = true;
      return true;
    }
    return false;
  }

  // Only filtered and plain main-stream messages can be dropped from the end:
  // removing a child or task message could change first-appearance order.
  function canRemove(i: number, o: SdkMessage): boolean {
    return FILTERED_TYPES.has(o.type) || (pMain[i] >= 0 && isPlainMain(o));
  }

  function removeLast(i: number, o: SdkMessage) {
    const j = pMain[i];
    if (j < 0) return; // filtered
    main.pop();
    if (isToolMsg(o) && o.toolUseId && mainToolFirst.get(o.toolUseId) === j) {
      mainToolFirst.delete(o.toolUseId);
    }
    if (j < restart) restart = j;
  }

  /** Step 5 from main-stream index k on; returns the items and the cut point. */
  function fold(k: number): { items: RenderItem[]; cut: number } {
    const cut = cpItems[k];
    const items = mainItems.slice(0, cut);
    let r = taskRefItem.length;
    while (r > 0 && taskRefItem[r - 1] >= cut) r--;
    taskRefItem.length = r;
    taskRefMain.length = r;
    let groupStart = cpGroup[k];
    let group: SdkMessage[] = groupStart >= 0 ? main.slice(groupStart, k) : [];
    cpItems.length = k;
    cpGroup.length = k;

    for (let j = k; j < main.length; j++) {
      cpItems.push(items.length);
      cpGroup.push(group.length > 0 ? groupStart : -1);
      const msg = main[j];
      if (isTaskToolCall(msg, known)) {
        if (group.length > 0 && grid) {
          items.push({ type: 'tool_group', tools: group });
          group = [];
        }
        taskRefItem.push(items.length);
        taskRefMain.push(j);
        items.push(buildTaskRenderItem(msg, ix));
      } else if (grid) {
        const isToolMessage = isToolMsg(msg) || msg.type === 'thinking';
        const hasImages = msg.images && msg.images.length > 0;
        if (isToolMessage && !hasImages) {
          if (group.length === 0) groupStart = j;
          group.push(msg);
        } else {
          if (group.length > 0) {
            items.push({ type: 'tool_group', tools: group });
            group = [];
          }
          items.push({ type: 'message', message: msg });
        }
      } else {
        items.push({ type: 'message', message: msg });
      }
    }
    cpItems.push(items.length);
    cpGroup.push(group.length > 0 ? groupStart : -1);
    if (group.length > 0 && grid) items.push({ type: 'tool_group', tools: group });
    return { items, cut };
  }

  function finish(): RenderItem[] {
    for (const id of newlyKnown) {
      // A top-level tool call already rendered as a plain card is now a task container.
      const j = mainToolFirst.get(id);
      if (j !== undefined && j < restart) restart = j;
    }
    if (restart === Infinity && !tasksDirty) return output;

    const order = tasksDirty ? orderedKnown() : null;
    if (order) ix.nestedByParent = computeNestedByParent(ix, order);

    let items: RenderItem[];
    let cut: number;
    if (restart !== Infinity) {
      ({ items, cut } = fold(restart));
    } else {
      items = mainItems.slice();
      cut = items.length;
    }
    if (tasksDirty) {
      for (let r = 0; r < taskRefItem.length && taskRefItem[r] < cut; r++) {
        items[taskRefItem[r]] = buildTaskRenderItem(main[taskRefMain[r]], ix);
      }
    }
    mainItems = items;

    const rendered = new Set<string>();
    for (const j of taskRefMain) rendered.add(main[j].toolUseId!);
    const orphans = collectOrphanTasks(ix, order ?? orderedKnown(), rendered);
    if (orphans.length > 0) {
      const withOrphans = items.slice();
      insertOrphanTasks(withOrphans, orphans);
      output = withOrphans;
    } else {
      output = items;
    }
    return output;
  }

  function rebuild(processed: SdkMessage[], isGridMode: boolean): RenderItem[] {
    stats.full++;
    input = processed;
    grid = isGridMode;
    known = new Set();
    step1 = new Set();
    step2 = new Set();
    step25 = new Set();
    ix = emptyIndex(known);
    pMain = [];
    pChild = [];
    main = [];
    mainToolFirst = new Map();
    cpItems = [0];
    cpGroup = [-1];
    mainItems = [];
    taskRefItem = [];
    taskRefMain = [];
    output = [];
    beginUpdate();
    for (let i = 0; i < processed.length; i++) append(processed[i], i);
    restart = 0;
    tasksDirty = true;
    return finish();
  }

  function beginUpdate() {
    restart = Infinity;
    tasksDirty = false;
    newlyKnown = [];
    copied = new Set();
  }

  function update(processed: SdkMessage[], isGridMode: boolean): RenderItem[] {
    if (processed === input && isGridMode === grid) return output;
    const prev = input;
    if (!prev || isGridMode !== grid) return rebuild(processed, isGridMode);

    const p = prev.length;
    const n = processed.length;
    const replaced = changedIndices(prev, processed);
    if (!replaced) return rebuild(processed, isGridMode);
    input = processed;
    beginUpdate();
    const d = replaced.length > 0 ? replaced[0] : Math.min(p, n);

    let removable = true;
    for (let i = d; i < p && removable; i++) removable = canRemove(i, prev[i]);
    if (removable) {
      // Strategy A: drop everything from the first change on, then re-append.
      for (let i = p - 1; i >= d; i--) removeLast(i, prev[i]);
      pMain.length = d;
      pChild.length = d;
      for (let i = d; i < n; i++) append(processed[i], i);
      stats.incremental++;
      return finish();
    }

    // Strategy B: in-place replacements, then the tail change.
    for (const i of replaced) {
      if (!replace(i, prev[i], processed[i])) return rebuild(processed, isGridMode);
    }
    if (n < p) {
      for (let i = p - 1; i >= n; i--) {
        if (!canRemove(i, prev[i])) return rebuild(processed, isGridMode);
        removeLast(i, prev[i]);
      }
      pMain.length = n;
      pChild.length = n;
    } else {
      for (let i = p; i < n; i++) append(processed[i], i);
    }
    stats.incremental++;
    return finish();
  }

  return { update, stats };
}

// ---------------------------------------------------------------------------
// Original-index lookup (fork support)
// ---------------------------------------------------------------------------

export interface MessageIndexLookup {
  /** Index of `msg`'s source in the raw messages array (first match), or -1. */
  indexOf(msg: SdkMessage): number;
}

export interface MessageIndexer {
  update(messages: SdkMessage[]): MessageIndexLookup;
}

/**
 * Maps a processed message back to its index in the raw messages array: by
 * (type, toolUseId) first — merged tool results keep the tool_result's id —
 * then by (type, timestamp). First match wins. Kept incrementally: on a change
 * at index d only entries pointing at d or later are dropped and re-added,
 * which leaves exactly the first-match entries of the untouched prefix.
 */
export function createMessageIndexer(): MessageIndexer {
  let input: SdkMessage[] | null = null;
  const byToolUse = new Map<string, Map<string, number>>();
  const byTimestamp = new Map<string, Map<number, number>>();
  let lookup: MessageIndexLookup = makeLookup();

  function makeLookup(): MessageIndexLookup {
    return {
      indexOf(msg) {
        if (msg.toolUseId) {
          const idx = byToolUse.get(msg.type)?.get(msg.toolUseId);
          if (idx !== undefined) return idx;
        }
        return byTimestamp.get(msg.type)?.get(msg.timestamp) ?? -1;
      },
    };
  }

  function add(m: SdkMessage, i: number) {
    if (m.toolUseId) {
      let byId = byToolUse.get(m.type);
      if (!byId) byToolUse.set(m.type, (byId = new Map()));
      if (!byId.has(m.toolUseId)) byId.set(m.toolUseId, i);
    }
    let byTs = byTimestamp.get(m.type);
    if (!byTs) byTimestamp.set(m.type, (byTs = new Map()));
    if (!byTs.has(m.timestamp)) byTs.set(m.timestamp, i);
  }

  function drop(m: SdkMessage, i: number) {
    if (m.toolUseId) {
      const byId = byToolUse.get(m.type);
      if (byId?.get(m.toolUseId) === i) byId.delete(m.toolUseId);
    }
    const byTs = byTimestamp.get(m.type);
    if (byTs?.get(m.timestamp) === i) byTs.delete(m.timestamp);
  }

  function update(msgs: SdkMessage[]): MessageIndexLookup {
    if (msgs === input) return lookup;
    const prev = input ?? [];
    input = msgs;
    const m = Math.min(prev.length, msgs.length);
    let d = 0;
    while (d < m && prev[d] === msgs[d]) d++;
    if (d === prev.length && d === msgs.length) return lookup;
    for (let i = prev.length - 1; i >= d; i--) drop(prev[i], i);
    for (let i = d; i < msgs.length; i++) add(msgs[i], i);
    // A fresh object so reactive readers re-run; the maps themselves are shared.
    lookup = makeLookup();
    return lookup;
  }

  return { update };
}

