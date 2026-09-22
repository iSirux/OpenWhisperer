<script lang="ts">
  /**
   * Main-pane editor for a single Schedule (the pile's `PileDetailView` is the
   * model). Everything is written straight through `schedules.update`, which
   * recomputes `nextFireAt` whenever the `when` spec changes — so no caller here
   * has to touch `computeNextFire` except for the read-only previews.
   */
  import {
    schedules,
    describeScheduleSpec,
    selectedScheduleId,
    type RecurrenceRule,
    type Schedule,
    type ScheduleMessageTarget,
    type ScheduleSessionTarget,
  } from '$lib/stores/schedules';
  import {
    sdkSessions,
    activeSdkSessionId,
    normalizeEffortLevel,
    type EffortLevel,
  } from '$lib/stores/sdkSessions';
  import { repos, findRepoById, isRepoActive } from '$lib/stores/repos';
  import { settings } from '$lib/stores/settings';
  import { navigation } from '$lib/stores/navigation';
  import { formatScheduleTarget } from '$lib/utils/duration';
  import { getProviderForModel, isAutoModel } from '$lib/utils/models';
  import { accountsForProvider, isDefaultAccountId } from '$lib/utils/accounts';
  import RepoSelector from '../RepoSelector.svelte';
  import ModelSelector from '../ModelSelector.svelte';
  import EffortToggle from '../EffortToggle.svelte';
  import ConfirmDialog from '../ConfirmDialog.svelte';
  import ScheduleTimePicker from './ScheduleTimePicker.svelte';
  import RecurrenceEditor from './RecurrenceEditor.svelte';

  interface Props {
    schedule: Schedule;
  }

  let { schedule }: Props = $props();

  let editedLabel = $state('');
  let editedPrompt = $state('');
  let lastScheduleId = $state('');
  let confirmDeleteOpen = $state(false);
  let running = $state(false);

  // Reset the local edit buffers when switching schedules; while staying on one,
  // pick up background changes (a fired run rewriting the item) only when the
  // user isn't typing into that field.
  $effect(() => {
    if (schedule.id !== lastScheduleId) {
      lastScheduleId = schedule.id;
      editedLabel = schedule.label;
      editedPrompt = schedule.prompt;
      return;
    }
    if (
      schedule.prompt !== editedPrompt &&
      document.activeElement?.tagName !== 'TEXTAREA'
    ) {
      editedPrompt = schedule.prompt;
    }
  });

  const sessionTarget = $derived(
    schedule.target.kind === 'session' ? (schedule.target as ScheduleSessionTarget) : null
  );
  const messageTarget = $derived(
    schedule.target.kind === 'message' ? (schedule.target as ScheduleMessageTarget) : null
  );

  const targetRepo = $derived(
    sessionTarget ? findRepoById($repos.list, sessionTarget.repoId) : null
  );
  const boundSession = $derived(
    messageTarget ? $sdkSessions.find((s) => s.id === messageTarget.sessionId) ?? null : null
  );

  // Account helpers speak the config-cased provider ("Claude"/"OpenAI"); the
  // schedule target stores the lowercase session provider.
  const accountProvider = $derived(sessionTarget?.provider === 'openai' ? 'OpenAI' : 'Claude');
  const availableAccounts = $derived(accountsForProvider($settings.accounts, accountProvider));

  const isRecurring = $derived(schedule.when.kind === 'recurring');
  const currentRule = $derived<RecurrenceRule>(
    schedule.when.kind === 'recurring'
      ? schedule.when.rule
      : { time: { hour: 9, minute: 0 }, pattern: { kind: 'weekly', days: [1, 2, 3, 4, 5] } }
  );

  const RUN_STATUS_CLASS: Record<string, string> = {
    ok: 'text-emerald-400',
    failed: 'text-red-400',
    skipped: 'text-text-muted',
    deferred: 'text-amber-400',
  };

  function saveLabel() {
    const label = editedLabel.trim();
    if (label !== schedule.label) schedules.update(schedule.id, { label });
  }

  function savePrompt() {
    if (editedPrompt !== schedule.prompt) schedules.update(schedule.id, { prompt: editedPrompt });
  }

  function patchSessionTarget(patch: Partial<ScheduleSessionTarget>) {
    if (!sessionTarget) return;
    schedules.update(schedule.id, { target: { ...sessionTarget, ...patch } });
  }

  function patchMessageTarget(patch: Partial<ScheduleMessageTarget>) {
    if (!messageTarget) return;
    schedules.update(schedule.id, { target: { ...messageTarget, ...patch } });
  }

  function handleRepoChange(path: string) {
    const repo = ($repos.list || []).filter(isRepoActive).find((r) => r.path === path);
    patchSessionTarget({ repoId: repo?.id ?? '' });
  }

  function handleProviderChange(provider: 'claude' | 'openai') {
    if (!sessionTarget || sessionTarget.provider === provider) return;
    // Switching provider invalidates both the model and the pinned account.
    const model =
      provider === 'openai'
        ? $settings.openai_model || 'gpt-5.6-terra'
        : $settings.default_model || 'claude-opus-5-5';
    patchSessionTarget({ provider, model, accountId: undefined });
  }

  function handleModelChange(model: string) {
    // Keep the stored provider consistent with the picked model (Auto stays on
    // the current provider — it resolves at fire time).
    patchSessionTarget({
      model,
      provider: isAutoModel(model)
        ? (sessionTarget?.provider ?? 'claude')
        : getProviderForModel(model),
    });
  }

  function handleAccountChange(id: string) {
    patchSessionTarget({ accountId: !id || isDefaultAccountId(id) ? undefined : id });
  }

  /** Switch between the one-shot and recurring specs, keeping the other side's shape sane. */
  function setTimingMode(mode: 'at' | 'recurring') {
    if (mode === (isRecurring ? 'recurring' : 'at')) return;
    if (mode === 'recurring') {
      schedules.update(schedule.id, { when: { kind: 'recurring', rule: currentRule } });
    } else {
      // Seed from the next recurring occurrence when it's still ahead, else an
      // hour out — a one-shot seeded in the past would be spent on arrival.
      const fallback = Date.now() + 3_600_000;
      const next = schedule.nextFireAt;
      schedules.update(schedule.id, {
        when: { kind: 'at', at: next != null && next > Date.now() ? next : fallback },
      });
    }
  }

  async function runNow() {
    running = true;
    try {
      await schedules.runNow(schedule.id);
    } finally {
      running = false;
    }
  }

  function deleteSchedule() {
    confirmDeleteOpen = false;
    const id = schedule.id;
    selectedScheduleId.set(null);
    schedules.remove(id);
  }

  /** Activate a launched session in the main pane (same path the pile detail view uses). */
  function openSession(sessionId: string) {
    selectedScheduleId.set(null);
    activeSdkSessionId.set(sessionId);
    sdkSessions.markAsRead(sessionId);
    navigation.setView('sessions');
  }
</script>

<div class="flex-1 flex flex-col overflow-hidden">
  <!-- Header -->
  <div class="px-4 py-3 border-b border-border flex items-center gap-3">
    <div class="flex-1 min-w-0">
      <input
        type="text"
        class="w-full bg-transparent text-base font-medium text-text-primary focus:outline-none focus:border-b focus:border-accent"
        placeholder="Schedule label"
        bind:value={editedLabel}
        onblur={saveLabel}
      />
      <div class="flex items-center gap-2 mt-0.5 text-xs text-text-muted">
        <span>{describeScheduleSpec(schedule.when)}</span>
        {#if schedule.enabled && schedule.nextFireAt != null}
          <span class="text-accent">· next {formatScheduleTarget(schedule.nextFireAt)}</span>
        {:else if !schedule.enabled}
          <span>· paused</span>
        {:else}
          <span>· no upcoming run</span>
        {/if}
        {#if schedule.runCount > 0}
          <span>· {schedule.runCount} run{schedule.runCount === 1 ? '' : 's'}</span>
        {/if}
      </div>
    </div>
    <label
      class="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer shrink-0"
      title={schedule.enabled ? 'Enabled — click to pause' : 'Paused — click to enable'}
    >
      <input
        type="checkbox"
        class="accent-accent"
        checked={schedule.enabled}
        onchange={(e) => schedules.setEnabled(schedule.id, e.currentTarget.checked)}
      />
      Enabled
    </label>
    <button
      class="px-2.5 py-1 text-xs rounded border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 transition-colors shrink-0 disabled:opacity-50"
      disabled={running}
      onclick={runNow}
      title="Fire once now — doesn't consume the next occurrence or count toward the run limit"
    >
      {running ? 'Running…' : 'Run now'}
    </button>
    <button
      class="px-2.5 py-1 text-xs rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
      onclick={() => (confirmDeleteOpen = true)}
    >
      Delete
    </button>
    <button
      class="px-2.5 py-1 text-xs rounded border border-border text-text-secondary hover:bg-surface-elevated transition-colors shrink-0"
      onclick={() => selectedScheduleId.set(null)}
    >
      Close
    </button>
  </div>

  <div class="flex-1 overflow-y-auto p-4 space-y-4 max-w-3xl w-full mx-auto">
    {#if schedule.enabled && !schedule.prompt.trim()}
      <div class="p-2.5 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-400">
        This schedule has no prompt — add one before it fires.
      </div>
    {/if}

    <!-- Prompt -->
    <div>
      <label class="text-xs font-medium text-text-secondary block mb-1" for="schedule-prompt">
        Prompt
      </label>
      <textarea
        id="schedule-prompt"
        class="w-full min-h-32 p-3 text-sm bg-surface-elevated border border-border rounded text-text-primary resize-y focus:outline-none focus:border-accent"
        bind:value={editedPrompt}
        onblur={savePrompt}
        placeholder="What should the agent do when this fires?"
      ></textarea>
    </div>

    <!-- Target -->
    <div class="p-3 bg-surface-elevated rounded border border-border space-y-3">
      <p class="text-xs font-medium text-text-secondary">
        {sessionTarget ? 'Launches a new session' : 'Sends into an existing session'}
      </p>

      {#if sessionTarget}
        <div>
          <span class="text-[11px] text-text-muted block mb-1">Repository</span>
          <RepoSelector
            cwd={targetRepo?.path ?? ''}
            onchange={handleRepoChange}
            size="md"
            maxVisible={3}
            emptyOption="none"
            dropdownDirection="down"
          />
          {#if !targetRepo}
            <p class="text-[11px] text-amber-400 mt-1">
              No repository selected — the schedule will fail when it fires.
            </p>
          {/if}
        </div>

        <div class="flex items-center gap-3 flex-wrap">
          <div>
            <span class="text-[11px] text-text-muted block mb-1">Provider</span>
            <div class="flex gap-1">
              <button
                class="px-2.5 py-1 rounded text-xs font-medium transition-colors {sessionTarget.provider ===
                'claude'
                  ? 'bg-accent text-white'
                  : 'bg-surface text-text-secondary hover:bg-background'}"
                onclick={() => handleProviderChange('claude')}
              >
                Claude
              </button>
              <button
                class="px-2.5 py-1 rounded text-xs font-medium transition-colors {sessionTarget.provider ===
                'openai'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-surface text-text-secondary hover:bg-background'}"
                onclick={() => handleProviderChange('openai')}
              >
                Codex
              </button>
            </div>
          </div>

          <div>
            <span class="text-[11px] text-text-muted block mb-1">Model</span>
            <ModelSelector
              model={sessionTarget.model}
              provider={sessionTarget.provider}
              size="md"
              onchange={handleModelChange}
            />
          </div>

          <div>
            <span class="text-[11px] text-text-muted block mb-1">Effort</span>
            <EffortToggle
              effortLevel={normalizeEffortLevel(sessionTarget.effortLevel)}
              modelId={sessionTarget.model}
              isAutoModel={isAutoModel(sessionTarget.model)}
              size="md"
              onchange={(level: EffortLevel) => patchSessionTarget({ effortLevel: level })}
            />
          </div>
        </div>

        <div class="flex items-center gap-4 flex-wrap">
          <label class="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              class="accent-accent"
              checked={sessionTarget.useWorktree}
              onchange={(e) => patchSessionTarget({ useWorktree: e.currentTarget.checked })}
            />
            Run in a new worktree
          </label>

          {#if sessionTarget.worktreePath}
            <span class="text-xs text-text-muted truncate" title={sessionTarget.worktreePath}>
              {#if sessionTarget.useWorktree}
                Existing worktree ignored while "new worktree" is on
              {:else}
                Runs in worktree {sessionTarget.worktreePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}
                (falls back to the main checkout if it is gone)
              {/if}
              <button
                class="ml-1 underline hover:text-text-primary transition-colors"
                onclick={() => patchSessionTarget({ worktreePath: undefined })}
              >
                use main checkout
              </button>
            </span>
          {/if}

          {#if availableAccounts.length > 1}
            <label class="flex items-center gap-1.5 text-xs text-text-secondary">
              Account
              <select
                class="px-2 py-1 text-xs bg-surface border border-border rounded text-text-primary"
                value={sessionTarget.accountId ?? availableAccounts[0]?.id ?? ''}
                onchange={(e) => handleAccountChange(e.currentTarget.value)}
              >
                {#each availableAccounts as account (account.id)}
                  <option value={account.id}>{account.label}</option>
                {/each}
              </select>
            </label>
          {/if}
        </div>
      {:else if messageTarget}
        <div class="p-2 rounded border border-border bg-surface text-xs">
          {#if boundSession}
            <button
              class="text-text-primary hover:text-accent transition-colors"
              onclick={() => openSession(messageTarget.sessionId)}
            >
              {boundSession.aiMetadata?.name || 'Bound session'} · {boundSession.status}
            </button>
          {:else}
            <span class="text-text-muted">The bound session no longer exists.</span>
          {/if}
        </div>
        <label class="flex items-center gap-1.5 text-xs text-text-secondary">
          If the session is gone
          <select
            class="px-2 py-1 text-xs bg-surface border border-border rounded text-text-primary"
            value={messageTarget.ifSessionGone}
            onchange={(e) =>
              patchMessageTarget({
                ifSessionGone: e.currentTarget.value as 'skip' | 'launch_new',
              })}
          >
            <option value="skip">Skip the run</option>
            <option value="launch_new" disabled={!messageTarget.fallback}>
              Launch a new session
            </option>
          </select>
        </label>
        <p class="text-[11px] text-text-muted">
          Scheduled messages always wait for their session to finish its current turn.
        </p>
      {/if}
    </div>

    <!-- Timing -->
    <div class="p-3 bg-surface-elevated rounded border border-border space-y-3">
      <div class="flex items-center gap-2">
        <p class="text-xs font-medium text-text-secondary flex-1">Timing</p>
        <div class="flex gap-1">
          <button
            class="px-2.5 py-1 rounded text-xs font-medium transition-colors {!isRecurring
              ? 'bg-accent text-white'
              : 'bg-surface text-text-secondary hover:bg-background'}"
            onclick={() => setTimingMode('at')}
          >
            One time
          </button>
          <button
            class="px-2.5 py-1 rounded text-xs font-medium transition-colors {isRecurring
              ? 'bg-accent text-white'
              : 'bg-surface text-text-secondary hover:bg-background'}"
            onclick={() => setTimingMode('recurring')}
          >
            Recurring
          </button>
        </div>
      </div>

      {#if isRecurring}
        <RecurrenceEditor
          rule={currentRule}
          anchor={schedule.createdAt}
          runCount={schedule.runCount}
          onChange={(rule) => schedules.update(schedule.id, { when: { kind: 'recurring', rule } })}
        />
      {:else}
        {@const at = schedule.when.kind === 'at' ? schedule.when.at : null}
        <!-- Keyed on the schedule: unlike the popover call sites, this view is reused
             when the user switches schedules, and the picker seeds its input (and its
             "now" for hiding passed presets) once on mount. -->
        {#key schedule.id}
          <ScheduleTimePicker
            value={at}
            confirmLabel="Set time"
            onPick={(picked) => schedules.update(schedule.id, { when: { kind: 'at', at: picked } })}
          />
        {/key}
        {#if at != null}
          <p class="text-[11px] text-text-muted">
            Runs once at {formatScheduleTarget(at)}
            {#if schedule.nextFireAt == null}· already spent{/if}
          </p>
        {/if}
      {/if}
    </div>

    <!-- Behaviour -->
    <div class="p-3 bg-surface-elevated rounded border border-border space-y-2">
      <p class="text-xs font-medium text-text-secondary">When it fires</p>
      {#if sessionTarget}
        <label class="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            class="accent-accent"
            checked={schedule.waitForIdle}
            onchange={(e) => schedules.update(schedule.id, { waitForIdle: e.currentTarget.checked })}
          />
          Wait until the repository is idle
        </label>
      {/if}
      <label class="flex items-center gap-1.5 text-xs text-text-secondary">
        Missed while the app was closed
        <select
          class="px-2 py-1 text-xs bg-surface border border-border rounded text-text-primary"
          value={schedule.catchUp}
          onchange={(e) =>
            schedules.update(schedule.id, {
              catchUp: e.currentTarget.value as 'skip' | 'run_once',
            })}
        >
          <option value="run_once">Run once on next launch</option>
          <option value="skip">Skip</option>
        </select>
      </label>
    </div>

    <!-- Run history -->
    {#if schedule.history.length > 0}
      <div>
        <p class="text-xs font-medium text-text-secondary mb-1">Run history</p>
        <div class="space-y-1">
          {#each schedule.history as run (run.at + run.status)}
            <div
              class="flex items-center gap-2 p-2 rounded border border-border bg-surface-elevated/50 text-xs"
            >
              <span class="{RUN_STATUS_CLASS[run.status] ?? 'text-text-muted'} shrink-0 w-16">
                {run.status}
              </span>
              <span class="text-text-muted shrink-0">{new Date(run.at).toLocaleString()}</span>
              {#if run.error}
                <span class="text-text-muted truncate flex-1" title={run.error}>{run.error}</span>
              {/if}
              {#if run.sessionId}
                {@const sessionId = run.sessionId}
                <button
                  class="ml-auto text-accent hover:underline shrink-0"
                  onclick={() => openSession(sessionId)}
                >
                  Open session
                </button>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>

<ConfirmDialog
  show={confirmDeleteOpen}
  title="Delete schedule"
  message="Delete this schedule? Sessions it already launched are not affected."
  confirmLabel="Delete"
  variant="danger"
  onconfirm={deleteSchedule}
  oncancel={() => (confirmDeleteOpen = false)}
/>
