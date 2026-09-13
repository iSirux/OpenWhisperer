import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexSubagents } from "./codexSubagents";

function fixture() {
  const events: Record<string, unknown>[] = [];
  const items: Record<string, unknown>[] = [];
  const router = new CodexSubagents(event => events.push(event));
  const handle = (method: string, params: Record<string, unknown>) =>
    router.handle({ method, params }, "root", (item, phase) => items.push({ ...item, phase }));
  const spawn = (receiver = "child", sender = "root") => handle("item/completed", {
    threadId: sender, item: { id: `spawn-${receiver}`, type: "collabAgentToolCall", tool: "spawnAgent",
      status: "completed", senderThreadId: sender, receiverThreadIds: [receiver], prompt: "Inspect routing",
      agentsStates: { [receiver]: { status: "running", message: null } } },
  });
  return { events, items, handle, spawn };
}

test("current spawn payload groups output and does not complete the agent at launch", () => {
  const f = fixture();
  f.spawn();
  assert.equal(f.events.filter(e => e.type === "task_started").length, 1);
  assert.equal(f.events.filter(e => e.type === "task_completed").length, 0);
  for (const type of ["agentMessage", "commandExecution", "reasoning"]) {
    f.handle("item/completed", { threadId: "child", item: { id: type, type } });
  }
  assert.ok(f.items.every(item => item.parentToolUseId === "codex-agent:child"));
  assert.equal(f.handle("item/completed", { threadId: "root", item: { type: "agentMessage" } }), false);
  assert.equal(f.handle("thread/tokenUsage/updated", { threadId: "child" }), true);
  assert.equal(f.handle("turn/completed", { threadId: "child", turn: { id: "child-turn", status: "completed" } }), true);
  assert.equal(f.events.filter(e => e.type === "task_completed").length, 1);
});

test("child thread start never replaces root and late spawn completion cannot revive it", () => {
  const f = fixture();
  assert.equal(f.handle("thread/started", { thread: { id: "child", source: {
    subAgent: { thread_spawn: { parent_thread_id: "root" } },
  } } }), true);
  f.handle("turn/completed", { threadId: "child", turn: { status: "completed" } });
  f.spawn();
  assert.equal(f.events.filter(e => e.type === "subagent_start").length, 1);
  assert.equal(f.events.filter(e => e.type === "task_started").length, 1);
  assert.equal(f.handle("thread/started", { thread: { id: "review", source: { subAgent: "review" } } }), true);
  assert.equal(f.handle("thread/started", { thread: { id: "root", source: "appServer" } }), false);
});

test("buffers output before spawn metadata and preserves nested ownership", () => {
  const f = fixture();
  f.handle("item/completed", { threadId: "child", item: { type: "agentMessage", text: "early" } });
  assert.equal(f.items.length, 0);
  f.spawn();
  assert.equal(f.items[0].parentToolUseId, "codex-agent:child");
  f.spawn("nested", "child");
  const nested = f.events.find(e => e.type === "tool_start" && e.toolUseId === "codex-agent:nested");
  assert.equal(nested?.parentToolUseId, "codex-agent:child");
});

test("wait updates settle each receiver once without creating extra agents", () => {
  const f = fixture();
  f.spawn("one");
  f.spawn("two");
  const params = { threadId: "root", item: { id: "wait", type: "collabAgentToolCall", tool: "wait",
    receiverThreadIds: ["one", "two"], agentsStates: {
      one: { status: "completed", message: "Done" }, two: { status: "errored", message: "Failed" },
    } } };
  f.handle("item/completed", params);
  f.handle("item/completed", params);
  assert.equal(f.events.filter(e => e.type === "subagent_start").length, 2);
  assert.deepEqual(f.events.filter(e => e.type === "task_completed").map(e => e.status), ["completed", "failed"]);
});

test("follow-up turns get a fresh task ID so old completion cannot settle new work", () => {
  const f = fixture();
  f.spawn();
  f.handle("turn/completed", { threadId: "child", turn: { status: "completed" } });
  f.handle("turn/started", { threadId: "child", turn: { id: "next" } });
  f.handle("item/completed", { threadId: "child", item: { type: "agentMessage" } });
  assert.equal(f.items[0].parentToolUseId, "codex-agent:child:2");
});
