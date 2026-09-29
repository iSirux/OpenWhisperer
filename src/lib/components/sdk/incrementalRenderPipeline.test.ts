// Run: npx tsx --test src/lib/components/sdk/incrementalRenderPipeline.test.ts
//
// The incremental builders must produce output IDENTICAL to the from-scratch
// processSdkMessages / buildRenderItems for every input sequence. These tests
// drive both with randomized event streams shaped like real store traffic
// (appends, thinking-end in-place replacement, tool results merging into their
// tool_start slot, subagents with task_started/task_completed, the trailing
// 'done' swap, orphans, retroactive task containers) plus the non-append edits
// (fork truncation, ghost filtering, arbitrary replacement) that must fall back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SdkMessage } from '$lib/stores/sdkSessions';
import {
  processSdkMessages,
  buildRenderItems,
  mergeTaskChildren,
  mergeToolResult,
  type RenderItem,
} from './sdkViewMessageProcessing';
import {
  createSdkMessageProcessor,
  createRenderItemsBuilder,
  createMessageIndexer,
} from './incrementalRenderPipeline';

// --- deterministic PRNG -----------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- random session simulator -------------------------------------------------
interface SimOptions {
  legacy?: boolean; // no toolUseIds at all
  steps: number;
  mutations?: boolean; // include non-append edits (fork, ghost removal, random replace)
}

function* simulate(seed: number, opts: SimOptions): Generator<SdkMessage[]> {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const chance = (p: number) => rnd() < p;
  let msgs: SdkMessage[] = [];
  let clock = 1_000;
  let nextId = 0;
  const tick = () => {
    // Frequent same-millisecond bursts, like parallel tool calls.
    if (!chance(0.35)) clock += 1 + Math.floor(rnd() * 3);
    return clock;
  };
  const openTools: { id?: string; tool: string; parent?: string }[] = [];
  const agents: { id: string; parent?: string; tool: string }[] = [];
  const liveAgents: string[] = [];
  const topLevelToolIds: string[] = [];

  const parentFor = (): string | undefined => {
    if (opts.legacy) return undefined;
    if (liveAgents.length > 0 && chance(0.55)) return pick(liveAgents);
    if (chance(0.03)) return `orphan-${Math.floor(rnd() * 3)}`;
    return undefined;
  };
  const push = (m: SdkMessage) => {
    msgs = [...msgs, m];
  };

  for (let step = 0; step < opts.steps; step++) {
    const r = rnd();
    if (r < 0.06) {
      push({ type: 'user', content: `u${step}`, timestamp: tick() });
    } else if (r < 0.18) {
      push({ type: 'text', content: `t${step}`, parentToolUseId: parentFor(), timestamp: tick() });
    } else if (r < 0.24) {
      push({ type: 'thinking', content: '', parentToolUseId: parentFor(), timestamp: tick() });
    } else if (r < 0.29) {
      // thinking-end: replace an open thinking entry in place (often mid-array).
      const open = msgs.map((m, i) => [m, i] as const).filter(([m]) => m.type === 'thinking' && m.thinkingDurationMs === undefined);
      if (open.length > 0) {
        const [m, i] = pick(open);
        const next = msgs.slice();
        next[i] = { ...m, thinkingDurationMs: 100 + step, content: `thought${step}` };
        msgs = next;
      }
    } else if (r < 0.47) {
      // Ordinary tool call.
      const id = opts.legacy || chance(0.02) ? undefined : `tool-${nextId++}`;
      const tool = pick(['Read', 'Bash', 'Edit', 'Grep']);
      const parent = parentFor();
      openTools.push({ id, tool, parent });
      if (id && !parent) topLevelToolIds.push(id);
      push({
        type: 'tool_start',
        tool,
        toolUseId: id,
        input: chance(0.9) ? { path: `/f${step}` } : undefined,
        parentToolUseId: parent,
        timestamp: tick(),
      });
    } else if (r < 0.62) {
      if (openTools.length > 0) {
        const idx = Math.floor(rnd() * openTools.length);
        const t = openTools[idx];
        openTools.splice(idx, 1);
        push({
          type: 'tool_result',
          tool: t.tool,
          toolUseId: t.id,
          output: `out${step}`,
          parentToolUseId: chance(0.95) ? t.parent : parentFor(),
          images: chance(0.05) ? [{ mediaType: 'image/png', base64Data: 'x' }] : undefined,
          timestamp: tick(),
        });
        // Rare duplicate result for the same id.
        if (t.id && chance(0.03)) {
          push({ type: 'tool_result', tool: t.tool, toolUseId: t.id, output: 'dup', parentToolUseId: t.parent, timestamp: tick() });
        }
      } else if (!opts.legacy && chance(0.2)) {
        // Standalone result (its tool_start never arrived / arrives later).
        const id = `tool-${nextId++}`;
        push({ type: 'tool_result', tool: 'Read', toolUseId: id, output: 'lone', timestamp: tick() });
        if (chance(0.5)) {
          push({ type: 'tool_start', tool: 'Read', toolUseId: id, input: { late: true }, timestamp: tick() });
        }
      }
    } else if (r < 0.68 && !opts.legacy) {
      // Subagent launch (top-level or nested).
      const id = `agent-${nextId++}`;
      const parent = liveAgents.length > 0 && chance(0.25) ? pick(liveAgents) : undefined;
      const tool = chance(0.8) ? 'Agent' : 'Task';
      agents.push({ id, parent, tool });
      liveAgents.push(id);
      push({
        type: 'tool_start',
        tool,
        toolUseId: id,
        input: chance(0.8)
          ? { subagent_type: pick(['Explore', 'general-purpose']), description: `d${step}`, prompt: 'p', model: chance(0.3) ? 'sonnet' : undefined }
          : undefined,
        parentToolUseId: parent,
        timestamp: tick(),
      });
      if (chance(0.6)) {
        push({ type: 'tool_result', tool, toolUseId: id, output: 'Async agent launched successfully', parentToolUseId: parent, timestamp: tick() });
      }
    } else if (r < 0.71 && agents.length > 0) {
      const a = pick(agents);
      push({
        type: 'task_started',
        toolUseId: chance(0.85) ? a.id : undefined,
        taskId: `task-${a.id}`,
        description: chance(0.5) ? `desc-${a.id}` : undefined,
        taskType: pick(['local_agent', 'Explore', undefined as unknown as string]),
        parentToolUseId: chance(0.1) ? a.parent : undefined,
        timestamp: tick(),
      });
    } else if (r < 0.74 && liveAgents.length > 0) {
      const id = pick(liveAgents);
      liveAgents.splice(liveAgents.indexOf(id), 1);
      push({
        type: 'task_completed',
        toolUseId: chance(0.7) ? id : undefined,
        taskId: `task-${id}`,
        taskStatus: pick(['completed', 'failed', 'stopped']),
        summary: chance(0.5) ? `sum-${id}` : '',
        taskUsage: chance(0.6) ? { total_tokens: 10, tool_uses: step, duration_ms: 5 } : undefined,
        timestamp: tick(),
      });
    } else if (r < 0.76 && topLevelToolIds.length > 0 && !opts.legacy) {
      // Retroactive container: an ordinary top-level tool id later referenced as a task.
      const id = pick(topLevelToolIds);
      if (chance(0.5)) {
        push({ type: 'task_started', toolUseId: id, taskId: `task-${id}`, timestamp: tick() });
      } else {
        push({ type: 'text', content: 'child of plain tool', parentToolUseId: id, timestamp: tick() });
      }
    } else if (r < 0.8) {
      push({ type: pick(['done', 'stopped', 'subagent_stop', 'subagent_start', 'error', 'notification'] as const), content: 'x', timestamp: tick() });
    } else if (r < 0.86) {
      // reactivateOnActivity: drop a trailing 'done' and append the new event.
      if (msgs.length > 0 && msgs[msgs.length - 1].type === 'done') {
        msgs = [...msgs.slice(0, -1), { type: 'text', content: `re${step}`, timestamp: tick() }];
      } else {
        push({ type: 'done', timestamp: tick() });
      }
    } else if (r < 0.88 && !opts.legacy && chance(0.3)) {
      // Duplicate tool_start for an existing id (e.g. a continued agent).
      const withId = msgs.filter((m) => m.type === 'tool_start' && m.toolUseId);
      if (withId.length > 0) push({ ...pick(withId), timestamp: tick() });
    } else if (opts.mutations && r < 0.9) {
      const kind = rnd();
      if (kind < 0.3 && msgs.length > 2) {
        // Fork / truncation.
        msgs = msgs.slice(0, Math.floor(rnd() * msgs.length));
      } else if (kind < 0.6 && msgs.length > 2) {
        // Ghost filtering: a message disappears from the middle.
        const i = Math.floor(rnd() * msgs.length);
        msgs = [...msgs.slice(0, i), ...msgs.slice(i + 1)];
      } else if (kind < 0.8 && msgs.length > 0) {
        // Arbitrary in-place replacement with a copy.
        const i = Math.floor(rnd() * msgs.length);
        const next = msgs.slice();
        next[i] = { ...next[i], content: `edited${step}` };
        msgs = next;
      } else if (msgs.length > 0) {
        // In-place replacement with an unrelated message (new id / type / parent).
        const i = Math.floor(rnd() * msgs.length);
        const next = msgs.slice();
        const id = chance(0.7) ? `tool-${nextId++}` : undefined;
        const parent = parentFor();
        // Candidate for a later retroactive task reference.
        if (id && !parent) topLevelToolIds.push(id);
        next[i] = chance(0.5)
          ? { type: pick(['tool_start', 'tool_result'] as const), tool: 'Read', toolUseId: id, input: { x: 1 }, parentToolUseId: parent, timestamp: tick() }
          : { type: pick(['text', 'thinking', 'done'] as const), content: 'swap', parentToolUseId: parent, timestamp: tick() };
        msgs = next;
      }
    } else {
      push({ type: 'text', content: `t${step}`, parentToolUseId: parentFor(), timestamp: tick() });
    }
    yield msgs;
  }
}

// --- comparison ---------------------------------------------------------------
// Messages that came from the processed input are compared by IDENTITY (the view
// relies on it to skip unchanged rows); synthesized ones (task_started merges,
// legacy completions) by value.
function normalize(items: RenderItem[], processed: SdkMessage[]) {
  const ids = new Map<SdkMessage, number>();
  processed.forEach((m, i) => {
    if (!ids.has(m)) ids.set(m, i);
  });
  const ref = (m: SdkMessage | undefined) =>
    m === undefined ? undefined : ids.has(m) ? `#${ids.get(m)}` : { synth: m };
  return items.map((item) => {
    if (item.type === 'message') return { t: 'message', m: ref(item.message) };
    if (item.type === 'tool_group') return { t: 'group', tools: item.tools.map(ref) };
    return {
      t: 'task',
      started: ref(item.taskStarted),
      children: item.children.map(ref),
      completed: ref(item.taskCompleted),
      nested: item.nestedSummaries ? [...item.nestedSummaries.entries()] : undefined,
      model: item.taskModel,
    };
  });
}

// The original string-keyed lookup SdkView used, as the oracle for the indexer.
function referenceIndex(messages: SdkMessage[]) {
  const byToolUse = new Map<string, number>();
  const byTimestamp = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.toolUseId) {
      const k = `${m.type}|${m.toolUseId}`;
      if (!byToolUse.has(k)) byToolUse.set(k, i);
    }
    const k = `${m.type}|${m.timestamp}`;
    if (!byTimestamp.has(k)) byTimestamp.set(k, i);
  });
  return (msg: SdkMessage) => {
    if (msg.toolUseId) {
      const idx = byToolUse.get(`${msg.type}|${msg.toolUseId}`);
      if (idx !== undefined) return idx;
    }
    return byTimestamp.get(`${msg.type}|${msg.timestamp}`) ?? -1;
  };
}

function runStream(seed: number, opts: SimOptions) {
  const proc = createSdkMessageProcessor();
  const builder = createRenderItemsBuilder();
  const indexer = createMessageIndexer();
  const rnd = mulberry32(seed ^ 0x5bd1e995);
  let grid = rnd() < 0.5;
  let step = 0;
  // Previous outputs must never be mutated afterwards: the view compares old vs
  // new rows by reference, so an in-place edit would hide a change.
  let prevProcessed: SdkMessage[] = [];
  let prevProcessedCopy: SdkMessage[] = [];
  let prevItems: RenderItem[] = [];
  let prevItemsSnapshot: unknown = [];
  for (const msgs of simulate(seed, opts)) {
    step++;
    if (rnd() < 0.02) grid = !grid;
    const where = `seed ${seed} step ${step}`;

    const processed = proc.update(msgs);
    const reference = processSdkMessages(msgs);
    assert.equal(processed.length, reference.length, `${where}: processed length`);
    for (let i = 0; i < reference.length; i++) {
      assert.ok(processed[i] === reference[i], `${where}: processed[${i}] identity`);
    }

    const items = builder.update(processed, grid);
    const refItems = buildRenderItems(reference, grid);
    assert.deepStrictEqual(normalize(items, processed), normalize(refItems, reference), `${where}: render items`);

    assert.ok(prevProcessed.every((m, i) => m === prevProcessedCopy[i]) && prevProcessed.length === prevProcessedCopy.length, `${where}: previous processed output mutated`);
    assert.deepStrictEqual(normalize(prevItems, prevProcessed), prevItemsSnapshot, `${where}: previous render items mutated`);
    prevProcessed = processed;
    prevProcessedCopy = processed.slice();
    prevItems = items;
    prevItemsSnapshot = normalize(items, processed);

    const lookup = indexer.update(msgs);
    const oracle = referenceIndex(msgs);
    for (const m of processed) assert.equal(lookup.indexOf(m), oracle(m), `${where}: index of processed`);
    for (const m of msgs) assert.equal(lookup.indexOf(m), oracle(m), `${where}: index of raw`);
  }
  return { proc: proc.stats, builder: builder.stats };
}

// Sum path counters across seeds (to prove the incremental path is exercised).
function runSeeds(from: number, to: number, opts: SimOptions) {
  const total = { procFull: 0, procInc: 0, builderFull: 0, builderInc: 0 };
  for (let seed = from; seed <= to; seed++) {
    const s = runStream(seed, opts);
    total.procFull += s.proc.full;
    total.procInc += s.proc.incremental;
    total.builderFull += s.builder.full;
    total.builderInc += s.builder.incremental;
  }
  return total;
}

test('incremental pipeline matches the full rebuild on append-heavy streams', () => {
  const t = runSeeds(1, 120, { steps: 220 });
  console.log('append-heavy', t);
  // Almost every event must take the incremental path, or this proves nothing.
  assert.ok(t.procInc > t.procFull * 20, 'processor mostly incremental');
  assert.ok(t.builderInc > t.builderFull * 5, 'builder mostly incremental');
});

test('incremental pipeline matches the full rebuild with forks, ghosts and edits', () => {
  const t = runSeeds(1000, 1100, { steps: 200, mutations: true });
  console.log('mutations', t);
  assert.ok(t.procFull > 100 && t.builderFull > 100, 'fallback paths exercised');
});

test('incremental pipeline matches the full rebuild on legacy (id-less) sessions', () => {
  const t = runSeeds(5000, 5040, { steps: 150, legacy: true, mutations: true });
  console.log('legacy', t);
});

// Run an explicit sequence of message arrays through both pipelines.
function assertSequence(name: string, sequence: SdkMessage[][]) {
  for (const grid of [false, true]) {
    const proc = createSdkMessageProcessor();
    const builder = createRenderItemsBuilder();
    sequence.forEach((msgs, step) => {
      const processed = proc.update(msgs);
      const reference = processSdkMessages(msgs);
      assert.ok(processed.length === reference.length && processed.every((m, i) => m === reference[i]), `${name} step ${step}: processed`);
      assert.deepStrictEqual(
        normalize(builder.update(processed, grid), processed),
        normalize(buildRenderItems(reference, grid), reference),
        `${name} step ${step} (grid ${grid}): render items`,
      );
    });
  }
}

test('scenario: thinking closes mid-array while a subagent keeps streaming', () => {
  const agent: SdkMessage = { type: 'tool_start', tool: 'Agent', toolUseId: 'ag', input: { description: 'x' }, timestamp: 1 };
  const think: SdkMessage = { type: 'thinking', content: '', timestamp: 2 };
  const c1: SdkMessage = { type: 'tool_start', tool: 'Read', toolUseId: 'c1', parentToolUseId: 'ag', input: {}, timestamp: 3 };
  const c1r: SdkMessage = { type: 'tool_result', tool: 'Read', toolUseId: 'c1', parentToolUseId: 'ag', output: 'o', timestamp: 4 };
  const s1 = [agent, think, c1];
  const s2 = [...s1, c1r];
  const s3 = s2.slice();
  s3[1] = { ...think, thinkingDurationMs: 10, content: 'done thinking' };
  const s4 = [...s3, { type: 'task_completed', toolUseId: 'ag', taskId: 't', taskStatus: 'completed', timestamp: 5 } as SdkMessage];
  const s5 = [...s4, { type: 'done', timestamp: 6 } as SdkMessage];
  const s6 = [...s5.slice(0, -1), { type: 'text', content: 'next turn', timestamp: 7 } as SdkMessage];
  assertSequence('thinking-mid', [s1, s2, s3, s4, s5, s6]);
});

test('scenario: an id swapped in place later becomes a task container', () => {
  const child: SdkMessage = { type: 'text', content: 'c', parentToolUseId: 'ag', timestamp: 3 };
  const agent: SdkMessage = { type: 'tool_start', tool: 'Agent', toolUseId: 'ag', timestamp: 1 };
  const a: SdkMessage = { type: 'tool_start', tool: 'Read', toolUseId: 'A', input: {}, timestamp: 2 };
  const b: SdkMessage = { type: 'tool_start', tool: 'Read', toolUseId: 'B', input: {}, timestamp: 2 };
  const s1 = [agent, a, child];
  const s2 = [agent, b, child]; // replaced mid-array, a child after it (not removable)
  const s3 = [...s2, { type: 'task_started', toolUseId: 'B', taskId: 'tb', timestamp: 4 } as SdkMessage];
  const s4 = [...s3, { type: 'text', content: 'late child', parentToolUseId: 'A', timestamp: 5 } as SdkMessage];
  assertSequence('id-swap', [s1, s2, s3, s4]);
});

test('scenario: parallel same-millisecond tools finishing out of order in grid mode', () => {
  const starts: SdkMessage[] = ['p1', 'p2', 'p3'].map((id) => ({ type: 'tool_start', tool: 'Read', toolUseId: id, input: { id }, timestamp: 10 }));
  const res = (id: string, ts: number): SdkMessage => ({ type: 'tool_result', tool: 'Read', toolUseId: id, output: id, timestamp: ts });
  const s1 = [{ type: 'user', content: 'go', timestamp: 9 } as SdkMessage, ...starts];
  const s2 = [...s1, res('p2', 11)];
  const s3 = [...s2, res('p1', 12), { type: 'text', content: 'mid', timestamp: 12 } as SdkMessage];
  const s4 = [...s3, res('p3', 13), { type: 'tool_result', tool: 'Read', toolUseId: 'p3', output: 'img', images: [{ mediaType: 'image/png', base64Data: 'x' }], timestamp: 14 } as SdkMessage];
  assertSequence('parallel', [s1, s2, s3, s4]);
});

test('long session: appends stay identical and unchanged input returns the same array', () => {
  const proc = createSdkMessageProcessor();
  const builder = createRenderItemsBuilder();
  let last: SdkMessage[] = [];
  for (const msgs of simulate(424242, { steps: 3000 })) {
    last = msgs;
    builder.update(proc.update(msgs), true);
  }
  const processed = proc.update(last);
  const items = builder.update(processed, true);
  assert.deepStrictEqual(normalize(items, processed), normalize(buildRenderItems(processSdkMessages(last), true), processed));
  // Same input → same output reference (so Svelte deriveds don't propagate).
  assert.equal(proc.update(last), processed);
  assert.equal(builder.update(processed, true), items);
  // A trailing filtered marker changes nothing visible → same items array.
  const withDone = [...last, { type: 'done' as const, timestamp: 1 }];
  assert.equal(builder.update(proc.update(withDone), true), items);
});

test('mergeTaskChildren matches the old task-block merge and keeps identities', () => {
  // The re-merge SdkTaskBlock used to run inline (copies every result).
  const oldMerge = (msgs: SdkMessage[]): SdkMessage[] => {
    if (!msgs.some((m) => m.type === 'tool_start')) return msgs;
    if (!msgs.some((m) => m.toolUseId)) return msgs;
    const toolResults = new Map<string, SdkMessage>();
    const toolInputs = new Map<string, Record<string, unknown>>();
    for (const m of msgs) if (m.type === 'tool_result' && m.toolUseId) toolResults.set(m.toolUseId, m);
    for (const m of msgs) if (m.type === 'tool_start' && m.toolUseId && m.input) toolInputs.set(m.toolUseId, m.input);
    const out: SdkMessage[] = [];
    const done = new Set<string>();
    for (const m of msgs) {
      if (m.type === 'tool_start') {
        if (m.toolUseId && toolResults.has(m.toolUseId)) {
          out.push({ ...toolResults.get(m.toolUseId)!, input: toolInputs.get(m.toolUseId) });
          done.add(m.toolUseId);
        } else out.push(m);
      } else if (m.type === 'tool_result') {
        if (!m.toolUseId || !done.has(m.toolUseId)) {
          const input = m.toolUseId ? (toolInputs.get(m.toolUseId) ?? m.input) : m.input;
          out.push({ ...m, input });
        }
      } else out.push(m);
    }
    return out;
  };
  for (let seed = 7000; seed < 7060; seed++) {
    let lastMsgs: SdkMessage[] = [];
    for (const msgs of simulate(seed, { steps: 120 })) lastMsgs = msgs;
    for (const item of buildRenderItems(processSdkMessages(lastMsgs), false)) {
      if (item.type !== 'task') continue;
      const merged = mergeTaskChildren(item.children);
      assert.deepStrictEqual(merged, oldMerge(item.children));
      // Stable across calls: nothing is re-copied.
      const again = mergeTaskChildren(item.children);
      merged.forEach((m, i) => assert.ok(m === again[i]));
    }
  }
  // Direct case: a running sibling must not re-copy a completed, merged child.
  const done = mergeToolResult({ type: 'tool_result', tool: 'Read', toolUseId: 'a', output: 'o', timestamp: 2 }, { p: 1 });
  const running: SdkMessage = { type: 'tool_start', tool: 'Bash', toolUseId: 'b', input: { c: 1 }, timestamp: 3 };
  const out = mergeTaskChildren([done, running]);
  assert.ok(out[0] === done && out[1] === running);
});
