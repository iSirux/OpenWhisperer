<script lang="ts">
  import type { SdkSessionUsage } from '$lib/stores/sdkSessions';
  import { formatTokens } from '$lib/stores/usageStats';

  let { usage, isQuerying = false }: { usage: SdkSessionUsage; isQuerying?: boolean } = $props();

  let contextPercent = $derived(usage.contextUsagePercent ?? 0);
</script>

<div class="session-header">
  <div class="usage-bar" class:querying={isQuerying}>
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
    min-width: 32px;
    text-align: right;
  }
</style>
