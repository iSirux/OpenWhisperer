<script lang="ts">
  import type { PendingTranscriptionInfo } from "$lib/stores/sdkSessions";
  import type { AutoModelEffort } from "$lib/stores/settings";
  import { settings } from "$lib/stores/settings";
  import { repos as reposStore, type RepoConfig } from "$lib/stores/repos";
  import {
    getShortModelName,
    getModelBadgeBgColor,
    getModelTextColor,
  } from "$lib/utils/modelColors";
  import TranscriptDiff from "../TranscriptDiff.svelte";
  import RepoIcon from "$lib/components/RepoIcon.svelte";
  import { findRepoByPath } from "$lib/utils/repoIcons";

  interface Props {
    pendingTranscription: PendingTranscriptionInfo;
    sessionId: string;
    /** Whether this is showing completed/historical recording info (not pending) */
    completed?: boolean;
    onRetry?: () => void;
    onCancel?: () => void;
    /** Whether to show approval UI (for pending_approval state) */
    showApproval?: boolean;
    /** The prompt waiting for approval */
    approvalPrompt?: string;
    /** Repository name for display in approval mode */
    repoName?: string;
    /** Callback when user approves the prompt (with optional edited text) */
    onApprove?: (editedPrompt?: string) => void;
    /** Callback when user cancels the approval */
    onCancelApproval?: () => void;
    /** Auto model effort setting - needed to show effort level in dynamic mode */
    autoModelEffort?: AutoModelEffort;
    /** Whether to show prepared session UI */
    showPrepared?: boolean;
    /** The prepared prompt for display/editing */
    preparedPrompt?: string;
    /** Callback when user launches the prepared session */
    onLaunch?: (editedPrompt?: string) => void;
    /** Callback when user cancels the prepared session */
    onCancelPrepared?: () => void;
    /** Available repos for prepared mode repo selection */
    repos?: RepoConfig[];
    /** Repo recommendation for prepared mode (low-confidence case) */
    preparedRepoRecommendation?: { recommendedIndex: number | null; reasoning: string; confidence: string };
    /** Currently selected repo cwd for prepared mode */
    selectedRepoCwd?: string;
    /** Callback when user selects a repo in prepared mode */
    onSelectRepo?: (repoCwd: string) => void;
  }

  let {
    pendingTranscription,
    sessionId,
    completed = false,
    onRetry,
    onCancel,
    showApproval = false,
    approvalPrompt,
    repoName,
    onApprove,
    onCancelApproval,
    autoModelEffort = "dynamic",
    showPrepared = false,
    preparedPrompt,
    onLaunch,
    onCancelPrepared,
    repos = [],
    preparedRepoRecommendation,
    selectedRepoCwd = "",
    onSelectRepo,
  }: Props = $props();

  // Resolve the recommended repo path using full repos array (recommendation index is into full array)
  const recommendedRepoPath = $derived(
    preparedRepoRecommendation?.recommendedIndex != null
      ? $reposStore.list[preparedRepoRecommendation.recommendedIndex]?.path
      : null
  );

  // Approval mode state
  let isEditingPrompt = $state(false);
  let editedPrompt = $state("");
  let textareaEl: HTMLTextAreaElement | null = $state(null);

  // Initialize edited prompt when approval mode is shown
  $effect(() => {
    if (showApproval && approvalPrompt) {
      editedPrompt = approvalPrompt;
    }
    if (showPrepared && preparedPrompt) {
      editedPrompt = preparedPrompt;
    }
  });

  // Auto-resize textarea
  function autoResizeTextarea() {
    if (textareaEl) {
      textareaEl.style.height = "auto";
      const maxHeight = 200;
      const newHeight = Math.min(textareaEl.scrollHeight, maxHeight);
      textareaEl.style.height = newHeight + "px";
      textareaEl.style.overflowY =
        textareaEl.scrollHeight > maxHeight ? "auto" : "hidden";
    }
  }

  // Focus textarea when entering edit mode
  $effect(() => {
    if (isEditingPrompt && textareaEl) {
      textareaEl.focus();
      textareaEl.select();
      autoResizeTextarea();
    }
  });

  function handleApprove() {
    if (onApprove) {
      // Only pass edited prompt if it was actually changed
      const promptToSend =
        editedPrompt !== approvalPrompt ? editedPrompt : undefined;
      onApprove(promptToSend);
    }
  }

  function handleCancelApproval() {
    if (onCancelApproval) {
      onCancelApproval();
    }
  }

  function handleLaunch() {
    if (onLaunch) {
      const promptToSend = editedPrompt !== preparedPrompt ? editedPrompt : undefined;
      onLaunch(promptToSend);
    }
  }

  function handleCancelPrepared() {
    if (onCancelPrepared) {
      onCancelPrepared();
    }
  }

  // Get repo name from path for display
  function getRepoNameFromPath(path: string): string {
    return path.split(/[/\\]/).pop() || path;
  }

  // Check if launch is allowed (repo must be selected)
  let canLaunch = $derived(showPrepared && !!selectedRepoCwd);
  let useIconRepoToggleGroup = $derived(repos.length <= 5);

  // Determine if this was a voice recording vs typed text input
  // Voice recordings have audio data (visualization history, duration, or audio bytes)
  let isVoiceInput = $derived(
    !!(
      pendingTranscription.audioVisualizationHistory?.length ||
      pendingTranscription.recordingDurationMs ||
      pendingTranscription.audioData
    )
  );

  // Label for the input type
  let inputTypeLabel = $derived(isVoiceInput ? "Voice input" : "Text input");

  // Live timer for recording duration
  let elapsedMs = $state(0);
  let timerInterval: ReturnType<typeof setInterval> | null = null;

  // Format duration in mm:ss format
  function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }

  // Get the display duration (live elapsed or final recorded)
  let displayDuration = $derived.by(() => {
    if (
      pendingTranscription.status === "recording" &&
      pendingTranscription.recordingStartedAt
    ) {
      return formatDuration(elapsedMs);
    }
    if (pendingTranscription.recordingDurationMs) {
      return formatDuration(pendingTranscription.recordingDurationMs);
    }
    return null;
  });

  // Start/stop timer based on recording status
  $effect(() => {
    if (
      pendingTranscription.status === "recording" &&
      pendingTranscription.recordingStartedAt
    ) {
      // Start live timer
      const startTime = pendingTranscription.recordingStartedAt;
      const updateElapsed = () => {
        elapsedMs = Date.now() - startTime;
      };
      updateElapsed(); // Initial update
      timerInterval = setInterval(updateElapsed, 100); // Update every 100ms

      return () => {
        if (timerInterval) {
          clearInterval(timerInterval);
          timerInterval = null;
        }
      };
    }
  });

  // Status helpers
  function getStatusText(status: PendingTranscriptionInfo["status"]): string {
    switch (status) {
      case "recording":
        return "Recording...";
      case "transcribing":
        return "Transcribing...";
      case "processing":
        return "Processing...";
      default:
        return "Pending";
    }
  }

  function getStatusColor(status: PendingTranscriptionInfo["status"]): string {
    switch (status) {
      case "recording":
        return "text-recording"; // red, matches overlay
      case "transcribing":
        return "text-amber-400";
      case "processing":
        return "text-blue-400";
      default:
        return "text-text-muted";
    }
  }

  function getDotColor(status: PendingTranscriptionInfo["status"]): string {
    switch (status) {
      case "recording":
        return "bg-recording"; // red, matches overlay
      case "transcribing":
        return "bg-amber-400";
      case "processing":
        return "bg-blue-400";
      default:
        return "bg-text-muted";
    }
  }
</script>

<div class="session-recording-header" class:completed>
  <!-- Status indicator (only show when pending, not completed) -->
  {#if !completed}
    <div class="status-row">
      <div class="status-indicator">
        <span
          class="status-dot {getDotColor(pendingTranscription.status)}"
          class:animate-pulse={pendingTranscription.status !== "recording"}
        ></span>
        {#if pendingTranscription.status === "recording"}
          <span
            class="status-dot {getDotColor(
              pendingTranscription.status
            )} animate-pulse-recording"
          ></span>
        {/if}
        <span class="status-text {getStatusColor(pendingTranscription.status)}">
          {getStatusText(pendingTranscription.status)}
        </span>
        {#if displayDuration}
          <span class="duration-text">{displayDuration}</span>
        {/if}
      </div>

      {#if pendingTranscription.status === "recording" && onCancel}
        <button class="cancel-btn" onclick={onCancel} title="Cancel recording">
          Cancel
        </button>
      {/if}
    </div>
  {/if}

  <!-- Transcription error with retry (only show when pending) -->
  {#if pendingTranscription.transcriptionError && !completed}
    <div class="error-section">
      <div class="error-message">
        <span class="error-icon">!</span>
        <span
          >Transcription failed: {pendingTranscription.transcriptionError}</span
        >
      </div>
      {#if onRetry}
        <button class="retry-btn" onclick={onRetry}>
          Retry Transcription
        </button>
      {/if}
    </div>
  {/if}

  <!-- Transcript preview section -->
  {#if pendingTranscription.transcript && !pendingTranscription.transcriptionError}
    <div class="transcript-section">
      <!-- Header row with label, badges, and duration -->
      <div class="transcript-header">
        <span class="transcript-label">
          {completed ? inputTypeLabel : (pendingTranscription.wasCleanedUp ? "Final transcript" : "Transcript")}
        </span>
        <div class="transcript-badges">
          {#if pendingTranscription.wasCleanedUp}
            <span class="cleaned-badge">Cleaned</span>
          {/if}
          {#if pendingTranscription.voskTranscript}
            <span class="dual-source-badge">Dual-source</span>
          {/if}
          {#if displayDuration}
            <span class="duration-badge">{displayDuration}</span>
          {/if}
        </div>
      </div>

      <!-- Main transcript text -->
      <div class="transcript-text">
        {pendingTranscription.cleanedTranscript || pendingTranscription.transcript}
      </div>

      <!-- Collapsible details section (sources + diff) -->
      {#if pendingTranscription.voskTranscript || (pendingTranscription.wasCleanedUp && pendingTranscription.cleanedTranscript !== pendingTranscription.transcript)}
        <details class="transcript-details">
          <summary>
            <span>Details</span>
            <svg class="chevron" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
            </svg>
          </summary>
          <div class="details-content">
            <!-- Source transcripts -->
            {#if pendingTranscription.voskTranscript}
              <div class="sources-compact">
                <div class="source-row">
                  <span class="source-badge whisper-badge">Whisper</span>
                  <span class="source-text-inline">{pendingTranscription.transcript}</span>
                </div>
                <div class="source-row">
                  <span class="source-badge vosk-badge">Vosk</span>
                  <span class="source-text-inline">{pendingTranscription.voskTranscript}</span>
                </div>
              </div>
            {/if}

            <!-- Diff visualization -->
            {#if (pendingTranscription.wasCleanedUp && pendingTranscription.cleanedTranscript && pendingTranscription.cleanedTranscript !== pendingTranscription.transcript) || (pendingTranscription.voskTranscript && pendingTranscription.voskTranscript !== pendingTranscription.transcript)}
              <div class="diff-container">
                <TranscriptDiff
                  original={pendingTranscription.transcript}
                  cleaned={pendingTranscription.cleanedTranscript ||
                    pendingTranscription.transcript}
                  voskTranscript={pendingTranscription.voskTranscript}
                  usedDualSource={!!pendingTranscription.voskTranscript}
                  corrections={pendingTranscription.cleanupCorrections || []}
                  collapsed={false}
                />
              </div>
            {/if}
          </div>
        </details>
      {/if}
    </div>
  {/if}

  <!-- LLM Recommendations -->
  {#if pendingTranscription.modelRecommendation || pendingTranscription.repoRecommendation}
    <div class="recommendations-section">
      {#if pendingTranscription.modelRecommendation}
        <div class="recommendation model-recommendation">
          <div class="recommendation-header">
            <span class="auto-badge">Auto</span>
            <span class="recommendation-label">Model</span>
            <span
              class="model-badge {getModelBadgeBgColor(
                pendingTranscription.modelRecommendation.modelId
              )} {getModelTextColor(
                pendingTranscription.modelRecommendation.modelId
              )}"
            >
              {getShortModelName(
                pendingTranscription.modelRecommendation.modelId
              )}
            </span>
            {#if pendingTranscription.modelRecommendation.effortLevel}
              <span class="effort-badge effort-on">
                Effort: {pendingTranscription.modelRecommendation.effortLevel}
              </span>
            {/if}
          </div>
          <p class="reasoning">
            {pendingTranscription.modelRecommendation.reasoning}
          </p>
        </div>
      {/if}

      {#if pendingTranscription.repoRecommendation}
        <div class="recommendation repo-recommendation">
          <div class="recommendation-header">
            <span class="auto-badge">Auto</span>
            <span class="recommendation-label">Repository</span>
            <span class="repo-name"
              >{pendingTranscription.repoRecommendation.repoName}</span
            >
            <span
              class="confidence confidence-{pendingTranscription
                .repoRecommendation.confidence}"
            >
              {pendingTranscription.repoRecommendation.confidence}
            </span>
          </div>
          <p class="reasoning">
            {pendingTranscription.repoRecommendation.reasoning}
          </p>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Prepared Session UI -->
  {#if showPrepared && preparedPrompt}
    <div class="prepared-section">
      <div class="prepared-header">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>Session prepared — review and launch when ready</span>
      </div>

      <!-- Repo section -->
      <div class="prepared-repo">
        {#if selectedRepoCwd}
          <div class="prepared-repo-display">
            <RepoIcon repo={findRepoByPath($reposStore.list, selectedRepoCwd)} size="xs" />
            <span class="repo-label">Repository:</span>
            <span class="repo-value">{getRepoNameFromPath(selectedRepoCwd)}</span>
          </div>
        {:else}
          <!-- No repo selected - show inline picker -->
          <div class="prepared-repo-picker">
            <div class="picker-label">
              <svg class="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <span>Select a repository to launch:</span>
            </div>
            {#if preparedRepoRecommendation}
              <p class="picker-reasoning text-xs text-text-muted mt-1">
                {preparedRepoRecommendation.reasoning}
              </p>
            {/if}
            {#if useIconRepoToggleGroup}
              <div class="picker-toggle-group" role="group" aria-label="Select repository">
                {#each repos as repo}
                  <button
                    class="picker-repo-btn icon-only"
                    class:recommended={repo.path === recommendedRepoPath}
                    onclick={() => onSelectRepo?.(repo.path)}
                    title={repo.name}
                    aria-label={`Select ${repo.name} repository`}
                  >
                    <RepoIcon repo={repo} size="xs" />
                    {#if repo.path === recommendedRepoPath}
                      <span class="picker-ai-dot" aria-hidden="true"></span>
                    {/if}
                  </button>
                {/each}
              </div>
            {:else}
              <div class="picker-grid">
                {#each repos as repo}
                  <button
                    class="picker-repo-btn"
                    class:recommended={repo.path === recommendedRepoPath}
                    onclick={() => onSelectRepo?.(repo.path)}
                  >
                    <RepoIcon repo={repo} size="xs" />
                    <span class="picker-repo-name">{repo.name}</span>
                    {#if repo.path === recommendedRepoPath}
                      <span class="picker-ai-badge">AI</span>
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Editable prompt -->
      <div class="prepared-prompt">
        {#if isEditingPrompt}
          <textarea
            bind:this={textareaEl}
            bind:value={editedPrompt}
            oninput={autoResizeTextarea}
            class="prompt-textarea prepared-textarea"
            placeholder="Enter your prompt..."
            rows="2"
          ></textarea>
        {:else}
          <div class="prompt-display prepared-prompt-display" onclick={() => (isEditingPrompt = true)}>
            <span class="prompt-text">{editedPrompt || preparedPrompt}</span>
            <button
              class="edit-inline-btn"
              onclick={(e) => {
                e.stopPropagation();
                isEditingPrompt = true;
              }}
              title="Edit prompt"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          </div>
        {/if}
      </div>

      <!-- Action buttons -->
      <div class="prepared-actions">
        <button class="cancel-approval-btn" onclick={handleCancelPrepared}>
          Discard
        </button>
        {#if isEditingPrompt}
          <button class="done-edit-btn" onclick={() => (isEditingPrompt = false)}>
            Done Editing
          </button>
        {/if}
        <button
          class="launch-btn"
          onclick={handleLaunch}
          disabled={!canLaunch}
          title={canLaunch ? 'Launch session' : 'Select a repository first'}
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          Launch
        </button>
      </div>
    </div>
  {/if}

  <!-- Approval UI -->
  {#if showApproval && approvalPrompt}
    <div class="approval-section">
      <div class="approval-header">
        <svg
          class="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span>Review your prompt before sending</span>
      </div>

      <!-- Repository info -->
      {#if repoName}
        <div class="approval-repo">
          <RepoIcon repo={$reposStore.list.find(r => r.name === repoName) || null} size="xs" />
          <span class="repo-label">Repository:</span>
          <span class="repo-value">{repoName}</span>
        </div>
      {/if}

      <!-- Editable prompt -->
      <div class="approval-prompt">
        {#if isEditingPrompt}
          <textarea
            bind:this={textareaEl}
            bind:value={editedPrompt}
            oninput={autoResizeTextarea}
            class="prompt-textarea"
            placeholder="Enter your prompt..."
            rows="2"
          ></textarea>
        {:else}
          <div class="prompt-display" onclick={() => (isEditingPrompt = true)}>
            <span class="prompt-text">{editedPrompt || approvalPrompt}</span>
            <button
              class="edit-inline-btn"
              onclick={(e) => {
                e.stopPropagation();
                isEditingPrompt = true;
              }}
              title="Edit prompt"
            >
              <svg
                class="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                />
              </svg>
            </button>
          </div>
        {/if}
      </div>

      <!-- Action buttons -->
      <div class="approval-actions">
        <button class="cancel-approval-btn" onclick={handleCancelApproval}>
          Cancel
        </button>
        {#if isEditingPrompt}
          <button
            class="done-edit-btn"
            onclick={() => (isEditingPrompt = false)}
          >
            Done Editing
          </button>
        {/if}
        <button class="approve-btn" onclick={handleApprove}>
          <svg
            class="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
          Send
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .session-recording-header {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 0.75rem;
    margin-bottom: 1rem;
  }

  .session-recording-header.completed {
    background: transparent;
    border: none;
    padding: 0;
    margin-bottom: 0.5rem;
  }

  .status-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .status-indicator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .status-dot.animate-pulse-recording {
    animation: pulse-recording 1s ease-in-out infinite;
  }

  @keyframes pulse-recording {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.5;
      transform: scale(1.2);
    }
  }

  .status-text {
    font-size: 0.875rem;
    font-weight: 500;
  }

  .duration-text {
    font-size: 0.875rem;
    font-weight: 600;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
      monospace;
    color: var(--color-text-secondary);
    margin-left: 0.5rem;
  }

  .duration-badge {
    padding: 0.125rem 0.375rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 3px;
    font-size: 0.6875rem;
    font-weight: 600;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
      monospace;
    color: var(--color-text-muted);
    margin-left: auto;
  }

  .cancel-btn {
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
    background: rgba(239, 68, 68, 0.1);
    color: var(--color-error);
    border: 1px solid var(--color-error);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .cancel-btn:hover {
    background: var(--color-error);
    color: white;
  }

  .error-section {
    padding: 0.75rem;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 6px;
  }

  .status-row + .error-section {
    margin-top: 0.75rem;
  }

  .error-message {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #ef4444;
    font-size: 0.875rem;
    margin-bottom: 0.5rem;
  }

  .error-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    background: #ef4444;
    color: white;
    border-radius: 50%;
    font-size: 0.75rem;
    font-weight: bold;
  }

  .retry-btn {
    font-size: 0.75rem;
    padding: 0.375rem 0.75rem;
    background: transparent;
    color: #ef4444;
    border: 1px solid #ef4444;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .retry-btn:hover {
    background: #ef4444;
    color: white;
  }

  .transcript-section {
    padding: 0.75rem;
    background: var(--color-surface-elevated);
    border-radius: 6px;
  }

  .status-row + .transcript-section,
  .error-section + .transcript-section {
    margin-top: 0.75rem;
  }

  .transcript-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.375rem;
  }

  .transcript-label {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-text-muted);
  }

  .transcript-badges {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .transcript-text {
    font-size: 0.875rem;
    color: var(--color-text-primary);
    line-height: 1.5;
  }

  /* Collapsible details section */
  .transcript-details {
    margin-top: 0.5rem;
    border-top: 1px solid var(--color-border);
    padding-top: 0.5rem;
  }

  .transcript-details summary {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.6875rem;
    color: var(--color-text-muted);
    cursor: pointer;
    user-select: none;
    width: fit-content;
    list-style: none;
  }

  .transcript-details summary::-webkit-details-marker {
    display: none;
  }

  .transcript-details summary:hover {
    color: var(--color-text-secondary);
  }

  .transcript-details summary .chevron {
    width: 14px;
    height: 14px;
    transition: transform 0.15s ease;
  }

  .transcript-details[open] summary .chevron {
    transform: rotate(180deg);
  }

  .transcript-details .details-content {
    margin-top: 0.5rem;
  }

  /* Compact source transcripts */
  .sources-compact {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin-bottom: 0.5rem;
  }

  .source-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.8125rem;
  }

  .source-text-inline {
    color: var(--color-text-secondary);
    line-height: 1.4;
  }

  .recommendations-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .transcript-section + .recommendations-section {
    margin-top: 0.75rem;
  }

  .recommendation {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.625rem 0.75rem;
    border-radius: 6px;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
  }

  .recommendation-header {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .auto-badge {
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    background: linear-gradient(135deg, #8b5cf6 0%, #f59e0b 100%);
    color: white;
    font-size: 0.6875rem;
    font-weight: 600;
  }

  .recommendation-label {
    color: var(--color-text-muted);
    font-weight: 500;
    font-size: 0.8125rem;
  }

  .model-badge {
    padding: 0.1875rem 0.5rem;
    border-radius: 4px;
    font-weight: 600;
    font-size: 0.75rem;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  }

  .effort-badge {
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    font-size: 0.6875rem;
    font-weight: 500;
    text-transform: capitalize;
  }

  .effort-badge.effort-on {
    background: rgba(6, 182, 212, 0.15);
    border: 1px solid rgba(6, 182, 212, 0.3);
    color: #22d3ee;
  }

  .effort-badge.effort-off {
    background: rgba(107, 114, 128, 0.1);
    border: 1px solid rgba(107, 114, 128, 0.2);
    color: #9ca3af;
  }

  .repo-name {
    color: var(--color-text-primary);
    font-weight: 600;
    font-size: 0.875rem;
  }

  .confidence {
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    font-size: 0.6875rem;
    font-weight: 500;
    text-transform: capitalize;
  }

  .confidence-high {
    background: rgba(34, 197, 94, 0.15);
    border: 1px solid rgba(34, 197, 94, 0.3);
    color: #4ade80;
  }

  .confidence-medium {
    background: rgba(234, 179, 8, 0.15);
    border: 1px solid rgba(234, 179, 8, 0.3);
    color: #fbbf24;
  }

  .confidence-low {
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #f87171;
  }

  .reasoning {
    color: var(--color-text-secondary);
    font-size: 0.8125rem;
    line-height: 1.4;
    margin: 0;
  }

  .diff-container {
    margin-top: 0.5rem;
  }

  .sources-compact + .diff-container {
    margin-top: 0;
    padding-top: 0.5rem;
    border-top: 1px dashed var(--color-border);
  }

  .dual-source-badge {
    padding: 0.125rem 0.375rem;
    background: rgba(139, 92, 246, 0.1);
    border: 1px solid rgba(139, 92, 246, 0.2);
    border-radius: 3px;
    font-size: 0.625rem;
    font-weight: 600;
    color: #a78bfa;
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }

  .cleaned-badge {
    padding: 0.125rem 0.375rem;
    background: rgba(34, 197, 94, 0.15);
    border: 1px solid rgba(34, 197, 94, 0.3);
    border-radius: 3px;
    font-size: 0.625rem;
    font-weight: 600;
    color: #4ade80;
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }

  .source-badge {
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.025em;
    flex-shrink: 0;
  }

  .whisper-badge {
    background: rgba(var(--color-accent-rgb, 59, 130, 246), 0.15);
    border: 1px solid rgba(var(--color-accent-rgb, 59, 130, 246), 0.3);
    color: var(--color-accent);
  }

  .vosk-badge {
    background: rgba(139, 92, 246, 0.15);
    border: 1px solid rgba(139, 92, 246, 0.3);
    color: #a78bfa;
  }

  /* Approval UI Styles */
  .approval-section {
    margin-top: 1rem;
    padding: 1rem;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-accent);
    border-radius: 8px;
  }

  .approval-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-accent);
    margin-bottom: 0.75rem;
  }

  .approval-repo {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin-bottom: 0.75rem;
    padding: 0.5rem 0.75rem;
    background: var(--color-surface);
    border-radius: 6px;
  }

  .repo-label {
    color: var(--color-text-muted);
  }

  .repo-value {
    color: var(--color-text-primary);
    font-weight: 500;
  }

  .approval-prompt {
    margin-bottom: 0.75rem;
  }

  .prompt-display {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.75rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    cursor: text;
    transition: border-color 0.15s ease;
  }

  .prompt-display:hover {
    border-color: var(--color-accent);
  }

  .prompt-display .prompt-text {
    font-size: 0.875rem;
    color: var(--color-text-primary);
    line-height: 1.5;
    flex: 1;
  }

  .edit-inline-btn {
    flex-shrink: 0;
    padding: 0.25rem;
    color: var(--color-text-muted);
    background: transparent;
    border-radius: 4px;
    transition: all 0.15s ease;
  }

  .edit-inline-btn:hover {
    color: var(--color-accent);
    background: rgba(var(--color-accent-rgb, 59, 130, 246), 0.1);
  }

  .prompt-textarea {
    width: 100%;
    padding: 0.75rem;
    background: var(--color-surface);
    border: 1px solid var(--color-accent);
    border-radius: 6px;
    color: var(--color-text-primary);
    font-size: 0.875rem;
    font-family: inherit;
    line-height: 1.5;
    resize: none;
    overflow-y: hidden;
  }

  .prompt-textarea:focus {
    outline: none;
    box-shadow: 0 0 0 2px rgba(var(--color-accent-rgb, 59, 130, 246), 0.2);
  }

  .approval-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .cancel-approval-btn {
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .cancel-approval-btn:hover {
    color: var(--color-error);
    border-color: var(--color-error);
    background: rgba(239, 68, 68, 0.1);
  }

  .done-edit-btn {
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .done-edit-btn:hover {
    background: var(--color-surface-elevated);
    border-color: var(--color-text-muted);
  }

  .approve-btn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: white;
    background: var(--color-accent);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .approve-btn:hover {
    filter: brightness(1.1);
  }

  .approve-btn:active {
    transform: scale(0.98);
  }

  /* Prepared Session UI Styles */
  .prepared-section {
    margin-top: 1rem;
    padding: 1rem;
    background: var(--color-surface-elevated);
    border: 1px solid rgba(20, 184, 166, 0.4);
    border-radius: 8px;
  }

  .prepared-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: #2dd4bf;
    margin-bottom: 0.75rem;
  }

  .prepared-repo {
    margin-bottom: 0.75rem;
  }

  .prepared-repo-display {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    padding: 0.5rem 0.75rem;
    background: var(--color-surface);
    border-radius: 6px;
  }

  .prepared-repo-picker {
    padding: 0.75rem;
    background: var(--color-surface);
    border-radius: 6px;
    border: 1px dashed rgba(245, 158, 11, 0.3);
  }

  .picker-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: #fbbf24;
  }

  .picker-reasoning {
    margin-bottom: 0.5rem;
  }

  .picker-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .picker-toggle-group {
    display: inline-flex;
    align-items: center;
    gap: 0;
    margin-top: 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--color-surface-elevated);
  }

  .picker-repo-btn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .picker-repo-btn.icon-only {
    position: relative;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    padding: 0;
    border: 0;
    border-right: 1px solid var(--color-border);
    border-radius: 0;
  }

  .picker-toggle-group .picker-repo-btn:last-child {
    border-right: 0;
  }

  .picker-repo-btn:hover {
    border-color: rgba(20, 184, 166, 0.5);
    color: var(--color-text-primary);
    background: rgba(20, 184, 166, 0.05);
  }

  .picker-repo-btn.recommended {
    border-color: rgba(20, 184, 166, 0.4);
    background: rgba(20, 184, 166, 0.08);
  }

  .picker-repo-name {
    font-weight: 500;
  }

  .picker-ai-dot {
    position: absolute;
    top: 0.3rem;
    right: 0.3rem;
    width: 0.35rem;
    height: 0.35rem;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8b5cf6 0%, #f59e0b 100%);
    box-shadow: 0 0 0 2px var(--color-surface-elevated);
  }

  .picker-ai-badge {
    padding: 0.0625rem 0.3125rem;
    border-radius: 3px;
    background: linear-gradient(135deg, #8b5cf6 0%, #f59e0b 100%);
    color: white;
    font-size: 0.625rem;
    font-weight: 600;
  }

  .prepared-prompt {
    margin-bottom: 0.75rem;
  }

  .prepared-textarea:focus {
    box-shadow: 0 0 0 2px rgba(20, 184, 166, 0.2);
    border-color: #2dd4bf;
  }

  .prepared-prompt-display:hover {
    border-color: #2dd4bf;
  }

  .prepared-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .launch-btn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: white;
    background: #0d9488;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .launch-btn:hover:not(:disabled) {
    background: #0f766e;
  }

  .launch-btn:active:not(:disabled) {
    transform: scale(0.98);
  }

  .launch-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
