import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";

type LogLevel = "debug" | "info" | "warn" | "error";

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

function sendToFile(level: LogLevel, args: unknown[]) {
  const message = formatArgs(args);
  // Fire-and-forget — never await here so we never block the UI
  invoke("write_frontend_log", { level, message }).catch(() => {
    // Silently ignore if IPC fails (e.g. during app startup before bridge is ready)
  });
}

/**
 * Monkey-patches console.log / console.warn / console.error so every call
 * is also written to the frontend log file on disk via the Tauri backend.
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
