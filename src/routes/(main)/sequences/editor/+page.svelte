<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { invoke } from '@tauri-apps/api/core';
  import { settings } from '$lib/stores/settings';
  import type { SequenceDefinition } from '$lib/types/sequence';
  import SequenceEditor from '$lib/components/sequences/editor/SequenceEditor.svelte';

  let definition = $state<SequenceDefinition | undefined>(undefined);
  let loading = $state(true);
  let error = $state('');

  onMount(async () => {
    // Sequences are gated entirely behind developer mode.
    if (!get(settings).system.dev_mode) {
      goto('/');
      return;
    }
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
  <div class="flex items-center justify-center flex-1 bg-surface-base">
    <span class="text-sm text-text-muted">Loading...</span>
  </div>
{:else if error}
  <div class="flex items-center justify-center flex-1 bg-surface-base">
    <span class="text-sm text-red-400">{error}</span>
  </div>
{:else}
  <SequenceEditor {definition} />
{/if}
