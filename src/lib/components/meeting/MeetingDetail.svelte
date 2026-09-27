<script lang="ts">
  /**
   * One meeting: header controls, live status (duration, levels, segments,
   * next triage), summary, review list and the delayed transcript.
   */
  import {
    meetings,
    formatMeetingTime,
    liveDurationSecs,
    meetingConfig,
  } from '$lib/stores/meetings';
  import { repos, findRepoById } from '$lib/stores/repos';
  import { renderMarkdown } from '$lib/utils/markdown';
  import MeetingTranscript from './MeetingTranscript.svelte';
  import MeetingReviewList from './MeetingReviewList.svelte';
  import ConfirmDialog from '../ConfirmDialog.svelte';

  interface Props {
    meetingId: string;
  }

  let { meetingId }: Props = $props();

  const rt = $derived($meetings.runtimes[meetingId]);
  const meta = $derived(rt?.meta ?? $meetings.list.find((m) => m.id === meetingId) ?? null);
  const isLive = $derived(meta?.status === 'recording' || meta?.status === 'paused');
  const isActive = $derived($meetings.activeId === meetingId);
  const errors = $derived($meetings.errors.filter((e) => e.meeting_id === meetingId));

  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  let editedTitle = $state('');
  let lastId = $state('');
  $effect(() => {
    if (meta && meta.id !== lastId) {
      lastId = meta.id;
      editedTitle = meta.title ?? '';
    }
  });

  let confirmStop = $state(false);
  let confirmDelete = $state(false);
  let summaryOpen = $state(true);
  let errorsOpen = $state(false);
  let busy = $state<string | null>(null);

  const duration = $derived(rt ? liveDurationSecs(rt, now) : (meta?.duration_secs ?? 0));
  const nextTriage = $derived(isLive ? meetings.nextTriageAt(meetingId) : null);
  const nextTriageIn = $derived(nextTriage != null ? Math.max(0, Math.round((nextTriage - now) / 1000)) : null);

  const repoLabel = $derived.by(() => {
    if (!meta) return '';
    if (meta.auto_repo) return 'Auto repo';
    return findRepoById($repos.list, meta.repo_id ?? undefined)?.name ?? 'No repository';
  });

  function saveTitle() {
    if (!meta) return;
    const title = editedTitle.trim();
    if (title && title !== meta.title) void meetings.updateMeta(meta.id, { title });
  }

  async function run(label: string, fn: () => Promise<unknown>) {
    busy = label;
    try {
      await fn();
    } finally {
      busy = null;
    }
  }

  function levelWidth(level: number): string {
    // RMS 0–1 is small in practice; scale for visibility
    return `${Math.min(100, Math.round(Math.sqrt(Math.max(0, level)) * 160))}%`;
  }

  const STATUS_CLASS: Record<string, string> = {
    recording: 'bg-red-500/15 text-red-400',
    paused: 'bg-amber-500/15 text-amber-400',
    finalizing: 'bg-sky-500/15 text-sky-400',
    done: 'bg-emerald-500/15 text-emerald-400',
    interrupted: 'bg-amber-500/15 text-amber-400',
  };
</script>

{#if meta}
  <div class="flex-1 flex flex-col overflow-hidden">
    <!-- Header -->
    <div class="px-4 py-3 border-b border-border flex items-center gap-3">
      <button
        class="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-elevated transition-colors shrink-0"
        onclick={() => meetings.openMeeting(null)}
        title="All meetings"
        aria-label="Back to meetings"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <div class="flex-1 min-w-0">
        <input
          type="text"
          class="w-full bg-transparent text-base font-medium text-text-primary focus:outline-none focus:border-b focus:border-accent"
          placeholder="Meeting"
          bind:value={editedTitle}
          onblur={saveTitle}
          onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
        />
        <div class="flex items-center gap-2 mt-0.5 text-xs text-text-muted flex-wrap">
          <span class="px-1.5 py-px rounded {STATUS_CLASS[meta.status] ?? 'bg-surface'}">{meta.status}</span>
          <span>{new Date(meta.started_at).toLocaleString()}</span>
          <span>· {repoLabel}</span>
          <span>· {meta.sources.mic ? 'mic' : ''}{meta.sources.mic && meta.sources.system ? ' + ' : ''}{meta.sources.system ? (meta.sources.system_target === 'process' ? 'app audio' : 'system audio') : ''}</span>
        </div>
      </div>

      <div class="flex items-center gap-1.5 shrink-0">
        {#if isLive}
          {#if meta.status === 'recording'}
            <button
              class="px-2.5 py-1 text-xs rounded border border-border text-text-secondary hover:bg-surface-elevated transition-colors"
              onclick={() => meetings.pause(meta.id)}
            >
              Pause
            </button>
          {:else}
            <button
              class="px-2.5 py-1 text-xs rounded border border-border text-text-secondary hover:bg-surface-elevated transition-colors"
              onclick={() => meetings.resume(meta.id)}
            >
              Resume
            </button>
          {/if}
          <button
            class="px-2.5 py-1 text-xs rounded font-medium bg-red-600 hover:bg-red-500 text-white transition-colors"
            onclick={() => (confirmStop = true)}
          >
            Stop
          </button>
        {:else if meta.status === 'interrupted'}
          <button
            class="px-2.5 py-1 text-xs rounded font-medium bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-50"
            disabled={busy === 'finalize'}
            onclick={() => run('finalize', () => meetings.finalize(meta.id))}
            title="Transcribe the remaining segments, then triage and summarize"
          >
            {busy === 'finalize' ? 'Finalizing…' : 'Finalize'}
          </button>
        {/if}
        {#if meta.status === 'done' || meta.status === 'interrupted'}
          <button
            class="px-2.5 py-1 text-xs rounded border border-border text-text-secondary hover:bg-surface-elevated transition-colors disabled:opacity-50"
            disabled={rt?.triageRunning || rt?.consolidating}
            onclick={() => run('triage', () => meetings.runTriage(meta.id, { final: true }))}
            title="Triage any transcript lines that haven't been triaged yet"
          >
            Triage
          </button>
          {#if meta.status === 'done'}
            <button
              class="px-2.5 py-1 text-xs rounded border border-border text-text-secondary hover:bg-surface-elevated transition-colors disabled:opacity-50"
              disabled={rt?.triageRunning || rt?.consolidating}
              onclick={() => run('consolidate', () => meetings.consolidate(meta.id))}
              title="Merge duplicates, tidy items and (re)write the summary"
            >
              {rt?.consolidating ? 'Summarizing…' : meta.summary ? 'Re-summarize' : 'Summarize'}
            </button>
          {/if}
          <button
            class="px-2.5 py-1 text-xs rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
            onclick={() => (confirmDelete = true)}
          >
            Delete
          </button>
        {/if}
      </div>
    </div>

    <!-- Live status -->
    {#if isActive || meta.status === 'finalizing'}
      <div class="px-4 py-2 border-b border-border bg-surface-elevated/40 flex items-center gap-4 flex-wrap text-xs">
        <div class="flex items-center gap-2">
          <span class="relative w-2.5 h-2.5">
            <span class="absolute inset-0 rounded-full {meta.status === 'recording' ? 'bg-red-500' : meta.status === 'paused' ? 'bg-amber-400' : 'bg-sky-400'}"></span>
            {#if meta.status === 'recording'}
              <span class="absolute inset-0 rounded-full bg-red-500 animate-ping opacity-60"></span>
            {/if}
          </span>
          <span class="font-mono text-sm text-text-primary tabular-nums">{formatMeetingTime(duration)}</span>
        </div>
        {#if isLive}
          <div class="flex items-center gap-3">
            {#if meta.sources.mic}
              <div class="flex items-center gap-1.5" title="Microphone level">
                <span class="text-text-muted w-7">Me</span>
                <div class="w-20 h-1.5 rounded bg-surface overflow-hidden">
                  <div class="h-full bg-accent transition-all duration-200" style="width: {levelWidth($meetings.level.mic)}"></div>
                </div>
              </div>
            {/if}
            {#if meta.sources.system}
              <div class="flex items-center gap-1.5" title="System audio level">
                <span class="text-text-muted w-9">Them</span>
                <div class="w-20 h-1.5 rounded bg-surface overflow-hidden">
                  <div class="h-full bg-amber-400 transition-all duration-200" style="width: {levelWidth($meetings.level.system)}"></div>
                </div>
              </div>
            {/if}
          </div>
        {/if}
        <span class="text-text-muted">
          {meta.segment_count} segments
          {#if meta.pending_segments > 0}<span class="text-amber-400"> · {meta.pending_segments} transcribing</span>{/if}
          {#if meta.failed_segments > 0}<span class="text-red-400"> · {meta.failed_segments} failed</span>{/if}
        </span>
        <span class="ml-auto flex items-center gap-2 text-text-muted">
          {#if rt?.triageRunning}
            <span class="text-accent animate-pulse">Triaging…</span>
          {:else if meta.status === 'finalizing'}
            <span>Finishing transcription — triage and summary follow</span>
          {:else if nextTriageIn != null}
            <span title="Triage interval: {meetingConfig().triage_interval_minutes} min">
              Next triage in {Math.floor(nextTriageIn / 60)}:{String(nextTriageIn % 60).padStart(2, '0')}
            </span>
          {/if}
          {#if isLive}
            <button
              class="px-2 py-0.5 rounded text-[11px] border border-border text-text-secondary hover:bg-surface-elevated disabled:opacity-50"
              disabled={rt?.triageRunning}
              onclick={() => meetings.runTriage(meta.id)}
            >
              Triage now
            </button>
          {/if}
        </span>
      </div>
    {/if}

    {#if rt?.itemsLoadError || rt?.triageError || rt?.consolidateError || errors.length > 0}
      <div class="px-4 py-1.5 border-b border-border bg-red-500/5 text-xs">
        {#if rt?.itemsLoadError}
          <p class="text-red-400">
            Couldn't load this meeting's items: {rt.itemsLoadError} — triage and saving are paused so nothing on disk is overwritten.
            <button class="ml-1 underline hover:text-text-primary" onclick={() => meetings.retryLoadItems(meta.id)}>Retry</button>
          </p>
        {/if}
        {#if rt?.triageError}
          <p class="text-red-400">Triage failed: {rt.triageError} — it retries on the next interval.</p>
        {/if}
        {#if rt?.consolidateError}
          <p class="text-red-400">Summary failed: {rt.consolidateError}</p>
        {/if}
        {#if errors.length > 0}
          <button class="text-red-400 hover:underline" onclick={() => (errorsOpen = !errorsOpen)}>
            {errors.length} capture/transcription error{errors.length === 1 ? '' : 's'} {errorsOpen ? '▾' : '▸'}
          </button>
          {#if errorsOpen}
            <ul class="mt-1 space-y-0.5 text-[11px] text-text-muted">
              {#each errors as err (err.at + err.message)}
                <li>
                  {new Date(err.at).toLocaleTimeString()} — {err.message}
                  {#if err.seg_id}
                    <button class="ml-1 underline hover:text-text-primary" onclick={() => meetings.retrySegment(meta.id, err.seg_id!)}>retry</button>
                  {/if}
                </li>
              {/each}
            </ul>
            <button class="text-[11px] text-text-muted hover:text-text-secondary underline mt-1" onclick={() => meetings.clearErrors(meta.id)}>
              Clear
            </button>
          {/if}
        {/if}
      </div>
    {/if}

    <!-- Summary -->
    {#if meta.summary || rt?.consolidating}
      <div class="px-4 py-2 border-b border-border">
        <button class="text-xs font-medium text-text-secondary flex items-center gap-1" onclick={() => (summaryOpen = !summaryOpen)}>
          Summary {summaryOpen ? '▾' : '▸'}
          {#if rt?.consolidating}<span class="text-accent animate-pulse font-normal">updating…</span>{/if}
        </button>
        {#if summaryOpen && meta.summary}
          <div class="meeting-summary mt-1.5 text-sm max-h-72 overflow-y-auto">
            {@html renderMarkdown(meta.summary)}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Review list + transcript -->
    <div class="flex-1 flex min-h-0">
      <div class="flex-[3] min-w-0 border-r border-border">
        <MeetingReviewList {meta} items={rt?.items ?? []} />
      </div>
      <div class="flex-[2] min-w-0">
        <MeetingTranscript meetingId={meta.id} lines={rt?.transcript ?? null} live={isLive} />
      </div>
    </div>
  </div>

  <ConfirmDialog
    show={confirmStop}
    title="Stop meeting"
    message="Stop recording? Remaining segments are transcribed, then the meeting is triaged and summarized."
    confirmLabel="Stop"
    variant="danger"
    onconfirm={() => {
      confirmStop = false;
      void meetings.stop(meta.id);
    }}
    oncancel={() => (confirmStop = false)}
  />

  <ConfirmDialog
    show={confirmDelete}
    title="Delete meeting"
    message="Delete this meeting with its transcript and audio? Pile and journal items it produced are kept."
    confirmLabel="Delete"
    variant="danger"
    onconfirm={async () => {
      confirmDelete = false;
      await meetings.remove(meta.id);
    }}
    oncancel={() => (confirmDelete = false)}
  />
{:else}
  <div class="flex-1 flex items-center justify-center text-xs text-text-muted">Loading meeting…</div>
{/if}

<style>
  .meeting-summary {
    color: var(--color-text-primary);
  }
  .meeting-summary :global(h1),
  .meeting-summary :global(h2),
  .meeting-summary :global(h3),
  .meeting-summary :global(h4) {
    font-weight: 600;
    margin: 0.75em 0 0.35em;
    font-size: 0.95em;
  }
  .meeting-summary :global(h1:first-child),
  .meeting-summary :global(h2:first-child),
  .meeting-summary :global(h3:first-child) {
    margin-top: 0;
  }
  .meeting-summary :global(p) {
    margin: 0 0 0.5em;
  }
  .meeting-summary :global(ul),
  .meeting-summary :global(ol) {
    margin: 0 0 0.5em;
    padding-left: 1.25em;
  }
  .meeting-summary :global(ul) {
    list-style: disc;
  }
  .meeting-summary :global(ol) {
    list-style: decimal;
  }
  .meeting-summary :global(li) {
    margin: 0.15em 0;
  }
  .meeting-summary :global(strong) {
    font-weight: 600;
  }
  .meeting-summary :global(code) {
    background: var(--color-surface);
    padding: 0.1em 0.35em;
    border-radius: 4px;
    font-size: 0.9em;
  }
</style>
