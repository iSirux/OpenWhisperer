<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { rateLimits, rateLimitData, codexRateLimits, codexRateLimitData, calculatePace, formatTimeRemaining, registerVisibilityHandler } from '$lib/stores/rateLimits';
  import { settings } from '$lib/stores/settings';
  import { goto } from '$app/navigation';

  let claude = $derived($rateLimitData);
  let codex = $derived($codexRateLimitData);

  // Calculate paces per provider
  let claudePace5h = $derived(claude ? calculatePace(claude.five_hour.utilization, claude.five_hour.resets_at, 5) : null);
  let claudePace7d = $derived(claude ? calculatePace(claude.seven_day.utilization, claude.seven_day.resets_at, 168) : null);
  let codexPace5h = $derived(codex ? calculatePace(codex.five_hour.utilization, codex.five_hour.resets_at, 5) : null);
  let codexPace7d = $derived(codex ? calculatePace(codex.seven_day.utilization, codex.seven_day.resets_at, 168) : null);

  // Keep rl/pace aliases for tooltip compatibility
  let provider = $derived($settings.sdk_provider);
  let rl = $derived(provider === 'OpenAI' ? codex : claude);
  let label = $derived(provider === 'OpenAI' ? 'Codex' : 'Claude');
  let pace5h = $derived(provider === 'OpenAI' ? codexPace5h : claudePace5h);
  let pace7d = $derived(provider === 'OpenAI' ? codexPace7d : claudePace7d);
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

{#snippet providerIndicator(data: typeof rl, p5h: typeof pace5h, p7d: typeof pace7d, name: string)}
  {#if data}
    <button
      class="indicator"
      class:indicator-claude={name === 'Claude'}
      class:indicator-codex={name === 'Codex'}
      onclick={() => goto('/usage')}
      title={tooltip()}
    >

      <div class="row">
        <span class="val" style="color: {p5h ? getPaceColor(p5h.paceRatio, data.five_hour.utilization) : 'var(--color-text-secondary)'}">{Math.round(data.five_hour.utilization)}%</span>
        <span class="sep">·</span>
        <span class="val" style="color: {p7d ? getPaceColor(p7d.paceRatio, data.seven_day.utilization) : 'var(--color-text-secondary)'}">{Math.round(data.seven_day.utilization)}%</span>
      </div>
      <div class="row sub">
        <span>{formatTimeRemaining(data.five_hour.resets_at)}</span>
      </div>
    </button>
  {/if}
{/snippet}

{#if claude || codex}
  {@render providerIndicator(claude, claudePace5h, claudePace7d, 'Claude')}
  {@render providerIndicator(codex, codexPace5h, codexPace7d, 'Codex')}
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

</style>
