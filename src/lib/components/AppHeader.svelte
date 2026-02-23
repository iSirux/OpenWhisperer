<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import ModelSelector from './ModelSelector.svelte';
  import EffortToggle from './EffortToggle.svelte';
  import OpenMicMarquee from './OpenMicMarquee.svelte';
  import RepoIcon from '$lib/components/RepoIcon.svelte';
  import { navigation } from '$lib/stores/navigation';
  import { settings, type AutoModelEffort } from '$lib/stores/settings';
  import { repos, activeRepo, isAutoRepoSelected } from '$lib/stores/repos';
  import { isRecording, pendingTranscriptions } from '$lib/stores/recording';
  import { isRecordingForNewSession, pendingHeaderAction } from '$lib/stores/headerRecording';
  import { settingsToStoreEffort, type EffortLevel } from '$lib/stores/sdkSessions';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { isRepoAutoSelectEnabled } from '$lib/utils/llm';
  import { DEFAULT_OPENAI_MODEL_ID, isAutoModel } from '$lib/utils/models';
  import RateLimitIndicator from './RateLimitIndicator.svelte';

  // Derived state from stores
  let activeRepos = $derived($repos.list.filter((r) => r.active !== false));
  let activeRepoIndex = $derived($repos.activeIndex);
  let currentActiveRepo = $derived($activeRepo);
  let autoRepoSelected = $derived($isAutoRepoSelected);
  let sdkProvider = $derived($settings.sdk_provider);
  let currentProvider = $derived(sdkProvider === 'OpenAI' ? 'openai' : 'claude');
  let selectedModel = $derived(currentProvider === 'openai' ? $settings.openai_model : $settings.default_model);
  let defaultEffortLevel = $derived(settingsToStoreEffort($settings.default_effort_level));
  let autoModelEffort = $derived($settings.llm.features.auto_model_effort);
  let recording = $derived($isRecording);
  let recordingForNewSession = $derived($isRecordingForNewSession);
  let pending = $derived($pendingTranscriptions);
  let currentPath = $derived($page.url.pathname);

  // Check if current model is auto
  const isAuto = $derived(currentProvider === 'claude' && isAutoModel(selectedModel));

  let showRepoSelector = $state(false);
  let openaiAvailable = $state(false);
  const autoRepoEnabled = $derived(isRepoAutoSelectEnabled());

  // Detect if we're on settings route
  let isOnSettings = $derived(currentPath.startsWith('/settings'));

  onMount(() => {
    invoke<{ authenticated: boolean }>('check_openai_codex_auth')
      .then((result) => {
        openaiAvailable = result.authenticated;
      })
      .catch(() => {
        openaiAvailable = false;
      });
  });

  function handleRepoSelect(index: number) {
    repos.setActiveRepo(index);
    showRepoSelector = false;
  }

  function handleAutoRepoClick() {
    if (isRepoAutoSelectEnabled()) {
      repos.setAutoRepoMode(true);
      showRepoSelector = false;
    } else {
      showRepoSelector = false;
      goto('/settings?tab=llm');
    }
  }

  function handleAddRepo() {
    showRepoSelector = false;
    goto('/settings?tab=repos');
  }

  async function handleChangeModel(model: string) {
    if (currentProvider === 'openai') {
      settings.update((s) => ({ ...s, openai_model: model }));
      await settings.save({ ...$settings, openai_model: model });
      return;
    }
    settings.update((s) => ({ ...s, default_model: model }));
    await settings.save({ ...$settings, default_model: model });
  }

  async function handleChangeProvider(provider: 'Claude' | 'OpenAI') {
    const nextSettings = {
      ...$settings,
      sdk_provider: provider,
      openai_model: $settings.openai_model || DEFAULT_OPENAI_MODEL_ID,
    };
    settings.update(() => nextSettings);
    await settings.save(nextSettings);
  }

  async function handleChangeEffort(level: EffortLevel) {
    const settingsLevel = level === null ? 'off' : level;
    settings.update((s) => ({ ...s, default_effort_level: settingsLevel }));
    await settings.save({ ...$settings, default_effort_level: settingsLevel });
  }

  async function handleChangeAutoModelEffort(newSetting: AutoModelEffort) {
    settings.update((s) => ({
      ...s,
      llm: {
        ...s.llm,
        features: {
          ...s.llm.features,
          auto_model_effort: newSetting,
        },
      },
    }));
    await settings.save({
      ...$settings,
      llm: {
        ...$settings.llm,
        features: {
          ...$settings.llm.features,
          auto_model_effort: newSetting,
        },
      },
    });
  }

  function handleShowStart() {
    if (currentPath !== '/') {
      goto('/');
    }
    navigation.setView('start');
  }

  function handleToggleSettings() {
    if (isOnSettings) {
      goto('/');
    } else {
      goto('/settings');
    }
  }

  async function handleStartRecording() {
    if (currentPath !== '/') {
      pendingHeaderAction.set('start');
      await goto('/');
    } else {
      window.dispatchEvent(new CustomEvent('app:header-start-recording'));
    }
  }

  async function handleStopRecording() {
    if (currentPath !== '/') {
      pendingHeaderAction.set('stop');
      await goto('/');
    } else {
      window.dispatchEvent(new CustomEvent('app:header-stop-recording'));
    }
  }
</script>

<header class="header flex items-center justify-between px-4 py-2 border-b border-border bg-surface">
  <div class="flex items-center gap-4 flex-shrink-0">
    <button
      class="text-lg font-semibold text-text-primary hover:text-accent transition-colors"
      onclick={handleShowStart}
      title="Go to start page"
    >
      Claude Whisperer
    </button>

    <!-- Repo Selector Dropdown -->
    <div class="relative">
      <button
        class="repo-selector flex items-center gap-1.5 px-2 py-1 bg-surface-elevated hover:bg-border rounded text-[10px] font-medium transition-colors"
        onclick={() => showRepoSelector = !showRepoSelector}
        title="Select repository"
      >
        {#if autoRepoSelected}
          <span class="text-transparent bg-clip-text bg-gradient-to-r from-purple-500 to-amber-500">Auto</span>
        {:else if currentActiveRepo}
          <RepoIcon repo={currentActiveRepo} size="xs" />
          <span class="text-text-primary">{currentActiveRepo.name}</span>
        {:else}
          <span class="text-text-muted">No repo selected</span>
        {/if}
        <svg class="w-3 h-3 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {#if showRepoSelector}
        <div class="absolute top-full left-0 mt-1 w-64 bg-surface-elevated border border-border rounded shadow-lg z-50">
          {#if recording}
            <div class="px-3 py-2 border-b border-border bg-recording/10">
              <div class="flex items-center gap-2 text-xs text-recording">
                <div class="w-1.5 h-1.5 bg-recording rounded-full animate-pulse-recording"></div>
                <span>Recording - switch repository for this prompt</span>
              </div>
            </div>
          {/if}

          <!-- Auto repo option -->
          <button
            class="w-full px-3 py-2 text-left text-sm hover:bg-border transition-colors relative"
            class:bg-gradient-to-r={autoRepoSelected && autoRepoEnabled}
            class:from-purple-500={autoRepoSelected && autoRepoEnabled}
            class:to-amber-500={autoRepoSelected && autoRepoEnabled}
            class:text-white={autoRepoSelected && autoRepoEnabled}
            onclick={handleAutoRepoClick}
            title={autoRepoEnabled ? "Automatically select repository based on prompt content" : "Click to enable Auto Repo Selection in LLM settings"}
          >
            <div class="flex items-center justify-between">
              <div class="flex-1 min-w-0">
                <div class="font-medium flex items-center gap-2">
                  <span
                    class:text-transparent={!autoRepoSelected || !autoRepoEnabled}
                    class:bg-clip-text={!autoRepoSelected || !autoRepoEnabled}
                    class:bg-gradient-to-r={!autoRepoSelected || !autoRepoEnabled}
                    class:from-purple-500={!autoRepoSelected || !autoRepoEnabled}
                    class:to-amber-500={!autoRepoSelected || !autoRepoEnabled}
                    class:text-text-muted={!autoRepoEnabled}
                  >Auto</span>
                  {#if autoRepoSelected && autoRepoEnabled}
                    <svg class="w-3 h-3 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                    </svg>
                  {/if}
                </div>
                <div
                  class="text-xs"
                  class:text-text-muted={!autoRepoSelected || !autoRepoEnabled}
                  class:opacity-80={autoRepoSelected && autoRepoEnabled}
                >
                  {autoRepoEnabled ? "Select repo based on prompt" : "Enable in LLM settings"}
                </div>
              </div>
            </div>
          </button>

          {#if activeRepos.length > 0}
            <div class="border-t border-border"></div>
          {/if}

          {#each activeRepos as repo, index}
            {@const isSelected = index === activeRepoIndex && !autoRepoSelected}
            <button
              class="w-full px-3 py-2 text-left text-sm hover:bg-border transition-colors relative"
              class:bg-accent={isSelected}
              class:text-white={isSelected}
              onclick={() => handleRepoSelect(index)}
            >
              <div class="flex items-center gap-2">
                <RepoIcon repo={repo} size="sm" />
                <div class="flex-1 min-w-0">
                  <div class="font-medium flex items-center gap-2">
                    {repo.name}
                    {#if isSelected}
                      <svg class="w-3 h-3 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                      </svg>
                    {/if}
                  </div>
                  <div class="text-xs truncate" class:text-text-muted={!isSelected} class:opacity-80={isSelected}>
                    {repo.path}
                  </div>
                </div>
              </div>
            </button>
          {/each}

          {#if activeRepos.length === 0}
            <div class="px-3 py-2 text-sm text-text-muted">
              No repositories configured
            </div>
          {/if}

          <div class="border-t border-border">
            <button
              class="w-full px-3 py-2 text-left text-sm text-accent hover:bg-border transition-colors"
              onclick={handleAddRepo}
            >
              + Add repository
            </button>
          </div>
        </div>
      {/if}
    </div>

    <!-- Global Model Selector -->
    {#if openaiAvailable}
      <div class="flex items-center gap-0.5 px-1.5 py-0.5 bg-surface-elevated rounded">
        <button
          class="rounded px-2 py-0.5 text-[10px] font-medium transition-all"
          class:bg-accent={sdkProvider === 'Claude'}
          class:text-white={sdkProvider === 'Claude'}
          class:text-text-secondary={sdkProvider !== 'Claude'}
          class:bg-border={sdkProvider !== 'Claude'}
          onclick={() => handleChangeProvider('Claude')}
        >
          Claude
        </button>
        <button
          class="rounded px-2 py-0.5 text-[10px] font-medium transition-all"
          class:bg-green-600={sdkProvider === 'OpenAI'}
          class:text-white={sdkProvider === 'OpenAI'}
          class:text-text-secondary={sdkProvider !== 'OpenAI'}
          class:bg-border={sdkProvider !== 'OpenAI'}
          onclick={() => handleChangeProvider('OpenAI')}
        >
          Codex
        </button>
      </div>
    {/if}

    <!-- Global Model Selector -->
    <ModelSelector
      model={selectedModel}
      onchange={handleChangeModel}
      size="sm"
      provider={currentProvider}
    />

    <!-- Global Effort Toggle -->
    <EffortToggle
      effortLevel={defaultEffortLevel}
      onchange={handleChangeEffort}
      modelId={selectedModel}
      size="sm"
      isAutoModel={isAuto}
      {autoModelEffort}
      onChangeAutoModelEffort={handleChangeAutoModelEffort}
    />
  </div>

  <div class="flex items-center gap-2 min-w-0">
    <!-- Rate Limit Indicator -->
    <RateLimitIndicator />

    <!-- Open Mic Marquee (shows live transcription when listening) -->
    <OpenMicMarquee />

    <!-- Record Button -->
    {#if recording && recordingForNewSession}
      <button
        class="px-3 py-1.5 text-sm bg-recording hover:bg-recording/90 text-white rounded transition-colors flex items-center gap-2"
        onclick={handleStopRecording}
        title="Stop recording and send"
      >
        <div class="w-2 h-2 bg-white rounded-full animate-pulse"></div>
        Stop & Send
      </button>
    {:else if !recording}
      <div class="flex items-center gap-2">
        <!-- Pending transcriptions indicator -->
        {#if pending > 0}
          <div class="flex items-center gap-1.5 px-2 py-1 bg-warning/20 text-warning rounded text-xs" title="Transcriptions in progress">
            <div class="w-2 h-2 bg-warning rounded-full animate-pulse"></div>
            <span>{pending}</span>
          </div>
        {/if}
        <button
          class="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded transition-colors flex items-center gap-2"
          onclick={handleStartRecording}
          title="Record voice prompt"
        >
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clip-rule="evenodd" />
          </svg>
          Record
        </button>
      </div>
    {/if}

    <!-- Settings Button -->
    <button
      class="p-2 hover:bg-surface-elevated rounded transition-colors"
      class:bg-surface-elevated={isOnSettings}
      onclick={handleToggleSettings}
      title="Settings"
    >
      <svg class="w-5 h-5 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    </button>
  </div>
</header>
