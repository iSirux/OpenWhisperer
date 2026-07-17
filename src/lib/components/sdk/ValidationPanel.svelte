<script lang="ts">
  import {
    validation,
    VALIDATION_STEP_ORDER,
    type ValidationRunView,
    type ValidationStep,
    type ValidationFinding,
    type StepName,
    type StepStatus,
    type AgentActivityItem,
  } from '$lib/stores/validation';

  let { run }: { run: ValidationRunView } = $props();

  const STEP_LABELS: Record<StepName, string> = {
    review: 'Review',
    test: 'Test',
    docs: 'Docs',
    lint: 'Lint',
    ship: 'Ship',
    ci: 'CI',
  };

  // Merge the run's selected steps into fixed order (the backend already orders
  // them, but guard against ordering drift).
  let steps = $derived(
    VALIDATION_STEP_ORDER.filter((name) => run.steps.some((s) => s.name === name)).map(
      (name) => run.steps.find((s) => s.name === name) as ValidationStep,
    ),
  );

  let isFinished = $derived(
    run.status === 'passed' || run.status === 'failed' || run.status === 'cancelled',
  );
  let isRunningLike = $derived(run.status === 'running' || run.status === 'gate');
  let hasReportedSteps = $derived(run.steps.length > 0);

  // Elapsed clock — ticks while active, freezes on finish (mirrors NoMistakesPanel).
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
      case 'running':
        return run.pendingFix ? 'Agent is fixing…' : 'Running…';
      case 'gate':
        return 'Waiting for your decision';
      case 'passed':
        return 'Passed';
      case 'failed':
        return 'Failed';
      case 'cancelled':
        return 'Cancelled';
      default:
        return '';
    }
  });

  const gate = $derived(run.gate ?? null);
  const gateStep = $derived(gate ? STEP_LABELS[gate.step] : '');

  // Combined findings shown at a findings/ci gate (agent findings + user-added).
  let gateFindings = $derived(gate ? [...gate.findings, ...run.userFindings] : []);
  let checkedIds = $derived(new Set(run.selectedFindingIds));
  let checkedCount = $derived(run.selectedFindingIds.length);

  function toggleFinding(id: string) {
    const next = new Set(run.selectedFindingIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    validation.selectFindings(run.id, [...next]);
  }

  // --- Instructions + add-finding inputs ------------------------------------
  let instructions = $state('');
  let newFindingText = $state('');
  // Reset the local inputs whenever we enter a new/changed gate.
  let lastGateSig = $state('');
  $effect(() => {
    const sig = gate ? `${gate.kind}::${gate.findings.map((f) => f.id).join(',')}` : '';
    if (sig !== lastGateSig) {
      lastGateSig = sig;
      instructions = '';
      newFindingText = '';
    }
  });

  function addFinding() {
    const text = newFindingText.trim();
    if (!text) return;
    validation.addUserFinding(run.id, { description: text });
    newFindingText = '';
  }

  function fixSelected() {
    if (run.responding || checkedCount === 0) return;
    validation.respond(run.id, 'fix', run.selectedFindingIds, instructions || undefined);
  }
  function fixOne(id: string) {
    if (run.responding) return;
    validation.respond(run.id, 'fix', [id], instructions || undefined);
  }
  function approve() {
    if (run.responding) return;
    validation.respond(run.id, 'approve');
  }
  function skip() {
    if (run.responding) return;
    validation.respond(run.id, 'skip');
  }

  // --- Ship gate editable proposal ------------------------------------------
  let shipCommit = $state('');
  let shipTitle = $state('');
  let shipBody = $state('');
  let lastShipSig = $state('');
  $effect(() => {
    const ship = gate?.kind === 'ship' ? gate.ship : null;
    const sig = ship ? `${gate?.step}:${ship.branch}:${ship.baseBranch}` : '';
    if (sig !== lastShipSig) {
      lastShipSig = sig;
      if (ship) {
        shipCommit = ship.commitMessage;
        shipTitle = ship.prTitle;
        shipBody = ship.prBody;
      }
    }
  });
  function commitAndShip() {
    if (run.responding) return;
    validation.executeShip(run.id, shipCommit, shipTitle, shipBody);
  }

  // --- Per-step expandable output / transcript ------------------------------
  let openOutput = $state<Record<string, boolean>>({});
  let openTranscript = $state<Record<string, boolean>>({});
  let openDiff = $state<Record<string, boolean>>({});

  function stepHasDetail(step: ValidationStep): boolean {
    return !!(
      step.proof?.command ||
      step.note ||
      step.riskLevel ||
      step.evidence ||
      step.transcript ||
      step.fixReviewDiff
    );
  }
  let detailSteps = $derived(steps.filter(stepHasDetail));

  function severityClass(sev: string): string {
    if (sev === 'error') return 'sev-error';
    if (sev === 'warning') return 'sev-warning';
    return 'sev-info';
  }
  function actionBadgeClass(action: string): string {
    if (action === 'auto-fix') return 'action-autofix';
    if (action === 'ask-user') return 'action-askuser';
    if (action === 'no-op') return 'action-noop';
    return 'action-other';
  }
  function fileLabel(f: ValidationFinding): string {
    if (!f.file) return '';
    return f.line != null ? `${f.file}:${f.line}` : f.file;
  }
  function diffLineClass(line: string): string {
    if (line.startsWith('+') && !line.startsWith('+++')) return 'diff-add';
    if (line.startsWith('-') && !line.startsWith('---')) return 'diff-del';
    if (line.startsWith('@@')) return 'diff-hunk';
    return '';
  }

  // --- Live agent activity ----------------------------------------------------
  const ROLE_LABELS: Record<string, string> = {
    review: 'Reviewer',
    verify: 'Verifier',
    evidence: 'Evidence',
    docs: 'Docs',
    lint: 'Lint',
  };
  function roleLabel(role: string): string {
    return ROLE_LABELS[role] ?? role;
  }
  function formatActivity(a: AgentActivityItem): string {
    if (a.kind === 'tool') return a.detail ? `${a.tool} · ${a.detail}` : (a.tool ?? '');
    return a.text ?? '';
  }
  function activityTime(ts: number): string {
    return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
  }
  let latestActivity = $derived(
    run.activity.length > 0 ? run.activity[run.activity.length - 1] : null,
  );
  // The live line shows only while the pipeline itself is running (agents work
  // only in that state; during a fix the session transcript is the live view).
  let showLiveActivity = $derived(run.status === 'running' && !run.pendingFix && !!latestActivity);

  let activityOpen = $state(false);
  let activityFeedEl = $state<HTMLElement | null>(null);
  $effect(() => {
    // Follow the tail while the drawer is open.
    run.activity.length;
    if (activityOpen && activityFeedEl) {
      activityFeedEl.scrollTop = activityFeedEl.scrollHeight;
    }
  });

  // --- Log tail -------------------------------------------------------------
  let detailsOpen = $state(false);
  let autoOpenedDetails = $state(false);
  $effect(() => {
    if (run.status === 'failed' && !autoOpenedDetails) {
      detailsOpen = true;
      autoOpenedDetails = true;
    }
  });

  async function openPr() {
    if (!run.prUrl) return;
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(run.prUrl);
    } catch (e) {
      console.error('[ValidationPanel] Failed to open PR url:', e);
    }
  }

  function statusStepIcon(status: StepStatus): 'check' | 'cross' | 'none' {
    if (status === 'passed') return 'check';
    if (status === 'failed') return 'cross';
    return 'none';
  }
</script>

<div class="v-panel" class:finished={isFinished} data-status={run.status}>
  <!-- Header -->
  <div class="v-header">
    <div class="v-header-left">
      <span
        class="v-icon"
        class:ok={run.status === 'passed'}
        class:bad={run.status === 'failed'}
        aria-hidden="true"
      >
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
      <span class="v-title">Validation</span>
      <span class="v-status">{statusText}</span>
      <span class="v-elapsed">{formatElapsed(displayElapsed)}</span>
    </div>
    <div class="v-header-right">
      {#if isRunningLike}
        <button class="v-btn v-btn-ghost" onclick={() => validation.cancel(run.id)} title="Cancel the validation run">
          Cancel
        </button>
      {/if}
      {#if isFinished}
        <button class="v-dismiss" onclick={() => validation.dismiss(run.id)} title="Dismiss" aria-label="Dismiss">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      {/if}
    </div>
  </div>

  <!-- Stepper -->
  <div class="v-stepper" class:shimmer={!hasReportedSteps && run.status === 'running'}>
    {#each steps as step (step.name)}
      <div class="v-step" data-status={step.status} title={`${STEP_LABELS[step.name]}: ${step.status}`}>
        <span class="v-step-dot" class:pulsing={step.status === 'running' || step.status === 'fixing'}>
          {#if statusStepIcon(step.status) === 'check'}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          {:else if statusStepIcon(step.status) === 'cross'}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          {/if}
        </span>
        <span class="v-step-label">{STEP_LABELS[step.name]}</span>
      </div>
    {/each}
  </div>

  <!-- Live agent activity (what the reviewer is doing right now) -->
  {#if showLiveActivity && latestActivity}
    <div class="v-activity-live" title={formatActivity(latestActivity)}>
      <span class="v-spinner" aria-hidden="true"></span>
      <span class="v-activity-role">{roleLabel(latestActivity.role)}</span>
      <span class="v-activity-line" class:is-text={latestActivity.kind === 'text'}>
        {formatActivity(latestActivity)}
      </span>
    </div>
  {/if}

  <!-- Pending fix banner -->
  {#if run.pendingFix}
    <div class="v-pending-fix">
      <span class="v-spinner" aria-hidden="true"></span>
      Agent is fixing
      {#if gateFindings.length > 0}({checkedCount || gateFindings.length}
        {(checkedCount || gateFindings.length) === 1 ? 'finding' : 'findings'}){/if}…
    </div>
  {/if}

  <!-- Per-step detail (proof / risk / evidence / transcript) -->
  {#if detailSteps.length > 0}
    <div class="v-details-list">
      {#each detailSteps as step (step.name)}
        <div class="v-step-detail">
          <div class="v-step-detail-head">
            <span class="v-step-detail-name">{STEP_LABELS[step.name]}</span>
            {#if step.riskLevel}
              <span class="v-risk risk-{step.riskLevel}">risk: {step.riskLevel}</span>
            {/if}
            {#if step.status === 'skipped'}
              <span class="v-tag">skipped</span>
            {/if}
          </div>

          {#if step.note}
            <div class="v-note">{step.note}</div>
          {/if}
          {#if step.riskRationale}
            <div class="v-note">{step.riskRationale}</div>
          {/if}

          {#if step.proof?.command}
            <div class="v-proof">
              <code class="v-proof-cmd">{step.proof.command}</code>
              {#if step.proof.exitCode != null}
                <span class="v-proof-exit" class:bad={step.proof.exitCode !== 0}>
                  exit {step.proof.exitCode}
                </span>
              {/if}
              {#if step.proof.outputTail}
                <button class="v-inline-toggle" onclick={() => (openOutput[step.name] = !openOutput[step.name])}>
                  {openOutput[step.name] ? 'Hide output' : 'Show output'}
                </button>
              {/if}
            </div>
            {#if step.proof.outputTail && openOutput[step.name]}
              <pre class="v-output">{step.proof.outputTail}</pre>
            {/if}
          {/if}

          {#if step.evidence}
            <div class="v-evidence">
              <div class="v-evidence-summary">{step.evidence.testingSummary}</div>
              {#if step.evidence.tested.length > 0}
                <ul class="v-evidence-tested">
                  {#each step.evidence.tested as t}<li>{t}</li>{/each}
                </ul>
              {/if}
              {#if step.evidence.artifacts.length > 0}
                <div class="v-artifacts">
                  {#each step.evidence.artifacts as a}
                    <span class="v-artifact" title={a.path}>{a.label} <em>({a.kind})</em></span>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}

          {#if step.fixReviewDiff}
            <button class="v-inline-toggle" onclick={() => (openDiff[step.name] = !openDiff[step.name])}>
              {openDiff[step.name] ? 'Hide fix diff' : 'View fix diff'}
            </button>
            {#if openDiff[step.name]}
              <pre class="v-diff">{#each step.fixReviewDiff.split('\n') as line}<span class={diffLineClass(line)}>{line}
</span>{/each}</pre>
            {/if}
          {/if}

          {#if step.transcript}
            <button class="v-inline-toggle" onclick={() => (openTranscript[step.name] = !openTranscript[step.name])}>
              {openTranscript[step.name] ? 'Hide agent transcript' : 'View agent transcript'}
            </button>
            {#if openTranscript[step.name]}
              <pre class="v-transcript">{step.transcript}</pre>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Gate -->
  {#if run.status === 'gate' && gate}
    <div class="v-gate">
      {#if gate.kind === 'ship' && gate.ship}
        {@const ship = gate.ship}
        <div class="v-gate-title">Ship — {gateStep}</div>
        <div class="v-ship-refs" title="{ship.baseBranch} ← {ship.branch}">
          <span class="v-ref">{ship.baseBranch}</span>
          <span class="v-arrow">←</span>
          <span class="v-ref">{ship.branch}</span>
        </div>
        {#if ship.onDefaultBranch}
          <div class="v-note">On the default branch — will commit &amp; push only (no PR).</div>
        {:else if ship.existingPrUrl}
          <div class="v-note">A PR already exists — will commit &amp; push to it.</div>
        {/if}
        {#if !ship.hasUncommitted && ship.alreadyPushed}
          <div class="v-note">Nothing to commit and branch already pushed.</div>
        {/if}
        <label class="v-field">
          <span class="v-field-label">Commit message</span>
          <textarea class="v-textarea" rows="2" bind:value={shipCommit}></textarea>
        </label>
        {#if !ship.onDefaultBranch && !ship.existingPrUrl}
          <label class="v-field">
            <span class="v-field-label">PR title</span>
            <input class="v-input" bind:value={shipTitle} />
          </label>
          <label class="v-field">
            <span class="v-field-label">PR body</span>
            <textarea class="v-textarea" rows="5" bind:value={shipBody}></textarea>
          </label>
        {/if}
        <div class="v-gate-actions">
          <button class="v-btn v-btn-primary" onclick={commitAndShip} disabled={run.responding}>
            {run.responding ? 'Shipping…' : 'Commit & Ship'}
          </button>
          <button class="v-btn v-btn-ghost" onclick={skip} disabled={run.responding}>Skip step</button>
        </div>
      {:else}
        <!-- findings / fix_review / ci_failure gates -->
        <div class="v-gate-title">
          {#if gate.kind === 'fix_review'}
            Review the fix — {gateStep}
          {:else if gate.kind === 'ci_failure'}
            CI failed — {gateStep}
          {:else}
            {gateStep} — {gateFindings.length}
            {gateFindings.length === 1 ? 'finding' : 'findings'}
          {/if}
        </div>

        {#if gate.kind === 'fix_review' && gate.diff}
          <pre class="v-diff">{#each gate.diff.split('\n') as line}<span class={diffLineClass(line)}>{line}
</span>{/each}</pre>
        {/if}

        {#if gateFindings.length > 0}
          <div class="v-findings">
            <div class="v-finding-row v-finding-head">
              <span class="v-col-check" aria-hidden="true"></span>
              <span class="v-col-sev">Severity</span>
              <span class="v-col-action">Action</span>
              <span class="v-col-file">File</span>
              <span class="v-col-desc">Description</span>
              <span class="v-col-send" aria-hidden="true"></span>
            </div>
            {#each gateFindings as finding (finding.id)}
              <div class="v-finding-row">
                <span class="v-col-check">
                  <input
                    type="checkbox"
                    checked={checkedIds.has(finding.id)}
                    disabled={run.responding}
                    onchange={() => toggleFinding(finding.id)}
                  />
                </span>
                <span class="v-col-sev">
                  <span class="v-sev-badge {severityClass(finding.severity)}">{finding.severity}</span>
                </span>
                <span class="v-col-action">
                  <span class="v-action-badge {actionBadgeClass(finding.action)}">{finding.action}</span>
                </span>
                <span class="v-col-file" title={finding.file ?? ''}>{fileLabel(finding)}</span>
                <span class="v-col-desc">
                  {finding.description}
                  {#if finding.userInstructions}
                    <span class="v-user-note">↳ {finding.userInstructions}</span>
                  {/if}
                </span>
                <span class="v-col-send">
                  <button
                    class="v-send-btn"
                    onclick={() => fixOne(finding.id)}
                    disabled={run.responding}
                    title="Send this single finding to the agent to fix"
                  >
                    Send to agent
                  </button>
                </span>
              </div>
            {/each}
          </div>
        {/if}

        <!-- Fix instructions + add finding -->
        <textarea
          class="v-textarea"
          rows="2"
          placeholder="Optional instructions for the agent when fixing…"
          bind:value={instructions}
          disabled={run.responding}
        ></textarea>
        <div class="v-add-finding">
          <input
            class="v-input"
            placeholder="Add a finding of your own…"
            bind:value={newFindingText}
            disabled={run.responding}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addFinding();
              }
            }}
          />
          <button class="v-btn" onclick={addFinding} disabled={run.responding || !newFindingText.trim()}>Add finding</button>
        </div>

        <div class="v-gate-actions">
          <button class="v-btn v-btn-primary" onclick={fixSelected} disabled={run.responding || checkedCount === 0}>
            Fix selected ({checkedCount})
          </button>
          {#if gate.kind !== 'ci_failure'}
            <button class="v-btn" onclick={approve} disabled={run.responding} title="Approve — accept the findings and continue">
              Approve
            </button>
          {/if}
          <button class="v-btn v-btn-ghost" onclick={skip} disabled={run.responding} title="Skip this step and continue">
            Skip step
          </button>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Outcome banner -->
  {#if isFinished}
    <div class="v-outcome" data-status={run.status}>
      {#if run.status === 'passed'}
        Validation passed{run.prUrl ? ' — pull request ready' : ''}
      {:else if run.status === 'failed'}
        Validation failed{run.error ? ` — ${run.error}` : ''}
      {:else}
        Cancelled{run.error ? ` — ${run.error}` : ''}
      {/if}
    </div>
    {#if run.prUrl}
      <div class="v-pr-hint">
        <button class="v-pr-link" onclick={openPr}>View pull request</button>
        <span class="v-note">— status &amp; merge live in the PR panel above the prompt.</span>
      </div>
    {/if}
  {/if}

  <!-- Agent activity feed (full history, for understanding & debugging) -->
  {#if run.activity.length > 0}
    <div class="v-log-details">
      <button class="v-details-toggle" onclick={() => (activityOpen = !activityOpen)}>
        <svg class="v-chevron" class:open={activityOpen} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m9 18 6-6-6-6" />
        </svg>
        Agent activity ({run.activity.length})
      </button>
      {#if activityOpen}
        <div class="v-activity-feed" bind:this={activityFeedEl}>
          {#each run.activity as a, i (i)}
            <div class="v-activity-row">
              <span class="v-activity-ts">{activityTime(a.ts)}</span>
              <span class="v-activity-role">{roleLabel(a.role)}</span>
              {#if a.kind === 'tool'}
                <span class="v-activity-tool">{a.tool}</span>
                <span class="v-activity-detail">{a.detail}</span>
              {:else}
                <span class="v-activity-msg">{a.text}</span>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Log tail -->
  {#if run.log.length > 0}
    <div class="v-log-details">
      <button class="v-details-toggle" onclick={() => (detailsOpen = !detailsOpen)}>
        <svg class="v-chevron" class:open={detailsOpen} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m9 18 6-6-6-6" />
        </svg>
        Log
      </button>
      {#if detailsOpen}
        <pre class="v-log">{run.log.join('\n')}</pre>
      {/if}
    </div>
  {/if}
</div>

<style>
  .v-panel {
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
  .v-panel[data-status='gate'] {
    border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
  }
  .v-panel[data-status='passed'] {
    border-color: color-mix(in srgb, var(--color-success, #22c55e) 45%, var(--color-border));
  }
  .v-panel[data-status='failed'] {
    border-color: color-mix(in srgb, var(--color-error, #ef4444) 45%, var(--color-border));
  }

  /* Header */
  .v-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .v-header-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .v-icon {
    display: inline-flex;
    color: var(--color-accent);
  }
  .v-icon.ok {
    color: var(--color-success, #22c55e);
  }
  .v-icon.bad {
    color: var(--color-error, #ef4444);
  }
  .v-icon svg {
    width: 16px;
    height: 16px;
  }
  .v-title {
    font-weight: 600;
    color: var(--color-text-primary);
  }
  .v-status {
    color: var(--color-text-secondary);
  }
  .v-elapsed {
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
    font-size: 0.72rem;
  }
  .v-header-right {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .v-dismiss {
    display: inline-flex;
    padding: 0.15rem;
    color: var(--color-text-muted);
    border-radius: 4px;
    transition: color 0.15s, background 0.15s;
  }
  .v-dismiss:hover {
    color: var(--color-text-primary);
    background: var(--color-border);
  }
  .v-dismiss svg {
    width: 15px;
    height: 15px;
  }

  /* Buttons */
  .v-btn {
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
  .v-btn:hover:not(:disabled) {
    border-color: var(--color-accent);
  }
  .v-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .v-btn-primary {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: #fff;
  }
  .v-btn-primary:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .v-btn-ghost {
    background: transparent;
    color: var(--color-text-secondary);
  }

  /* Stepper */
  .v-stepper {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  .v-step {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.2rem 0.4rem;
    border-radius: 6px;
  }
  .v-step-dot {
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
  .v-step-dot svg {
    width: 11px;
    height: 11px;
  }
  .v-step-label {
    font-size: 0.74rem;
    color: var(--color-text-muted);
  }
  .v-step[data-status='running'] .v-step-label,
  .v-step[data-status='fixing'] .v-step-label,
  .v-step[data-status='gate'] .v-step-label,
  .v-step[data-status='fix_review'] .v-step-label {
    color: var(--color-accent);
    font-weight: 600;
  }
  .v-step[data-status='running'] .v-step-dot,
  .v-step[data-status='fixing'] .v-step-dot,
  .v-step[data-status='gate'] .v-step-dot,
  .v-step[data-status='fix_review'] .v-step-dot {
    border-color: var(--color-accent);
    background: var(--color-accent);
  }
  .v-step-dot.pulsing {
    animation: v-pulse 1.2s ease-in-out infinite;
  }
  .v-step[data-status='passed'] .v-step-dot {
    border-color: var(--color-success, #22c55e);
    background: var(--color-success, #22c55e);
  }
  .v-step[data-status='passed'] .v-step-label {
    color: var(--color-text-secondary);
  }
  .v-step[data-status='failed'] .v-step-dot {
    border-color: var(--color-error, #ef4444);
    background: var(--color-error, #ef4444);
  }
  .v-step[data-status='failed'] .v-step-label {
    color: var(--color-error, #ef4444);
    font-weight: 600;
  }
  .v-step[data-status='skipped'] .v-step-label {
    text-decoration: line-through;
    opacity: 0.55;
  }
  .v-step[data-status='skipped'] .v-step-dot {
    opacity: 0.5;
  }

  .v-stepper.shimmer {
    position: relative;
    overflow: hidden;
  }
  .v-stepper.shimmer::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      transparent 0%,
      color-mix(in srgb, var(--color-accent) 18%, transparent) 50%,
      transparent 100%
    );
    animation: v-shimmer 1.4s linear infinite;
    pointer-events: none;
  }

  @keyframes v-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.55; transform: scale(0.82); }
  }
  @keyframes v-shimmer {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }

  /* Pending fix */
  .v-pending-fix {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.55rem;
    border-radius: 7px;
    background: color-mix(in srgb, var(--color-accent) 12%, transparent);
    color: var(--color-accent);
    font-weight: 500;
  }
  .v-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: v-spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  @keyframes v-spin {
    to { transform: rotate(360deg); }
  }

  /* Per-step details */
  .v-details-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .v-step-detail {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.45rem 0.55rem;
    border: 1px solid var(--color-border);
    border-radius: 7px;
    background: var(--color-surface-elevated);
  }
  .v-step-detail-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .v-step-detail-name {
    font-weight: 600;
    color: var(--color-text-primary);
  }
  .v-tag {
    font-size: 0.66rem;
    padding: 0.05rem 0.35rem;
    border-radius: 5px;
    background: var(--color-border);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .v-risk {
    font-size: 0.68rem;
    padding: 0.05rem 0.4rem;
    border-radius: 5px;
    font-weight: 600;
  }
  .risk-low { color: var(--color-success, #22c55e); background: color-mix(in srgb, var(--color-success, #22c55e) 16%, transparent); }
  .risk-medium { color: rgb(251, 191, 36); background: rgba(251, 191, 36, 0.16); }
  .risk-high { color: var(--color-error, #ef4444); background: color-mix(in srgb, var(--color-error, #ef4444) 16%, transparent); }
  .v-note {
    color: var(--color-text-secondary);
    line-height: 1.4;
    font-size: 0.74rem;
  }
  .v-proof {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .v-proof-cmd {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.72rem;
    color: var(--color-text-secondary);
    background: var(--color-background);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: 0.05rem 0.3rem;
  }
  .v-proof-exit {
    font-size: 0.68rem;
    color: var(--color-success, #22c55e);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .v-proof-exit.bad {
    color: var(--color-error, #ef4444);
  }
  .v-inline-toggle {
    align-self: flex-start;
    font-size: 0.7rem;
    color: var(--color-accent);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
  }
  .v-inline-toggle:hover {
    text-decoration: underline;
  }
  .v-output,
  .v-transcript,
  .v-log {
    margin: 0;
    max-height: 220px;
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
  .v-evidence {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .v-evidence-summary {
    color: var(--color-text-secondary);
    font-size: 0.74rem;
    line-height: 1.4;
  }
  .v-evidence-tested {
    margin: 0;
    padding-left: 1.1rem;
    color: var(--color-text-muted);
    font-size: 0.72rem;
  }
  .v-artifacts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .v-artifact {
    font-size: 0.7rem;
    padding: 0.05rem 0.4rem;
    border-radius: 5px;
    background: var(--color-background);
    border: 1px solid var(--color-border);
    color: var(--color-text-secondary);
  }
  .v-artifact em {
    color: var(--color-text-muted);
    font-style: normal;
  }

  /* Diff */
  .v-diff {
    margin: 0;
    max-height: 260px;
    overflow: auto;
    padding: 0.5rem;
    background: var(--color-background);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.7rem;
    line-height: 1.35;
    white-space: pre;
    color: var(--color-text-secondary);
  }
  .v-diff .diff-add { color: rgb(74, 222, 128); }
  .v-diff .diff-del { color: rgb(248, 113, 113); }
  .v-diff .diff-hunk { color: rgb(96, 165, 250); }

  /* Gate */
  .v-gate {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px dashed var(--color-border);
  }
  .v-gate-title {
    font-weight: 600;
    color: var(--color-text-primary);
  }
  .v-findings {
    display: flex;
    flex-direction: column;
    max-height: 260px;
    overflow-y: auto;
    border: 1px solid var(--color-border);
    border-radius: 7px;
  }
  .v-finding-row {
    display: grid;
    grid-template-columns: 24px 68px 72px minmax(80px, 1.2fr) minmax(120px, 2.4fr) 84px;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid var(--color-border);
  }
  .v-finding-row:last-child {
    border-bottom: none;
  }
  .v-finding-head {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
    background: var(--color-surface-elevated);
  }
  .v-col-check {
    display: inline-flex;
    justify-content: center;
  }
  .v-col-file {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.7rem;
    color: var(--color-text-secondary);
  }
  .v-col-desc {
    color: var(--color-text-secondary);
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .v-user-note {
    color: var(--color-text-muted);
    font-size: 0.7rem;
    font-style: italic;
  }
  .v-col-send {
    display: inline-flex;
    justify-content: flex-end;
  }
  .v-send-btn {
    font-size: 0.66rem;
    padding: 0.12rem 0.4rem;
    border-radius: 5px;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    color: var(--color-text-secondary);
    cursor: pointer;
    white-space: nowrap;
  }
  .v-send-btn:hover:not(:disabled) {
    border-color: var(--color-accent);
    color: var(--color-text-primary);
  }
  .v-send-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .v-sev-badge {
    display: inline-block;
    padding: 0.1rem 0.4rem;
    border-radius: 5px;
    font-size: 0.66rem;
    text-transform: capitalize;
    font-weight: 600;
  }
  .sev-error { color: var(--color-error, #ef4444); background: color-mix(in srgb, var(--color-error, #ef4444) 16%, transparent); }
  .sev-warning { color: rgb(251, 191, 36); background: rgba(251, 191, 36, 0.16); }
  .sev-info { color: var(--color-text-muted); background: var(--color-surface-elevated); }
  .v-action-badge {
    display: inline-block;
    padding: 0.1rem 0.4rem;
    border-radius: 5px;
    font-size: 0.66rem;
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
  .v-add-finding {
    display: flex;
    gap: 0.5rem;
  }
  .v-add-finding .v-input {
    flex: 1;
  }
  .v-input,
  .v-textarea {
    width: 100%;
    padding: 0.35rem 0.5rem;
    background: var(--color-background);
    color: var(--color-text-primary);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 0.76rem;
    font-family: inherit;
  }
  .v-input:focus,
  .v-textarea:focus {
    outline: none;
    border-color: var(--color-accent);
  }
  .v-textarea {
    resize: vertical;
  }
  .v-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .v-field-label {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
  }
  .v-ship-refs {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .v-ref {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.72rem;
    color: rgb(96, 165, 250);
    background: rgba(96, 165, 250, 0.1);
    padding: 0.03rem 0.35rem;
    border-radius: 4px;
  }
  .v-arrow {
    color: var(--color-text-muted);
  }
  .v-gate-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  /* Outcome */
  .v-outcome {
    padding: 0.45rem 0.6rem;
    border-radius: 7px;
    font-weight: 500;
  }
  .v-outcome[data-status='passed'] {
    background: color-mix(in srgb, var(--color-success, #22c55e) 15%, transparent);
    color: var(--color-success, #22c55e);
  }
  .v-outcome[data-status='failed'] {
    background: color-mix(in srgb, var(--color-error, #ef4444) 15%, transparent);
    color: var(--color-error, #ef4444);
  }
  .v-outcome[data-status='cancelled'] {
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
  }
  .v-pr-hint {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .v-pr-link {
    color: var(--color-accent);
    background: none;
    border: none;
    cursor: pointer;
    font-weight: 600;
    padding: 0;
  }
  .v-pr-link:hover {
    text-decoration: underline;
  }

  /* Live agent activity */
  .v-activity-live {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    padding: 0.35rem 0.55rem;
    border-radius: 7px;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    color: var(--color-text-secondary);
    font-size: 0.72rem;
  }
  .v-activity-live .v-spinner {
    color: var(--color-accent);
  }
  .v-activity-role {
    flex-shrink: 0;
    font-size: 0.66rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--color-accent);
  }
  .v-activity-line {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .v-activity-line.is-text {
    font-family: inherit;
    font-style: italic;
  }
  .v-activity-feed {
    display: flex;
    flex-direction: column;
    max-height: 240px;
    overflow-y: auto;
    padding: 0.35rem 0.45rem;
    background: var(--color-background);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 0.7rem;
    line-height: 1.45;
  }
  .v-activity-row {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    min-width: 0;
    padding: 0.08rem 0;
  }
  .v-activity-ts {
    flex-shrink: 0;
    color: var(--color-text-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.64rem;
  }
  .v-activity-tool {
    flex-shrink: 0;
    font-weight: 600;
    color: var(--color-text-primary);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .v-activity-detail {
    min-width: 0;
    color: var(--color-text-secondary);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    word-break: break-all;
  }
  .v-activity-msg {
    min-width: 0;
    color: var(--color-text-secondary);
    font-style: italic;
    word-break: break-word;
  }

  /* Log */
  .v-log-details {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .v-details-toggle {
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
  .v-details-toggle:hover {
    color: var(--color-text-secondary);
  }
  .v-chevron {
    width: 12px;
    height: 12px;
    transition: transform 0.15s ease;
  }
  .v-chevron.open {
    transform: rotate(90deg);
  }
</style>
