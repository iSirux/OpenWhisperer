type RecordValue = Record<string, unknown>;
type Notification = { method: string; params?: RecordValue };
type Agent = { toolUseId: string; parentToolUseId?: string; description: string; live: boolean; run: number };
const normalized = (value: unknown) => String(value ?? "").replace(/[_/.]/g, "").toLowerCase();

/** App-server multiplexes threads on one connection; only root events may mutate the session. */
export class CodexSubagents {
  private agents = new Map<string, Agent>();
  private pending = new Map<string, Notification[]>();

  constructor(private emit: (event: RecordValue) => void) {}

  private start(threadId: string, parentThreadId: string, rootId: string | undefined, description: string, restart = false): Agent {
    let agent = this.agents.get(threadId);
    const created = !agent;
    if (!agent) {
      agent = {
        toolUseId: `codex-agent:${threadId}`,
        parentToolUseId: parentThreadId && parentThreadId !== rootId
          ? this.agents.get(parentThreadId)?.toolUseId ?? `codex-agent:${parentThreadId}` : undefined,
        description: description || "Codex subagent",
        live: false,
        run: 1,
      };
      this.agents.set(threadId, agent);
    }
    if (created || (restart && !agent.live)) {
      if (!created) agent.toolUseId = `codex-agent:${threadId}:${++agent.run}`;
      agent.live = true;
      this.emit({ type: "tool_start", tool: "Agent", toolUseId: agent.toolUseId,
        parentToolUseId: agent.parentToolUseId, input: { description: agent.description, prompt: description } });
      this.emit({ type: "subagent_start", agentId: threadId, agentType: "codex" });
      this.emit({ type: "task_started", taskId: agent.toolUseId, toolUseId: agent.toolUseId,
        description: agent.description, taskType: "codex" });
    }
    if (description) agent.description = description;
    return agent;
  }

  private finish(threadId: string, status: string, summary = ""): void {
    const agent = this.agents.get(threadId);
    if (!agent?.live) return;
    agent.live = false;
    this.emit({ type: "task_completed", taskId: agent.toolUseId, toolUseId: agent.toolUseId,
      status: ["failed", "errored", "notFound"].includes(status) ? "failed" : "completed",
      summary, taskType: "codex" });
    this.emit({ type: "subagent_stop", agentId: threadId, transcriptPath: "" });
  }

  /** Returns true when handled, including child lifecycle/usage events that must not reach root. */
  handle(notification: Notification, rootId: string | undefined,
    itemEvent: (item: RecordValue, phase: "started" | "updated" | "completed") => void): boolean {
    const params = notification.params ?? {};
    const method = normalized(notification.method);
    const thread = params.thread as RecordValue | undefined;
    const threadId = String(params.threadId ?? params.thread_id ?? thread?.id ?? "");
    if (method === "threadstarted") {
      const source = thread?.source as RecordValue | undefined;
      const subAgent = source?.subAgent as RecordValue | undefined;
      const spawn = subAgent?.thread_spawn as RecordValue | undefined;
      if (spawn && threadId) {
        this.start(threadId, String(spawn.parent_thread_id ?? ""), rootId,
          String(thread?.agentNickname ?? thread?.agentRole ?? "Codex subagent"));
        this.flush(threadId, rootId, itemEvent);
        return true;
      }
      // Review/compaction child threads must not replace the persisted root ID either.
      return !!subAgent || (!!rootId && threadId !== rootId);
    }

    const child = !!threadId && !!rootId && threadId !== rootId;
    const agent = this.agents.get(threadId);
    if (child && !agent) {
      // Child output can precede the spawn completion that supplies its thread ID.
      if (/^(item(started|updated|completed)|turn(started|completed))$/.test(method)) {
        const queue = this.pending.get(threadId) ?? [];
        if (queue.length < 1000) queue.push(notification);
        this.pending.set(threadId, queue);
      }
      return true;
    }

    const item = params.item as RecordValue | undefined;
    if (item && /^item(started|updated|completed)$/.test(method)) {
      const phase = method.slice(4) as "started" | "updated" | "completed";
      const type = normalized(item.type);
      if (type === "collabagenttoolcall" || type === "collabtoolcall") {
        const tool = normalized(item.tool);
        const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds :
          [item.receiverThreadId ?? item.receiver_thread_id ?? item.newThreadId ?? item.new_thread_id].filter(Boolean);
        for (const receiver of receivers) {
          if (typeof receiver !== "string" || receiver === rootId) continue;
          if (tool === "spawnagent" || tool === "resumeagent" || tool === "followuptask") {
            const target = this.start(receiver, String(item.senderThreadId ?? threadId), rootId, String(item.prompt ?? ""));
            if (typeof item.model === "string") this.emit({ type: "subagent_model", toolUseId: target.toolUseId, model: item.model });
            this.flush(receiver, rootId, itemEvent);
          }
        }
        const states = (item.agentsStates ?? {}) as Record<string, RecordValue>;
        for (const [receiver, state] of Object.entries(states)) {
          if (["completed", "errored", "shutdown", "notFound", "interrupted"].includes(String(state.status))) {
            this.finish(receiver, String(state.status), String(state.message ?? ""));
          }
        }
        // Completion of spawn/wait is a tool completion, not the child's completion.
        if (tool !== "spawnagent" || (phase === "completed" && receivers.length === 0)) {
          itemEvent({ ...item, type: "codexCollaboration", parentToolUseId: agent?.toolUseId }, phase);
        }
        return true;
      }
      if (agent) {
        itemEvent({ ...item, parentToolUseId: agent.toolUseId }, phase);
        return true;
      }
    }
    if (agent && method === "turncompleted") {
      const turn = params.turn as RecordValue | undefined;
      this.finish(threadId, String(turn?.status ?? "completed"), String((turn?.error as RecordValue)?.message ?? ""));
    }
    if (agent && method === "turnstarted" && !agent.live) {
      this.start(threadId, "", rootId, agent.description, true);
    }
    return child;
  }

  private flush(threadId: string, rootId: string | undefined,
    itemEvent: (item: RecordValue, phase: "started" | "updated" | "completed") => void): void {
    const queued = this.pending.get(threadId) ?? [];
    this.pending.delete(threadId);
    for (const notification of queued) this.handle(notification, rootId, itemEvent);
  }
}
