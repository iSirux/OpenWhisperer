/**
 * Composable for managing session-related event handlers
 * Centralizes window and Tauri event listener setup/teardown
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { recording, isRecording } from '$lib/stores/recording';
import { sdkSessions } from '$lib/stores/sdkSessions';
import { settings } from '$lib/stores/settings';
import { overlay } from '$lib/stores/overlay';
import { processVoiceCommand, type VoiceCommandType } from '$lib/utils/voiceCommands';
import { playOpenMicTriggerSound, playVoiceCommandSound } from '$lib/utils/sound';

export interface EventHandlerCallbacks {
  /** Show the sessions view */
  onShowSessions: () => void;
  /** Open settings with optional tab */
  onOpenSettings: (tab?: string) => void;
  /** Close settings */
  onCloseSettings: () => void;
  /** Retry transcription for a session */
  onRetryTranscription: (sessionId: string) => Promise<void>;
  /** Approve transcription for a session */
  onApproveTranscription: (sessionId: string, editedPrompt?: string) => Promise<void>;
  /** Select repo for a session */
  onSelectRepoForSession: (sessionId: string, repoIndex: number) => Promise<void>;
  /** Focus the SDK prompt input */
  onFocusSdkPrompt: () => Promise<void>;
  /** Switch to a specific session */
  onSwitchToSession: (sessionId: string) => void;
  /** Cancel the current recording */
  onCancelRecording: () => Promise<void>;
  /** Send the current recording (stop and process) */
  onSendRecording: () => Promise<void>;
  /** Start recording from open mic */
  onStartRecordingFromOpenMic: () => Promise<void>;
  /** Handle voice command (stop recording and process) */
  onVoiceCommand: (
    commandType: VoiceCommandType,
    cleanedTranscript: string,
    originalTranscript: string
  ) => Promise<void>;
  /** Unregister recording hotkeys */
  onUnregisterRecordingHotkeys: () => Promise<void>;
  /** Launch a prepared session */
  onLaunchPrepared?: (sessionId: string, editedPrompt?: string) => Promise<void>;
}

export function useSessionEventHandlers() {
  let callbacks: EventHandlerCallbacks | null = null;
  let unlistenDiscardRecording: UnlistenFn | null = null;
  let unlistenSendRecording: UnlistenFn | null = null;
  let unlistenOpenMicTriggered: UnlistenFn | null = null;
  let unlistenVoiceCommandTriggered: UnlistenFn | null = null;

  // Window event handlers
  function handleShowSessions() {
    callbacks?.onShowSessions();
  }

  function handleOpenSettings(event: Event) {
    const customEvent = event as CustomEvent<{ tab: string }>;
    callbacks?.onOpenSettings(customEvent.detail?.tab);
  }

  function handleCloseSettings() {
    callbacks?.onCloseSettings();
  }

  async function handleRetryTranscription(event: Event) {
    const customEvent = event as CustomEvent<{ sessionId: string }>;
    await callbacks?.onRetryTranscription(customEvent.detail.sessionId);
  }

  async function handleApproveTranscription(event: Event) {
    const customEvent = event as CustomEvent<{ sessionId: string; editedPrompt?: string }>;
    await callbacks?.onApproveTranscription(
      customEvent.detail.sessionId,
      customEvent.detail.editedPrompt
    );
  }

  async function handleSelectRepoForSession(event: Event) {
    const customEvent = event as CustomEvent<{ sessionId: string; repoIndex: number }>;
    await callbacks?.onSelectRepoForSession(
      customEvent.detail.sessionId,
      customEvent.detail.repoIndex
    );
  }

  async function handleFocusSdkPrompt() {
    await callbacks?.onFocusSdkPrompt();
  }

  function handleSwitchToSession(event: Event) {
    const customEvent = event as CustomEvent<{ sessionId: string }>;
    callbacks?.onSwitchToSession(customEvent.detail.sessionId);
  }

  async function handleLaunchPrepared(event: Event) {
    const customEvent = event as CustomEvent<{ sessionId: string; editedPrompt?: string }>;
    await callbacks?.onLaunchPrepared?.(customEvent.detail.sessionId, customEvent.detail.editedPrompt);
  }

  /**
   * Initialize event handlers with callbacks
   */
  function init(cb: EventHandlerCallbacks) {
    callbacks = cb;
  }

  /**
   * Set up all window event listeners
   */
  function setupWindowListeners() {
    window.addEventListener('switch-to-sessions', handleShowSessions);
    window.addEventListener('open-settings', handleOpenSettings);
    window.addEventListener('close-settings', handleCloseSettings);
    window.addEventListener('retry-transcription', handleRetryTranscription);
    window.addEventListener('approve-transcription', handleApproveTranscription);
    window.addEventListener('select-repo-for-session', handleSelectRepoForSession);
    window.addEventListener('focus-sdk-prompt', handleFocusSdkPrompt);
    window.addEventListener('switch-to-session', handleSwitchToSession);
    window.addEventListener('launch-prepared', handleLaunchPrepared);
  }

  /**
   * Remove all window event listeners
   */
  function removeWindowListeners() {
    window.removeEventListener('switch-to-sessions', handleShowSessions);
    window.removeEventListener('open-settings', handleOpenSettings);
    window.removeEventListener('close-settings', handleCloseSettings);
    window.removeEventListener('retry-transcription', handleRetryTranscription);
    window.removeEventListener('approve-transcription', handleApproveTranscription);
    window.removeEventListener('select-repo-for-session', handleSelectRepoForSession);
    window.removeEventListener('focus-sdk-prompt', handleFocusSdkPrompt);
    window.removeEventListener('switch-to-session', handleSwitchToSession);
    window.removeEventListener('launch-prepared', handleLaunchPrepared);
  }

  /**
   * Set up Tauri event listeners
   */
  async function setupTauriListeners() {
    // Listen for discard-recording events from overlay
    unlistenDiscardRecording = await listen('discard-recording', async () => {
      console.log('[Recording] Discard recording event received');
      await callbacks?.onCancelRecording();
    });

    // Listen for send-recording events from overlay (Go button)
    unlistenSendRecording = await listen('send-recording', async () => {
      console.log('[Recording] Send recording event received');
      await callbacks?.onSendRecording();
    });

    // Listen for open-mic-triggered events
    unlistenOpenMicTriggered = await listen<{ command: string }>(
      'open-mic-triggered',
      async (event) => {
        console.log('[open-mic] Wake command triggered:', event.payload?.command);

        if (get(isRecording)) {
          console.log('[open-mic] Already recording, ignoring trigger');
          return;
        }

        const currentSettings = get(settings);
        if (currentSettings.audio.play_sound_on_open_mic_trigger) {
          playOpenMicTriggerSound();
        }

        await callbacks?.onStartRecordingFromOpenMic();
      }
    );

    // Listen for voice-command-triggered events
    unlistenVoiceCommandTriggered = await listen<{
      command: string;
      cleanedTranscript: string;
      originalTranscript: string;
      commandType: VoiceCommandType;
    }>('voice-command-triggered', async (event) => {
      const commandType = event.payload?.commandType || 'send';
      console.log('[voice-command] Triggered:', event.payload?.command, 'type:', commandType);

      if (!get(isRecording)) {
        console.log('[voice-command] Not recording, ignoring trigger');
        return;
      }

      const currentSettings = get(settings);
      if (currentSettings.audio.play_sound_on_voice_command) {
        playVoiceCommandSound();
      }

      await callbacks?.onUnregisterRecordingHotkeys();
      await overlay.hide();
      overlay.clearSessionInfo();

      await callbacks?.onVoiceCommand(
        commandType,
        event.payload.cleanedTranscript,
        event.payload.originalTranscript
      );
    });
  }

  /**
   * Remove Tauri event listeners
   */
  function removeTauriListeners() {
    if (unlistenDiscardRecording) {
      unlistenDiscardRecording();
      unlistenDiscardRecording = null;
    }

    if (unlistenSendRecording) {
      unlistenSendRecording();
      unlistenSendRecording = null;
    }

    if (unlistenOpenMicTriggered) {
      unlistenOpenMicTriggered();
      unlistenOpenMicTriggered = null;
    }

    if (unlistenVoiceCommandTriggered) {
      unlistenVoiceCommandTriggered();
      unlistenVoiceCommandTriggered = null;
    }
  }

  /**
   * Set up all event listeners
   */
  async function setup() {
    setupWindowListeners();
    await setupTauriListeners();
  }

  /**
   * Clean up all event listeners
   */
  function cleanup() {
    removeWindowListeners();
    removeTauriListeners();
  }

  return {
    init,
    setup,
    cleanup,
    setupWindowListeners,
    removeWindowListeners,
    setupTauriListeners,
    removeTauriListeners,
  };
}
