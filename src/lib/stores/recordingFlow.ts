/**
 * Global recording flow store.
 *
 * Manages the recording lifecycle (start/stop, pending sessions, audio
 * visualization, overlay integration) as a singleton that survives across
 * route changes.  Replaces the former page-scoped `useRecordingFlow`
 * composable.
 *
 * Pattern: closure-based singleton (same as recording.ts, overlay.ts, openMic.ts).
 */

import { writable, derived, get } from 'svelte/store';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Stores
import { recording, isRecording } from '$lib/stores/recording';
import { sdkSessions, settingsToStoreEffort } from '$lib/stores/sdkSessions';
import { settings, getEffectiveTerminalMode, isNoteModeAvailable } from '$lib/stores/settings';
import { activeRepo } from '$lib/stores/repos';
import { overlay } from '$lib/stores/overlay';
import { openMic } from '$lib/stores/openMic';
import { DEFAULT_OPENAI_MODEL_ID, type SdkProvider } from '$lib/utils/models';
import { captureRecordingScreenshot } from '$lib/utils/screenshot';

// Transcript processor (Phase 1)
import {
  handlePrepareTranscriptReady,
  handleTranscriptReady,
  handlePileTranscriptReady,
} from '$lib/stores/transcriptProcessor';
import type { RecordAndSendAction } from '$lib/stores/settings';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HotkeyCallbacks {
  registerRecordingHotkeys: () => Promise<void>;
  unregisterRecordingHotkeys: () => Promise<void>;
}

interface RecordingFlowState {
  /** True while recording for a new session (header / button flow). */
  isRecordingForNewSession: boolean;
  /** True while recording from the setup view. */
  isRecordingForSetup: boolean;
  /** True while recording for note mode. */
  isRecordingForNoteMode: boolean;
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

function createRecordingFlowStore() {
  // Observable state ---------------------------------------------------------
  const { subscribe, set, update } = writable<RecordingFlowState>({
    isRecordingForNewSession: false,
    isRecordingForSetup: false,
    isRecordingForNoteMode: false,
  });

  // Private (non-observable) state ------------------------------------------
  let wasAppFocusedOnRecordStart = true;
  let pendingTranscriptionSessionId: string | null = null;
  let unlistenAudioVisualization: UnlistenFn | null = null;
  let hotkeyCallbacks: HotkeyCallbacks | null = null;

  // -------------------------------------------------------------------------
  // Hotkey callback registration
  // -------------------------------------------------------------------------

  function setHotkeyCallbacks(cb: HotkeyCallbacks) {
    hotkeyCallbacks = cb;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function getPendingSessionId(): string | null {
    return pendingTranscriptionSessionId;
  }

  function clearPendingSessionId() {
    pendingTranscriptionSessionId = null;
  }

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

  function cleanupAudioVisualizationListener() {
    if (unlistenAudioVisualization) {
      unlistenAudioVisualization();
      unlistenAudioVisualization = null;
    }
  }

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
    const provider: SdkProvider =
      currentSettings.sdk_provider === 'OpenAI' ? 'openai' : 'claude';
    const model =
      provider === 'openai'
        ? currentSettings.openai_model || DEFAULT_OPENAI_MODEL_ID
        : currentSettings.default_model;
    const effortLevel = settingsToStoreEffort(currentSettings.default_effort_level);

    let branch: string | null = null;
    try {
      branch = await invoke<string>('get_git_branch', { repoPath });
    } catch (e) {
      console.error('Failed to get git branch:', e);
    }

    return { repoPath, provider, model, effortLevel, branch };
  }

  function createPendingSession(
    model: string,
    effortLevel: ReturnType<typeof settingsToStoreEffort>,
    provider: SdkProvider
  ): string {
    const sessionId = sdkSessions.createPendingTranscriptionSession(model, effortLevel, provider);
    pendingTranscriptionSessionId = sessionId;
    maybeCaptureScreenshot(sessionId);
    return sessionId;
  }

  /**
   * Capture a screenshot of what the user is looking at as the recording
   * starts (fire-and-forget — grabs the screen before the overlay appears).
   * Stored on the pending session; attached to the first prompt on send.
   */
  function maybeCaptureScreenshot(sessionId: string) {
    if (!get(settings).audio.capture_screenshot_on_record) return;
    captureRecordingScreenshot().then((screenshot) => {
      if (screenshot) {
        sdkSessions.updatePendingTranscription(sessionId, { screenshots: [screenshot] });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Shared stop-recording helper
  // -------------------------------------------------------------------------

  function handleRecordingStop(
    sessionIdToProcess: string | null,
    capturedVoskTranscript: string | undefined,
    isNoteMode: boolean = false,
    forceAction?: RecordAndSendAction
  ) {
    const currentSettings = get(settings);
    const isSdk = getEffectiveTerminalMode(currentSettings) === 'Sdk';
    const stopAction: RecordAndSendAction =
      forceAction ??
      (!isNoteMode && isSdk ? currentSettings.audio.record_and_send_action : 'send');
    const shouldPileOnStop = stopAction === 'pile';
    const shouldPrepareOnStop = !isNoteMode && isSdk && stopAction === 'prepare';

    recording
      .stopRecording(true)
      .then(async (transcript) => {
        if (sessionIdToProcess) {
          const audioData = get(recording).audioData;
          if (audioData) {
            sdkSessions.storeAudioData(sessionIdToProcess, audioData);
          }
        }

        if (shouldPileOnStop) {
          // Pile mode keeps failed transcriptions too (audio is preserved)
          await handlePileTranscriptReady(
            transcript || '',
            sessionIdToProcess,
            capturedVoskTranscript,
            transcript ? undefined : 'No transcription returned'
          );
        } else if (transcript) {
          if (shouldPrepareOnStop && sessionIdToProcess) {
            await handlePrepareTranscriptReady(
              transcript,
              sessionIdToProcess,
              capturedVoskTranscript
            );
          } else {
            await handleTranscriptReady(
              transcript,
              sessionIdToProcess,
              capturedVoskTranscript,
              isNoteMode
            );
          }
        } else {
          // No transcription returned — salvage the recording to the pile (audio is
          // preserved, retriable) regardless of the intended destination, instead of
          // leaving a stuck session.
          await handlePileTranscriptReady(
            '',
            sessionIdToProcess,
            capturedVoskTranscript,
            'No transcription returned'
          );
        }

        if (pendingTranscriptionSessionId === sessionIdToProcess) {
          pendingTranscriptionSessionId = null;
        }
      })
      .catch(async (error) => {
        // Transcription failed (service down/network/5xx) — salvage the recording to
        // the pile so it survives and can be retried, regardless of intended destination.
        await handlePileTranscriptReady(
          '',
          sessionIdToProcess,
          capturedVoskTranscript,
          error?.message || 'Transcription failed'
        );
        if (pendingTranscriptionSessionId === sessionIdToProcess) {
          pendingTranscriptionSessionId = null;
        }
      });
  }

  // -------------------------------------------------------------------------
  // Recording start/stop methods
  // -------------------------------------------------------------------------

  /** Start recording for a new session (header button / record button). */
  async function startRecordingNewSession() {
    if (get(isRecording)) return;
    update((s) => ({ ...s, isRecordingForNewSession: true }));

    await openMic.stop();
    const { provider, model, effortLevel, branch } = await prepareRecording();

    overlay.setMode('session');
    overlay.setSessionInfo(branch, model, false);

    const currentSettings = get(settings);
    if (getEffectiveTerminalMode(currentSettings) === 'Sdk') {
      createPendingSession(model, effortLevel, provider);
      // NOTE: We intentionally do NOT call navigation.setView('sessions') or
      // sdkSessions.selectSession() here — recording should not force a view switch.
      await setupAudioVisualizationListener();
    }

    await recording.startRecording(currentSettings.audio.device_id || undefined);
    await hotkeyCallbacks?.registerRecordingHotkeys();
    await overlay.show();
  }

  /** Stop recording for a new session. */
  async function stopRecordingNewSession() {
    if (!get(isRecording)) return;
    update((s) => ({ ...s, isRecordingForNewSession: false }));

    await hotkeyCallbacks?.unregisterRecordingHotkeys();
    await overlay.hide();
    overlay.clearSessionInfo();
    cleanupAudioVisualizationListener();

    const sessionIdToProcess = pendingTranscriptionSessionId;
    if (sessionIdToProcess) {
      sdkSessions.updatePendingTranscription(sessionIdToProcess, { status: 'transcribing' });
    }

    const capturedVoskTranscript = get(recording).realtimeTranscript;
    handleRecordingStop(sessionIdToProcess, capturedVoskTranscript);
  }

  /** Start recording from hotkey (standard toggle). */
  async function startRecordingFromHotkey() {
    if (get(isRecording)) return;

    await openMic.stop();

    const mainWindow = getCurrentWindow();
    wasAppFocusedOnRecordStart = await mainWindow.isFocused();

    const { provider, model, effortLevel, branch } = await prepareRecording();

    overlay.setMode('session');
    overlay.setSessionInfo(branch, model, false);

    const currentSettings = get(settings);
    if (getEffectiveTerminalMode(currentSettings) === 'Sdk') {
      createPendingSession(model, effortLevel, provider);
      await setupAudioVisualizationListener();
    }

    await recording.startRecording(currentSettings.audio.device_id || undefined);
    await hotkeyCallbacks?.registerRecordingHotkeys();

    if (!wasAppFocusedOnRecordStart || currentSettings.overlay.show_when_focused) {
      await overlay.show();
    }
  }

  /** Stop recording from hotkey (standard toggle). */
  async function stopRecordingFromHotkey() {
    // Delegate to note mode if active
    const state = get({ subscribe });
    if (state.isRecordingForNoteMode) {
      await stopRecordingForNoteMode();
      return;
    }

    await hotkeyCallbacks?.unregisterRecordingHotkeys();
    await overlay.hide();
    overlay.clearSessionInfo();
    cleanupAudioVisualizationListener();

    const sessionIdToProcess = pendingTranscriptionSessionId;
    if (sessionIdToProcess) {
      sdkSessions.updatePendingTranscription(sessionIdToProcess, { status: 'transcribing' });
    }

    const capturedVoskTranscript = get(recording).realtimeTranscript;
    handleRecordingStop(sessionIdToProcess, capturedVoskTranscript);
  }

  /** Stop the current recording and save it to the pile (hotkey / UI). */
  async function stopRecordingToPile() {
    if (!get(isRecording)) return;

    await hotkeyCallbacks?.unregisterRecordingHotkeys();
    await overlay.hide();
    overlay.clearSessionInfo();
    cleanupAudioVisualizationListener();

    const sessionIdToProcess = pendingTranscriptionSessionId;
    if (sessionIdToProcess) {
      sdkSessions.updatePendingTranscription(sessionIdToProcess, { status: 'transcribing' });
    }

    const capturedVoskTranscript = get(recording).realtimeTranscript;

    update((s) => ({
      ...s,
      isRecordingForNewSession: false,
      isRecordingForNoteMode: false,
    }));

    handleRecordingStop(sessionIdToProcess, capturedVoskTranscript, false, 'pile');
  }

  /** Start recording from open mic wake command. */
  async function startRecordingFromOpenMic() {
    if (get(isRecording)) return;

    await openMic.stop();

    const mainWindow = getCurrentWindow();
    wasAppFocusedOnRecordStart = await mainWindow.isFocused();

    const { provider, model, effortLevel, branch } = await prepareRecording();

    overlay.setMode('session');
    overlay.setSessionInfo(branch, model, false);

    const currentSettings = get(settings);
    if (getEffectiveTerminalMode(currentSettings) === 'Sdk') {
      createPendingSession(model, effortLevel, provider);
      await setupAudioVisualizationListener();
    }

    await recording.startRecording(currentSettings.audio.device_id || undefined);
    await hotkeyCallbacks?.registerRecordingHotkeys();
    await overlay.show();

    console.log('[open-mic] Recording started via wake command');
  }

  /** Cancel the current recording and any pending session. */
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
    update((s) => ({
      ...s,
      isRecordingForNewSession: false,
      isRecordingForNoteMode: false,
    }));
  }

  /** Start recording for session setup view. */
  async function startRecordingForSetup() {
    if (get(isRecording)) return;
    update((s) => ({ ...s, isRecordingForSetup: true }));

    await openMic.stop();
    await recording.startRecording();
  }

  /** Stop recording for session setup view. Returns the transcript (null on failure). */
  async function stopRecordingForSetup(): Promise<string | null> {
    update((s) => ({ ...s, isRecordingForSetup: false }));
    const capturedVoskTranscript = get(recording).realtimeTranscript;
    try {
      return await recording.stopRecording();
    } catch (error) {
      // Transcription failed — salvage the recording to the pile so it isn't lost.
      await handlePileTranscriptReady(
        '',
        null,
        capturedVoskTranscript,
        error instanceof Error ? error.message : 'Transcription failed'
      );
      return null;
    }
  }

  /** Handle transcribe-to-input hotkey. */
  async function handleTranscribeToInput() {
    await hotkeyCallbacks?.unregisterRecordingHotkeys();
    await overlay.hide();
    overlay.clearSessionInfo();
    cleanupAudioVisualizationListener();

    if (pendingTranscriptionSessionId) {
      sdkSessions.cancelPendingTranscription(pendingTranscriptionSessionId);
      pendingTranscriptionSessionId = null;
    }

    update((s) => ({
      ...s,
      isRecordingForNewSession: false,
      isRecordingForNoteMode: false,
    }));

    recording
      .stopRecording(true)
      .then(async (transcript) => {
        if (transcript) {
          await invoke('paste_text', { text: transcript });
        } else {
          // Nothing transcribed — keep the recording in the pile so it isn't lost.
          await handlePileTranscriptReady('', null, undefined, 'No transcription returned');
        }
      })
      .catch(async (error) => {
        // Transcription failed — salvage the recording to the pile for retry.
        await handlePileTranscriptReady(
          '',
          null,
          undefined,
          error?.message || 'Transcription failed'
        );
      });
  }

  /** Start recording for note-taking mode. */
  async function startRecordingForNoteMode() {
    if (!isNoteModeAvailable()) return;
    if (get(isRecording)) return;
    update((s) => ({ ...s, isRecordingForNoteMode: true }));

    await openMic.stop();

    const mainWindow = getCurrentWindow();
    wasAppFocusedOnRecordStart = await mainWindow.isFocused();

    overlay.setMode('note');
    overlay.setSessionInfo(null, 'haiku', false);

    const currentSettings = get(settings);
    if (getEffectiveTerminalMode(currentSettings) === 'Sdk') {
      const sessionId = sdkSessions.createPendingNoteSession();
      pendingTranscriptionSessionId = sessionId;
      sdkSessions.selectSession(sessionId);
      // NOTE: We intentionally do NOT call navigation.setView('sessions') here.
      await setupAudioVisualizationListener();
    }

    await recording.startRecording(currentSettings.audio.device_id || undefined);
    await hotkeyCallbacks?.registerRecordingHotkeys();

    if (!wasAppFocusedOnRecordStart || currentSettings.overlay.show_when_focused) {
      await overlay.show();
    }
  }

  /** Stop recording for note-taking mode. */
  async function stopRecordingForNoteMode() {
    await hotkeyCallbacks?.unregisterRecordingHotkeys();
    await overlay.hide();
    overlay.clearSessionInfo();
    cleanupAudioVisualizationListener();

    const sessionIdToProcess = pendingTranscriptionSessionId;
    if (sessionIdToProcess) {
      sdkSessions.updatePendingTranscription(sessionIdToProcess, { status: 'transcribing' });
    }

    const capturedVoskTranscript = get(recording).realtimeTranscript;

    update((s) => ({ ...s, isRecordingForNoteMode: false }));

    handleRecordingStop(sessionIdToProcess, capturedVoskTranscript, true);
  }

  /** Clean up resources. */
  function cleanup() {
    cleanupAudioVisualizationListener();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    subscribe,

    // Hotkey callback registration
    setHotkeyCallbacks,

    // Pending session helpers
    getPendingSessionId,
    clearPendingSessionId,

    // Recording lifecycle
    startRecordingNewSession,
    stopRecordingNewSession,
    startRecordingFromHotkey,
    stopRecordingFromHotkey,
    stopRecordingToPile,
    startRecordingFromOpenMic,
    cancelRecording,
    startRecordingForSetup,
    stopRecordingForSetup,
    handleTranscribeToInput,
    startRecordingForNoteMode,
    stopRecordingForNoteMode,

    // Cleanup
    cleanupAudioVisualizationListener,
    cleanup,
  };
}

// Singleton export
export const recordingFlow = createRecordingFlowStore();

// Derived stores for convenience
export const isRecordingForNewSession = derived(
  recordingFlow,
  ($rf) => $rf.isRecordingForNewSession
);
export const isRecordingForSetup = derived(recordingFlow, ($rf) => $rf.isRecordingForSetup);
export const isRecordingForNoteMode = derived(recordingFlow, ($rf) => $rf.isRecordingForNoteMode);
