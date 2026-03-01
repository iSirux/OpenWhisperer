<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { open } from '@tauri-apps/plugin-shell';
  import { goto } from '$app/navigation';
  import { get } from 'svelte/store';
  import AppHeader from '$lib/components/AppHeader.svelte';
  import { settings, configLoadedOk } from '$lib/stores/settings';
  import { repos } from '$lib/stores/repos';
  import { sessions } from '$lib/stores/sessions';
  import { sdkSessions, activeSdkSessionId, activeSdkSession } from '$lib/stores/sdkSessions';
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
  } from '$lib/stores/sequenceExecutions';
  import { loadSequences } from '$lib/stores/sequences';
  import { isActivelyWorking } from '$lib/utils/sessionStatus';
  import { type VoiceCommandType } from '$lib/utils/voiceCommands';
  import { eventMatchesHotkey } from '$lib/utils/hotkeys';
  import { createAndActivateNewSession } from '$lib/utils/sessionCreation';

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
    handleLaunchPrepared,
    handleSendSelection,
    handlePrepareSelection,
    handleVoiceCommand,
  } from '$lib/stores/transcriptProcessor';

  // Initialize composables at layout level — they persist across route changes
  const hotkeyManager = useHotkeyManager();
  const eventHandlers = useSessionEventHandlers();
  const openMicLifecycle = useOpenMicLifecycle();

  let configFilePath = $state<string>('');
  let configDirPath = $state<string>('');

  // Cleanup handlers
  let cleanupAutoSave: (() => void) | null = null;
  let cleanupPeriodicSave: (() => void) | null = null;

  // Wire the recording flow store to the hotkey manager
  recordingFlow.setHotkeyCallbacks({
    registerRecordingHotkeys: () => hotkeyManager.registerRecordingHotkeys(),
    unregisterRecordingHotkeys: () => hotkeyManager.unregisterRecordingHotkeys(),
  });

  // Effect to re-register hotkeys when hotkey bindings or enabled states change
  $effect(() => {
    const currentHotkey = $settings.hotkeys.toggle_recording;
    const enabledState = $settings.hotkeys_enabled;
    if (hotkeyManager.checkForHotkeyChange(currentHotkey, enabledState)) {
      hotkeyManager.setup({
        onStartRecording: () => recordingFlow.startRecordingFromHotkey(),
        onStopAndSend: () => recordingFlow.stopRecordingFromHotkey(),
        onStopAndPaste: () => recordingFlow.handleTranscribeToInput(),
        onStartNoteRecording: () => recordingFlow.startRecordingForNoteMode(),
        onSendSelection: handleSendSelection,
        onPrepareSelection: handlePrepareSelection,
      });
    }
  });

  // Effect to manage open mic lifecycle
  $effect(() => {
    const openMicEnabled = $settings.audio.open_mic.enabled;
    const voskEnabled = $settings.vosk?.enabled ?? false;
    const currentlyRecording = $isRecording;
    const currentlyListening = $isOpenMicListening;
    const currentlyPaused = $isOpenMicPaused;

    openMicLifecycle.update(openMicEnabled, voskEnabled, currentlyRecording, currentlyListening, currentlyPaused);
  });

  // Effect to emit active session/sequence counts to the overlay
  $effect(() => {
    const allSessions = [...$sessions, ...$sdkSessions];
    const activeSessions = allSessions.filter(s => isActivelyWorking(s.status)).length;
    const activeSequences = $sequenceRunningCount;
    overlay.setActivityInfo(activeSessions, activeSequences);
  });

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
    if (event.repeat) return;
    if (!$settings.hotkeys_enabled.new_session) return;
    if (!eventMatchesHotkey(event, $settings.hotkeys.new_session)) return;

    event.preventDefault();
    void createAndActivateNewSession();
  }

  onMount(async () => {
    // Load settings and repos before child routes render with defaults
    await settings.load();
    await repos.load();

    // Apply saved theme
    document.documentElement.setAttribute('data-theme', $settings.theme);

    try {
      const [filePath, dirPath] = await invoke<[string, string]>('get_config_paths');
      configFilePath = filePath;
      configDirPath = dirPath;
    } catch { /* non-critical */ }

    // Load sessions
    await sessions.load();
    sessions.setupListeners();

    // Load persisted sessions if enabled
    if ($settings.session_persistence.enabled) {
      await loadSessionsFromDisk();
    }

    // Load sequences
    await initSequenceExecutionListeners();
    await loadSequences();
    await loadExecutionHistory();

    // Setup auto-save
    cleanupAutoSave = setupAutoSave();
    cleanupPeriodicSave = setupPeriodicAutoSave();

    // If there are existing sessions, show sessions view
    if (($sessions.length > 0 || $sdkSessions.length > 0) && $navigation.mainView === 'start') {
      navigation.setView('sessions');
    }

    // Initialize event handlers
    eventHandlers.init({
      onShowSessions: showSessionsView,
      onOpenSettings: (tab) => goto(tab ? `/settings?tab=${tab}` : '/settings'),
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
      onSendRecording: recordingFlow.stopRecordingFromHotkey,
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
      onLaunchPrepared: handleLaunchPrepared,
    });

    // Setup event listeners
    await eventHandlers.setup();

    // Setup hotkeys
    await hotkeyManager.setup({
      onStartRecording: () => recordingFlow.startRecordingFromHotkey(),
      onStopAndSend: () => recordingFlow.stopRecordingFromHotkey(),
      onStopAndPaste: () => recordingFlow.handleTranscribeToInput(),
      onStartNoteRecording: () => recordingFlow.startRecordingForNoteMode(),
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
    cleanupSequenceExecutionListeners();

    saveSessionsToDisk();
  });
</script>

<svelte:window onkeydown={handleAppKeydown} />

<div class="app-container h-screen flex flex-col bg-background">

  {#if !$configLoadedOk}
    <div class="config-warning bg-red-900/80 text-red-100 px-4 py-2 text-sm flex items-center gap-2 border-b border-red-700">
      <span class="font-bold">Warning:</span>
      <span>Config failed to parse and loaded defaults. Saves are blocked to protect your data. Fix or delete your config file to resume normal operation.</span>
      {#if configFilePath}
        <button
          class="underline hover:text-white cursor-pointer bg-transparent border-none text-red-200 text-sm p-0"
          onclick={() => invoke('open_config_file')}
        >Open config</button>
        <span class="text-red-400">|</span>
        <button
          class="underline hover:text-white cursor-pointer bg-transparent border-none text-red-200 text-sm p-0"
          onclick={() => open(configDirPath)}
        >Open folder</button>
      {/if}
    </div>
  {/if}

  <AppHeader />

  <slot />
</div>

<style>
  .app-container {
    user-select: none;
  }
</style>
