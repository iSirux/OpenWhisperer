import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { NestedTranscriptParser, NestedSubagentTailer, findSubagentTranscript, type NestedEvent } from "./nestedSubagents";

const line = (o: object) => JSON.stringify(o);
const assistant = (uuid: string, content: object[], t = "2026-11-16T12:00:00.000Z") =>
  line({ type: "assistant", uuid, timestamp: t, message: { id: "m", model: "claude-opus-5-5", content } });
const user = (uuid: string, content: unknown, t = "2026-11-16T12:00:01.000Z") =>
  line({ type: "user", uuid, timestamp: t, message: { role: "user", content } });

test("parser maps assistant/user records to scoped events", () => {
  const p = new NestedTranscriptParser("toolu_nested");
  assert.deepEqual(p.line(user("u0", "the prompt")), []);
  assert.deepEqual(p.line(line({ type: "attachment", uuid: "a1" })), []);
  const thinking = p.line(assistant("a2", [{ type: "thinking", thinking: "hmm" }]));
  assert.deepEqual(thinking.map(e => e.type), ["subagent_model", "thinking_start"]);
  const tool = p.line(assistant("a3", [{ type: "tool_use", id: "t1", name: "WebFetch", input: { url: "x" } }], "2026-11-16T12:00:02.000Z"));
  assert.deepEqual(tool, [
    { type: "thinking_end", durationMs: 2000, content: "hmm", parentToolUseId: "toolu_nested" },
    { type: "tool_start", tool: "WebFetch", input: { url: "x" }, toolUseId: "t1", parentToolUseId: "toolu_nested" },
  ]);
  assert.deepEqual(p.line(user("u4", [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }])), [
    { type: "tool_result", tool: "WebFetch", output: "ok", toolUseId: "t1", parentToolUseId: "toolu_nested" },
  ]);
  // Same record again (uuid dedupe) yields nothing.
  assert.deepEqual(p.line(user("u4", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }])), []);
  assert.deepEqual(p.line(assistant("a5", [{ type: "text", text: "done" }])), [
    { type: "text", content: "done", parentToolUseId: "toolu_nested" },
  ]);
});

function sessionDir() {
  const config = mkdtempSync(path.join(tmpdir(), "ow-nested-"));
  const dir = path.join(config, "projects", "F--Repo", "sess-1", "subagents");
  mkdirSync(dir, { recursive: true });
  return { config, dir };
}

test("findSubagentTranscript locates the file under any project key", async () => {
  const { config, dir } = sessionDir();
  writeFileSync(path.join(dir, "agent-abc.jsonl"), "");
  assert.equal(await findSubagentTranscript(config, "sess-1", "abc"), path.join(dir, "agent-abc.jsonl"));
  assert.equal(await findSubagentTranscript(config, "sess-1", "nope"), null);
});

test("tailer streams a depth-2 agent and skips a depth-1 agent", async () => {
  const { config, dir } = sessionDir();
  const events: NestedEvent[] = [];
  const tailer = new NestedSubagentTailer((_, e) => events.push(e), () => {});

  writeFileSync(path.join(dir, "agent-d1.meta.json"), line({ toolUseId: "toolu_d1", spawnDepth: 1 }));
  writeFileSync(path.join(dir, "agent-d1.jsonl"), assistant("x", [{ type: "text", text: "streamed by sdk" }]) + "\n");

  writeFileSync(path.join(dir, "agent-d2.meta.json"), line({ toolUseId: "toolu_d2", spawnDepth: 2 }));
  writeFileSync(path.join(dir, "agent-d2.jsonl"), assistant("y1", [{ type: "tool_use", id: "t9", name: "Grep", input: {} }]) + "\n");

  const opts = (agentId: string, toolUseId: string) => ({ configDir: config, sdkSessionId: () => "sess-1", agentId, toolUseId });
  tailer.start("s", opts("d1", "toolu_d1"));
  tailer.start("s", opts("d2", "toolu_d2"));
  await new Promise(r => setTimeout(r, 300));
  appendFileSync(path.join(dir, "agent-d2.jsonl"), user("y2", [{ type: "tool_result", tool_use_id: "t9", content: "hit" }]) + "\n");
  tailer.finish("s", "d2");
  await new Promise(r => setTimeout(r, 300));

  assert.ok(events.every(e => !("parentToolUseId" in e) || e.parentToolUseId === "toolu_d2"));
  assert.deepEqual(events.map(e => e.type), ["subagent_model", "tool_start", "tool_result"]);
});
