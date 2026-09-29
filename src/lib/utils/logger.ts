import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";

type LogLevel = "debug" | "info" | "warn" | "error";

type LogEntry = { level: LogLevel; message: string; ts: string };

/** Info/debug lines are batched into one IPC call per window this long. */
const FLUSH_DELAY_MS = 500;
/** Flush early once this many lines are waiting. */
const MAX_BATCH = 200;

let pending: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.message}\n${a.stack ?? ""}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

/** Local time as `YYYY-MM-DDTHH:MM:SS.mmm` — the frontend log's line format. */
function localTimestamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.length === 0) return;
  const entries = pending;
  pending = [];
  // Fire-and-forget — never await here so we never block the UI
  invoke("write_frontend_log", { entries }).catch(() => {
    // Silently ignore if IPC fails (e.g. during app startup before bridge is ready)
  });
}

function sendToFile(level: LogLevel, args: unknown[]) {
  // Timestamp now, not at flush, so batched lines keep their real times.
  pending.push({ level, message: formatArgs(args), ts: localTimestamp() });
  // Warnings and errors go out right away (with everything queued before them)
  // so they aren't lost if the webview dies.
  if (level === "warn" || level === "error" || pending.length >= MAX_BATCH) {
    flush();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  }
}

/**
 * Monkey-patches console.log / console.warn / console.error so every call
 * is also written to the frontend log file on disk via the Tauri backend.
 * Lines are batched (one IPC call per ~500 ms; warn/error immediately).
 *
 * Call once, as early as possible in +layout.svelte's onMount.
 */
export function initLogger() {
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const origDebug = console.debug.bind(console);

  console.log = (...args: unknown[]) => {
    origLog(...args);
    sendToFile("info", args);
  };

  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    sendToFile("warn", args);
  };

  console.error = (...args: unknown[]) => {
    origError(...args);
    sendToFile("error", args);
  };

  console.debug = (...args: unknown[]) => {
    origDebug(...args);
    sendToFile("debug", args);
  };

  // Don't drop the tail of the batch on reload / window close.
  window.addEventListener("pagehide", flush);

  // Write a startup marker so it's easy to find session boundaries in the log.
  // Read the version from Tauri at runtime (the authoritative tauri.conf.json
  // value) rather than the build-time package.json constant, which lags a
  // release by one version since the workflow only commits it back post-build.
  getVersion()
    .then((version) =>
      sendToFile("info", [`=== OpenWhisperer ${version} frontend started ===`])
    )
    .catch(() =>
      sendToFile("info", [
        `=== OpenWhisperer ${__APP_VERSION__ ?? "unknown"} frontend started ===`,
      ])
    );
}

// Vite injects this at build time via define in vite.config.ts
declare const __APP_VERSION__: string | undefined;
