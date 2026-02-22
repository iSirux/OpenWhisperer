<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import Terminal from '$lib/components/Terminal.svelte';
  import SdkView from '$lib/components/SdkView.svelte';
  import SessionList from '$lib/components/SessionList.svelte';
  import SessionHeader from '$lib/components/SessionHeader.svelte';
  import Start from '$lib/components/Start.svelte';
  import SessionPendingView from '$lib/components/SessionPendingView.svelte';

  // Refactored components
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
    type EffortLevel,
    settingsToStoreEffort,
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
  import {
    activeExecution,
    activeExecutionId,
    loadExecutionHistory,
  } from '$lib/stores/sequenceExecutions';
  import { sequences, loadSequences } from '$lib/stores/sequences';
  import SequenceSessionView from '$lib/components/sequences/SequenceSessionView.svelte';

  // Tauri APIs
  import { invoke } from '@tauri-apps/api/core';
  import { goto } from '$app/navigation';
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

  // Listen for recording events dispatched by AppHeader (in the layout)
  function onHeaderStartRecording() {
    recordingFlow.startRecordingNewSession();
  }
  function onHeaderStopRecording() {
    recordingFlow.stopRecordingNewSession();
  }

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

    // Load sequences for execution view
    await loadSequences();
    await loadExecutionHistory();

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
      onOpenSettings: (tab) => goto(tab ? `/settings?tab=${tab}` : '/settings'),
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
    });

    // Listen for AppHeader recording events
    window.addEventListener('app:header-start-recording', onHeaderStartRecording);
    window.addEventListener('app:header-stop-recording', onHeaderStopRecording);
  });

  onDestroy(() => {
    eventHandlers.cleanup();
    openMicLifecycle.cleanup();
    recordingFlow.cleanup();
    sidebar.cleanup();
    hotkeyManager.cleanup();

    window.removeEventListener('app:header-start-recording', onHeaderStartRecording);
    window.removeEventListener('app:header-stop-recording', onHeaderStopRecording);

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
        const recommendedRepo = $settings.repos[repoRecommendation.repoIndex];
        updatePendingWithRepoRecommendation(
          pendingSessionId,
          repoRecommendation,
          recommendedRepo?.name || 'Unknown'
        );
      }
    }

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
          settingsToStoreEffort($settings.default_effort_level)
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

  async function processNoteTranscript(
    transcript: string,
    pendingSessionId: string | null
  ) {
    const repoPath = $activeRepo?.path || '.';

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
   * Process transcript for prepare mode - does all processing but stops short of launching
   */
  async function handlePrepareTranscriptReady(
    transcript: string,
    sessionId: string,
    voskTranscript?: string
  ) {
    if (!transcript.trim()) {
      sdkSessions.cancelPendingTranscription(sessionId);
      return;
    }

    sdkSessions.updatePendingTranscription(sessionId, {
      status: 'processing',
      transcript: transcript,
      voskTranscript: voskTranscript || undefined,
    });

    let finalTranscript = transcript;

    // Step 1: Clean up transcription
    if (isTranscriptionCleanupEnabled()) {
      const repoContext = buildAllReposContext($settings.repos);
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
    let sessionRepo = $activeRepo;
    let preparedRepoRecommendation: { recommendedIndex: number | null; reasoning: string; confidence: string } | undefined;

    if ($isAutoRepoSelected && isRepoAutoSelectEnabled() && $settings.repos.length > 1) {
      const repoRecommendation = await getRepoRecommendation(finalTranscript, $settings.repos);

      if (repoRecommendation && !repoNeedsConfirmation(repoRecommendation.confidence)) {
        // High confidence - auto-select repo
        sessionRepo = $settings.repos[repoRecommendation.repoIndex];
        sessionCwd = sessionRepo?.path || '';
        updatePendingWithRepoRecommendation(
          sessionId,
          repoRecommendation,
          sessionRepo?.name || 'Unknown'
        );
      } else {
        // Low/medium confidence - store recommendation for the prepared UI to show
        preparedRepoRecommendation = {
          recommendedIndex: repoRecommendation?.repoIndex ?? null,
          reasoning: repoRecommendation?.reasoning ?? 'Not enough information to determine repository',
          confidence: repoRecommendation?.confidence ?? 'low',
        };
        sessionCwd = ''; // No repo selected yet
      }
    } else {
      sessionCwd = sessionRepo?.path || '';
    }

    // Step 3: Get model recommendation
    const { model, effortLevel, recommendation } = await getModelRecommendation(
      finalTranscript,
      $settings.enabled_models
    );

    if (recommendation) {
      updatePendingWithModelRecommendation(sessionId, recommendation);
      await sdkSessions.updateSessionModel(sessionId, model);
      if (recommendation.effortLevel) {
        await sdkSessions.updateSessionEffort(sessionId, recommendation.effortLevel);
      }
    }

    // Step 4: Build system prompt
    const systemPrompt = sessionCwd ? buildSystemPrompt({
      repoPath: sessionCwd,
      repoName: sessionRepo?.name || '',
      includeTranscriptionNotice: true,
      allRepos: $settings.repos,
    }) : buildSystemPrompt({
      repoPath: '',
      repoName: '',
      includeTranscriptionNotice: true,
      allRepos: $settings.repos,
    });

    // Step 5: Set prepared status instead of launching
    sdkSessions.setPrepared(sessionId, finalTranscript, sessionCwd, systemPrompt, preparedRepoRecommendation);
    activeSessionId.set(null);
  }

  async function handleRepoSelectionNeeded(
    pendingSessionId: string | null,
    transcript: string,
    recommendedIndex: number | null,
    reasoning: string,
    confidence: string
  ) {
    const model = $settings.default_model;
    const effortLevel = settingsToStoreEffort($settings.default_effort_level);

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

    if (pendingSessionId) {
      sdkSessions.cancelPendingTranscription(pendingSessionId);
    }

    const sessionId = await sessions.createSession(finalTranscript);
    activeSessionId.set(sessionId);
    activeSdkSessionId.set(null);
  }

  async function completePendingSession(
    sessionId: string,
    transcript: string,
    repo: typeof $activeRepo
  ) {
    const repoPath = repo?.path || '.';
    const repoName = repo?.name || '';

    const { model, effortLevel, recommendation } = await getModelRecommendation(
      transcript,
      $settings.enabled_models
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
      allRepos: $settings.repos,
    });

    await sdkSessions.completePendingTranscription(sessionId, repoPath, transcript, systemPrompt);
    activeSessionId.set(null);
  }

  async function createSessionWithPrompt(transcript: string, repo: typeof $activeRepo) {
    const repoPath = repo?.path || '.';
    const repoName = repo?.name || '';

    const { model, effortLevel } = await getModelRecommendation(
      transcript,
      $settings.enabled_models
    );

    const systemPrompt = buildSystemPrompt({
      repoPath,
      repoName,
      includeTranscriptionNotice: true,
      allRepos: $settings.repos,
    });

    const sessionId = await sdkSessions.createSession(repoPath, model, effortLevel, systemPrompt);
    activeSdkSessionId.set(sessionId);
    await sdkSessions.sendPrompt(sessionId, transcript);
    activeSessionId.set(null);
  }

  // ==================== Voice Command Handling ====================

  async function handleVoiceCommand(
    commandType: VoiceCommandType,
    cleanedTranscript: string,
    _originalTranscript: string
  ) {
    const pendingSessionId = recordingFlow.getPendingSessionId();
    recordingFlow.cleanupAudioVisualizationListener();

    if (commandType === 'transcribe') {
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
      if (pendingSessionId) {
        sdkSessions.cancelPendingTranscription(pendingSessionId);
        recordingFlow.clearPendingSessionId();
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

    if (commandType === 'prepare') {
      // Prepare command - process transcription but don't start the session
      const prepareSessionId = pendingSessionId || sdkSessions.createPendingTranscriptionSession(
        $settings.default_model,
        settingsToStoreEffort($settings.default_effort_level)
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

          recordingFlow.clearPendingSessionId();
        })
        .catch((error) => {
          sdkSessions.updatePendingTranscription(prepareSessionId, {
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

  async function handleLaunchPrepared(sessionId: string, editedPrompt?: string) {
    try {
      await sdkSessions.launchPrepared(sessionId, editedPrompt);
    } catch (error) {
      console.error('[session] Failed to launch prepared session:', error);
    }
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

  function handleSessionClose() {
    if ($activeSdkSessionId) {
      sdkSessions.closeSession($activeSdkSessionId);
      activeSdkSessionId.set(null);
    }
  }

  // ==================== View Navigation ====================

  function showSessionsView() {
    navigation.setView('sessions');
  }

  // ==================== Session Setup ====================

  async function handleSetupSessionStart(
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
    let repoPath = config.cwd;
    let needsAutoRepo = !repoPath || repoPath === '.';
    let selectedRepo = needsAutoRepo ? null : $settings.repos.find((r) => r.path === repoPath);

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

    let finalModel = config.model;
    let finalEffort = config.effortLevel;

    if (isAutoModel(config.model) && isModelRecommendationEnabled()) {
      const { model, effortLevel } = await getModelRecommendation(
        config.prompt,
        $settings.enabled_models
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

  function handleSetupSessionCancel(sessionId: string) {
    sdkSessions.cancelSetupSession(sessionId);
    activeSdkSessionId.set(null);
  }
</script>

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
    {:else if currentView === 'sequences' && $activeExecution}
      <SequenceSessionView
        execution={$activeExecution}
        nodes={$sequences.find(s => s.id === $activeExecution.sequence_id)?.nodes ?? []}
      />
    {:else if $activeSdkSession}
      {@const activeSession = $activeSdkSession}
      {@const sessionId = activeSession.id}
      {@const isPendingState =
        activeSession.status === 'pending_repo' ||
        activeSession.status === 'initializing'}
      {@const isSetupState = activeSession.status === 'setup'}

      {#if isSetupState}
        <SessionSetupView
          initialModel={activeSession.model}
          initialEffortLevel={activeSession.effortLevel}
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
      <SessionHeader session={$activeSession} />
      <div class="terminal-wrapper flex-1 overflow-hidden">
        {#key $activeSession.id}
          <Terminal sessionId={$activeSession.id} />
        {/key}
      </div>
    {/if}
  </main>
</div>

<style>
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
