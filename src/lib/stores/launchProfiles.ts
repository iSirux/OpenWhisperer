import { writable, derived, get } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { LaunchCommand, LaunchProfile, LaunchRuntime, QueuedLaunch } from "$lib/types/launch";
import { repos, findRepoById } from "./repos";
import {
  sdkSessions,
  hasBusySessionsInScope,
  normalizeScopePath,
  type SdkSession,
} from "./sdkSessions";

// ---- Store State ----

interface LaunchState {
  /** Currently running launches, keyed by repo ID */
  runtimes: Record<string, LaunchRuntime>;
  /** Queued launch waiting for an agent to finish */
  queued: QueuedLaunch | null;
  taskQueues: Record<string, QueuedLaunch[]>;
  errors: Record<string, string | undefined>;
}

const defaultState: LaunchState = {
  runtimes: {},
  queued: null,
  taskQueues: {},
  errors: {},
};

// ---- Store Implementation ----

// Cleanup functions for queued launch event listeners
let queueCleanup: (() => void) | null = null;
const refreshing = new Set<string>();
const launching = new Set<string>();
const launchFinished = new Map<string, Promise<void>>();

function createLaunchStore() {
  const { subscribe, set, update } = writable<LaunchState>(defaultState);

  return {
    subscribe,

    /** Launch a specific profile by its ID */
    async launchProfile(repoId: string, profileId: string, launchedFromCwd?: string, force = false): Promise<void> {
      const state = get({ subscribe });
      const current = state.runtimes[repoId];
      const repo = findRepoById(get(repos).list, repoId);
      const profile = repo?.launch_profiles?.find(p => p.id === profileId);
      if (!profile) throw new Error('Launch profile no longer exists');
      if (!force && current?.executionType === 'task' && current.taskStatus !== 'succeeded') {
        const queue = state.taskQueues[repoId] ?? [];
        const last = queue.at(-1);
        if (last && repo?.launch_profiles?.find(p => p.id === last.profileId)?.execution_type !== 'task') {
          update(s => ({ ...s, errors: { ...s.errors, [repoId]: 'A service must be the final queue item. Remove it to add more tasks.' } }));
          return;
        }
        update(s => ({ ...s, errors: { ...s.errors, [repoId]: undefined }, taskQueues: { ...s.taskQueues,
          [repoId]: [...queue, { repoId, profileId, profileName: profile.name, launchedFromCwd: current.launchedFromCwd }],
        } }));
        return;
      }
      if (launching.has(repoId)) return;
      launching.add(repoId);
      let finish!: () => void;
      launchFinished.set(repoId, new Promise<void>(resolve => { finish = resolve; }));
      try {
        // Publish the task immediately so another click can queue while its terminal opens.
        update((s) => ({
          ...s,
          errors: { ...s.errors, [repoId]: undefined },
          runtimes: {
            ...s.runtimes,
            [repoId]: {
              repoId,
              profileId,
              profileName: profile?.name,
              runningCommandIds: profile?.command_ids ?? [],
              startedAt: Date.now(),
              executionType: profile?.execution_type ?? 'service',
              taskStatus: profile?.execution_type === 'task' ? 'running' : undefined,
              launchedFromCwd,
            },
          },
        }));
        await invoke("launch_profile", { repoId, profileId, cwd: launchedFromCwd });
      } catch (error) {
        update(s => {
          const runtimes = { ...s.runtimes };
          if (current?.executionType === 'task') runtimes[repoId] = { ...current, taskStatus: 'failed' };
          else if (profile.execution_type === 'task') runtimes[repoId] = { ...runtimes[repoId], taskStatus: 'failed' };
          else delete runtimes[repoId];
          return { ...s, runtimes, errors: { ...s.errors, [repoId]: String(error) } };
        });
        console.error("[launch] Failed to launch profile:", error);
        throw error;
      } finally {
        launching.delete(repoId);
        launchFinished.delete(repoId);
        finish();
      }
    },

    removeTaskQueueItem(repoId: string, index: number): void {
      update(s => ({ ...s, taskQueues: { ...s.taskQueues, [repoId]: (s.taskQueues[repoId] ?? []).filter((_, i) => i !== index) }, errors: { ...s.errors, [repoId]: undefined } }));
    },

    async retryTask(repoId: string): Promise<void> {
      const runtime = get({ subscribe }).runtimes[repoId];
      if (runtime?.profileId) await this.launchProfile(repoId, runtime.profileId, runtime.launchedFromCwd, true);
    },

    /** Launch specific commands directly */
    async launchCommands(repoId: string, repoPath: string, commands: LaunchCommand[], launchedFromCwd?: string): Promise<void> {
      if (get({ subscribe }).runtimes[repoId]?.executionType === 'task') {
        update(s => ({ ...s, errors: { ...s.errors, [repoId]: 'Create a profile to queue these commands, or stop the current task first.' } }));
        return;
      }
      try {
        await invoke("launch_commands", { repoId, repoPath, commands });

        update((s) => ({
          ...s,
          runtimes: {
            ...s.runtimes,
            [repoId]: {
              repoId,
              runningCommandIds: commands.map((c) => c.id),
              startedAt: Date.now(),
              launchedFromCwd,
            },
          },
        }));
      } catch (error) {
        console.error("[launch] Failed to launch commands:", error);
        throw error;
      }
    },

    /** Stop all running processes for a repo */
    async stopAll(repoId: string): Promise<void> {
      await launchFinished.get(repoId);
      if (launching.has(repoId)) return;
      launching.add(repoId);
      try {
        await invoke("stop_launch_profile", { repoId });
        update((s) => {
          const { [repoId]: _, ...rest } = s.runtimes;
          return { ...s, runtimes: rest, taskQueues: { ...s.taskQueues, [repoId]: [] }, errors: { ...s.errors, [repoId]: undefined } };
        });
      } catch (error) {
        console.error("[launch] Failed to stop profile:", error);
        throw error;
      } finally {
        launching.delete(repoId);
      }
    },

    /** Refresh runtime status from backend */
    async refreshStatus(repoId: string): Promise<void> {
      if (refreshing.has(repoId) || launching.has(repoId)) return;
      const runtime = get({ subscribe }).runtimes[repoId];
      if (!runtime) return;
      if (runtime.executionType === 'task' && runtime.taskStatus !== 'running') return;
      refreshing.add(repoId);
      try {
        if (runtime.executionType === 'task') {
          const result = await invoke<{ status: 'running' | 'succeeded' | 'failed' }>('get_launch_task_status', { repoId });
          if (get({ subscribe }).runtimes[repoId] !== runtime || launching.has(repoId)) return;
          if (result.status === 'running') return;
          update(s => ({ ...s, runtimes: { ...s.runtimes, [repoId]: { ...runtime, taskStatus: result.status } } }));
          if (result.status === 'failed') return;
          const next = get({ subscribe }).taskQueues[repoId]?.[0];
          if (next) {
            await this.launchProfile(repoId, next.profileId, next.launchedFromCwd, true);
            update(s => ({ ...s, taskQueues: { ...s.taskQueues, [repoId]: (s.taskQueues[repoId] ?? []).filter(item => item !== next) } }));
          } else {
            update(s => {
              const { [repoId]: _, ...rest } = s.runtimes;
              return { ...s, runtimes: rest };
            });
          }
          return;
        }
        const runningIds = await invoke<string[]>("get_launch_status", { repoId });
        if (get({ subscribe }).runtimes[repoId] !== runtime || launching.has(repoId)) return;
        update((s) => {
          if (runningIds.length === 0) {
            const { [repoId]: _, ...rest } = s.runtimes;
            return { ...s, runtimes: rest };
          }
          const existing = s.runtimes[repoId];
          return {
            ...s,
            runtimes: {
              ...s.runtimes,
              [repoId]: {
                ...existing,
                repoId,
                runningCommandIds: runningIds,
                startedAt: existing?.startedAt ?? Date.now(),
              },
            },
          };
        });
      } catch (error) {
        console.error("[launch] Failed to refresh status:", error);
        update(s => ({ ...s, errors: { ...s.errors, [repoId]: String(error) }, runtimes: {
          ...s.runtimes, ...(s.runtimes[repoId]?.taskStatus === 'succeeded' ? { [repoId]: { ...s.runtimes[repoId], taskStatus: 'failed' as const } } : {}),
        } }));
      } finally {
        refreshing.delete(repoId);
      }
    },

    /** Queue a profile launch to auto-trigger when a session finishes */
    async queueAfterAgent(repoId: string, profileId: string, profileName: string, sessionId: string, launchedFromCwd?: string): Promise<void> {
      // Clean up any existing queue
      this.cancelQueue();

      // A raw sdk-done can be a "semi-stop": the SDK emits it while background subagents /
      // blocking tasks are still running, and the main agent usually resumes right after
      // they settle. Only launch once the session has actually settled; poll while busy
      // (covers the grace-timer finalize, which produces no further sdk-done).
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let cancelled = false;
      const launchWhenSettled = () => {
        if (cancelled) return;
        const session = get(sdkSessions).find((s) => s.id === sessionId);
        const busy =
          !!session &&
          (session.status === "querying" ||
            !!session.completionDeferred ||
            (session.liveSubagentIds ?? []).length > 0 ||
            (session.liveBackgroundTasks ?? []).some((t) => t.kind !== "server"));
        if (busy) {
          pollTimer = setTimeout(launchWhenSettled, 5000);
          return;
        }
        console.log("[launch] Agent done, launching queued profile");
        void this.launchProfile(repoId, profileId, launchedFromCwd);
        this.cancelQueue();
      };

      const unlistenDone = await listen(`sdk-done-${sessionId}`, () => {
        launchWhenSettled();
      });

      const unlistenError = await listen(`sdk-error-${sessionId}`, () => {
        console.warn("[launch] Agent errored, cancelling queued launch");
        this.cancelQueue();
      });

      queueCleanup = () => {
        cancelled = true;
        if (pollTimer !== undefined) clearTimeout(pollTimer);
        unlistenDone();
        unlistenError();
      };

      update((s) => ({
        ...s,
        queued: { repoId, profileId, profileName, mode: "after_agent", sessionId, launchedFromCwd },
      }));
    },

    /**
     * Ctrl+click on a profile: queue a launch to auto-trigger once EVERY session in the
     * repo+worktree scope (`scopeCwd`) has finished — not just the current one. Launches
     * immediately when the scope is already idle.
     */
    async queueUntilRepoIdle(repoId: string, profileId: string, profileName: string, scopeCwd: string): Promise<void> {
      // Clean up any existing queue
      this.cancelQueue();

      if (!hasBusySessionsInScope(get(sdkSessions), scopeCwd)) {
        await this.launchProfile(repoId, profileId, scopeCwd);
        return;
      }

      let fired = false;
      const unsubscribe = sdkSessions.subscribe((sessions) => {
        // The first (synchronous) call sees the busy scope we just checked; later
        // calls fire the launch exactly once when the scope goes idle.
        if (fired || hasBusySessionsInScope(sessions, scopeCwd)) return;
        fired = true;
        console.log("[launch] Repo scope idle, launching queued profile");
        this.cancelQueue();
        void this.launchProfile(repoId, profileId, scopeCwd);
      });

      queueCleanup = unsubscribe;

      update((s) => ({
        ...s,
        queued: { repoId, profileId, profileName, mode: "repo_idle", launchedFromCwd: scopeCwd },
      }));
    },

    /** Cancel queued launch */
    cancelQueue(): void {
      if (queueCleanup) {
        queueCleanup();
        queueCleanup = null;
      }
      update((s) => ({ ...s, queued: null }));
    },

    /** Check if any processes are running for a repo */
    isRunning(repoId: string): boolean {
      const state = get({ subscribe });
      return !!state.runtimes[repoId];
    },
  };
}

export const launchStore = createLaunchStore();

// Task queues continue while the user views a different session or repository.
if (typeof window !== 'undefined') {
  const timer = setInterval(() => {
    for (const [repoId, runtime] of Object.entries(get(launchStore).runtimes)) {
      if (runtime.executionType === 'task' && runtime.taskStatus === 'running') void launchStore.refreshStatus(repoId);
    }
  }, 1000);
  if (import.meta.hot) import.meta.hot.dispose(() => clearInterval(timer));
}

// ---- Derived Stores ----

/**
 * Does the given session have a launch profile currently running or queued against
 * its scope? Used to warn before closing/archiving a session that owns launch work.
 * A launch is tied to a session when it was started/queued from that session's cwd,
 * or (queued after_agent) is explicitly waiting on that session id.
 */
export function sessionLaunchActivity(
  sessionId: string,
  sessionCwd: string | undefined,
): { running: boolean; queued: boolean } {
  const state = get(launchStore);
  const scope = sessionCwd ? normalizeScopePath(sessionCwd) : undefined;

  const q = state.queued;
  const queued =
    !!q &&
    ((!!q.sessionId && q.sessionId === sessionId) ||
      (!!scope && !!q.launchedFromCwd && normalizeScopePath(q.launchedFromCwd) === scope));

  const running =
    !!scope &&
    Object.values(state.runtimes).some(
      (rt) => !!rt.launchedFromCwd && normalizeScopePath(rt.launchedFromCwd) === scope,
    );

  return { running, queued };
}

/**
 * Should closing this session warn that launch work will be left behind?
 * Launches belong to the worktree scope, so another session in the same cwd keeps
 * that scope represented. Only the final session in the worktree needs the warning.
 */
export function shouldWarnForLaunchOnSessionClose(
  sessionId: string,
  sessionCwd: string | undefined,
  sessions: SdkSession[] = get(sdkSessions),
): boolean {
  const activity = sessionLaunchActivity(sessionId, sessionCwd);
  if (!activity.running && !activity.queued) return false;
  if (!sessionCwd) return true;

  const scope = normalizeScopePath(sessionCwd);
  const hasSiblingInWorktree = sessions.some(
    (session) =>
      session.id !== sessionId &&
      !!session.cwd &&
      normalizeScopePath(session.cwd) === scope,
  );

  return !hasSiblingInWorktree;
}

/** Get runtime for a specific repo ID */
export function getLaunchRuntime(repoId: string | undefined) {
  return derived(launchStore, ($store) => {
    if (!repoId) return null;
    return $store.runtimes[repoId] ?? null;
  });
}

/** Get the queued launch */
export const queuedLaunch = derived(launchStore, ($store) => $store.queued);
