<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import ModelSelector from './ModelSelector.svelte';
  import EffortToggle from './EffortToggle.svelte';
  import OpenMicMarquee from './OpenMicMarquee.svelte';
  import RepoSelector from './RepoSelector.svelte';
  import { navigation } from '$lib/stores/navigation';
  import { settings, type AutoModelEffort } from '$lib/stores/settings';
  import { repos, activeRepo, isAutoRepoSelected } from '$lib/stores/repos';
  import { isRecording, pendingTranscriptions } from '$lib/stores/recording';
  import { recordingFlow, isRecordingForNewSession } from '$lib/stores/recordingFlow';
  import { settingsToStoreEffort, type EffortLevel } from '$lib/stores/sdkSessions';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { DEFAULT_OPENAI_MODEL_ID, isAutoModel } from '$lib/utils/models';
  import RateLimitIndicator from './RateLimitIndicator.svelte';
  import QueueIndicator from './QueueIndicator.svelte';
  import { updater, updateAvailable } from '$lib/stores/updater';

  // Derived state from stores
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
  let recordStopVerb = $derived(
    $settings.audio.record_and_send_action === 'prepare' ? 'prepare' : 'send'
  );

  // Check if current model is auto
  const isAuto = $derived(currentProvider === 'claude' && isAutoModel(selectedModel));

  let openaiAvailable = $state(false);

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

  function handleRepoChange(path: string) {
    if (!path) {
      repos.setAutoRepoMode(true);
      return;
    }
    const index = $repos.list.findIndex((r) => r.path === path);
    if (index >= 0) {
      repos.setActiveRepo(index);
    }
  }

  function handleAddRepo() {
    if (currentPath !== '/') {
      goto('/');
    }
    navigation.showRepositoryAdd();
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
    const settingsLevel = level === null ? 'low' : level;
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
    recordingFlow.startRecordingNewSession();
  }

  async function handleStopRecording() {
    recordingFlow.stopRecordingNewSession();
  }
</script>

<header class="header flex items-center justify-between px-4 py-2 border-b border-border bg-surface">
  <div class="flex items-center gap-4 flex-shrink-0">
    <button
      class="text-lg font-semibold text-text-primary hover:text-accent transition-colors"
      onclick={handleShowStart}
      title="Go to start page"
    >
      OpenWhisperer
    </button>

    <!-- Repo Selector Toggle Group -->
    <RepoSelector
      cwd={autoRepoSelected ? '' : currentActiveRepo?.path ?? ''}
      onchange={handleRepoChange}
      size="sm"
      maxVisible={3}
      dropdownDirection="down"
      notice={recording ? 'Recording - switch repository for this prompt' : undefined}
      onAddRepo={handleAddRepo}
    />

    <!-- Global Model Selector -->
    {#if openaiAvailable}
      <div class="flex items-center gap-0.5 px-1.5 py-0.5 bg-surface-elevated rounded">
        <button
          class="rounded px-2 py-0.5 text-[10px] font-medium transition-all"
          class:bg-orange-500={sdkProvider === 'Claude'}
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
      provider={currentProvider as 'openai' | 'claude'}
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
    <!-- Update Available Indicator -->
    {#if $updateAvailable}
      <button
        class="flex items-center gap-1.5 px-2 py-1 bg-accent/15 text-accent rounded text-xs hover:bg-accent/25 transition-colors"
        onclick={() => goto('/settings?tab=about')}
        title={$updater.status === 'downloading'
          ? 'Downloading update...'
          : `Update v${$updater.version} available — click to install`}
      >
        {#if $updater.status === 'downloading'}
          <div class="w-2 h-2 bg-accent rounded-full animate-pulse"></div>
          <span>Updating{$updater.progress != null ? ` ${Math.round($updater.progress * 100)}%` : '...'}</span>
        {:else}
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m0 0l-4-4m4 4l4-4" />
          </svg>
          <span>Update v{$updater.version}</span>
        {/if}
      </button>
    {/if}

    <!-- Rate Limit Indicator -->
    <RateLimitIndicator />

    <!-- Smart Queue Indicator (queued count + next reset) -->
    <QueueIndicator />

    <!-- Open Mic Marquee (shows live transcription when listening) -->
    <OpenMicMarquee />

    <!-- Record Button -->
    {#if recording && recordingForNewSession}
      <button
        class="px-3 py-1.5 text-sm bg-recording hover:bg-recording/90 text-white rounded transition-colors flex items-center gap-2"
        onclick={handleStopRecording}
        title={`Stop recording and ${recordStopVerb}`}
      >
        <div class="w-2 h-2 bg-white rounded-full animate-pulse"></div>
        {#if recordStopVerb === 'prepare'}
          Stop & Prepare
        {:else}
          Stop & Send
        {/if}
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
