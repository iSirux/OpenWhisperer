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
   *
   * Re-checks the endpoint first so we install the newest version even if a
   * fresher release was published since the update was originally detected
   * (the cached handle could otherwise point at an already-superseded build).
   */
  async function downloadAndInstall(): Promise<boolean> {
    // Refresh the update handle before committing to an install.
    try {
      const latest = await check();
      if (!latest) {
        // The endpoint no longer offers an update — nothing to install.
        currentUpdate = null;
        set({ ...initialState, status: "upToDate" });
        return false;
      }
      currentUpdate = latest;
      update((st) => ({
        ...st,
        version: latest.version,
        notes: latest.body ?? null,
      }));
    } catch (e) {
      console.error("[updater] Re-check before install failed:", e);
      set({ ...initialState, status: "error", error: String(e) });
      return false;
    }

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
   * Scheduled check per the system.update_check setting. Skipped in dev builds —
   * a dev build always looks older than the published release. Notifies (status
   * flips to "available", driving the header pill) or, in Auto mode, downloads
   * and installs.
   */
  async function scheduledCheck(mode: UpdateCheckMode): Promise<void> {
    if (import.meta.env.DEV || mode === "Off") return;
    lastCheckAt = Date.now();
    const available = await checkForUpdate();
    if (available && mode === "Auto") {
      const installed = await downloadAndInstall();
      // Windows never reaches this point (installer exits the app)
      if (installed) await restart();
    }
  }

  /** Startup check, run once when the app boots. */
  async function startupCheck(mode: UpdateCheckMode): Promise<void> {
    await scheduledCheck(mode);
  }

  const PERIODIC_INTERVAL_MS = 60 * 60 * 1000; // check at most hourly
  const POLL_INTERVAL_MS = 5 * 60 * 1000; // wake up every 5 min to re-evaluate

  let periodicTimer: ReturnType<typeof setInterval> | null = null;
  let onFocus: (() => void) | null = null;
  let lastCheckAt = 0;

  /** Whether the app window currently has focus (assume yes if unavailable). */
  function appFocused(): boolean {
    return typeof document === "undefined" ? true : document.hasFocus();
  }

  function stopPeriodicChecks(): void {
    if (periodicTimer != null) {
      clearInterval(periodicTimer);
      periodicTimer = null;
    }
    if (onFocus != null && typeof window !== "undefined") {
      window.removeEventListener("focus", onFocus);
      onFocus = null;
    }
  }

  /** Run a scheduled check only if the app is focused and an hour has elapsed. */
  async function maybeScheduledCheck(mode: UpdateCheckMode): Promise<void> {
    if (!appFocused()) return;
    if (Date.now() - lastCheckAt < PERIODIC_INTERVAL_MS) return;
    await scheduledCheck(mode);
  }

  /**
   * Keep the update state fresh for long-running app sessions. Only checks while
   * the app window is focused (no background polling) and at most once an hour;
   * also re-evaluates when the window regains focus. Returns a cleanup fn.
   * No-op in dev builds or when update checks are disabled.
   */
  function startPeriodicChecks(mode: UpdateCheckMode): () => void {
    stopPeriodicChecks();
    if (import.meta.env.DEV || mode === "Off") return () => {};
    periodicTimer = setInterval(() => {
      void maybeScheduledCheck(mode);
    }, POLL_INTERVAL_MS);
    if (typeof window !== "undefined") {
      onFocus = () => void maybeScheduledCheck(mode);
      window.addEventListener("focus", onFocus);
    }
    return stopPeriodicChecks;
  }

  return {
    subscribe,
    checkForUpdate,
    downloadAndInstall,
    restart,
    startupCheck,
    startPeriodicChecks,
    stopPeriodicChecks,
    reset: () => set(initialState),
  };
}

export const updater = createUpdaterStore();

/** True when an update is available or being installed — drives the header pill. */
export const updateAvailable = derived(
  updater,
  ($u) => $u.status === "available" || $u.status === "downloading" || $u.status === "installed"
);
