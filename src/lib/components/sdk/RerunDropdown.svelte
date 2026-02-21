<script lang="ts">
  import { settings, type RepoConfig } from '$lib/stores/settings';
  import { sdkSessions, activeSdkSessionId, type SdkImageContent, settingsToStoreThinking, type ThinkingLevel } from '$lib/stores/sdkSessions';
  import { activeSessionId } from '$lib/stores/sessions';
  import { getEnabledModels, type ModelInfo } from '$lib/utils/models';
  import { getModelBgColor, getModelHoverBgColor } from '$lib/utils/modelColors';

  interface Props {
    /** The original prompt content to rerun */
    prompt: string;
    /** Optional images from the original message */
    images?: SdkImageContent[];
    /** Current session's repo path (cwd) */
    currentCwd: string;
    /** Current session's model */
    currentModel: string;
  }

  let { prompt, images, currentCwd, currentModel }: Props = $props();

  let isOpen = $state(false);
  let selectedRepoIndex = $state<number | null>(null);
  let selectedModel = $state<string | null>(null);

  // Get available models and repos from settings
  const models = $derived(getEnabledModels($settings.enabled_models));
  const repos = $derived($settings.repos);

  // Find current repo index
  const currentRepoIndex = $derived(repos.findIndex(r => r.path === currentCwd));

  // Effective selections (fallback to current if not changed)
  const effectiveRepoIndex = $derived(selectedRepoIndex ?? currentRepoIndex);
  const effectiveModel = $derived(selectedModel ?? currentModel);

  function toggleDropdown(e: MouseEvent) {
    e.stopPropagation();
    isOpen = !isOpen;
    if (!isOpen) {
      // Reset selections when closing
      selectedRepoIndex = null;
      selectedModel = null;
    }
  }

  function closeDropdown() {
    isOpen = false;
    selectedRepoIndex = null;
    selectedModel = null;
  }

  function handleRepoSelect(index: number) {
    selectedRepoIndex = index === currentRepoIndex ? null : index;
  }

  function handleModelSelect(modelId: string) {
    selectedModel = modelId === currentModel ? null : modelId;
  }

  async function handleRerun() {
    const repo = repos[effectiveRepoIndex];
    if (!repo) return;

    const thinkingLevel: ThinkingLevel = settingsToStoreThinking($settings.default_thinking_level);

    try {
      // Create a new session with the selected repo and model
      const newSessionId = await sdkSessions.createSession(
        repo.path,
        effectiveModel,
        thinkingLevel
      );

      // Send the same prompt to the new session
      await sdkSessions.sendPrompt(newSessionId, prompt, images);

      // Select the new session (clear PTY selection first)
      activeSessionId.set(null);
      activeSdkSessionId.set(newSessionId);

      closeDropdown();
    } catch (error) {
      console.error('[RerunDropdown] Failed to rerun prompt:', error);
    }
  }

  // Close dropdown when clicking outside
  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest('.rerun-dropdown')) {
      closeDropdown();
    }
  }

  function getRepoDisplayName(repo: RepoConfig): string {
    return repo.name || repo.path.split(/[/\\]/).pop() || repo.path;
  }

  function getModelLabel(model: ModelInfo): string {
    return model.label;
  }

  function getModelButtonClass(modelId: string, isSelected: boolean): string {
    const base = 'px-2 py-1 text-xs rounded font-medium transition-all';
    if (isSelected) {
      return `${base} ${getModelBgColor(modelId)} text-white`;
    }
    return `${base} text-text-secondary ${getModelHoverBgColor(modelId)}`;
  }
</script>

<svelte:window on:click={handleClickOutside} />

<div class="rerun-dropdown relative">
  <button
    class="rerun-button"
    onclick={toggleDropdown}
    title="Rerun with different model or repo"
  >
    <svg viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5">
      <path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-9.182a.75.75 0 00-.75.75v2.43l-.31-.31A7 7 0 003.77 8.25a.75.75 0 001.449.39 5.5 5.5 0 019.201-2.466l.312.311h-2.433a.75.75 0 000 1.5h4.243a.75.75 0 00.75-.75V2.992a.75.75 0 00-.75-.75z" clip-rule="evenodd" />
    </svg>
  </button>

  {#if isOpen}
    <div class="dropdown-menu" onclick={(e) => e.stopPropagation()}>
      <div class="dropdown-inner">
        <div class="dropdown-header">
          <span class="dropdown-title">Rerun with</span>
        </div>

        <!-- Model Selection -->
        <div class="dropdown-section">
          <div class="section-label">Model</div>
          <div class="model-grid">
            {#each models as model}
              <button
                class={getModelButtonClass(model.id, effectiveModel === model.id)}
                onclick={() => handleModelSelect(model.id)}
                title={model.title}
              >
                {getModelLabel(model)}
                {#if model.id === currentModel && selectedModel === null}
                  <span class="current-badge">current</span>
                {/if}
              </button>
            {/each}
          </div>
        </div>

        <!-- Repo Selection -->
        {#if repos.length > 0}
          <div class="dropdown-section">
            <div class="section-label">Repository</div>
            <div class="repo-list">
              {#each repos as repo, index}
                <button
                  class="repo-option"
                  class:selected={effectiveRepoIndex === index}
                  onclick={() => handleRepoSelect(index)}
                >
                  <svg class="repo-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  <span class="repo-name">{getRepoDisplayName(repo)}</span>
                  {#if index === currentRepoIndex && selectedRepoIndex === null}
                    <span class="current-badge">current</span>
                  {/if}
                  {#if effectiveRepoIndex === index}
                    <svg class="check-icon" viewBox="0 0 20 20" fill="currentColor">
                      <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                    </svg>
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Rerun Button -->
        <div class="dropdown-footer">
          <button
            class="rerun-action"
            onclick={handleRerun}
          >
            <svg viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4">
              <path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-9.182a.75.75 0 00-.75.75v2.43l-.31-.31A7 7 0 003.77 8.25a.75.75 0 001.449.39 5.5 5.5 0 019.201-2.466l.312.311h-2.433a.75.75 0 000 1.5h4.243a.75.75 0 00.75-.75V2.992a.75.75 0 00-.75-.75z" clip-rule="evenodd" />
            </svg>
            Rerun
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .rerun-dropdown {
    display: inline-block;
  }

  .rerun-button {
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
    border: none;
    border-radius: 4px;
    padding: 0.35rem;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: unset;
  }

  .rerun-button:hover {
    background: var(--color-border);
    color: var(--color-text-primary);
  }

  .dropdown-menu {
    position: absolute;
    bottom: 100%;
    right: 0;
    margin-bottom: 0.5rem;
    min-width: 240px;
    max-width: 320px;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    z-index: 100;
    overflow: visible;
  }

  .dropdown-header {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--color-border);
  }

  .dropdown-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-text-primary);
  }

  .dropdown-section {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--color-border);
    overflow: visible;
  }

  .dropdown-section:last-of-type {
    border-bottom: none;
  }

  .dropdown-inner {
    background: var(--color-surface-elevated);
    border-radius: 8px;
    overflow: hidden;
  }

  .section-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    margin-bottom: 0.5rem;
  }

  .model-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .current-badge {
    font-size: 0.6rem;
    background: var(--color-surface);
    color: var(--color-text-muted);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    margin-left: 0.25rem;
  }

  .repo-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-height: 200px;
    overflow-y: auto;
  }

  .repo-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s;
    color: var(--color-text-secondary);
    text-align: left;
    width: 100%;
  }

  .repo-option:hover {
    background: var(--color-surface);
  }

  .repo-option.selected {
    background: var(--color-surface);
    color: var(--color-text-primary);
  }

  .repo-icon {
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    color: var(--color-text-muted);
  }

  .repo-name {
    flex: 1;
    font-size: 0.8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .check-icon {
    width: 1rem;
    height: 1rem;
    color: var(--color-accent);
    flex-shrink: 0;
  }

  .dropdown-footer {
    padding: 0.75rem 1rem;
    background: var(--color-surface);
    border-top: 1px solid var(--color-border);
  }

  .rerun-action {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 1rem;
    background: var(--color-accent);
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .rerun-action:hover {
    filter: brightness(1.1);
  }
</style>
