// Live model discovery for both providers, so the app's model catalog follows
// whatever the bundled SDKs / CLIs actually offer instead of a hardcoded list.
//
// - Claude: `query().supportedModels()` on a throwaway query whose prompt stream
//   never yields — the CLI answers the initialize handshake (~1 s) without a
//   model turn, so no tokens are spent.
// - Codex: a short-lived `codex app-server` → `initialize` → `model/list`.

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as readline from "readline";
import { query } from "@anthropic-ai/claude-agent-sdk";

/** Normalized model entry sent to the app (frontend owns what it does with it). */
export interface ListedModel {
  id: string;
  /** Provider display name ("Opus 5.5", "GPT-6-Sol"). */
  displayName: string;
  description: string;
  /** Supported effort levels, provider order (may include levels the UI ignores). */
  efforts: string[];
  defaultEffort?: string;
  isDefault?: boolean;
  /** The provider flags this model as superseded (Codex `upgrade`). */
  legacy?: boolean;
  /** Short aliases that resolve to this model ("opus", "sonnet"). */
  aliases?: string[];
  contextTokens?: number;
}

const LIST_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), LIST_TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

const ONE_M_SUFFIX = /\[1m\]$/i;

export async function listClaudeModels(env: NodeJS.ProcessEnv): Promise<ListedModel[]> {
  // A prompt stream that never yields: the query initializes and idles.
  const idle: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
  };
  const q = query({ prompt: idle, options: { settingSources: [], env } });
  try {
    const infos = await withTimeout(q.supportedModels(), "Claude supportedModels()");
    const byId = new Map<string, ListedModel>();
    let defaultId: string | undefined;
    for (const info of infos) {
      const raw = info.resolvedModel ?? info.value;
      const id = raw.replace(ONE_M_SUFFIX, "");
      // Only concrete model ids; "default" without a resolution is meaningless here.
      if (!id.startsWith("claude-")) continue;
      if (info.value === "default") {
        defaultId = id;
        continue; // "Default (recommended)" is a pointer, not a model
      }
      const alias = info.value.replace(ONE_M_SUFFIX, "");
      const existing = byId.get(id);
      if (existing) {
        if (alias !== id && !existing.aliases?.includes(alias)) {
          existing.aliases = [...(existing.aliases ?? []), alias];
        }
        continue;
      }
      byId.set(id, {
        id,
        displayName: info.displayName,
        description: info.description,
        efforts: info.supportsEffort === false ? [] : [...(info.supportedEffortLevels ?? [])],
        aliases: alias !== id ? [alias] : undefined,
        contextTokens: ONE_M_SUFFIX.test(raw) || ONE_M_SUFFIX.test(info.value) ? 1_000_000 : undefined,
      });
    }
    if (defaultId && byId.has(defaultId)) byId.get(defaultId)!.isDefault = true;
    return [...byId.values()];
  } finally {
    q.close();
  }
}

interface CodexModelRaw {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  upgrade?: string | null;
  defaultReasoningEffort?: string | number | null;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string | number }>;
}

/**
 * List Codex models via a throwaway app-server. `command` / `args` are the
 * already-resolved spawn target (the caller knows the bundled binary layout);
 * `kill` must take the whole process tree down (Windows cmd.exe shims).
 */
export async function listCodexModels(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  kill: (child: ChildProcessWithoutNullStreams) => Promise<void>
): Promise<ListedModel[]> {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const rl = readline.createInterface({ input: child.stdout, terminal: false });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let stderr = "";

  const fail = (err: Error) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  child.on("error", (err) => fail(err));
  child.on("close", (code) => fail(new Error(`codex app-server exited (${code ?? "unknown"})${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`)));
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  rl.on("line", (line) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    if (typeof msg.method === "string") {
      // Server-initiated request we don't handle.
      child.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "not handled" } }) + "\n");
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    const error = msg.error as { code?: number; message?: string } | undefined;
    if (error) p.reject(new Error(`JSON-RPC ${error.code}: ${error.message}`));
    else p.resolve(msg.result);
  });

  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ method, id, params }) + "\n");
    });

  try {
    return await withTimeout(
      (async () => {
        await request("initialize", {
          clientInfo: { name: "open_whisperer", title: "OpenWhisperer", version: "1.0.0" },
        });
        child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
        const out: ListedModel[] = [];
        let cursor: string | null = null;
        do {
          const res = (await request("model/list", cursor ? { cursor } : {})) as {
            data?: CodexModelRaw[];
            nextCursor?: string | null;
          };
          for (const m of res?.data ?? []) {
            const id = m.model ?? m.id;
            if (!id || m.hidden) continue;
            out.push({
              id,
              displayName: m.displayName ?? id,
              description: m.description ?? "",
              efforts: (m.supportedReasoningEfforts ?? [])
                .map((e) => e.reasoningEffort)
                .filter((e): e is string => typeof e === "string"),
              defaultEffort:
                typeof m.defaultReasoningEffort === "string" ? m.defaultReasoningEffort : undefined,
              isDefault: m.isDefault || undefined,
              legacy: m.upgrade ? true : undefined,
            });
          }
          cursor = res?.nextCursor ?? null;
        } while (cursor);
        return out;
      })(),
      "Codex model/list"
    );
  } finally {
    rl.close();
    await kill(child);
  }
}
