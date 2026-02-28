<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { sequences, loadSequences, deleteSequence, saveSequence, exportSequence, listSchedules, toggleSchedule } from '$lib/stores/sequences';
  import type { SequenceDefinition, ScheduleInfo } from '$lib/types/sequence';
  import SequenceInputDialog from '$lib/components/sequences/SequenceInputDialog.svelte';

  let searchQuery = $state('');
  let selectedTag = $state<string | null>(null);
  let showImportDialog = $state(false);
  let importYaml = $state('');
  let importError = $state('');
  let runSequence = $state<SequenceDefinition | null>(null);
  let schedules = $state<ScheduleInfo[]>([]);

  // All unique tags
  let allTags = $derived(
    [...new Set($sequences.flatMap(s => s.tags))]
  );

  // Filtered sequences
  let filtered = $derived(
    $sequences.filter(s => {
      const matchesSearch = !searchQuery ||
        s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (s.description?.toLowerCase().includes(searchQuery.toLowerCase()));
      const matchesTag = !selectedTag || s.tags.includes(selectedTag);
      return matchesSearch && matchesTag;
    })
  );

  onMount(async () => {
    await loadSequences();
    schedules = await listSchedules();
  });

  async function handleImport() {
    importError = '';
    try {
      await saveSequence(importYaml);
      showImportDialog = false;
      importYaml = '';
    } catch (e: unknown) {
      importError = e?.toString() ?? 'Failed to import';
    }
  }

  async function handleExport(id: string) {
    try {
      const yaml = await exportSequence(id);
      await navigator.clipboard.writeText(yaml);
    } catch (e) {
      console.error('Export failed:', e);
    }
  }

  async function handleDelete(id: string) {
    if (confirm('Delete this sequence?')) {
      await deleteSequence(id);
    }
  }

  async function handleToggleSchedule(schedule: ScheduleInfo) {
    await toggleSchedule(schedule.sequence_id, schedule.cron, !schedule.enabled);
    schedules = await listSchedules();
  }

  function formatScheduleTime(value?: string): string {
    if (!value) return 'Not available';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Invalid time';
    return date.toLocaleString();
  }
</script>

<div class="flex flex-col flex-1 overflow-hidden">
  <div class="flex items-center justify-between px-4 py-2 border-b border-border">
    <div class="flex items-center gap-3">
      <h2 class="text-sm font-semibold text-text-primary">Sequences</h2>
      <span class="text-xs text-text-muted">{$sequences.length} sequences</span>
    </div>

    <div class="flex items-center gap-2">
      <input type="text" bind:value={searchQuery}
        placeholder="Search..."
        class="px-2 py-1 text-sm rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none w-40" />
      <button class="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/80 transition-colors"
        onclick={() => goto('/sequences/editor')}>
        New Sequence
      </button>
      <button class="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/80 transition-colors"
        onclick={() => showImportDialog = true}>
        Import YAML
      </button>
    </div>
  </div>

  <!-- Tags filter -->
  {#if allTags.length > 0}
    <div class="flex items-center gap-1 px-4 py-2 border-b border-border overflow-x-auto">
      <button class="px-2 py-0.5 text-xs rounded-full transition-colors"
        class:bg-accent={!selectedTag}
        class:text-white={!selectedTag}
        class:bg-surface-elevated={selectedTag !== null}
        class:text-text-muted={selectedTag !== null}
        onclick={() => selectedTag = null}>
        All
      </button>
      {#each allTags as tag}
        <button class="px-2 py-0.5 text-xs rounded-full transition-colors"
          class:bg-accent={selectedTag === tag}
          class:text-white={selectedTag === tag}
          class:bg-surface-elevated={selectedTag !== tag}
          class:text-text-muted={selectedTag !== tag}
          onclick={() => selectedTag = selectedTag === tag ? null : tag}>
          {tag}
        </button>
      {/each}
    </div>
  {/if}

  <!-- Grid -->
  <div class="flex-1 overflow-y-auto p-4">
    {#if filtered.length === 0}
      <div class="flex flex-col items-center justify-center h-full text-text-muted">
        <svg class="w-12 h-12 mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z"/>
        </svg>
        <p class="text-sm">No sequences yet</p>
        <p class="text-xs mt-1">Import a YAML file to get started</p>
      </div>
    {:else}
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {#each filtered as seq (seq.id)}
          <div class="border border-border rounded-lg p-3 hover:border-accent/50 transition-colors bg-surface">
            <div class="flex items-start justify-between mb-2">
              <h3 class="text-sm font-medium text-text-primary">{seq.name}</h3>
              <div class="flex items-center gap-1">
                <button class="p-1 text-text-muted hover:text-accent transition-colors" title="Edit"
                  onclick={() => goto(`/sequences/editor?id=${seq.id}`)}>
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                  </svg>
                </button>
                <button class="p-1 text-text-muted hover:text-accent transition-colors" title="Run"
                  onclick={() => runSequence = seq}>
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                  </svg>
                </button>
                <button class="p-1 text-text-muted hover:text-text-primary transition-colors" title="Export"
                  onclick={() => handleExport(seq.id)}>
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                  </svg>
                </button>
                <button class="p-1 text-text-muted hover:text-red-400 transition-colors" title="Delete"
                  onclick={() => handleDelete(seq.id)}>
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                  </svg>
                </button>
              </div>
            </div>

            {#if seq.description}
              <p class="text-xs text-text-muted mb-2 line-clamp-2">{seq.description}</p>
            {/if}

            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-[10px] text-text-muted">{seq.nodes.length} nodes</span>
              {#each seq.tags.slice(0, 3) as tag}
                <span class="px-1.5 py-0.5 text-[10px] rounded bg-surface-elevated text-text-muted">{tag}</span>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Schedules Section -->
  {#if schedules.length > 0}
    <div class="border-t border-border px-4 py-3">
      <h3 class="text-sm font-semibold text-text-primary mb-2">Scheduled Sequences</h3>
      <div class="space-y-1">
        {#each schedules as schedule}
          <div class="flex items-center justify-between py-1.5 px-2 rounded hover:bg-surface-elevated">
            <div class="flex items-center gap-3">
              <span class="text-xs font-medium text-text-primary">{schedule.sequence_name}</span>
              <code class="text-[10px] text-text-muted bg-surface-elevated px-1.5 py-0.5 rounded">{schedule.cron}</code>
            </div>
            <div class="flex items-center gap-3">
              <span class="text-[10px] text-text-muted" title={schedule.next_fire || 'No next run available'}>
                Next run: {formatScheduleTime(schedule.next_fire)}
              </span>
              <span class="text-[10px] text-text-muted" title={schedule.last_run || 'No previous run'}>
                Last run: {formatScheduleTime(schedule.last_run)}
              </span>
              <label class="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={schedule.enabled}
                  onchange={() => handleToggleSchedule(schedule)}
                  class="rounded border-border accent-accent" />
                <span class="text-[10px] text-text-muted">{schedule.enabled ? 'On' : 'Off'}</span>
              </label>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<!-- Import Dialog -->
{#if showImportDialog}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    onclick={() => showImportDialog = false}
    role="dialog" aria-modal="true" aria-label="Import sequence">
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="bg-surface border border-border rounded-lg shadow-xl w-full max-w-lg mx-4"
      onclick={(e) => e.stopPropagation()}>
      <header class="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 class="text-sm font-semibold text-text-primary">Import Sequence</h3>
      </header>
      <div class="p-4">
        <textarea bind:value={importYaml}
          placeholder="Paste YAML here..."
          class="w-full h-64 px-3 py-2 text-sm font-mono rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none resize-none"></textarea>
        {#if importError}
          <p class="text-xs text-red-400 mt-2">{importError}</p>
        {/if}
      </div>
      <footer class="flex justify-end gap-2 px-4 py-3 border-t border-border">
        <button class="px-3 py-1.5 text-xs rounded border border-border text-text-secondary hover:bg-surface-elevated"
          onclick={() => showImportDialog = false}>Cancel</button>
        <button class="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/80"
          onclick={handleImport}>Import</button>
      </footer>
    </div>
  </div>
{/if}

<!-- Run Dialog -->
{#if runSequence}
  <SequenceInputDialog sequence={runSequence} onclose={() => runSequence = null} />
{/if}
