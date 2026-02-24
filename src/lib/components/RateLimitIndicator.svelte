<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { rateLimits, rateLimitData, codexRateLimits, codexRateLimitData, calculatePace, formatTimeRemaining, registerVisibilityHandler } from '$lib/stores/rateLimits';
  import { settings } from '$lib/stores/settings';
  import { goto } from '$app/navigation';

  let claude = $derived($rateLimitData);
  let codex = $derived($codexRateLimitData);
  let provider = $derived($settings.sdk_provider);

  // Pick the active provider's data
  let rl = $derived(provider === 'OpenAI' ? codex : claude);
  let label = $derived(provider === 'OpenAI' ? 'Codex' : 'Claude');

  // Calculate paces for color coding (active provider)
  let pace5h = $derived(rl ? calculatePace(rl.five_hour.utilization, rl.five_hour.resets_at, 5) : null);
  let pace7d = $derived(rl ? calculatePace(rl.seven_day.utilization, rl.seven_day.resets_at, 168) : null);

  // Calculate paces for alt provider
  let altPace5h = $derived(alt ? calculatePace(alt.five_hour.utilization, alt.five_hour.resets_at, 5) : null);
  let altPace7d = $derived(alt ? calculatePace(alt.seven_day.utilization, alt.seven_day.resets_at, 168) : null);

  // Show the secondary provider's data if available
  let alt = $derived(provider === 'OpenAI' ? claude : codex);
  let altLabel = $derived(provider === 'OpenAI' ? 'Claude' : 'Codex');

  function paceLabel(paceRatio: number, utilization: number): string {
    if (utilization < 1) return 'idle';
    if (paceRatio >= 1.2) return 'ahead of linear pace';
    if (paceRatio <= 0.8) return 'behind linear pace';
    return 'on pace';
  }

  let tooltip = $derived(() => {
    if (!rl) return '';
    const lines: string[] = [`${label} Rate Limits`];
    lines.push(`5h window: ${rl.five_hour.utilization.toFixed(1)}% used, resets in ${formatTimeRemaining(rl.five_hour.resets_at)}`);
    lines.push(`7d window: ${rl.seven_day.utilization.toFixed(1)}% used, resets in ${formatTimeRemaining(rl.seven_day.resets_at)}${pace7d ? ` (${paceLabel(pace7d.paceRatio, rl.seven_day.utilization)})` : ''}`);
    if (alt) {
      lines.push('');
      lines.push(`${altLabel} Rate Limits`);
      lines.push(`5h: ${alt.five_hour.utilization.toFixed(1)}% | 7d: ${alt.seven_day.utilization.toFixed(1)}%`);
    }
    lines.push('');
    lines.push('Colors: green = low, white = on target, red = high');
    return lines.join('\n');
  });

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

{#if rl}
  <button
    class="indicator"
    onclick={() => goto('/usage')}
    title={tooltip()}
  >
    <div class="row">
      <span class="val" style="color: {pace5h ? getPaceColor(pace5h.paceRatio, rl.five_hour.utilization) : 'var(--color-text-secondary)'}">{Math.round(rl.five_hour.utilization)}%</span>
      <span class="sep">·</span>
      <span class="val" style="color: {pace7d ? getPaceColor(pace7d.paceRatio, rl.seven_day.utilization) : 'var(--color-text-secondary)'}">{Math.round(rl.seven_day.utilization)}%</span>
    </div>
    <div class="row sub">
      <span>{formatTimeRemaining(rl.five_hour.resets_at)}</span>
    </div>
  </button>
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

  .indicator:hover {
    border-color: var(--color-accent);
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
</style>
