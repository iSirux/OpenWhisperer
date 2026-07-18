<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    recording,
    isRecording,
    isProcessing,
    type RecordingState,
  } from "$lib/stores/recording";
  import {
    settings,
    RECORD_STOP_MODES,
    type RecordAndSendAction,
  } from "$lib/stores/settings";
  import { repos, activeRepo, isAutoRepoSelected } from "$lib/stores/repos";
  import { isRepoAutoSelectEnabled } from "$lib/utils/llm";
  import { overlay } from "$lib/stores/overlay";
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

  // Check if real-time transcription should be shown
  $: showRealtimeTranscript = $settings.realtime?.enabled ?? false;

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
        showRepoDropdown = false;
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

  function handleStopWith(event: MouseEvent, action: RecordAndSendAction) {
    event.stopPropagation();
    // Emit event to stop + process the recording in the main window
    emit("send-recording", { action });
  }

  function handleSetStopMode(event: MouseEvent, mode: RecordAndSendAction) {
    event.stopPropagation();
    // Handled by the main window (updates + saves settings, then re-emits settings-changed)
    emit("set-stop-mode", { mode });
  }

  // Repo dropdown (opened by clicking the repo chip, like the in-app repo picker)
  let showRepoDropdown = false;
  let repoTrigger: HTMLElement | null = null;

  function toggleRepoDropdown(event: MouseEvent) {
    event.stopPropagation();
    showRepoDropdown = !showRepoDropdown;
    setTimeout(notifyResize, 10);
  }

  function closeRepoDropdown() {
    if (!showRepoDropdown) return;
    showRepoDropdown = false;
    setTimeout(notifyResize, 10);
  }

  function handleRepoPick(event: MouseEvent, option: "auto" | string) {
    event.stopPropagation();
    showRepoDropdown = false;
    // Handled by the main window (sets auto mode / active repo, then re-emits settings-changed)
    emit("select-repo", { option });
    setTimeout(notifyResize, 10);
  }

  function handleWindowClick(event: MouseEvent) {
    if (
      showRepoDropdown &&
      repoTrigger &&
      !repoTrigger.contains(event.target as Node)
    ) {
      closeRepoDropdown();
    }
  }

  function handleCycleModel(event: MouseEvent) {
    event.stopPropagation();
    // Handled by the main window (cycles default model, then re-emits settings-changed)
    emit("cycle-model");
  }

  // Model shown on the idle chip: what a new recording would use
  $: toolbarModel =
    $settings.sdk_provider === "OpenAI"
      ? $settings.openai_model
      : $settings.default_model;

  $: stopMode = $settings.audio.record_and_send_action;

  // Repos selectable in the overlay dropdown (active repos, plus the current
  // one even if it was deactivated, so the select always shows a valid value)
  $: repoOptions = $repos.list.filter(
    (r) => r.active !== false || r.id === $activeRepo?.id
  );
  $: repoSelectValue =
    $isAutoRepoSelected && isRepoAutoSelectEnabled()
      ? "auto"
      : ($activeRepo?.id ?? "");

  const STOP_MODE_DISPLAY: Record<
    RecordAndSendAction,
    { label: string; cls: string; hoverCls: string; title: string; stopTitle: string }
  > = {
    send: {
      label: "Go",
      cls: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
      hoverCls: "hover:bg-emerald-500/30",
      title: "Stopping a recording sends it as a session",
      stopTitle: "Stop and send as a session",
    },
    draft: {
      label: "Draft",
      cls: "bg-sky-500/20 text-sky-400 border-sky-500/30",
      hoverCls: "hover:bg-sky-500/30",
      title: "Stopping a recording creates a draft session for review",
      stopTitle: "Stop and create a draft session for review",
    },
    pile: {
      label: "Pile",
      cls: "bg-amber-500/20 text-amber-400 border-amber-500/30",
      hoverCls: "hover:bg-amber-500/30",
      title: "Stopping a recording saves it to the pile for later",
      stopTitle: "Stop and save to the pile for later",
    },
  };

  const STOP_MODE_INACTIVE_CLS =
    "bg-surface text-text-muted border-transparent hover:text-text-secondary";
</script>

<svelte:window onclick={handleWindowClick} />

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

    <!-- Real-time transcript -->
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
            <button
              class="text-xs px-1.5 py-0.5 rounded cursor-pointer hover:opacity-80 transition-opacity {getModelBadgeBgColor(
                $overlay.sessionInfo.model
              )} {getModelTextColor($overlay.sessionInfo.model)}"
              onclick={handleCycleModel}
              title="Model for this recording. Click to cycle."
            >
              {getModelLabel($overlay.sessionInfo.model)}
            </button>
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
        <div class="flex items-center gap-0.5">
          {#each RECORD_STOP_MODES as mode}
            {@const modeDisplay = STOP_MODE_DISPLAY[mode]}
            <button
              class="stop-mode-btn px-1.5 py-0.5 text-xs font-medium border rounded transition-colors {mode ===
              stopMode
                ? modeDisplay.cls
                : STOP_MODE_INACTIVE_CLS}"
              onclick={(e) => handleSetStopMode(e, mode)}
              title={modeDisplay.title}
            >
              {modeDisplay.label}
            </button>
          {/each}
        </div>
        {#if toolbarModel}
          <button
            class="text-xs px-1.5 py-0.5 rounded cursor-pointer hover:opacity-80 transition-opacity {getModelBadgeBgColor(
              toolbarModel
            )} {getModelTextColor(toolbarModel)}"
            onclick={handleCycleModel}
            title="Model for new recordings. Click to cycle."
          >
            {getModelLabel(toolbarModel)}
          </button>
        {/if}
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
      {:else if $overlay.mode !== "paste"}
        <div class="flex items-center gap-2 text-xs justify-end">
          {#if repoSelectValue === "auto"}
            <button
              bind:this={repoTrigger}
              class="px-2 py-0.5 rounded bg-gradient-to-r from-purple-500 to-amber-500 text-white font-medium shadow-sm flex-shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
              onclick={toggleRepoDropdown}
              title="Repository is auto-selected. Click to choose."
              >Auto</button
            >
          {:else if $activeRepo}
            <button
              bind:this={repoTrigger}
              class="flex items-center gap-1.5 min-w-0 cursor-pointer hover:opacity-80 transition-opacity"
              onclick={toggleRepoDropdown}
              title="Active repository. Click to choose."
            >
              <RepoIcon repo={$activeRepo} size="xs" />
              <span class="text-text-secondary truncate"
                >{$activeRepo.name}</span
              >
              <svg
                class="w-3 h-3 text-text-muted flex-shrink-0 transition-transform {showRepoDropdown
                  ? 'rotate-180'
                  : ''}"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Right section: Action buttons (fixed width) -->
    {#if isRecordingActive}
      <div class="flex items-center gap-1.5 flex-shrink-0">
        {#if $overlay.mode === "session"}
          {#each RECORD_STOP_MODES as mode}
            {@const modeDisplay = STOP_MODE_DISPLAY[mode]}
            <button
              class="stop-mode-btn px-2 py-1 text-xs font-medium border rounded transition-colors {modeDisplay.cls} {modeDisplay.hoverCls}"
              onclick={(e) => handleStopWith(e, mode)}
              title={modeDisplay.stopTitle}
            >
              {modeDisplay.label}
            </button>
          {/each}
        {:else}
          <button
            class="go-btn px-2 py-1 text-xs font-medium bg-primary/20 hover:bg-primary/30 text-primary border border-primary/30 rounded transition-colors"
            onclick={(e) => handleStopWith(e, "send")}
            title="Stop and send"
          >
            Go
          </button>
        {/if}
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

  <!-- Repo dropdown panel (in-flow so the overlay window grows to fit it) -->
  {#if showRepoDropdown && $overlay.mode !== "paste" && $overlay.mode !== "inline"}
    <div
      class="mt-2 bg-surface-elevated border border-border rounded max-h-48 overflow-y-auto"
    >
      {#if isRepoAutoSelectEnabled()}
        <button
          class="w-full px-3 py-2 text-left text-xs hover:bg-border transition-colors flex items-center gap-2"
          onclick={(e) => handleRepoPick(e, "auto")}
          title="Automatically select repository based on prompt"
        >
          <span
            class="font-medium text-transparent bg-clip-text bg-gradient-to-r from-purple-500 to-amber-500"
            >Auto</span
          >
          {#if repoSelectValue === "auto"}
            <span class="ml-auto text-accent">✓</span>
          {/if}
        </button>
      {/if}
      {#each repoOptions as repo (repo.id)}
        <button
          class="w-full px-3 py-2 text-left text-xs hover:bg-border transition-colors flex items-center gap-2"
          onclick={(e) => handleRepoPick(e, repo.id ?? "")}
          title={repo.path}
        >
          <RepoIcon {repo} size="xs" />
          <span class="font-medium truncate text-text-primary">{repo.name}</span>
          {#if repo.id === repoSelectValue}
            <span class="ml-auto text-accent flex-shrink-0">✓</span>
          {/if}
        </button>
      {/each}
      {#if repoOptions.length === 0}
        <div class="px-3 py-2 text-xs text-text-muted">
          No repositories configured
        </div>
      {/if}
    </div>
  {/if}

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
