<script lang="ts">
  import ModelSelector from './ModelSelector.svelte';
  import EffortToggle from './EffortToggle.svelte';
  import UsagePreview from './UsagePreview.svelte';
  import OpenMicMarquee from './OpenMicMarquee.svelte';
  import type { EffortLevel } from '$lib/stores/sdkSessions';
  import type { AutoModelEffort } from '$lib/stores/settings';
  import { isRepoAutoSelectEnabled } from '$lib/utils/llm';
  import { isAutoModel } from '$lib/utils/models';

  interface Repo {
    name: string;
    path: string;
    description?: string;
  }

  interface Props {
    repos: Repo[];
    activeRepoIndex: number;
    activeRepo: Repo | null | undefined;
    isAutoRepoSelected: boolean;
    defaultModel: string;
    defaultEffortLevel: EffortLevel;
    autoModelEffort: AutoModelEffort;
    isRecording: boolean;
    isRecordingForNewSession: boolean;
    pendingTranscriptions: number;
    currentView: string;
    onShowStart: () => void;
    onShowSettings: () => void;
    onShowSessions: () => void;
    onOpenSettingsTab: (tab: string) => void;
    onSelectRepo: (index: number) => void;
    onEnableAutoRepo: () => void;
    onChangeModel: (model: string) => void;
    onChangeEffort: (level: EffortLevel) => void;
    onChangeAutoModelEffort: (setting: AutoModelEffort) => void;
    onStartRecording: () => void;
    onStopRecording: () => void;
  }

  let {
    repos,
    activeRepoIndex,
    activeRepo,
    isAutoRepoSelected,
    defaultModel,
    defaultEffortLevel,
    autoModelEffort,
    isRecording,
    isRecordingForNewSession,
    pendingTranscriptions,
    currentView,
    onShowStart,
    onShowSettings,
    onShowSessions,
    onOpenSettingsTab,
    onSelectRepo,
    onEnableAutoRepo,
    onChangeModel,
    onChangeEffort,
    onChangeAutoModelEffort,
    onStartRecording,
    onStopRecording,
  }: Props = $props();

  // Check if current model is auto
  const isAuto = $derived(isAutoModel(defaultModel));

  let showRepoSelector = $state(false);
  const autoRepoEnabled = $derived(isRepoAutoSelectEnabled());

  function handleRepoSelect(index: number) {
    onSelectRepo(index);
    showRepoSelector = false;
  }

  function handleAutoRepoClick() {
    if (isRepoAutoSelectEnabled()) {
      onEnableAutoRepo();
      showRepoSelector = false;
    } else {
      showRepoSelector = false;
      onOpenSettingsTab('llm');
    }
  }

  function handleAddRepo() {
    showRepoSelector = false;
    onOpenSettingsTab('repos');
  }
</script>

<header class="header flex items-center justify-between px-4 py-2 border-b border-border bg-surface">
  <div class="flex items-center gap-4">
    <button
      class="text-lg font-semibold text-text-primary hover:text-accent transition-colors"
      onclick={onShowStart}
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
        {#if isAutoRepoSelected}
          <span class="text-transparent bg-clip-text bg-gradient-to-r from-purple-500 to-amber-500">Auto</span>
        {:else if activeRepo}
          <span class="text-text-primary">{activeRepo.name}</span>
        {:else}
          <span class="text-text-muted">No repo selected</span>
        {/if}
        <svg class="w-3 h-3 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {#if showRepoSelector}
        <div class="absolute top-full left-0 mt-1 w-64 bg-surface-elevated border border-border rounded shadow-lg z-50">
          {#if isRecording}
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
            class:bg-gradient-to-r={isAutoRepoSelected && autoRepoEnabled}
            class:from-purple-500={isAutoRepoSelected && autoRepoEnabled}
            class:to-amber-500={isAutoRepoSelected && autoRepoEnabled}
            class:text-white={isAutoRepoSelected && autoRepoEnabled}
            onclick={handleAutoRepoClick}
            title={autoRepoEnabled ? "Automatically select repository based on prompt content" : "Click to enable Auto Repo Selection in LLM settings"}
          >
            <div class="flex items-center justify-between">
              <div class="flex-1 min-w-0">
                <div class="font-medium flex items-center gap-2">
                  <span
                    class:text-transparent={!isAutoRepoSelected || !autoRepoEnabled}
                    class:bg-clip-text={!isAutoRepoSelected || !autoRepoEnabled}
                    class:bg-gradient-to-r={!isAutoRepoSelected || !autoRepoEnabled}
                    class:from-purple-500={!isAutoRepoSelected || !autoRepoEnabled}
                    class:to-amber-500={!isAutoRepoSelected || !autoRepoEnabled}
                    class:text-text-muted={!autoRepoEnabled}
                  >Auto</span>
                  {#if isAutoRepoSelected && autoRepoEnabled}
                    <svg class="w-3 h-3 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                    </svg>
                  {/if}
                </div>
                <div
                  class="text-xs"
                  class:text-text-muted={!isAutoRepoSelected || !autoRepoEnabled}
                  class:opacity-80={isAutoRepoSelected && autoRepoEnabled}
                >
                  {autoRepoEnabled ? "Select repo based on prompt" : "Enable in LLM settings"}
                </div>
              </div>
            </div>
          </button>

          {#if repos.length > 0}
            <div class="border-t border-border"></div>
          {/if}

          {#each repos as repo, index}
            {@const isSelected = index === activeRepoIndex && !isAutoRepoSelected}
            <button
              class="w-full px-3 py-2 text-left text-sm hover:bg-border transition-colors relative"
              class:bg-accent={isSelected}
              class:text-white={isSelected}
              onclick={() => handleRepoSelect(index)}
            >
              <div class="flex items-center justify-between">
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

          {#if repos.length === 0}
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
    <ModelSelector
      model={defaultModel}
      onchange={onChangeModel}
      size="sm"
    />

    <!-- Global Effort Toggle -->
    <EffortToggle
      effortLevel={defaultEffortLevel}
      onchange={onChangeEffort}
      modelId={defaultModel}
      size="sm"
      isAutoModel={isAuto}
      {autoModelEffort}
      onChangeAutoModelEffort={onChangeAutoModelEffort}
    />
  </div>

  <div class="flex items-center gap-2">
    <!-- Open Mic Marquee (shows live transcription when listening) -->
    <OpenMicMarquee />

    <!-- Usage Preview -->
    <UsagePreview />

    <!-- Record Button -->
    {#if isRecording && isRecordingForNewSession}
      <button
        class="px-3 py-1.5 text-sm bg-recording hover:bg-recording/90 text-white rounded transition-colors flex items-center gap-2"
        onclick={onStopRecording}
        title="Stop recording and send"
      >
        <div class="w-2 h-2 bg-white rounded-full animate-pulse"></div>
        Stop & Send
      </button>
    {:else if !isRecording}
      <div class="flex items-center gap-2">
        <!-- Pending transcriptions indicator -->
        {#if pendingTranscriptions > 0}
          <div class="flex items-center gap-1.5 px-2 py-1 bg-warning/20 text-warning rounded text-xs" title="Transcriptions in progress">
            <div class="w-2 h-2 bg-warning rounded-full animate-pulse"></div>
            <span>{pendingTranscriptions}</span>
          </div>
        {/if}
        <button
          class="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded transition-colors flex items-center gap-2"
          onclick={onStartRecording}
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
      class:bg-surface-elevated={currentView === 'settings'}
      onclick={() => {
        if (currentView === 'settings') {
          onShowSessions();
        } else {
          onShowSettings();
        }
      }}
      title="Settings"
    >
      <svg class="w-5 h-5 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    </button>
  </div>
</header>
