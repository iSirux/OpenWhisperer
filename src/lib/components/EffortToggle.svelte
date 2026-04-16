<script lang="ts">
  import type { EffortLevel } from "$lib/stores/sdkSessions";
  import { normalizeAutoModelEffort, type AutoModelEffort } from "$lib/stores/settings";
  import { modelSupportsEffort, getMaxEffort } from "$lib/utils/models";
  import { normalizeEffortLevel } from "$lib/stores/sdkSessions";

  interface Props {
    effortLevel: EffortLevel;
    onchange: (level: EffortLevel) => void;
    modelId?: string;
    size?: "sm" | "md";
    /** Whether the current model is "auto" */
    isAutoModel?: boolean;
    /** The auto model effort setting (only used when isAutoModel is true) */
    autoModelEffort?: AutoModelEffort;
    /** Callback to change the auto model effort setting */
    onChangeAutoModelEffort?: (setting: AutoModelEffort) => void;
  }

  let {
    effortLevel,
    onchange,
    modelId = "",
    size = "sm",
    isAutoModel = false,
    autoModelEffort = "dynamic",
    onChangeAutoModelEffort,
  }: Props = $props();

  // Determine if the toggle should be shown
  const shouldShow = $derived(isAutoModel || !modelId || modelSupportsEffort(modelId));

  // Determine max dots based on model
  const maxLevel = $derived.by(() => {
    if (isAutoModel) return 'high' as const; // Auto doesn't support max
    if (!modelId) return 'high' as const;
    return getMaxEffort(modelId);
  });

  const dotCount = $derived(maxLevel === 'max' ? 5 : maxLevel === 'xhigh' ? 4 : 3);

  // Map effort level to a numeric value for dot filling
  const LEVEL_VALUES: Record<string, number> = {
    off: 0,
    low: 1,
    medium: 2,
    high: 3,
    xhigh: 4,
    max: 5,
    dynamic: -1,
  };

  // Determine display state
  const displayMode = $derived.by(() => {
    if (isAutoModel) {
      return normalizeAutoModelEffort(autoModelEffort);
    }
    return normalizeEffortLevel(effortLevel);
  });

  const filledDots = $derived.by(() => {
    const val = LEVEL_VALUES[displayMode] ?? 0;
    return val;
  });

  const isDynamic = $derived(displayMode === 'dynamic');

  // Cycle order for effort levels
  const cycleOrder = $derived.by((): string[] => {
    if (isAutoModel) {
      return ['low', 'medium', 'high', 'dynamic'];
    }
    const levels = ['low', 'medium', 'high'];
    if (maxLevel === 'xhigh' || maxLevel === 'max') levels.push('xhigh');
    if (maxLevel === 'max') levels.push('max');
    return levels;
  });

  function cycle() {
    if (isAutoModel && onChangeAutoModelEffort) {
      const currentIndex = cycleOrder.indexOf(autoModelEffort);
      const nextIndex = (currentIndex + 1) % cycleOrder.length;
      onChangeAutoModelEffort(cycleOrder[nextIndex] as AutoModelEffort);
    } else {
      const currentVal = normalizeEffortLevel(effortLevel);
      const currentIndex = cycleOrder.indexOf(currentVal);
      const nextIndex = (currentIndex + 1) % cycleOrder.length;
      const next = cycleOrder[nextIndex];
      onchange(next as EffortLevel);
    }
  }

  const buttonTitle = $derived.by(() => {
    if (isDynamic) return "Effort: Dynamic (AI decides) - click to cycle";
    const labels: Record<string, string> = {
      low: "Effort: Low",
      medium: "Effort: Medium",
      high: "Effort: High",
      xhigh: "Effort: Extra High",
      max: "Effort: Max",
    };
    return `${labels[displayMode] || 'Effort: Low'} - click to cycle`;
  });

  const displayLabel = $derived.by(() => {
    if (isDynamic) return "Dynamic";
    const labels: Record<string, string> = {
      low: "Low",
      medium: "Med",
      high: "High",
      xhigh: "XHigh",
      max: "Max",
    };
    return labels[displayMode] || "Low";
  });

  const sizeClasses = {
    sm: "px-1.5 py-0.5 text-[10px] gap-1",
    md: "px-2.5 py-1 text-xs gap-1.5",
  };

  const dotSizes = {
    sm: 5,
    md: 6,
  };
</script>

{#if shouldShow}
  <button
    class="effort-toggle flex items-center rounded font-medium transition-all {sizeClasses[size]}
      {isDynamic
        ? 'bg-violet-600 text-white shadow-md ring-1 ring-violet-500/50'
        : filledDots > 0
          ? 'bg-cyan-600/90 text-white shadow-md ring-1 ring-cyan-500/50'
          : 'bg-surface-elevated text-text-secondary hover:bg-cyan-500/20'}"
    onclick={cycle}
    title={buttonTitle}
  >
    <span class="flex items-center gap-[3px]">
      {#each Array(dotCount) as _, i}
        {@const dotSize = dotSizes[size]}
        {#if isDynamic}
          <svg width={dotSize} height={dotSize} viewBox="0 0 10 10">
            <circle cx="5" cy="5" r="4" fill="currentColor" opacity="0.7" />
          </svg>
        {:else if i < filledDots}
          <svg width={dotSize} height={dotSize} viewBox="0 0 10 10">
            <circle cx="5" cy="5" r="4" fill="currentColor" />
          </svg>
        {:else}
          <svg width={dotSize} height={dotSize} viewBox="0 0 10 10">
            <circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" stroke-width="1" opacity="0.4" />
          </svg>
        {/if}
      {/each}
    </span>
    <span>{displayLabel}</span>
  </button>
{/if}
