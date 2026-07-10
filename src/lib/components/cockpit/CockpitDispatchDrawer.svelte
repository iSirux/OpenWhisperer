<script lang="ts">
  import { cockpitController, draft } from '$lib/cockpit';
  import { settings } from '$lib/stores/settings';
  import { repos, findRepoById } from '$lib/stores/repos';
  import type { EffortLevel } from '$lib/stores/sdkSessions';
  import { getShortModelName } from '$lib/utils/modelColors';
  import { appendChips } from '$lib/utils/promptChips';
  import RepoSelector from '$lib/components/RepoSelector.svelte';
  import PromptChips from '$lib/components/PromptChips.svelte';

  // Local transcript mirror (background enrichment may replace the draft text).
  let editedTranscript = $state('');
  let lastDraftId = $state(0);
  // Chips are appended to the prompt at launch (Go button path only).
  let selectedChips = $state<string[]>([]);

  $effect(() => {
    const d = $draft;
    if (!d) return;
    if (d.createdAt !== lastDraftId) {
      lastDraftId = d.createdAt;
      editedTranscript = d.transcript;
      selectedChips = [];
    } else if (
      d.transcript !== editedTranscript &&
      document.activeElement?.tagName !== 'TEXTAREA'
    ) {
      // Enrichment (cleanup) or a voice append updated the transcript.
      editedTranscript = d.transcript;
    }
  });

  function commitTranscript() {
    const d = $draft;
    if (d && d.transcript !== editedTranscript) {
      draft.set({ ...d, transcript: editedTranscript });
    }
  }

  const currentRepoPath = $derived.by(() => {
    const d = $draft;
    if (!d?.repoId) return '';
    return findRepoById($repos.list, d.repoId)?.path ?? '';
  });

  function setRepoByPath(path: string) {
    const d = $draft;
    if (!d) return;
    const repo = path && path !== '.' ? $repos.list.find((r) => r.path === path) : undefined;
    draft.set({ ...d, repoId: repo?.id });
  }

  const modelOptions = $derived.by(() => {
    const models = [...$settings.enabled_models];
    const d = $draft;
    if (d?.model && !models.includes(d.model)) models.push(d.model);
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

  function setModel(value: string) {
    const d = $draft;
    if (d) draft.set({ ...d, model: value || undefined });
  }
  function setEffort(value: string) {
    const d = $draft;
    if (d) draft.set({ ...d, effortLevel: (value || null) as EffortLevel });
  }

  function handleGo() {
    const d = $draft;
    if (!d) return;
    commitTranscript();
    // Fold selected chips into the prompt so both the button and voice "go" agree.
    if (selectedChips.length > 0) {
      const cur = $draft;
      if (cur) draft.set({ ...cur, transcript: appendChips(cur.transcript, selectedChips) });
    }
    void cockpitController.handleUtterance('go');
  }

  function handleCancel() {
    void cockpitController.handleUtterance('cancel');
  }
</script>

{#if $draft}
  {@const d = $draft}
  <div class="cockpit-drawer border-t border-accent/40 bg-surface-elevated shadow-lg">
    <div class="mx-auto max-w-3xl w-full p-4 space-y-3">
      <div class="flex items-center gap-2">
        <span class="text-xs font-semibold uppercase tracking-wide text-accent">New task</span>
        <span class="text-[11px] text-text-muted">say "go" to launch · "cancel" to discard</span>
        {#if d.cleaning}
          <span class="text-[11px] text-amber-400 animate-pulse ml-auto">cleaning transcript…</span>
        {/if}
      </div>

      <!-- Editable transcript -->
      <textarea
        class="w-full min-h-20 p-3 text-sm bg-surface border border-border rounded text-text-primary resize-y focus:outline-none focus:border-accent"
        bind:value={editedTranscript}
        oninput={commitTranscript}
        onblur={commitTranscript}
        placeholder="Task for the fleet…"
        aria-label="Draft task"
      ></textarea>

      {#if d.cleanupCorrections && d.cleanupCorrections.length > 0}
        <details>
          <summary class="text-[11px] text-text-muted cursor-pointer">
            {d.cleanupCorrections.length} cleanup correction(s)
          </summary>
          <ul class="text-[11px] text-text-muted ml-4 mt-1 list-disc">
            {#each d.cleanupCorrections as correction}
              <li>{correction}</li>
            {/each}
          </ul>
        </details>
      {/if}

      <!-- Repo / model / effort -->
      <div class="flex flex-wrap items-start gap-4">
        <div>
          <div class="text-[11px] font-medium text-text-secondary mb-1 flex items-center gap-1.5">
            Repository
            {#if d.recommendingRepo}
              <span class="text-amber-400 animate-pulse">·</span>
            {/if}
          </div>
          <RepoSelector cwd={currentRepoPath} onchange={setRepoByPath} size="md" />
          {#if d.repoRecommendation}
            <p
              class="text-[11px] text-text-muted mt-1 max-w-48"
              title={d.repoRecommendation.reasoning}
            >
              {#if d.repoRecommendation.confidence !== 'high'}
                <span class="text-amber-400">{d.repoRecommendation.confidence}:</span>
              {/if}
              {d.repoRecommendation.repoName}
            </p>
          {/if}
        </div>

        <div>
          <div class="text-[11px] font-medium text-text-secondary mb-1 flex items-center gap-1.5">
            Model
            {#if d.recommendingModel}
              <span class="text-amber-400 animate-pulse">·</span>
            {/if}
          </div>
          <select
            class="px-2 py-1.5 text-sm bg-surface border border-border rounded text-text-primary"
            value={d.model ?? ''}
            onchange={(e) => setModel((e.currentTarget as HTMLSelectElement).value)}
            aria-label="Draft model"
          >
            <option value="">Default</option>
            {#each modelOptions as model}
              <option value={model}>{getShortModelName(model)}</option>
            {/each}
          </select>
          {#if d.modelRecommendation}
            <p class="text-[11px] text-text-muted mt-1 max-w-48" title={d.modelRecommendation.reasoning}>
              {d.modelRecommendation.reasoning}
            </p>
          {/if}
        </div>

        <div>
          <div class="text-[11px] font-medium text-text-secondary mb-1">Effort</div>
          <select
            class="px-2 py-1.5 text-sm bg-surface border border-border rounded text-text-primary"
            value={d.effortLevel ?? ''}
            onchange={(e) => setEffort((e.currentTarget as HTMLSelectElement).value)}
            aria-label="Draft effort"
          >
            {#each EFFORT_OPTIONS as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </div>
      </div>

      <PromptChips selected={selectedChips} onchange={(next) => (selectedChips = next)} />

      <div class="flex items-center gap-2">
        <button
          class="px-4 py-1.5 rounded text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-50"
          disabled={editedTranscript.trim().length === 0}
          onclick={handleGo}
        >
          Go
        </button>
        <button
          class="px-4 py-1.5 rounded text-sm font-medium bg-surface hover:bg-border text-text-secondary transition-colors"
          onclick={handleCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  </div>
{/if}
