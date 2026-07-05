<script lang="ts">
  import { onDestroy } from 'svelte';
  import { sdkSessions, type SdkSession } from '$lib/stores/sdkSessions';
  import { settings } from '$lib/stores/settings';

  interface Props {
    session: SdkSession;
  }

  let { session }: Props = $props();

  let busy = $state(false);
  // Local dismiss: hides the banner in this view without cancelling the parked
  // turn (used by the X and by rate-limit "Dismiss"). A real cancel of a scheduled
  // send goes through sdkSessions.clearRateLimited() — see handleCancel.
  let dismissed = $state(false);

  // Live countdown tick.
  let now = $state(Date.now());
  const timer = setInterval(() => {
    now = Date.now();
  }, 1000);
  onDestroy(() => clearInterval(timer));

  let rl = $derived(session.rateLimited);
  let reason = $derived(rl?.reason ?? 'rate_limit');
  // For a scheduled turn the target is targetStartAt; for a rate-limit turn prefer
  // the (possibly refreshed) targetStartAt, falling back to the event's resetsAt.
  let targetMs = $derived(
    reason === 'scheduled'
      ? rl?.targetStartAt
      : (rl?.targetStartAt ?? rl?.resetsAt),
  );
  let queueEnabled = $derived($settings.queue?.enabled ?? false);

  const WINDOW_LABELS: Record<string, string> = {
    '5h': '5-hour',
    '7d': 'weekly',
  };
  let windowLabel = $derived(rl?.window ? WINDOW_LABELS[rl.window] ?? rl.window : '');

  /** Format epoch-ms remaining as a compact countdown, e.g. "2h 15m" / "45s". */
  function formatMsRemaining(ms: number | undefined): string {
    if (ms == null) return '';
    const diff = ms - now;
    if (diff <= 0) return 'now';
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    const seconds = Math.floor((diff % 60_000) / 1000);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  let countdown = $derived(formatMsRemaining(targetMs));

  let title = $derived(
    reason === 'scheduled'
      ? `Scheduled to send${countdown ? ` in ${countdown}` : ''}`
      : `Rate limit reached${countdown ? ` — resets in ${countdown}` : ''}`,
  );

  let primaryLabel = $derived(reason === 'scheduled' ? 'Send now' : 'Continue now');

  async function handleContinue() {
    if (busy) return;
    busy = true;
    try {
      await sdkSessions.continueRateLimited(session.id);
    } catch (err) {
      console.error('[RateLimitBanner] Continue failed:', err);
    } finally {
      busy = false;
    }
  }

  // The labeled action button. For a scheduled turn "Cancel" truly cancels the
  // parked send (clears rateLimited + drops the pending bubble). For a rate-limit
  // turn "Dismiss" only hides the banner locally — the driver still auto-continues
  // the rejected turn when the window resets, which is the desired behavior.
  function handleCancel() {
    if (reason === 'scheduled') {
      sdkSessions.clearRateLimited(session.id);
    } else {
      dismissed = true;
    }
  }

  // The top-right X always just hides the banner in this view (never cancels a send).
  function handleDismiss() {
    dismissed = true;
  }
</script>

{#if rl && !dismissed}
  <div class="rate-limit-banner" class:scheduled={reason === 'scheduled'}>
    <div class="banner-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    </div>
    <div class="banner-body">
      <div class="banner-title">{title}</div>
      <div class="banner-text">
        {#if reason === 'scheduled'}
          This turn is parked and will send automatically at the next{windowLabel ? ` ${windowLabel}` : ''} window reset.
        {:else}
          {windowLabel ? `The ${windowLabel} usage window is exhausted. ` : ''}Your turn is saved and can be re-sent.
          {#if queueEnabled}
            It will continue automatically when the window resets.
          {/if}
        {/if}
      </div>
      <div class="banner-actions">
        <button
          class="banner-btn primary"
          onclick={handleContinue}
          disabled={busy}
          title={reason === 'scheduled' ? 'Send this turn now' : 'Re-send this turn now'}
        >
          {primaryLabel}
        </button>
        <button
          class="banner-btn"
          onclick={handleCancel}
          disabled={busy}
          title={reason === 'scheduled' ? 'Cancel this scheduled send' : 'Hide this banner'}
        >
          {reason === 'scheduled' ? 'Cancel' : 'Dismiss'}
        </button>
      </div>
    </div>
    <button
      class="banner-close"
      onclick={handleDismiss}
      title="Dismiss"
      aria-label="Dismiss"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  </div>
{/if}

<style>
  .rate-limit-banner {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    margin: 0.5rem 0.75rem;
    border: 1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 40%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--color-warning, #f59e0b) 10%, transparent);
    color: var(--color-text-primary);
  }

  .rate-limit-banner.scheduled {
    border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
    background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  }

  .banner-icon {
    flex-shrink: 0;
    color: var(--color-warning, #f59e0b);
    margin-top: 0.125rem;
  }

  .rate-limit-banner.scheduled .banner-icon {
    color: var(--color-accent);
  }

  .banner-icon svg {
    width: 20px;
    height: 20px;
  }

  .banner-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .banner-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-warning, #f59e0b);
  }

  .rate-limit-banner.scheduled .banner-title {
    color: var(--color-accent);
  }

  .banner-text {
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    line-height: 1.4;
  }

  .banner-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.25rem;
    flex-wrap: wrap;
  }

  .banner-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 500;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text-primary);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }

  .banner-btn:hover:not(:disabled) {
    background: var(--color-border);
  }

  .banner-btn.primary {
    border-color: color-mix(in srgb, var(--color-warning, #f59e0b) 50%, transparent);
    background: color-mix(in srgb, var(--color-warning, #f59e0b) 18%, transparent);
    color: var(--color-text-primary);
  }

  .banner-btn.primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-warning, #f59e0b) 28%, transparent);
  }

  .rate-limit-banner.scheduled .banner-btn.primary {
    border-color: color-mix(in srgb, var(--color-accent) 50%, transparent);
    background: color-mix(in srgb, var(--color-accent) 18%, transparent);
  }

  .rate-limit-banner.scheduled .banner-btn.primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-accent) 28%, transparent);
  }

  .banner-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .banner-close {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--color-text-muted);
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .banner-close:hover {
    background: color-mix(in srgb, var(--color-warning, #f59e0b) 15%, transparent);
    color: var(--color-text-primary);
  }

  .banner-close svg {
    width: 14px;
    height: 14px;
  }
</style>
