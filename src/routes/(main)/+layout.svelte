<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { goto } from '$app/navigation';
  import { get } from 'svelte/store';
  import AppHeader from '$lib/components/AppHeader.svelte';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import { settings, configLoadedOk, configLoadReport } from '$lib/stores/settings';
  import { pile } from '$lib/stores/pile';
  import { repos } from '$lib/stores/repos';
  import { sdkSessions, activeSdkSessionId, activeSdkSession } from '$lib/stores/sdkSessions';
  import { startSmartQueue } from '$lib/stores/smartQueue';
  import { spareTokens, startSpareTokens } from '$lib/stores/spareTokens';
  import { updater } from '$lib/stores/updater';
  import { isRecording } from '$lib/stores/recording';
  import { isOpenMicListening, isOpenMicPaused } from '$lib/stores/openMic';
  import { overlay } from '$lib/stores/overlay';
  import { navigation } from '$lib/stores/navigation';
  import { recordingFlow } from '$lib/stores/recordingFlow';
  import {
    loadSessionsFromDisk,
    saveSessionsToDisk,
    setupAutoSave,
    setupPeriodicAutoSave,
  } from '$lib/stores/sessionPersistence';
  import {
    initSequenceExecutionListeners,
    cleanupAllListeners as cleanupSequenceExecutionListeners,
    loadExecutionHistory,
    runningCount as sequenceRunningCount,
    executions as sequenceExecutions,
  } from '$lib/stores/sequenceExecutions';
  import { loadSequences } from '$lib/stores/sequences';
  import { validation } from '$lib/stores/validation';
  import { sessionPrs } from '$lib/stores/sessionPrs';
  import { isActivelyWorking } from '$lib/utils/sessionStatus';
  import { type VoiceCommandType } from '$lib/utils/voiceCommands';
  import { eventMatchesHotkey } from '$lib/utils/hotkeys';
  import { cycleModel, selectRepo } from '$lib/utils/recordingCycles';
  import { createAndActivateNewSession, createSessionInSameRepo } from '$lib/utils/sessionCreation';
  import { selectDisplaySession } from '$lib/utils/sessionSelection';
  import { transformToDisplaySessions, getSdkSmartStatus } from '$lib/composables/useDisplaySessions.svelte';
  import { sessionRepoFilter, filterDisplaySessions } from '$lib/stores/sessionRepoFilter';
  import { sessionListGrouped, applySessionGrouping } from '$lib/stores/sessionGrouping';
  import { ctrlHintKeydown, ctrlHintKeyup, ctrlHintReset } from '$lib/stores/ctrlHint';
  import { popRecentlyClosed, recentlyClosedSessions } from '$lib/stores/recentlyClosed';
  import { archive } from '$lib/stores/archive';
  import { sessionNavHistory } from '$lib/stores/sessionNavHistory';

  // Composables (now layout-level — survive route changes)
  import { useHotkeyManager } from '$lib/composables/useHotkeyManager.svelte';
  import { useSessionEventHandlers } from '$lib/composables/useSessionEventHandlers.svelte';
  import { useOpenMicLifecycle } from '$lib/composables/useOpenMic.svelte';

  // Transcript processor (global service)
  import {
    handleTranscriptReady,
    handleRetryTranscription,
    handleRepoSelectionForSession,
    handleSendSelection,
    handlePrepareSelection,
    handleVoiceCommand,
  } from '$lib/stores/transcriptProcessor';

  // Initialize composables at layout level — they persist across route changes
  const hotkeyManager = useHotkeyManager();
  const eventHandlers = useSessionEventHandlers();
  const openMicLifecycle = useOpenMicLifecycle();

  let configReloading = $state(false);
  let configWarningsDismissed = $state(false);

  async function handleConfigReload() {
    configReloading = true;
    try {
      const report = await settings.reloadConfig();
      if (report?.loaded_ok) {
        // Startup ran against defaults while the config was broken, so rebuild
        // the whole frontend from the real config instead of patching stores.
        window.location.reload();
      }
    } finally {
      configReloading = false;
    }
  }

  // Cleanup handlers
  let cleanupAutoSave: (() => void) | null = null;
  let cleanupPeriodicSave: (() => void) | null = null;
  let cleanupSmartQueue: (() => void) | null = null;
  let cleanupSpareTokens: (() => void) | null = null;
  let cleanupUpdateChecks: (() => void) | null = null;

  // Wire the recording flow store to the hotkey manager
  recordingFlow.setHotkeyCallbacks({
    registerRecordingHotkeys: () => hotkeyManager.registerRecordingHotkeys(),
    unregisterRecordingHotkeys: () => hotkeyManager.unregisterRecordingHotkeys(),
  });

  // Effect to re-register hotkeys when hotkey bindings or enabled states change
  $effect(() => {
    const currentHotkey = $settings.hotkeys.toggle_recording;
    const enabledState = $settings.hotkeys_enabled;
    const voiceModeDisabled = $settings.system.voice_mode_disabled;
    if (hotkeyManager.checkForHotkeyChange(currentHotkey, enabledState, voiceModeDisabled)) {
      hotkeyManager.setup({
        onStartRecording: () => recordingFlow.startRecordingFromHotkey(),
        onStopAndSend: () => recordingFlow.stopRecordingFromHotkey(),
        onStopAndPaste: () => recordingFlow.handleTranscribeToInput(),
        onStopAndPile: () => recordingFlow.stopRecordingToPile(),
        onSendSelection: handleSendSelection,
        onPrepareSelection: handlePrepareSelection,
      });
    }
  });

  // Effect to manage open mic lifecycle
  $effect(() => {
    const openMicEnabled = $settings.audio.open_mic.enabled && !$settings.system.voice_mode_disabled;
    const realtimeEnabled = $settings.realtime?.enabled ?? false;
    const realtime = $settings.realtime;
    const provider = realtime?.provider ?? "Vosk";
    const providerConfig =
      provider === "VoiceStreamAI" ? realtime?.voice_stream_ai
      : provider === "SherpaOnnx" ? realtime?.sherpa_onnx
      : provider === "Speaches" ? realtime?.speaches
      : provider === "Moonshine" ? realtime?.moonshine
      : realtime;
    const realtimeConfigFingerprint = JSON.stringify({
      provider,
      endpoint: providerConfig?.endpoint,
      sampleRate: providerConfig && "sample_rate" in providerConfig ? providerConfig.sample_rate : undefined,
    });
    const currentlyRecording = $isRecording;
    const currentlyListening = $isOpenMicListening;
    const currentlyPaused = $isOpenMicPaused;

    openMicLifecycle.update(openMicEnabled, realtimeEnabled, realtimeConfigFingerprint, currentlyRecording, currentlyListening, currentlyPaused);
  });

  // Effect to emit active session/sequence counts to the overlay
  $effect(() => {
    const activeSessions = $sdkSessions.filter(s => isActivelyWorking(s.status)).length;
    const activeSequences = $sequenceRunningCount;
    overlay.setActivityInfo(activeSessions, activeSequences);
  });

  // Ctrl+W close confirmation (only shown when the active session is working)
  let closeConfirm = $state<{
    show: boolean;
    sessionId: string;
  }>({ show: false, sessionId: '' });

  function performActiveClose(sessionId: string) {
    // Was the closing session the active one? If so, advance to the next session
    // in the sidebar rather than dropping the user on an empty view — matching
    // SessionList's close behaviour. Uses the same transform/order (and repo
    // filter) as the list.
    const wasActive = get(activeSdkSessionId) === sessionId;
    const ordered = applySessionGrouping(
      filterDisplaySessions(
        transformToDisplaySessions(
          get(sdkSessions),
          get(settings).session_sort_order,
          get(sequenceExecutions)
        ),
        get(sessionRepoFilter)
      ),
      get(sessionListGrouped)
    );
    const idx = ordered.findIndex((s) => s.id === sessionId);
    let nextSession = null;
    if (wasActive && idx !== -1) {
      for (let i = idx + 1; i < ordered.length; i++) {
        if (ordered[i].id !== sessionId) { nextSession = ordered[i]; break; }
      }
      if (!nextSession) {
        for (let i = idx - 1; i >= 0; i--) {
          if (ordered[i].id !== sessionId) { nextSession = ordered[i]; break; }
        }
      }
    }

    void sdkSessions.closeSession(sessionId);

    if (wasActive) {
      if (nextSession) {
        selectDisplaySession(nextSession);
      } else if (get(activeSdkSessionId) === sessionId) {
        activeSdkSessionId.set(null);
      }
    }
  }

  function confirmActiveClose() {
    performActiveClose(closeConfirm.sessionId);
    closeConfirm = { show: false, sessionId: '' };
  }

  function cancelActiveClose() {
    closeConfirm = { show: false, sessionId: '' };
  }

  // Ctrl+Shift+T — reopen the most recently closed session (browser-tab style).
  // Pops the recently-closed stack, unarchiving entries until one succeeds
  // (skipping any that were meanwhile deleted from the archive).
  let reopeningClosed = false;
  async function reopenLastClosed() {
    if (reopeningClosed) return;
    reopeningClosed = true;
    try {
      let entry = popRecentlyClosed();
      while (entry) {
        try {
          const result = await archive.unarchiveEntry(entry.id);
          if (result) {
            navigation.setView('sessions');
            return;
          }
        } catch (error) {
          console.error('[layout] Failed to reopen closed session:', error);
        }
        // Entry was not restorable (deleted/trimmed) — try the next one.
        entry = popRecentlyClosed();
      }
    } finally {
      reopeningClosed = false;
    }
  }

  // Helper: switch to a session by ID
  function handleSwitchToSession(sessionId: string) {
    activeSdkSessionId.set(sessionId);
    navigation.setView('sessions');
  }

  // Helper: show sessions view
  function showSessionsView() {
    navigation.setView('sessions');
  }

  function handleAppKeydown(event: KeyboardEvent): void {
    ctrlHintKeydown(event);
    if (event.repeat) return;

    // Esc while recording — discard the recording (same as the overlay's
    // Discard button). Only reachable while the app is focused, since window
    // keydown events don't fire otherwise.
    if (event.key === 'Escape' && get(isRecording)) {
      event.preventDefault();
      void recordingFlow.cancelRecording();
      return;
    }

    // Ctrl+1..9 — jump to the Nth session in the sidebar. Uses the same transform
    // and repo filter (and therefore the same order) as SessionList, which
    // renders the number badges.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      const digitMatch = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
      if (digitMatch) {
        const ordered = applySessionGrouping(
          filterDisplaySessions(
            transformToDisplaySessions(
              $sdkSessions,
              $settings.session_sort_order,
              $sequenceExecutions
            ),
            $sessionRepoFilter
          ),
          $sessionListGrouped
        );
        const target = ordered[Number(digitMatch[1]) - 1];
        if (target) {
          event.preventDefault();
          selectDisplaySession(target);
        }
        return;
      }
    }

    // Ctrl/Cmd+W — close the currently active session, mirroring the browser
    // "close tab" convention. Fixed binding like Ctrl+1..9.
    // Confirms first when the session is actively working (matches SessionList).
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.code === 'KeyW'
    ) {
      const sdkId = get(activeSdkSessionId);
      if (sdkId) {
        event.preventDefault();
        const sdkSession = get(sdkSessions).find((s) => s.id === sdkId);
        const working = sdkSession
          ? isActivelyWorking(getSdkSmartStatus(sdkSession).status)
          : false;
        if (working) {
          closeConfirm = { show: true, sessionId: sdkId };
        } else {
          performActiveClose(sdkId);
        }
        return;
      }
    }

    // Ctrl/Cmd+Shift+T — reopen the most recently closed session.
    if (
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      !event.altKey &&
      event.code === 'KeyT'
    ) {
      if (get(recentlyClosedSessions).length > 0) {
        event.preventDefault();
        void reopenLastClosed();
      }
      return;
    }

    if (
      $settings.hotkeys_enabled.new_session &&
      eventMatchesHotkey(event, $settings.hotkeys.new_session)
    ) {
      event.preventDefault();
      void createAndActivateNewSession();
      return;
    }

    if (
      $settings.hotkeys_enabled.new_session_same_repo &&
      eventMatchesHotkey(event, $settings.hotkeys.new_session_same_repo)
    ) {
      event.preventDefault();
      void createSessionInSameRepo();
      return;
    }

    // Alt+Left / Alt+Right — browser-style back/forward through viewed sessions,
    // the keyboard equivalent of the mouse back/forward buttons below.
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (event.code === 'ArrowLeft') {
        if (sessionNavHistory.goBack()) event.preventDefault();
        return;
      }
      if (event.code === 'ArrowRight') {
        if (sessionNavHistory.goForward()) event.preventDefault();
        return;
      }
    }
  }

  // Mouse back (button 3) / forward (button 4) → browser-style session history.
  // Handle on mousedown so the WebView never acts on its own history, and mirror
  // the preventDefault onto mouseup/auxclick to fully suppress native navigation.
  function handleNavMouseButton(event: MouseEvent): void {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    if (event.type !== 'mousedown') return;
    if (event.button === 3) sessionNavHistory.goBack();
    else sessionNavHistory.goForward();
  }

  onMount(async () => {
    // Load settings and repos before child routes render with defaults
    await settings.load();
    await repos.load();

    // Apply saved theme
    document.documentElement.setAttribute('data-theme', $settings.theme);

    // First-run onboarding: bail out to the chromeless wizard before anything
    // else initializes. Finishing the wizard navigates back to '/', which
    // remounts this layout and runs the full startup path.
    if (!$settings.onboarding_completed) {
      goto('/onboarding');
      return;
    }

    // App update check per settings (fire-and-forget; skipped in dev builds),
    // then keep polling hourly so long-running sessions pick up new releases.
    const updateCheckMode = $settings.system.update_check ?? 'Notify';
    void updater.startupCheck(updateCheckMode);
    cleanupUpdateChecks = updater.startPeriodicChecks(updateCheckMode);

    // Load persisted sessions if enabled
    if ($settings.session_persistence.enabled) {
      await loadSessionsFromDisk();
      // Restore per-session dock state saved with the sessions: the full
      // validation run (panel survives restart, reattaching to the backend if it
      // still has the run) and the PR panel's open flag.
      await validation.rehydrateFromSessions();
      sessionPrs.rehydrateFromSessions();
    }

    // Load the recording pile
    await pile.load();

    // Load sequences
    await initSequenceExecutionListeners();
    await loadSequences();
    await loadExecutionHistory();

    // Setup auto-save
    cleanupAutoSave = setupAutoSave();
    cleanupPeriodicSave = setupPeriodicAutoSave();

    // Start the Smart Queue drain driver (after sessions are restored from disk so
    // any queued/rate-limited sessions whose window already reset dispatch promptly).
    cleanupSmartQueue = startSmartQueue();

    // Spare Tokens: load persisted auto state, then start the auto driver
    // (enabled gating happens inside each evaluation).
    await spareTokens.load();
    cleanupSpareTokens = startSpareTokens();

    // If there are existing sessions, show sessions view
    if ($sdkSessions.length > 0 && $navigation.mainView === 'start') {
      navigation.setView('sessions');
    }

    // Initialize event handlers
    eventHandlers.init({
      onShowSessions: showSessionsView,
      onOpenSettings: (tab) => {
        if (tab === 'repos') {
          goto('/');
          navigation.showRepositoryAdd();
          return;
        }
        goto(tab ? `/settings?tab=${tab}` : '/settings');
      },
      onCloseSettings: showSessionsView,
      onRetryTranscription: handleRetryTranscription,
      onSelectRepoForSession: handleRepoSelectionForSession,
      onFocusSdkPrompt: async () => {
        // This is a UI action that only works when the prompt input is visible.
        // Dispatch a custom event that +page.svelte can optionally handle.
        window.dispatchEvent(new CustomEvent('app:focus-sdk-prompt'));
      },
      onSwitchToSession: handleSwitchToSession,
      onCancelRecording: recordingFlow.cancelRecording,
      onSendRecording: (action) =>
        action === 'pile'
          ? recordingFlow.stopRecordingToPile()
          : recordingFlow.stopRecordingFromHotkey(action ?? 'send'),
      onStartRecordingFromOpenMic: recordingFlow.startRecordingFromOpenMic,
      onVoiceCommand: (
        commandType: VoiceCommandType,
        cleanedTranscript: string,
        originalTranscript: string
      ) =>
        handleVoiceCommand(
          commandType,
          cleanedTranscript,
          originalTranscript,
          recordingFlow.getPendingSessionId,
          recordingFlow.clearPendingSessionId,
          recordingFlow.cleanupAudioVisualizationListener,
        ),
      onUnregisterRecordingHotkeys: () => hotkeyManager.unregisterRecordingHotkeys(),
      onSetStopMode: async (mode) => {
        const current = get(settings);
        if (current.audio.record_and_send_action === mode) return;
        await settings.save({
          ...current,
          audio: { ...current.audio, record_and_send_action: mode },
        });
      },
      onSelectRepo: selectRepo,
      onCycleModel: cycleModel,
    });

    // Setup event listeners
    await eventHandlers.setup();

    // Setup hotkeys
    await hotkeyManager.setup({
      onStartRecording: () => recordingFlow.startRecordingFromHotkey(),
      onStopAndSend: () => recordingFlow.stopRecordingFromHotkey(),
      onStopAndPaste: () => recordingFlow.handleTranscribeToInput(),
      onStopAndPile: () => recordingFlow.stopRecordingToPile(),
      onSendSelection: handleSendSelection,
      onPrepareSelection: handlePrepareSelection,
    });
  });

  onDestroy(() => {
    eventHandlers.cleanup();
    openMicLifecycle.cleanup();
    recordingFlow.cleanup();

    // Only cleanup OS-level hotkeys during HMR or window close.
    // Since the layout persists across in-app navigation, this is primarily
    // for dev-mode HMR.
    hotkeyManager.cleanup();

    if (cleanupAutoSave) cleanupAutoSave();
    if (cleanupPeriodicSave) cleanupPeriodicSave();
    if (cleanupSmartQueue) cleanupSmartQueue();
    if (cleanupSpareTokens) cleanupSpareTokens();
    if (cleanupUpdateChecks) cleanupUpdateChecks();
    cleanupSequenceExecutionListeners();

    saveSessionsToDisk();
  });
</script>

<svelte:window
  onkeydown={handleAppKeydown}
  onkeyup={ctrlHintKeyup}
  onblur={ctrlHintReset}
  onmousedown={handleNavMouseButton}
  onmouseup={handleNavMouseButton}
  onauxclick={handleNavMouseButton}
/>

<div class="app-container h-screen flex flex-col bg-background">

  {#if !$configLoadedOk}
    <div class="config-warning bg-red-900/80 text-red-100 px-4 py-2 text-sm border-b border-red-700">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="font-bold">Warning:</span>
        <span>Config failed to parse and loaded defaults. Saves are blocked to protect your data. Fix your config file, then reload it here.</span>
        <button
          class="underline hover:text-white cursor-pointer bg-transparent border-none text-red-200 text-sm p-0 disabled:opacity-50"
          disabled={configReloading}
          onclick={handleConfigReload}
        >{configReloading ? 'Reloading…' : 'Reload config'}</button>
        <span class="text-red-400">|</span>
        <button
          class="underline hover:text-white cursor-pointer bg-transparent border-none text-red-200 text-sm p-0"
          onclick={() => invoke('open_config_file')}
        >Open config</button>
        <span class="text-red-400">|</span>
        <button
          class="underline hover:text-white cursor-pointer bg-transparent border-none text-red-200 text-sm p-0"
          onclick={() => invoke('open_config_folder')}
        >Open folder</button>
      </div>
      {#if $configLoadReport.error}
        <div class="mt-1 font-mono text-xs text-red-300 break-all">{$configLoadReport.error}</div>
      {/if}
    </div>
  {:else if $configLoadReport.warnings.length > 0 && !configWarningsDismissed}
    <div class="config-warning bg-amber-900/70 text-amber-100 px-4 py-2 text-sm border-b border-amber-700">
      <div class="flex items-start gap-2">
        <span class="font-bold shrink-0">Config notice:</span>
        <div class="flex-1 min-w-0">
          {#each $configLoadReport.warnings as warning (warning)}
            <div class="break-words">{warning}</div>
          {/each}
        </div>
        <button
          class="underline hover:text-white cursor-pointer bg-transparent border-none text-amber-200 text-sm p-0 shrink-0"
          onclick={() => (configWarningsDismissed = true)}
        >Dismiss</button>
      </div>
    </div>
  {/if}

  <AppHeader />

  <slot />
</div>

<ConfirmDialog
  show={closeConfirm.show}
  title="Close session?"
  message="This session is still working. Closing it will stop the current work. Are you sure?"
  confirmLabel="Close"
  cancelLabel="Cancel"
  variant="danger"
  onconfirm={confirmActiveClose}
  oncancel={cancelActiveClose}
/>

<style>
  .app-container {
    user-select: none;
  }
</style>
