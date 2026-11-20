<script lang="ts">
  import { throughput, formatTokensPerSec, THROUGHPUT_WINDOW_MS } from '$lib/stores/throughput';

  let snap = $derived($throughput);
  let visible = $derived(snap.windowTokens > 0);

  let tooltip = $derived.by(() => {
    const span = `last ${Math.round(THROUGHPUT_WINDOW_MS / 1000)}s`;
    const lines = [
      `Output throughput (${span}):${formatTokensPerSec(snap.tokensPerSec)} tok/s`,
      `${snap.windowTokens.toLocaleString()} output tokens across ${snap.activeSessions} session${snap.activeSessions === 1 ? '' : 's'}`,
    ];
    const { claude, openai } = snap.byProvider;
    if (claude > 0 && openai > 0) {
      lines.push(`Claude ${formatTokensPerSec(claude)} tok/s · Codex ${formatTokensPerSec(openai)} tok/s`);
    }
    lines.push('Counted per model call, so the rate updates in steps.');
    return lines.join('\n');
  });
</script>

{#if visible}
  <div class="indicator" title={tooltip}>
    <div class="row">
      <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
      <span class="val">{formatTokensPerSec(snap.tokensPerSec)}</span>
    </div>
    <div class="row sub">
      <span>tok/s{snap.activeSessions > 1 ? ` · ${snap.activeSessions}` : ''}</span>
    </div>
  </div>
{/if}

<style>
  .indicator {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0px;
    padding: 0px 6px;
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    background: rgb(167 139 250 / 0.07);
    border: 1px solid rgb(167 139 250 / 0.25);
    white-space: nowrap;
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

  .icon {
    width: 11px;
    height: 11px;
    color: rgb(167 139 250);
  }

  .val {
    font-weight: 600;
    color: rgb(167 139 250);
    font-variant-numeric: tabular-nums;
  }
</style>
