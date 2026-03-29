// Model color utilities for consistent color coding across the app
// Each model has a distinct color that follows the current theme

export type ModelType = 'opus' | 'sonnet' | 'haiku' | 'auto' | 'openai' | 'unknown';

export function getModelType(modelId: string): ModelType {
  if (modelId === 'auto') return 'auto';
  if (modelId.includes('opus')) return 'opus';
  if (modelId.includes('sonnet')) return 'sonnet';
  if (modelId.includes('haiku')) return 'haiku';
  // OpenAI models
  if (modelId.startsWith('codex') || modelId.startsWith('gpt-')) return 'openai';
  return 'unknown';
}

export function getShortModelName(model: string): string {
  if (model === 'auto') return 'Auto';
  if (model.includes('opus')) return 'Opus';
  if (model.includes('sonnet')) {
    return 'Sonnet';
  }
  if (model.includes('haiku')) return 'Haiku';
  // OpenAI models
  if (model.startsWith('codex-mini')) return 'Codex Mini';
  if (model.startsWith('codex')) return 'Codex';
  if (model === 'gpt-5.4' || model === 'gpt-5.4-codex') return '5.4';
  if (model === 'gpt-5-mini' || model === 'gpt-5.4-mini') return '5.4 Mini';
  if (model === 'gpt-5.3-codex-spark') return '5.3 Spark';
  if (model === 'gpt-5.3-codex') return '5.3 Codex';
  if (model === 'gpt-5.2-codex') return '5.2 Codex';
  if (model === 'gpt-5-codex') return '5 Codex';
  if (model.startsWith('gpt-')) return model;
  const parts = model.split('-');
  return parts[parts.length - 1] || model;
}

// Background colors for selected/active state - uses theme model colors
export function getModelBgColor(modelId: string): string {
  const type = getModelType(modelId);
  switch (type) {
    case 'auto': return 'bg-gradient-to-r from-purple-500 to-amber-500';
    case 'opus': return 'bg-model-opus';
    case 'sonnet': return 'bg-model-sonnet';
    case 'haiku': return 'bg-model-haiku';
    case 'openai': return 'bg-green-600';
    default: return 'bg-accent';
  }
}

// Lighter background colors for badges/pills - uses theme model colors
export function getModelBadgeBgColor(modelId: string): string {
  const type = getModelType(modelId);
  switch (type) {
    case 'auto': return 'bg-gradient-to-r from-purple-500/20 to-amber-500/20';
    case 'opus': return 'bg-model-opus/20';
    case 'sonnet': return 'bg-model-sonnet/20';
    case 'haiku': return 'bg-model-haiku/20';
    case 'openai': return 'bg-green-600/20';
    default: return 'bg-accent/20';
  }
}

// Text colors for badges/labels - uses theme model colors
export function getModelTextColor(modelId: string): string {
  const type = getModelType(modelId);
  switch (type) {
    case 'auto': return 'text-purple-400';
    case 'opus': return 'text-model-opus';
    case 'sonnet': return 'text-model-sonnet';
    case 'haiku': return 'text-model-haiku';
    case 'openai': return 'text-green-400';
    default: return 'text-accent';
  }
}

// Ring/border colors for focus states - uses theme model colors
export function getModelRingColor(modelId: string): string {
  const type = getModelType(modelId);
  switch (type) {
    case 'auto': return 'ring-purple-400';
    case 'opus': return 'ring-model-opus';
    case 'sonnet': return 'ring-model-sonnet';
    case 'haiku': return 'ring-model-haiku';
    case 'openai': return 'ring-green-400';
    default: return 'ring-accent';
  }
}

// Hover background colors for unselected buttons - uses theme model colors
export function getModelHoverBgColor(modelId: string): string {
  const type = getModelType(modelId);
  switch (type) {
    case 'auto': return 'hover:bg-purple-500/10';
    case 'opus': return 'hover:bg-model-opus/10';
    case 'sonnet': return 'hover:bg-model-sonnet/10';
    case 'haiku': return 'hover:bg-model-haiku/10';
    case 'openai': return 'hover:bg-green-600/10';
    default: return 'hover:bg-accent/10';
  }
}
