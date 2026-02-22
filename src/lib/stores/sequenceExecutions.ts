import { writable, derived, get } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { playNotificationSound } from "$lib/utils/sound";
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

/** Set up event listeners for an execution */
export async function setupListeners(executionId: string): Promise<void> {
  const unlisteners: UnlistenFn[] = [];

  // Node start
  unlisteners.push(
    await listen<SequenceNodeStartEvent>(
      `sequence-node-start-${executionId}`,
      (event) => {
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

  // Notification events (system notifications + sounds)
  unlisteners.push(
    await listen<{
      title: string;
      message: string;
      system_notification?: boolean;
      play_sound?: boolean;
      sound?: number;
    }>(
      `sequence-notification-${executionId}`,
      (event) => {
        const { title, message, system_notification, play_sound, sound } = event.payload;
        if (system_notification) {
          try {
            if ('Notification' in window && Notification.permission === 'granted') {
              new Notification(title, { body: message });
            } else if ('Notification' in window && Notification.permission !== 'denied') {
              Notification.requestPermission().then((perm) => {
                if (perm === 'granted') new Notification(title, { body: message });
              });
            }
          } catch (e) {
            console.warn('Failed to send system notification:', e);
          }
        }
        if (play_sound) {
          playNotificationSound(sound);
        }
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
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** Start a new sequence execution */
export async function startExecution(
  sequenceId: string,
  inputs: Record<string, unknown> = {},
  dryRun: boolean = false,
  entryNodeId?: string
): Promise<string> {
  const executionId = await invoke<string>("start_execution", {
    sequenceId,
    inputs,
    dryRun,
    entryNodeId: entryNodeId ?? null,
  });

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

  // Set up event listeners
  await setupListeners(executionId);

  // Sync state from backend to catch any events that fired before listeners were ready
  try {
    const currentState = await invoke<SequenceExecution>("get_execution", { executionId });
    if (currentState) {
      executions.update((execs) =>
        execs.map((e) => (e.id === executionId ? { ...e, ...currentState } : e))
      );
    }
  } catch {
    // Execution may not be persisted yet if it just started — that's OK
  }

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
    // Merge with existing active executions
    // Only add completed ones that aren't already tracked
    executions.update((execs) => {
      const activeIds = new Set(execs.map((e) => e.id));
      const historicalExecs: SequenceExecution[] = summaries
        .filter((s) => !activeIds.has(s.id))
        .map((s) => ({
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
        }));
      return [...execs, ...historicalExecs];
    });
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
  cleanupListeners(executionId);
  executions.update((execs) => execs.filter((e) => e.id !== executionId));
  activeExecutionId.update((id) => (id === executionId ? null : id));
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
