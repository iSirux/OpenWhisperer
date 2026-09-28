// SDK provider type
export type SdkProvider = "claude" | "openai";

import { ALL_MODELS, OPENAI_MODELS, type ModelInfo } from "./modelLists.svelte";

export { ALL_MODELS, OPENAI_MODELS };
export type { ModelInfo };

// Special "Auto" model that uses LLM integration to recommend the best model
export const AUTO_MODEL: ModelInfo = {
  id: "auto",
  label: "Auto",
  title: "Automatically select the best model using LLM integration",
  isAuto: true,
  maxContextTokens: 1000000,
};

export const DEFAULT_OPENAI_MODEL_ID = "gpt-5.6-terra";

const OPENAI_MODEL_ALIASES: Record<string, string> = {
  "codex-mini-latest": "gpt-5.4",
  "gpt-5.4-codex": "gpt-5.4",
  "gpt-5-mini": "gpt-5.4-mini",
  "gpt-5.1-codex-mini": "gpt-5.4-mini",
  // Deprecated by OpenAI with the GPT-5.6 release
  "gpt-5.3-codex": DEFAULT_OPENAI_MODEL_ID,
  "gpt-5.2-codex": DEFAULT_OPENAI_MODEL_ID,
};

export function normalizeOpenAiModelId(modelId: string): string {
  return OPENAI_MODEL_ALIASES[modelId] || modelId;
}

// Check if a model ID is the auto model
export function isAutoModel(modelId: string): boolean {
  return modelId === AUTO_MODEL.id;
}

// Get all models for a given provider
export function getModelsForProvider(provider: SdkProvider): ModelInfo[] {
  return provider === "openai" ? OPENAI_MODELS : ALL_MODELS;
}

// Get enabled models filtered by the enabled_models setting
export function getEnabledModels(enabledModelIds: string[], provider: SdkProvider = "claude"): ModelInfo[] {
  const allModels = getModelsForProvider(provider);
  const normalizedEnabled = new Set(enabledModelIds.map((id) => normalizeOpenAiModelId(id)));
  return allModels.filter((model) => normalizedEnabled.has(model.id));
}

// Get enabled models with Auto option always prepended (Claude only)
// The Auto option is always shown, but isAutoEnabled indicates if the feature is active
export function getEnabledModelsWithAuto(enabledModelIds: string[], _includeAuto?: boolean): ModelInfo[] {
  const models = getEnabledModels(enabledModelIds, "claude");
  // Always include Auto option - the component will handle navigation to settings if not enabled
  return [AUTO_MODEL, ...models];
}

// Get model info by ID (searches both Claude and OpenAI models)
export function getModelById(id: string): ModelInfo | undefined {
  if (id === AUTO_MODEL.id) return AUTO_MODEL;
  const normalizedId = normalizeOpenAiModelId(id);
  return ALL_MODELS.find((model) => model.id === normalizedId) || OPENAI_MODELS.find((model) => model.id === normalizedId);
}

// Default model to use when no other model is available
export const DEFAULT_MODEL_ID = "claude-sonnet-5";

/**
 * Resolve a bare provider alias (e.g. "opus", "sonnet", "haiku") to a concrete
 * model id. Sequence prompt nodes store shorthand model names that the sidecar
 * expands at runtime; the UI needs the full id so the model selector and labels
 * match what actually ran. Returns the input unchanged when it's already a known
 * id, is "auto", or has no alias match.
 */
export function resolveModelAlias(modelId: string): string {
  if (!modelId || isAutoModel(modelId) || getModelById(modelId)) return modelId;
  const alias = modelId.toLowerCase();
  const all = [...ALL_MODELS, ...OPENAI_MODELS];
  // Exact match on the un-prefixed id wins over the substring scan below, so a
  // version-qualified alias still resolves to that exact version once a newer
  // model shares its prefix ("opus-5" must not drift onto "claude-opus-5-5").
  const exact = all.find(
    (m) => m.id.toLowerCase() === `claude-${alias.replace(/\./g, "-")}`,
  );
  if (exact) return exact.id;
  // Provider-reported aliases ("opus" → whatever Opus the SDK currently points at).
  const aliased = all.find((m) => m.aliases?.includes(alias));
  if (aliased) return aliased.id;
  const match = all.find((m) => m.id.toLowerCase().includes(alias));
  return match?.id ?? modelId;
}

// Check if a model ID belongs to OpenAI
export function isOpenAiModel(modelId: string): boolean {
  return OPENAI_MODELS.some((m) => m.id === modelId) ||
    modelId.startsWith("codex") ||
    modelId.startsWith("gpt-");
}

// Get the provider for a model ID
export function getProviderForModel(modelId: string): SdkProvider {
  return isOpenAiModel(modelId) ? "openai" : "claude";
}

export function getMaxContextTokens(modelId: string): number {
  if (isAutoModel(modelId)) {
    return AUTO_MODEL.maxContextTokens ?? 1000000;
  }
  return getModelById(modelId)?.maxContextTokens ?? (isOpenAiModel(modelId) ? 400000 : 200000);
}

/**
 * Resolve a model ID for use with the API.
 * If the model is "auto" and no recommendation was made, falls back to the first enabled model
 * or the default model.
 *
 * @param modelId The model ID to resolve
 * @param enabledModels Array of enabled model IDs
 * @returns A valid model ID that can be sent to the API
 */
export function resolveModelForApi(modelId: string, enabledModels: string[]): string {
  if (isAutoModel(modelId)) {
    // "auto" should never be sent to the API - fall back to first enabled model
    return normalizeOpenAiModelId(enabledModels[0] || DEFAULT_MODEL_ID);
  }
  return normalizeOpenAiModelId(modelId);
}

/**
 * Check if a model supports the effort parameter
 */
export function modelSupportsEffort(modelId: string): boolean {
  const model = getModelById(modelId);
  return model?.supportsEffort ?? false;
}

/**
 * Get the maximum effort level supported by a model.
 * Comes from the provider's live effort list once the catalog is fetched;
 * defaults to 'high' for unknown models.
 */
export function getMaxEffort(modelId: string): 'high' | 'xhigh' | 'max' {
  const model = getModelById(modelId);
  return model?.maxEffort ?? 'high';
}

/**
 * Whether the model exposes the 'xhigh' effort tier in the UI.
 * True when maxEffort >= xhigh AND the model doesn't explicitly opt out.
 */
export function modelSupportsXhigh(modelId: string): boolean {
  const model = getModelById(modelId);
  if (!model) return false;
  const max = model.maxEffort ?? 'high';
  if (max === 'high') return false;
  return model.supportsXhigh ?? true;
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Clamp an effort level down to a value the given model/provider actually supports.
 *
 * - OpenAI/Codex models are clamped to the model's `maxEffort` (from Codex's
 *   `model/list`). Unknown OpenAI model IDs conservatively clamp
 *   'xhigh'/'max' -> 'high'.
 * - For Claude models, the value is returned unchanged (the SDK accepts the full
 *   effort range natively, including 'xhigh', and falls back internally when needed).
 * - `null` / `undefined` (effort off) passes through unchanged.
 * - Haiku (and any model without effort support) is left untouched; callers decide whether
 *   to strip effort entirely for no-effort models.
 */
export function clampEffortForModel<T extends string | null | undefined>(
  effort: T,
  modelId: string,
): T {
  if (effort == null) return effort;
  if (!isOpenAiModel(modelId)) return effort;
  const maxEffort = getModelById(modelId)?.maxEffort ?? 'high';
  const effortIdx = EFFORT_ORDER.indexOf(effort as (typeof EFFORT_ORDER)[number]);
  const maxIdx = EFFORT_ORDER.indexOf(maxEffort);
  if (effortIdx > maxIdx) {
    return maxEffort as T;
  }
  return effort;
}
