import { writable, derived, get } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { LaunchCommand, LaunchProfile, LaunchRuntime, QueuedLaunch } from "$lib/types/launch";
import { repos, findRepoById } from "./repos";

// ---- Store State ----

interface LaunchState {
  /** Currently running launches, keyed by repo ID */
  runtimes: Record<string, LaunchRuntime>;
  /** Queued launch waiting for an agent to finish */
  queued: QueuedLaunch | null;
}

const defaultState: LaunchState = {
  runtimes: {},
  queued: null,
};

// ---- Store Implementation ----

// Cleanup functions for queued launch event listeners
let queueCleanup: (() => void) | null = null;

function createLaunchStore() {
  const { subscribe, set, update } = writable<LaunchState>(defaultState);

  return {
    subscribe,

    /** Launch a specific profile by its ID */
    async launchProfile(repoId: string, profileId: string): Promise<void> {
      try {
        await invoke("launch_profile", { repoId, profileId });

        // Get profile info for display
        const reposList = get(repos).list;
        const repo = findRepoById(reposList, repoId);
        const profile = repo?.launch_profiles?.find((p) => p.id === profileId);

        update((s) => ({
          ...s,
          runtimes: {
            ...s.runtimes,
            [repoId]: {
              repoId,
              profileId,
              profileName: profile?.name,
              runningCommandIds: profile?.command_ids ?? [],
              startedAt: Date.now(),
            },
          },
        }));
      } catch (error) {
        console.error("[launch] Failed to launch profile:", error);
        throw error;
      }
    },

    /** Launch specific commands directly */
    async launchCommands(repoId: string, repoPath: string, commands: LaunchCommand[]): Promise<void> {
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
      try {
        await invoke("stop_launch_profile", { repoId });
        update((s) => {
          const { [repoId]: _, ...rest } = s.runtimes;
          return { ...s, runtimes: rest };
        });
      } catch (error) {
        console.error("[launch] Failed to stop profile:", error);
        throw error;
      }
    },

    /** Refresh runtime status from backend */
    async refreshStatus(repoId: string): Promise<void> {
      try {
        const runningIds = await invoke<string[]>("get_launch_status", { repoId });
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
      }
    },

    /** Queue a profile launch to auto-trigger when a session finishes */
    async queueAfterAgent(repoId: string, profileId: string, profileName: string, sessionId: string): Promise<void> {
      // Clean up any existing queue
      this.cancelQueue();

      const unlistenDone = await listen(`sdk-done-${sessionId}`, () => {
        console.log("[launch] Agent done, launching queued profile");
        this.launchProfile(repoId, profileId);
        this.cancelQueue();
      });

      const unlistenError = await listen(`sdk-error-${sessionId}`, () => {
        console.warn("[launch] Agent errored, cancelling queued launch");
        this.cancelQueue();
      });

      queueCleanup = () => {
        unlistenDone();
        unlistenError();
      };

      update((s) => ({
        ...s,
        queued: { repoId, profileId, profileName, sessionId },
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

// ---- Derived Stores ----

/** Get runtime for a specific repo ID */
export function getLaunchRuntime(repoId: string | undefined) {
  return derived(launchStore, ($store) => {
    if (!repoId) return null;
    return $store.runtimes[repoId] ?? null;
  });
}

/** Get the queued launch */
export const queuedLaunch = derived(launchStore, ($store) => $store.queued);
