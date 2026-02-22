/**
 * Composable for managing the recording flow
 * Handles starting/stopping recordings, pending transcription sessions,
 * audio visualization, and overlay integration
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { get } from 'svelte/store';
import { recording, isRecording } from '$lib/stores/recording';
import { sdkSessions, settingsToStoreEffort } from '$lib/stores/sdkSessions';
import { settings, activeRepo, getEffectiveTerminalMode } from '$lib/stores/settings';
import { overlay } from '$lib/stores/overlay';
import { openMic } from '$lib/stores/openMic';
import { navigation } from '$lib/stores/navigation';
import { isRecordingForNewSession as headerRecordingStore } from '$lib/stores/headerRecording';
import { DEFAULT_OPENAI_MODEL_ID, type SdkProvider } from '$lib/utils/models';

export interface RecordingFlowCallbacks {
  /** Called when a recording stops with transcript ready to process */
  onTranscriptReady: (
    transcript: string,
    pendingSessionId: string | null,
    voskTranscript?: string,
    isNoteMode?: boolean
  ) => Promise<void>;
  /** Called to register recording-only hotkeys */
  onRegisterRecordingHotkeys: () => Promise<void>;
  /** Called to unregister recording-only hotkeys */
  onUnregisterRecordingHotkeys: () => Promise<void>;
}

export function useRecordingFlow() {
  // State
  let isRecordingForNewSession = $state(false);
  let isRecordingForSetup = $state(false);
  let isRecordingForNoteMode = $state(false);
  let wasAppFocusedOnRecordStart = true;
  let pendingTranscriptionSessionId: string | null = null;
  let unlistenAudioVisualization: UnlistenFn | null = null;

  // Sync isRecordingForNewSession to the header store so AppHeader (in the layout) can read it
  $effect(() => {
    headerRecordingStore.set(isRecordingForNewSession);
  });

  // Stored callbacks
  let callbacks: RecordingFlowCallbacks | null = null;

  /**
   * Initialize the recording flow with callbacks
   */
  function init(cb: RecordingFlowCallbacks) {
    callbacks = cb;
  }

  /**
   * Get the current pending transcription session ID
   */
  function getPendingSessionId(): string | null {
    return pendingTranscriptionSessionId;
  }

  /**
   * Clear the pending transcription session ID
   */
  function clearPendingSessionId() {
    pendingTranscriptionSessionId = null;
  }

  /**
   * Set up audio visualization listener for a pending session
   */
  async function setupAudioVisualizationListener() {
    if (unlistenAudioVisualization) {
      unlistenAudioVisualization();
      unlistenAudioVisualization = null;
    }

    unlistenAudioVisualization = await listen<{ data: number[] | null }>(
      'audio-visualization',
      (event) => {
        if (pendingTranscriptionSessionId && event.payload.data) {
          sdkSessions.addAudioVisualizationSnapshot(
            pendingTranscriptionSessionId,
            event.payload.data
          );
        }
      }
    );
  }

  /**
   * Clean up audio visualization listener
   */
  function cleanupAudioVisualizationListener() {
    if (unlistenAudioVisualization) {
      unlistenAudioVisualization();
      unlistenAudioVisualization = null;
    }
  }

  /**
   * Common setup for starting a recording
   */
  async function prepareRecording(): Promise<{
    repoPath: string;
    provider: SdkProvider;
    model: string;
    effortLevel: ReturnType<typeof settingsToStoreEffort>;
    branch: string | null;
  }> {
    const currentSettings = get(settings);
    const currentActiveRepo = get(activeRepo);
    const repoPath = currentActiveRepo?.path || '.';
    const provider: SdkProvider = currentSettings.sdk_provider === 'OpenAI' ? 'openai' : 'claude';
    const model = provider === 'openai'
      ? (currentSettings.openai_model || DEFAULT_OPENAI_MODEL_ID)
      : currentSettings.default_model;
    const effortLevel = settingsToStoreEffort(currentSettings.default_effort_level);

    // Get current git branch for overlay display
    let branch: string | null = null;
    try {
      branch = await invoke<string>('get_git_branch', { repoPath });
    } catch (e) {
      console.error('Failed to get git branch:', e);
    }

    return { repoPath, provider, model, effortLevel, branch };
  }

  /**
   * Create a pending transcription session (SDK mode only)
   */
  function createPendingSession(
    model: string,
    effortLevel: ReturnType<typeof settingsToStoreEffort>,
    provider: SdkProvider
  ): string {
    const sessionId = sdkSessions.createPendingTranscriptionSession(model, effortLevel, provider);
    pendingTranscriptionSessionId = sessionId;
    return sessionId;
  }

  /**
   * Start recording for a new session (header button)
   */
  async function startRecordingNewSession() {
    if (get(isRecording)) return;
    isRecordingForNewSession = true;

    // Stop open mic to avoid two Vosk sessions running simultaneously
    await openMic.stop();

    const { provider, model, effortLevel, branch } = await prepareRecording();

    // Set overlay info
    overlay.setMode('session');
    overlay.setSessionInfo(branch, model, false);

    // Create pending transcription session immediately (SDK mode only)
    const currentSettings = get(settings);
    if (getEffectiveTerminalMode(currentSettings) === 'Sdk') {
      const sessionId = createPendingSession(model, effortLevel, provider);
      sdkSessions.selectSession(sessionId);
      navigation.setView('sessions');

      await setupAudioVisualizationListener();
    }

    await recording.startRecording(currentSettings.audio.device_id || undefined);

    // Register hotkeys now that we're recording
    await callbacks?.onRegisterRecordingHotkeys();

    // Show overlay
    await overlay.show();
  }

  /**
   * Stop recording for a new session
   */
  async function stopRecordingNewSession() {
    if (!get(isRecording)) return;

    isRecordingForNewSession = false;

    // Unregister recording-only hotkeys
    await callbacks?.onUnregisterRecordingHotkeys();

    // Hide overlay immediately
    await overlay.hide();
    overlay.clearSessionInfo();

    // Clean up audio visualization
    cleanupAudioVisualizationListener();

    // Update pending session to transcribing status
    const sessionIdToProcess = pendingTranscriptionSessionId;
    if (sessionIdToProcess) {
      sdkSessions.updatePendingTranscription(sessionIdToProcess, { status: 'transcribing' });
    }

    // Capture Vosk transcript before stopping
    const capturedVoskTranscript = get(recording).realtimeTranscript;

    // Stop recording
    recording
      .stopRecording(true)
      .then(async (transcript) => {
        // Store audio data for retry capability
        if (sessionIdToProcess) {
          const audioData = get(recording).audioData;
          if (audioData) {
            sdkSessions.storeAudioData(sessionIdToProcess, audioData);
          }
        }

        if (transcript) {
          await callbacks?.onTranscriptReady(transcript, sessionIdToProcess, capturedVoskTranscript);
        } else if (sessionIdToProcess) {
          sdkSessions.updatePendingTranscription(sessionIdToProcess, {
            transcriptionError: 'No transcription returned',
          });
        }

        // Only clear if still the same session
        if (pendingTranscriptionSessionId === sessionIdToProcess) {
          pendingTranscriptionSessionId = null;
        }
      })
      .catch((error) => {
        if (sessionIdToProcess) {
          const audioData = get(recording).audioData;
          if (audioData) {
            sdkSessions.storeAudioData(sessionIdToProcess, audioData);
          }
          sdkSessions.updatePendingTranscription(sessionIdToProcess, {
            transcriptionError: error?.message || 'Transcription failed',
          });
        }
        if (pendingTranscriptionSessionId === sessionIdToProcess) {
          pendingTranscriptionSessionId = null;
        }
      });
  }

  /**
   * Start recording from hotkey (standard toggle)
   */
  async function startRecordingFromHotkey() {
    if (get(isRecording)) return;

    // Stop open mic
    await openMic.stop();

    // Check if main window is focused
    const mainWindow = getCurrentWindow();
    wasAppFocusedOnRecordStart = await mainWindow.isFocused();

    const { provider, model, effortLevel, branch } = await prepareRecording();

    // Set overlay info
    overlay.setMode('session');
    overlay.setSessionInfo(branch, model, false);

    // Create pending transcription session (SDK mode only)
    const currentSettings = get(settings);
    if (getEffectiveTerminalMode(currentSettings) === 'Sdk') {
      createPendingSession(model, effortLevel, provider);
      await setupAudioVisualizationListener();
    }

    await recording.startRecording(currentSettings.audio.device_id || undefined);

    // Register recording hotkeys
    await callbacks?.onRegisterRecordingHotkeys();

    // Show overlay if app is not focused, or if show_when_focused is enabled
    if (!wasAppFocusedOnRecordStart || currentSettings.overlay.show_when_focused) {
      await overlay.show();
    }
  }

  /**
   * Stop recording from hotkey (standard toggle)
   */
  async function stopRecordingFromHotkey() {
    // If we're in note mode, delegate to note mode stop handler
    if (isRecordingForNoteMode) {
      await stopRecordingForNoteMode();
      return;
    }

    // Unregister recording hotkeys
    await callbacks?.onUnregisterRecordingHotkeys();

    // Hide overlay
    await overlay.hide();
    overlay.clearSessionInfo();

    // Clean up audio visualization
    cleanupAudioVisualizationListener();

    // Update pending session status
    const sessionIdToProcess = pendingTranscriptionSessionId;
    if (sessionIdToProcess) {
      sdkSessions.updatePendingTranscription(sessionIdToProcess, { status: 'transcribing' });
    }

    // Capture Vosk transcript
    const capturedVoskTranscript = get(recording).realtimeTranscript;

    // Stop recording (async - don't await)
    recording
      .stopRecording()
      .then(async (transcript) => {
        if (sessionIdToProcess) {
          const audioData = get(recording).audioData;
          if (audioData) {
            sdkSessions.storeAudioData(sessionIdToProcess, audioData);
          }
        }

        if (transcript) {
          await callbacks?.onTranscriptReady(transcript, sessionIdToProcess, capturedVoskTranscript);
        } else if (sessionIdToProcess) {
          sdkSessions.updatePendingTranscription(sessionIdToProcess, {
            transcriptionError: 'No transcription returned',
          });
        }

        if (pendingTranscriptionSessionId === sessionIdToProcess) {
          pendingTranscriptionSessionId = null;
        }
      })
      .catch((error) => {
        if (sessionIdToProcess) {
          const audioData = get(recording).audioData;
          if (audioData) {
            sdkSessions.storeAudioData(sessionIdToProcess, audioData);
          }
          sdkSessions.updatePendingTranscription(sessionIdToProcess, {
            transcriptionError: error?.message || 'Transcription failed',
          });
        }
        if (pendingTranscriptionSessionId === sessionIdToProcess) {
          pendingTranscriptionSessionId = null;
        }
      });
  }

  /**
   * Start recording from open mic wake command
   */
  async function startRecordingFromOpenMic() {
    if (get(isRecording)) return;

    // Stop open mic while recording
    await openMic.stop();

    // Check focus
    const mainWindow = getCurrentWindow();
    wasAppFocusedOnRecordStart = await mainWindow.isFocused();

    const { provider, model, effortLevel, branch } = await prepareRecording();

    // Set overlay info
    overlay.setMode('session');
    overlay.setSessionInfo(branch, model, false);

    // Create pending session (SDK mode)
    const currentSettings = get(settings);
    if (getEffectiveTerminalMode(currentSettings) === 'Sdk') {
      createPendingSession(model, effortLevel, provider);
      await setupAudioVisualizationListener();
    }

    await recording.startRecording(currentSettings.audio.device_id || undefined);

    // Register recording hotkeys
    await callbacks?.onRegisterRecordingHotkeys();

    // Always show overlay when triggered by open mic
    await overlay.show();

    console.log('[open-mic] Recording started via wake command');
  }

  /**
   * Cancel the current recording and pending session
   */
  async function cancelRecording() {
    await recording.cancelRecording();
    await overlay.hide();
    overlay.clearSessionInfo();

    cleanupAudioVisualizationListener();

    if (pendingTranscriptionSessionId) {
      sdkSessions.cancelPendingTranscription(pendingTranscriptionSessionId);
      pendingTranscriptionSessionId = null;
    }

    sdkSessions.clearSelection();
    isRecordingForNewSession = false;
    isRecordingForNoteMode = false;
  }

  /**
   * Start recording for session setup view
   */
  async function startRecordingForSetup() {
    if (get(isRecording)) return;
    isRecordingForSetup = true;

    await openMic.stop();
    await recording.startRecording();
  }

  /**
   * Stop recording for session setup view
   * @returns The transcript, or null if transcription failed
   */
  async function stopRecordingForSetup(): Promise<string | null> {
    isRecordingForSetup = false;
    return await recording.stopRecording();
  }

  /**
   * Handle transcribe-to-input hotkey
   */
  async function handleTranscribeToInput() {
    await callbacks?.onUnregisterRecordingHotkeys();
    await overlay.hide();
    overlay.clearSessionInfo();
    cleanupAudioVisualizationListener();

    // Cancel pending session since we're pasting instead
    if (pendingTranscriptionSessionId) {
      sdkSessions.cancelPendingTranscription(pendingTranscriptionSessionId);
      pendingTranscriptionSessionId = null;
    }

    isRecordingForNewSession = false;
    isRecordingForNoteMode = false;

    // Stop recording and paste
    recording.stopRecording(true).then(async (transcript) => {
      if (transcript) {
        await invoke('paste_text', { text: transcript });
      }
    });
  }

  /**
   * Start recording for note-taking mode
   */
  async function startRecordingForNoteMode() {
    if (get(isRecording)) return;
    isRecordingForNoteMode = true;

    // Stop open mic
    await openMic.stop();

    // Check if main window is focused
    const mainWindow = getCurrentWindow();
    wasAppFocusedOnRecordStart = await mainWindow.isFocused();

    // Set overlay to note mode
    overlay.setMode('note');
    overlay.setSessionInfo(null, 'haiku', false);

    // Create pending note session
    const currentSettings = get(settings);
    if (getEffectiveTerminalMode(currentSettings) === 'Sdk') {
      const sessionId = sdkSessions.createPendingNoteSession();
      pendingTranscriptionSessionId = sessionId;
      sdkSessions.selectSession(sessionId);
      navigation.setView('sessions');

      await setupAudioVisualizationListener();
    }

    await recording.startRecording(currentSettings.audio.device_id || undefined);

    // Register recording hotkeys
    await callbacks?.onRegisterRecordingHotkeys();

    // Show overlay
    if (!wasAppFocusedOnRecordStart || currentSettings.overlay.show_when_focused) {
      await overlay.show();
    }
  }

  /**
   * Stop recording for note-taking mode
   */
  async function stopRecordingForNoteMode() {
    // Unregister recording hotkeys
    await callbacks?.onUnregisterRecordingHotkeys();

    // Hide overlay
    await overlay.hide();
    overlay.clearSessionInfo();

    // Clean up audio visualization
    cleanupAudioVisualizationListener();

    // Update pending session status
    const sessionIdToProcess = pendingTranscriptionSessionId;
    if (sessionIdToProcess) {
      sdkSessions.updatePendingTranscription(sessionIdToProcess, { status: 'transcribing' });
    }

    // Capture Vosk transcript
    const capturedVoskTranscript = get(recording).realtimeTranscript;

    const wasNoteMode = isRecordingForNoteMode;
    isRecordingForNoteMode = false;

    // Stop recording (async - don't await)
    recording
      .stopRecording()
      .then(async (transcript) => {
        if (sessionIdToProcess) {
          const audioData = get(recording).audioData;
          if (audioData) {
            sdkSessions.storeAudioData(sessionIdToProcess, audioData);
          }
        }

        if (transcript) {
          await callbacks?.onTranscriptReady(transcript, sessionIdToProcess, capturedVoskTranscript, wasNoteMode);
        } else if (sessionIdToProcess) {
          sdkSessions.updatePendingTranscription(sessionIdToProcess, {
            transcriptionError: 'No transcription returned',
          });
        }

        if (pendingTranscriptionSessionId === sessionIdToProcess) {
          pendingTranscriptionSessionId = null;
        }
      })
      .catch((error) => {
        if (sessionIdToProcess) {
          const audioData = get(recording).audioData;
          if (audioData) {
            sdkSessions.storeAudioData(sessionIdToProcess, audioData);
          }
          sdkSessions.updatePendingTranscription(sessionIdToProcess, {
            transcriptionError: error?.message || 'Transcription failed',
          });
        }
        if (pendingTranscriptionSessionId === sessionIdToProcess) {
          pendingTranscriptionSessionId = null;
        }
      });
  }

  /**
   * Clean up resources
   */
  function cleanup() {
    cleanupAudioVisualizationListener();
  }

  return {
    // State getters
    get isRecordingForNewSession() {
      return isRecordingForNewSession;
    },
    get isRecordingForSetup() {
      return isRecordingForSetup;
    },
    get isRecordingForNoteMode() {
      return isRecordingForNoteMode;
    },

    // Methods
    init,
    getPendingSessionId,
    clearPendingSessionId,
    startRecordingNewSession,
    stopRecordingNewSession,
    startRecordingFromHotkey,
    stopRecordingFromHotkey,
    startRecordingFromOpenMic,
    cancelRecording,
    startRecordingForSetup,
    stopRecordingForSetup,
    handleTranscribeToInput,
    startRecordingForNoteMode,
    stopRecordingForNoteMode,
    cleanupAudioVisualizationListener,
    cleanup,
  };
}
