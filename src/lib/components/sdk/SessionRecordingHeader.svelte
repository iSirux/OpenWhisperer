<script lang="ts">
  import { sdkSessions, type PendingTranscriptionInfo } from "$lib/stores/sdkSessions";
  import type { AutoModelEffort } from "$lib/stores/settings";
  import {
    getShortModelName,
    getModelBadgeBgColor,
    getModelTextColor,
  } from "$lib/utils/modelColors";
  import TranscriptDiff from "../TranscriptDiff.svelte";

  interface Props {
    pendingTranscription: PendingTranscriptionInfo;
    sessionId: string;
    /** Whether this is showing completed/historical recording info (not pending) */
    completed?: boolean;
    onRetry?: () => void;
    onCancel?: () => void;
    /** Auto model effort setting - needed to show effort level in dynamic mode */
    autoModelEffort?: AutoModelEffort;
  }

  let {
    pendingTranscription,
    sessionId,
    completed = false,
    onRetry,
    onCancel,
    autoModelEffort = "dynamic",
  }: Props = $props();

  // Recording screenshot previews (expanded state per thumbnail index)
  let expandedScreenshots = $state<Set<number>>(new Set());

  function toggleScreenshot(idx: number) {
    const next = new Set(expandedScreenshots);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    expandedScreenshots = next;
  }

  function removeScreenshot(idx: number) {
    const remaining = pendingTranscription.screenshots?.filter((_, i) => i !== idx);
    expandedScreenshots = new Set();
    sdkSessions.updatePendingTranscription(sessionId, {
      screenshots: remaining && remaining.length > 0 ? remaining : undefined,
    });
  }

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
          {#if pendingTranscription.realtimeTranscript}
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
      {#if pendingTranscription.realtimeTranscript || (pendingTranscription.wasCleanedUp && pendingTranscription.cleanedTranscript !== pendingTranscription.transcript)}
        <details class="transcript-details">
          <summary>
            <span>Details</span>
            <svg class="chevron" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
            </svg>
          </summary>
          <div class="details-content">
            <!-- Source transcripts -->
            {#if pendingTranscription.realtimeTranscript}
              <div class="sources-compact">
                <div class="source-row">
                  <span class="source-badge whisper-badge">Whisper</span>
                  <span class="source-text-inline">{pendingTranscription.transcript}</span>
                </div>
                <div class="source-row">
                  <span class="source-badge realtime-badge">Real-time</span>
                  <span class="source-text-inline">{pendingTranscription.realtimeTranscript}</span>
                </div>
              </div>
            {/if}

            <!-- Diff visualization -->
            {#if (pendingTranscription.wasCleanedUp && pendingTranscription.cleanedTranscript && pendingTranscription.cleanedTranscript !== pendingTranscription.transcript) || (pendingTranscription.realtimeTranscript && pendingTranscription.realtimeTranscript !== pendingTranscription.transcript)}
              <div class="diff-container">
                <TranscriptDiff
                  original={pendingTranscription.transcript}
                  cleaned={pendingTranscription.cleanedTranscript ||
                    pendingTranscription.transcript}
                  realtimeTranscript={pendingTranscription.realtimeTranscript}
                  usedDualSource={!!pendingTranscription.realtimeTranscript}
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

  <!-- Recording screenshots (auto-captured at record start, attached to the prompt) -->
  {#if pendingTranscription.screenshots && pendingTranscription.screenshots.length > 0}
    <div class="screenshot-section">
      <div class="screenshot-header">
        <span class="screenshot-label">
          Screenshot{pendingTranscription.screenshots.length > 1 ? "s" : ""}
        </span>
        <span class="screenshot-hint">captured at recording start — attached to the prompt</span>
      </div>
      <div class="screenshot-thumbs">
        {#each pendingTranscription.screenshots as screenshot, idx}
          <div class="screenshot-thumb-item">
            <button
              class="screenshot-thumb-wrap"
              onclick={() => toggleScreenshot(idx)}
              title={expandedScreenshots.has(idx) ? "Collapse" : "Expand"}
            >
              <img
                src={`data:${screenshot.mediaType};base64,${screenshot.base64Data}`}
                alt="Screen captured when recording started"
                class="screenshot-thumb"
                class:expanded={expandedScreenshots.has(idx)}
              />
            </button>
            {#if !completed}
              <button
                class="screenshot-remove-btn screenshot-remove-overlay"
                onclick={() => removeScreenshot(idx)}
                title="Remove screenshot (won't be attached to the prompt)"
              >
                ✕
              </button>
            {/if}
          </div>
        {/each}
      </div>
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

  .screenshot-section {
    padding: 0.75rem;
    background: var(--color-surface-elevated);
    border-radius: 6px;
    margin-top: 0.75rem;
  }

  .screenshot-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.375rem;
  }

  .screenshot-label {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-text-muted);
  }

  .screenshot-hint {
    font-size: 0.6875rem;
    color: var(--color-text-muted);
    opacity: 0.7;
  }

  .screenshot-remove-btn {
    margin-left: auto;
    font-size: 0.75rem;
    padding: 0.125rem 0.375rem;
    background: transparent;
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .screenshot-remove-btn:hover {
    background: rgba(239, 68, 68, 0.1);
    color: var(--color-error);
    border-color: var(--color-error);
  }

  .screenshot-thumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: flex-start;
  }

  .screenshot-thumb-item {
    position: relative;
  }

  .screenshot-remove-overlay {
    position: absolute;
    top: 0.25rem;
    right: 0.25rem;
    margin-left: 0;
    background: var(--color-surface);
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .screenshot-thumb-item:hover .screenshot-remove-overlay {
    opacity: 1;
  }

  .screenshot-thumb-wrap {
    display: block;
    padding: 0;
    background: transparent;
    border: none;
    cursor: pointer;
  }

  .screenshot-thumb {
    max-height: 90px;
    max-width: 100%;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    transition: max-height 0.15s ease;
  }

  .screenshot-thumb.expanded {
    max-height: 480px;
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

  .realtime-badge {
    background: rgba(139, 92, 246, 0.15);
    border: 1px solid rgba(139, 92, 246, 0.3);
    color: #a78bfa;
  }
</style>
