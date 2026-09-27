/**
 * In-app local LLM (llama.cpp `llama-server`) — frontend side of
 * `src-tauri/src/local_llm/`.
 *
 * Global (not component-scoped) so a multi-GB download keeps reporting
 * progress while the user navigates away from Settings. `initLocalLlm()` is
 * idempotent; it's called from the main layout and from `LocalLlmSetup`
 * (the onboarding route sits outside the main layout).
 *
 * The backend mutates `llm` / `local_llm` itself (install, routing, port
 * changes) and announces it via `local-llm-config`; we merge that into the
 * settings store so the settings page's whole-config auto-save never writes
 * a stale copy back.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writable, get } from "svelte/store";
import { settings, type LlmConfig, type LocalLlmConfig } from "./settings";

export type LocalLlmServerState = "stopped" | "starting" | "running" | "error";

export interface LocalLlmStatus {
  state: LocalLlmServerState;
  port: number | null;
  model: string | null;
  vram_used_mib: number | null;
  message: string | null;
  /** Last start used `-ngl 99` (true) or `--fit on` (false) */
  full_gpu: boolean | null;
  startup_ms: number | null;
  installing: boolean;
}

export type LocalLlmStage =
  | "runtime"
  | "model"
  | "verifying"
  | "starting"
  | "test"
  | "done"
  | "cancelled"
  | "error";

export interface LocalLlmProgress {
  stage: LocalLlmStage;
  file: string | null;
  downloaded: number;
  total: number | null;
  message: string | null;
}

export interface GpuInfo {
  name: string;
  vendor: "nvidia" | "amd" | "intel" | "apple" | "other" | "none";
  vram_total_mib: number | null;
  vram_free_mib: number | null;
  driver_version: string | null;
  unified_memory: boolean;
}

export interface LocalLlmProbe {
  hardware: {
    os: string;
    arch: string;
    gpu: GpuInfo | null;
    ram_total_mib: number | null;
    cpu_name: string | null;
    disk_free_mib: number | null;
    models_dir: string;
  };
  recommendation: { preset_id: string; budget_mib: number | null; reason: string };
  whisper_local: boolean;
  default_models_dir: string;
}

export interface LocalLlmPreset {
  id: string;
  label: string;
  model_name: string;
  file_name: string;
  url: string;
  size_bytes: number;
  sha256: string;
  vram_needed_mib: number;
  min_gpu_total_mib: number;
  description: string;
  license: string;
  license_note: string | null;
}

export interface LocalLlmBenchmark {
  latency_ms: number;
  tokens_per_second: number | null;
  prompt_tokens_per_second: number | null;
  completion_tokens: number | null;
  prompt_tokens: number | null;
  valid_json: boolean;
  output: string;
}

export interface LocalLlmInstallOutcome {
  status: LocalLlmStatus;
  benchmark: LocalLlmBenchmark | null;
  runtime_version: string;
  runtime_variant: string;
}

const STOPPED: LocalLlmStatus = {
  state: "stopped",
  port: null,
  model: null,
  vram_used_mib: null,
  message: null,
  full_gpu: null,
  startup_ms: null,
  installing: false,
};

export const localLlmStatus = writable<LocalLlmStatus>(STOPPED);
/** Latest progress event of the running (or last) setup; null = none yet. */
export const localLlmProgress = writable<LocalLlmProgress | null>(null);
/** Result of the last successful setup / speed test. */
export const localLlmBenchmark = writable<LocalLlmBenchmark | null>(null);
/** Error of the last failed setup (cleared on the next attempt). */
export const localLlmError = writable<string | null>(null);

let initialized: Promise<void> | null = null;

export function initLocalLlm(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    await listen<LocalLlmStatus>("local-llm-status", (e) => localLlmStatus.set(e.payload));
    await listen<LocalLlmProgress>("local-llm-progress", (e) => localLlmProgress.set(e.payload));
    await listen<{ llm: LlmConfig; local_llm: LocalLlmConfig }>("local-llm-config", (e) => {
      settings.update((s) => ({ ...s, llm: e.payload.llm, local_llm: e.payload.local_llm }));
    });
    await refreshLocalLlmStatus();
  })();
  return initialized;
}

export async function refreshLocalLlmStatus() {
  try {
    localLlmStatus.set(await invoke<LocalLlmStatus>("local_llm_status"));
  } catch (e) {
    console.error("[localLlm] status failed:", e);
  }
}

export function probeLocalLlm(): Promise<LocalLlmProbe> {
  return invoke<LocalLlmProbe>("local_llm_probe");
}

export function getLocalLlmPresets(): Promise<LocalLlmPreset[]> {
  return invoke<LocalLlmPreset[]>("local_llm_presets");
}

/** Persist the frontend's settings first: the backend reads `models_dir` from its copy. */
async function persistSettings() {
  await settings.save(get(settings));
}

export async function installLocalLlm(opts: {
  presetId?: string | null;
  existingPath?: string | null;
  useForQuality: boolean;
  useForFast: boolean;
}): Promise<LocalLlmInstallOutcome> {
  localLlmError.set(null);
  localLlmBenchmark.set(null);
  localLlmProgress.set({ stage: "runtime", file: null, downloaded: 0, total: null, message: "Preparing…" });
  await persistSettings();
  try {
    const outcome = await invoke<LocalLlmInstallOutcome>("local_llm_install", {
      presetId: opts.presetId ?? null,
      existingPath: opts.existingPath ?? null,
      useForQuality: opts.useForQuality,
      useForFast: opts.useForFast,
    });
    localLlmBenchmark.set(outcome.benchmark);
    return outcome;
  } catch (e) {
    const msg = String(e);
    localLlmError.set(msg === "Cancelled" ? null : msg);
    throw e;
  } finally {
    await refreshLocalLlmStatus();
  }
}

export function cancelLocalLlm(): Promise<void> {
  return invoke("local_llm_cancel");
}

export async function startLocalLlm(): Promise<LocalLlmStatus> {
  const s = await invoke<LocalLlmStatus>("local_llm_start");
  localLlmStatus.set(s);
  return s;
}

export async function stopLocalLlm(): Promise<LocalLlmStatus> {
  const s = await invoke<LocalLlmStatus>("local_llm_stop");
  localLlmStatus.set(s);
  return s;
}

export async function benchmarkLocalLlm(): Promise<LocalLlmBenchmark> {
  const b = await invoke<LocalLlmBenchmark>("local_llm_benchmark");
  localLlmBenchmark.set(b);
  return b;
}

export async function setLocalLlmRouting(useForQuality: boolean, useForFast: boolean) {
  await invoke("local_llm_set_routing", { useForQuality, useForFast });
}

export async function uninstallLocalLlm(removeModels: boolean) {
  await invoke("local_llm_uninstall", { removeModels });
  localLlmProgress.set(null);
  localLlmBenchmark.set(null);
  await refreshLocalLlmStatus();
}

export function formatGb(mib: number | null | undefined): string {
  if (mib == null) return "?";
  return `${(mib / 1024).toFixed(1)} GB`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "?";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}
