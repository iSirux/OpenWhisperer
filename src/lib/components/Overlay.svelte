<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    recording,
    isRecording,
    isProcessing,
    type RecordingState,
  } from "$lib/stores/recording";
  import { settings } from "$lib/stores/settings";
  import { activeRepo, isAutoRepoSelected } from "$lib/stores/repos";
  import { isRepoAutoSelectEnabled } from "$lib/utils/llm";
  import { overlay } from "$lib/stores/overlay";
  import StatusBadge from "./StatusBadge.svelte";
  import RepoIcon from "./RepoIcon.svelte";
  import Waveform from "./Waveform.svelte";
  import TranscriptMarquee from "./TranscriptMarquee.svelte";
  import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
  import {
    getShortModelName,
    getModelBadgeBgColor,
    getModelTextColor,
  } from "$lib/utils/modelColors";
  import type { OverlayMode, OverlayActivityInfo } from "$lib/stores/overlay";

  // Check if Vosk real-time transcription should be shown
  $: showRealtimeTranscript = $settings.vosk?.enabled ?? false;

  // Check if active sessions should be shown in overlay
  $: showActiveSessions = $settings.overlay?.show_active_sessions ?? true;

  // Track remote recording state (from main window events)
  let remoteRecordingState: RecordingState = "idle";
  let unlistenRecordingState: UnlistenFn | null = null;
  let unlistenSessionInfo: UnlistenFn | null = null;
  let unlistenMode: UnlistenFn | null = null;
  let unlistenInlineSessionInfo: UnlistenFn | null = null;
  let unlistenActivityInfo: UnlistenFn | null = null;

  // Use remote state if available, otherwise local state
  $: isRecordingActive = remoteRecordingState === "recording" || $isRecording;
  $: isProcessingActive =
    remoteRecordingState === "processing" || $isProcessing;

  // Build the activity status text
  $: hasActivity = $overlay.activityInfo.activeSessions > 0 || $overlay.activityInfo.activeSequences > 0;
  $: activityText = buildActivityText($overlay.activityInfo.activeSessions, $overlay.activityInfo.activeSequences);

  function buildActivityText(sessions: number, sequences: number): string {
    const parts: string[] = [];
    if (sessions > 0) {
      parts.push(`${sessions} active session${sessions !== 1 ? "s" : ""}`);
    }
    if (sequences > 0) {
      parts.push(`${sequences} active sequence${sequences !== 1 ? "s" : ""}`);
    }
    return parts.join(", ");
  }

  function getModelLabel(model: string | null): string {
    if (!model) return "";
    return getShortModelName(model);
  }

  // Dispatch resize event to notify parent page
  function notifyResize() {
    console.log("[Overlay] notifyResize dispatching event");
    window.dispatchEvent(new CustomEvent("overlay-content-changed"));
  }

  onMount(async () => {
    console.log("[Overlay] onMount - setting up listeners");

    // Listen for recording state changes from main window
    unlistenRecordingState = await listen<{ state: RecordingState }>(
      "recording-state",
      (event) => {
        console.log(
          "[Overlay] recording-state event received:",
          event.payload.state
        );
        remoteRecordingState = event.payload.state;
        // Notify parent to resize after state change renders
        setTimeout(notifyResize, 10);
        setTimeout(notifyResize, 50);
        setTimeout(notifyResize, 150);
      }
    );

    // Listen for session info changes from main window (for model display)
    unlistenSessionInfo = await listen<{
      branch: string | null;
      model: string | null;
      creatingSession: boolean;
    }>("overlay-session-info", (event) => {
      overlay.updateSessionInfoLocal(
        event.payload.branch,
        event.payload.model,
        event.payload.creatingSession
      );
      setTimeout(notifyResize, 10);
    });

    // Listen for mode changes from main window
    unlistenMode = await listen<{ mode: OverlayMode }>(
      "overlay-mode",
      (event) => {
        overlay.updateModeLocal(event.payload.mode);
        setTimeout(notifyResize, 10);
      }
    );

    // Listen for inline session info changes from main window
    unlistenInlineSessionInfo = await listen<{
      repoName: string | null;
      branch: string | null;
      model: string | null;
      promptPreview: string | null;
    } | null>("overlay-inline-session-info", (event) => {
      overlay.updateInlineSessionInfoLocal(event.payload);
      setTimeout(notifyResize, 10);
    });

    // Listen for activity info changes from main window (active sessions/sequences)
    unlistenActivityInfo = await listen<OverlayActivityInfo>(
      "overlay-activity-info",
      (event) => {
        overlay.updateActivityInfoLocal(
          event.payload.activeSessions,
          event.payload.activeSequences
        );
        setTimeout(notifyResize, 10);
      }
    );
  });

  onDestroy(() => {
    if (unlistenRecordingState) {
      unlistenRecordingState();
    }
    if (unlistenSessionInfo) {
      unlistenSessionInfo();
    }
    if (unlistenMode) {
      unlistenMode();
    }
    if (unlistenInlineSessionInfo) {
      unlistenInlineSessionInfo();
    }
    if (unlistenActivityInfo) {
      unlistenActivityInfo();
    }
  });

  function handleDiscard(event: MouseEvent) {
    event.stopPropagation();
    // Emit event to cancel recording in main window
    emit("discard-recording");
    // Also cancel locally in case this is the main window
    recording.cancelRecording();
    overlay.hide();
    overlay.clearSessionInfo();
  }

  function handleGo(event: MouseEvent) {
    event.stopPropagation();
    // Emit event to send recording in main window
    emit("send-recording");
  }
</script>

<div class="overlay-window px-3 pt-3 pb-2">
  <!-- Waveform visualization when recording -->
  {#if isRecordingActive}
    <div class="mb-2">
      <Waveform
        height={40}
        barWidth={2}
        barGap={1}
        color="#ef4444"
        useEvents={true}
      />
    </div>

    <!-- Real-time transcript from Vosk -->
    {#if showRealtimeTranscript}
      <div class="mb-2">
        <TranscriptMarquee />
      </div>
    {/if}
  {/if}

  <div class="flex items-center gap-3">
    <!-- Left section: Model badge / Status indicator (fixed width) -->
    <div class="flex items-center gap-2 flex-shrink-0">
      {#if isRecordingActive}
        {#if $overlay.mode === "paste"}
          <span
            class="text-xs text-text-muted px-1.5 py-0.5 bg-surface rounded"
          >
            Transcription
          </span>
        {:else if $overlay.mode === "note"}
          <span
            class="text-xs font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 flex items-center gap-1"
          >
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Note Mode
          </span>
        {:else if $overlay.mode === "inline"}
          {#if $overlay.inlineSessionInfo?.model}
            <span
              class="text-xs px-1.5 py-0.5 rounded {getModelBadgeBgColor(
                $overlay.inlineSessionInfo.model
              )} {getModelTextColor($overlay.inlineSessionInfo.model)}"
            >
              {getModelLabel($overlay.inlineSessionInfo.model)}
            </span>
          {/if}
        {:else}
          {#if $overlay.sessionInfo.model}
            <span
              class="text-xs px-1.5 py-0.5 rounded {getModelBadgeBgColor(
                $overlay.sessionInfo.model
              )} {getModelTextColor($overlay.sessionInfo.model)}"
            >
              {getModelLabel($overlay.sessionInfo.model)}
            </span>
          {/if}
        {/if}
      {:else if isProcessingActive}
        <div class="w-3 h-3 bg-warning rounded-full animate-pulse"></div>
        {#if $overlay.mode === "paste"}
          <span class="text-sm font-medium text-warning">Transcribing...</span>
        {:else}
          <span class="text-sm font-medium text-warning">Processing</span>
        {/if}
      {:else if $overlay.sessionInfo.creatingSession}
        <div class="w-3 h-3 bg-primary rounded-full animate-pulse"></div>
        <span class="text-sm font-medium text-primary"
          >Opening SDK session...</span
        >
      {:else}
        <div class="w-3 h-3 bg-text-muted rounded-full"></div>
        <span class="text-sm text-text-secondary">Ready</span>
      {/if}
    </div>

    <!-- Middle section: Repo info (can shrink/truncate) -->
    <div class="flex-1 min-w-0 overflow-hidden">
      {#if $overlay.mode === "inline" && $overlay.inlineSessionInfo}
        <div class="flex items-center gap-2 text-xs justify-end">
          {#if $overlay.inlineSessionInfo.repoName}
            <span class="text-text-secondary truncate"
              >{$overlay.inlineSessionInfo.repoName}</span
            >
          {/if}
          {#if $overlay.inlineSessionInfo.branch}
            <span class="text-text-muted flex-shrink-0">·</span>
            <span class="font-mono text-primary truncate max-w-24"
              >{$overlay.inlineSessionInfo.branch}</span
            >
          {/if}
        </div>
      {:else if $overlay.mode !== "paste" && $overlay.mode !== "note"}
        <div class="flex items-center gap-2 text-xs justify-end">
          {#if $isAutoRepoSelected && isRepoAutoSelectEnabled()}
            <span
              class="px-2 py-0.5 rounded bg-gradient-to-r from-purple-500 to-amber-500 text-white font-medium shadow-sm flex-shrink-0"
              >Auto</span
            >
          {:else if $activeRepo}
            <RepoIcon repo={$activeRepo} size="xs" />
            <span class="text-text-secondary truncate"
              >{$activeRepo.name}</span
            >
          {/if}
          {#if $activeRepo && !($isAutoRepoSelected && isRepoAutoSelectEnabled())}
            <StatusBadge
              createBranch={$settings.git.create_branch}
              autoMerge={$settings.git.auto_merge}
            />
          {/if}
        </div>
      {/if}
    </div>

    <!-- Right section: Action buttons (fixed width) -->
    {#if isRecordingActive}
      <div class="flex items-center gap-2 flex-shrink-0">
        <button
          class="go-btn px-2 py-1 text-xs font-medium bg-primary/20 hover:bg-primary/30 text-primary border border-primary/30 rounded transition-colors"
          onclick={handleGo}
          title="Stop and send"
        >
          Go
        </button>
        <button
          class="discard-btn px-2 py-1 text-xs font-medium bg-error/20 hover:bg-error/30 text-error border border-error/30 rounded transition-colors"
          onclick={handleDiscard}
          title="Discard recording"
        >
          Discard
        </button>
      </div>
    {/if}
  </div>

  <!-- Show SDK session info when available (only show branch here, model is shown inline when recording) -->
  {#if $overlay.sessionInfo.branch && !isRecordingActive && $overlay.mode !== "paste" && $overlay.mode !== "inline"}
    <div class="mt-2 p-2 bg-surface rounded text-xs text-text-secondary">
      <div class="flex items-center gap-3">
        <div class="flex items-center gap-1">
          <span class="text-text-muted">Branch:</span>
          <span class="font-mono text-primary"
            >{$overlay.sessionInfo.branch}</span
          >
        </div>
        {#if $overlay.sessionInfo.model}
          <div class="flex items-center gap-1">
            <span class="text-text-muted">Model:</span>
            <span
              class="font-medium px-1.5 py-0.5 rounded {getModelBadgeBgColor(
                $overlay.sessionInfo.model
              )} {getModelTextColor($overlay.sessionInfo.model)}"
              >{getModelLabel($overlay.sessionInfo.model)}</span
            >
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Active sessions/sequences indicator -->
  {#if showActiveSessions && hasActivity}
    <div class="mt-1.5 flex items-center gap-1.5 px-0.5">
      <div class="relative flex-shrink-0">
        <div class="w-2 h-2 rounded-full bg-emerald-400"></div>
        <div class="absolute inset-0 w-2 h-2 rounded-full bg-emerald-400 animate-ping opacity-75"></div>
      </div>
      <span class="text-[11px] text-text-secondary">{activityText}</span>
    </div>
  {/if}

  {#if $recording.error}
    <div
      class="mt-2 p-2 bg-error/20 border border-error/50 rounded text-sm text-error"
    >
      {$recording.error}
    </div>
  {/if}
</div>

<style>
  .overlay-window {
    width: 380px;
    display: inline-block;
    background: var(--color-surface);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }

  .line-clamp-3 {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
