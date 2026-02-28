<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { rateLimits, rateLimitData, rateLimitError, codexRateLimits, codexRateLimitData, codexRateLimitError, calculatePace, formatTimeRemaining, registerVisibilityHandler } from '$lib/stores/rateLimits';
  import { goto } from '$app/navigation';

  let claude = $derived($rateLimitData);
  let codex = $derived($codexRateLimitData);
  let claudeError = $derived($rateLimitError);
  let codexError = $derived($codexRateLimitError);

  // Calculate paces per provider
  let claudePace5h = $derived(claude ? calculatePace(claude.five_hour.utilization, claude.five_hour.resets_at, 5) : null);
  let claudePace7d = $derived(claude ? calculatePace(claude.seven_day.utilization, claude.seven_day.resets_at, 168) : null);
  let codexPace5h = $derived(codex ? calculatePace(codex.five_hour.utilization, codex.five_hour.resets_at, 5) : null);
  let codexPace7d = $derived(codex ? calculatePace(codex.seven_day.utilization, codex.seven_day.resets_at, 168) : null);

  function paceLabel(paceRatio: number, utilization: number): string {
    if (utilization < 1) return 'idle';
    if (paceRatio >= 1.2) return 'ahead of linear pace';
    if (paceRatio <= 0.8) return 'behind linear pace';
    return 'on pace';
  }

  function formatResetAt(isoTimestamp: string): string {
    const resetDate = new Date(isoTimestamp);
    if (Number.isNaN(resetDate.getTime())) return 'at unknown time';

    const weekday = resetDate.toLocaleDateString(undefined, { weekday: 'long' });
    const time = resetDate.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    return `${weekday} at ${time}`;
  }

  function buildTooltip(
    data: typeof claude,
    pace5hData: typeof claudePace5h,
    pace7dData: typeof claudePace7d,
    name: 'Claude' | 'Codex',
    error: string | null = null
  ): string {
    if (!data) return '';
    const lines: string[] = [`${name} Rate Limits`];
    if (error) {
      lines.push('⚠ Data may be stale — last fetch failed');
      lines.push(error);
      lines.push('');
    }
    lines.push(
      `5h window: ${data.five_hour.utilization.toFixed(1)}% used, resets in ${formatTimeRemaining(data.five_hour.resets_at)}${pace5hData ? ` (${paceLabel(pace5hData.paceRatio, data.five_hour.utilization)})` : ''}`
    );
    lines.push(
      `7d window: ${data.seven_day.utilization.toFixed(1)}% used, resets ${formatResetAt(data.seven_day.resets_at)}${pace7dData ? ` (${paceLabel(pace7dData.paceRatio, data.seven_day.utilization)})` : ''}`
    );
    lines.push('');
    lines.push('Colors: green = low, white = on target, red = high');
    return lines.join('\n');
  }

  function getPaceColor(paceRatio: number, utilization: number): string {
    if (utilization < 1) return 'var(--color-text-muted)';
    if (paceRatio >= 1.2) return 'var(--color-error)';
    if (paceRatio <= 0.8) return 'var(--color-success)';
    return 'var(--color-text-primary)';
  }

  onMount(() => {
    rateLimits.startAutoRefresh();
    codexRateLimits.startAutoRefresh();
    registerVisibilityHandler();
  });

  onDestroy(() => {
    rateLimits.stopAutoRefresh();
    codexRateLimits.stopAutoRefresh();
  });
</script>

{#snippet providerIndicator(data: typeof claude, p5h: typeof claudePace5h, p7d: typeof claudePace7d, name: 'Claude' | 'Codex', error: string | null)}
  {#if data}
    <button
      class="indicator"
      class:indicator-claude={name === 'Claude'}
      class:indicator-codex={name === 'Codex'}
      class:indicator-stale={!!error}
      onclick={() => goto('/usage')}
      title={buildTooltip(data, p5h, p7d, name, error)}
    >
      <div class="row">
        <span class="val" style="color: {p5h ? getPaceColor(p5h.paceRatio, data.five_hour.utilization) : 'var(--color-text-secondary)'}">{Math.round(data.five_hour.utilization)}%</span>
        <span class="sep">·</span>
        <span class="val" style="color: {p7d ? getPaceColor(p7d.paceRatio, data.seven_day.utilization) : 'var(--color-text-secondary)'}">{Math.round(data.seven_day.utilization)}%</span>
        {#if error}<span class="stale-badge">!</span>{/if}
      </div>
      <div class="row sub">
        {#if error}
          <span class="stale-label">stale</span>
        {:else}
          <span>{formatTimeRemaining(data.five_hour.resets_at)}</span>
        {/if}
      </div>
    </button>
  {/if}
{/snippet}

{#if claude || codex}
  {@render providerIndicator(claude, claudePace5h, claudePace7d, 'Claude', claudeError)}
  {@render providerIndicator(codex, codexPace5h, codexPace7d, 'Codex', codexError)}
{/if}

<style>
  .indicator {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0px;
    padding: 0px 6px;
    border-radius: 4px;
    cursor: pointer;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    transition: border-color 0.15s ease;
    white-space: nowrap;
  }

  .indicator-claude {
    background: rgb(249 115 22 / 0.07);
    border-color: rgb(249 115 22 / 0.25);
  }

  .indicator-claude:hover {
    border-color: rgb(249 115 22 / 0.6);
  }

  .indicator-codex {
    background: rgb(34 197 94 / 0.07);
    border-color: rgb(34 197 94 / 0.25);
  }

  .indicator-codex:hover {
    border-color: rgb(34 197 94 / 0.6);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 3px;
    font-size: 10px;
  }

  .row.sub {
    font-size: 9px;
    color: var(--color-text-muted);
  }

  .val {
    font-weight: 600;
  }

  .sep {
    color: var(--color-text-muted);
    opacity: 0.5;
  }

  .indicator-stale {
    opacity: 0.5;
  }

  .stale-badge {
    font-size: 9px;
    font-weight: 700;
    color: var(--color-warning, #f59e0b);
    line-height: 1;
  }

  .stale-label {
    color: var(--color-warning, #f59e0b);
    font-style: italic;
  }

</style>
