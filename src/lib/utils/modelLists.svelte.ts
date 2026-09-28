// Reactive model catalog. The lists start from the bootstrap snapshot below
// (used offline / before the first fetch) and are replaced in place by
// `applyListedModels` once the provider SDKs report what they actually offer
// (see stores/modelCatalog.ts). Kept in a .svelte.ts module so every reader of
// ALL_MODELS / OPENAI_MODELS re-renders when the catalog changes.

export interface ModelInfo {
  id: string;
  label: string;
  title: string;
  isAuto?: boolean; // Special flag for auto model selection
  maxContextTokens?: number;
  /** Whether this model supports the effort parameter */
  supportsEffort?: boolean;
  /**
   * Maximum effort level supported by the model.
   * - 'high': Older OpenAI/Codex models (pre-5.6) cap out here
   * - 'xhigh': intermediate tier between 'high' and 'max'
   * - 'max': Full "max" reasoning (native Anthropic SDK value; GPT-6 / GPT-5.6
   *   accept it too). Derived from the provider's effort list once fetched.
   */
  maxEffort?: 'high' | 'xhigh' | 'max';
  /**
   * Whether the model supports the 'xhigh' effort tier.
   * Defaults to true when maxEffort is 'xhigh' or 'max'. Set to false for models
   * that jump from 'high' directly to 'max' (e.g., Opus 4.6).
   */
  supportsXhigh?: boolean;
  /** Not in the provider's latest model listing (kept so older selections still resolve). */
  legacy?: boolean;
  /** The provider's recommended default model. */
  isDefault?: boolean;
  /** Short aliases the provider resolves to this model (Claude: "opus", "sonnet"). */
  aliases?: string[];
}

// Snapshot used until the first live listing arrives.
export const BOOTSTRAP_CLAUDE_MODELS: ModelInfo[] = [
  {
    id: "claude-fable-5-1",
    label: "Fable 5.1",
    title: "Fable 5.1 - Most capable widely released model (1M context, adaptive thinking)",
    maxContextTokens: 1000000,
    supportsEffort: true,
    maxEffort: "max",
  },
  {
    id: "claude-fable-5",
    label: "Fable 5",
    title: "Fable 5 - Previous Fable generation (1M context, adaptive thinking)",
    maxContextTokens: 1000000,
    supportsEffort: true,
    maxEffort: "max",
  },
  {
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    title: "Opus 5.5 - Flagship for long-running agentic coding (1M context, adaptive thinking)",
    maxContextTokens: 1000000,
    supportsEffort: true,
    maxEffort: "max",
  },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    title: "Opus 5 - Previous flagship (1M context, adaptive thinking)",
    maxContextTokens: 1000000,
    supportsEffort: true,
    maxEffort: "max",
  },
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    title: "Opus 4.8 - Previous flagship (1M context)",
    maxContextTokens: 1000000,
    supportsEffort: true,
    maxEffort: "max",
  },
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    title: "Opus 4.7 - Previous flagship (1M context)",
    maxContextTokens: 1000000,
    supportsEffort: true,
    maxEffort: "max",
  },
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",
    title: "Opus 4.6 - Previous flagship (1M context)",
    maxContextTokens: 1000000,
    supportsEffort: true,
    maxEffort: "max",
    supportsXhigh: false,
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    title: "Sonnet 5 - Balanced performance (1M context, adaptive thinking)",
    maxContextTokens: 1000000,
    supportsEffort: true,
    maxEffort: "max",
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku",
    title: "Haiku 4.5 - Fastest model",
    maxContextTokens: 200000,
    supportsEffort: false,
  },
];

export const BOOTSTRAP_OPENAI_MODELS: ModelInfo[] = [
  {
    id: "gpt-6-astra",
    label: "6 Astra",
    title: "GPT-6 Astra - Most capable OpenAI model (1.05M context, effort up to max)",
    maxContextTokens: 1050000,
    supportsEffort: true,
    maxEffort: "max",
  },
  {
    id: "gpt-6-sol",
    label: "6 Sol",
    title: "GPT-6 Sol - Complex coding and agentic workflows (1.05M context, effort up to max)",
    maxContextTokens: 1050000,
    supportsEffort: true,
    maxEffort: "max",
  },
  {
    id: "gpt-6-luna",
    label: "6 Luna",
    title: "GPT-6 Luna - Fast, efficient model for focused tasks (1.05M context, effort up to max)",
    maxContextTokens: 1050000,
    supportsEffort: true,
    maxEffort: "max",
  },
  {
    id: "gpt-5.6-sol",
    label: "5.6 Sol",
    title: "GPT-5.6 Sol - Flagship model for the most complex tasks (1M context)",
    maxContextTokens: 1000000,
    supportsEffort: true,
    maxEffort: "max",
  },
  {
    id: "gpt-5.6-terra",
    label: "5.6 Terra",
    title: "GPT-5.6 Terra - Balanced everyday workhorse (1M context)",
    maxContextTokens: 1000000,
    supportsEffort: true,
    maxEffort: "max",
  },
  {
    id: "gpt-5.6-luna",
    label: "5.6 Luna",
    title: "GPT-5.6 Luna - Fast and affordable (1M context)",
    maxContextTokens: 1000000,
    supportsEffort: true,
    maxEffort: "max",
  },
  {
    id: "gpt-5.4",
    label: "5.4",
    title: "GPT-5.4 - Previous-generation agentic coding model",
    maxContextTokens: 400000,
    supportsEffort: true,
    maxEffort: "high",
  },
  {
    id: "gpt-5.3-codex-spark",
    label: "5.3 Spark",
    title: "GPT-5.3 Codex Spark - Near-instant real-time coding (Pro only)",
    maxContextTokens: 400000,
    supportsEffort: true,
    maxEffort: "high",
  },
  {
    id: "gpt-5.4-mini",
    label: "5.4 Mini",
    title: "GPT-5.4 Mini - Strong mini model for coding, computer use, and subagents",
    maxContextTokens: 400000,
    supportsEffort: true,
    maxEffort: "high",
  },
];

export const ALL_MODELS: ModelInfo[] = $state(BOOTSTRAP_CLAUDE_MODELS.map((m) => ({ ...m })));
export const OPENAI_MODELS: ModelInfo[] = $state(BOOTSTRAP_OPENAI_MODELS.map((m) => ({ ...m })));

/** A model entry as reported by the sidecar's `list_models`. */
export interface ListedModel {
  id: string;
  displayName: string;
  description: string;
  efforts: string[];
  defaultEffort?: string;
  isDefault?: boolean;
  legacy?: boolean;
  aliases?: string[];
  contextTokens?: number;
}

const UI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

function inferContextTokens(provider: "claude" | "openai", id: string): number {
  if (provider === "openai") {
    if (id.includes("gpt-6")) return 1050000;
    if (id.includes("gpt-5.6")) return 1000000;
    if (id.includes("gpt-5")) return 400000;
    return 200000;
  }
  return id.includes("haiku") ? 200000 : 1000000;
}

/** "GPT-6-Sol" → "6 Sol" (matches the compact labels used across the UI). */
function openAiLabel(displayName: string): string {
  return displayName.replace(/^GPT-/i, "").replace(/-/g, " ");
}

export function toModelInfo(provider: "claude" | "openai", m: ListedModel): ModelInfo {
  const known = (provider === "openai" ? BOOTSTRAP_OPENAI_MODELS : BOOTSTRAP_CLAUDE_MODELS).find(
    (b) => b.id === m.id,
  );
  const efforts = UI_EFFORTS.filter((e) => m.efforts.includes(e));
  const maxEffort = efforts.includes("max") ? "max" : efforts.includes("xhigh") ? "xhigh" : "high";
  return {
    id: m.id,
    label: provider === "openai" ? openAiLabel(m.displayName) : m.displayName,
    title: m.description ? `${m.displayName} - ${m.description}` : m.displayName,
    maxContextTokens: m.contextTokens ?? known?.maxContextTokens ?? inferContextTokens(provider, m.id),
    supportsEffort: efforts.length > 0,
    maxEffort: efforts.length > 0 ? maxEffort : undefined,
    supportsXhigh: efforts.includes("xhigh"),
    legacy: m.legacy || undefined,
    isDefault: m.isDefault || undefined,
    aliases: m.aliases,
  };
}

/**
 * Replace a provider's catalog with the listed models (provider order), then
 * append bootstrap models the listing no longer includes as `legacy` so saved
 * selections keep resolving.
 */
export function applyListedModels(provider: "claude" | "openai", listed: ListedModel[]): void {
  if (listed.length === 0) return;
  const target = provider === "openai" ? OPENAI_MODELS : ALL_MODELS;
  const bootstrap = provider === "openai" ? BOOTSTRAP_OPENAI_MODELS : BOOTSTRAP_CLAUDE_MODELS;
  const next = listed.map((m) => toModelInfo(provider, m));
  const ids = new Set(next.map((m) => m.id));
  for (const b of bootstrap) {
    if (!ids.has(b.id)) next.push({ ...b, legacy: true });
  }
  target.splice(0, target.length, ...next);
}
