// Live model catalog: fetches the models each provider's SDK/CLI currently
// offers (Claude `supportedModels()`, Codex `model/list`, via the sidecar),
// caches them to `model-catalog.json`, and applies them to the reactive
// ALL_MODELS / OPENAI_MODELS lists. Newly released models are auto-enabled
// (unless they're an older version of a family the user already has).

import { writable, get } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { settings } from "./settings";
import {
  applyListedModels,
  BOOTSTRAP_CLAUDE_MODELS,
  BOOTSTRAP_OPENAI_MODELS,
  type ListedModel,
} from "$lib/utils/modelLists.svelte";
import type { SdkProvider } from "$lib/utils/models";

const CACHE_VERSION = 1;
/** Refetch after this long, or whenever the app version (and so the bundled SDKs) changes. */
const STALE_MS = 6 * 60 * 60 * 1000;
/** Let startup settle before spawning the listing processes. */
const STARTUP_DELAY_MS = 8000;

interface ProviderCache {
  fetchedAt: number;
  models: ListedModel[];
}

interface CatalogCache {
  version: number;
  appVersion?: string;
  providers: Partial<Record<SdkProvider, ProviderCache>>;
  /** Every id ever listed per provider — "new" detection for auto-enable. */
  knownIds: Partial<Record<SdkProvider, string[]>>;
}

export interface ProviderCatalogStatus {
  loading: boolean;
  fetchedAt?: number;
  error?: string;
}

export const modelCatalogStatus = writable<Record<SdkProvider, ProviderCatalogStatus>>({
  claude: { loading: false },
  openai: { loading: false },
});

let cache: CatalogCache = { version: CACHE_VERSION, providers: {}, knownIds: {} };
let appVersion: string | undefined;

/** Load the cached catalog and apply it. Cheap; call right after settings load. */
export async function loadModelCatalog(): Promise<void> {
  try {
    appVersion = await getVersion().catch(() => undefined);
    const raw = await invoke<string | null>("load_model_catalog");
    if (raw) {
      const parsed = JSON.parse(raw) as CatalogCache;
      if (parsed?.version === CACHE_VERSION) cache = parsed;
    }
  } catch (e) {
    console.warn(`[modelCatalog] Failed to load cache: ${e}`);
  }
  for (const provider of ["claude", "openai"] as const) {
    const entry = cache.providers[provider];
    if (entry?.models?.length) {
      applyListedModels(provider, entry.models);
      setStatus(provider, { fetchedAt: entry.fetchedAt });
    }
  }
}

/** Background refresh of stale providers shortly after startup. Returns cleanup. */
export function startModelCatalog(): () => void {
  const timer = setTimeout(() => {
    const enabled = get(settings).enabled_providers ?? { claude: true, openai: true };
    for (const provider of ["claude", "openai"] as const) {
      if (!enabled[provider]) continue;
      if (isStale(provider)) void refreshModelCatalog(provider);
    }
  }, STARTUP_DELAY_MS);
  return () => clearTimeout(timer);
}

function isStale(provider: SdkProvider): boolean {
  const entry = cache.providers[provider];
  if (!entry) return true;
  if (appVersion && cache.appVersion !== appVersion) return true;
  return Date.now() - entry.fetchedAt > STALE_MS;
}

function setStatus(provider: SdkProvider, patch: Partial<ProviderCatalogStatus>): void {
  modelCatalogStatus.update((s) => ({ ...s, [provider]: { ...s[provider], ...patch } }));
}

const inFlight = new Map<SdkProvider, Promise<void>>();

/** Fetch a provider's models now, apply + cache them. Never throws. */
export function refreshModelCatalog(provider: SdkProvider): Promise<void> {
  const existing = inFlight.get(provider);
  if (existing) return existing;
  const run = (async () => {
    setStatus(provider, { loading: true, error: undefined });
    try {
      const models = await invoke<ListedModel[]>("list_agent_models", { provider });
      if (!Array.isArray(models) || models.length === 0) {
        throw new Error("Provider returned no models");
      }
      const known = cache.knownIds[provider] ?? bootstrapIds(provider);
      applyListedModels(provider, models);
      await autoEnableNewModels(provider, models, known);

      const fetchedAt = Date.now();
      cache = {
        ...cache,
        appVersion,
        providers: { ...cache.providers, [provider]: { fetchedAt, models } },
        knownIds: {
          ...cache.knownIds,
          [provider]: [...new Set([...known, ...models.map((m) => m.id)])],
        },
      };
      await invoke("save_model_catalog", { data: JSON.stringify(cache) });
      setStatus(provider, { loading: false, fetchedAt });
      console.log(`[modelCatalog] ${provider}: ${models.length} models`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.warn(`[modelCatalog] ${provider} refresh failed: ${error}`);
      setStatus(provider, { loading: false, error });
    } finally {
      inFlight.delete(provider);
    }
  })();
  inFlight.set(provider, run);
  return run;
}

function bootstrapIds(provider: SdkProvider): string[] {
  return (provider === "openai" ? BOOTSTRAP_OPENAI_MODELS : BOOTSTRAP_CLAUDE_MODELS).map((m) => m.id);
}

/**
 * Family + version of a model id, for "is this newer than what they have?":
 * `claude-sonnet-5-5` → sonnet [5,5]; `claude-haiku-4-5-20251001` → haiku [4,5];
 * `gpt-6-sol` → sol [6]; `gpt-5.5` → "" [5,5]. Null for unrecognized shapes.
 */
export function modelFamilyVersion(
  provider: SdkProvider,
  id: string,
): { family: string; version: number[] } | null {
  if (provider === "openai") {
    const m = /^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/.exec(id);
    return m ? { family: m[2] ?? "", version: m[1].split(".").map(Number) } : null;
  }
  const parts = id.split("-");
  if (parts[0] !== "claude" || !parts[1]) return null;
  const version: number[] = [];
  for (const p of parts.slice(2)) {
    if (!/^\d{1,2}$/.test(p)) break;
    version.push(Number(p));
  }
  return version.length ? { family: parts[1], version } : null;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Which of `listed` should be auto-enabled: never seen before, not flagged
 * legacy, and at least as new as every known model of its family.
 */
export function pickNewModelsToEnable(
  provider: SdkProvider,
  listed: ListedModel[],
  knownIds: string[],
): string[] {
  const known = new Set(knownIds);
  const knownVersions = knownIds
    .map((id) => modelFamilyVersion(provider, id))
    .filter((v): v is NonNullable<typeof v> => v !== null);
  return listed
    .filter((m) => !known.has(m.id) && !m.legacy)
    .filter((m) => {
      const fv = modelFamilyVersion(provider, m.id);
      if (!fv) return false;
      return knownVersions
        .filter((k) => k.family === fv.family)
        .every((k) => compareVersions(fv.version, k.version) >= 0);
    })
    .map((m) => m.id);
}

async function autoEnableNewModels(
  provider: SdkProvider,
  listed: ListedModel[],
  knownIds: string[],
): Promise<void> {
  const fresh = pickNewModelsToEnable(provider, listed, knownIds);
  if (fresh.length === 0) return;
  const config = get(settings);
  const key = provider === "openai" ? "enabled_openai_models" : "enabled_models";
  const current = config[key] ?? [];
  const add = fresh.filter((id) => !current.includes(id));
  if (add.length === 0) return;
  console.log(`[modelCatalog] Auto-enabling new ${provider} models: ${add.join(", ")}`);
  await settings.save({ ...config, [key]: [...add, ...current] });
}
