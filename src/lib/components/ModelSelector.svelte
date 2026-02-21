<script lang="ts">
  import {
    getModelBgColor,
    getModelRingColor,
    getModelHoverBgColor,
  } from "$lib/utils/modelColors";
  import { getEnabledModelsWithAuto, getEnabledModels, isAutoModel, type SdkProvider } from "$lib/utils/models";
  import { settings } from "$lib/stores/settings";

  interface Props {
    model: string;
    onchange: (model: string) => void;
    size?: "sm" | "md";
    provider?: SdkProvider;
  }

  let { model, onchange, size = "sm", provider = "claude" }: Props = $props();

  // Check if smart model selection feature is enabled
  const isSmartModelEnabled = $derived(
    $settings.llm?.enabled && $settings.llm?.features?.recommend_model
  );

  // Get enabled models - Auto is shown for Claude, plain list for OpenAI
  const models = $derived(
    provider === "openai"
      ? getEnabledModels($settings.enabled_openai_models, "openai")
      : getEnabledModelsWithAuto($settings.enabled_models)
  );

  const sizeClasses = {
    sm: "px-2 py-0.5 text-[10px]",
    md: "px-3 py-1 text-xs",
  };

  function handleModelClick(id: string) {
    if (isAutoModel(id) && !isSmartModelEnabled) {
      // Navigate to settings to enable the feature
      window.dispatchEvent(new CustomEvent('open-settings', { detail: { tab: 'gemini' } }));
      return;
    }
    onchange(id);
  }

  function getButtonClasses(id: string, isSelected: boolean): string {
    const base = `rounded font-medium transition-all ${sizeClasses[size]}`;

    // Auto model when not enabled - show as disabled/muted
    if (isAutoModel(id) && !isSmartModelEnabled) {
      return `${base} text-text-muted hover:text-text-secondary hover:bg-surface-elevated`;
    }

    if (isSelected) {
      // Auto model gets a special gradient
      if (isAutoModel(id)) {
        return `${base} bg-gradient-to-r from-purple-500 to-amber-500 text-white shadow-md ring-2 ring-purple-400 ring-opacity-50 scale-105`;
      }
      return `${base} ${getModelBgColor(id)} text-white shadow-md ring-2 ${getModelRingColor(id)} ring-opacity-50 scale-105`;
    }

    // Auto model hover state
    if (isAutoModel(id)) {
      return `${base} text-text-secondary hover:bg-gradient-to-r hover:from-purple-500/20 hover:to-amber-500/20`;
    }

    return `${base} text-text-secondary ${getModelHoverBgColor(id)}`;
  }

  function getButtonTitle(id: string, originalTitle: string): string {
    if (isAutoModel(id) && !isSmartModelEnabled) {
      return "Click to enable Smart Model Selection in Gemini settings";
    }
    return originalTitle;
  }
</script>

<div class="flex items-center gap-0.5 px-1.5 py-0.5 bg-surface-elevated rounded">
  {#each models as { id, label, title }}
    <button
      class={getButtonClasses(id, model === id)}
      onclick={() => handleModelClick(id)}
      title={getButtonTitle(id, title)}
    >
      {label}
    </button>
  {/each}
</div>
