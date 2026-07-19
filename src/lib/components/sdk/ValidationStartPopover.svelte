<script lang="ts">
  import {
    validation,
    seedRunOptions,
    saveRunOptions,
    VALIDATION_STEP_ORDER,
    type RunOptions,
    type StepName,
  } from '$lib/stores/validation';
  import { buildValidationIntent } from '$lib/utils/validationIntent';
  import {
    getEnabledModels,
    isAutoModel,
    modelSupportsEffort,
    DEFAULT_MODEL_ID,
  } from '$lib/utils/models';
  import type { SdkSession, EffortLevel } from '$lib/stores/sdkSessions';
  import { settings } from '$lib/stores/settings';
  import EffortToggle from '$lib/components/EffortToggle.svelte';

  let {
    session,
    cwd,
    repoId,
    repoSteps = null,
    onClose,
  }: {
    session: SdkSession;
    cwd: string;
    repoId: string | undefined;
    repoSteps?: string[] | null;
    onClose: () => void;
  } = $props();

  const STEP_META: Record<StepName, { label: string; description: string }> = {
    simplify: {
      label: 'Simplify',
      description: 'Headless agent cleans up the changed code (finds & fixes, no gates)',
    },
    review: { label: 'Review', description: 'Code review of the branch diff' },
    test: { label: 'Test', description: 'Run tests & gather evidence' },
    docs: { label: 'Docs', description: 'Find documentation this change made stale' },
    lint: { label: 'Lint', description: 'Run linters / formatters on changed files' },
    ship: { label: 'Ship', description: 'Commit, push, and open a pull request' },
    ci: { label: 'CI', description: 'Wait for CI checks to pass' },
  };

  // Seed the form (localStorage last-used → repo overrides → global defaults).
  let seeded: RunOptions = $state(
    seedRunOptions({ repoId, repoSteps, defaults: $settings.validation }),
  );

  // Reviewer choices come from the user's ACTIVE Claude models (same source as
  // the session model selector), plus "Session model". Computed once at mount —
  // the popover is short-lived.
  const models = getEnabledModels($settings.enabled_models);
  // The simplify agent can run on any active provider's model (the sidecar
  // routes Claude models to the SDK rail, GPT/Codex models to a Codex thread).
  const simplifyModels = [
    ...($settings.enabled_providers.claude ? getEnabledModels($settings.enabled_models, 'claude') : []),
    ...($settings.enabled_providers.openai
      ? getEnabledModels($settings.enabled_openai_models, 'openai')
      : []),
  ];

  let selectedSteps = $state<Set<StepName>>(new Set(seeded.steps));
  let reviewerModel = $state(
    seeded.reviewerModel === 'session' || models.some((m) => m.id === seeded.reviewerModel)
      ? seeded.reviewerModel
      : 'session',
  );
  let simplifyModel = $state(
    seeded.simplifyModel && simplifyModels.some((m) => m.id === seeded.simplifyModel)
      ? seeded.simplifyModel
      : 'session',
  );
  // Effort is always on for the reviewer; older saved options may carry null.
  let reviewerEffort = $state<EffortLevel>(
    (seeded.reviewerEffort || $settings.validation.reviewer_effort || 'medium') as EffortLevel,
  );
  let adversarialVerify = $state(seeded.adversarialVerify);

  // The model the effort toggle caps itself against (resolved like the run will be).
  const effortModelId = $derived(
    reviewerModel === 'session'
      ? session.model && !isAutoModel(session.model)
        ? session.model
        : ''
      : reviewerModel,
  );
  let starting = $state(false);
  let error = $state<string | null>(null);

  function toggleStep(step: StepName) {
    const next = new Set(selectedSteps);
    if (next.has(step)) next.delete(step);
    else next.add(step);
    selectedSteps = next;
  }

  let orderedSelected = $derived(VALIDATION_STEP_ORDER.filter((s) => selectedSteps.has(s)));
  let canStart = $derived(orderedSelected.length > 0 && !starting);

  /**
   * The backend cannot see the live session's model, so "session" must be
   * resolved to a concrete Claude model id here before we call startRun. The
   * user's "session" preference is still persisted (so it tracks the session's
   * model over time); only the id sent to the run is resolved.
   */
  function resolveReviewerModel(choice: string): string {
    if (choice !== 'session') return choice;
    const sessionModel = session.model;
    if (sessionModel && !isAutoModel(sessionModel)) return sessionModel;
    // Unknown / Auto session model — fall back to the global default.
    const fallback = $settings.validation.reviewer_model;
    return fallback && fallback !== 'session' ? fallback : DEFAULT_MODEL_ID;
  }

  /**
   * Like resolveReviewerModel, but for the simplify agent — the session's model
   * is used as-is whatever its provider (a Codex session gets a Codex agent).
   */
  function resolveSimplifyModel(choice: string): string {
    if (choice !== 'session') return choice;
    const sessionModel = session.model;
    if (sessionModel && !isAutoModel(sessionModel)) return sessionModel;
    return resolveReviewerModel('session');
  }

  async function start() {
    if (!canStart) return;
    starting = true;
    error = null;
    // Effort is dropped when off or when the resolved model doesn't support it.
    const effortSupported = !effortModelId || modelSupportsEffort(effortModelId);
    const base = {
      steps: orderedSelected,
      reviewerEffort: reviewerEffort && effortSupported ? reviewerEffort : null,
      adversarialVerify,
      baseBranch: seeded.baseBranch ?? null,
    };
    // Persist the user's raw choice (may be "session"); send the resolved id.
    const persisted: RunOptions = { ...base, reviewerModel, simplifyModel };
    const runOptions: RunOptions = {
      ...base,
      reviewerModel: resolveReviewerModel(reviewerModel),
      simplifyModel: resolveSimplifyModel(simplifyModel),
    };
    try {
      saveRunOptions(repoId, persisted);
      const intent = buildValidationIntent(session);
      await validation.startRun(session.id, cwd, repoId, intent, runOptions);
      onClose();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      starting = false;
    }
  }
</script>

<div class="vsp" role="dialog" aria-label="Start validation run">
  <div class="vsp-header">
    <span class="vsp-title">Validate this branch</span>
    <button class="vsp-close" onclick={onClose} title="Close" aria-label="Close">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  </div>

  <div class="vsp-section">
    <div class="vsp-section-label">Steps</div>
    <div class="vsp-steps">
      {#each VALIDATION_STEP_ORDER as step (step)}
        <label class="vsp-step" class:on={selectedSteps.has(step)}>
          <input
            type="checkbox"
            checked={selectedSteps.has(step)}
            onchange={() => toggleStep(step)}
          />
          <span class="vsp-step-text">
            <span class="vsp-step-name">{STEP_META[step].label}</span>
            <span class="vsp-step-desc">{STEP_META[step].description}</span>
          </span>
        </label>
      {/each}
    </div>
  </div>

  {#if selectedSteps.has('simplify')}
    <div class="vsp-section">
      <label class="vsp-section-label" for="vsp-simplify-model">Simplify model</label>
      <select id="vsp-simplify-model" class="vsp-select" bind:value={simplifyModel}>
        <option value="session">Session model</option>
        {#each simplifyModels as m (m.id)}
          <option value={m.id}>{m.label}</option>
        {/each}
      </select>
    </div>
  {/if}

  <div class="vsp-section vsp-grid">
    <div class="vsp-field">
      <label class="vsp-section-label" for="vsp-model">Reviewer model</label>
      <select id="vsp-model" class="vsp-select" bind:value={reviewerModel}>
        <option value="session">Session model</option>
        {#each models as m (m.id)}
          <option value={m.id}>{m.label}</option>
        {/each}
      </select>
    </div>
    <div class="vsp-field">
      <span class="vsp-section-label">Effort</span>
      <div class="vsp-effort">
        <EffortToggle
          effortLevel={reviewerEffort}
          onchange={(l) => (reviewerEffort = l)}
          modelId={effortModelId}
          size="md"
        />
      </div>
    </div>
  </div>

  <label class="vsp-toggle-row">
    <input type="checkbox" bind:checked={adversarialVerify} />
    <span class="vsp-toggle-text">
      <span>Adversarial verify</span>
      <span class="vsp-step-desc">Try to refute each error finding before it gates.</span>
    </span>
  </label>

  {#if error}
    <div class="vsp-error">{error}</div>
  {/if}

  <div class="vsp-actions">
    <button class="vsp-btn" onclick={onClose} disabled={starting}>Cancel</button>
    <button class="vsp-btn vsp-btn-primary" onclick={start} disabled={!canStart}>
      {starting ? 'Starting…' : `Start (${orderedSelected.length})`}
    </button>
  </div>
</div>

<style>
  .vsp {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    width: 320px;
    padding: 0.85rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
    font-size: 0.8rem;
  }
  .vsp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .vsp-title {
    font-weight: 600;
    color: var(--color-text-primary);
  }
  .vsp-close {
    display: inline-flex;
    padding: 0.15rem;
    color: var(--color-text-muted);
    border-radius: 4px;
  }
  .vsp-close:hover {
    color: var(--color-text-primary);
    background: var(--color-border);
  }
  .vsp-close svg {
    width: 15px;
    height: 15px;
  }
  .vsp-section {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .vsp-section-label {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
  }
  .vsp-steps {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .vsp-step {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.3rem 0.4rem;
    border-radius: 6px;
    cursor: pointer;
  }
  .vsp-step:hover {
    background: var(--color-surface-elevated);
  }
  .vsp-step input {
    margin-top: 0.15rem;
  }
  .vsp-step-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .vsp-step-name {
    color: var(--color-text-primary);
    font-weight: 500;
  }
  .vsp-step.on .vsp-step-name {
    color: var(--color-accent);
  }
  .vsp-step-desc {
    color: var(--color-text-muted);
    font-size: 0.72rem;
    line-height: 1.3;
  }
  .vsp-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }
  .vsp-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .vsp-select {
    padding: 0.35rem 0.4rem;
    background: var(--color-background);
    color: var(--color-text-primary);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 0.76rem;
  }
  .vsp-select:focus {
    outline: none;
    border-color: var(--color-accent);
  }
  .vsp-effort {
    display: flex;
    align-items: center;
    min-height: 30px;
  }
  .vsp-toggle-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    cursor: pointer;
  }
  .vsp-toggle-row input {
    margin-top: 0.15rem;
  }
  .vsp-toggle-text {
    display: flex;
    flex-direction: column;
    color: var(--color-text-primary);
  }
  .vsp-error {
    color: var(--color-error, #ef4444);
    background: color-mix(in srgb, var(--color-error, #ef4444) 12%, transparent);
    border-radius: 6px;
    padding: 0.35rem 0.5rem;
    font-size: 0.72rem;
  }
  .vsp-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .vsp-btn {
    padding: 0.35rem 0.8rem;
    background: var(--color-surface-elevated);
    color: var(--color-text-primary);
    border: 1px solid var(--color-border);
    border-radius: 7px;
    font-size: 0.76rem;
    font-weight: 500;
    cursor: pointer;
  }
  .vsp-btn:hover:not(:disabled) {
    border-color: var(--color-accent);
  }
  .vsp-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .vsp-btn-primary {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: #fff;
  }
  .vsp-btn-primary:hover:not(:disabled) {
    filter: brightness(1.08);
  }
</style>
