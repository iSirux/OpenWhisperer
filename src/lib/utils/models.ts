// SDK provider type
export type SdkProvider = "claude" | "openai";

// All available models with metadata
export interface ModelInfo {
  id: string;
  label: string;
  title: string;
  isAuto?: boolean; // Special flag for auto model selection
  /** Whether this model supports the effort parameter */
  supportsEffort?: boolean;
  /** Maximum effort level supported: 'high' for most models, 'max' for Opus 4.6 */
  maxEffort?: 'high' | 'max';
}

// Special "Auto" model that uses LLM integration to recommend the best model
export const AUTO_MODEL: ModelInfo = {
  id: "auto",
  label: "Auto",
  title: "Automatically select the best model using LLM integration",
  isAuto: true,
};

export const ALL_MODELS: ModelInfo[] = [
  {
    id: "claude-opus-4-6",
    label: "Opus",
    title: "Opus 4.6 - Most capable model",
    supportsEffort: true,
    maxEffort: "high", // 'max' is API-key only, not available for Claude.ai subscribers
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet",
    title: "Sonnet 4.6 - Balanced performance",
    supportsEffort: true,
    maxEffort: "high",
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku",
    title: "Haiku 4.5 - Fastest model",
    supportsEffort: false,
  },
];

export const OPENAI_MODELS: ModelInfo[] = [
  {
    id: "gpt-5.4",
    label: "5.4",
    title: "GPT-5.4 - Most capable agentic coding model",
    supportsEffort: true,
    maxEffort: "high",
  },
  {
    id: "gpt-5.3-codex",
    label: "5.3 Codex",
    title: "GPT-5.3 Codex - Most capable agentic coding model",
    supportsEffort: true,
    maxEffort: "high",
  },
  {
    id: "gpt-5.3-codex-spark",
    label: "5.3 Spark",
    title: "GPT-5.3 Codex Spark - Near-instant real-time coding (Pro only)",
    supportsEffort: true,
    maxEffort: "high",
  },
  {
    id: "gpt-5.2-codex",
    label: "5.2 Codex",
    title: "GPT-5.2 Codex - Advanced production engineering",
    supportsEffort: true,
    maxEffort: "high",
  },
  {
    id: "gpt-5.1-codex-mini",
    label: "5.1 Mini",
    title: "GPT-5.1 Codex Mini - Cost-effective, up to 4x more usage",
    supportsEffort: true,
    maxEffort: "high",
  },
];

export const DEFAULT_OPENAI_MODEL_ID = "gpt-5.4";

const OPENAI_MODEL_ALIASES: Record<string, string> = {
  "codex-mini-latest": DEFAULT_OPENAI_MODEL_ID,
  "gpt-5.4-codex": DEFAULT_OPENAI_MODEL_ID,
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
export const DEFAULT_MODEL_ID = "claude-sonnet-4-6";

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
 * Get the maximum effort level supported by a model
 * Returns 'high' for most models, 'max' for Opus 4.6
 */
export function getMaxEffort(modelId: string): 'high' | 'max' {
  const model = getModelById(modelId);
  return model?.maxEffort ?? 'high';
}
