<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { goto } from '$app/navigation';
  import { get } from 'svelte/store';
  import AppHeader from '$lib/components/AppHeader.svelte';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import { settings, configLoadedOk, configLoadReport, nextRecordStopMode } from '$lib/stores/settings';
  import { pile } from '$lib/stores/pile';
  import { repos } from '$lib/stores/repos';
  import { sessions } from '$lib/stores/sessions';
  import { sdkSessions, activeSdkSessionId, activeSdkSession } from '$lib/stores/sdkSessions';
  import { startSmartQueue } from '$lib/stores/smartQueue';
  import { updater } from '$lib/stores/updater';
  import { activeSessionId } from '$lib/stores/sessions';
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
  import { isActivelyWorking } from '$lib/utils/sessionStatus';
  import { type VoiceCommandType } from '$lib/utils/voiceCommands';
  import { eventMatchesHotkey } from '$lib/utils/hotkeys';
  import { cycleModel, cycleRepo } from '$lib/utils/recordingCycles';
  import { createAndActivateNewSession, createSessionInSameRepo } from '$lib/utils/sessionCreation';
  import { selectDisplaySession } from '$lib/utils/sessionSelection';
  import { transformToDisplaySessions, getSdkSmartStatus } from '$lib/composables/useDisplaySessions.svelte';
  import { ctrlHintKeydown, ctrlHintKeyup, ctrlHintReset } from '$lib/stores/ctrlHint';

  // Composables (now layout-level — survive route changes)
  import { useHotkeyManager } from '$lib/composables/useHotkeyManager.svelte';
  import { useSessionEventHandlers } from '$lib/composables/useSessionEventHandlers.svelte';
  import { useOpenMicLifecycle } from '$lib/composables/useOpenMic.svelte';

  // Transcript processor (global service)
  import {
    handleTranscriptReady,
    handleRetryTranscription,
    handleApproveTranscription,
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
    const voskEnabled = $settings.vosk?.enabled ?? false;
    const vosk = $settings.vosk;
    const provider = vosk?.provider ?? "Vosk";
    const providerConfig =
      provider === "VoiceStreamAI" ? vosk?.voice_stream_ai
      : provider === "SherpaOnnx" ? vosk?.sherpa_onnx
      : provider === "Speaches" ? vosk?.speaches
      : provider === "Moonshine" ? vosk?.moonshine
      : vosk;
    const realtimeConfigFingerprint = JSON.stringify({
      provider,
      endpoint: providerConfig?.endpoint,
      sampleRate: providerConfig && "sample_rate" in providerConfig ? providerConfig.sample_rate : undefined,
    });
    const currentlyRecording = $isRecording;
    const currentlyListening = $isOpenMicListening;
    const currentlyPaused = $isOpenMicPaused;

    openMicLifecycle.update(openMicEnabled, voskEnabled, realtimeConfigFingerprint, currentlyRecording, currentlyListening, currentlyPaused);
  });

  // Effect to emit active session/sequence counts to the overlay
  $effect(() => {
    const allSessions = [...$sessions, ...$sdkSessions];
    const activeSessions = allSessions.filter(s => isActivelyWorking(s.status)).length;
    const activeSequences = $sequenceRunningCount;
    overlay.setActivityInfo(activeSessions, activeSequences);
  });

  // Ctrl+W close confirmation (only shown when the active session is working)
  let closeConfirm = $state<{
    show: boolean;
    sessionId: string;
    sessionType: 'pty' | 'sdk';
  }>({ show: false, sessionId: '', sessionType: 'sdk' });

  function performActiveClose(sessionId: string, sessionType: 'pty' | 'sdk') {
    if (sessionType === 'sdk') {
      void sdkSessions.closeSession(sessionId);
      if (get(activeSdkSessionId) === sessionId) activeSdkSessionId.set(null);
    } else {
      void sessions.closeSession(sessionId);
      if (get(activeSessionId) === sessionId) activeSessionId.set(null);
    }
  }

  function confirmActiveClose() {
    performActiveClose(closeConfirm.sessionId, closeConfirm.sessionType);
    closeConfirm = { show: false, sessionId: '', sessionType: 'sdk' };
  }

  function cancelActiveClose() {
    closeConfirm = { show: false, sessionId: '', sessionType: 'sdk' };
  }

  // Helper: switch to a session by ID
  function handleSwitchToSession(sessionId: string) {
    activeSdkSessionId.set(sessionId);
    activeSessionId.set(null);
    navigation.setView('sessions');
  }

  // Helper: show sessions view
  function showSessionsView() {
    navigation.setView('sessions');
  }

  function handleAppKeydown(event: KeyboardEvent): void {
    ctrlHintKeydown(event);
    if (event.repeat) return;

    // Ctrl+1..9 — jump to the Nth session in the sidebar. Uses the same transform
    // (and therefore the same order) as SessionList, which renders the number badges.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      const digitMatch = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
      if (digitMatch) {
        const ordered = transformToDisplaySessions(
          $sessions,
          $sdkSessions,
          $settings.session_sort_order,
          $sequenceExecutions
        );
        const target = ordered[Number(digitMatch[1]) - 1];
        if (target) {
          event.preventDefault();
          selectDisplaySession(target);
        }
        return;
      }
    }

    // Ctrl/Cmd+W — close the currently active session (SDK preferred, then PTY),
    // mirroring the browser "close tab" convention. Fixed binding like Ctrl+1..9.
    // Confirms first when the session is actively working (matches SessionList).
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.code === 'KeyW'
    ) {
      const sdkId = get(activeSdkSessionId);
      const ptyId = get(activeSessionId);
      if (sdkId) {
        event.preventDefault();
        const sdkSession = get(sdkSessions).find((s) => s.id === sdkId);
        const working = sdkSession
          ? isActivelyWorking(getSdkSmartStatus(sdkSession).status)
          : false;
        if (working) {
          closeConfirm = { show: true, sessionId: sdkId, sessionType: 'sdk' };
        } else {
          performActiveClose(sdkId, 'sdk');
        }
        return;
      }
      if (ptyId) {
        event.preventDefault();
        const ptySession = get(sessions).find((s) => s.id === ptyId);
        const working = ptySession ? isActivelyWorking(ptySession.status) : false;
        if (working) {
          closeConfirm = { show: true, sessionId: ptyId, sessionType: 'pty' };
        } else {
          performActiveClose(ptyId, 'pty');
        }
        return;
      }
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
    }
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

    // App update check per settings (fire-and-forget; skipped in dev builds)
    void updater.startupCheck($settings.system.update_check ?? 'Notify');

    // Load sessions
    await sessions.load();
    sessions.setupListeners();

    // Load persisted sessions if enabled
    if ($settings.session_persistence.enabled) {
      await loadSessionsFromDisk();
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

    // If there are existing sessions, show sessions view
    if (($sessions.length > 0 || $sdkSessions.length > 0) && $navigation.mainView === 'start') {
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
      onApproveTranscription: handleApproveTranscription,
      onSelectRepoForSession: handleRepoSelectionForSession,
      onFocusSdkPrompt: async () => {
        // This is a UI action that only works when the prompt input is visible.
        // Dispatch a custom event that +page.svelte can optionally handle.
        window.dispatchEvent(new CustomEvent('app:focus-sdk-prompt'));
      },
      onSwitchToSession: handleSwitchToSession,
      onCancelRecording: recordingFlow.cancelRecording,
      onSendRecording: recordingFlow.stopRecordingAndSend,
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
      onCycleStopMode: async () => {
        const current = get(settings);
        const next = nextRecordStopMode(current.audio.record_and_send_action);
        await settings.save({
          ...current,
          audio: { ...current.audio, record_and_send_action: next },
        });
      },
      onCycleRepo: cycleRepo,
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
    cleanupSequenceExecutionListeners();

    saveSessionsToDisk();
  });
</script>

<svelte:window onkeydown={handleAppKeydown} onkeyup={ctrlHintKeyup} onblur={ctrlHintReset} />

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
