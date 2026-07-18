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
import { debugRecordings } from '$lib/stores/debugRecordings';
import { sdkSessions, settingsToStoreEffort } from '$lib/stores/sdkSessions';
import { settings } from '$lib/stores/settings';
import { activeRepo, repos, isRepoActive } from '$lib/stores/repos';
import { isTranscriptionCleanupEnabled } from '$lib/utils/llm';
import {
  cleanupTranscript,
  buildAllReposContext,
} from '$lib/composables/useTranscriptionProcessor.svelte';
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
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

function createRecordingFlowStore() {
  // Observable state ---------------------------------------------------------
  const { subscribe, set, update } = writable<RecordingFlowState>({
    isRecordingForNewSession: false,
    isRecordingForSetup: false,
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

  function prepareRecording(): {
    repoPath: string;
    provider: SdkProvider;
    model: string;
    effortLevel: ReturnType<typeof settingsToStoreEffort>;
  } {
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

    return { repoPath, provider, model, effortLevel };
  }

  // Bumped whenever the overlay session info is set or cleared, so a branch
  // lookup that resolves after the recording ended can't resurrect stale info.
  let overlayInfoToken = 0;

  /**
   * Show the overlay session info immediately (without the branch) and fill
   * the branch in when the lookup resolves — the git subprocess is
   * display-only and must not delay recording start.
   */
  function setOverlayRecordingInfo(repoPath: string, model: string) {
    const token = ++overlayInfoToken;
    overlay.setMode('session');
    overlay.setSessionInfo(null, model, false);
    invoke<string>('get_git_branch', { repoPath })
      .then((branch) => {
        if (token === overlayInfoToken) {
          overlay.setSessionInfo(branch, model, false);
        }
      })
      .catch((e) => console.error('Failed to get git branch:', e));
  }

  function clearOverlayRecordingInfo() {
    overlayInfoToken++;
    overlay.clearSessionInfo();
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
    capturedRealtimeTranscript: string | undefined,
    forceAction?: RecordAndSendAction
  ) {
    const currentSettings = get(settings);
    const stopAction: RecordAndSendAction =
      forceAction ?? currentSettings.audio.record_and_send_action;
    const shouldPileOnStop = stopAction === 'pile';
    const shouldDraftOnStop = stopAction === 'draft';

    // Mint the debug id up-front and own it through the whole flow, so the
    // destination tag and the transcript pipeline's cleanup stage attach to the
    // right entry regardless of when async transcription resolves (reading the
    // mutable lastDebugId store field after the await raced and lost the id).
    const debugId = recording.newRecordingId();

    recording
      .stopRecording(true, debugId)
      .then(async (transcript) => {
        if (sessionIdToProcess) {
          const audioData = get(recording).audioData;
          if (audioData) {
            sdkSessions.storeAudioData(sessionIdToProcess, audioData);
          }
        }

        // Debug-recordings log (dev mode): tag this recording with its destination
        // and, for the main path, let the transcript pipeline attach cleanup below.
        debugRecordings.update(debugId, { destination: stopAction });

        if (shouldPileOnStop) {
          // Pile mode keeps failed transcriptions too (audio is preserved)
          await handlePileTranscriptReady(
            transcript || '',
            sessionIdToProcess,
            capturedRealtimeTranscript,
            transcript ? undefined : 'No transcription returned',
            debugId
          );
        } else if (transcript) {
          if (shouldDraftOnStop && sessionIdToProcess) {
            await handlePrepareTranscriptReady(
              transcript,
              sessionIdToProcess,
              capturedRealtimeTranscript,
              debugId
            );
          } else {
            await handleTranscriptReady(
              transcript,
              sessionIdToProcess,
              capturedRealtimeTranscript,
              debugId
            );
          }
        } else {
          // No transcription returned — salvage the recording to the pile (audio is
          // preserved, retriable) regardless of the intended destination, instead of
          // leaving a stuck session.
          await handlePileTranscriptReady(
            '',
            sessionIdToProcess,
            capturedRealtimeTranscript,
            'No transcription returned',
            debugId
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
          capturedRealtimeTranscript,
          error?.message || 'Transcription failed',
          debugId
        );
        if (pendingTranscriptionSessionId === sessionIdToProcess) {
          pendingTranscriptionSessionId = null;
        }
      });
  }

  // -------------------------------------------------------------------------
  // Recording start/stop methods
  // -------------------------------------------------------------------------

  /** Stop open mic without blocking recording start (failure is non-fatal). */
  function stopOpenMicInBackground(): Promise<void> {
    return openMic.stop().catch((e) => console.error('Failed to stop open mic:', e));
  }

  /** Start recording for a new session (header button / record button). */
  async function startRecordingNewSession() {
    if (get(isRecording)) return;
    update((s) => ({ ...s, isRecordingForNewSession: true }));

    // Open-mic teardown and mic acquisition are independent — run them
    // concurrently so wake-word cleanup never delays recording start.
    const openMicStopped = stopOpenMicInBackground();
    const { provider, model, effortLevel, repoPath } = prepareRecording();
    setOverlayRecordingInfo(repoPath, model);
    // Show the overlay immediately — mic acquisition can take over a second,
    // and the user needs instant feedback that the press registered. The
    // overlay is event-driven and flips to the waveform on 'recording-state'.
    const overlayShown = overlay.show();

    const currentSettings = get(settings);
    createPendingSession(model, effortLevel, provider);
    // NOTE: We intentionally do NOT call navigation.setView('sessions') or
    // sdkSessions.selectSession() here — recording should not force a view switch.
    await setupAudioVisualizationListener();

    await Promise.all([
      openMicStopped,
      overlayShown,
      recording.startRecording(currentSettings.audio.device_id || undefined, 'global'),
    ]);
    await hotkeyCallbacks?.registerRecordingHotkeys();
  }

  /** Stop recording for a new session. */
  async function stopRecordingNewSession() {
    if (!get(isRecording)) return;
    update((s) => ({ ...s, isRecordingForNewSession: false }));

    await hotkeyCallbacks?.unregisterRecordingHotkeys();
    await overlay.hide();
    clearOverlayRecordingInfo();
    cleanupAudioVisualizationListener();

    const sessionIdToProcess = pendingTranscriptionSessionId;
    if (sessionIdToProcess) {
      sdkSessions.updatePendingTranscription(sessionIdToProcess, { status: 'transcribing' });
    }

    const capturedRealtimeTranscript = get(recording).realtimeTranscript;
    handleRecordingStop(sessionIdToProcess, capturedRealtimeTranscript);
  }

  /** Start recording from hotkey (standard toggle). */
  async function startRecordingFromHotkey() {
    if (get(isRecording)) return;

    const openMicStopped = stopOpenMicInBackground();

    const mainWindow = getCurrentWindow();
    wasAppFocusedOnRecordStart = await mainWindow.isFocused();

    const { provider, model, effortLevel, repoPath } = prepareRecording();
    setOverlayRecordingInfo(repoPath, model);

    const currentSettings = get(settings);
    // Show the overlay immediately (focus rules permitting) — don't make it
    // wait behind mic acquisition and hotkey registration.
    const overlayShown =
      !wasAppFocusedOnRecordStart || currentSettings.overlay.show_when_focused
        ? overlay.show()
        : Promise.resolve();
    createPendingSession(model, effortLevel, provider);
    await setupAudioVisualizationListener();

    await Promise.all([
      openMicStopped,
      overlayShown,
      recording.startRecording(currentSettings.audio.device_id || undefined, 'global'),
    ]);
    await hotkeyCallbacks?.registerRecordingHotkeys();
  }

  /** Stop recording from hotkey (standard toggle). */
  async function stopRecordingFromHotkey(forceAction?: RecordAndSendAction) {
    await hotkeyCallbacks?.unregisterRecordingHotkeys();
    await overlay.hide();
    clearOverlayRecordingInfo();
    cleanupAudioVisualizationListener();

    const sessionIdToProcess = pendingTranscriptionSessionId;
    if (sessionIdToProcess) {
      sdkSessions.updatePendingTranscription(sessionIdToProcess, { status: 'transcribing' });
    }

    const capturedRealtimeTranscript = get(recording).realtimeTranscript;
    handleRecordingStop(sessionIdToProcess, capturedRealtimeTranscript, forceAction);
  }

  /** Stop recording and always send (overlay Go button), regardless of the stop-mode setting. */
  async function stopRecordingAndSend() {
    await stopRecordingFromHotkey('send');
  }

  /** Stop the current recording and save it to the pile (hotkey / UI). */
  async function stopRecordingToPile() {
    if (!get(isRecording)) return;

    await hotkeyCallbacks?.unregisterRecordingHotkeys();
    await overlay.hide();
    clearOverlayRecordingInfo();
    cleanupAudioVisualizationListener();

    const sessionIdToProcess = pendingTranscriptionSessionId;
    if (sessionIdToProcess) {
      sdkSessions.updatePendingTranscription(sessionIdToProcess, { status: 'transcribing' });
    }

    const capturedRealtimeTranscript = get(recording).realtimeTranscript;

    update((s) => ({
      ...s,
      isRecordingForNewSession: false,
    }));

    handleRecordingStop(sessionIdToProcess, capturedRealtimeTranscript, 'pile');
  }

  /** Start recording from open mic wake command. */
  async function startRecordingFromOpenMic() {
    if (get(isRecording)) return;

    const openMicStopped = stopOpenMicInBackground();

    const mainWindow = getCurrentWindow();
    wasAppFocusedOnRecordStart = await mainWindow.isFocused();

    const { provider, model, effortLevel, repoPath } = prepareRecording();
    setOverlayRecordingInfo(repoPath, model);
    // Show the overlay immediately — see startRecordingNewSession.
    const overlayShown = overlay.show();

    const currentSettings = get(settings);
    createPendingSession(model, effortLevel, provider);
    await setupAudioVisualizationListener();

    await Promise.all([
      openMicStopped,
      overlayShown,
      recording.startRecording(currentSettings.audio.device_id || undefined, 'global'),
    ]);
    await hotkeyCallbacks?.registerRecordingHotkeys();

    console.log('[open-mic] Recording started via wake command');
  }

  /** Cancel the current recording and any pending session. */
  async function cancelRecording() {
    await hotkeyCallbacks?.unregisterRecordingHotkeys();
    await recording.cancelRecording();
    await overlay.hide();
    clearOverlayRecordingInfo();
    cleanupAudioVisualizationListener();

    if (pendingTranscriptionSessionId) {
      sdkSessions.cancelPendingTranscription(pendingTranscriptionSessionId);
      pendingTranscriptionSessionId = null;
    }

    sdkSessions.clearSelection();
    update((s) => ({
      ...s,
      isRecordingForNewSession: false,
    }));
  }

  /** Start recording for session setup view. */
  async function startRecordingForSetup() {
    if (get(isRecording)) return;
    update((s) => ({ ...s, isRecordingForSetup: true }));

    await Promise.all([
      stopOpenMicInBackground(),
      recording.startRecording(get(settings).audio.device_id || undefined),
    ]);
  }

  /** Stop recording for session setup view. Returns the transcript (null on failure). */
  async function stopRecordingForSetup(): Promise<string | null> {
    update((s) => ({ ...s, isRecordingForSetup: false }));
    const capturedRealtimeTranscript = get(recording).realtimeTranscript;

    // Own the debug id so the destination tag and LLM cleanup stage land in the log.
    const debugId = recording.newRecordingId();

    let transcript: string | null;
    try {
      transcript = await recording.stopRecording(true, debugId);
    } catch (error) {
      // Transcription failed — salvage the recording to the pile so it isn't lost.
      await handlePileTranscriptReady(
        '',
        null,
        capturedRealtimeTranscript,
        error instanceof Error ? error.message : 'Transcription failed',
        debugId
      );
      return null;
    }

    debugRecordings.update(debugId, { destination: 'setup' });
    if (!transcript || !isTranscriptionCleanupEnabled()) return transcript;

    // Apply LLM cleanup (dual-source when a realtime transcript exists), same as
    // every other dictation path, and attach the result to the recordings log.
    const repoContext = buildAllReposContext(get(repos).list.filter(isRepoActive));
    const cleanupResult = await cleanupTranscript(transcript, capturedRealtimeTranscript, repoContext);
    debugRecordings.update(debugId, {
      cleanedTranscript: cleanupResult.text,
      wasCleanedUp: cleanupResult.wasCleanedUp,
      cleanupCorrections: cleanupResult.corrections,
      usedDualSource: cleanupResult.usedDualSource,
    });
    return cleanupResult.text;
  }

  /** Handle transcribe-to-input hotkey. */
  async function handleTranscribeToInput() {
    await hotkeyCallbacks?.unregisterRecordingHotkeys();
    await overlay.hide();
    clearOverlayRecordingInfo();
    cleanupAudioVisualizationListener();

    if (pendingTranscriptionSessionId) {
      sdkSessions.cancelPendingTranscription(pendingTranscriptionSessionId);
      pendingTranscriptionSessionId = null;
    }

    update((s) => ({
      ...s,
      isRecordingForNewSession: false,
    }));

    const debugId = recording.newRecordingId();
    recording
      .stopRecording(true, debugId)
      .then(async (transcript) => {
        debugRecordings.update(debugId, { destination: 'paste' });
        if (transcript) {
          await invoke('paste_text', { text: transcript });
        } else {
          // Nothing transcribed — keep the recording in the pile so it isn't lost.
          await handlePileTranscriptReady('', null, undefined, 'No transcription returned', debugId);
        }
      })
      .catch(async (error) => {
        // Transcription failed — salvage the recording to the pile for retry.
        await handlePileTranscriptReady(
          '',
          null,
          undefined,
          error?.message || 'Transcription failed',
          debugId
        );
      });
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
    stopRecordingAndSend,
    stopRecordingToPile,
    startRecordingFromOpenMic,
    cancelRecording,
    startRecordingForSetup,
    stopRecordingForSetup,
    handleTranscribeToInput,

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
