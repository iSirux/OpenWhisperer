<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { queuedCount, nextQueueResetAt, isDraining } from '$lib/stores/smartQueue';

  let count = $derived($queuedCount);
  let resetAt = $derived($nextQueueResetAt);
  let draining = $derived($isDraining);

  // Tick so the countdown stays fresh between store updates.
  let now = $state(Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
  });

  /** Countdown to an epoch-ms target, formatted like "2h 14m" / "3d 4h". */
  function formatMsRemaining(target: number | undefined, ref: number): string {
    if (target == null) return '';
    const diff = target - ref;
    if (diff <= 0) return 'now';
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  let countdown = $derived(formatMsRemaining(resetAt, now));
  let tooltip = $derived(
    draining
      ? 'Dispatching queued sessions…'
      : `${count} session${count === 1 ? '' : 's'} queued${countdown ? ` · next dispatch in ${countdown}` : ''}`
  );
</script>

{#if count > 0}
  <div class="indicator" class:draining title={tooltip}>
    <div class="row">
      {#if draining}
        <svg class="icon spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      {:else}
        <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h10" />
        </svg>
      {/if}
      <span class="val">{count}</span>
    </div>
    <div class="row sub">
      {#if draining}
        <span>launching…</span>
      {:else if countdown}
        <span>next in {countdown}</span>
      {:else}
        <span>queued</span>
      {/if}
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
    background: rgb(56 189 248 / 0.07);
    border: 1px solid rgb(56 189 248 / 0.25);
    transition: border-color 0.15s ease;
    white-space: nowrap;
  }

  .indicator.draining {
    border-color: rgb(56 189 248 / 0.6);
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
    color: rgb(56 189 248);
  }

  .val {
    font-weight: 600;
    color: rgb(56 189 248);
  }

  .spin {
    animation: queue-spin 1s linear infinite;
  }

  @keyframes queue-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
