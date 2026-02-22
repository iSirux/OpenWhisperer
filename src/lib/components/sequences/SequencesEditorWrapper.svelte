<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import type { SequenceDefinition } from '$lib/types/sequence';
  import SequenceEditor from '$lib/components/sequences/editor/SequenceEditor.svelte';

  let { editorId }: { editorId: string | null } = $props();

  let definition = $state<SequenceDefinition | undefined>(undefined);
  let loading = $state(true);
  let error = $state('');

  onMount(async () => {
    if (editorId) {
      try {
        definition = await invoke<SequenceDefinition>('get_sequence', { id: editorId });
      } catch (e) {
        error = `Failed to load sequence: ${e}`;
      }
    }
    loading = false;
  });
</script>

{#if loading}
  <div class="flex items-center justify-center h-full bg-surface-base">
    <span class="text-sm text-text-muted">Loading...</span>
  </div>
{:else if error}
  <div class="flex items-center justify-center h-full bg-surface-base">
    <span class="text-sm text-red-400">{error}</span>
  </div>
{:else}
  <SequenceEditor {definition} />
{/if}
