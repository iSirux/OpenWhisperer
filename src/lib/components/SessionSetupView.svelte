<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { normalizeEffortLevel, sdkSessions, type EffortLevel, type SdkImageContent } from '$lib/stores/sdkSessions';
  import type { QueueWindow } from '$lib/stores/queueDetection';
  import { settings } from '$lib/stores/settings';
  import { repos } from '$lib/stores/repos';
  import RepoSelector from '$lib/components/RepoSelector.svelte';
  import PromptChips from '$lib/components/PromptChips.svelte';
  import { appendChips } from '$lib/utils/promptChips';
  import SdkQuickActions from '$lib/components/sdk/SdkQuickActions.svelte';
  import { isRecording, isTranscribing } from '$lib/stores/recording';
  import { holdSpaceRecord } from '$lib/actions/holdSpaceRecord';
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
  import {
    getImagesFromClipboard,
    getImagesFromClipboardHtml,
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

  interface SetupLaunchConfig {
    prompt: string;
    images?: SdkImageContent[];
    model: string;
    effortLevel: EffortLevel;
    cwd: string;
    provider?: SdkProvider;
    worktreeMode?: 'main' | 'new' | 'existing';
    worktreeBranch?: string;
    worktreeRepoPath?: string;
    worktreePostSetup?: { repoPath: string; copyFiles: string[]; postCreateCommands: string[] };
  }

  interface Props {
    sessionId: string;
    initialModel?: string;
    initialProvider?: SdkProvider;
    initialEffortLevel?: EffortLevel;
    initialCwd?: string;
    initialWorktreeMode?: 'main' | 'new' | 'existing';
    initialWorktreePath?: string;
    initialDraftPrompt?: string;
    initialDraftImages?: SdkImageContent[];
    providerLocked?: boolean;
    forkedFromLabel?: string;
    isRecordingForSetup?: boolean;
    onStart: (config: SetupLaunchConfig) => void;
    /** Schedule the launch for a later usage window (fire-and-forget) instead of starting now. */
    /** 'after_sessions' = start once every other session in the target repo/worktree is done. */
    onSchedule?: (config: SetupLaunchConfig, window: QueueWindow | 'after_sessions') => void;
    /** Save this draft to the pile to handle later instead of starting a session. */
    onToPile?: (config: SetupLaunchConfig) => void;
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
    initialDraftPrompt = '',
    initialDraftImages = [],
    providerLocked = false,
    forkedFromLabel = '',
    isRecordingForSetup = false,
    onStart,
    onSchedule,
    onToPile,
    onDraftChange,
    onStartRecording,
    onStopRecording,
    onCancel,
  }: Props = $props();

  let scheduleMenuOpen = $state(false);

  // Local state
  let prompt = $state(initialDraftPrompt);
  let model = $state(initialModel);
  let effortLevel = $state<EffortLevel>(normalizeEffortLevel(initialEffortLevel));
  let cwd = $state(initialCwd);
  let selectedChips = $state<string[]>([]);
  let pendingImages = $state<ImageData[]>(toImageData(initialDraftImages));
  let isProcessingImages = $state(false);
  let provider = $state<SdkProvider>(initialProvider ?? getProviderForModel(initialModel));
  let openaiAvailable = $state(false);
  // The provider choice only renders when BOTH providers are enabled;
  // a single-provider setup never shows a picker.
  const showProviderChoice = $derived(
    openaiAvailable && ($settings.enabled_providers?.claude ?? true)
  );
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

  // Derived state
  const noVoice = $derived($settings.system.voice_mode_disabled);
  const activeRepos = $derived(($repos.list || []).filter((r) => r.active !== false));
  const isAutoRepoMode = $derived(!cwd || cwd === '.');
  const isSmartModelEnabled = $derived(
    $settings.llm?.enabled && $settings.llm?.features?.recommend_model
  );
  const models = $derived(
    provider === 'openai'
      ? getEnabledModels($settings.enabled_openai_models, 'openai')
      : getEnabledModelsWithAuto($settings.enabled_models)
  );

  const currentRepo = $derived(activeRepos.find(r => r.path === cwd));
  const currentRepoIndex = $derived($repos.list.findIndex(r => r.path === cwd));
  const canStart = $derived(prompt.trim() || pendingImages.length > 0);

  // Focus textarea on mount
  $effect(() => {
    if (textareaEl) {
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
      prompt = initialDraftPrompt;
      pendingImages = toImageData(initialDraftImages);
      selectedChips = [];
      prevSessionId = sessionId;
    }
  });

  // Check if OpenAI Codex is available (auth exists AND the provider is
  // enabled — disabled providers are hidden app-wide per onboarding choice)
  $effect(() => {
    const enabledProviders = $settings.enabled_providers ?? { claude: true, openai: true };
    invoke<{ authenticated: boolean }>('check_openai_codex_auth')
      .then(result => {
        openaiAvailable = result.authenticated && enabledProviders.openai;
        if (!openaiAvailable && provider === 'openai') {
          provider = 'claude';
          model = $settings.default_model || DEFAULT_MODEL_ID;
        } else if (!enabledProviders.claude && openaiAvailable && provider === 'claude') {
          provider = 'openai';
          model = $settings.openai_model || DEFAULT_OPENAI_MODEL_ID;
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
    });
  });

  /**
   * Resolve the full launch config from the current form state, creating a git worktree up-front
   * when in "new"/"existing" worktree mode. Shared by "Start" (launch now) and "Schedule for later"
   * (defer via the Smart Queue). Returns null if worktree creation failed.
   */
  async function resolveStartConfig(promptOverride?: string): Promise<SetupLaunchConfig | null> {
    const effectivePrompt = (promptOverride ?? prompt).trim();
    const imageContent: SdkImageContent[] | undefined = pendingImages.length > 0
      ? toSdkImageContent(pendingImages)
      : undefined;

    let effectiveCwd = cwd;
    let worktreeBranch: string | undefined;
    let worktreeRepoPath: string | undefined;
    let worktreePostSetup: { repoPath: string; copyFiles: string[]; postCreateCommands: string[] } | undefined;

    if (worktreeMode === 'new' && cwd && cwd !== '.') {
      isCreatingWorktree = true;
      try {
        const branchName = await invoke<string>('generate_worktree_branch_name', {
          prompt: effectivePrompt,
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
        return null;
      } finally {
        isCreatingWorktree = false;
      }
    } else if (worktreeMode === 'existing' && selectedWorktreePath) {
      worktreeRepoPath = cwd;
      effectiveCwd = selectedWorktreePath;
      const selectedWt = existingWorktrees.find(w => w.path === selectedWorktreePath);
      worktreeBranch = selectedWt?.branch || undefined;
    }

    return {
      prompt: appendChips(effectivePrompt, selectedChips),
      images: imageContent,
      model,
      effortLevel,
      cwd: effectiveCwd,
      provider,
      worktreeMode: worktreeMode !== 'main' ? worktreeMode : undefined,
      worktreeBranch,
      worktreeRepoPath,
      worktreePostSetup,
    };
  }

  async function handleStart() {
    if (!canStart || isStarting) return;
    isStarting = true;
    try {
      const config = await resolveStartConfig();
      if (config) await onStart(config);
    } finally {
      isStarting = false;
    }
  }

  /** Quick action: immediately start the session with the action's prompt (ignores the draft). */
  async function handleQuickAction(actionPrompt: string) {
    if (isStarting) return;
    isStarting = true;
    try {
      const config = await resolveStartConfig(actionPrompt);
      if (config) await onStart(config);
    } finally {
      isStarting = false;
    }
  }

  /** Ctrl+click quick action: queue the session to start once the target repo/worktree is idle. */
  async function handleQuickActionAfterIdle(actionPrompt: string) {
    if (isStarting || !onSchedule) return;
    isStarting = true;
    try {
      const config = await resolveStartConfig(actionPrompt);
      if (config) await onSchedule(config, 'after_sessions');
    } finally {
      isStarting = false;
    }
  }

  async function handleSchedule(window: QueueWindow | 'after_sessions') {
    scheduleMenuOpen = false;
    if (!canStart || isStarting || !onSchedule) return;
    isStarting = true;
    try {
      const config = await resolveStartConfig();
      if (config) await onSchedule(config, window);
    } finally {
      isStarting = false;
    }
  }

  /**
   * Save the current draft to the pile (no worktree creation, no launch).
   * Hands the assembled prompt/images/model/effort/repo to the parent, which owns
   * the pile write + session teardown.
   */
  function handleToPile() {
    if (!canStart || isStarting || !onToPile) return;
    const imageContent: SdkImageContent[] | undefined = pendingImages.length > 0
      ? toSdkImageContent(pendingImages)
      : undefined;
    onToPile({
      prompt: appendChips(prompt.trim(), selectedChips),
      images: imageContent,
      model,
      effortLevel,
      cwd,
      provider,
    });
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleStart();
    }
  }

  // Image handling
  async function handlePaste(e: ClipboardEvent) {
    // Read clipboard data synchronously — it's only valid during the event.
    const html = e.clipboardData?.getData('text/html') ?? '';
    const imageFiles = await getImagesFromClipboard(e);
    if (imageFiles.length > 0) {
      // Raw image blob (e.g. a screenshot) — replace the paste with the image.
      e.preventDefault();
      await addImages(imageFiles);
      return;
    }
    // Rich HTML with embedded images (e.g. a page copied from Google Docs).
    // Don't preventDefault — let the accompanying text paste normally, and
    // attach the images alongside it.
    const htmlImages = await getImagesFromClipboardHtml(html);
    if (htmlImages.length > 0) {
      await addImages(htmlImages);
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

  // Repo handling ('' means Auto — the RepoSelector only emits it when enabled)
  function handleRepoSelect(path: string) {
    cwd = path;
    const repo = activeRepos.find(r => r.path === path);
    // 'new' is a one-off per-session choice, never a sticky repo default (mirrors RepositoryView)
    worktreeMode = repo?.worktree_mode === 'existing' ? 'existing' : 'main';
    selectedWorktreePath = '';
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

    // Persist to repo config — but 'new' is a one-off per-session choice, not a repo default
    if (currentRepoIndex >= 0 && mode !== 'new') {
      repos.updateRepo(currentRepoIndex, { worktree_mode: mode });
    }
  }

  function handleWorktreeSelect(path: string) {
    selectedWorktreePath = path;
    showWorktreeDropdown = false;
  }

  function handleClickOutside(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (!target.closest('.worktree-selector-container')) {
      showWorktreeDropdown = false;
    }
    if (!target.closest('.schedule-split-container')) {
      scheduleMenuOpen = false;
    }
  }
</script>

<svelte:window onclick={handleClickOutside} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="setup-view" ondragover={handleDragOver} ondrop={handleDrop}>
  <div class="setup-content">
    <!-- Header -->
    <div class="setup-header">
      <div class="header-icon">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      </div>
      <div class="header-content">
        <h3 class="header-title">
          {providerLocked ? 'Fork Session' : 'New Session'}
        </h3>
        {#if providerLocked}
          <p class="header-description">
            {forkedFromLabel
              ? `Forked from ${forkedFromLabel}.`
              : 'Forked from an earlier session point.'}
            You can adjust model, effort, repo, and prompt before starting.
          </p>
        {/if}
      </div>
    </div>

    <div class="options-grid">
      <div class="option-row option-row--wide">
        <div class="session-control-row" class:session-control-row--triple={(showProviderChoice || providerLocked) && (modelSupportsEffort(model) || isAutoModel(model))} class:session-control-row--double={!(showProviderChoice || providerLocked) || !(modelSupportsEffort(model) || isAutoModel(model))}>
          {#if showProviderChoice && !providerLocked}
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
          {:else if providerLocked}
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
            <RepoSelector
              {cwd}
              onchange={handleRepoSelect}
              size="md"
              maxVisible={4}
              dropdownDirection="down"
            />
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
        Your prompt
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
        use:holdSpaceRecord={{
          enabled: $settings.audio.hold_space_to_record_inline && !noVoice,
          canStart: () => !$isRecording && !$isTranscribing && !isAwaitingTranscript,
          start: onStartRecording,
          stop: onStopRecording,
          onState: (s) => (isAwaitingTranscript = s === 'transcribing'),
        }}
        placeholder={`Enter your prompt... (Ctrl+V to paste images${$settings.audio.hold_space_to_record_inline && !noVoice ? ', hold Space to dictate' : ''})`}
        rows="1"
      ></textarea>

      <div class="prompt-hint">
        Press <kbd>Ctrl</kbd> + <kbd>Enter</kbd> to start, or use the button below
      </div>

      <div class="chips-row">
        <PromptChips selected={selectedChips} onchange={(next) => (selectedChips = next)} />
      </div>

      <SdkQuickActions
        onSendPrompt={handleQuickAction}
        onSendAfterIdle={onSchedule ? handleQuickActionAfterIdle : undefined}
      />
    </div>

    <!-- Action Buttons -->
    <div class="action-row">
      {#if !noVoice}
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
      {/if}

      <button
        class="start-btn"
        class:loading={isStarting}
        disabled={!canStart || isStarting}
        onclick={(e) =>
          onSchedule && (e.ctrlKey || e.metaKey)
            ? handleSchedule('after_sessions')
            : handleStart()}
        title={onSchedule
          ? 'Start now — Ctrl+click: start when this repo/worktree is idle'
          : undefined}
      >
        {#if isStarting}
          <div class="start-spinner"></div>
          {isCreatingWorktree ? 'Creating worktree...' : 'Starting Session...'}
        {:else}
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Start Session
        {/if}
      </button>

      {#if onSchedule}
        <div class="schedule-split-container relative">
          <button
            class="schedule-toggle"
            onclick={() => (scheduleMenuOpen = !scheduleMenuOpen)}
            disabled={!canStart || isStarting}
            aria-haspopup="menu"
            aria-expanded={scheduleMenuOpen}
            title="Fire-and-forget: schedule this launch for the next 5h or 7d usage-window reset"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd" />
            </svg>
            Schedule
            <svg viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5">
              <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
            </svg>
          </button>
          {#if scheduleMenuOpen}
            <div class="schedule-menu" role="menu">
              <button class="schedule-menu-item" role="menuitem" onclick={() => handleSchedule('after_sessions')}>
                When repo is idle
              </button>
              <button class="schedule-menu-item" role="menuitem" onclick={() => handleSchedule('5h')}>
                Next 5h reset
              </button>
              <button class="schedule-menu-item" role="menuitem" onclick={() => handleSchedule('7d')}>
                Next 7d reset
              </button>
            </div>
          {/if}
        </div>
      {/if}

      {#if onToPile && !noVoice}
        <button
          class="pile-btn"
          onclick={handleToPile}
          disabled={!canStart || isStarting}
          title="Save this draft to the pile to handle later"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4">
            <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
          </svg>
          To Pile
        </button>
      {/if}
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

  .chips-row {
    margin-top: 0.25rem;
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

  .start-btn.loading {
    cursor: wait;
  }

  /* Schedule-for-later split button */
  .schedule-split-container {
    position: relative;
    flex-shrink: 0;
  }

  .schedule-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    height: 100%;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--color-text-primary);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    transition: all 0.15s ease;
  }

  .schedule-toggle:hover:not(:disabled) {
    background: var(--color-surface-elevated);
    border-color: var(--color-accent);
  }

  .schedule-toggle:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* To Pile secondary button */
  .pile-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--color-text-primary);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    transition: all 0.15s ease;
  }

  .pile-btn:hover:not(:disabled) {
    background: var(--color-surface-elevated);
    border-color: var(--color-accent);
  }

  .pile-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .schedule-menu {
    position: absolute;
    bottom: calc(100% + 6px);
    right: 0;
    z-index: 50;
    min-width: 12rem;
    display: flex;
    flex-direction: column;
    padding: 0.25rem;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
  }

  .schedule-menu-item {
    width: 100%;
    padding: 0.5rem 0.625rem;
    text-align: left;
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-text-primary);
    transition: background 0.15s ease;
  }

  .schedule-menu-item:hover {
    background: var(--color-border);
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
