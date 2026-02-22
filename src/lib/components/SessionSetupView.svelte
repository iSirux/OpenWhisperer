<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import type { EffortLevel, SdkImageContent } from '$lib/stores/sdkSessions';
  import type { RepoConfig } from '$lib/stores/settings';
  import { settings } from '$lib/stores/settings';
  import RepoIcon from '$lib/components/RepoIcon.svelte';
  import { findRepoByPath } from '$lib/utils/repoIcons';
  import { isRecording, isTranscribing } from '$lib/stores/recording';
  import {
    getModelBgColor,
    getModelRingColor,
    getModelHoverBgColor,
  } from '$lib/utils/modelColors';
  import {
    getEnabledModelsWithAuto,
    getEnabledModels,
    getProviderForModel,
    isAutoModel,
    DEFAULT_MODEL_ID,
    DEFAULT_OPENAI_MODEL_ID,
    modelSupportsEffort,
    getMaxEffort,
    type SdkProvider,
  } from '$lib/utils/models';
  import { isRepoAutoSelectEnabled } from '$lib/utils/llm';
  import {
    getImagesFromClipboard,
    getImagesFromDrop,
    processImages,
    createPreviewUrl,
    formatFileSize,
    type ImageData,
  } from '$lib/utils/image';

  interface Props {
    initialModel?: string;
    initialProvider?: SdkProvider;
    initialEffortLevel?: EffortLevel;
    initialCwd?: string;
    initialPlanMode?: boolean;
    initialNoteMode?: boolean;
    isRecordingForSetup?: boolean;
    onStart: (config: {
      prompt: string;
      images?: SdkImageContent[];
      model: string;
      effortLevel: EffortLevel;
      cwd: string;
      planMode: boolean;
      noteMode: boolean;
      provider?: SdkProvider;
    }) => void;
    onStartRecording: () => void;
    onStopRecording: () => Promise<string | null>;
    onCancel?: () => void;
  }

  let {
    initialModel = DEFAULT_MODEL_ID,
    initialProvider = undefined,
    initialEffortLevel = null,
    initialCwd = '',
    initialPlanMode = false,
    initialNoteMode = false,
    isRecordingForSetup = false,
    onStart,
    onStartRecording,
    onStopRecording,
    onCancel,
  }: Props = $props();

  // Local state
  let prompt = $state('');
  let model = $state(initialModel);
  let effortLevel = $state<EffortLevel>(initialEffortLevel);
  let cwd = $state(initialCwd);
  let planMode = $state(initialPlanMode);
  let noteMode = $state(initialNoteMode);
  let pendingImages = $state<ImageData[]>([]);
  let isProcessingImages = $state(false);
  let showRepoDropdown = $state(false);
  let provider = $state<SdkProvider>(initialProvider ?? getProviderForModel(initialModel));
  let openaiAvailable = $state(false);
  let isStarting = $state(false);
  let isAwaitingTranscript = $state(false);
  let textareaEl: HTMLTextAreaElement;

  // Derived state
  const repos = $derived(($settings.repos || []).filter((r) => r.active !== false));
  const autoRepoEnabled = $derived(isRepoAutoSelectEnabled());
  const isAutoRepoMode = $derived(!cwd || cwd === '.');
  const isSmartModelEnabled = $derived(
    $settings.llm?.enabled && $settings.llm?.features?.recommend_model
  );
  const models = $derived(
    provider === 'openai'
      ? getEnabledModels($settings.enabled_openai_models, 'openai')
      : getEnabledModelsWithAuto($settings.enabled_models)
  );

  const currentRepoName = $derived(() => {
    if (!cwd || cwd === '.') return 'Auto';
    const repo = repos.find(r => r.path === cwd);
    return repo?.name || cwd.split(/[/\\]/).pop() || 'Unknown';
  });

  const canStart = $derived(prompt.trim() || pendingImages.length > 0);

  // Focus textarea on mount
  $effect(() => {
    if (textareaEl && !initialPlanMode) {
      textareaEl.focus();
    }
  });

  // Check if OpenAI Codex is available
  $effect(() => {
    invoke<{ authenticated: boolean }>('check_openai_codex_auth')
      .then(result => {
        openaiAvailable = result.authenticated;
        if (!openaiAvailable && provider === 'openai') {
          provider = 'claude';
          model = $settings.default_model || DEFAULT_MODEL_ID;
        }
      })
      .catch(() => {
        openaiAvailable = false;
        if (provider === 'openai') {
          provider = 'claude';
          model = $settings.default_model || DEFAULT_MODEL_ID;
        }
      });
  });

  // Keep selected model aligned with current provider and enabled model list.
  $effect(() => {
    const availableModels = models;
    if (availableModels.length === 0) return;

    if (!availableModels.some((m) => m.id === model)) {
      model = provider === 'openai'
        ? ($settings.openai_model || availableModels[0].id || DEFAULT_OPENAI_MODEL_ID)
        : ($settings.default_model || availableModels[0].id || DEFAULT_MODEL_ID);
    }
  });

  // Auto-resize textarea
  function autoResize() {
    if (textareaEl) {
      textareaEl.style.height = 'auto';
      const maxHeight = 200;
      const newHeight = Math.min(textareaEl.scrollHeight, maxHeight);
      textareaEl.style.height = newHeight + 'px';
      textareaEl.style.overflowY = textareaEl.scrollHeight > maxHeight ? 'auto' : 'hidden';
    }
  }

  $effect(() => {
    prompt;
    autoResize();
  });

  async function handleStart() {
    if (!canStart || isStarting) return;

    isStarting = true;

    const imageContent: SdkImageContent[] | undefined = pendingImages.length > 0
      ? pendingImages.map(img => ({
          mediaType: img.mediaType,
          base64Data: img.base64Data,
          width: img.width,
          height: img.height,
        }))
      : undefined;

    try {
      await onStart({
        prompt: prompt.trim(),
        images: imageContent,
        model,
        effortLevel,
        cwd,
        planMode,
        noteMode,
        provider: noteMode ? 'claude' : provider,
      });
    } finally {
      isStarting = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleStart();
    }
  }

  // Image handling
  async function handlePaste(e: ClipboardEvent) {
    const imageFiles = await getImagesFromClipboard(e);
    if (imageFiles.length > 0) {
      e.preventDefault();
      await addImages(imageFiles);
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    const imageFiles = getImagesFromDrop(e);
    if (imageFiles.length > 0) {
      await addImages(imageFiles);
    }
  }

  async function addImages(files: File[]) {
    if (isProcessingImages) return;
    isProcessingImages = true;
    try {
      const processed = await processImages(files);
      pendingImages = [...pendingImages, ...processed];
    } catch (err) {
      console.error('[SessionSetupView] Error processing images:', err);
    } finally {
      isProcessingImages = false;
    }
  }

  function removeImage(index: number) {
    pendingImages = pendingImages.filter((_, i) => i !== index);
  }

  // Recording handling
  async function handleStopRecording() {
    isAwaitingTranscript = true;
    try {
      const transcript = await onStopRecording();
      if (transcript) {
        // Append to existing prompt with a space separator
        prompt = prompt ? `${prompt} ${transcript}` : transcript;
        autoResize();
      }
    } finally {
      isAwaitingTranscript = false;
    }
  }

  // Model handling
  function handleModelClick(id: string) {
    if (isAutoModel(id) && !isSmartModelEnabled) {
      window.dispatchEvent(new CustomEvent('open-settings', { detail: { tab: 'llm' } }));
      return;
    }
    model = id;
  }

  function handleProviderSwitch(newProvider: SdkProvider) {
    if (newProvider === provider) return;
    provider = newProvider;
    // Reset model to the default for the new provider
    if (newProvider === 'openai') {
      model = $settings.openai_model || DEFAULT_OPENAI_MODEL_ID;
    } else {
      model = $settings.default_model || DEFAULT_MODEL_ID;
    }
  }

  function getModelButtonClasses(id: string, isSelected: boolean): string {
    const base = 'rounded font-medium transition-all px-3 py-1.5 text-xs';

    if (isAutoModel(id) && !isSmartModelEnabled) {
      return `${base} text-text-muted hover:text-text-secondary hover:bg-surface-elevated`;
    }

    if (isSelected) {
      if (isAutoModel(id)) {
        return `${base} bg-gradient-to-r from-purple-500 to-amber-500 text-white shadow-md ring-2 ring-purple-400 ring-opacity-50`;
      }
      return `${base} ${getModelBgColor(id)} text-white shadow-md ring-2 ${getModelRingColor(id)} ring-opacity-50`;
    }

    if (isAutoModel(id)) {
      return `${base} text-text-secondary hover:bg-gradient-to-r hover:from-purple-500/20 hover:to-amber-500/20`;
    }

    return `${base} text-text-secondary ${getModelHoverBgColor(id)}`;
  }

  // Repo handling
  function handleRepoSelect(path: string) {
    cwd = path;
    showRepoDropdown = false;
  }

  function handleAutoRepoClick() {
    if (autoRepoEnabled) {
      cwd = '';
      showRepoDropdown = false;
    } else {
      showRepoDropdown = false;
      window.dispatchEvent(new CustomEvent('open-settings', { detail: { tab: 'llm' } }));
    }
  }

  function handleClickOutside(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (!target.closest('.repo-selector-container')) {
      showRepoDropdown = false;
    }
  }
</script>

<svelte:window onclick={handleClickOutside} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="setup-view" ondragover={handleDragOver} ondrop={handleDrop}>
  <div class="setup-content">
    <!-- Header -->
    <div class="setup-header">
      <div class="header-icon" class:note={noteMode}>
        {#if noteMode}
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        {:else if planMode}
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
          </svg>
        {:else}
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        {/if}
      </div>
      <div class="header-content">
        <h3 class="header-title">
          {noteMode ? 'New Note' : planMode ? 'Start Planning Session' : 'New Session'}
        </h3>
        <p class="header-description">
          {noteMode
            ? 'Capture a voice note. The AI will create a note using your configured note-taking tools.'
            : planMode
              ? 'Describe the feature you want to plan. The AI will help you flesh out the requirements.'
              : 'Enter your prompt to start a new session'}
        </p>
      </div>
    </div>

    <!-- Mode Toggle -->
    <div class="option-row">
      <label class="option-label">Mode</label>
      <div class="mode-toggle">
        <button
          class="mode-btn"
          class:active={!planMode && !noteMode}
          onclick={() => { planMode = false; noteMode = false; }}
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          Execute
        </button>
        <button
          class="mode-btn plan"
          class:active={planMode}
          onclick={() => { planMode = true; noteMode = false; }}
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
          </svg>
          Plan
        </button>
        <button
          class="mode-btn note"
          class:active={noteMode}
          onclick={() => { noteMode = true; planMode = false; }}
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          Note
        </button>
      </div>
    </div>

    <!-- Provider Toggle (only show when both providers are available) -->
    {#if openaiAvailable && !noteMode}
      <div class="option-row">
        <label class="option-label">Provider</label>
        <div class="mode-toggle">
          <button
            class="mode-btn"
            class:active={provider === 'claude'}
            onclick={() => handleProviderSwitch('claude')}
            style={provider === 'claude' ? 'background: var(--color-accent);' : ''}
          >
            Claude
          </button>
          <button
            class="mode-btn"
            class:active={provider === 'openai'}
            onclick={() => handleProviderSwitch('openai')}
            style={provider === 'openai' ? 'background: #16a34a;' : ''}
          >
            Codex
          </button>
        </div>
      </div>
    {/if}

    <!-- Model Selector -->
    <div class="option-row">
      <label class="option-label">Model</label>
      <div class="model-selector">
        {#each models as { id, label, title }}
          <button
            class={getModelButtonClasses(id, model === id)}
            onclick={() => handleModelClick(id)}
            title={isAutoModel(id) && !isSmartModelEnabled ? 'Enable in LLM settings' : title}
          >
            {label}
          </button>
        {/each}
      </div>
    </div>

    <!-- Effort Level -->
    {#if modelSupportsEffort(model) || isAutoModel(model)}
      <div class="option-row">
        <label class="option-label">Effort</label>
        <div class="flex items-center gap-2">
          {#each (['off', 'low', 'medium', 'high', ...(getMaxEffort(model) === 'max' ? ['max'] : [])] as const) as level}
            <button
              class="effort-option-btn"
              class:active={level === 'off' ? effortLevel === null : effortLevel === level}
              onclick={() => effortLevel = level === 'off' ? null : level as EffortLevel}
            >
              {level === 'off' ? 'Off' : level.charAt(0).toUpperCase() + level.slice(1)}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Repository Selector -->
    <div class="option-row">
      <label class="option-label">Repository</label>
      <div class="repo-selector-container relative">
        <button
          class="repo-btn"
          onclick={() => showRepoDropdown = !showRepoDropdown}
        >
          {#if isAutoRepoMode && autoRepoEnabled}
            <span class="auto-text">{currentRepoName()}</span>
          {:else}
            <RepoIcon repo={findRepoByPath(repos, cwd)} size="sm" />
            <span>{currentRepoName()}</span>
          {/if}
          <svg class="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {#if showRepoDropdown}
          <div class="repo-dropdown">
            <!-- Auto option -->
            <button
              class="repo-option"
              class:selected={isAutoRepoMode && autoRepoEnabled}
              onclick={handleAutoRepoClick}
            >
              <span class="flex items-center gap-2">
                <span class:auto-text={autoRepoEnabled && !isAutoRepoMode} class:text-text-muted={!autoRepoEnabled}>
                  Auto
                </span>
                {#if !autoRepoEnabled}
                  <span class="text-text-muted text-[10px]">(enable in settings)</span>
                {/if}
              </span>
              {#if isAutoRepoMode && autoRepoEnabled}
                <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                </svg>
              {/if}
            </button>

            {#if repos.length > 0}
              <div class="repo-divider"></div>
            {/if}

            {#each repos as repo}
              {@const isSelected = repo.path === cwd}
              <button
                class="repo-option"
                class:selected={isSelected}
                onclick={() => handleRepoSelect(repo.path)}
                title={repo.path}
              >
                <div class="repo-option-left">
                  <RepoIcon repo={repo} size="sm" />
                  <div class="repo-info">
                    <div class="repo-name">{repo.name}</div>
                    {#if repo.description}
                      <div class="repo-desc">{repo.description}</div>
                    {/if}
                  </div>
                </div>
                {#if isSelected}
                  <svg class="w-3 h-3 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                  </svg>
                {/if}
              </button>
            {/each}

            {#if repos.length === 0}
              <div class="px-3 py-2 text-xs text-text-muted">
                No repositories configured
              </div>
            {/if}

            <div class="repo-divider"></div>
            <button
              class="repo-option add-repo"
              onclick={() => {
                showRepoDropdown = false;
                window.dispatchEvent(new CustomEvent('open-settings', { detail: { tab: 'repos' } }));
              }}
            >
              + Add repository
            </button>
          </div>
        {/if}
      </div>
    </div>

    <!-- Prompt Input -->
    <div class="prompt-section">
      <label class="option-label">
        {noteMode ? 'Your note' : planMode ? 'What do you want to plan?' : 'Your prompt'}
      </label>

      {#if pendingImages.length > 0 || isProcessingImages}
        <div class="pending-images">
          {#each pendingImages as img, i}
            <div class="pending-image">
              <img src={createPreviewUrl(img)} alt="Pending" />
              <button
                class="remove-image"
                onclick={() => removeImage(i)}
                title="Remove image"
              >
                <svg viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
                </svg>
              </button>
              <span class="image-size">{formatFileSize(img.compressedSize)}</span>
            </div>
          {/each}
          {#if isProcessingImages}
            <div class="pending-image processing">
              <div class="processing-spinner"></div>
            </div>
          {/if}
        </div>
      {/if}

      <textarea
        bind:this={textareaEl}
        bind:value={prompt}
        oninput={autoResize}
        onkeydown={handleKeydown}
        onpaste={handlePaste}
        placeholder={noteMode
          ? 'Enter your note content or use the Record button...'
          : planMode
            ? 'Describe the feature you want to plan...'
            : 'Enter your prompt... (Ctrl+V to paste images)'}
        rows="3"
      ></textarea>

      <div class="prompt-hint">
        Press <kbd>Ctrl</kbd> + <kbd>Enter</kbd> to start, or use the button below
      </div>
    </div>

    <!-- Action Buttons -->
    <div class="action-row">
      {#if isAwaitingTranscript || $isTranscribing}
        <button class="record-btn transcribing" disabled>
          <div class="transcribing-spinner"></div>
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clip-rule="evenodd" />
          </svg>
          Transcribing...
        </button>
      {:else if $isRecording && isRecordingForSetup}
        <button class="record-btn recording" onclick={handleStopRecording}>
          <div class="recording-pulse"></div>
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clip-rule="evenodd" />
          </svg>
          Stop Recording
        </button>
      {:else if !$isRecording}
        <button class="record-btn" onclick={onStartRecording}>
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clip-rule="evenodd" />
          </svg>
          Record
        </button>
      {/if}

      <button
        class="start-btn"
        class:plan={planMode}
        class:note={noteMode}
        class:loading={isStarting}
        disabled={!canStart || isStarting}
        onclick={handleStart}
      >
        {#if isStarting}
          <div class="start-spinner"></div>
          {noteMode ? 'Creating Note...' : planMode ? 'Starting Planning...' : 'Starting Session...'}
        {:else if noteMode}
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          Create Note
        {:else if planMode}
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          Start Planning
        {:else}
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Start Session
        {/if}
      </button>
    </div>

    {#if onCancel}
      <div class="cancel-section">
        <button class="cancel-btn" onclick={onCancel}>
          Cancel
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .setup-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-background);
    color: var(--color-text-primary);
    overflow-y: auto;
  }

  .setup-content {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding: 1.5rem;
    max-width: 40rem;
    margin: 0 auto;
    width: 100%;
  }

  .setup-header {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    padding: 1rem;
    background: var(--color-surface-elevated);
    border-radius: 0.75rem;
    border: 1px solid var(--color-border);
  }

  .header-icon {
    flex-shrink: 0;
    color: var(--color-accent);
    padding: 0.5rem;
    background: color-mix(in srgb, var(--color-accent) 10%, transparent);
    border-radius: 0.5rem;
  }

  .header-icon.note {
    color: #f59e0b;
    background: rgba(245, 158, 11, 0.1);
  }

  .header-content {
    flex: 1;
  }

  .header-title {
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--color-text-primary);
    margin: 0;
  }

  .header-description {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    margin: 0.25rem 0 0;
  }

  .option-row {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .option-label {
    font-size: 0.8rem;
    color: var(--color-text-muted);
    min-width: 80px;
    flex-shrink: 0;
  }

  /* Mode Toggle */
  .mode-toggle {
    display: flex;
    gap: 0.25rem;
    padding: 0.25rem;
    background: var(--color-surface);
    border-radius: 0.5rem;
    border: 1px solid var(--color-border);
  }

  .mode-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .mode-btn:hover {
    background: var(--color-surface-elevated);
  }

  .mode-btn.active {
    background: var(--color-accent);
    color: white;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }

  .mode-btn.plan.active {
    background: #06b6d4;
  }

  .mode-btn.note.active {
    background: #f59e0b;
  }

  /* Model Selector */
  .model-selector {
    display: flex;
    gap: 0.25rem;
    padding: 0.25rem;
    background: var(--color-surface);
    border-radius: 0.5rem;
    border: 1px solid var(--color-border);
  }

  /* Effort Option Button */
  .effort-option-btn {
    padding: 0.35rem 0.75rem;
    border-radius: 0.375rem;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--color-text-secondary);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    transition: all 0.15s ease;
  }

  .effort-option-btn:hover {
    background: var(--color-surface-elevated);
    border-color: var(--color-accent);
  }

  .effort-option-btn.active {
    background: #0891b2;
    color: white;
    border-color: #06b6d4;
  }

  /* Repo Selector */
  .repo-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border-radius: 0.5rem;
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--color-text-primary);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    transition: all 0.15s ease;
  }

  .repo-btn:hover {
    background: var(--color-surface-elevated);
    border-color: var(--color-accent);
  }

  .auto-text {
    background: linear-gradient(to right, #a855f7, #f59e0b);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .repo-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 0.25rem;
    width: 16rem;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 50;
    max-height: 16rem;
    overflow-y: auto;
  }

  .repo-option {
    width: 100%;
    padding: 0.625rem 0.875rem;
    text-align: left;
    font-size: 0.8rem;
    color: var(--color-text-primary);
    display: flex;
    align-items: center;
    justify-content: space-between;
    transition: background 0.15s ease;
  }

  .repo-option:hover {
    background: var(--color-border);
  }

  .repo-option.selected {
    background: var(--color-accent);
    color: white;
  }

  .repo-option.add-repo {
    color: var(--color-accent);
  }

  .repo-option-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
  }

  .repo-info {
    flex: 1;
    min-width: 0;
  }

  .repo-name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .repo-desc {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: 0.125rem;
  }

  .repo-option.selected .repo-desc {
    color: rgba(255, 255, 255, 0.7);
  }

  .repo-divider {
    height: 1px;
    background: var(--color-border);
    margin: 0.25rem 0;
  }

  /* Prompt Section */
  .prompt-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  textarea {
    width: 100%;
    padding: 0.875rem 1rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    color: var(--color-text-primary);
    font-size: 0.9rem;
    font-family: inherit;
    resize: none;
    overflow-y: hidden;
    transition: border-color 0.15s ease;
    line-height: 1.5;
  }

  textarea:focus {
    outline: none;
    border-color: var(--color-accent);
  }

  textarea::placeholder {
    color: var(--color-text-muted);
  }

  .prompt-hint {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .prompt-hint kbd {
    padding: 0.125rem 0.375rem;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    border-radius: 0.25rem;
    font-size: 0.7rem;
    font-family: inherit;
  }

  /* Pending Images */
  .pending-images {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.5rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-bottom: none;
    border-radius: 0.5rem 0.5rem 0 0;
  }

  .pending-image {
    position: relative;
    width: 80px;
    height: 80px;
    border-radius: 0.25rem;
    overflow: hidden;
    background: var(--color-surface-elevated);
  }

  .pending-image img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .pending-image .remove-image {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 20px;
    height: 20px;
    padding: 2px;
    background: rgba(0, 0, 0, 0.7);
    border: none;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.2s;
  }

  .pending-image:hover .remove-image {
    opacity: 1;
  }

  .pending-image .remove-image svg {
    width: 12px;
    height: 12px;
    color: #fff;
  }

  .pending-image .image-size {
    position: absolute;
    bottom: 2px;
    left: 2px;
    font-size: 0.65rem;
    color: #fff;
    background: rgba(0, 0, 0, 0.7);
    padding: 1px 4px;
    border-radius: 2px;
  }

  .pending-image.processing {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .processing-spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--color-border);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .setup-content:has(.pending-images) textarea {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
    border-top: none;
  }

  /* Action Buttons */
  .action-row {
    display: flex;
    gap: 0.75rem;
    padding-top: 0.5rem;
  }

  .record-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1.25rem;
    border-radius: 0.5rem;
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--color-text-secondary);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    transition: all 0.15s ease;
    position: relative;
  }

  .record-btn:hover {
    background: var(--color-surface-elevated);
    border-color: var(--color-error);
    color: var(--color-error);
  }

  .record-btn.recording {
    background: var(--color-error);
    color: white;
    border-color: var(--color-error);
  }

  .record-btn.transcribing {
    background: var(--color-warning, #f59e0b);
    color: white;
    border-color: var(--color-warning, #f59e0b);
    cursor: wait;
  }

  .record-btn.transcribing:disabled {
    opacity: 1;
  }

  .transcribing-spinner {
    position: absolute;
    inset: 4px;
    border: 2px solid transparent;
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .recording-pulse {
    position: absolute;
    inset: 0;
    background: var(--color-error);
    border-radius: 0.5rem;
    animation: pulse-recording 1.5s ease-in-out infinite;
  }

  @keyframes pulse-recording {
    0%, 100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.7;
      transform: scale(1.02);
    }
  }

  .start-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.75rem 1.5rem;
    border-radius: 0.5rem;
    font-size: 0.9rem;
    font-weight: 600;
    color: white;
    background: var(--color-accent);
    transition: all 0.15s ease;
  }

  .start-btn:hover:not(:disabled) {
    background: var(--color-accent-hover);
    transform: translateY(-1px);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  }

  .start-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .start-btn.plan {
    background: #0891b2;
  }

  .start-btn.plan:hover:not(:disabled) {
    background: #06b6d4;
  }

  .start-btn.note {
    background: #d97706;
  }

  .start-btn.note:hover:not(:disabled) {
    background: #f59e0b;
  }

  .start-btn.loading {
    cursor: wait;
  }

  .start-spinner {
    width: 18px;
    height: 18px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  /* Cancel */
  .cancel-section {
    display: flex;
    justify-content: center;
    padding-top: 0.5rem;
  }

  .cancel-btn {
    font-size: 0.85rem;
    color: var(--color-text-muted);
    padding: 0.5rem 1.25rem;
    border-radius: 0.375rem;
    transition: all 0.15s ease;
  }

  .cancel-btn:hover {
    color: var(--color-error);
    background: color-mix(in srgb, var(--color-error) 10%, transparent);
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
