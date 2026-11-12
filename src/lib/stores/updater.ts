// App update checking and installation via the Tauri updater plugin.
// Checks a static latest.json manifest on the GitHub release and, as soon as an
// update is found, downloads (and signature-verifies) it in the background, so
// installing is one click that runs right away. On Windows the app exits while
// the installer runs; on macOS/Linux we relaunch after installing.
//
// Cleanup: the downloaded package lives in a Rust-side resource owned by the
// `Update` handle — every superseded handle (newer release found, endpoint no
// longer offers an update, failed download) is `close()`d to free it. The
// installer folder the plugin writes to %TEMP% on Windows is removed at the
// next startup (`updater_cleanup.rs`).
import { writable, derived, get } from "svelte/store";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { UpdateCheckMode } from "$lib/stores/settings";

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "upToDate"
  /** Found, but not downloaded (background download failed) — install downloads first */
  | "available"
  | "downloading"
  /** Downloaded and verified — installing is instant */
  | "ready"
  | "installing"
  | "installed"
  | "error";

export interface UpdaterState {
  status: UpdaterStatus;
  /** Version of the update being offered */
  version: string | null;
  /** Release notes from the update manifest */
  notes: string | null;
  /** Download progress 0..1, or null while the total size is unknown */
  progress: number | null;
  /** True while a download runs in the background (not requested by the user) */
  background: boolean;
  error: string | null;
}

const initialState: UpdaterState = {
  status: "idle",
  version: null,
  notes: null,
  progress: null,
  background: false,
  error: null,
};

function createUpdaterStore() {
  const store = writable<UpdaterState>(initialState);
  const { subscribe, set, update } = store;

  // Not serializable state; kept module-side.
  let currentUpdate: Update | null = null;
  /** Version whose package is downloaded into `currentUpdate` */
  let downloadedVersion: string | null = null;
  let downloadPromise: Promise<boolean> | null = null;

  /** Drop the held update handle, freeing any downloaded bytes on the Rust side. */
  async function releaseUpdate(): Promise<void> {
    const old = currentUpdate;
    currentUpdate = null;
    downloadedVersion = null;
    if (old) {
      try {
        await old.close();
      } catch (e) {
        console.warn("[updater] Failed to release update handle:", e);
      }
    }
  }

  /**
   * Query the endpoint and reconcile with what we hold. Returns the update
   * handle to use (possibly the already-downloaded one) or null when none.
   * Throws on network/manifest errors.
   */
  async function refresh(): Promise<Update | null> {
    const found = await check();
    if (!found) {
      await releaseUpdate();
      return null;
    }
    if (currentUpdate && currentUpdate.version === found.version) {
      // Same release we already hold (maybe downloaded) — keep it.
      await found.close().catch(() => {});
      return currentUpdate;
    }
    await releaseUpdate();
    currentUpdate = found;
    return found;
  }

  /** Download the held update. Resolves true when it's ready to install. */
  function download(background: boolean): Promise<boolean> {
    if (downloadPromise) {
      // Already running — a user request just stops it being "background".
      if (!background) update((st) => ({ ...st, background: false }));
      return downloadPromise;
    }
    const target = currentUpdate;
    if (!target) return Promise.resolve(false);
    if (downloadedVersion === target.version) return Promise.resolve(true);

    let total = 0;
    let received = 0;
    update((st) => ({
      ...st,
      status: "downloading",
      version: target.version,
      notes: target.body ?? null,
      progress: null,
      background,
      error: null,
    }));
    downloadPromise = (async () => {
      try {
        await target.download((event) => {
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
        if (currentUpdate !== target) return false; // superseded meanwhile
        downloadedVersion = target.version;
        update((st) => ({ ...st, status: "ready", progress: 1, background: false }));
        return true;
      } catch (e) {
        console.error("[updater] Download failed:", e);
        if (currentUpdate === target) {
          // Reopen as "available": a click retries with a fresh handle.
          update((st) => ({
            ...st,
            status: "available",
            progress: null,
            background: false,
            error: String(e),
          }));
        }
        return false;
      } finally {
        downloadPromise = null;
      }
    })();
    return downloadPromise;
  }

  /**
   * Check the update endpoint. When an update is found it starts downloading
   * in the background. Returns true if an update is available.
   */
  async function checkForUpdate(): Promise<boolean> {
    const s = get(store);
    if (s.status === "checking" || s.status === "downloading" || s.status === "installing") {
      return s.status === "downloading";
    }
    const prev = s;
    update((st) => ({ ...st, status: "checking", error: null }));
    try {
      const found = await refresh();
      if (!found) {
        set({ ...initialState, status: "upToDate" });
        return false;
      }
      if (downloadedVersion === found.version) {
        set({ ...initialState, status: "ready", version: found.version, notes: found.body ?? null, progress: 1 });
        return true;
      }
      void download(true);
      return true;
    } catch (e) {
      console.error("[updater] Check failed:", e);
      if (prev.status === "ready" && downloadedVersion) {
        // Offline now, but the downloaded update is still good to install.
        set(prev);
        return true;
      }
      set({ ...initialState, status: "error", error: String(e) });
      return false;
    }
  }

  /**
   * Install the update — instant when it was already downloaded in the
   * background. On Windows the installer takes over and the app exits before
   * this resolves; on macOS/Linux the app relaunches into the new version.
   *
   * Re-checks the endpoint first (when not already downloaded) so a release
   * published since detection is the one installed.
   */
  async function downloadAndInstall(): Promise<boolean> {
    const s = get(store);
    if (s.status === "installing") return false;

    if (s.status !== "ready" || !downloadedVersion) {
      if (!downloadPromise) {
        try {
          const latest = await refresh();
          if (!latest) {
            set({ ...initialState, status: "upToDate" });
            return false;
          }
        } catch (e) {
          console.error("[updater] Re-check before install failed:", e);
          set({ ...initialState, status: "error", error: String(e) });
          return false;
        }
      }
      if (!(await download(false))) return false;
    }

    const target = currentUpdate;
    if (!target) return false;
    update((st) => ({ ...st, status: "installing", error: null }));
    try {
      await target.install(); // frees the downloaded bytes on the Rust side
      downloadedVersion = null;
      update((st) => ({ ...st, status: "installed", progress: 1 }));
    } catch (e) {
      console.error("[updater] Install failed:", e);
      // The downloaded package may be bad; drop it so a retry re-downloads.
      await releaseUpdate();
      update((st) => ({ ...st, status: "available", progress: null, error: String(e) }));
      return false;
    }
    try {
      await relaunch();
    } catch (e) {
      console.error("[updater] Relaunch failed:", e);
    }
    return true;
  }

  /** Relaunch the app to run the freshly installed version (macOS/Linux). */
  async function restart(): Promise<void> {
    await relaunch();
  }

  /**
   * Scheduled check per the system.update_check setting. Skipped in dev builds —
   * a dev build always looks older than the published release. Any found update
   * is downloaded in the background; the header pill then installs it in one
   * click. In Auto mode it is installed as soon as the download finishes.
   */
  async function scheduledCheck(mode: UpdateCheckMode): Promise<void> {
    if (import.meta.env.DEV || mode === "Off") return;
    lastCheckAt = Date.now();
    const available = await checkForUpdate();
    if (available && mode === "Auto") {
      if (downloadPromise) await downloadPromise;
      if (get(store).status === "ready") await downloadAndInstall();
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
    reset: () => {
      void releaseUpdate();
      set(initialState);
    },
  };
}

export const updater = createUpdaterStore();

/**
 * Drives the header pill: shown once the update is downloaded (one click
 * installs), while installing, when a user-started download runs, or when the
 * background download failed (click downloads + installs). A background
 * download in progress stays quiet.
 */
export const updateAvailable = derived(
  updater,
  ($u) =>
    $u.status === "ready" ||
    $u.status === "installing" ||
    $u.status === "installed" ||
    $u.status === "available" ||
    ($u.status === "downloading" && !$u.background)
);
