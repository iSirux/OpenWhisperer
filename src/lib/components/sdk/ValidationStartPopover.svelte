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
    getProviderForModel,
    isAutoModel,
    modelSupportsEffort,
    DEFAULT_MODEL_ID,
    type SdkProvider,
  } from '$lib/utils/models';
  import type { SdkSession, EffortLevel } from '$lib/stores/sdkSessions';
  import { settings } from '$lib/stores/settings';
  import { repos } from '$lib/stores/repos';
  import {
    allowedAccountsForRepo,
    defaultAccountIdForRepo,
    isDefaultAccountId,
  } from '$lib/utils/accounts';
  import EffortToggle from '$lib/components/EffortToggle.svelte';
  import SendTimingIcon from '$lib/components/sdk/SendTimingIcon.svelte';
  import { modifierCombo } from '$lib/stores/ctrlHint';
  import { sendTimingFromEvent, type SendTiming } from '$lib/utils/sendTiming';

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

  // One provider/model/effort/account configuration drives every validation agent.
  const claudeModels = $settings.enabled_providers.claude
    ? getEnabledModels($settings.enabled_models, 'claude')
    : [];
  const openaiModels = $settings.enabled_providers.openai
    ? getEnabledModels($settings.enabled_openai_models, 'openai')
    : [];
  const sessionProvider = $derived(session.provider ?? getProviderForModel(session.model));
  const savedProvider = seeded.reviewerModel === 'session'
    ? (session.provider ?? getProviderForModel(session.model))
    : getProviderForModel(seeded.reviewerModel);
  let reviewerProvider = $state<SdkProvider>(
    savedProvider === 'openai' && $settings.enabled_providers.openai
      ? 'openai'
      : savedProvider === 'claude' && $settings.enabled_providers.claude
        ? 'claude'
        : $settings.enabled_providers.openai
          ? 'openai'
          : 'claude',
  );
  const showProviderChoice = $derived(
    $settings.enabled_providers.claude && $settings.enabled_providers.openai,
  );
  const models = $derived(reviewerProvider === 'openai' ? openaiModels : claudeModels);

  let selectedSteps = $state<Set<StepName>>(new Set(seeded.steps));
  let reviewerModel = $state(
    (seeded.reviewerModel === 'session' && reviewerProvider === sessionProvider) ||
      models.some((m) => m.id === seeded.reviewerModel)
      ? seeded.reviewerModel
      : models[0]?.id ?? 'session',
  );
  // Effort is always on; older saved options may carry null.
  let reviewerEffort = $state<EffortLevel>(
    (seeded.reviewerEffort || $settings.validation.reviewer_effort || 'medium') as EffortLevel,
  );
  let adversarialVerify = $state(seeded.adversarialVerify);
  const repo = $derived(
    $repos.list.find((r) => r.id === repoId) ??
      $repos.list.find((r) => cwd.replaceAll('\\', '/').startsWith(r.path.replaceAll('\\', '/'))) ??
      null,
  );
  const accountProvider = $derived(reviewerProvider === 'openai' ? 'OpenAI' : 'Claude');
  const accounts = $derived(allowedAccountsForRepo($settings.accounts, repo, accountProvider));
  let reviewerAccountId = $state<string | undefined>(seeded.reviewerAccountId ?? undefined);

  $effect(() => {
    const sessionChoiceIsValid =
      reviewerModel === 'session' && reviewerProvider === sessionProvider;
    if (sessionChoiceIsValid || models.some((model) => model.id === reviewerModel)) return;
    reviewerModel = models[0]?.id ??
      (reviewerProvider === 'openai' ? $settings.openai_model : $settings.default_model);
  });

  $effect(() => {
    const ids = accounts.map((account) => account.id);
    if (reviewerAccountId && ids.includes(reviewerAccountId)) return;
    reviewerAccountId =
      defaultAccountIdForRepo($settings.accounts, repo, accountProvider) ?? accounts[0]?.id;
  });

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

  function selectProvider(provider: SdkProvider) {
    if (provider === reviewerProvider) return;
    reviewerProvider = provider;
    reviewerModel = provider === 'openai'
      ? ($settings.openai_model || openaiModels[0]?.id || DEFAULT_MODEL_ID)
      : ($settings.default_model || claudeModels[0]?.id || DEFAULT_MODEL_ID);
    reviewerAccountId = undefined;
  }

  let orderedSelected = $derived(VALIDATION_STEP_ORDER.filter((s) => selectedSteps.has(s)));
  let canStart = $derived(orderedSelected.length > 0 && !starting);

  /**
   * The backend cannot see the live session's model, so "session" must be
   * resolved to a concrete model id here before we call startRun. The
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
   * Start the run with the same send-timing modifiers as Send / record / compact:
   * plain/Ctrl = now, Shift = when this session is idle, Ctrl+Shift = when the
   * repo/worktree is idle, Ctrl+Shift+Alt = on the next 5h reset. Deferred timings
   * park the run on the Smart Queue with the model/intent snapshotted now.
   */
  async function start(timing: SendTiming = 'now') {
    if (!canStart) return;
    starting = true;
    error = null;
    // Effort is dropped when off or when the resolved model doesn't support it.
    const effortSupported = !effortModelId || modelSupportsEffort(effortModelId);
    const base = {
      steps: orderedSelected,
      reviewerEffort: reviewerEffort && effortSupported ? reviewerEffort : null,
      reviewerAccountId:
        reviewerAccountId && !isDefaultAccountId(reviewerAccountId)
          ? reviewerAccountId
          : null,
      adversarialVerify,
      baseBranch: seeded.baseBranch ?? null,
    };
    // Persist the user's raw choice (may be "session"); send the resolved id.
    const persisted: RunOptions = { ...base, reviewerModel };
    const resolvedModel = resolveReviewerModel(reviewerModel);
    const runOptions: RunOptions = {
      ...base,
      reviewerModel: resolvedModel,
    };
    try {
      saveRunOptions(repoId, persisted);
      const intent = buildValidationIntent(session);
      const provider = reviewerProvider;
      const accountId = runOptions.reviewerAccountId ?? undefined;
      await validation.scheduleRun(
        session.id,
        cwd,
        repoId,
        intent,
        runOptions,
        timing,
        provider,
        accountId,
      );
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

  <div class="vsp-section vsp-grid">
    {#if showProviderChoice}
      <div class="vsp-field">
        <span class="vsp-section-label">Provider</span>
        <div class="vsp-provider">
          <button class:active={reviewerProvider === 'claude'} onclick={() => selectProvider('claude')}>Claude</button>
          <button class:active={reviewerProvider === 'openai'} onclick={() => selectProvider('openai')}>Codex</button>
        </div>
      </div>
    {:else}
      <div class="vsp-field">
        <span class="vsp-section-label">Provider</span>
        <div class="vsp-provider-label">{reviewerProvider === 'openai' ? 'Codex' : 'Claude'}</div>
      </div>
    {/if}
    <div class="vsp-field">
      <label class="vsp-section-label" for="vsp-model">Model</label>
      <select id="vsp-model" class="vsp-select" bind:value={reviewerModel}>
        {#if reviewerProvider === sessionProvider}
          <option value="session">Session model</option>
        {/if}
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

  {#if accounts.length > 1}
    <div class="vsp-section">
      <label class="vsp-section-label" for="vsp-account">Account</label>
      <select id="vsp-account" class="vsp-select" bind:value={reviewerAccountId}>
        {#each accounts as account (account.id)}
          <option value={account.id}>{account.label}</option>
        {/each}
      </select>
    </div>
  {/if}

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
    <button
      class="vsp-btn vsp-btn-primary vsp-start"
      onclick={(e) => start(sendTimingFromEvent(e))}
      disabled={!canStart}
      title={'Start now — Shift+click: when this session is idle — Ctrl+Shift+click: when the repo/worktree is idle — Ctrl+Shift+Alt+click: on the next 5h reset'}
    >
      {starting ? 'Starting…' : `Start (${orderedSelected.length})`}
      {#if $modifierCombo === 'shift'}
        <span class="vsp-hint-badge" aria-hidden="true"><SendTimingIcon timing="session_idle" /></span>
      {:else if $modifierCombo === 'ctrl+shift'}
        <span class="vsp-hint-badge" aria-hidden="true"><SendTimingIcon timing="repo_idle" /></span>
      {:else if $modifierCombo === 'ctrl+shift+alt'}
        <span class="vsp-hint-badge" aria-hidden="true"><SendTimingIcon timing="reset_5h" /></span>
      {/if}
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
  .vsp-provider {
    display: flex;
    min-height: 30px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
  }
  .vsp-provider button {
    flex: 1;
    color: var(--color-text-secondary);
    font-size: 0.74rem;
  }
  .vsp-provider button.active {
    color: #fff;
    background: var(--color-accent);
  }
  .vsp-provider button + button {
    border-left: 1px solid var(--color-border);
  }
  .vsp-provider-label {
    display: flex;
    align-items: center;
    min-height: 30px;
    padding: 0 0.45rem;
    color: var(--color-text-secondary);
    background: var(--color-background);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 0.74rem;
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
  .vsp-start {
    position: relative;
  }
  /* Modifier-held send-timing hint badge (mirrors Send / record / compact). */
  .vsp-hint-badge {
    position: absolute;
    top: -0.4rem;
    right: -0.4rem;
    width: 0.95rem;
    height: 0.95rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-accent);
    color: #fff;
    border-radius: 0.25rem;
    z-index: 5;
    pointer-events: none;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  }
</style>
