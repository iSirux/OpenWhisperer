<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { open } from '@tauri-apps/plugin-shell';
  import AppHeader from '$lib/components/AppHeader.svelte';
  import { configLoadedOk } from '$lib/stores/settings';

  let configFilePath = $state<string>('');
  let configDirPath = $state<string>('');

  onMount(async () => {
    try {
      const [filePath, dirPath] = await invoke<[string, string]>('get_config_paths');
      configFilePath = filePath;
      configDirPath = dirPath;
    } catch { /* non-critical */ }
  });
</script>

<div class="app-container h-screen flex flex-col bg-background">
  {#if !$configLoadedOk}
    <div class="config-warning bg-red-900/80 text-red-100 px-4 py-2 text-sm flex items-center gap-2 border-b border-red-700">
      <span class="font-bold">Warning:</span>
      <span>Config failed to parse and loaded defaults. Saves are blocked to protect your data. Fix or delete your config file to resume normal operation.</span>
      {#if configFilePath}
        <button
          class="underline hover:text-white cursor-pointer bg-transparent border-none text-red-200 text-sm p-0"
          onclick={() => invoke('open_config_file')}
        >Open config</button>
        <span class="text-red-400">|</span>
        <button
          class="underline hover:text-white cursor-pointer bg-transparent border-none text-red-200 text-sm p-0"
          onclick={() => open(configDirPath)}
        >Open folder</button>
      {/if}
    </div>
  {/if}

  <AppHeader />

  <slot />
</div>

<style>
  .app-container {
    user-select: none;
  }
</style>
