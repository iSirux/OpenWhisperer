<script lang="ts">
  import { onDestroy } from 'svelte';
  import { pile, pileItemTitle, selectedPileItemId, type PileItem } from '$lib/stores/pile';
  import { sdkSessions, activeSdkSessionId, type EffortLevel } from '$lib/stores/sdkSessions';
  import { activeSessionId } from '$lib/stores/sessions';
  import { settings } from '$lib/stores/settings';
  import { repos, isRepoActive } from '$lib/stores/repos';
  import { navigation } from '$lib/stores/navigation';
  import {
    launchPileItem,
    preparePileItem,
    type PileLaunchAction,
  } from '$lib/utils/pileActions';
  import { getShortModelName } from '$lib/utils/modelColors';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import PromptChips from './PromptChips.svelte';

  interface Props {
    item: PileItem;
  }

  let { item }: Props = $props();

  let editedTranscript = $state('');
  let editedTitle = $state('');
  let lastItemId = $state('');
  let showRaw = $state(false);
  let useWorktree = $state(false);
  let playwrightQa = $state(false);
  let confirmDeleteOpen = $state(false);
  let launching = $state(false);
  let audioUrl = $state<string | null>(null);
  let screenshotUrl = $state<string | null>(null);
  let screenshotExpanded = $state(false);

  // Reset local edit state + audio when switching items
  $effect(() => {
    if (item.id !== lastItemId) {
      lastItemId = item.id;
      editedTranscript = item.transcript;
      editedTitle = item.title ?? '';
      showRaw = false;
      screenshotExpanded = false;
      loadAudio(item);
      loadScreenshot(item);
    } else if (item.transcript !== editedTranscript && document.activeElement?.tagName !== 'TEXTAREA') {
      // Background processing updated the transcript while not editing
      editedTranscript = item.transcript;
    }
  });

  async function loadAudio(current: PileItem) {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = null;
    }
    if (current.hasAudio) {
      const url = await pile.getAudioUrl(current.id);
      // Guard against the user switching items while the audio was loading
      if (current.id === lastItemId) {
        audioUrl = url;
      } else if (url) {
        URL.revokeObjectURL(url);
      }
    }
  }

  async function loadScreenshot(current: PileItem) {
    screenshotUrl = null;
    if (current.hasScreenshot) {
      const img = await pile.getScreenshotImage(current.id);
      // Guard against the user switching items while the screenshot was loading
      if (img && current.id === lastItemId) {
        screenshotUrl = `data:${img.mediaType};base64,${img.base64Data}`;
      }
    }
  }

  async function removeScreenshot() {
    screenshotUrl = null;
    await pile.removeScreenshot(item.id);
  }

  onDestroy(() => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  });

  function saveTranscript() {
    if (editedTranscript !== item.transcript) {
      pile.updateItem(item.id, { transcript: editedTranscript });
    }
  }

  function saveTitle() {
    const title = editedTitle.trim();
    if (title !== (item.title ?? '')) {
      pile.updateItem(item.id, { title: title || undefined });
    }
  }

  const activeRepos = $derived($repos.list.filter(isRepoActive));

  function setRepo(repoId: string) {
    pile.updateItem(item.id, {
      repoId: repoId || undefined,
      repoConfidence: undefined,
      repoReasoning: 'Selected manually',
    });
  }

  const modelOptions = $derived.by(() => {
    const models = [...$settings.enabled_models];
    if (item.model && !models.includes(item.model)) models.push(item.model);
    return models;
  });

  const EFFORT_OPTIONS: { value: string; label: string }[] = [
    { value: '', label: 'Effort: off' },
    { value: 'low', label: 'Effort: low' },
    { value: 'medium', label: 'Effort: medium' },
    { value: 'high', label: 'Effort: high' },
    { value: 'xhigh', label: 'Effort: xhigh' },
    { value: 'max', label: 'Effort: max' },
  ];

  const linkedSessions = $derived(
    (item.linkedSessionIds || [])
      .map((id) => $sdkSessions.find((s) => s.id === id))
      .filter((s) => !!s)
  );

  // Static mini-waveform from the recorded visualization history
  const waveformBars = $derived.by(() => {
    const history = item.audioVisualizationHistory;
    if (!history || history.length === 0) return [];
    return history.map(
      (frame) => frame.reduce((sum, v) => sum + v, 0) / Math.max(frame.length, 1)
    );
  });
  const waveformMax = $derived(Math.max(...waveformBars, 0.001));

  function formatDuration(ms?: number): string {
    if (!ms) return '';
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  function formatCreatedAt(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  async function runLaunch(action: PileLaunchAction) {
    saveTranscript();
    launching = true;
    try {
      const sessionId = await launchPileItem(pile.getItem(item.id)!, action, {
        useWorktree,
        playwrightQa,
      });
      if (sessionId) {
        selectedPileItemId.set(null);
        activeSdkSessionId.set(sessionId);
        activeSessionId.set(null);
        navigation.setView('sessions');
      }
    } finally {
      launching = false;
    }
  }

  function runPrepare() {
    saveTranscript();
    const sessionId = preparePileItem(pile.getItem(item.id)!, true);
    if (sessionId) {
      selectedPileItemId.set(null);
    }
  }

  async function deleteItem() {
    confirmDeleteOpen = false;
    selectedPileItemId.set(null);
    await pile.removeItem(item.id);
  }

  function openSession(sessionId: string) {
    selectedPileItemId.set(null);
    activeSdkSessionId.set(sessionId);
    activeSessionId.set(null);
    navigation.setView('sessions');
  }

  const isBusy = $derived(item.status === 'processing' || item.status === 'transcribing');
  const canLaunch = $derived(!isBusy && !launching && editedTranscript.trim().length > 0);
</script>

<div class="flex-1 flex flex-col overflow-hidden">
  <!-- Header -->
  <div class="px-4 py-3 border-b border-border flex items-center gap-3">
    <div class="flex-1 min-w-0">
      <input
        type="text"
        class="w-full bg-transparent text-base font-medium text-text-primary focus:outline-none focus:border-b focus:border-accent"
        placeholder={pileItemTitle(item)}
        bind:value={editedTitle}
        onblur={saveTitle}
      />
      <div class="flex items-center gap-2 mt-0.5 text-xs text-text-muted">
        <span>{formatCreatedAt(item.createdAt)}</span>
        {#if item.recordingDurationMs}
          <span>· {formatDuration(item.recordingDurationMs)} recording</span>
        {/if}
        {#if item.category}
          <span class="px-1.5 py-px rounded bg-surface-elevated">{item.category}</span>
        {/if}
        {#if isBusy}
          <span class="text-amber-400 animate-pulse">
            {item.status === 'transcribing' ? 'Transcribing…' : 'Processing…'}
          </span>
        {/if}
      </div>
    </div>
    <button
      class="px-2.5 py-1 text-xs rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
      onclick={() => (confirmDeleteOpen = true)}
    >
      Delete
    </button>
    <button
      class="px-2.5 py-1 text-xs rounded border border-border text-text-secondary hover:bg-surface-elevated transition-colors shrink-0"
      onclick={() => selectedPileItemId.set(null)}
    >
      Close
    </button>
  </div>

  <div class="flex-1 overflow-y-auto p-4 space-y-4 max-w-3xl w-full mx-auto">
    <!-- Error banner -->
    {#if item.transcriptionError}
      <div class="p-3 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-400 flex items-center gap-3">
        <span class="flex-1">{item.transcriptionError}</span>
        {#if item.hasAudio}
          <button
            class="px-2.5 py-1 text-xs rounded bg-red-500/20 hover:bg-red-500/30 transition-colors shrink-0"
            onclick={() => pile.retranscribe(item.id)}
            disabled={isBusy}
          >
            Retry transcription
          </button>
        {/if}
      </div>
    {/if}

    <!-- Audio + waveform -->
    {#if item.hasAudio || waveformBars.length > 0}
      <div class="p-3 bg-surface-elevated rounded border border-border space-y-2">
        {#if waveformBars.length > 0}
          <div class="flex items-end gap-px h-10">
            {#each waveformBars as bar}
              <div
                class="flex-1 bg-accent/60 rounded-sm min-h-px"
                style="height: {Math.max((bar / waveformMax) * 100, 2)}%"
              ></div>
            {/each}
          </div>
        {/if}
        {#if audioUrl}
          <audio controls src={audioUrl} class="w-full h-8"></audio>
        {/if}
        {#if item.hasAudio && !item.transcriptionError}
          <div class="flex justify-end">
            <button
              class="text-[11px] text-text-muted hover:text-text-secondary transition-colors"
              onclick={() => pile.retranscribe(item.id)}
              disabled={isBusy}
              title="Re-run Whisper transcription on the saved audio, then re-run processing"
            >
              Re-transcribe
            </button>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Screenshot captured at recording start -->
    {#if item.hasScreenshot}
      <div class="p-3 bg-surface-elevated rounded border border-border space-y-2">
        <div class="flex items-center gap-2">
          <span class="text-xs font-medium text-text-secondary">Screenshot</span>
          <span class="text-[11px] text-text-muted flex-1"
            >captured at recording start — attached to the prompt on launch</span
          >
          <button
            class="text-[11px] text-text-muted hover:text-red-400 transition-colors"
            onclick={removeScreenshot}
            title="Remove screenshot (won't be attached to the prompt)"
          >
            Remove
          </button>
        </div>
        {#if screenshotUrl}
          <button
            class="block"
            onclick={() => (screenshotExpanded = !screenshotExpanded)}
            title={screenshotExpanded ? 'Collapse' : 'Expand'}
          >
            <img
              src={screenshotUrl}
              alt="Screen at recording start"
              class="rounded border border-border transition-all {screenshotExpanded
                ? 'max-h-[480px]'
                : 'max-h-24'}"
            />
          </button>
        {/if}
      </div>
    {/if}

    <!-- Transcript -->
    <div>
      <div class="flex items-center justify-between mb-1">
        <label class="text-xs font-medium text-text-secondary" for="pile-transcript">Prompt</label>
        <div class="flex items-center gap-2">
          {#if item.wasCleanedUp}
            <button
              class="text-[11px] text-text-muted hover:text-text-secondary transition-colors"
              onclick={() => (showRaw = !showRaw)}
            >
              {showRaw ? 'Hide original' : 'Show original'}
            </button>
          {/if}
          <button
            class="text-[11px] text-text-muted hover:text-text-secondary transition-colors"
            onclick={() => {
              saveTranscript();
              pile.processItem(item.id);
            }}
            disabled={isBusy}
            title="Re-run cleanup, repo/model recommendation, and titling"
          >
            Re-process
          </button>
        </div>
      </div>
      <textarea
        id="pile-transcript"
        class="w-full min-h-32 p-3 text-sm bg-surface-elevated border border-border rounded text-text-primary resize-y focus:outline-none focus:border-accent"
        bind:value={editedTranscript}
        onblur={saveTranscript}
        placeholder="Transcript..."
      ></textarea>
      {#if showRaw && item.rawTranscript}
        <div class="mt-2 p-3 bg-surface rounded border border-border/50 text-xs text-text-muted whitespace-pre-wrap">
          <p class="font-medium text-text-secondary mb-1">Original transcription</p>
          {item.rawTranscript}
        </div>
      {/if}
      {#if item.cleanupCorrections && item.cleanupCorrections.length > 0}
        <details class="mt-1">
          <summary class="text-[11px] text-text-muted cursor-pointer">
            {item.cleanupCorrections.length} cleanup correction(s)
            {item.usedDualSource ? ' (dual-source)' : ''}
          </summary>
          <ul class="text-[11px] text-text-muted ml-4 mt-1 list-disc">
            {#each item.cleanupCorrections as correction}
              <li>{correction}</li>
            {/each}
          </ul>
        </details>
      {/if}
    </div>

    <!-- Repo / model / effort -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div>
        <label class="text-xs font-medium text-text-secondary block mb-1" for="pile-repo">Repository</label>
        <select
          id="pile-repo"
          class="w-full px-2 py-1.5 text-sm bg-surface-elevated border border-border rounded text-text-primary"
          value={item.repoId ?? ''}
          onchange={(e) => setRepo((e.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">— none —</option>
          {#each activeRepos as repo}
            <option value={repo.id}>{repo.name}</option>
          {/each}
        </select>
        {#if item.repoReasoning}
          <p class="text-[11px] text-text-muted mt-1" title={item.repoReasoning}>
            {#if item.repoConfidence && item.repoConfidence !== 'high'}
              <span class="text-amber-400">{item.repoConfidence} confidence:</span>
            {/if}
            {item.repoReasoning}
          </p>
        {/if}
      </div>
      <div>
        <label class="text-xs font-medium text-text-secondary block mb-1" for="pile-model">Model</label>
        <select
          id="pile-model"
          class="w-full px-2 py-1.5 text-sm bg-surface-elevated border border-border rounded text-text-primary"
          value={item.model ?? ''}
          onchange={(e) =>
            pile.updateItem(item.id, {
              model: (e.currentTarget as HTMLSelectElement).value || undefined,
            })}
        >
          <option value="">Default</option>
          {#each modelOptions as model}
            <option value={model}>{getShortModelName(model)}</option>
          {/each}
        </select>
        {#if item.modelReasoning}
          <p class="text-[11px] text-text-muted mt-1">{item.modelReasoning}</p>
        {/if}
      </div>
      <div>
        <label class="text-xs font-medium text-text-secondary block mb-1" for="pile-effort">Effort</label>
        <select
          id="pile-effort"
          class="w-full px-2 py-1.5 text-sm bg-surface-elevated border border-border rounded text-text-primary"
          value={item.effortLevel ?? ''}
          onchange={(e) =>
            pile.updateItem(item.id, {
              effortLevel: ((e.currentTarget as HTMLSelectElement).value ||
                null) as EffortLevel,
            })}
        >
          {#each EFFORT_OPTIONS as option}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      </div>
    </div>

    <!-- Launch actions -->
    <div class="p-3 bg-surface-elevated rounded border border-border space-y-2">
      <PromptChips
        selected={item.selectedChips ?? []}
        onchange={(next) => pile.updateItem(item.id, { selectedChips: next.length ? next : undefined })}
      />
      <div class="flex items-center gap-3">
        <label class="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
          <input type="checkbox" bind:checked={useWorktree} class="accent-accent" />
          Worktree
        </label>
        <label class="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
          <input type="checkbox" bind:checked={playwrightQa} class="accent-purple-500" />
          Playwright QA
        </label>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <button
          class="px-3 py-1.5 rounded text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-50"
          disabled={!canLaunch}
          onclick={() => runLaunch('start')}
        >
          Start session
        </button>
        <button
          class="px-3 py-1.5 rounded text-xs font-medium bg-sky-600/60 hover:bg-sky-600 text-white transition-colors disabled:opacity-50"
          disabled={!canLaunch}
          onclick={runPrepare}
        >
          Prepare draft
        </button>
        <button
          class="px-3 py-1.5 rounded text-xs font-medium bg-surface hover:bg-background text-text-secondary transition-colors disabled:opacity-50"
          disabled={!canLaunch}
          onclick={() => runLaunch('plan')}
          title="Appends a request to plan before implementing"
        >
          Plan first
        </button>
        <button
          class="px-3 py-1.5 rounded text-xs font-medium bg-surface hover:bg-background text-text-secondary transition-colors disabled:opacity-50"
          disabled={!canLaunch}
          onclick={() => runLaunch('discuss')}
          title="Scan the codebase, then discuss without implementing"
        >
          Discuss
        </button>
      </div>
    </div>

    <!-- Linked sessions -->
    {#if linkedSessions.length > 0}
      <div>
        <p class="text-xs font-medium text-text-secondary mb-1">Launched sessions</p>
        <div class="space-y-1">
          {#each linkedSessions as session (session.id)}
            <button
              class="w-full flex items-center gap-2 p-2 rounded border border-border bg-surface-elevated/50 hover:bg-surface-elevated text-left transition-colors"
              onclick={() => openSession(session.id)}
            >
              {#if session.status === 'querying' || session.status === 'initializing'}
                <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0"></span>
              {:else}
                <span class="w-2 h-2 rounded-full bg-text-muted shrink-0"></span>
              {/if}
              <span class="text-xs text-text-primary truncate flex-1">
                {session.aiMetadata?.name || session.messages.find((m) => m.type === 'user')?.content?.slice(0, 60) || session.status}
              </span>
              <span class="text-[10px] text-text-muted shrink-0">{session.status}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>

<ConfirmDialog
  show={confirmDeleteOpen}
  title="Delete pile item"
  message="Delete this item from the pile? Its saved audio will also be deleted."
  confirmLabel="Delete"
  variant="danger"
  onconfirm={deleteItem}
  oncancel={() => (confirmDeleteOpen = false)}
/>
