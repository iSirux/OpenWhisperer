/**
 * Global transcript processing service.
 *
 * Extracted from +page.svelte so that transcript processing works regardless
 * of which route is currently active.  Every function reads from global stores
 * (settings, repos, sdkSessions, etc.) — no component lifecycle needed.
 */

import { get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Stores
import {
  sdkSessions,
  activeSdkSessionId,
  type EffortLevel,
  settingsToStoreEffort,
} from '$lib/stores/sdkSessions';
import { sessions, activeSessionId } from '$lib/stores/sessions';
import { settings, getEffectiveTerminalMode } from '$lib/stores/settings';
import { repos, activeRepo, isAutoRepoSelected, isRepoActive, type RepoConfig } from '$lib/stores/repos';
import { recording } from '$lib/stores/recording';
import { navigation } from '$lib/stores/navigation';

// Transcription processing utilities (already stateless)
import {
  cleanupTranscript,
  getModelRecommendation,
  getRepoRecommendation,
  repoNeedsConfirmation,
  buildSystemPrompt,
  buildAllReposContext,
  buildSingleRepoContext,
  updatePendingWithCleanup,
  updatePendingWithModelRecommendation,
  updatePendingWithRepoRecommendation,
} from '$lib/composables/useTranscriptionProcessor.svelte';

// Utils
import {
  isTranscriptionCleanupEnabled,
  isModelRecommendationEnabled,
  isRepoAutoSelectEnabled,
} from '$lib/utils/llm';
import { isAutoModel } from '$lib/utils/models';
import { processVoiceCommand, type VoiceCommandType } from '$lib/utils/voiceCommands';
import { playRepoSelectedSound } from '$lib/utils/sound';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get list of active repos (filters out inactive). */
function getActiveReposList() {
  return get(repos).list.filter(isRepoActive);
}

// ---------------------------------------------------------------------------
// Core transcript processing pipeline
// ---------------------------------------------------------------------------

/**
 * Handle a transcript that's ready to be processed.
 * Entry-point called by recordingFlow after transcription completes.
 */
export async function handleTranscriptReady(
  transcript: string,
  pendingSessionId: string | null,
  voskTranscript?: string,
  isNoteMode?: boolean
) {
  if (!transcript.trim()) {
    console.log('[transcript] Empty transcript, skipping');
    if (pendingSessionId) {
      sdkSessions.cancelPendingTranscription(pendingSessionId);
    }
    return;
  }

  // Update pending session status
  if (pendingSessionId) {
    sdkSessions.updatePendingTranscription(pendingSessionId, {
      status: 'processing',
      transcript: transcript,
      voskTranscript: voskTranscript || undefined,
    });
  }

  const currentSettings = get(settings);
  if (getEffectiveTerminalMode(currentSettings) === 'Sdk') {
    if (isNoteMode) {
      await processNoteTranscript(transcript, pendingSessionId);
    } else {
      await processSdkTranscript(transcript, pendingSessionId, voskTranscript);
    }
  } else {
    await processPtyTranscript(transcript, pendingSessionId, voskTranscript);
  }
}

/**
 * Process transcript for SDK mode.
 */
async function processSdkTranscript(
  transcript: string,
  pendingSessionId: string | null,
  voskTranscript?: string
) {
  const activeReposList = getActiveReposList();
  let finalTranscript = transcript;

  // Step 1: Clean up transcription
  if (isTranscriptionCleanupEnabled()) {
    const repoContext = buildAllReposContext(activeReposList);
    const cleanupResult = await cleanupTranscript(transcript, voskTranscript, repoContext);
    finalTranscript = cleanupResult.text;

    if (pendingSessionId) {
      updatePendingWithCleanup(
        pendingSessionId,
        voskTranscript,
        finalTranscript,
        cleanupResult.wasCleanedUp,
        cleanupResult.corrections,
        cleanupResult.usedDualSource
      );
    }
  }

  // Step 2: Get repo recommendation if in auto-repo mode
  const currentSettings = get(settings);
  const currentRepos = get(repos);
  let repoRecommendation: Awaited<ReturnType<typeof getRepoRecommendation>> = null;

  if (get(isAutoRepoSelected) && isRepoAutoSelectEnabled() && activeReposList.length > 1) {
    repoRecommendation = await getRepoRecommendation(finalTranscript, activeReposList);

    if (!repoRecommendation || repoNeedsConfirmation(repoRecommendation.confidence)) {
      await handleRepoSelectionNeeded(
        pendingSessionId,
        finalTranscript,
        repoRecommendation?.repoIndex ?? null,
        repoRecommendation?.reasoning ?? 'Not enough information to determine repository',
        repoRecommendation?.confidence ?? 'low'
      );
      return;
    }

    if (pendingSessionId && repoRecommendation) {
      const recommendedRepo = currentRepos.list[repoRecommendation.repoIndex];
      updatePendingWithRepoRecommendation(
        pendingSessionId,
        repoRecommendation,
        recommendedRepo?.name || 'Unknown'
      );
    }
  }

  const sessionRepo = repoRecommendation
    ? currentRepos.list[repoRecommendation.repoIndex]
    : get(activeRepo);

  // Check if approval is required
  if (currentSettings.audio.require_transcription_approval) {
    const repoPath = sessionRepo?.path || '.';
    if (pendingSessionId) {
      sdkSessions.setPendingApproval(pendingSessionId, finalTranscript, repoPath);
    } else {
      const newSessionId = sdkSessions.createPendingTranscriptionSession(
        currentSettings.default_model,
        settingsToStoreEffort(currentSettings.default_effort_level)
      );
      sdkSessions.setPendingApproval(newSessionId, finalTranscript, repoPath);
      activeSdkSessionId.set(newSessionId);
      activeSessionId.set(null);
    }
    navigation.setView('sessions');
    return;
  }

  if (pendingSessionId) {
    await completePendingSession(pendingSessionId, finalTranscript, sessionRepo);
  } else {
    await createSessionWithPrompt(finalTranscript, sessionRepo);
  }
}

/**
 * Process transcript for note mode.
 */
async function processNoteTranscript(
  transcript: string,
  pendingSessionId: string | null
) {
  const currentActiveRepo = get(activeRepo);
  const repoPath = currentActiveRepo?.path || '.';

  let finalTranscript = transcript;
  if (isTranscriptionCleanupEnabled()) {
    const repoContext = currentActiveRepo ? buildSingleRepoContext(currentActiveRepo) : undefined;
    const cleanupResult = await cleanupTranscript(transcript, undefined, repoContext);
    finalTranscript = cleanupResult.text;

    if (pendingSessionId) {
      updatePendingWithCleanup(
        pendingSessionId,
        undefined,
        finalTranscript,
        cleanupResult.wasCleanedUp,
        cleanupResult.corrections,
        cleanupResult.usedDualSource
      );
    }
  }

  if (pendingSessionId) {
    await sdkSessions.completePendingNoteSession(pendingSessionId, repoPath, finalTranscript);
    activeSessionId.set(null);
  } else {
    const sessionId = sdkSessions.createPendingNoteSession();
    sdkSessions.selectSession(sessionId);
    await sdkSessions.completePendingNoteSession(sessionId, repoPath, finalTranscript);
    activeSdkSessionId.set(sessionId);
    activeSessionId.set(null);
  }

  navigation.setView('sessions');
}

/**
 * Process transcript for PTY mode.
 */
async function processPtyTranscript(
  transcript: string,
  pendingSessionId: string | null,
  voskTranscript?: string
) {
  const currentActiveRepo = get(activeRepo);
  let finalTranscript = transcript;

  if (isTranscriptionCleanupEnabled()) {
    const repoContext = currentActiveRepo ? buildSingleRepoContext(currentActiveRepo) : undefined;
    const cleanupResult = await cleanupTranscript(transcript, voskTranscript, repoContext);
    finalTranscript = cleanupResult.text;
  }

  if (pendingSessionId) {
    sdkSessions.cancelPendingTranscription(pendingSessionId);
  }

  const sessionId = await sessions.createSession(finalTranscript);
  activeSessionId.set(sessionId);
  activeSdkSessionId.set(null);
}

/**
 * Complete a pending session with a processed transcript.
 */
async function completePendingSession(
  sessionId: string,
  transcript: string,
  repo: RepoConfig | null | undefined
) {
  const currentSettings = get(settings);
  const activeReposList = getActiveReposList();
  const repoPath = repo?.path || '.';
  const repoName = repo?.name || '';

  const { model, effortLevel, recommendation } = await getModelRecommendation(
    transcript,
    currentSettings.enabled_models
  );

  if (recommendation) {
    updatePendingWithModelRecommendation(sessionId, recommendation);
    await sdkSessions.updateSessionModel(sessionId, model);
    if (recommendation.effortLevel) {
      await sdkSessions.updateSessionEffort(sessionId, recommendation.effortLevel);
    }
  }

  const systemPrompt = buildSystemPrompt({
    repoPath,
    repoName,
    includeTranscriptionNotice: true,
    allRepos: activeReposList,
  });

  await sdkSessions.completePendingTranscription(sessionId, repoPath, transcript, systemPrompt);
  activeSessionId.set(null);
}

/**
 * Create a brand-new session with a prompt (no pending session).
 */
async function createSessionWithPrompt(
  transcript: string,
  repo: RepoConfig | null | undefined
) {
  const currentSettings = get(settings);
  const activeReposList = getActiveReposList();
  const repoPath = repo?.path || '.';
  const repoName = repo?.name || '';

  const { model, effortLevel } = await getModelRecommendation(
    transcript,
    currentSettings.enabled_models
  );

  const systemPrompt = buildSystemPrompt({
    repoPath,
    repoName,
    includeTranscriptionNotice: true,
    allRepos: activeReposList,
  });

  const sessionId = await sdkSessions.createSession(repoPath, model, effortLevel, systemPrompt);
  activeSdkSessionId.set(sessionId);
  await sdkSessions.sendPrompt(sessionId, transcript);
  activeSessionId.set(null);
}

/**
 * Handle low-confidence repo recommendation — show repo selection UI.
 */
async function handleRepoSelectionNeeded(
  pendingSessionId: string | null,
  transcript: string,
  recommendedIndex: number | null,
  reasoning: string,
  confidence: string
) {
  const currentSettings = get(settings);
  const model = currentSettings.default_model;
  const effortLevel = settingsToStoreEffort(currentSettings.default_effort_level);

  if (pendingSessionId) {
    await sdkSessions.completePendingTranscription(pendingSessionId, '', transcript, undefined, {
      transcript,
      recommendedIndex,
      reasoning,
      confidence,
    });
    navigation.setView('sessions');
  } else {
    sdkSessions.createPendingRepoSession(model, effortLevel, {
      transcript,
      recommendedIndex,
      reasoning,
      confidence,
    });
  }
}

// ---------------------------------------------------------------------------
// Prepare-mode transcript processing
// ---------------------------------------------------------------------------

/**
 * Process transcript for prepare mode — does all processing but stops short of launching.
 */
export async function handlePrepareTranscriptReady(
  transcript: string,
  sessionId: string,
  voskTranscript?: string
) {
  if (!transcript.trim()) {
    sdkSessions.cancelPendingTranscription(sessionId);
    return;
  }

  const activeReposList = getActiveReposList();
  const currentSettings = get(settings);
  const currentRepos = get(repos);
  const currentActiveRepo = get(activeRepo);

  sdkSessions.updatePendingTranscription(sessionId, {
    status: 'processing',
    transcript: transcript,
    voskTranscript: voskTranscript || undefined,
  });

  let finalTranscript = transcript;

  // Step 1: Clean up transcription
  if (isTranscriptionCleanupEnabled()) {
    const repoContext = buildAllReposContext(activeReposList);
    const cleanupResult = await cleanupTranscript(transcript, voskTranscript, repoContext);
    finalTranscript = cleanupResult.text;

    updatePendingWithCleanup(
      sessionId,
      voskTranscript,
      finalTranscript,
      cleanupResult.wasCleanedUp,
      cleanupResult.corrections,
      cleanupResult.usedDualSource
    );
  }

  // Step 2: Get repo recommendation if in auto-repo mode
  let sessionCwd = '';
  let sessionRepo = currentActiveRepo;
  let preparedRepoRecommendation:
    | { recommendedIndex: number | null; reasoning: string; confidence: string }
    | undefined;

  if (
    get(isAutoRepoSelected) &&
    isRepoAutoSelectEnabled() &&
    activeReposList.length > 1
  ) {
    const repoRecommendation = await getRepoRecommendation(finalTranscript, activeReposList);

    if (repoRecommendation && !repoNeedsConfirmation(repoRecommendation.confidence)) {
      sessionRepo = currentRepos.list[repoRecommendation.repoIndex];
      sessionCwd = sessionRepo?.path || '';
      updatePendingWithRepoRecommendation(
        sessionId,
        repoRecommendation,
        sessionRepo?.name || 'Unknown'
      );
    } else {
      preparedRepoRecommendation = {
        recommendedIndex: repoRecommendation?.repoIndex ?? null,
        reasoning:
          repoRecommendation?.reasoning ?? 'Not enough information to determine repository',
        confidence: repoRecommendation?.confidence ?? 'low',
      };
      sessionCwd = '';
    }
  } else {
    sessionCwd = sessionRepo?.path || '';
  }

  // Step 3: Get model recommendation
  const { model, effortLevel, recommendation } = await getModelRecommendation(
    finalTranscript,
    currentSettings.enabled_models
  );

  if (recommendation) {
    updatePendingWithModelRecommendation(sessionId, recommendation);
    await sdkSessions.updateSessionModel(sessionId, model);
    if (recommendation.effortLevel) {
      await sdkSessions.updateSessionEffort(sessionId, recommendation.effortLevel);
    }
  }

  // Step 4: Build system prompt
  const systemPrompt = buildSystemPrompt({
    repoPath: sessionCwd,
    repoName: sessionRepo?.name || '',
    includeTranscriptionNotice: true,
    allRepos: activeReposList,
  });

  // Step 5: Set prepared status instead of launching
  sdkSessions.setPrepared(
    sessionId,
    finalTranscript,
    sessionCwd,
    systemPrompt,
    preparedRepoRecommendation
  );
  activeSessionId.set(null);
}

// ---------------------------------------------------------------------------
// Selection handling
// ---------------------------------------------------------------------------

/**
 * Handle "Send Selection" hotkey:
 * 1. Copy selected text from focused app
 * 2. Show/focus ClaudeWhisperer window
 * 3. Run auto-model/repo recommendations
 * 4. Create session and send immediately
 */
export async function handleSendSelection() {
  try {
    const selectedText = await invoke<string>('copy_selection');
    if (!selectedText.trim()) {
      console.log('[selection] No text selected, ignoring send_selection hotkey');
      return;
    }

    console.log('[selection] Captured selection:', selectedText.substring(0, 80) + '...');

    const mainWindow = getCurrentWindow();
    await mainWindow.show();
    await mainWindow.setFocus();

    navigation.setView('sessions');

    const activeReposList = getActiveReposList();
    const currentSettings = get(settings);
    const currentRepos = get(repos);
    let sessionRepo = get(activeRepo);

    if (get(isAutoRepoSelected) && isRepoAutoSelectEnabled() && activeReposList.length > 1) {
      const repoRecommendation = await getRepoRecommendation(selectedText, activeReposList);

      if (repoRecommendation && !repoNeedsConfirmation(repoRecommendation.confidence)) {
        sessionRepo = currentRepos.list[repoRecommendation.repoIndex];
      } else {
        const model = currentSettings.default_model;
        const effortLevel = settingsToStoreEffort(currentSettings.default_effort_level);
        const sessionId = sdkSessions.createPendingRepoSession(model, effortLevel, {
          transcript: selectedText,
          recommendedIndex: repoRecommendation?.repoIndex ?? null,
          reasoning:
            repoRecommendation?.reasoning ?? 'Not enough information to determine repository',
          confidence: repoRecommendation?.confidence ?? 'low',
        });
        activeSdkSessionId.set(sessionId);
        activeSessionId.set(null);
        return;
      }
    }

    const repoPath = sessionRepo?.path || '.';
    const repoName = sessionRepo?.name || '';

    const { model, effortLevel } = await getModelRecommendation(
      selectedText,
      currentSettings.enabled_models
    );

    const systemPrompt = buildSystemPrompt({
      repoPath,
      repoName,
      includeTranscriptionNotice: false,
      allRepos: activeReposList,
    });

    const sessionId = await sdkSessions.createSession(repoPath, model, effortLevel, systemPrompt);
    activeSdkSessionId.set(sessionId);
    await sdkSessions.sendPrompt(sessionId, selectedText);
    activeSessionId.set(null);
  } catch (error) {
    console.error('[selection] Failed to send selection:', error);
  }
}

/**
 * Handle "Prepare Selection" hotkey:
 * 1. Copy selected text from focused app
 * 2. Show/focus ClaudeWhisperer window
 * 3. Run auto-model/repo recommendations
 * 4. Create prepared session for user review
 */
export async function handlePrepareSelection() {
  try {
    const selectedText = await invoke<string>('copy_selection');
    if (!selectedText.trim()) {
      console.log('[selection] No text selected, ignoring prepare_selection hotkey');
      return;
    }

    console.log(
      '[selection] Captured selection for prepare:',
      selectedText.substring(0, 80) + '...'
    );

    const mainWindow = getCurrentWindow();
    await mainWindow.show();
    await mainWindow.setFocus();

    navigation.setView('sessions');

    const activeReposList = getActiveReposList();
    const currentSettings = get(settings);
    const currentRepos = get(repos);
    let currentActiveRepo = get(activeRepo);

    const sessionId = sdkSessions.createPendingTranscriptionSession(
      currentSettings.default_model,
      settingsToStoreEffort(currentSettings.default_effort_level)
    );
    sdkSessions.selectSession(sessionId);
    activeSdkSessionId.set(sessionId);
    activeSessionId.set(null);

    sdkSessions.updatePendingTranscription(sessionId, {
      status: 'processing',
      transcript: selectedText,
    });

    let sessionCwd = '';
    let sessionRepo = currentActiveRepo;
    let preparedRepoRecommendation:
      | { recommendedIndex: number | null; reasoning: string; confidence: string }
      | undefined;

    if (
      get(isAutoRepoSelected) &&
      isRepoAutoSelectEnabled() &&
      activeReposList.length > 1
    ) {
      const repoRecommendation = await getRepoRecommendation(selectedText, activeReposList);

      if (repoRecommendation && !repoNeedsConfirmation(repoRecommendation.confidence)) {
        sessionRepo = currentRepos.list[repoRecommendation.repoIndex];
        sessionCwd = sessionRepo?.path || '';
        updatePendingWithRepoRecommendation(
          sessionId,
          repoRecommendation,
          sessionRepo?.name || 'Unknown'
        );
      } else {
        preparedRepoRecommendation = {
          recommendedIndex: repoRecommendation?.repoIndex ?? null,
          reasoning:
            repoRecommendation?.reasoning ?? 'Not enough information to determine repository',
          confidence: repoRecommendation?.confidence ?? 'low',
        };
        sessionCwd = '';
      }
    } else {
      sessionCwd = sessionRepo?.path || '';
    }

    const { model, effortLevel, recommendation } = await getModelRecommendation(
      selectedText,
      currentSettings.enabled_models
    );

    if (recommendation) {
      updatePendingWithModelRecommendation(sessionId, recommendation);
      await sdkSessions.updateSessionModel(sessionId, model);
      if (recommendation.effortLevel) {
        await sdkSessions.updateSessionEffort(sessionId, recommendation.effortLevel);
      }
    }

    const systemPrompt = buildSystemPrompt({
      repoPath: sessionCwd,
      repoName: sessionRepo?.name || '',
      includeTranscriptionNotice: false,
      allRepos: activeReposList,
    });

    sdkSessions.setPrepared(
      sessionId,
      selectedText,
      sessionCwd,
      systemPrompt,
      preparedRepoRecommendation
    );
  } catch (error) {
    console.error('[selection] Failed to prepare selection:', error);
  }
}

// ---------------------------------------------------------------------------
// Voice command handling
// ---------------------------------------------------------------------------

/**
 * Handle voice commands detected during recording.
 * Called from the event handler when Vosk detects a command phrase.
 *
 * `getPendingSessionId` and `clearPendingSessionId` are passed in from the
 * recording flow store to avoid a circular dependency.
 */
export async function handleVoiceCommand(
  commandType: VoiceCommandType,
  cleanedTranscript: string,
  _originalTranscript: string,
  getPendingSessionId: () => string | null,
  clearPendingSessionId: () => void,
  cleanupAudioVisualizationListener: () => void,
) {
  const pendingSessionId = getPendingSessionId();
  cleanupAudioVisualizationListener();

  if (commandType === 'transcribe') {
    if (pendingSessionId) {
      sdkSessions.cancelPendingTranscription(pendingSessionId);
      clearPendingSessionId();
    }

    recording.stopRecording(true).then(async (whisperTranscript) => {
      const transcriptToUse = whisperTranscript
        ? processVoiceCommand(whisperTranscript).cleanedTranscript
        : cleanedTranscript;

      if (transcriptToUse) {
        await invoke('paste_text', { text: transcriptToUse });
      }
    });
    return;
  }

  if (commandType === 'cancel') {
    if (pendingSessionId) {
      sdkSessions.cancelPendingTranscription(pendingSessionId);
      clearPendingSessionId();
    }
    await recording.cancelRecording();
    return;
  }

  if (commandType === 'note') {
    if (pendingSessionId) {
      sdkSessions.cancelPendingTranscription(pendingSessionId);
    }

    const noteSessionId = sdkSessions.createPendingNoteSession();
    sdkSessions.selectSession(noteSessionId);
    navigation.setView('sessions');
    sdkSessions.updatePendingTranscription(noteSessionId, { status: 'transcribing' });

    recording
      .stopRecording(true)
      .then(async (whisperTranscript) => {
        if (noteSessionId) {
          const audioData = get(recording).audioData;
          if (audioData) {
            sdkSessions.storeAudioData(noteSessionId, audioData);
          }
        }

        const finalTranscript = whisperTranscript
          ? processVoiceCommand(whisperTranscript).cleanedTranscript
          : cleanedTranscript;

        if (finalTranscript) {
          await handleTranscriptReady(finalTranscript, noteSessionId, cleanedTranscript, true);
        } else {
          sdkSessions.updatePendingTranscription(noteSessionId, {
            transcriptionError: 'No transcription available',
          });
        }

        clearPendingSessionId();
      })
      .catch((error) => {
        sdkSessions.updatePendingTranscription(noteSessionId, {
          transcriptionError: error?.message || 'Recording stop failed',
        });
        clearPendingSessionId();
      });
    return;
  }

  if (commandType === 'prepare') {
    const prepareSessionId =
      pendingSessionId ||
      sdkSessions.createPendingTranscriptionSession(
        get(settings).default_model,
        settingsToStoreEffort(get(settings).default_effort_level)
      );
    sdkSessions.selectSession(prepareSessionId);
    navigation.setView('sessions');
    sdkSessions.updatePendingTranscription(prepareSessionId, { status: 'transcribing' });

    recording
      .stopRecording(true)
      .then(async (whisperTranscript) => {
        if (prepareSessionId) {
          const audioData = get(recording).audioData;
          if (audioData) {
            sdkSessions.storeAudioData(prepareSessionId, audioData);
          }
        }

        const finalTranscript = whisperTranscript
          ? processVoiceCommand(whisperTranscript).cleanedTranscript
          : cleanedTranscript;

        if (finalTranscript) {
          await handlePrepareTranscriptReady(finalTranscript, prepareSessionId, cleanedTranscript);
        } else {
          sdkSessions.updatePendingTranscription(prepareSessionId, {
            transcriptionError: 'No transcription available',
          });
        }

        clearPendingSessionId();
      })
      .catch((error) => {
        sdkSessions.updatePendingTranscription(prepareSessionId, {
          transcriptionError: error?.message || 'Recording stop failed',
        });
        clearPendingSessionId();
      });
    return;
  }

  // 'send' command — stop and process
  if (pendingSessionId) {
    sdkSessions.updatePendingTranscription(pendingSessionId, { status: 'transcribing' });
  }

  recording
    .stopRecording(true)
    .then(async (whisperTranscript) => {
      if (pendingSessionId) {
        const audioData = get(recording).audioData;
        if (audioData) {
          sdkSessions.storeAudioData(pendingSessionId, audioData);
        }
      }

      const finalTranscript = whisperTranscript
        ? processVoiceCommand(whisperTranscript).cleanedTranscript
        : cleanedTranscript;

      if (finalTranscript) {
        await handleTranscriptReady(finalTranscript, pendingSessionId, cleanedTranscript);
      } else if (pendingSessionId) {
        sdkSessions.updatePendingTranscription(pendingSessionId, {
          transcriptionError: 'No transcription available',
        });
      }

      clearPendingSessionId();
    })
    .catch((error) => {
      if (pendingSessionId) {
        sdkSessions.updatePendingTranscription(pendingSessionId, {
          transcriptionError: error?.message || 'Recording stop failed',
        });
      }
      clearPendingSessionId();
    });
}

// ---------------------------------------------------------------------------
// Event handlers (for sessions: retry, approve, repo selection, launch)
// ---------------------------------------------------------------------------

/**
 * Retry transcription for a session that previously failed.
 */
export async function handleRetryTranscription(sessionId: string) {
  const currentSessions = get(sdkSessions);
  const session = currentSessions.find((s) => s.id === sessionId);

  if (!session || !session.pendingTranscription?.audioData) {
    console.error('[retry] No audio data available for retry');
    return;
  }

  sdkSessions.updatePendingTranscription(sessionId, {
    status: 'transcribing',
    transcriptionError: undefined,
  });

  try {
    const transcript = await invoke<string>('transcribe_audio', {
      audioData: Array.from(session.pendingTranscription.audioData),
    });

    if (transcript) {
      await handleTranscriptReady(transcript, sessionId, undefined);
    } else {
      sdkSessions.updatePendingTranscription(sessionId, {
        transcriptionError: 'No transcription returned',
      });
    }
  } catch (error) {
    console.error('[retry] Transcription failed:', error);
    sdkSessions.updatePendingTranscription(sessionId, {
      transcriptionError: error instanceof Error ? error.message : 'Transcription failed',
    });
  }
}

/**
 * Approve a pending transcription and send it.
 */
export async function handleApproveTranscription(sessionId: string, editedPrompt?: string) {
  const currentSessions = get(sdkSessions);
  const session = currentSessions.find((s) => s.id === sessionId);

  if (!session || session.status !== 'pending_approval') {
    console.warn('[approve] Session not found or not pending approval');
    return;
  }

  const prompt = editedPrompt || session.pendingApprovalPrompt;
  if (!prompt) {
    console.error('[approve] No prompt to send');
    return;
  }

  const currentSettings = get(settings);
  const currentRepos = get(repos);

  let systemPrompt = '';
  if (currentSettings.audio.include_transcription_notice) {
    const repo = currentRepos.list.find((r) => r.path === session!.cwd);
    systemPrompt = `The following prompt was voice-transcribed and may contain minor errors or homophones. `;
    if (repo) {
      systemPrompt += `The user is working in the "${repo.name}" repository.`;
    }
  }

  try {
    await sdkSessions.approveAndSend(sessionId, editedPrompt, systemPrompt || undefined);
  } catch (error) {
    console.error('[approve] Failed to approve and send:', error);
  }
}

/**
 * Handle user selecting a repo for a pending repo-selection session.
 */
export async function handleRepoSelectionForSession(
  sessionId: string,
  repoIndex: number,
  editedPrompt?: string
) {
  const currentSdkSessions = get(sdkSessions);
  const session = currentSdkSessions.find((s) => s.id === sessionId);
  if (!session || session.status !== 'pending_repo') return;

  const currentRepos = get(repos);
  const selectedRepo = currentRepos.list[repoIndex];
  if (!selectedRepo) return;

  const rawTranscript =
    editedPrompt || session.pendingPrompt || session.pendingRepoSelection?.transcript || '';

  console.log('[llm] User selected repo for session:', selectedRepo.name);

  const currentSettings = get(settings);
  if (currentSettings.audio.play_sound_on_repo_select) {
    playRepoSelectedSound();
  }

  await repos.setActiveRepo(repoIndex);

  const activeReposList = getActiveReposList();
  let finalTranscript = rawTranscript;
  if (isTranscriptionCleanupEnabled() && rawTranscript) {
    const repoContext = buildSingleRepoContext(selectedRepo);
    const cleanupResult = await cleanupTranscript(rawTranscript, undefined, repoContext);
    finalTranscript = cleanupResult.text;
  }

  const systemPrompt = buildSystemPrompt({
    repoPath: selectedRepo.path,
    repoName: selectedRepo.name,
    includeTranscriptionNotice: true,
    allRepos: activeReposList,
  });

  try {
    await sdkSessions.completeRepoSelection(
      sessionId,
      selectedRepo.path,
      systemPrompt,
      finalTranscript
    );
  } catch (error) {
    console.error('[session] Failed to complete repo selection:', error);
  }
}

/**
 * Launch a prepared session.
 */
export async function handleLaunchPrepared(sessionId: string, editedPrompt?: string) {
  try {
    await sdkSessions.launchPrepared(sessionId, editedPrompt);
  } catch (error) {
    console.error('[session] Failed to launch prepared session:', error);
  }
}

// ---------------------------------------------------------------------------
// Session setup handling
// ---------------------------------------------------------------------------

/**
 * Start a session from the setup view.
 */
export async function handleSetupSessionStart(
  sessionId: string,
  config: {
    prompt: string;
    images?: import('$lib/stores/sdkSessions').SdkImageContent[];
    model: string;
    effortLevel: EffortLevel;
    cwd: string;
    planMode: boolean;
    noteMode: boolean;
    provider?: import('$lib/utils/models').SdkProvider;
  }
) {
  const currentSettings = get(settings);
  const currentRepos = get(repos);
  const currentActiveRepo = get(activeRepo);
  const activeReposList = getActiveReposList();

  let repoPath = config.cwd;
  let needsAutoRepo = !repoPath || repoPath === '.';
  let selectedRepo = needsAutoRepo ? null : currentRepos.list.find((r) => r.path === repoPath);

  if (
    needsAutoRepo &&
    get(isAutoRepoSelected) &&
    isRepoAutoSelectEnabled() &&
    activeReposList.length > 1
  ) {
    const recommendation = await getRepoRecommendation(config.prompt, activeReposList);
    if (recommendation) {
      selectedRepo = currentRepos.list[recommendation.repoIndex];
      repoPath = selectedRepo?.path || '.';
    }
  }

  if (!selectedRepo && needsAutoRepo) {
    selectedRepo = currentActiveRepo;
    repoPath = selectedRepo?.path || '.';
  }

  let finalModel = config.model;
  let finalEffort = config.effortLevel;

  if (isAutoModel(config.model) && isModelRecommendationEnabled()) {
    const { model, effortLevel } = await getModelRecommendation(
      config.prompt,
      currentSettings.enabled_models
    );
    finalModel = model;
    if (effortLevel) finalEffort = effortLevel;
  }

  await sdkSessions.startSetupSession(sessionId, {
    prompt: config.prompt,
    images: config.images,
    cwd: repoPath,
    model: finalModel,
    effortLevel: finalEffort,
    planMode: config.planMode,
    noteMode: config.noteMode,
    provider: config.provider,
  });
}
