<script lang="ts">
  /**
   * Sidebar "Scheduled" tab: one card per Schedule with its pattern summary,
   * countdown to the next fire, an enable toggle, Run now, and an overflow menu
   * (Skip next / Duplicate / Delete). Selecting a card opens it in the main pane
   * (`ScheduleDetailView`), mirroring how the pile routes its items.
   */
  import {
    schedules,
    describeScheduleSpec,
    selectedScheduleId,
    type Schedule,
  } from '$lib/stores/schedules';
  import { sdkSessions, activeSdkSessionId, settingsToStoreEffort } from '$lib/stores/sdkSessions';
  import { selectedPileItemId } from '$lib/stores/pile';
  import { repos, activeRepo, findRepoById, isRepoActive } from '$lib/stores/repos';
  import { settings } from '$lib/stores/settings';
  import { navigation } from '$lib/stores/navigation';
  import { formatScheduleTarget } from '$lib/utils/duration';
  import { getProviderForModel } from '$lib/utils/models';
  import ConfirmDialog from '../ConfirmDialog.svelte';

  let openMenuId = $state<string | null>(null);
  let confirmDeleteId = $state<string | null>(null);
  let runningId = $state<string | null>(null);

  // Live countdown tick — schedules are minute-grained, so 30 s is plenty.
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  const items = $derived(
    [...$schedules].sort((a, b) => {
      // Armed schedules first (soonest first), then everything paused/spent.
      const aNext = a.enabled && a.nextFireAt != null ? a.nextFireAt : Number.POSITIVE_INFINITY;
      const bNext = b.enabled && b.nextFireAt != null ? b.nextFireAt : Number.POSITIVE_INFINITY;
      if (aNext !== bNext) return aNext - bNext;
      return b.createdAt - a.createdAt;
    })
  );

  const confirmDeleteLabel = $derived(
    confirmDeleteId ? ($schedules.find((s) => s.id === confirmDeleteId)?.label ?? '') : ''
  );

  function openSchedule(schedule: Schedule) {
    selectedScheduleId.set(schedule.id);
    selectedPileItemId.set(null);
    activeSdkSessionId.set(null);
    navigation.setView('sessions');
  }

  /**
   * Create an empty draft schedule seeded from the current repo/model defaults.
   * It starts DISABLED: an empty prompt firing unattended would launch a useless
   * session, so the user fills it in and enables it from the detail view.
   */
  function createSchedule() {
    const repo = $activeRepo ?? ($repos.list || []).filter(isRepoActive)[0] ?? null;
    const provider = $settings.sdk_provider === 'OpenAI' ? 'openai' : 'claude';
    const model =
      provider === 'openai'
        ? $settings.openai_model || 'gpt-5.6-terra'
        : $settings.default_model || 'claude-opus-5-5';
    const created = schedules.add({
      label: 'New schedule',
      enabled: false,
      prompt: '',
      target: {
        kind: 'session',
        repoId: repo?.id ?? '',
        model,
        effortLevel: settingsToStoreEffort($settings.default_effort_level ?? 'medium'),
        provider: getProviderForModel(model),
        useWorktree: false,
      },
      when: {
        kind: 'recurring',
        rule: { time: { hour: 9, minute: 0 }, pattern: { kind: 'weekly', days: [1, 2, 3, 4, 5] } },
      },
    });
    openSchedule(created);
  }

  /** "in 2h 14m" style countdown; empty when there is no target. */
  function countdown(target: number | null | undefined): string {
    if (target == null) return '';
    const diff = target - now;
    if (diff <= 0) return 'due';
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${Math.max(minutes, 1)}m`;
  }

  /** Repo name for a session target (the card's "where does this run" chip). */
  function repoLabel(repoId: string): string {
    return findRepoById($repos.list, repoId)?.name ?? 'Missing repo';
  }

  function boundSessionLabel(sessionId: string): string {
    const session = $sdkSessions.find((s) => s.id === sessionId);
    if (!session) return 'Session gone';
    return session.aiMetadata?.name || 'Bound session';
  }

  const RUN_STATUS_CLASS: Record<string, string> = {
    ok: 'text-emerald-400',
    failed: 'text-red-400',
    skipped: 'text-text-muted',
    deferred: 'text-amber-400',
  };

  async function runNow(schedule: Schedule) {
    openMenuId = null;
    runningId = schedule.id;
    try {
      await schedules.runNow(schedule.id);
    } finally {
      runningId = null;
    }
  }

  function deleteSchedule() {
    if (!confirmDeleteId) return;
    if ($selectedScheduleId === confirmDeleteId) selectedScheduleId.set(null);
    schedules.remove(confirmDeleteId);
    confirmDeleteId = null;
  }

  function duplicate(id: string) {
    openMenuId = null;
    const copy = schedules.duplicate(id);
    if (copy) selectedScheduleId.set(copy.id);
  }

  function skipNext(id: string) {
    openMenuId = null;
    schedules.skipNext(id);
  }

  function handleWindowClick(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.overflow-wrap')) return;
    openMenuId = null;
  }
</script>

<svelte:window onclick={handleWindowClick} />

<div class="flex flex-col h-full">
  <div class="p-1.5 border-b border-border shrink-0">
    <button
      class="w-full px-2 py-1.5 rounded text-xs font-medium bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
      onclick={createSchedule}
    >
      + New schedule
    </button>
  </div>

  <div class="flex-1 overflow-y-auto">
    {#if items.length === 0}
      <div class="p-4 text-center text-xs text-text-muted">
        <p class="mb-1 font-medium text-text-secondary">No schedules yet</p>
        <p>
          Create one here, or use “Recurring…” in a session's send menu to repeat a
          prompt on a rule.
        </p>
      </div>
    {:else}
      <div class="flex flex-col gap-1 p-1.5">
        {#each items as schedule (schedule.id)}
          {@const lastRun = schedule.history[0]}
          <div
            class="rounded border p-2 cursor-pointer transition-colors {$selectedScheduleId ===
            schedule.id
              ? 'border-accent bg-accent/10'
              : 'border-border bg-surface-elevated/50 hover:bg-surface-elevated'}"
            class:opacity-60={!schedule.enabled}
            onclick={() => openSchedule(schedule)}
            onkeydown={(e) => e.key === 'Enter' && openSchedule(schedule)}
            role="button"
            tabindex="0"
          >
            <div class="flex items-start gap-1.5">
              <div class="flex-1 min-w-0">
                <span class="block text-xs font-medium text-text-primary truncate">
                  {schedule.label}
                </span>
                <p class="text-[11px] text-text-muted truncate mt-0.5">
                  {describeScheduleSpec(schedule.when, now)}
                </p>
              </div>

              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="flex items-center gap-1 shrink-0" onclick={(e) => e.stopPropagation()}>
                <label
                  class="flex items-center cursor-pointer"
                  title={schedule.enabled ? 'Enabled — click to pause' : 'Paused — click to enable'}
                >
                  <input
                    type="checkbox"
                    class="accent-accent"
                    checked={schedule.enabled}
                    onchange={(e) => schedules.setEnabled(schedule.id, e.currentTarget.checked)}
                  />
                </label>
                <button
                  class="p-0.5 rounded text-text-muted hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-40"
                  title="Run now (doesn't consume the next occurrence)"
                  disabled={runningId === schedule.id}
                  onclick={() => runNow(schedule)}
                  aria-label="Run now"
                >
                  <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path
                      fill-rule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z"
                      clip-rule="evenodd"
                    />
                  </svg>
                </button>
                <div class="overflow-wrap relative">
                  <button
                    class="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-surface transition-colors"
                    title="More actions"
                    aria-haspopup="menu"
                    aria-expanded={openMenuId === schedule.id}
                    onclick={() =>
                      (openMenuId = openMenuId === schedule.id ? null : schedule.id)}
                  >
                    <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                      <path
                        d="M6 10a2 2 0 11-4 0 2 2 0 014 0zM12 10a2 2 0 11-4 0 2 2 0 014 0zM18 10a2 2 0 11-4 0 2 2 0 014 0z"
                      />
                    </svg>
                  </button>
                  {#if openMenuId === schedule.id}
                    <div class="overflow-menu" role="menu">
                      <button
                        class="overflow-item"
                        role="menuitem"
                        disabled={schedule.nextFireAt == null}
                        onclick={() => skipNext(schedule.id)}
                      >
                        Skip next
                      </button>
                      <button
                        class="overflow-item"
                        role="menuitem"
                        onclick={() => duplicate(schedule.id)}
                      >
                        Duplicate
                      </button>
                      <button
                        class="overflow-item overflow-item--danger"
                        role="menuitem"
                        onclick={() => {
                          openMenuId = null;
                          confirmDeleteId = schedule.id;
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  {/if}
                </div>
              </div>
            </div>

            <div class="flex items-center gap-1.5 mt-1 flex-wrap">
              <span
                class="text-[10px] px-1.5 py-px rounded bg-surface text-text-secondary truncate max-w-[110px]"
                title={schedule.target.kind === 'message'
                  ? 'Follow-up message on a bound session'
                  : 'Launches a new session in this repository'}
              >
                {schedule.target.kind === 'message'
                  ? boundSessionLabel(schedule.target.sessionId)
                  : repoLabel(schedule.target.repoId)}
              </span>
              {#if schedule.target.kind === 'session' && !schedule.target.useWorktree && schedule.target.worktreePath}
                <span
                  class="text-[10px] px-1.5 py-px rounded bg-surface text-text-secondary truncate max-w-[110px]"
                  title="Runs in worktree {schedule.target.worktreePath}"
                >
                  ⑂ {schedule.target.worktreePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}
                </span>
              {/if}
              {#if schedule.source === 'cli'}
                <span
                  class="text-[10px] px-1 py-px rounded border border-border text-text-muted shrink-0"
                  title="Created by an agent via the ow CLI"
                >
                  CLI
                </span>
              {/if}
              {#if schedule.enabled && schedule.nextFireAt != null}
                <span
                  class="text-[10px] text-accent shrink-0"
                  title={formatScheduleTarget(schedule.nextFireAt, now)}
                >
                  in {countdown(schedule.nextFireAt)}
                </span>
              {:else if !schedule.enabled}
                <span class="text-[10px] text-text-muted shrink-0">paused</span>
              {:else}
                <span class="text-[10px] text-text-muted shrink-0">no upcoming run</span>
              {/if}
              {#if lastRun}
                <span
                  class="text-[10px] ml-auto shrink-0 {RUN_STATUS_CLASS[lastRun.status] ??
                    'text-text-muted'}"
                  title={lastRun.error ?? `Last run ${new Date(lastRun.at).toLocaleString()}`}
                >
                  {lastRun.status}
                </span>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<ConfirmDialog
  show={confirmDeleteId != null}
  title="Delete schedule"
  message={`Delete “${confirmDeleteLabel}”? Sessions it already launched are not affected.`}
  confirmLabel="Delete"
  variant="danger"
  onconfirm={deleteSchedule}
  oncancel={() => (confirmDeleteId = null)}
/>

<style>
  .overflow-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 30;
    min-width: 9rem;
    display: flex;
    flex-direction: column;
    padding: 0.2rem;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    border-radius: 0.375rem;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
  }

  .overflow-item {
    width: 100%;
    padding: 0.35rem 0.5rem;
    text-align: left;
    border-radius: 0.25rem;
    font-size: 0.72rem;
    color: var(--color-text-primary);
    transition: background 0.15s ease;
  }

  .overflow-item:hover:not(:disabled) {
    background: var(--color-border);
  }

  .overflow-item:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .overflow-item--danger {
    color: var(--color-error, #f87171);
  }
</style>
