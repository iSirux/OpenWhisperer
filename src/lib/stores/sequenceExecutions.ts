import { writable, derived, get } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { playNotificationSound } from "$lib/utils/sound";
import { sdkSessions } from "$lib/stores/sdkSessions";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type {
  SequenceExecution,
  ExecutionSummary,
  ExecutionStatus,
  NodeResult,
  NodeStatus,
  LogEntry,
  SequenceNodeStartEvent,
  SequenceNodeCompleteEvent,
  SequenceNodeErrorEvent,
  SequenceNodeSessionEvent,
  SequenceLogEvent,
} from "$lib/types/sequence";

// ─── Store ──────────────────────────────────────────────────────────────────

/** Active/recent executions */
export const executions = writable<SequenceExecution[]>([]);

/** Currently selected execution ID */
export const activeExecutionId = writable<string | null>(null);

/** Derived: active execution */
export const activeExecution = derived(
  [executions, activeExecutionId],
  ([$executions, $activeId]) =>
    $activeId ? $executions.find((e) => e.id === $activeId) ?? null : null
);

/** Derived: running execution count */
export const runningCount = derived(executions, ($execs) =>
  $execs.filter((e) => {
    const status = typeof e.status === "string" ? e.status : e.status.status;
    return status === "running" || status === "initializing";
  }).length
);

// ─── Event Listeners ────────────────────────────────────────────────────────

const listeners: Map<string, UnlistenFn[]> = new Map();
let globalStartedUnlisten: UnlistenFn | null = null;
let globalNotificationUnlisten: UnlistenFn | null = null;

type SequenceExecutionStartedEvent = {
  execution_id: string;
  sequence_id: string;
  sequence_name: string;
  started_at: string;
};

type SequenceNotificationEvent = {
  execution_id: string;
  title: string;
  message: string;
  system_notification?: boolean;
  play_sound?: boolean;
  sound?: number;
};

async function handleExecutionStarted(
  payload: SequenceExecutionStartedEvent
): Promise<void> {
  const executionId = payload.execution_id;
  const exists = get(executions).some((e) => e.id === executionId);

  if (!exists) {
    executions.update((execs) => [
      {
        id: executionId,
        sequence_id: payload.sequence_id,
        sequence_name: payload.sequence_name || payload.sequence_id,
        started_at: payload.started_at || new Date().toISOString(),
        status: { status: "initializing" } as ExecutionStatus,
        node_results: {},
        session_ids: [],
        inputs: {},
        total_tokens: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read: 0,
          cache_creation: 0,
        },
        total_cost: 0,
        log: [],
        completed_node_ids: [],
        total_nodes: 0,
      },
      ...execs,
    ]);
  }

  if (!listeners.has(executionId)) {
    await setupListeners(executionId);
  }

  // Sync from backend in case this execution is very short-lived and events
  // complete before listeners are attached.
  await loadFullExecution(executionId);
  setTimeout(() => {
    void loadFullExecution(executionId);
  }, 250);
}

export async function initSequenceExecutionListeners(): Promise<void> {
  if (globalStartedUnlisten) return;

  globalStartedUnlisten = await listen<SequenceExecutionStartedEvent>(
    "sequence-execution-started",
    (event) => {
      void handleExecutionStarted(event.payload);
    }
  );

  globalNotificationUnlisten = await listen<SequenceNotificationEvent>(
    "sequence-notification",
    (event) => {
      const { title, message, system_notification, play_sound, sound } = event.payload;
      if (system_notification) {
        (async () => {
          try {
            let granted = await isPermissionGranted();
            if (!granted) {
              const perm = await requestPermission();
              granted = perm === "granted";
            }
            if (granted) {
              sendNotification({ title, body: message });
            }
          } catch (e) {
            console.warn("Failed to send system notification:", e);
          }
        })();
      }
      if (play_sound) {
        playNotificationSound(sound);
      }
    }
  );
}

/** Set up event listeners for an execution */
export async function setupListeners(executionId: string): Promise<void> {
  if (listeners.has(executionId)) {
    return;
  }
  console.log(`[sequence] Setting up listeners for ${executionId.slice(0, 8)}`);
  const unlisteners: UnlistenFn[] = [];

  // Prompt-node live session: the moment a prompt node starts its agent run, the
  // backend emits this so we materialize a real, LIVE SDK session (streaming into
  // the session list immediately) rather than waiting for the node to finish.
  unlisteners.push(
    await listen<SequenceNodeSessionEvent>(
      `sequence-node-session-${executionId}`,
      (event) => {
        const p = event.payload;
        const sequenceName = get(executions).find((e) => e.id === executionId)?.sequence_name;
        sdkSessions.attachSequenceNodeSession({
          executionId,
          sessionId: p.session_id,
          nodeId: p.node_id,
          nodeName: p.node_name ?? undefined,
          sequenceName,
          cwd: p.cwd,
          model: p.model,
          provider: p.provider,
          effort: p.effort,
          prompt: p.prompt,
        });
      }
    )
  );

  // Node start
  unlisteners.push(
    await listen<SequenceNodeStartEvent>(
      `sequence-node-start-${executionId}`,
      (event) => {
        console.log(`[sequence][${executionId.slice(0, 8)}] node-start:`, event.payload.node_id);
        executions.update((execs) =>
          execs.map((e) => {
            if (e.id !== executionId) return e;
            return {
              ...e,
              current_node_id: event.payload.node_id,
              node_results: {
                ...e.node_results,
                [event.payload.node_id]: {
                  status: "running" as NodeStatus,
                  started_at: new Date().toISOString(),
                  retry_count: 0,
                },
              },
            };
          })
        );
      }
    )
  );

  // Node complete
  unlisteners.push(
    await listen<SequenceNodeCompleteEvent>(
      `sequence-node-complete-${executionId}`,
      (event) => {
        console.log(`[sequence][${executionId.slice(0, 8)}] node-complete:`, event.payload.node_id);
        executions.update((execs) =>
          execs.map((e) => {
            if (e.id !== executionId) return e;
            const nodeResult = e.node_results[event.payload.node_id] || {
              retry_count: 0,
            };
            return {
              ...e,
              node_results: {
                ...e.node_results,
                [event.payload.node_id]: {
                  ...nodeResult,
                  status: "completed" as NodeStatus,
                  finished_at: new Date().toISOString(),
                  duration_ms: event.payload.duration_ms,
                  cost: event.payload.cost,
                },
              },
              completed_node_ids: [
                ...e.completed_node_ids,
                event.payload.node_id,
              ],
            };
          })
        );
      }
    )
  );

  // Node error
  unlisteners.push(
    await listen<SequenceNodeErrorEvent>(
      `sequence-node-error-${executionId}`,
      (event) => {
        executions.update((execs) =>
          execs.map((e) => {
            if (e.id !== executionId) return e;
            const nodeResult = e.node_results[event.payload.node_id] || {
              retry_count: 0,
            };
            return {
              ...e,
              node_results: {
                ...e.node_results,
                [event.payload.node_id]: {
                  ...nodeResult,
                  status: "failed" as NodeStatus,
                  finished_at: new Date().toISOString(),
                  error: event.payload.error,
                },
              },
            };
          })
        );
      }
    )
  );

  // Node waiting (approval/condition)
  unlisteners.push(
    await listen<{ node_id: string; type: string; message?: string }>(
      `sequence-node-waiting-${executionId}`,
      (event) => {
        executions.update((execs) =>
          execs.map((e) => {
            if (e.id !== executionId) return e;
            const nodeResult = e.node_results[event.payload.node_id] || {
              retry_count: 0,
            };
            return {
              ...e,
              status: {
                status: "waiting_for_approval",
                node_id: event.payload.node_id,
              } as ExecutionStatus,
              node_results: {
                ...e.node_results,
                [event.payload.node_id]: {
                  ...nodeResult,
                  status: "waiting_approval" as NodeStatus,
                },
              },
            };
          })
        );
      }
    )
  );

  // Status change (payload is raw ExecutionStatus, e.g. {"status": "running"})
  unlisteners.push(
    await listen<ExecutionStatus>(
      `sequence-status-${executionId}`,
      (event) => {
        console.log(`[sequence][${executionId.slice(0, 8)}] status event:`, event.payload);
        executions.update((execs) =>
          execs.map((e) => {
            if (e.id !== executionId) return e;
            return {
              ...e,
              status: event.payload,
            };
          })
        );
      }
    )
  );

  // Log entries
  unlisteners.push(
    await listen<SequenceLogEvent>(
      `sequence-log-${executionId}`,
      (event) => {
        executions.update((execs) =>
          execs.map((e) => {
            if (e.id !== executionId) return e;
            return {
              ...e,
              log: [...e.log, event.payload.entry],
            };
          })
        );
      }
    )
  );

  // Execution done
  unlisteners.push(
    await listen<ExecutionStatus>(
      `sequence-done-${executionId}`,
      (event) => {
        console.log(`[sequence][${executionId.slice(0, 8)}] done event:`, event.payload);
        executions.update((execs) =>
          execs.map((e) => {
            if (e.id !== executionId) return e;
            return {
              ...e,
              status: event.payload,
              completed_at: new Date().toISOString(),
            };
          })
        );
        // Clean up listeners after completion
        cleanupListeners(executionId);
      }
    )
  );

  listeners.set(executionId, unlisteners);
}

/** Clean up listeners for an execution */
export function cleanupListeners(executionId: string): void {
  const unlisteners = listeners.get(executionId);
  if (unlisteners) {
    unlisteners.forEach((unlisten) => unlisten());
    listeners.delete(executionId);
  }
}

/** Clean up all listeners */
export function cleanupAllListeners(): void {
  listeners.forEach((unlisteners) => {
    unlisteners.forEach((unlisten) => unlisten());
  });
  listeners.clear();

  if (globalStartedUnlisten) {
    globalStartedUnlisten();
    globalStartedUnlisten = null;
  }
  if (globalNotificationUnlisten) {
    globalNotificationUnlisten();
    globalNotificationUnlisten = null;
  }
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** Start a new sequence execution */
export async function startExecution(
  sequenceId: string,
  inputs: Record<string, unknown> = {},
  dryRun: boolean = false,
  entryNodeId?: string
): Promise<string> {
  // Generate execution ID up-front so we can set up listeners BEFORE the
  // backend starts emitting events (avoids race where fast sequences
  // complete before listeners are registered).
  const executionId = crypto.randomUUID();
  console.log(`[sequence] startExecution id=${executionId.slice(0, 8)} for sequence=${sequenceId}`);

  // Create initial execution state
  executions.update((execs) => [
    {
      id: executionId,
      sequence_id: sequenceId,
      sequence_name: sequenceId, // Will be updated from events
      started_at: new Date().toISOString(),
      status: { status: "initializing" } as ExecutionStatus,
      node_results: {},
      session_ids: [],
      inputs,
      total_tokens: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read: 0,
        cache_creation: 0,
      },
      total_cost: 0,
      log: [],
      completed_node_ids: [],
      total_nodes: 0,
    },
    ...execs,
  ]);

  // Set up event listeners BEFORE starting execution
  await setupListeners(executionId);

  // NOW start execution on the backend with our pre-generated ID
  await invoke<string>("start_execution", {
    executionId,
    sequenceId,
    inputs,
    dryRun,
    entryNodeId: entryNodeId ?? null,
  });

  // Select this execution
  activeExecutionId.set(executionId);

  return executionId;
}

/** Pause a running execution */
export async function pauseExecution(executionId: string): Promise<void> {
  await invoke("pause_execution", { executionId });
}

/** Resume a paused execution */
export async function resumeExecution(executionId: string): Promise<void> {
  await invoke("resume_execution", { executionId });
}

/** Cancel a running execution */
export async function cancelExecution(executionId: string): Promise<void> {
  await invoke("cancel_execution", { executionId });
}

/** Approve a node waiting for approval */
export async function approveNode(
  executionId: string,
  nodeId: string
): Promise<void> {
  await invoke("approve_node", { executionId, nodeId });
}

/** Reject a node waiting for approval */
export async function rejectNode(
  executionId: string,
  nodeId: string,
  reason?: string
): Promise<void> {
  await invoke("reject_node", { executionId, nodeId, reason });
}

/** Retry a failed node */
export async function retryNode(
  executionId: string,
  nodeId: string
): Promise<void> {
  await invoke("retry_node", { executionId, nodeId });
}

/** Load execution history */
export async function loadExecutionHistory(): Promise<void> {
  try {
    const summaries = await invoke<ExecutionSummary[]>("list_executions");
    const fullExecutions = await Promise.all(
      summaries.map(async (s) => {
        try {
          return await invoke<SequenceExecution>("get_execution", {
            executionId: s.id,
          });
        } catch {
          // Fallback to summary shape if full execution cannot be loaded.
          return {
            id: s.id,
            sequence_id: s.sequence_id,
            sequence_name: s.sequence_name,
            started_at: s.started_at,
            completed_at: s.completed_at,
            status: s.status,
            node_results: {},
            session_ids: [],
            inputs: {},
            total_tokens: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read: 0,
              cache_creation: 0,
            },
            total_cost: s.total_cost,
            log: [],
            error: s.error,
            completed_node_ids: [],
            total_nodes: s.total_nodes,
          } as SequenceExecution;
        }
      })
    );

    executions.update((execs) => {
      const activeIds = new Set(execs.map((e) => e.id));
      const historicalExecs = fullExecutions.filter((s) => !activeIds.has(s.id));
      return [...execs, ...historicalExecs];
    });

    for (const exec of fullExecutions) {
      const status = getStatusString(exec.status);
      if (!isTerminal(exec.status) && !listeners.has(exec.id)) {
        await setupListeners(exec.id);
      }
      // If a persisted execution is still running, refresh once to sync any
      // near-real-time progress that occurred during startup.
      if (status === "running" || status === "initializing") {
        void loadFullExecution(exec.id);
      }
    }
  } catch (error) {
    console.error("Failed to load execution history:", error);
  }
}

/** Get a full execution from backend */
export async function loadFullExecution(
  executionId: string
): Promise<SequenceExecution | null> {
  try {
    const exec = await invoke<SequenceExecution>("get_execution", {
      executionId,
    });
    // Update in store
    executions.update((execs) => {
      const idx = execs.findIndex((e) => e.id === executionId);
      if (idx >= 0) {
        execs[idx] = exec;
        return [...execs];
      }
      return [exec, ...execs];
    });
    return exec;
  } catch (error) {
    console.error("Failed to load execution:", error);
    return null;
  }
}

/** Close/remove an execution from the list and delete from disk */
export function closeExecution(executionId: string): void {
  // Capture execution data for archiving before removing from store
  const currentExecs = get(executions);
  const executionToArchive = currentExecs.find((e) => e.id === executionId);

  cleanupListeners(executionId);
  executions.update((execs) => execs.filter((e) => e.id !== executionId));
  activeExecutionId.update((id) => (id === executionId ? null : id));

  // Archive the execution before deleting from disk
  if (executionToArchive) {
    const statusStr = getStatusString(executionToArchive.status);
    const startedAtMs = executionToArchive.started_at
      ? new Date(executionToArchive.started_at).getTime()
      : Date.now();
    const completedAtMs = executionToArchive.completed_at
      ? new Date(executionToArchive.completed_at).getTime()
      : 0;

    const entry = {
      id: executionToArchive.id,
      sessionType: "sequence" as const,
      name: executionToArchive.sequence_name || undefined,
      status: statusStr,
      createdAt: startedAtMs,
      archivedAt: Date.now(),
      durationMs: completedAtMs > 0 ? completedAtMs - startedAtMs : 0,
      totalCost: executionToArchive.total_cost || undefined,
      messageCount: executionToArchive.completed_node_ids?.length ?? 0,
    };

    invoke("archive_sequence_execution", {
      executionData: executionToArchive,
      entry,
    })
      .then(async () => {
        const { settings } = await import("./settings");
        const currentSettings = get(settings);
        await invoke("trim_archive", {
          maxEntries:
            currentSettings.session_persistence?.max_archived_sessions ?? 500,
        });
        // Refresh archive count for sidebar
        const { archive } = await import("./archive");
        await archive.refresh();
      })
      .catch((err: unknown) =>
        console.error("[sequenceExecutions] Failed to archive execution:", err)
      );
  }

  // Delete from disk so it doesn't reappear on reload
  invoke("dismiss_execution", { executionId }).catch((err) =>
    console.error("Failed to dismiss execution:", err)
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Get execution status as a simple string */
export function getStatusString(status: ExecutionStatus): string {
  if (typeof status === "string") return status;
  return status.status;
}

/** Check if an execution is in a terminal state */
export function isTerminal(status: ExecutionStatus): boolean {
  const s = getStatusString(status);
  return s === "completed" || s === "failed" || s === "cancelled";
}

/** Get progress as a percentage */
export function getProgress(exec: SequenceExecution): number {
  if (exec.total_nodes === 0) return 0;
  return Math.round((exec.completed_node_ids.length / exec.total_nodes) * 100);
}
