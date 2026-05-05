<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { normalizeEffortLevel, sdkSessions, type EffortLevel, type SdkImageContent } from '$lib/stores/sdkSessions';
  import { settings, isNoteModeAvailable } from '$lib/stores/settings';
  import { repos, type RepoConfig } from '$lib/stores/repos';
  import RepoIcon from '$lib/components/RepoIcon.svelte';
  import { findRepoByPath } from '$lib/utils/repoIcons';
  import { isRecording, isTranscribing } from '$lib/stores/recording';
  import {
    getEnabledModelsWithAuto,
    getEnabledModels,
    getProviderForModel,
    isAutoModel,
    DEFAULT_MODEL_ID,
    DEFAULT_OPENAI_MODEL_ID,
    modelSupportsEffort,
    getMaxEffort,
    modelSupportsXhigh,
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
  import {
    toImageData,
    toSdkImageContent,
    getModelButtonClasses,
    getWorktreeLabel,
    type WorktreeInfo,
    type WorktreeCreationResult,
  } from '$lib/components/session-setup/sessionSetupHelpers';

  interface Props {
    sessionId: string;
    initialModel?: string;
    initialProvider?: SdkProvider;
    initialEffortLevel?: EffortLevel;
    initialCwd?: string;
    initialWorktreeMode?: 'main' | 'new' | 'existing';
    initialWorktreePath?: string;
    initialPlanMode?: boolean;
    initialNoteMode?: boolean;
    initialReadOnlyMode?: boolean;
    initialPlaywrightQa?: boolean;
    initialDraftPrompt?: string;
    initialDraftImages?: SdkImageContent[];
    providerLocked?: boolean;
    forkedFromLabel?: string;
    isRecordingForSetup?: boolean;
    onStart: (config: {
      prompt: string;
      images?: SdkImageContent[];
      model: string;
      effortLevel: EffortLevel;
      cwd: string;
      planMode: boolean;
      noteMode: boolean;
      readOnlyMode: boolean;
      provider?: SdkProvider;
      worktreeMode?: 'main' | 'new' | 'existing';
      worktreeBranch?: string;
      worktreeRepoPath?: string;
      worktreePostSetup?: { repoPath: string; copyFiles: string[]; postCreateCommands: string[] };
      playwrightQa?: boolean;
    }) => void;
    onDraftChange?: (
      sessionId: string,
      prompt: string,
      images: SdkImageContent[],
    ) => void;
    onStartRecording: () => void;
    onStopRecording: () => Promise<string | null>;
    onCancel?: () => void;
  }

  let {
    sessionId,
    initialModel = DEFAULT_MODEL_ID,
    initialProvider = undefined,
    initialEffortLevel = 'low',
    initialCwd = '',
    initialWorktreeMode = 'main',
    initialWorktreePath = '',
    initialPlanMode = false,
    initialNoteMode = false,
    initialReadOnlyMode = false,
    initialPlaywrightQa = false,
    initialDraftPrompt = '',
    initialDraftImages = [],
    providerLocked = false,
    forkedFromLabel = '',
    isRecordingForSetup = false,
    onStart,
    onDraftChange,
    onStartRecording,
    onStopRecording,
    onCancel,
  }: Props = $props();

  // Local state
  let prompt = $state(initialDraftPrompt);
  let model = $state(initialModel);
  let effortLevel = $state<EffortLevel>(normalizeEffortLevel(initialEffortLevel));
  let cwd = $state(initialCwd);
  let planMode = $state(initialPlanMode);
  let noteMode = $state(initialNoteMode);
  let readOnlyMode = $state(initialReadOnlyMode);
  let pendingImages = $state<ImageData[]>(toImageData(initialDraftImages));
  let isProcessingImages = $state(false);
  let showRepoDropdown = $state(false);
  let provider = $state<SdkProvider>(initialProvider ?? getProviderForModel(initialModel));
  let openaiAvailable = $state(false);
  let isStarting = $state(false);
  let isAwaitingTranscript = $state(false);
  let textareaEl: HTMLTextAreaElement;
  let prevSessionId = $state(sessionId);

  // Worktree state
  let worktreeMode = $state<'main' | 'new' | 'existing'>(initialWorktreeMode);
  let existingWorktrees = $state<WorktreeInfo[]>([]);
  let selectedWorktreePath = $state<string>(initialWorktreePath);
  let isLoadingWorktrees = $state(false);
  let isCreatingWorktree = $state(false);
  let showWorktreeDropdown = $state(false);

  // Playwright QA state
  let playwrightQa = $state(initialPlaywrightQa !== undefined ? initialPlaywrightQa : true);

  // Derived state
  const activeRepos = $derived(($repos.list || []).filter((r) => r.active !== false));
  const noteModeAvailable = $derived(isNoteModeAvailable());
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
    const repo = activeRepos.find(r => r.path === cwd);
    return repo?.name || cwd.split(/[/\\]/).pop() || 'Unknown';
  });

  const currentRepo = $derived(activeRepos.find(r => r.path === cwd));
  const currentRepoIndex = $derived($repos.list.findIndex(r => r.path === cwd));
  const canStart = $derived(prompt.trim() || pendingImages.length > 0);

  // Focus textarea on mount
  $effect(() => {
    if (textareaEl && !initialPlanMode) {
      textareaEl.focus();
    }
  });

  // Restore full setup state when switching between setup sessions.
  $effect(() => {
    if (sessionId !== prevSessionId) {
      model = initialModel;
      provider = initialProvider ?? getProviderForModel(initialModel);
      effortLevel = normalizeEffortLevel(initialEffortLevel);
      cwd = initialCwd;
      worktreeMode = initialWorktreeMode;
      selectedWorktreePath = initialWorktreePath;
      planMode = initialPlanMode;
      noteMode = initialNoteMode;
      readOnlyMode = initialReadOnlyMode;
      prompt = initialDraftPrompt;
      pendingImages = toImageData(initialDraftImages);
      prevSessionId = sessionId;
    }
  });

  $effect(() => {
    if (!noteModeAvailable && noteMode) {
      noteMode = false;
    }
  });

  $effect(() => {
    if (providerLocked && noteMode) {
      noteMode = false;
    }
  });

  $effect(() => {
    if (noteMode && readOnlyMode) {
      readOnlyMode = false;
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

  // Load existing worktrees when "existing" mode is selected
  $effect(() => {
    if (worktreeMode === 'existing' && cwd && cwd !== '.') {
      loadWorktrees(cwd);
    }
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

  // Persist setup draft per session so typed content survives session switching.
  $effect(() => {
    prompt;
    pendingImages;
    onDraftChange?.(sessionId, prompt, toSdkImageContent(pendingImages));
  });

  // Sync local config back to the store so setup-session state survives session switching.
  $effect(() => {
    sdkSessions.updateSetupConfig(sessionId, {
      model,
      effortLevel,
      cwd,
      setupRepoPath: cwd,
      setupWorktreeMode: worktreeMode,
      setupWorktreePath: selectedWorktreePath,
      currentBranch: null,
      provider,
      planMode: planMode
        ? { isActive: true, questions: [], answers: [], currentQuestionIndex: 0, isComplete: false }
        : undefined,
      noteMode: noteMode
        ? { isActive: true, noteCreated: false }
        : undefined,
      readOnlyMode,
    });
  });

  async function handleStart() {
    if (!canStart || isStarting) return;

    isStarting = true;

    const imageContent: SdkImageContent[] | undefined = pendingImages.length > 0
      ? toSdkImageContent(pendingImages)
      : undefined;

    try {
      const effectiveNoteMode = noteModeAvailable ? noteMode : false;
      const effectiveReadOnlyMode = effectiveNoteMode ? false : readOnlyMode;

      let effectiveCwd = cwd;
      let worktreeBranch: string | undefined;
      let worktreeRepoPath: string | undefined;

      let worktreePostSetup: { repoPath: string; copyFiles: string[]; postCreateCommands: string[] } | undefined;

      if (worktreeMode === 'new' && cwd && cwd !== '.') {
        isCreatingWorktree = true;
        try {
          const branchName = await invoke<string>('generate_worktree_branch_name', {
            prompt: prompt.trim(),
            repoPath: cwd,
          });

          const repo = currentRepo;
          const result = await invoke<WorktreeCreationResult>('create_git_worktree_only', {
            repoPath: cwd,
            branchName,
            worktreePath: null,
            baseBranch: repo?.worktree_base_branch || null,
          });

          worktreeRepoPath = cwd;
          effectiveCwd = result.worktree_path;
          worktreeBranch = result.branch;

          const copyFiles = repo?.worktree_copy_files || [];
          const postCreateCommands = repo?.worktree_post_create_commands || [];
          if (copyFiles.length > 0 || postCreateCommands.length > 0) {
            worktreePostSetup = { repoPath: cwd, copyFiles, postCreateCommands };
          }
        } catch (err) {
          console.error('[SessionSetupView] Failed to create worktree:', err);
          isCreatingWorktree = false;
          isStarting = false;
          return;
        } finally {
          isCreatingWorktree = false;
        }
      } else if (worktreeMode === 'existing' && selectedWorktreePath) {
        worktreeRepoPath = cwd;
        effectiveCwd = selectedWorktreePath;
        const selectedWt = existingWorktrees.find(w => w.path === selectedWorktreePath);
        worktreeBranch = selectedWt?.branch || undefined;
      }

      await onStart({
        prompt: prompt.trim(),
        images: imageContent,
        model,
        effortLevel,
        cwd: effectiveCwd,
        planMode,
        noteMode: effectiveNoteMode,
        readOnlyMode: effectiveReadOnlyMode,
        provider: effectiveNoteMode ? 'claude' : provider,
        worktreeMode: worktreeMode !== 'main' ? worktreeMode : undefined,
        worktreeBranch,
        worktreeRepoPath,
        worktreePostSetup,
        playwrightQa: playwrightQa || undefined,
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

  // Repo handling
  function handleRepoSelect(path: string) {
    cwd = path;
    const repo = activeRepos.find(r => r.path === path);
    worktreeMode = repo?.worktree_mode || 'main';
    selectedWorktreePath = '';
    showRepoDropdown = false;
  }

  function handleAutoRepoClick() {
    if (autoRepoEnabled) {
      cwd = '';
      worktreeMode = 'main';
      selectedWorktreePath = '';
      showRepoDropdown = false;
    } else {
      showRepoDropdown = false;
      window.dispatchEvent(new CustomEvent('open-settings', { detail: { tab: 'llm' } }));
    }
  }

  // Worktree handling
  async function loadWorktrees(repoPath: string) {
    isLoadingWorktrees = true;
    try {
      const worktrees = await invoke<WorktreeInfo[]>('list_git_worktrees', { repoPath });
      existingWorktrees = worktrees.filter(w => !w.is_main);
    } catch (err) {
      console.error('[SessionSetupView] Failed to list worktrees:', err);
      existingWorktrees = [];
    } finally {
      isLoadingWorktrees = false;
    }
  }

  function handleWorktreeModeChange(mode: 'main' | 'new' | 'existing') {
    worktreeMode = mode;
    selectedWorktreePath = '';
    showWorktreeDropdown = false;

    // Persist to repo config
    if (currentRepoIndex >= 0) {
      repos.updateRepo(currentRepoIndex, { worktree_mode: mode });
    }
  }

  function handleWorktreeSelect(path: string) {
    selectedWorktreePath = path;
    showWorktreeDropdown = false;
  }

  function handleClickOutside(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (!target.closest('.repo-selector-container')) {
      showRepoDropdown = false;
    }
    if (!target.closest('.worktree-selector-container')) {
      showWorktreeDropdown = false;
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
          {providerLocked
            ? 'Fork Session'
            : noteMode
              ? 'New Note'
              : planMode
                ? 'Start Planning Session'
                : 'New Session'}
        </h3>
        {#if providerLocked}
          <p class="header-description">
            {forkedFromLabel
              ? `Forked from ${forkedFromLabel}.`
              : 'Forked from an earlier session point.'}
            You can adjust model, effort, repo, and prompt before starting.
          </p>
        {:else if noteMode || planMode}
          <p class="header-description">
            {noteMode
              ? 'Capture a voice note. The AI will create a note using your configured note-taking tools.'
              : 'Describe the feature you want to plan. The AI will help you flesh out the requirements.'}
          </p>
        {/if}
      </div>
    </div>

    <div class="options-grid">
      <div class="option-row option-row--wide">
        <div class="session-control-row session-control-row--double">
          <div class="option-cell">
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
              {#if noteModeAvailable && !providerLocked}
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
              {/if}
            </div>
          </div>

          {#if !noteMode}
            <div class="option-cell">
              <label class="option-label">Access</label>
              <div class="mode-toggle">
                <button
                  class="mode-btn"
                  class:active={!readOnlyMode}
                  onclick={() => { readOnlyMode = false; }}
                >
                  Full
                </button>
                <button
                  class="mode-btn readonly"
                  class:active={readOnlyMode}
                  onclick={() => { readOnlyMode = true; }}
                  title="Read-only tools (Read, Glob, Grep) + WebSearch"
                >
                  Readonly
                </button>
              </div>
            </div>
          {/if}
        </div>
      </div>

      <div class="option-row option-row--wide">
        <div class="session-control-row" class:session-control-row--triple={!noteMode && (openaiAvailable || providerLocked) && (modelSupportsEffort(model) || isAutoModel(model))} class:session-control-row--double={noteMode || !(openaiAvailable || providerLocked) || !(modelSupportsEffort(model) || isAutoModel(model))}>
          {#if openaiAvailable && !noteMode && !providerLocked}
            <div class="option-cell">
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
          {:else if !noteMode && providerLocked}
            <div class="option-cell">
              <label class="option-label">Provider</label>
              <div class="locked-provider">
                <span class="locked-provider-badge">{provider === 'openai' ? 'Codex' : 'Claude'}</span>
                <span class="locked-provider-text">Locked for forked sessions</span>
              </div>
            </div>
          {/if}

          <div class="option-cell option-cell--grow">
            <label class="option-label">Model</label>
            <div class="model-selector">
              {#each models as { id, label, title }}
                <button
                  class={getModelButtonClasses(id, model === id, isSmartModelEnabled)}
                  onclick={() => handleModelClick(id)}
                  title={isAutoModel(id) && !isSmartModelEnabled ? 'Enable in LLM settings' : title}
                >
                  {label}
                </button>
              {/each}
            </div>
          </div>

          {#if modelSupportsEffort(model) || isAutoModel(model)}
            <div class="option-cell">
              <label class="option-label">Effort</label>
              <div class="effort-options">
                {#each (() => {
                  const max = getMaxEffort(model);
                  const levels: string[] = ['low', 'medium', 'high'];
                  if (modelSupportsXhigh(model)) levels.push('xhigh');
                  if (max === 'max') levels.push('max');
                  return levels;
                })() as level}
                  <button
                    class="effort-option-btn"
                    class:active={effortLevel === level}
                    onclick={() => effortLevel = level as EffortLevel}
                  >
                    {level === 'xhigh' ? 'XHigh' : level.charAt(0).toUpperCase() + level.slice(1)}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      </div>

      <!-- Repository Selector -->
      <div class="option-row option-row--wide">
        <div class="repo-selector-cell">
            <label class="option-label">Repository</label>
            <div class="repo-selector-container relative">
              <button
                class="repo-btn"
                onclick={() => showRepoDropdown = !showRepoDropdown}
              >
                {#if isAutoRepoMode && autoRepoEnabled}
                  <span class="auto-text">{currentRepoName()}</span>
                {:else}
                  <RepoIcon repo={findRepoByPath(activeRepos, cwd)} size="sm" />
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

                  {#if activeRepos.length > 0}
                    <div class="repo-divider"></div>
                  {/if}

                  {#each activeRepos as repo}
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

                  {#if activeRepos.length === 0}
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
      </div>

      <!-- Worktree Toggle - only show when a specific repo is selected -->
      {#if !isAutoRepoMode}
        <div class="option-row option-row--wide">
          <div class="worktree-grid">
            <div class="worktree-cell">
              <label class="option-label">Worktree</label>
              <div class="mode-toggle">
                <button
                  class="mode-btn worktree"
                  class:active={worktreeMode === 'main'}
                  onclick={() => handleWorktreeModeChange('main')}
                >
                  Main
                </button>
                <button
                  class="mode-btn worktree"
                  class:active={worktreeMode === 'new'}
                  onclick={() => handleWorktreeModeChange('new')}
                >
                  New
                </button>
                <button
                  class="mode-btn worktree"
                  class:active={worktreeMode === 'existing'}
                  onclick={() => handleWorktreeModeChange('existing')}
                >
                  Existing
                </button>
              </div>
            </div>

            <div class="worktree-cell">
              <label class="option-label">Browser</label>
              <div class="mode-toggle">
                <button
                  class="mode-btn"
                  class:active={!playwrightQa}
                  onclick={() => { playwrightQa = false; }}
                >
                  Off
                </button>
                <button
                  class="mode-btn playwright"
                  class:active={playwrightQa}
                  onclick={() => { playwrightQa = true; }}
                  title="Enable Playwright MCP — gives Claude browser control for QA testing"
                >
                  Playwright
                </button>
              </div>
            </div>

            {#if worktreeMode === 'existing'}
              <div class="worktree-cell">
                <label class="option-label">Existing Worktree</label>
                <div class="worktree-selector-container relative">
                  <button
                    class="worktree-btn"
                    onclick={() => showWorktreeDropdown = !showWorktreeDropdown}
                    disabled={isLoadingWorktrees}
                  >
                    {#if isLoadingWorktrees}
                      <span class="text-text-muted">Loading worktrees...</span>
                    {:else if selectedWorktreePath}
                      {@const selectedWt = existingWorktrees.find(w => w.path === selectedWorktreePath)}
                      <span>{selectedWt ? getWorktreeLabel(selectedWt) : 'Select worktree'}</span>
                    {:else}
                      <span class="text-text-muted">Select a worktree</span>
                    {/if}
                    <svg class="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {#if showWorktreeDropdown}
                    <div class="worktree-dropdown">
                      {#if existingWorktrees.length === 0}
                        <div class="px-3 py-2 text-xs text-text-muted">
                          No worktrees found
                        </div>
                      {:else}
                        {#each existingWorktrees as wt}
                          {@const isSelected = wt.path === selectedWorktreePath}
                          <button
                            class="worktree-option"
                            class:selected={isSelected}
                            onclick={() => handleWorktreeSelect(wt.path)}
                            title={wt.path}
                          >
                            <div class="worktree-option-info">
                              <div class="worktree-option-branch">
                                <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                                </svg>
                                {wt.branch || '(detached)'}
                              </div>
                              <div class="worktree-option-path">{wt.path}</div>
                            </div>
                            {#if isSelected}
                              <svg class="w-3 h-3 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                              </svg>
                            {/if}
                          </button>
                        {/each}
                      {/if}
                    </div>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        </div>
      {/if}

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
        rows="1"
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
          Transcribing...
        </button>
      {:else if $isRecording && isRecordingForSetup}
        <button class="record-btn recording" onclick={handleStopRecording}>
          <div class="recording-dot"></div>
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
          {isCreatingWorktree ? 'Creating worktree...' : noteMode ? 'Creating Note...' : planMode ? 'Starting Planning...' : 'Starting Session...'}
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
    max-width: none;
    margin: 0;
    width: 100%;
  }

  .setup-header {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    padding: 0.625rem 0.75rem;
    background: var(--color-surface-elevated);
    border-radius: 0.5rem;
    border: 1px solid var(--color-border);
  }

  .header-icon {
    flex-shrink: 0;
    color: var(--color-accent);
    padding: 0.35rem;
    background: color-mix(in srgb, var(--color-accent) 10%, transparent);
    border-radius: 0.375rem;
    line-height: 0;
  }

  .header-icon :global(svg) {
    width: 16px;
    height: 16px;
  }

  .header-icon.note {
    color: #f59e0b;
    background: rgba(245, 158, 11, 0.1);
  }

  .header-content {
    flex: 1;
  }

  .header-title {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--color-text-primary);
    margin: 0;
  }

  .header-description {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    margin: 0.15rem 0 0;
  }

  .options-grid {
    --control-columns: repeat(2, minmax(18rem, 34rem));
    --control-column-gap: 1rem;
    display: grid;
    grid-template-columns: var(--control-columns);
    gap: 0.85rem var(--control-column-gap);
    justify-content: start;
    width: fit-content;
    max-width: 100%;
  }

  .option-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.4rem;
    min-width: 0;
  }

  .option-row--wide {
    grid-column: 1 / -1;
    width: 100%;
  }

  .session-control-row {
    display: grid;
    gap: 0.85rem var(--control-column-gap);
    width: 100%;
  }

  .session-control-row--double {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .session-control-row--triple {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .option-cell {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.4rem;
    min-width: 0;
  }

  .option-cell--grow {
    min-width: 0;
  }

  .worktree-grid {
    display: grid;
    grid-template-columns: var(--control-columns);
    column-gap: var(--control-column-gap);
    row-gap: 0.85rem;
    width: 100%;
  }

  .worktree-cell {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.4rem;
    min-width: 0;
  }

  .repo-selector-cell {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.4rem;
    min-width: 0;
    width: 100%;
  }

  .option-label {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    margin: 0;
  }

  /* Mode Toggle */
  .mode-toggle {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    padding: 0.25rem;
    background: var(--color-surface);
    border-radius: 0.5rem;
    border: 1px solid var(--color-border);
  }

  .locked-provider {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    min-height: 2.5rem;
  }

  .locked-provider-badge {
    padding: 0.45rem 0.8rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-accent) 18%, transparent);
    color: var(--color-text-primary);
    font-size: 0.82rem;
    font-weight: 600;
  }

  .locked-provider-text {
    font-size: 0.8rem;
    color: var(--color-text-muted);
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

  .mode-btn.readonly.active {
    background: #475569;
  }

  /* Model Selector */
  .model-selector {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    padding: 0.25rem;
    background: var(--color-surface);
    border-radius: 0.5rem;
    border: 1px solid var(--color-border);
  }

  .effort-options {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
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
  .repo-selector-container {
    width: auto;
  }

  .repo-btn {
    display: flex;
    align-items: center;
    justify-content: space-between;
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
    color: white;
    background: var(--color-recording);
    border: none;
    transition: all 0.15s ease;
    position: relative;
  }

  .record-btn:hover {
    background: color-mix(in srgb, var(--color-recording) 85%, black);
  }

  .record-btn.recording {
    background: var(--color-recording);
    color: white;
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
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .recording-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: white;
    flex-shrink: 0;
    animation: pulse-recording 1.5s ease-in-out infinite;
  }

  @keyframes pulse-recording {
    0%, 100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.4;
      transform: scale(0.8);
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

  /* Worktree toggle */
  .mode-btn.worktree.active {
    background: #059669;
  }

  .mode-btn.playwright.active {
    background: #7c3aed;
  }

  /* Worktree selector */
  .worktree-btn {
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
    width: auto;
    min-width: 16rem;
    justify-content: space-between;
  }

  .worktree-selector-container {
    width: auto;
  }

  .worktree-btn:hover:not(:disabled) {
    background: var(--color-surface-elevated);
    border-color: var(--color-accent);
  }

  .worktree-btn:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  .worktree-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 0.25rem;
    width: 22rem;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 50;
    max-height: 16rem;
    overflow-y: auto;
  }

  .worktree-option {
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

  .worktree-option:hover {
    background: var(--color-border);
  }

  .worktree-option.selected {
    background: #059669;
    color: white;
  }

  .worktree-option-info {
    flex: 1;
    min-width: 0;
  }

  .worktree-option-branch {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .worktree-option-path {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: 0.125rem;
  }

  .worktree-option.selected .worktree-option-path {
    color: rgba(255, 255, 255, 0.7);
  }

  @media (max-width: 900px) {
    .options-grid {
      grid-template-columns: 1fr;
    }

    .session-control-row,
    .session-control-row--double,
    .session-control-row--triple,
    .worktree-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
