<script lang="ts">
  /**
   * Start panel: title, fixed repo vs auto-repo, capture sources, free-text
   * context, and the first-use recording-consent notice (meetings always need
   * an explicit start — never auto-start).
   */
  import { get } from 'svelte/store';
  import { settings } from '$lib/stores/settings';
  import { repos, activeRepo, isRepoActive, findRepoById } from '$lib/stores/repos';
  import {
    meetings,
    meetingConfig,
    meetingConsentAcknowledged,
    acknowledgeMeetingConsent,
  } from '$lib/stores/meetings';

  const cfg = meetingConfig();
  const activeRepos = $derived($repos.list.filter(isRepoActive));

  let title = $state('');
  let context = $state('');
  let repoMode = $state<'fixed' | 'auto'>(cfg.default_auto_repo ? 'auto' : 'fixed');
  let repoId = $state<string>(get(activeRepo)?.id ?? '');
  let consentChecked = $state(false);

  // Sources live in settings (the backend reads them at start).
  let captureMic = $state(cfg.capture_mic);
  let captureSystem = $state(cfg.capture_system);
  let systemTarget = $state<'process' | 'all'>(cfg.system_target);

  $effect(() => {
    if (!repoId && activeRepos.length > 0) repoId = activeRepos[0].id ?? '';
  });

  const autoRepoAvailable = $derived(activeRepos.length > 1);
  const needsConsent = $derived(!$meetingConsentAcknowledged);
  const canStart = $derived(
    !$meetings.starting &&
      (captureMic || captureSystem) &&
      (!needsConsent || consentChecked) &&
      (repoMode === 'auto' || !!repoId || activeRepos.length === 0)
  );

  async function persistSources() {
    const current = get(settings);
    const meeting = { ...meetingConfig(), ...(current.meeting ?? {}) };
    if (
      meeting.capture_mic === captureMic &&
      meeting.capture_system === captureSystem &&
      meeting.system_target === systemTarget
    ) {
      return;
    }
    await settings.save({
      ...current,
      meeting: { ...meeting, capture_mic: captureMic, capture_system: captureSystem, system_target: systemTarget },
    });
  }

  async function start() {
    if (!canStart) return;
    if (needsConsent) acknowledgeMeetingConsent();
    await persistSources();
    const auto = repoMode === 'auto' && autoRepoAvailable;
    const repo = auto ? null : findRepoById($repos.list, repoId);
    await meetings.start({
      title: title.trim() || null,
      repo_id: repo?.id ?? null,
      auto_repo: auto,
      context: context.trim() || null,
      vocabulary: repo?.vocabulary?.length ? repo.vocabulary : null,
    });
  }

  const inputClass =
    'w-full px-2 py-1.5 text-sm bg-surface-elevated border border-border rounded text-text-primary focus:outline-none focus:border-accent';
</script>

<div class="p-4 bg-surface-elevated/50 rounded border border-border space-y-4">
  <div>
    <label class="text-xs font-medium text-text-secondary block mb-1" for="meeting-title">Title</label>
    <input
      id="meeting-title"
      type="text"
      class={inputClass}
      placeholder="e.g. Playtest with the Friday crew"
      bind:value={title}
    />
  </div>

  <div>
    <span class="text-xs font-medium text-text-secondary block mb-1">Repository</span>
    <div class="flex items-center gap-1 mb-2">
      <button
        class="px-2 py-1 rounded text-[11px] transition-colors {repoMode === 'fixed'
          ? 'bg-accent/20 text-text-primary font-medium'
          : 'bg-surface text-text-secondary hover:bg-background'}"
        onclick={() => (repoMode = 'fixed')}
      >
        One repository
      </button>
      <button
        class="px-2 py-1 rounded text-[11px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed {repoMode === 'auto'
          ? 'bg-accent/20 text-text-primary font-medium'
          : 'bg-surface text-text-secondary hover:bg-background'}"
        onclick={() => (repoMode = 'auto')}
        disabled={!autoRepoAvailable}
        title={autoRepoAvailable
          ? 'The LLM picks a repository per item from the repo descriptions'
          : 'Needs at least two active repositories'}
      >
        Auto per item
      </button>
    </div>
    {#if repoMode === 'fixed' || !autoRepoAvailable}
      <select class={inputClass} bind:value={repoId} disabled={activeRepos.length === 0}>
        {#if activeRepos.length === 0}
          <option value="">No repositories configured</option>
        {/if}
        {#each activeRepos as repo (repo.id)}
          <option value={repo.id}>{repo.name}</option>
        {/each}
      </select>
    {:else}
      <p class="text-[11px] text-text-muted">
        Items are routed across {activeRepos.length} active repositories — the LLM picks one per
        item from their descriptions.
      </p>
    {/if}
  </div>

  <div>
    <span class="text-xs font-medium text-text-secondary block mb-1">Capture</span>
    <div class="flex flex-wrap items-center gap-3">
      <label class="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
        <input type="checkbox" class="accent-accent" bind:checked={captureMic} />
        My microphone ("me")
      </label>
      <label class="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
        <input type="checkbox" class="accent-accent" bind:checked={captureSystem} />
        System audio ("them")
      </label>
      {#if captureSystem}
        <select
          class="px-2 py-1 text-xs bg-surface-elevated border border-border rounded text-text-primary"
          bind:value={systemTarget}
          title="Which system audio to capture"
        >
          <option value="process">
            Only {($settings.meeting?.system_process_names ?? cfg.system_process_names).join(', ') || 'listed apps'}
          </option>
          <option value="all">All system audio</option>
        </select>
      {/if}
    </div>
    {#if !captureMic && !captureSystem}
      <p class="text-[11px] text-error mt-1">Pick at least one source.</p>
    {/if}
  </div>

  <div>
    <label class="text-xs font-medium text-text-secondary block mb-1" for="meeting-context">
      Context <span class="text-text-muted font-normal">(optional — helps the triage)</span>
    </label>
    <textarea
      id="meeting-context"
      class="{inputClass} min-h-16 resize-y"
      placeholder="e.g. Playtesting build 0.4 — the new cave level and the grappling hook"
      bind:value={context}
    ></textarea>
  </div>

  {#if needsConsent}
    <div class="p-3 rounded border border-amber-500/40 bg-amber-500/10 space-y-2">
      <p class="text-xs text-amber-300">
        <strong>Tell participants you're recording.</strong> Meeting Mode records other people's
        voices. Recording without consent is illegal in some places (all-party-consent laws, GDPR).
        Audio stays on this machine unless you use an API transcription or LLM provider.
      </p>
      <label class="flex items-center gap-2 text-xs text-text-primary cursor-pointer">
        <input type="checkbox" class="accent-accent" bind:checked={consentChecked} />
        I'll let everyone know this meeting is being recorded
      </label>
    </div>
  {:else}
    <p class="text-[11px] text-text-muted">Reminder: tell participants you're recording.</p>
  {/if}

  {#if $meetings.startError}
    <div class="p-2 rounded border border-error/40 bg-error/10 text-xs text-error">
      Couldn't start the meeting: {$meetings.startError}
    </div>
  {/if}

  <div class="flex items-center gap-2">
    <button
      class="inline-flex items-center gap-2 px-4 py-1.5 rounded text-xs font-semibold bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      disabled={!canStart}
      onclick={start}
    >
      <span class="w-2 h-2 rounded-full bg-white"></span>
      {$meetings.starting ? 'Starting…' : 'Start meeting'}
    </button>
    {#if $settings.hotkeys?.toggle_meeting}
      <span class="text-[11px] text-text-muted">
        or press <span class="font-mono">{$settings.hotkeys.toggle_meeting.replace(/CommandOrControl/g, 'Ctrl').replace(/\+/g, ' + ')}</span>
      </span>
    {/if}
  </div>
</div>
