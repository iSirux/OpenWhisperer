<script lang="ts">
  import type { SdkSessionUsage } from '$lib/stores/sdkSessions';
  import { formatTokens, formatCost } from '$lib/stores/usageStats';

  let { usage, isQuerying = false, showCost = true }: { usage: SdkSessionUsage; isQuerying?: boolean; showCost?: boolean } = $props();

  let liveInputTokens = $derived(usage.totalInputTokens + usage.progressiveInputTokens);
  let liveOutputTokens = $derived(usage.totalOutputTokens + usage.progressiveOutputTokens);
  let liveCacheReadTokens = $derived(usage.totalCacheReadTokens + usage.progressiveCacheReadTokens);
  let contextPercent = $derived(usage.contextUsagePercent ?? 0);
</script>

<div class="session-header">
  <div class="usage-bar" class:querying={isQuerying}>
    <div class="usage-stats">
      <span class="usage-stat" class:live={isQuerying && usage.progressiveInputTokens > 0} title="Input tokens{isQuerying && usage.progressiveInputTokens > 0 ? ' (live)' : ''}">
        <svg class="usage-icon" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 8a.5.5 0 0 1 .5-.5h5.793L8.146 5.354a.5.5 0 1 1 .708-.708l3 3a.5.5 0 0 1 0 .708l-3 3a.5.5 0 0 1-.708-.708L10.293 8.5H4.5A.5.5 0 0 1 4 8z"/>
        </svg>
        {formatTokens(liveInputTokens)}
      </span>
      <span class="usage-stat" class:live={isQuerying && usage.progressiveOutputTokens > 0} title="Output tokens{isQuerying && usage.progressiveOutputTokens > 0 ? ' (live)' : ''}">
        <svg class="usage-icon" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12 8a.5.5 0 0 1-.5.5H5.707l2.147 2.146a.5.5 0 0 1-.708.708l-3-3a.5.5 0 0 1 0-.708l3-3a.5.5 0 1 1 .708.708L5.707 7.5H11.5a.5.5 0 0 1 .5.5z"/>
        </svg>
        {formatTokens(liveOutputTokens)}
      </span>
      {#if liveCacheReadTokens > 0}
        <span class="usage-stat cache" class:live={isQuerying && usage.progressiveCacheReadTokens > 0} title="Cache read tokens (reduced cost){isQuerying && usage.progressiveCacheReadTokens > 0 ? ' (live)' : ''}">
          <svg class="usage-icon" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm.93-9.412-1 4.705c-.07.34.029.533.304.533.194 0 .487-.07.686-.246l-.088.416c-.287.346-.92.598-1.465.598-.703 0-1.002-.422-.808-1.319l.738-3.468c.064-.293.006-.399-.287-.47l-.451-.081.082-.381 2.29-.287zM8 5.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/>
          </svg>
          {formatTokens(liveCacheReadTokens)}
        </span>
      {/if}
      {#if showCost && usage.totalCostUsd > 0}
        <span class="usage-stat cost" title="Total cost">
          {formatCost(usage.totalCostUsd)}
        </span>
      {/if}
    </div>
    <div class="context-bar-container" title="Context usage: {contextPercent.toFixed(1)}% of {formatTokens(usage.contextWindow ?? 0)}">
      <div class="context-bar-bg">
        <div
          class="context-bar-fill"
          class:warning={contextPercent > 70}
          class:danger={contextPercent > 90}
          class:live={isQuerying && (usage.progressiveInputTokens > 0 || usage.progressiveOutputTokens > 0)}
          style="width: {Math.min(100, contextPercent)}%"
        ></div>
      </div>
      <span class="context-percent">{contextPercent.toFixed(0)}%</span>
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

  .usage-stats {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-shrink: 0;
  }

  .usage-stat {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    color: var(--color-text-secondary);
    font-size: 0.75rem;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  }

  .usage-stat.cache {
    color: var(--color-success);
  }

  .usage-stat.cost {
    color: var(--color-warning);
    font-weight: 600;
  }

  .usage-icon {
    width: 12px;
    height: 12px;
    opacity: 0.7;
  }

  .context-bar-container {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
  }

  .context-bar-bg {
    flex: 1;
    height: 6px;
    background: var(--color-surface-elevated);
    border-radius: 3px;
    overflow: hidden;
  }

  .context-bar-fill {
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

  .usage-stat.live {
    color: var(--color-accent-hover);
    animation: pulse-value 1.5s ease-in-out infinite;
  }

  .usage-stat.cache.live {
    color: color-mix(in srgb, var(--color-success) 80%, white);
  }

  .context-bar-fill.live {
    animation: pulse-bar 1.5s ease-in-out infinite;
  }

  @keyframes pulse-value {
    0%, 100% {
      opacity: 1;
    }
    50% {
      opacity: 0.7;
    }
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
    min-width: 32px;
    text-align: right;
  }
</style>
