<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import RepoSelector from '$lib/components/RepoSelector.svelte';
  import {
    spareTokens,
    evaluateBurn,
    type SpareTokensAggressiveness,
  } from '$lib/stores/spareTokens';
  import { SPARE_TOKENS_LIBRARY } from '$lib/spareTokens/library';
  import {
    rateLimitData,
    codexRateLimitData,
    formatTimeRemaining,
    calculatePace,
    type ProviderRateLimits,
  } from '$lib/stores/rateLimits';
  import { settings } from '$lib/stores/settings';
  import { repos, findRepoById } from '$lib/stores/repos';
  import { activeSdkSessionId } from '$lib/stores/sdkSessions';
  import { navigation } from '$lib/stores/navigation';
  import { formatRelativeTime } from '$lib/stores/usageStats';

  const SEVEN_DAY_HOURS = 24 * 7;
  const AGGRESSIVENESS: SpareTokensAggressiveness[] = ['conservative', 'normal', 'aggressive'];

  // A live tick so countdowns, pace, and burn evaluation stay fresh.
  let now = $state(Date.now());
  const tick = setInterval(() => (now = Date.now()), 30_000);
  onDestroy(() => clearInterval(tick));

  onMount(() => {
    repos.load();
  });

  const enabledProviders = $derived($settings.enabled_providers ?? { claude: true, openai: true });

  // One card per enabled provider with a fresh burn evaluation.
  const providerCards = $derived.by(() => {
    // Reference `now` so this recomputes on each tick.
    void now;
    const aggressiveness = $spareTokens.aggressiveness;
    const cards: Array<{
      key: 'claude' | 'openai';
      label: string;
      limits: ProviderRateLimits | null;
      burn: ReturnType<typeof evaluateBurn>;
    }> = [];
    if (enabledProviders.claude) {
      cards.push({
        key: 'claude',
        label: 'Claude',
        limits: $rateLimitData,
        burn: evaluateBurn($rateLimitData, aggressiveness, now),
      });
    }
    if (enabledProviders.openai) {
      cards.push({
        key: 'openai',
        label: 'Codex',
        limits: $codexRateLimitData,
        burn: evaluateBurn($codexRateLimitData, aggressiveness, now),
      });
    }
    return cards;
  });

  function itemState(promptId: string) {
    return (
      $spareTokens.items[promptId] ?? {
        autoEnabled: false,
        repoId: null,
        lastRunAt: null,
        lastRunWindow: null,
        lastRunSessionId: null,
      }
    );
  }

  // RepoSelector works in paths; map to/from the stored repoId.
  function repoPathFor(promptId: string): string {
    const repoId = itemState(promptId).repoId;
    if (!repoId) return '';
    return findRepoById($repos.list, repoId)?.path ?? '';
  }

  function handleRepoChange(promptId: string, cwd: string) {
    const repo = cwd ? $repos.list.find((r) => r.path === cwd) : null;
    spareTokens.updateItem(promptId, { repoId: repo?.id ?? null });
  }

  let runningId = $state<string | null>(null);

  async function handleRunNow(promptId: string) {
    if (runningId) return;
    runningId = promptId;
    try {
      const sessionId = await spareTokens.runNow(promptId);
      if (sessionId) {
        activeSdkSessionId.set(sessionId);
        navigation.showSessions();
      }
    } finally {
      runningId = null;
    }
  }

  function paceLabelFor(limits: ProviderRateLimits | null): string {
    if (!limits?.seven_day?.resets_at) return 'unknown';
    return calculatePace(limits.seven_day.utilization, limits.seven_day.resets_at, SEVEN_DAY_HOURS)
      .paceLabel;
  }
</script>

<div class="spare-page">
  <section class="card header-card">
    <div class="section-header section-header-top">
      <div>
        <h2>Spare Tokens</h2>
        <p>
          Spend leftover subscription capacity on high-value maintenance runs before it expires.
          Pin read-only prompts for auto mode, or run any prompt on demand.
        </p>
      </div>
      <label class="auto-toggle" title="Auto mode fires pinned read-only prompts when there's expiring headroom">
        <input
          type="checkbox"
          checked={$spareTokens.enabled}
          onchange={(e) => spareTokens.setEnabled((e.currentTarget as HTMLInputElement).checked)}
        />
        <span>Auto mode</span>
      </label>
    </div>

    <div class="field-inline">
      <span class="field-label">Aggressiveness</span>
      <div class="segmented-control" role="tablist" aria-label="Aggressiveness">
        {#each AGGRESSIVENESS as level}
          <button
            class="segment-btn"
            class:is-selected={$spareTokens.aggressiveness === level}
            onclick={() => spareTokens.setAggressiveness(level)}
          >
            {level}
          </button>
        {/each}
      </div>
    </div>
  </section>

  <section class="headroom-grid">
    {#each providerCards as card (card.key)}
      <div class="card headroom-card">
        <div class="headroom-head">
          <span class="provider-name">{card.label}</span>
          <span
            class="burn-tag"
            class:tier-prime={card.burn.tier === 'prime'}
            class:tier-okay={card.burn.tier === 'okay'}
            class:tier-none={card.burn.tier === null}
          >
            {card.burn.tier === 'prime'
              ? 'Burn window open'
              : card.burn.tier === 'okay'
                ? 'Leftover headroom'
                : 'Holding'}
          </span>
        </div>

        {#if card.limits}
          {@const windows = [
            { label: '5h', w: card.limits.five_hour },
            { label: '7d', w: card.limits.seven_day },
          ]}
          {#each windows as win}
            <div class="window-row">
              <div class="window-top">
                <span class="window-label">{win.label}</span>
                <span class="window-meta">
                  {Math.round(win.w.utilization)}% · resets in {formatTimeRemaining(win.w.resets_at)}
                  {#if win.label === '7d'}
                    · {paceLabelFor(card.limits)}
                  {/if}
                </span>
              </div>
              <div class="bar">
                <div
                  class="bar-fill"
                  class:bar-warn={win.w.utilization >= 85}
                  style="width: {Math.min(100, Math.max(0, win.w.utilization))}%"
                ></div>
              </div>
            </div>
          {/each}
        {:else}
          <p class="muted">Rate-limit data not loaded yet.</p>
        {/if}

        <p
          class="burn-reason"
          class:reason-prime={card.burn.tier === 'prime'}
          class:reason-okay={card.burn.tier === 'okay'}
        >
          {card.burn.reason}
        </p>
      </div>
    {/each}
    {#if providerCards.length === 0}
      <div class="card headroom-card">
        <p class="muted">No providers enabled. Enable Claude or Codex in Settings.</p>
      </div>
    {/if}
  </section>

  <section class="library">
    {#each SPARE_TOKENS_LIBRARY as prompt (prompt.id)}
      {@const state = itemState(prompt.id)}
      {@const canAuto = prompt.readOnly}
      <div class="card item-card">
        <div class="item-head">
          <div class="item-copy">
            <div class="item-title-row">
              <h3>{prompt.title}</h3>
              <div class="badges">
                <span class="badge">{prompt.appetite}</span>
                {#if prompt.fanOut}
                  <span class="badge badge-soft">fan-out</span>
                {/if}
                {#if !prompt.readOnly}
                  <span class="badge badge-write">writes code — runs in worktree</span>
                {/if}
              </div>
            </div>
            <p>{prompt.description}</p>
          </div>
          <button
            class="btn btn-primary"
            onclick={() => handleRunNow(prompt.id)}
            disabled={!state.repoId || runningId !== null}
            title={state.repoId ? 'Launch this prompt now' : 'Select a repository first'}
          >
            {runningId === prompt.id ? 'Launching…' : 'Run now'}
          </button>
        </div>

        <div class="item-controls">
          <div class="control-field">
            <span class="field-label">Repository</span>
            <RepoSelector
              cwd={repoPathFor(prompt.id)}
              onchange={(cwd) => handleRepoChange(prompt.id, cwd)}
              emptyOption="none"
              dropdownDirection="down"
            />
          </div>

          <label class="auto-toggle" class:is-disabled={!canAuto}>
            <input
              type="checkbox"
              checked={state.autoEnabled}
              disabled={!canAuto}
              onchange={(e) =>
                spareTokens.updateItem(prompt.id, {
                  autoEnabled: (e.currentTarget as HTMLInputElement).checked,
                })}
            />
            <span>Auto</span>
          </label>

          {#if state.lastRunAt}
            <span class="last-run">Last run {formatRelativeTime(state.lastRunAt)}</span>
          {/if}
        </div>

        {#if !canAuto}
          <p class="hint">Write task — Run now only (launched in a worktree); never auto-fired.</p>
        {:else if state.autoEnabled && !state.repoId}
          <p class="hint">Select a repository for auto mode to fire this prompt.</p>
        {/if}
      </div>
    {/each}
  </section>
</div>

<style>
  .spare-page {
    height: 100%;
    overflow-y: auto;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    background: var(--color-background);
    font-size: 0.8125rem;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem;
    border: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
    border-radius: 0.375rem;
    background: var(--color-surface-elevated);
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .section-header-top {
    align-items: center;
  }

  h2 {
    margin: 0;
    color: var(--color-text-primary);
    font-size: 0.95rem;
    font-weight: 600;
  }

  h3 {
    margin: 0;
    color: var(--color-text-primary);
    font-size: 0.85rem;
    font-weight: 600;
  }

  p {
    margin: 0;
    color: var(--color-text-muted);
    font-size: 0.75rem;
    line-height: 1.4;
  }

  .muted {
    color: var(--color-text-muted);
  }

  .field-inline {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .field-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text-secondary);
  }

  .segmented-control {
    display: inline-flex;
    gap: 0.25rem;
    padding: 0.2rem;
    border: 1px solid var(--color-border);
    border-radius: 0.375rem;
    background: var(--color-background);
  }

  .segment-btn {
    padding: 0.35rem 0.65rem;
    border: none;
    border-radius: 0.25rem;
    background: transparent;
    color: var(--color-text-secondary);
    font-weight: 500;
    font-size: 0.75rem;
    text-transform: capitalize;
    transition: background 0.16s ease, color 0.16s ease;
  }

  .segment-btn:hover {
    background: var(--color-surface-elevated);
    color: var(--color-text-primary);
  }

  .segment-btn.is-selected {
    background: color-mix(in srgb, var(--color-accent) 18%, var(--color-surface-elevated));
    color: var(--color-text-primary);
  }

  .auto-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text-secondary);
    cursor: pointer;
    white-space: nowrap;
  }

  .auto-toggle.is-disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .auto-toggle input {
    width: 0.9rem;
    height: 0.9rem;
    margin: 0;
    accent-color: var(--color-accent);
  }

  .headroom-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
  }

  .headroom-card {
    gap: 0.6rem;
  }

  .headroom-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }

  .provider-name {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--color-text-primary);
  }

  .burn-tag {
    font-size: 0.65rem;
    font-weight: 600;
    padding: 0.15rem 0.45rem;
    border-radius: 999px;
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
  }

  .burn-tag.tier-prime {
    color: rgb(34, 197, 94);
    border-color: color-mix(in srgb, rgb(34, 197, 94) 40%, var(--color-border));
    background: color-mix(in srgb, rgb(34, 197, 94) 12%, transparent);
  }

  .burn-tag.tier-okay {
    color: rgb(245, 158, 11);
    border-color: color-mix(in srgb, rgb(245, 158, 11) 40%, var(--color-border));
    background: color-mix(in srgb, rgb(245, 158, 11) 12%, transparent);
  }

  .window-row {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .window-top {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
  }

  .window-label {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--color-text-secondary);
  }

  .window-meta {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
  }

  .bar {
    height: 0.4rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-border) 70%, transparent);
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    border-radius: 999px;
    background: var(--color-accent);
    transition: width 0.3s ease;
  }

  .bar-fill.bar-warn {
    background: rgb(245, 158, 11);
  }

  .burn-reason {
    font-size: 0.7rem;
    line-height: 1.4;
  }

  .reason-prime {
    color: rgb(34, 197, 94);
  }

  .reason-okay {
    color: rgb(245, 158, 11);
  }

  .library {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .item-card {
    gap: 0.6rem;
  }

  .item-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .item-copy {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .item-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .badges {
    display: inline-flex;
    gap: 0.35rem;
    flex-wrap: wrap;
  }

  .badge {
    font-size: 0.65rem;
    font-weight: 500;
    padding: 0.12rem 0.4rem;
    border-radius: 0.375rem;
    border: 1px solid color-mix(in srgb, var(--color-accent) 20%, var(--color-border));
    background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
    color: var(--color-text-secondary);
    text-transform: capitalize;
  }

  .badge-soft {
    background: color-mix(in srgb, var(--color-surface) 75%, transparent);
    border-color: var(--color-border);
    color: var(--color-text-muted);
  }

  .badge-write {
    color: rgb(245, 158, 11);
    border-color: color-mix(in srgb, rgb(245, 158, 11) 35%, var(--color-border));
    background: color-mix(in srgb, rgb(245, 158, 11) 10%, transparent);
    text-transform: none;
  }

  .item-controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .control-field {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .last-run {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    margin-left: auto;
  }

  .hint {
    font-size: 0.7rem;
    color: var(--color-text-muted);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    padding: 0.45rem 0.7rem;
    border: 1px solid var(--color-border);
    border-radius: 0.375rem;
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
    font-weight: 500;
    font-size: 0.75rem;
    flex-shrink: 0;
    transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
  }

  .btn-primary {
    background: var(--color-accent);
    color: white;
    border-color: color-mix(in srgb, var(--color-accent) 70%, black 10%);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
    color: white;
  }

  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  @media (max-width: 720px) {
    .headroom-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
