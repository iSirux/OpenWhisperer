<script lang="ts">
  import type { RepoConfig } from '$lib/stores/settings';
  import type { PendingRepoSelection } from '$lib/stores/sdkSessions';
  import RepoIcon from '$lib/components/RepoIcon.svelte';

  interface Props {
    status: 'pending_repo' | 'initializing';
    repos: RepoConfig[];
    pendingSelection?: PendingRepoSelection;
    pendingPrompt?: string;
    onSelectRepo: (index: number, editedPrompt?: string) => void;
    onCancel: () => void;
  }

  let { status, repos, pendingSelection, pendingPrompt, onSelectRepo, onCancel }: Props = $props();

  // Editable prompt state
  let editedPrompt = $state(pendingSelection?.transcript || pendingPrompt || '');
  let textareaEl: HTMLTextAreaElement;

  // Update edited prompt when pendingSelection changes
  $effect(() => {
    const newPrompt = pendingSelection?.transcript || pendingPrompt || '';
    if (newPrompt && !editedPrompt) {
      editedPrompt = newPrompt;
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
    editedPrompt;
    autoResize();
  });

  function handleSelectRepo(index: number) {
    const originalPrompt = pendingSelection?.transcript || pendingPrompt || '';
    // Only pass edited prompt if it was actually modified
    if (editedPrompt !== originalPrompt) {
      onSelectRepo(index, editedPrompt);
    } else {
      onSelectRepo(index);
    }
  }

  function getConfidenceColor(conf: string): string {
    switch (conf) {
      case 'high':
        return 'text-emerald-400';
      case 'medium':
        return 'text-amber-400';
      case 'low':
        return 'text-red-400';
      default:
        return 'text-text-muted';
    }
  }

  function getConfidenceBgColor(conf: string): string {
    switch (conf) {
      case 'high':
        return 'bg-emerald-400/10';
      case 'medium':
        return 'bg-amber-400/10';
      case 'low':
        return 'bg-red-400/10';
      default:
        return 'bg-surface-elevated';
    }
  }

  let displayPrompt = $derived(pendingSelection?.transcript || pendingPrompt || '');

  // Sort repos to show recommended first, filtering to active repos only
  let sortedRepos = $derived(() => {
    // Filter to active repos while preserving original indices into the full array
    const activeWithIndex = repos
      .map((repo, index) => ({ repo, originalIndex: index }))
      .filter(({ repo }) => repo.active !== false);

    if (!pendingSelection || pendingSelection.recommendedIndex === null || pendingSelection.recommendedIndex === undefined) {
      return activeWithIndex;
    }

    const recommendedEntry = activeWithIndex.find(({ originalIndex }) => originalIndex === pendingSelection.recommendedIndex);
    if (!recommendedEntry) {
      return activeWithIndex;
    }

    const others = activeWithIndex.filter(({ originalIndex }) => originalIndex !== pendingSelection.recommendedIndex);

    return [
      recommendedEntry,
      ...others
    ];
  });
</script>

<div class="pending-view">
  {#if status === 'pending_repo'}
    <!-- Repo Selection State -->
    <div class="pending-content">
      <!-- Header with explanation -->
      <div class="selection-header">
        <div class="header-icon">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div class="header-content">
          <h3 class="header-title">Select Repository</h3>
          <p class="header-description">
            Which repository should handle this task?
          </p>
        </div>
      </div>

      <!-- Editable prompt -->
      <div class="prompt-edit">
        <label class="prompt-label" for="prompt-input">Your request:</label>
        <textarea
          id="prompt-input"
          class="prompt-textarea"
          bind:this={textareaEl}
          bind:value={editedPrompt}
          oninput={autoResize}
          placeholder="Enter your request..."
          rows="1"
        ></textarea>
      </div>

      <!-- AI Recommendation -->
      {#if pendingSelection && pendingSelection.recommendedIndex !== null}
        <div class="recommendation {getConfidenceBgColor(pendingSelection.confidence)}">
          <div class="recommendation-header">
            <svg class="w-4 h-4 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
            </svg>
            <span class="recommendation-label">AI Suggestion:</span>
            <span class="recommendation-repo">{repos[pendingSelection.recommendedIndex]?.name}</span>
            <span class="confidence-badge {getConfidenceColor(pendingSelection.confidence)}">
              {pendingSelection.confidence}
            </span>
          </div>
          {#if pendingSelection.reasoning}
            <p class="recommendation-reasoning">{pendingSelection.reasoning}</p>
          {/if}
        </div>
      {/if}

      <!-- Repo list -->
      <div class="repo-list">
        {#each sortedRepos() as { repo, originalIndex }}
          {@const isRecommended = pendingSelection ? originalIndex === pendingSelection.recommendedIndex : false}
          <button
            class="repo-item"
            class:recommended={isRecommended}
            onclick={() => handleSelectRepo(originalIndex)}
          >
            <div class="repo-icon">
              <RepoIcon repo={repo} size="sm" />
            </div>
            <div class="repo-info">
              <div class="repo-name">
                {repo.name}
                {#if isRecommended}
                  <span class="suggested-badge">Suggested</span>
                {/if}
              </div>
              <div class="repo-path">{repo.path}</div>
              {#if repo.description}
                <div class="repo-description">{repo.description}</div>
              {/if}
            </div>
            <svg class="select-arrow" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        {/each}
      </div>

      <!-- Cancel button -->
      <div class="cancel-section">
        <button class="cancel-btn" onclick={onCancel}>
          Cancel session
        </button>
      </div>
    </div>
  {:else if status === 'initializing'}
    <!-- Initializing State -->
    <div class="initializing-content">
      <div class="initializing-animation">
        <div class="spinner"></div>
      </div>
      <h3 class="initializing-title">Starting Session</h3>
      <p class="initializing-description">Initializing and preparing your workspace...</p>

      {#if displayPrompt}
        <div class="prompt-preview initializing-prompt">
          <span class="prompt-text">"{displayPrompt.slice(0, 80)}{displayPrompt.length > 80 ? '...' : ''}"</span>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .pending-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-background);
    color: var(--color-text-primary);
  }

  .pending-content {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.5rem;
    max-width: 36rem;
    margin: 0 auto;
    width: 100%;
  }

  .selection-header {
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
    background: var(--color-accent)/10%;
    border-radius: 0.5rem;
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

  .prompt-edit {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .prompt-preview {
    padding: 0.875rem 1rem;
    background: var(--color-surface);
    border-radius: 0.5rem;
    border: 1px solid var(--color-border);
    font-size: 0.875rem;
  }

  .prompt-label {
    color: var(--color-text-muted);
    font-size: 0.8rem;
  }

  .prompt-textarea {
    width: 100%;
    padding: 0.75rem 1rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    color: var(--color-text-primary);
    font-size: 0.9rem;
    font-family: inherit;
    resize: none;
    overflow-y: hidden;
    transition: border-color 0.15s ease;
  }

  .prompt-textarea:focus {
    outline: none;
    border-color: var(--color-accent);
  }

  .prompt-textarea::placeholder {
    color: var(--color-text-muted);
  }

  .prompt-text {
    color: var(--color-text-secondary);
    font-style: italic;
  }

  .recommendation {
    padding: 0.875rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid var(--color-border);
  }

  .recommendation-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .recommendation-label {
    font-size: 0.8rem;
    color: var(--color-text-muted);
  }

  .recommendation-repo {
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--color-text-primary);
  }

  .confidence-badge {
    font-size: 0.7rem;
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
    background: rgba(255, 255, 255, 0.1);
    text-transform: capitalize;
  }

  .recommendation-reasoning {
    margin: 0.5rem 0 0;
    font-size: 0.8rem;
    color: var(--color-text-muted);
    font-style: italic;
  }

  .repo-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .repo-item {
    display: flex;
    align-items: flex-start;
    gap: 0.875rem;
    padding: 1rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: left;
    width: 100%;
  }

  .repo-item:hover {
    background: var(--color-surface-elevated);
    border-color: var(--color-accent);
  }

  .repo-item.recommended {
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 5%, var(--color-surface));
  }

  .repo-icon {
    flex-shrink: 0;
    color: var(--color-text-muted);
    margin-top: 0.125rem;
  }

  .repo-info {
    flex: 1;
    min-width: 0;
  }

  .repo-name {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--color-text-primary);
  }

  .suggested-badge {
    font-size: 0.65rem;
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
    background: var(--color-accent);
    color: white;
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.025em;
  }

  .repo-path {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    margin-top: 0.25rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  }

  .repo-description {
    font-size: 0.8rem;
    color: var(--color-text-secondary);
    margin-top: 0.375rem;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .select-arrow {
    flex-shrink: 0;
    width: 1.25rem;
    height: 1.25rem;
    color: var(--color-text-muted);
    margin-top: 0.25rem;
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .repo-item:hover .select-arrow {
    opacity: 1;
  }

  .cancel-section {
    display: flex;
    justify-content: center;
    padding-top: 0.75rem;
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

  /* Initializing State */
  .initializing-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 3rem;
    height: 100%;
    text-align: center;
  }

  .initializing-animation {
    margin-bottom: 0.5rem;
  }

  .spinner {
    width: 48px;
    height: 48px;
    border: 3px solid var(--color-border);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .initializing-title {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--color-text-primary);
    margin: 0;
  }

  .initializing-description {
    font-size: 0.9rem;
    color: var(--color-text-muted);
    margin: 0;
    max-width: 24rem;
  }

  .initializing-prompt {
    margin-top: 1rem;
    max-width: 28rem;
  }
</style>
