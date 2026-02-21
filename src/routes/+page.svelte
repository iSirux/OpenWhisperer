<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import Terminal from '$lib/components/Terminal.svelte';
  import SdkView from '$lib/components/SdkView.svelte';
  import SessionList from '$lib/components/SessionList.svelte';
  import SessionHeader from '$lib/components/SessionHeader.svelte';
  import Settings from './settings/+page.svelte';
  import Start from '$lib/components/Start.svelte';
  import SessionPendingView from '$lib/components/SessionPendingView.svelte';

  // Refactored components
  import AppHeader from '$lib/components/AppHeader.svelte';
  import SdkSessionHeader from '$lib/components/SdkSessionHeader.svelte';
  import SessionSidebarHeader from '$lib/components/SessionSidebarHeader.svelte';
  import SessionSetupView from '$lib/components/SessionSetupView.svelte';

  // Composables
  import { useSidebarResize } from '$lib/composables/useSidebarResize.svelte';
  import { useHotkeyManager } from '$lib/composables/useHotkeyManager.svelte';
  import { useRecordingFlow } from '$lib/composables/useRecordingFlow.svelte';
  import { useOpenMicLifecycle } from '$lib/composables/useOpenMic.svelte';
  import { useSessionEventHandlers } from '$lib/composables/useSessionEventHandlers.svelte';
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
    VOICE_TRANSCRIPTION_SYSTEM_PROMPT,
  } from '$lib/composables/useTranscriptionProcessor.svelte';

  // Stores
  import { sessions, activeSessionId, activeSession } from '$lib/stores/sessions';
  import {
    sdkSessions,
    activeSdkSessionId,
    activeSdkSession,
    type ThinkingLevel,
    settingsToStoreThinking,
  } from '$lib/stores/sdkSessions';
  import { settings, activeRepo, isAutoRepoSelected } from '$lib/stores/settings';
  import { recording, isRecording, pendingTranscriptions } from '$lib/stores/recording';
  import { overlay } from '$lib/stores/overlay';
  import { isOpenMicListening, isOpenMicPaused } from '$lib/stores/openMic';
  import {
    loadSessionsFromDisk,
    saveSessionsToDisk,
    setupAutoSave,
    setupPeriodicAutoSave,
  } from '$lib/stores/sessionPersistence';
  import { navigation } from '$lib/stores/navigation';

  // Tauri APIs
  import { invoke } from '@tauri-apps/api/core';
  import { get } from 'svelte/store';

  // Utils
  import {
    isTranscriptionCleanupEnabled,
    isModelRecommendationEnabled,
    isRepoAutoSelectEnabled,
    getRepoConfirmationSystemPrompt,
  } from '$lib/utils/llm';
  import { isAutoModel } from '$lib/utils/models';
  import { processVoiceCommand, type VoiceCommandType } from '$lib/utils/voiceCommands';
  import { playRepoSelectedSound } from '$lib/utils/sound';

  // Constants
  const PROMPT_PREVIEW_LENGTH = 80;

  // Initialize composables
  const sidebar = useSidebarResize();
  const hotkeyManager = useHotkeyManager();
  const recordingFlow = useRecordingFlow();
  const openMicLifecycle = useOpenMicLifecycle();
  const eventHandlers = useSessionEventHandlers();

  // Cleanup handlers
  let cleanupAutoSave: (() => void) | null = null;
  let cleanupPeriodicSave: (() => void) | null = null;

  // Current view from navigation store
  let currentView = $derived($navigation.mainView);
  let settingsTabFromNav = $derived($navigation.settingsTab);

  // Reference to SdkView for focusing prompt input
  let sdkViewRef: { focusPromptInput: () => void } | undefined;

  // Active SDK session header info
  let activeSdkSessionBranch = $state<string | null>(null);

  // Computed values for the active SDK session header
  let activeSdkRepoName = $derived(
    !$activeSdkSession?.cwd || $activeSdkSession?.cwd === '.'
      ? ''
      : $activeSdkSession?.cwd?.split(/[/\\]/).pop() || $activeSdkSession?.cwd || ''
  );

  let activeSdkFirstPrompt = $derived(() => {
    const firstUserMessage = $activeSdkSession?.messages.find((m) => m.type === 'user');
    if (!firstUserMessage?.content) return null;
    const content = firstUserMessage.content.trim();
    if (content.length <= PROMPT_PREVIEW_LENGTH) return content;
    return content.slice(0, PROMPT_PREVIEW_LENGTH) + '...';
  });

  // Track last fetched cwd to avoid redundant IPC calls
  let lastFetchedBranchCwd = '';

  // Effect to fetch branch when active SDK session's cwd changes
  $effect(() => {
    const cwd = $activeSdkSession?.cwd;
    // Only fetch if cwd actually changed
    if (cwd !== lastFetchedBranchCwd) {
      lastFetchedBranchCwd = cwd ?? '';
      if (cwd && cwd !== '.') {
        invoke<string>('get_git_branch', { repoPath: cwd })
          .then((b) => {
            activeSdkSessionBranch = b;
          })
          .catch(() => {
            activeSdkSessionBranch = null;
          });
      } else {
        activeSdkSessionBranch = null;
      }
    }
  });

  // Effect to re-register hotkeys when toggle_recording hotkey changes
  $effect(() => {
    const currentHotkey = $settings.hotkeys.toggle_recording;
    if (hotkeyManager.checkForHotkeyChange(currentHotkey)) {
      hotkeyManager.setup({
        onStartRecording: () => recordingFlow.startRecordingFromHotkey(),
        onStopAndSend: () => recordingFlow.stopRecordingFromHotkey(),
        onStopAndPaste: () => recordingFlow.handleTranscribeToInput(),
        onStartNoteRecording: () => recordingFlow.startRecordingForNoteMode(),
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

  onMount(async () => {
    await settings.load();

    // Apply saved theme
    document.documentElement.setAttribute('data-theme', $settings.theme);

    // Initialize sidebar
    sidebar.initFromSettings();

    await sessions.load();
    sessions.setupListeners();

    // Load persisted sessions if enabled
    if ($settings.session_persistence.enabled) {
      await loadSessionsFromDisk();
    }

    // Switch to sessions view if there are sessions
    if (($sessions.length > 0 || $sdkSessions.length > 0) && $navigation.mainView === 'start') {
      navigation.setView('sessions');
    }

    // Setup auto-save
    cleanupAutoSave = setupAutoSave();
    cleanupPeriodicSave = setupPeriodicAutoSave();

    // Initialize recording flow
    recordingFlow.init({
      onTranscriptReady: handleTranscriptReady,
      onRegisterRecordingHotkeys: () => hotkeyManager.registerRecordingHotkeys(),
      onUnregisterRecordingHotkeys: () => hotkeyManager.unregisterRecordingHotkeys(),
    });

    // Initialize event handlers
    eventHandlers.init({
      onShowSessions: showSessionsView,
      onOpenSettings: (tab) => navigation.showSettings(tab),
      onCloseSettings: showSessionsView,
      onRetryTranscription: handleRetryTranscription,
      onApproveTranscription: handleApproveTranscription,
      onSelectRepoForSession: handleRepoSelectionForSession,
      onFocusSdkPrompt: handleFocusSdkPrompt,
      onSwitchToSession: handleSwitchToSession,
      onCancelRecording: recordingFlow.cancelRecording,
      onSendRecording: recordingFlow.stopRecordingFromHotkey,
      onStartRecordingFromOpenMic: recordingFlow.startRecordingFromOpenMic,
      onVoiceCommand: handleVoiceCommand,
      onUnregisterRecordingHotkeys: () => hotkeyManager.unregisterRecordingHotkeys(),
    });

    // Setup event listeners
    await eventHandlers.setup();

    // Setup hotkeys
    await hotkeyManager.setup({
      onStartRecording: () => recordingFlow.startRecordingFromHotkey(),
      onStopAndSend: () => recordingFlow.stopRecordingFromHotkey(),
      onStopAndPaste: () => recordingFlow.handleTranscribeToInput(),
      onStartNoteRecording: () => recordingFlow.startRecordingForNoteMode(),
    });
  });

  onDestroy(() => {
    eventHandlers.cleanup();
    openMicLifecycle.cleanup();
    recordingFlow.cleanup();
    sidebar.cleanup();
    hotkeyManager.cleanup();

    if (cleanupAutoSave) cleanupAutoSave();
    if (cleanupPeriodicSave) cleanupPeriodicSave();

    saveSessionsToDisk();
  });

  // ==================== Transcript Processing ====================

  /**
   * Handle a transcript that's ready to be processed
   */
  async function handleTranscriptReady(
    transcript: string,
    pendingSessionId: string | null,
    voskTranscript?: string,
    isNoteMode?: boolean
  ) {
    // Note: Voice commands are detected via Vosk in real-time only
    // (see voice-command-triggered event in useSessionEventHandlers)
    // We don't check Whisper transcripts for voice commands to avoid false positives

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

    if ($settings.terminal_mode === 'Sdk') {
      // Check if we're in note mode (from hotkey)
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
   * Process transcript for SDK mode
   */
  async function processSdkTranscript(
    transcript: string,
    pendingSessionId: string | null,
    voskTranscript?: string
  ) {
    let finalTranscript = transcript;

    // Step 1: Clean up transcription
    if (isTranscriptionCleanupEnabled()) {
      const repoContext = buildAllReposContext($settings.repos);
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
    let repoRecommendation: Awaited<ReturnType<typeof getRepoRecommendation>> = null;

    if ($isAutoRepoSelected && isRepoAutoSelectEnabled() && $settings.repos.length > 1) {
      repoRecommendation = await getRepoRecommendation(finalTranscript, $settings.repos);

      if (!repoRecommendation || repoNeedsConfirmation(repoRecommendation.confidence)) {
        // Need user to select repo
        await handleRepoSelectionNeeded(
          pendingSessionId,
          finalTranscript,
          repoRecommendation?.repoIndex ?? null,
          repoRecommendation?.reasoning ?? 'Not enough information to determine repository',
          repoRecommendation?.confidence ?? 'low'
        );
        return;
      }

      // Update pending session with recommendation
      if (pendingSessionId && repoRecommendation) {
        const recommendedRepo = $settings.repos[repoRecommendation.repoIndex];
        updatePendingWithRepoRecommendation(
          pendingSessionId,
          repoRecommendation,
          recommendedRepo?.name || 'Unknown'
        );
      }
    }

    // Determine repo for session
    const sessionRepo = repoRecommendation
      ? $settings.repos[repoRecommendation.repoIndex]
      : $activeRepo;

    // Check if approval is required
    if ($settings.audio.require_transcription_approval) {
      const repoPath = sessionRepo?.path || '.';
      if (pendingSessionId) {
        sdkSessions.setPendingApproval(pendingSessionId, finalTranscript, repoPath);
      } else {
        const newSessionId = sdkSessions.createPendingTranscriptionSession(
          $settings.default_model,
          settingsToStoreThinking($settings.default_thinking_level)
        );
        sdkSessions.setPendingApproval(newSessionId, finalTranscript, repoPath);
        activeSdkSessionId.set(newSessionId);
        activeSessionId.set(null);
      }
      navigation.setView('sessions');
      return;
    }

    // Create/complete session
    if (pendingSessionId) {
      await completePendingSession(pendingSessionId, finalTranscript, sessionRepo);
    } else {
      await createSessionWithPrompt(finalTranscript, sessionRepo);
    }
  }

  /**
   * Process transcript for note-taking mode
   */
  async function processNoteTranscript(
    transcript: string,
    pendingSessionId: string | null
  ) {
    // Note mode always uses the active repo (or '.' if none)
    const repoPath = $activeRepo?.path || '.';

    // Clean up transcription if enabled
    let finalTranscript = transcript;
    if (isTranscriptionCleanupEnabled()) {
      const repoContext = $activeRepo ? buildSingleRepoContext($activeRepo) : undefined;
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

    // Complete the note session
    if (pendingSessionId) {
      await sdkSessions.completePendingNoteSession(pendingSessionId, repoPath, finalTranscript);
      activeSessionId.set(null);
    } else {
      // Create a new note session if we don't have a pending one
      const sessionId = sdkSessions.createPendingNoteSession();
      sdkSessions.selectSession(sessionId);
      await sdkSessions.completePendingNoteSession(sessionId, repoPath, finalTranscript);
      activeSdkSessionId.set(sessionId);
      activeSessionId.set(null);
    }

    navigation.setView('sessions');
  }

  /**
   * Handle repo selection needed scenario
   */
  async function handleRepoSelectionNeeded(
    pendingSessionId: string | null,
    transcript: string,
    recommendedIndex: number | null,
    reasoning: string,
    confidence: string
  ) {
    const model = $settings.default_model;
    const thinkingLevel = settingsToStoreThinking($settings.default_thinking_level);

    if (pendingSessionId) {
      await sdkSessions.completePendingTranscription(pendingSessionId, '', transcript, undefined, {
        transcript,
        recommendedIndex,
        reasoning,
        confidence,
      });
      navigation.setView('sessions');
    } else {
      sdkSessions.createPendingRepoSession(model, thinkingLevel, {
        transcript,
        recommendedIndex,
        reasoning,
        confidence,
      });
    }
  }

  /**
   * Process transcript for PTY mode
   */
  async function processPtyTranscript(
    transcript: string,
    pendingSessionId: string | null,
    voskTranscript?: string
  ) {
    let finalTranscript = transcript;

    if (isTranscriptionCleanupEnabled()) {
      const repoContext = $activeRepo ? buildSingleRepoContext($activeRepo) : undefined;
      const cleanupResult = await cleanupTranscript(transcript, voskTranscript, repoContext);
      finalTranscript = cleanupResult.text;
    }

    // Clear any pending SDK session (PTY mode doesn't use them)
    if (pendingSessionId) {
      sdkSessions.cancelPendingTranscription(pendingSessionId);
    }

    const sessionId = await sessions.createSession(finalTranscript);
    activeSessionId.set(sessionId);
    activeSdkSessionId.set(null);
  }

  /**
   * Complete a pending transcription session
   */
  async function completePendingSession(
    sessionId: string,
    transcript: string,
    repo: typeof $activeRepo
  ) {
    const repoPath = repo?.path || '.';
    const repoName = repo?.name || '';

    // Get model (handling auto mode)
    const { model, thinkingLevel, recommendation } = await getModelRecommendation(
      transcript,
      $settings.enabled_models
    );

    if (recommendation) {
      updatePendingWithModelRecommendation(sessionId, recommendation);
      await sdkSessions.updateSessionModel(sessionId, model);
      if (recommendation.thinkingLevel) {
        await sdkSessions.updateSessionThinking(sessionId, recommendation.thinkingLevel);
      }
    }

    // Build system prompt
    const systemPrompt = buildSystemPrompt({
      repoPath,
      repoName,
      includeTranscriptionNotice: true,
      allRepos: $settings.repos,
    });

    await sdkSessions.completePendingTranscription(sessionId, repoPath, transcript, systemPrompt);
    activeSessionId.set(null);
  }

  /**
   * Create a new SDK session with a prompt
   */
  async function createSessionWithPrompt(transcript: string, repo: typeof $activeRepo) {
    const repoPath = repo?.path || '.';
    const repoName = repo?.name || '';

    const { model, thinkingLevel } = await getModelRecommendation(
      transcript,
      $settings.enabled_models
    );

    const systemPrompt = buildSystemPrompt({
      repoPath,
      repoName,
      includeTranscriptionNotice: true,
      allRepos: $settings.repos,
    });

    const sessionId = await sdkSessions.createSession(repoPath, model, thinkingLevel, systemPrompt);
    activeSdkSessionId.set(sessionId);
    await sdkSessions.sendPrompt(sessionId, transcript);
    activeSessionId.set(null);
  }

  // ==================== Voice Command Handling ====================

  /**
   * Handle voice command detected during recording
   */
  async function handleVoiceCommand(
    commandType: VoiceCommandType,
    cleanedTranscript: string,
    _originalTranscript: string
  ) {
    const pendingSessionId = recordingFlow.getPendingSessionId();
    recordingFlow.cleanupAudioVisualizationListener();

    if (commandType === 'transcribe') {
      // Paste transcript instead of sending
      if (pendingSessionId) {
        sdkSessions.cancelPendingTranscription(pendingSessionId);
        recordingFlow.clearPendingSessionId();
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
      // Discard recording
      if (pendingSessionId) {
        sdkSessions.cancelPendingTranscription(pendingSessionId);
        recordingFlow.clearPendingSessionId();
      }
      await recording.cancelRecording();
      return;
    }

    if (commandType === 'note') {
      // Note mode - cancel existing pending session and create note session
      if (pendingSessionId) {
        sdkSessions.cancelPendingTranscription(pendingSessionId);
      }

      // Create a new pending note session
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

          recordingFlow.clearPendingSessionId();
        })
        .catch((error) => {
          sdkSessions.updatePendingTranscription(noteSessionId, {
            transcriptionError: error?.message || 'Recording stop failed',
          });
          recordingFlow.clearPendingSessionId();
        });
      return;
    }

    // Send command - stop and process
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

        recordingFlow.clearPendingSessionId();
      })
      .catch((error) => {
        if (pendingSessionId) {
          sdkSessions.updatePendingTranscription(pendingSessionId, {
            transcriptionError: error?.message || 'Recording stop failed',
          });
        }
        recordingFlow.clearPendingSessionId();
      });
  }

  // ==================== Event Handlers ====================

  async function handleRetryTranscription(sessionId: string) {
    let session: (typeof $sdkSessions)[0] | undefined;
    sdkSessions.subscribe((sessions) => {
      session = sessions.find((s) => s.id === sessionId);
    })();

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

  async function handleApproveTranscription(sessionId: string, editedPrompt?: string) {
    let session: (typeof $sdkSessions)[0] | undefined;
    sdkSessions.subscribe((sessions) => {
      session = sessions.find((s) => s.id === sessionId);
    })();

    if (!session || session.status !== 'pending_approval') {
      console.warn('[approve] Session not found or not pending approval');
      return;
    }

    const prompt = editedPrompt || session.pendingApprovalPrompt;
    if (!prompt) {
      console.error('[approve] No prompt to send');
      return;
    }

    let systemPrompt = '';
    if ($settings.audio.include_transcription_notice) {
      const repo = $settings.repos.find((r) => r.path === session!.cwd);
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

  async function handleRepoSelectionForSession(
    sessionId: string,
    repoIndex: number,
    editedPrompt?: string
  ) {
    const session = $sdkSessions.find((s) => s.id === sessionId);
    if (!session || session.status !== 'pending_repo') return;

    const selectedRepo = $settings.repos[repoIndex];
    if (!selectedRepo) return;

    const rawTranscript =
      editedPrompt || session.pendingPrompt || session.pendingRepoSelection?.transcript || '';

    console.log('[llm] User selected repo for session:', selectedRepo.name);

    if ($settings.audio.play_sound_on_repo_select) {
      playRepoSelectedSound();
    }

    await settings.setActiveRepo(repoIndex);

    // Clean transcription with repo context
    let finalTranscript = rawTranscript;
    if (isTranscriptionCleanupEnabled() && rawTranscript) {
      const repoContext = buildSingleRepoContext(selectedRepo);
      const cleanupResult = await cleanupTranscript(rawTranscript, undefined, repoContext);
      finalTranscript = cleanupResult.text;
    }

    // Build system prompt
    const systemPrompt = buildSystemPrompt({
      repoPath: selectedRepo.path,
      repoName: selectedRepo.name,
      includeTranscriptionNotice: true,
      allRepos: $settings.repos,
    });

    try {
      await sdkSessions.completeRepoSelection(sessionId, selectedRepo.path, systemPrompt, finalTranscript);
    } catch (error) {
      console.error('[session] Failed to complete repo selection:', error);
    }
  }

  async function handleFocusSdkPrompt() {
    await tick();
    sdkViewRef?.focusPromptInput();
  }

  function handleSwitchToSession(sessionId: string) {
    activeSdkSessionId.set(sessionId);
    activeSessionId.set(null);
    navigation.setView('sessions');
  }

  function handlePendingRepoSelection(index: number, editedPrompt?: string) {
    const session = $activeSdkSession;
    if (!session || session.status !== 'pending_repo') return;
    handleRepoSelectionForSession(session.id, index, editedPrompt);
  }

  async function handlePendingSessionCancel() {
    if (!$activeSdkSessionId) return;
    console.log('[session] User cancelled pending session');
    await sdkSessions.closeSession($activeSdkSessionId);
    activeSdkSessionId.set(null);
  }

  // ==================== Session Model/Thinking Handlers ====================

  function handleSessionModelChange(newModel: string) {
    if ($activeSdkSessionId) {
      sdkSessions.updateSessionModel($activeSdkSessionId, newModel);
    }
  }

  function handleSessionThinkingChange(newLevel: ThinkingLevel) {
    if ($activeSdkSessionId) {
      sdkSessions.updateSessionThinking($activeSdkSessionId, newLevel);
    }
  }

  function handleSessionClose() {
    if ($activeSdkSessionId) {
      sdkSessions.closeSession($activeSdkSessionId);
      activeSdkSessionId.set(null);
    }
  }

  // ==================== View Navigation ====================

  function showSettingsView() {
    navigation.showSettings();
  }

  function showSessionsView() {
    navigation.setView('sessions');
  }

  function showStartView() {
    navigation.setView('start');
  }

  async function selectRepo(index: number) {
    await settings.setActiveRepo(index);
  }

  async function enableAutoRepo() {
    await settings.setAutoRepoMode(true);
  }

  async function changeModel(newModel: string) {
    settings.update((s) => ({ ...s, default_model: newModel }));
    await settings.save({ ...$settings, default_model: newModel });
  }

  async function changeThinking(newLevel: ThinkingLevel) {
    const settingsLevel = newLevel === null ? 'off' : newLevel;
    settings.update((s) => ({ ...s, default_thinking_level: settingsLevel }));
    await settings.save({ ...$settings, default_thinking_level: settingsLevel });
  }

  async function changeAutoModelThinking(newSetting: import('$lib/stores/settings').AutoModelThinking) {
    settings.update((s) => ({
      ...s,
      llm: {
        ...s.llm,
        features: {
          ...s.llm.features,
          auto_model_thinking: newSetting,
        },
      },
    }));
    await settings.save({
      ...$settings,
      llm: {
        ...$settings.llm,
        features: {
          ...$settings.llm.features,
          auto_model_thinking: newSetting,
        },
      },
    });
  }

  function openSettingsTab(tab: string) {
    navigation.showSettings(tab);
  }

  // ==================== Session Setup ====================

  function handleNewSession() {
    const model = $settings.default_model;
    const thinkingLevel = settingsToStoreThinking($settings.default_thinking_level);
    const sessionId = sdkSessions.createSetupSession(model, thinkingLevel, false);

    activeSdkSessionId.set(sessionId);
    activeSessionId.set(null);
    navigation.setView('sessions');
  }

  async function handleSetupSessionStart(
    sessionId: string,
    config: {
      prompt: string;
      images?: import('$lib/stores/sdkSessions').SdkImageContent[];
      model: string;
      thinkingLevel: ThinkingLevel;
      cwd: string;
      planMode: boolean;
      noteMode: boolean;
    }
  ) {
    let repoPath = config.cwd;
    let needsAutoRepo = !repoPath || repoPath === '.';
    let selectedRepo = needsAutoRepo ? null : $settings.repos.find((r) => r.path === repoPath);

    // Auto-repo selection
    if (needsAutoRepo && $isAutoRepoSelected && isRepoAutoSelectEnabled() && $settings.repos.length > 1) {
      const recommendation = await getRepoRecommendation(config.prompt, $settings.repos);
      if (recommendation) {
        selectedRepo = $settings.repos[recommendation.repoIndex];
        repoPath = selectedRepo?.path || '.';
      }
    }

    if (!selectedRepo && needsAutoRepo) {
      selectedRepo = $activeRepo;
      repoPath = selectedRepo?.path || '.';
    }

    // Handle auto model
    let finalModel = config.model;
    let finalThinking = config.thinkingLevel;

    if (isAutoModel(config.model) && isModelRecommendationEnabled()) {
      const { model, thinkingLevel } = await getModelRecommendation(
        config.prompt,
        $settings.enabled_models
      );
      finalModel = model;
      if (thinkingLevel) finalThinking = thinkingLevel;
    }

    await sdkSessions.startSetupSession(sessionId, {
      prompt: config.prompt,
      images: config.images,
      cwd: repoPath,
      model: finalModel,
      thinkingLevel: finalThinking,
      planMode: config.planMode,
      noteMode: config.noteMode,
    });
  }

  function handleSetupSessionCancel(sessionId: string) {
    sdkSessions.cancelSetupSession(sessionId);
    activeSdkSessionId.set(null);
  }
</script>

<div class="app-container h-screen flex flex-col bg-background">
  <AppHeader
    repos={$settings.repos}
    activeRepoIndex={$settings.active_repo_index}
    activeRepo={$activeRepo}
    isAutoRepoSelected={$isAutoRepoSelected}
    defaultModel={$settings.default_model}
    defaultThinkingLevel={settingsToStoreThinking($settings.default_thinking_level)}
    autoModelThinking={$settings.llm.features.auto_model_thinking}
    isRecording={$isRecording}
    isRecordingForNewSession={recordingFlow.isRecordingForNewSession}
    pendingTranscriptions={$pendingTranscriptions}
    {currentView}
    onShowStart={showStartView}
    onShowSettings={showSettingsView}
    onShowSessions={showSessionsView}
    onOpenSettingsTab={openSettingsTab}
    onSelectRepo={selectRepo}
    onEnableAutoRepo={enableAutoRepo}
    onChangeModel={changeModel}
    onChangeThinking={changeThinking}
    onChangeAutoModelThinking={changeAutoModelThinking}
    onStartRecording={recordingFlow.startRecordingNewSession}
    onStopRecording={recordingFlow.stopRecordingNewSession}
  />

  <div class="main-content flex-1 flex overflow-hidden">
    <aside
      class="sidebar border-r border-border bg-surface flex flex-col relative"
      style="width: {sidebar.width}px; min-width: {sidebar.minWidth}px; max-width: {sidebar.maxWidth}px;"
    >
      <SessionSidebarHeader
        sessions={$sessions}
        sdkSessions={$sdkSessions}
        {currentView}
        markSessionsUnread={$settings.mark_sessions_unread}
        onShowSessions={showSessionsView}
      />
      <div class="flex-1 overflow-hidden">
        <SessionList {currentView} />
      </div>
      <!-- Resize handle -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="resize-handle absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-accent/50 transition-colors"
        class:bg-accent={sidebar.isResizing}
        onmousedown={sidebar.startResize}
      ></div>
    </aside>

    <main class="flex-1 flex flex-col overflow-hidden">
      {#if currentView === 'start'}
        <Start />
      {:else if currentView === 'settings'}
        <Settings initialTab={settingsTabFromNav} />
      {:else if $activeSdkSession}
        <!-- SDK Mode Session -->
        {@const activeSession = $activeSdkSession}
        {@const sessionId = activeSession.id}
        {@const isPendingState =
          activeSession.status === 'pending_repo' ||
          activeSession.status === 'initializing'}
        {@const isSetupState = activeSession.status === 'setup'}

        {#if isSetupState}
          <SessionSetupView
            initialModel={activeSession.model}
            initialThinkingLevel={activeSession.thinkingLevel}
            initialCwd={$activeRepo?.path || ''}
            initialPlanMode={activeSession.planMode?.isActive || false}
            isRecordingForSetup={recordingFlow.isRecordingForSetup}
            onStart={(config) => handleSetupSessionStart(sessionId, config)}
            onStartRecording={recordingFlow.startRecordingForSetup}
            onStopRecording={recordingFlow.stopRecordingForSetup}
            onCancel={() => handleSetupSessionCancel(sessionId)}
          />
        {:else}
          <SdkSessionHeader
            createdAt={activeSession.createdAt}
            messages={activeSession.messages}
            isPending={isPendingState}
            repoName={activeSdkRepoName}
            branch={activeSdkSessionBranch}
            firstPrompt={activeSdkFirstPrompt()}
            onClose={handleSessionClose}
            onCancel={handlePendingSessionCancel}
          />

          {#if isPendingState}
            <div class="terminal-wrapper flex-1 overflow-hidden">
              <SessionPendingView
                status={activeSession.status as 'pending_repo' | 'initializing'}
                repos={$settings.repos}
                pendingSelection={activeSession.pendingRepoSelection}
                pendingPrompt={activeSession.pendingPrompt}
                onSelectRepo={handlePendingRepoSelection}
                onCancel={handlePendingSessionCancel}
              />
            </div>
          {:else}
            <div class="terminal-wrapper flex-1 overflow-hidden">
              {#key sessionId}
                <SdkView bind:this={sdkViewRef} sessionId={sessionId} />
              {/key}
            </div>
          {/if}
        {/if}
      {:else if $activeSession}
        <!-- PTY Mode Session -->
        <SessionHeader session={$activeSession} />
        <div class="terminal-wrapper flex-1 overflow-hidden">
          {#key $activeSession.id}
            <Terminal sessionId={$activeSession.id} />
          {/key}
        </div>
      {/if}
    </main>
  </div>
</div>

<style>
  .app-container {
    user-select: none;
  }

  .terminal-wrapper {
    min-height: 0;
  }

  .resize-handle {
    padding-left: 3px;
    padding-right: 3px;
    margin-right: -3px;
    background-clip: content-box;
  }

  .resize-handle:hover,
  .resize-handle.bg-accent {
    background-color: var(--color-accent);
    opacity: 0.5;
  }

  .resize-handle.bg-accent {
    opacity: 1;
  }

  .sidebar {
    flex-shrink: 0;
  }
</style>
