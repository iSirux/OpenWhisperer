<script lang="ts">
  import {
    NM_CANONICAL_STEPS,
    type NmRun,
    type NmStepStatus,
  } from '$lib/stores/noMistakes';

  let {
    run,
    onRespond,
    onCancel,
    onDismiss,
    onSelectFindings,
  }: {
    run: NmRun;
    onRespond: (action: 'approve' | 'fix' | 'skip', findingIds: string[]) => void;
    onCancel: () => void;
    onDismiss: () => void;
    onSelectFindings?: (findingIds: string[]) => void;
  } = $props();

  const STEP_LABELS: Record<string, string> = {
    review: 'Review',
    test: 'Test',
    docs: 'Docs',
    lint: 'Lint',
    push: 'Push',
    pr: 'PR',
    ci: 'CI',
  };

  // Merge the canonical 7-step spine with whatever statuses the backend reported.
  let steps = $derived(
    NM_CANONICAL_STEPS.map((name) => {
      const reported = run.steps.find(
        (s) => s.name.toLowerCase() === name,
      );
      return {
        name,
        label: STEP_LABELS[name] ?? name,
        status: (reported?.status ?? 'pending') as NmStepStatus,
      };
    }),
  );

  let isFinished = $derived(
    run.status === 'passed' ||
      run.status === 'failed' ||
      run.status === 'cancelled' ||
      run.status === 'error',
  );
  let isRunningLike = $derived(
    run.status === 'starting' || run.status === 'running' || run.status === 'gate',
  );
  let hasReportedSteps = $derived(run.steps.length > 0);

  // Elapsed time — ticks while the run is active.
  let now = $state(Date.now());
  $effect(() => {
    if (isFinished) return;
    now = Date.now();
    const t = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(t);
  });
  let elapsed = $derived(Math.max(0, Math.floor((now - run.startedAt) / 1000)));
  // Freeze the elapsed clock once the run finishes.
  let frozenElapsed = $state<number | null>(null);
  $effect(() => {
    if (isFinished && frozenElapsed === null) {
      frozenElapsed = Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000));
    } else if (!isFinished && frozenElapsed !== null) {
      frozenElapsed = null;
    }
  });
  let displayElapsed = $derived(frozenElapsed ?? elapsed);
  function formatElapsed(secs: number): string {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  let statusText = $derived.by(() => {
    switch (run.status) {
      case 'starting':
        return 'Starting…';
      case 'running':
        return 'Running…';
      case 'gate':
        return 'Waiting for your decision';
      case 'passed':
        return 'Passed';
      case 'failed':
        return 'Failed';
      case 'cancelled':
        return 'Cancelled';
      case 'error':
        return 'Error';
      default:
        return '';
    }
  });

  // --- Gate finding selection -----------------------------------------------
  let checked = $state<Record<string, boolean>>({});
  // (Re)initialise checkboxes whenever we enter a gate / the finding set changes.
  let gateKey = $derived(
    run.status === 'gate' ? run.findings.map((f) => f.id).join('|') : '',
  );
  let lastGateKey = $state('');
  $effect(() => {
    if (run.status === 'gate' && gateKey !== lastGateKey) {
      lastGateKey = gateKey;
      const init: Record<string, boolean> = {};
      for (const f of run.findings) {
        // Default-check the mechanical auto-fixes.
        init[f.id] =
          run.selectedFindingIds.includes(f.id) || f.action === 'auto-fix';
      }
      checked = init;
    }
  });

  let checkedIds = $derived(
    run.findings.filter((f) => checked[f.id]).map((f) => f.id),
  );
  let checkedCount = $derived(checkedIds.length);

  function toggleFinding(id: string) {
    checked = { ...checked, [id]: !checked[id] };
    onSelectFindings?.(run.findings.filter((f) => checked[f.id]).map((f) => f.id));
  }

  function approve() {
    if (run.responding) return;
    onRespond('approve', []);
  }
  function fixSelected() {
    if (run.responding || checkedCount === 0) return;
    onRespond('fix', checkedIds);
  }
  function skip() {
    if (run.responding) return;
    onRespond('skip', []);
  }

  // --- Details (log tail) ---------------------------------------------------
  let detailsOpen = $state(false);
  let autoOpenedDetails = $state(false);
  $effect(() => {
    // Auto-open details when the run ends badly so the failure is visible.
    if ((run.status === 'failed' || run.status === 'error') && !autoOpenedDetails) {
      detailsOpen = true;
      autoOpenedDetails = true;
    }
  });

  function actionBadgeClass(action: string): string {
    if (action === 'auto-fix') return 'action-autofix';
    if (action === 'ask-user') return 'action-askuser';
    if (action === 'no-op') return 'action-noop';
    return 'action-other';
  }
</script>

<div class="nm-panel" class:finished={isFinished} data-status={run.status}>
  <!-- Header -->
  <div class="nm-header">
    <div class="nm-header-left">
      <span class="nm-icon" class:ok={run.status === 'passed'} class:bad={run.status === 'failed' || run.status === 'error'} aria-hidden="true">
        {#if run.status === 'passed'}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
        {:else}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        {/if}
      </span>
      <span class="nm-title">No mistakes</span>
      <span class="nm-status">{statusText}</span>
      <span class="nm-elapsed">{formatElapsed(displayElapsed)}</span>
    </div>
    <div class="nm-header-right">
      {#if isRunningLike}
        <button
          class="nm-btn nm-btn-ghost"
          onclick={onCancel}
          title="Cancel the no-mistakes run"
        >
          Cancel
        </button>
      {/if}
      {#if isFinished}
        <button
          class="nm-dismiss"
          onclick={onDismiss}
          title="Dismiss"
          aria-label="Dismiss"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      {/if}
    </div>
  </div>

  <!-- Stepper -->
  <div class="nm-stepper" class:shimmer={!hasReportedSteps && run.status === 'running'}>
    {#each steps as step (step.name)}
      <div class="nm-step" data-status={step.status} title={`${step.label}: ${step.status}`}>
        <span class="nm-step-dot" class:pulsing={step.status === 'running'}>
          {#if step.status === 'passed'}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          {:else if step.status === 'failed'}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          {/if}
        </span>
        <span class="nm-step-label">{step.label}</span>
      </div>
    {/each}
  </div>

  <!-- Gate -->
  {#if run.status === 'gate'}
    <div class="nm-gate">
      <div class="nm-gate-title">
        Decision gate — {run.findings.length}
        {run.findings.length === 1 ? 'finding' : 'findings'}
      </div>
      {#if run.findings.length > 0}
        <div class="nm-findings">
          <div class="nm-finding-row nm-finding-head">
            <span class="nm-col-check" aria-hidden="true"></span>
            <span class="nm-col-sev">Severity</span>
            <span class="nm-col-file">File</span>
            <span class="nm-col-action">Action</span>
            <span class="nm-col-desc">Description</span>
          </div>
          {#each run.findings as finding (finding.id)}
            <label class="nm-finding-row">
              <span class="nm-col-check">
                <input
                  type="checkbox"
                  checked={checked[finding.id] ?? false}
                  disabled={run.responding}
                  onchange={() => toggleFinding(finding.id)}
                />
              </span>
              <span class="nm-col-sev">
                <span class="nm-sev-badge">{finding.severity}</span>
              </span>
              <span class="nm-col-file" title={finding.file}>{finding.file}</span>
              <span class="nm-col-action">
                <span class="nm-action-badge {actionBadgeClass(finding.action)}">{finding.action}</span>
              </span>
              <span class="nm-col-desc">{finding.description}</span>
            </label>
          {/each}
        </div>
      {/if}
      <div class="nm-gate-actions">
        <button class="nm-btn nm-btn-primary" onclick={approve} disabled={run.responding} title="Approve all findings and continue">
          Approve
        </button>
        <button class="nm-btn" onclick={fixSelected} disabled={run.responding || checkedCount === 0} title="Fix the selected findings">
          Fix selected ({checkedCount})
        </button>
        <button class="nm-btn nm-btn-ghost" onclick={skip} disabled={run.responding} title="Skip these findings and continue">
          Skip
        </button>
      </div>
    </div>
  {/if}

  <!-- Done banner -->
  {#if isFinished}
    <div class="nm-outcome" data-status={run.status}>
      {#if run.status === 'passed'}
        All checks passed — pushed &amp; PR opened
      {:else if run.status === 'failed'}
        Pipeline failed{run.message ? ` — ${run.message}` : ''}
      {:else if run.status === 'cancelled'}
        Cancelled{run.message ? ` — ${run.message}` : ''}
      {:else}
        Error{run.message ? ` — ${run.message}` : ''}
      {/if}
    </div>
  {/if}

  <!-- Details / log tail -->
  {#if run.log.length > 0 || run.lastRaw}
    <div class="nm-details">
      <button class="nm-details-toggle" onclick={() => (detailsOpen = !detailsOpen)}>
        <svg class="nm-chevron" class:open={detailsOpen} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m9 18 6-6-6-6" />
        </svg>
        Details
      </button>
      {#if detailsOpen}
        <pre class="nm-log">{run.log.length > 0 ? run.log.join('\n') : run.lastRaw}</pre>
      {/if}
    </div>
  {/if}
</div>

<style>
  .nm-panel {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    margin: 0 0.75rem 0.5rem;
    padding: 0.75rem 0.85rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    font-size: 0.8rem;
  }
  .nm-panel[data-status='gate'] {
    border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
  }
  .nm-panel[data-status='passed'] {
    border-color: color-mix(in srgb, var(--color-success, #22c55e) 45%, var(--color-border));
  }
  .nm-panel[data-status='failed'],
  .nm-panel[data-status='error'] {
    border-color: color-mix(in srgb, var(--color-error, #ef4444) 45%, var(--color-border));
  }

  /* Header */
  .nm-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .nm-header-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .nm-icon {
    display: inline-flex;
    color: var(--color-accent);
  }
  .nm-icon.ok {
    color: var(--color-success, #22c55e);
  }
  .nm-icon.bad {
    color: var(--color-error, #ef4444);
  }
  .nm-icon svg {
    width: 16px;
    height: 16px;
  }
  .nm-title {
    font-weight: 600;
    color: var(--color-text-primary);
  }
  .nm-status {
    color: var(--color-text-secondary);
  }
  .nm-elapsed {
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
    font-size: 0.72rem;
  }
  .nm-header-right {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .nm-dismiss {
    display: inline-flex;
    padding: 0.15rem;
    color: var(--color-text-muted);
    border-radius: 4px;
    transition: color 0.15s, background 0.15s;
  }
  .nm-dismiss:hover {
    color: var(--color-text-primary);
    background: var(--color-border);
  }
  .nm-dismiss svg {
    width: 15px;
    height: 15px;
  }

  /* Buttons */
  .nm-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.3rem 0.7rem;
    background: var(--color-surface-elevated);
    color: var(--color-text-primary);
    border: 1px solid var(--color-border);
    border-radius: 7px;
    font-size: 0.76rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s, opacity 0.15s;
  }
  .nm-btn:hover:not(:disabled) {
    border-color: var(--color-accent);
  }
  .nm-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .nm-btn-primary {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: #fff;
  }
  .nm-btn-primary:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .nm-btn-ghost {
    background: transparent;
    color: var(--color-text-secondary);
  }

  /* Stepper */
  .nm-stepper {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  .nm-step {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.2rem 0.4rem;
    border-radius: 6px;
  }
  .nm-step-dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    border: 1.5px solid var(--color-text-muted);
    color: #fff;
    flex-shrink: 0;
  }
  .nm-step-dot svg {
    width: 11px;
    height: 11px;
  }
  .nm-step-label {
    font-size: 0.74rem;
    color: var(--color-text-muted);
  }
  /* pending: muted (default) */
  .nm-step[data-status='running'] .nm-step-label {
    color: var(--color-accent);
    font-weight: 600;
  }
  .nm-step[data-status='running'] .nm-step-dot {
    border-color: var(--color-accent);
    background: var(--color-accent);
  }
  .nm-step-dot.pulsing {
    animation: nm-pulse 1.2s ease-in-out infinite;
  }
  .nm-step[data-status='passed'] .nm-step-dot {
    border-color: var(--color-success, #22c55e);
    background: var(--color-success, #22c55e);
  }
  .nm-step[data-status='passed'] .nm-step-label {
    color: var(--color-text-secondary);
  }
  .nm-step[data-status='failed'] .nm-step-dot {
    border-color: var(--color-error, #ef4444);
    background: var(--color-error, #ef4444);
  }
  .nm-step[data-status='failed'] .nm-step-label {
    color: var(--color-error, #ef4444);
    font-weight: 600;
  }
  .nm-step[data-status='skipped'] .nm-step-label {
    text-decoration: line-through;
    opacity: 0.55;
  }
  .nm-step[data-status='skipped'] .nm-step-dot {
    opacity: 0.5;
  }

  .nm-stepper.shimmer {
    position: relative;
    overflow: hidden;
  }
  .nm-stepper.shimmer::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      transparent 0%,
      color-mix(in srgb, var(--color-accent) 18%, transparent) 50%,
      transparent 100%
    );
    animation: nm-shimmer 1.4s linear infinite;
    pointer-events: none;
  }

  @keyframes nm-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.55; transform: scale(0.82); }
  }
  @keyframes nm-shimmer {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }

  /* Gate */
  .nm-gate {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px dashed var(--color-border);
  }
  .nm-gate-title {
    font-weight: 600;
    color: var(--color-text-primary);
  }
  .nm-findings {
    display: flex;
    flex-direction: column;
    max-height: 220px;
    overflow-y: auto;
    border: 1px solid var(--color-border);
    border-radius: 7px;
  }
  .nm-finding-row {
    display: grid;
    grid-template-columns: 24px 72px minmax(90px, 1.3fr) 78px minmax(120px, 2.5fr);
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid var(--color-border);
    cursor: pointer;
  }
  .nm-finding-row:last-child {
    border-bottom: none;
  }
  .nm-finding-head {
    cursor: default;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
    background: var(--color-surface-elevated);
  }
  .nm-col-check {
    display: inline-flex;
    justify-content: center;
  }
  .nm-col-file {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.72rem;
    color: var(--color-text-secondary);
  }
  .nm-col-desc {
    color: var(--color-text-secondary);
    min-width: 0;
  }
  .nm-sev-badge {
    display: inline-block;
    padding: 0.1rem 0.4rem;
    border-radius: 5px;
    font-size: 0.68rem;
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    text-transform: capitalize;
  }
  .nm-action-badge {
    display: inline-block;
    padding: 0.1rem 0.4rem;
    border-radius: 5px;
    font-size: 0.68rem;
    font-weight: 500;
    white-space: nowrap;
  }
  .action-autofix {
    background: color-mix(in srgb, var(--color-success, #22c55e) 18%, transparent);
    color: var(--color-success, #22c55e);
  }
  .action-askuser {
    background: color-mix(in srgb, var(--color-warning, #f59e0b) 20%, transparent);
    color: var(--color-warning, #f59e0b);
  }
  .action-noop {
    background: var(--color-surface-elevated);
    color: var(--color-text-muted);
  }
  .action-other {
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
  }
  .nm-gate-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  /* Outcome banner */
  .nm-outcome {
    padding: 0.45rem 0.6rem;
    border-radius: 7px;
    font-weight: 500;
  }
  .nm-outcome[data-status='passed'] {
    background: color-mix(in srgb, var(--color-success, #22c55e) 15%, transparent);
    color: var(--color-success, #22c55e);
  }
  .nm-outcome[data-status='failed'],
  .nm-outcome[data-status='error'] {
    background: color-mix(in srgb, var(--color-error, #ef4444) 15%, transparent);
    color: var(--color-error, #ef4444);
  }
  .nm-outcome[data-status='cancelled'] {
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
  }

  /* Details */
  .nm-details {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .nm-details-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    align-self: flex-start;
    padding: 0.15rem 0.25rem;
    font-size: 0.72rem;
    color: var(--color-text-muted);
    cursor: pointer;
    background: none;
    border: none;
  }
  .nm-details-toggle:hover {
    color: var(--color-text-secondary);
  }
  .nm-chevron {
    width: 12px;
    height: 12px;
    transition: transform 0.15s ease;
  }
  .nm-chevron.open {
    transform: rotate(90deg);
  }
  .nm-log {
    margin: 0;
    max-height: 200px;
    overflow: auto;
    padding: 0.5rem;
    background: var(--color-background);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.7rem;
    line-height: 1.4;
    color: var(--color-text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
