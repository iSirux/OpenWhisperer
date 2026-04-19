<script lang="ts">
  import type { SdkSessionUsage } from '$lib/stores/sdkSessions';
  import { formatTokens } from '$lib/stores/usageStats';

  function formatTokensCompact(tokens: number): string {
    if (tokens < 1000) return `${tokens}`;
    if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}K`;
    const m = tokens / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }

  let {
    usage,
    isQuerying = false,
    /** Size of the reserved auto-compaction buffer in tokens. Renders a striped zone on the right
     *  equal to buffer/contextWindow. null = no stripe (auto-compact disabled or non-Claude session).
     *  Claude Code hardcodes this at ~33000 tokens (the reason the default threshold sits at ~83.5%
     *  on a 200K window; the override is clamped to this default, so this buffer IS the optimum). */
    autocompactBufferTokens = null,
  }: {
    usage: SdkSessionUsage;
    isQuerying?: boolean;
    autocompactBufferTokens?: number | null;
  } = $props();

  const LEGACY_CONTEXT_LIMIT = 200000;
  let contextPercent = $derived(usage.contextUsagePercent ?? 0);
  let contextWindow = $derived(usage.contextWindow ?? LEGACY_CONTEXT_LIMIT);

  let autocompactThresholdPercent = $derived.by(() => {
    if (autocompactBufferTokens === null || autocompactBufferTokens <= 0) return null;
    if (contextWindow <= 0) return null;
    const pct = 100 - (autocompactBufferTokens / contextWindow) * 100;
    if (pct <= 0 || pct >= 100) return null;
    return pct;
  });
  let currentContextTokens = $derived(Math.round((contextPercent / 100) * contextWindow));

  let markerTokens = $derived.by(() => {
    const contextWindow = usage.contextWindow ?? LEGACY_CONTEXT_LIMIT;
    const markerStep = contextWindow > LEGACY_CONTEXT_LIMIT ? LEGACY_CONTEXT_LIMIT : 0;
    if (markerStep === 0) return [];

    const markers: Array<{ tokens: number; leftPercent: number; isLegacy: boolean }> = [];
    for (let tokens = markerStep; tokens < contextWindow; tokens += markerStep) {
      markers.push({
        tokens,
        leftPercent: (tokens / contextWindow) * 100,
        isLegacy: tokens === LEGACY_CONTEXT_LIMIT
      });
    }
    return markers;
  });
</script>

<div class="session-header">
  <div class="usage-bar" class:querying={isQuerying}>
    <div class="context-bar-container" title="Context usage: {contextPercent.toFixed(1)}% of {formatTokens(usage.contextWindow ?? 0)}">
      <div class="context-bar-bg">
        {#if autocompactThresholdPercent !== null && autocompactBufferTokens}
          <div
            class="context-bar-autocompact-zone"
            style="left: {autocompactThresholdPercent}%; width: {100 - autocompactThresholdPercent}%"
            title={`Auto-compaction fires at ${autocompactThresholdPercent.toFixed(1)}% (${formatTokensCompact(autocompactBufferTokens)} buffer reserved for summarization).`}
          ></div>
        {/if}
        {#each markerTokens as marker (marker.tokens)}
          <div
            class="context-bar-marker"
            class:legacy={marker.isLegacy}
            style="left: {marker.leftPercent}%"
            title={marker.isLegacy ? `Legacy limit: ${formatTokens(marker.tokens)}` : formatTokens(marker.tokens)}
          ></div>
        {/each}
        <div
          class="context-bar-fill"
          class:warning={contextPercent > 70}
          class:danger={contextPercent > 90}
          class:live={isQuerying && (usage.progressiveInputTokens > 0 || usage.progressiveOutputTokens > 0)}
          style="width: {Math.min(100, contextPercent)}%"
        ></div>
      </div>
      <span class="context-percent">{contextPercent.toFixed(0)}% <span class="context-tokens">{formatTokensCompact(currentContextTokens)}/{formatTokensCompact(contextWindow)}</span></span>
    </div>
  </div>
</div>

<style>
  .session-header {
    position: sticky;
    top: 0;
    z-index: 10;
    padding: 0.5rem 1rem;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    font-size: 0.85rem;
  }

  .usage-bar {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .context-bar-container {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
  }

  .context-bar-bg {
    position: relative;
    flex: 1;
    height: 6px;
    background: var(--color-surface-elevated);
    border-radius: 3px;
    overflow: hidden;
  }

  .context-bar-marker {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: color-mix(in srgb, var(--color-text-muted) 50%, transparent);
    transform: translateX(-0.5px);
    z-index: 1;
    pointer-events: none;
  }

  .context-bar-autocompact-zone {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 0;
    pointer-events: auto;
    background-image: repeating-linear-gradient(
      135deg,
      color-mix(in srgb, var(--color-warning) 35%, transparent) 0,
      color-mix(in srgb, var(--color-warning) 35%, transparent) 3px,
      transparent 3px,
      transparent 6px
    );
    border-left: 1px dashed color-mix(in srgb, var(--color-warning) 70%, transparent);
  }

  .context-bar-marker.legacy {
    background: color-mix(in srgb, var(--color-warning) 75%, white 10%);
  }

  .context-bar-fill {
    position: relative;
    z-index: 0;
    height: 100%;
    background: var(--color-accent);
    border-radius: 3px;
    transition: width 0.3s ease, background 0.3s ease;
  }

  .context-bar-fill.warning {
    background: var(--color-warning);
  }

  .context-bar-fill.danger {
    background: var(--color-error);
  }

  .usage-bar.querying {
    border-color: var(--color-accent);
  }

  .context-bar-fill.live {
    animation: pulse-bar 1.5s ease-in-out infinite;
  }

  @keyframes pulse-bar {
    0%, 100% {
      opacity: 1;
    }
    50% {
      opacity: 0.8;
    }
  }

  .context-percent {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    font-weight: 500;
    text-align: right;
    white-space: nowrap;
  }

  .context-tokens {
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
    margin-left: 0.25rem;
  }
</style>
