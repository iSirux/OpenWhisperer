// App update checking and installation via the Tauri updater plugin.
// Checks a static latest.json manifest on the GitHub release, verifies the
// signature, downloads and runs the installer. On Windows the app exits while
// the installer runs, so the "installed" state is mostly reached on macOS/Linux.
import { writable, derived, get } from "svelte/store";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { UpdateCheckMode } from "$lib/stores/settings";

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "installed"
  | "error";

export interface UpdaterState {
  status: UpdaterStatus;
  /** Version of the available update (when status is available/downloading/installed) */
  version: string | null;
  /** Release notes from the update manifest */
  notes: string | null;
  /** Download progress 0..1, or null while the total size is unknown */
  progress: number | null;
  error: string | null;
}

const initialState: UpdaterState = {
  status: "idle",
  version: null,
  notes: null,
  progress: null,
  error: null,
};

function createUpdaterStore() {
  const store = writable<UpdaterState>(initialState);
  const { subscribe, set, update } = store;

  // The Update handle is not serializable state; keep it module-side
  let currentUpdate: Update | null = null;

  /** Check the update endpoint. Returns true if an update is available. */
  async function checkForUpdate(): Promise<boolean> {
    const s = get(store);
    if (s.status === "checking" || s.status === "downloading") return false;
    update((st) => ({ ...st, status: "checking", error: null }));
    try {
      const found = await check();
      if (found) {
        currentUpdate = found;
        set({
          status: "available",
          version: found.version,
          notes: found.body ?? null,
          progress: null,
          error: null,
        });
        return true;
      }
      currentUpdate = null;
      set({ ...initialState, status: "upToDate" });
      return false;
    } catch (e) {
      console.error("[updater] Check failed:", e);
      set({ ...initialState, status: "error", error: String(e) });
      return false;
    }
  }

  /**
   * Download and install the available update. On Windows the installer takes
   * over and the app exits before this resolves; on macOS/Linux the promise
   * resolves and the caller may offer a restart.
   */
  async function downloadAndInstall(): Promise<boolean> {
    if (!currentUpdate) return false;
    let total = 0;
    let received = 0;
    update((st) => ({ ...st, status: "downloading", progress: null, error: null }));
    try {
      await currentUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          if (total > 0) {
            const progress = Math.min(received / total, 1);
            update((st) => ({ ...st, progress }));
          }
        } else if (event.event === "Finished") {
          update((st) => ({ ...st, progress: 1 }));
        }
      });
      update((st) => ({ ...st, status: "installed", progress: 1 }));
      return true;
    } catch (e) {
      console.error("[updater] Download/install failed:", e);
      update((st) => ({
        ...st,
        status: "error",
        error: String(e),
        progress: null,
      }));
      return false;
    }
  }

  /** Relaunch the app to run the freshly installed version (macOS/Linux). */
  async function restart(): Promise<void> {
    await relaunch();
  }

  /**
   * Startup check per the system.update_check setting. Skipped in dev builds —
   * a dev build always looks older than the published release.
   */
  async function startupCheck(mode: UpdateCheckMode): Promise<void> {
    if (import.meta.env.DEV || mode === "Off") return;
    const available = await checkForUpdate();
    if (available && mode === "Auto") {
      const installed = await downloadAndInstall();
      // Windows never reaches this point (installer exits the app)
      if (installed) await restart();
    }
  }

  return {
    subscribe,
    checkForUpdate,
    downloadAndInstall,
    restart,
    startupCheck,
    reset: () => set(initialState),
  };
}

export const updater = createUpdaterStore();

/** True when an update is available or being installed — drives the header pill. */
export const updateAvailable = derived(
  updater,
  ($u) => $u.status === "available" || $u.status === "downloading" || $u.status === "installed"
);
