// Nested subagent transcripts.
//
// The Claude Code CLI streams the conversation of subagents spawned by the MAIN
// agent (messages carry parent_tool_use_id), but it does not stream agents spawned
// by a subagent (spawn depth >= 2). Those only send task_started /
// task_notification. Their full conversation is still written to disk as it runs:
//
//   <config dir>/projects/<project key>/<session id>/subagents/[...]/agent-<agentId>.jsonl
//   <same path>.meta.json  -> { toolUseId, spawnDepth, finished, ... }
//
// (the task_id of a local_agent task is the agentId). This module tails those
// files and turns their records into the same tool_start / tool_result / text /
// thinking events a streamed subagent produces, scoped to the nested Agent
// tool_use id, so the frontend renders them inside the nested task block.

import { promises as fs } from "fs";
import * as path from "path";

type Rec = Record<string, unknown>;

export type NestedEvent =
  | { type: "text"; content: string; parentToolUseId: string }
  | { type: "tool_start"; tool: string; input: unknown; toolUseId: string; parentToolUseId: string }
  | { type: "tool_result"; tool: string; output: string; toolUseId: string; parentToolUseId: string }
  | { type: "thinking_start"; content: string; timestamp: number; parentToolUseId: string }
  | { type: "thinking_end"; durationMs: number; content: string; parentToolUseId: string }
  | { type: "subagent_model"; toolUseId: string; model: string };

/**
 * Turns transcript JSONL lines of one subagent into display events. Stateful
 * (tool names for results, open thinking span, model reported once), pure
 * otherwise — fed by the tailer below and by tests.
 */
export class NestedTranscriptParser {
  private toolNames = new Map<string, string>();
  private seen = new Set<string>();
  private thinking: { start: number; content: string } | null = null;
  private modelSent = false;

  constructor(private readonly agentToolUseId: string) {}

  /** Parses one JSONL line; returns the events it produces (possibly none). */
  line(raw: string): NestedEvent[] {
    // Most lines are attachments / API request blobs; skip them without parsing.
    if (!raw.includes('"type":"assistant"') && !raw.includes('"type":"user"')) return [];
    let rec: Rec;
    try {
      rec = JSON.parse(raw) as Rec;
    } catch {
      return [];
    }
    if (rec.type !== "assistant" && rec.type !== "user") return [];
    const uuid = typeof rec.uuid === "string" ? rec.uuid : undefined;
    if (uuid) {
      if (this.seen.has(uuid)) return [];
      this.seen.add(uuid);
    }
    const message = rec.message as Rec | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return []; // the agent's prompt (plain string)
    const at = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) || Date.now() : Date.now();
    const parent = this.agentToolUseId;
    const out: NestedEvent[] = [];

    if (rec.type === "assistant") {
      const model = typeof message?.model === "string" ? message.model : undefined;
      if (model && !this.modelSent && model !== "<synthetic>") {
        this.modelSent = true;
        out.push({ type: "subagent_model", toolUseId: parent, model });
      }
      for (const block of content as Rec[]) {
        if (block.type === "thinking") {
          const text = typeof block.thinking === "string" ? block.thinking : "";
          if (!this.thinking) {
            this.thinking = { start: at, content: text };
            out.push({ type: "thinking_start", content: text, timestamp: at, parentToolUseId: parent });
          } else if (text) {
            this.thinking.content += (this.thinking.content ? "\n\n" : "") + text;
          }
          continue;
        }
        out.push(...this.endThinking(at));
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          out.push({ type: "text", content: block.text, parentToolUseId: parent });
        } else if (block.type === "tool_use" && typeof block.id === "string") {
          const name = typeof block.name === "string" ? block.name : "unknown";
          this.toolNames.set(block.id, name);
          out.push({ type: "tool_start", tool: name, input: block.input, toolUseId: block.id, parentToolUseId: parent });
        }
      }
      return out;
    }

    for (const block of content as Rec[]) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      out.push(...this.endThinking(at));
      out.push({
        type: "tool_result",
        tool: this.toolNames.get(block.tool_use_id) ?? "unknown",
        output: toolResultText(block.content),
        toolUseId: block.tool_use_id,
        parentToolUseId: parent,
      });
    }
    return out;
  }

  /** Closes a thinking span left open when the agent ends. */
  finish(): NestedEvent[] {
    return this.endThinking(Date.now());
  }

  private endThinking(at: number): NestedEvent[] {
    if (!this.thinking) return [];
    const { start, content } = this.thinking;
    this.thinking = null;
    return [{ type: "thinking_end", durationMs: Math.max(0, at - start), content, parentToolUseId: this.agentToolUseId }];
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Rec[])
    .filter(c => c.type === "text" && typeof c.text === "string")
    .map(c => c.text as string)
    .join("\n");
}

/** Finds `agent-<agentId>.jsonl` under any `projects/<key>/<sessionId>/subagents` tree. */
export async function findSubagentTranscript(
  configDir: string,
  sessionId: string,
  agentId: string
): Promise<string | null> {
  const projects = path.join(configDir, "projects");
  let keys: string[];
  try {
    keys = await fs.readdir(projects);
  } catch {
    return null;
  }
  const fileName = `agent-${agentId}.jsonl`;
  for (const key of keys) {
    const root = path.join(projects, key, sessionId, "subagents");
    const found = await findFile(root, fileName, 4);
    if (found) return found;
  }
  return null;
}

async function findFile(dir: string, fileName: string, depth: number): Promise<string | null> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  if (entries.some(e => e.isFile() && e.name === fileName)) return path.join(dir, fileName);
  if (depth <= 0) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = await findFile(path.join(dir, e.name), fileName, depth - 1);
    if (found) return found;
  }
  return null;
}

const POLL_MS = 1500;
const LOCATE_TIMEOUT_MS = 2 * 60_000;
const MAX_TAIL_MS = 12 * 60 * 60_000;

interface Tail {
  stopped: boolean;
  finishRequested: boolean;
  timer?: ReturnType<typeof setTimeout>;
  wake?: () => void;
}

/**
 * Tails nested (spawn depth >= 2) subagent transcripts for live sessions.
 * Depth-1 agents are skipped once their meta says so — the SDK streams those.
 */
export class NestedSubagentTailer {
  private tails = new Map<string, Tail>(); // key: `${sessionId}\0${agentId}`

  constructor(
    private readonly emit: (sessionId: string, event: NestedEvent) => void,
    private readonly log: (sessionId: string, message: string) => void
  ) {}

  /** Starts tailing a local_agent task. No-op when already tailing it. */
  start(sessionId: string, opts: { configDir: string; sdkSessionId: () => string | undefined; agentId: string; toolUseId: string }): void {
    const key = `${sessionId}\0${opts.agentId}`;
    if (this.tails.has(key)) return;
    const tail: Tail = { stopped: false, finishRequested: false };
    this.tails.set(key, tail);
    void this.run(sessionId, key, tail, opts).catch(err => {
      this.log(sessionId, `[nested subagent] tail ${opts.agentId} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.tails.delete(key);
    });
  }

  /** The task ended: read what's left, then stop. */
  finish(sessionId: string, agentId: string): void {
    const tail = this.tails.get(`${sessionId}\0${agentId}`);
    if (!tail) return;
    tail.finishRequested = true;
    if (tail.timer) {
      clearTimeout(tail.timer);
      tail.timer = undefined;
      tail.wake?.();
    }
  }

  /** Session closed: drop every tail without a final read. */
  stopSession(sessionId: string): void {
    for (const [key, tail] of this.tails) {
      if (!key.startsWith(`${sessionId}\0`)) continue;
      tail.stopped = true;
      if (tail.timer) clearTimeout(tail.timer);
      tail.wake?.();
      this.tails.delete(key);
    }
  }

  private sleep(tail: Tail): Promise<void> {
    if (tail.finishRequested || tail.stopped) return Promise.resolve();
    return new Promise(resolve => {
      tail.wake = () => {
        tail.wake = undefined;
        resolve();
      };
      tail.timer = setTimeout(() => {
        tail.timer = undefined;
        tail.wake?.();
      }, POLL_MS);
    });
  }

  private async run(
    sessionId: string,
    key: string,
    tail: Tail,
    opts: { configDir: string; sdkSessionId: () => string | undefined; agentId: string; toolUseId: string }
  ): Promise<void> {
    const began = Date.now();
    let file: string | null = null;
    // Locate the transcript (written a moment after the task starts).
    while (!tail.stopped) {
      const sid = opts.sdkSessionId();
      if (sid) file = await findSubagentTranscript(opts.configDir, sid, opts.agentId);
      if (file) break;
      if (tail.finishRequested || Date.now() - began > LOCATE_TIMEOUT_MS) {
        this.log(sessionId, `[nested subagent] no transcript found for ${opts.agentId}`);
        this.tails.delete(key);
        return;
      }
      await this.sleep(tail);
    }
    if (!file || tail.stopped) return;

    const meta = await readMeta(file);
    if (meta && typeof meta.spawnDepth === "number" && meta.spawnDepth < 2) {
      // Spawned by the main agent: the SDK already streams its conversation.
      this.tails.delete(key);
      return;
    }
    const agentToolUseId = typeof meta?.toolUseId === "string" ? meta.toolUseId : opts.toolUseId;
    this.log(sessionId, `[nested subagent] tailing ${opts.agentId} (depth ${String(meta?.spawnDepth ?? "?")}) -> ${agentToolUseId}`);

    const parser = new NestedTranscriptParser(agentToolUseId);
    let offset = 0;
    while (!tail.stopped) {
      const last = tail.finishRequested;
      const chunk = await readFrom(file, offset);
      if (tail.stopped) return;
      if (chunk.length > 0) {
        offset += chunk.length;
        for (const l of chunk.toString("utf8").split("\n")) for (const ev of parser.line(l)) this.emit(sessionId, ev);
      }
      if (last || Date.now() - began > MAX_TAIL_MS) break;
      // The CLI marks the meta finished when the agent ends; one more read after that.
      if (chunk.length === 0 && (await readMeta(file))?.finished === true) tail.finishRequested = true;
      await this.sleep(tail);
    }
    if (tail.stopped) return;
    for (const ev of parser.finish()) this.emit(sessionId, ev);
    this.tails.delete(key);
  }
}

async function readMeta(transcript: string): Promise<Rec | null> {
  try {
    return JSON.parse(await fs.readFile(transcript.replace(/\.jsonl$/, ".meta.json"), "utf8")) as Rec;
  } catch {
    return null;
  }
}

async function readFrom(file: string, offset: number): Promise<Buffer> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    if (size <= offset) return Buffer.alloc(0);
    const buf = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
    // Only hand back whole lines (up to the last newline); a line still being
    // written is re-read next time, which also keeps multi-byte chars intact.
    const data = buf.subarray(0, bytesRead);
    const nl = data.lastIndexOf(0x0a);
    return nl < 0 ? Buffer.alloc(0) : data.subarray(0, nl + 1);
  } finally {
    await handle.close();
  }
}
