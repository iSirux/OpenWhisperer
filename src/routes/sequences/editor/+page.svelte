<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { invoke } from '@tauri-apps/api/core';
  import type { SequenceDefinition } from '$lib/types/sequence';
  import SequenceEditor from '$lib/components/sequences/editor/SequenceEditor.svelte';

  let definition = $state<SequenceDefinition | undefined>(undefined);
  let loading = $state(true);
  let error = $state('');

  onMount(async () => {
    const id = $page.url.searchParams.get('id');
    if (id) {
      try {
        definition = await invoke<SequenceDefinition>('get_sequence', { id });
      } catch (e) {
        error = `Failed to load sequence: ${e}`;
      }
    }
    loading = false;
  });
</script>

{#if loading}
  <div class="flex items-center justify-center h-screen bg-surface-base">
    <span class="text-sm text-text-muted">Loading...</span>
  </div>
{:else if error}
  <div class="flex items-center justify-center h-screen bg-surface-base">
    <span class="text-sm text-red-400">{error}</span>
  </div>
{:else}
  <SequenceEditor {definition} />
{/if}
