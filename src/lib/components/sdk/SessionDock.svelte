<script lang="ts">
  import PrPanel from './PrPanel.svelte';
  import ValidationPanel from './ValidationPanel.svelte';
  import type { SdkSession } from '$lib/stores/sdkSessions';
  import type { SessionPrEntry } from '$lib/stores/sessionPrs';
  import type { ValidationRunView } from '$lib/stores/validation';
  import type { RepoConfig } from '$lib/stores/repos';

  let {
    session,
    prEntry,
    validationRun,
    repo,
  }: {
    session: SdkSession;
    /** Only passed when the PR panel is open for this session. */
    prEntry?: SessionPrEntry;
    /** Only passed when the validation panel is open for this session. */
    validationRun?: ValidationRunView;
    repo?: RepoConfig;
  } = $props();

  type DockView = 'pr' | 'validation';

  let hasPr = $derived(!!prEntry);
  let hasValidation = $derived(!!validationRun);

  let active = $state<DockView>('pr');

  // View selection is transition-driven: a view APPEARING while the dock is
  // open means the user (PR badge click) or the pipeline (run start / new
  // gate) just asked for it. Plain non-reactive trackers hold the previous
  // values across effect runs; null marks the first run, where the dock picks
  // its opening view instead (a parked gate outranks the PR view; otherwise
  // PR wins — it only appears via an explicit click).
  let prevPr: boolean | null = null;
  let prevValidation: boolean | null = null;
  let prevGate: boolean | null = null;
  $effect(() => {
    const pr = hasPr;
    const val = hasValidation;
    const gated = validationRun?.status === 'gate';

    if (prevPr === null) {
      active = val && (gated || !pr) ? 'validation' : 'pr';
    } else {
      if (pr && !prevPr) active = 'pr';
      if (val && !prevValidation) active = 'validation';
      if (gated && !prevGate) active = 'validation';
    }
    prevPr = pr;
    prevValidation = val;
    prevGate = gated;

    // Keep the selection valid when the active view closes.
    if (active === 'pr' && !pr && val) active = 'validation';
    else if (active === 'validation' && !val && pr) active = 'pr';
  });
</script>

<div class="dock">
  {#if hasPr && hasValidation}
    <div class="dock-tabs" role="tablist">
      <button
        class="dock-tab"
        class:active={active === 'pr'}
        role="tab"
        aria-selected={active === 'pr'}
        onclick={() => (active = 'pr')}
      >
        <svg class="dock-tab-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
        </svg>
        {prEntry?.pr ? `PR #${prEntry.pr.number}` : 'Pull request'}
      </button>
      <button
        class="dock-tab"
        class:active={active === 'validation'}
        role="tab"
        aria-selected={active === 'validation'}
        onclick={() => (active = 'validation')}
      >
        <svg class="dock-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
        Validation
        {#if validationRun?.status === 'gate'}
          <span class="dock-tab-alert" title="Waiting for your decision"></span>
        {/if}
      </button>
    </div>
  {/if}

  <div class="dock-body">
    {#if active === 'pr' && prEntry}
      <PrPanel {session} entry={prEntry} {repo} />
    {:else if validationRun}
      <ValidationPanel run={validationRun} />
    {/if}
  </div>
</div>

<style>
  .dock {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--color-surface);
  }

  .dock-tabs {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    padding: 0 0.6rem;
    background: var(--color-surface-elevated);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .dock-tab {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.6rem;
    margin-bottom: -1px;
    font-size: 0.74rem;
    font-weight: 500;
    color: var(--color-text-muted);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
  }

  .dock-tab:hover {
    color: var(--color-text-secondary);
  }

  .dock-tab.active {
    color: var(--color-text-primary);
    border-bottom-color: var(--color-accent);
  }

  .dock-tab-icon {
    width: 0.8rem;
    height: 0.8rem;
    flex-shrink: 0;
  }

  .dock-tab-alert {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-accent);
    animation: dock-alert-pulse 1.2s ease-in-out infinite;
    flex-shrink: 0;
  }

  @keyframes dock-alert-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }

  .dock-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
</style>
