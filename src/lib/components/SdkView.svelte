<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import {
    sdkSessions,
    type SdkMessage,
    type SdkSession,
    type SdkImageContent,
    type EffortLevel,
    type PlanningAnswer,
  } from "$lib/stores/sdkSessions";
  import { recording, isRecording, isTranscribing } from "$lib/stores/recording";
  import { settings, isAutoRepoSelected } from "$lib/stores/settings";
  import { overlay } from "$lib/stores/overlay";
  import { invoke } from "@tauri-apps/api/core";
  import SdkUsageBar from "./sdk/SdkUsageBar.svelte";
  import SdkMessageComponent from "./sdk/SdkMessage.svelte";
  import SdkLoadingIndicator from "./sdk/SdkLoadingIndicator.svelte";
  import SdkPromptInput from "./sdk/SdkPromptInput.svelte";
  import SessionRecordingHeader from "./sdk/SessionRecordingHeader.svelte";
  import SdkQuickActions from "./sdk/SdkQuickActions.svelte";
  import PlanningWizard from "./sdk/PlanningWizard.svelte";
  import PlanModeBanner from "./sdk/PlanModeBanner.svelte";
  import SdkToolGrid from "./sdk/SdkToolGrid.svelte";
  import ModelSelector from "./ModelSelector.svelte";
  import EffortToggle from "./EffortToggle.svelte";
  import RepoSelector from "./RepoSelector.svelte";
  import {
    recommendModel,
    recommendRepo,
    isModelRecommendationEnabled,
    isRepoAutoSelectEnabled,
    isTranscriptionCleanupEnabled,
    needsUserConfirmation,
  } from "$lib/utils/llm";
  import {
    processVoiceCommands,
    cleanupTranscript,
    buildSingleRepoContext,
  } from "$lib/composables/useTranscriptionProcessor.svelte";
  import { get } from "svelte/store";

  let { sessionId }: { sessionId: string } = $props();

  let copiedMessageId = $state<number | null>(null);
  let messagesEl: HTMLDivElement;
  let session = $state<SdkSession | null>(null);
  let unsubscribe: (() => void) | undefined;

  // Track scroll positions per session (module-level to persist across component re-renders)
  const scrollPositions = new Map<string, number>();

  let messages = $derived(session?.messages ?? []);

  // Process messages to merge tool_start/tool_result pairs
  // - Skip tool_start if there's a matching tool_result
  // - Copy input from tool_start to tool_result for display
  // - Completed tools are shown in the order they STARTED, not completed
  // - Supports both toolUseId matching (new) and sequential matching (legacy sessions)
  let processedMessages = $derived(() => {
    const result: SdkMessage[] = [];
    const msgs = messages;

    // Check if this session has toolUseIds (new format) or not (legacy)
    const hasToolUseIds = msgs.some((m) => m.toolUseId);

    if (hasToolUseIds) {
      // NEW FORMAT: Match by toolUseId
      // Build a map of toolUseId -> tool_result message
      const toolResults = new Map<string, SdkMessage>();
      for (const msg of msgs) {
        if (msg.type === "tool_result" && msg.toolUseId) {
          toolResults.set(msg.toolUseId, msg);
        }
      }

      // Build a map of toolUseId -> input from tool_start
      const toolInputs = new Map<string, Record<string, unknown>>();
      for (const msg of msgs) {
        if (msg.type === "tool_start" && msg.toolUseId && msg.input) {
          toolInputs.set(msg.toolUseId, msg.input);
        }
      }

      // Track which tool_results we've already output (to avoid duplicates)
      const outputToolIds = new Set<string>();

      for (const msg of msgs) {
        if (msg.type === "tool_start") {
          // Check if this tool has a result
          if (msg.toolUseId && toolResults.has(msg.toolUseId)) {
            // Tool completed - output the result at the START position (preserving start order)
            const resultMsg = toolResults.get(msg.toolUseId)!;
            const input = toolInputs.get(msg.toolUseId);
            result.push({ ...resultMsg, input });
            outputToolIds.add(msg.toolUseId);
          } else {
            // Tool still running - show tool_start
            result.push(msg);
          }
        } else if (msg.type === "tool_result") {
          // Skip tool_results here - they're output at tool_start position above
          // (Unless it wasn't matched, which shouldn't happen but handle gracefully)
          if (!msg.toolUseId || !outputToolIds.has(msg.toolUseId)) {
            const input = msg.toolUseId ? toolInputs.get(msg.toolUseId) : undefined;
            result.push({ ...msg, input });
          }
        } else {
          result.push(msg);
        }
      }
    } else {
      // LEGACY FORMAT: Match sequentially by tool name
      // For each tool_start at index i, check if there's a tool_result for the same tool after it
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];

        if (msg.type === "tool_start") {
          // Look for the next tool_result with the same tool name
          let hasResult = false;
          let resultIndex = -1;
          for (let j = i + 1; j < msgs.length; j++) {
            if (msgs[j].type === "tool_result" && msgs[j].tool === msg.tool) {
              hasResult = true;
              resultIndex = j;
              break;
            }
            // Stop if we hit another tool_start for the same tool (parallel calls)
            if (msgs[j].type === "tool_start" && msgs[j].tool === msg.tool) {
              break;
            }
          }
          // Only show tool_start if it doesn't have a result yet
          if (!hasResult) {
            result.push(msg);
          }
        } else if (msg.type === "tool_result") {
          // Find the matching tool_start to get its input
          let toolInput: Record<string, unknown> | undefined;
          for (let j = i - 1; j >= 0; j--) {
            if (msgs[j].type === "tool_start" && msgs[j].tool === msg.tool) {
              toolInput = msgs[j].input;
              break;
            }
          }
          result.push({ ...msg, input: toolInput });
        } else {
          result.push(msg);
        }
      }
    }

    return result;
  });

  // Group messages for rendering based on tool_display_mode setting
  // Returns an array of render items: either single messages or tool groups
  type RenderItem =
    | { type: 'message'; message: SdkMessage }
    | { type: 'tool_group'; tools: SdkMessage[] };

  let renderItems = $derived(() => {
    // Filter out subagent_stop messages - they shouldn't be rendered
    const msgs = processedMessages().filter(msg => msg.type !== 'subagent_stop');
    const isGridMode = $settings.tool_display_mode === 'grid';

    if (!isGridMode) {
      // List mode: each message is its own render item
      return msgs.map(msg => ({ type: 'message' as const, message: msg }));
    }

    // Grid mode: group consecutive tool messages together
    const items: RenderItem[] = [];
    let currentToolGroup: SdkMessage[] = [];

    for (const msg of msgs) {
      const isToolMessage = msg.type === 'tool_start' || msg.type === 'tool_result' || msg.type === 'thinking';

      if (isToolMessage) {
        currentToolGroup.push(msg);
      } else {
        // Flush any pending tool group
        if (currentToolGroup.length > 0) {
          items.push({ type: 'tool_group', tools: [...currentToolGroup] });
          currentToolGroup = [];
        }
        items.push({ type: 'message', message: msg });
      }
    }

    // Flush remaining tool group
    if (currentToolGroup.length > 0) {
      items.push({ type: 'tool_group', tools: currentToolGroup });
    }

    return items;
  });

  let status = $derived(session?.status ?? "idle");
  let isQuerying = $derived(status === "querying");
  let isPendingRepo = $derived(status === "pending_repo");
  let isInitializing = $derived(status === "initializing");
  let isPendingTranscription = $derived(status === "pending_transcription");
  let isPendingApproval = $derived(status === "pending_approval");
  let isPrepared = $derived(status === "prepared");
  let preparedPrompt = $derived(session?.preparedPrompt ?? "");
  let preparedRepoRecommendation = $derived(session?.preparedRepoRecommendation);
  let isLoading = $derived(isQuerying || isInitializing);

  // Plan mode state (must be defined before showQuickActions which uses isPlanMode)
  let planMode = $derived(session?.planMode);
  let isPlanMode = $derived(planMode?.isActive ?? false);

  let showQuickActions = $derived(
    status === "idle" &&
      messages.length > 0 &&
      !isPendingRepo &&
      !isPendingTranscription &&
      !isPendingApproval &&
      !isPlanMode
  );
  let generatedQuickActions = $derived(session?.aiMetadata?.quickActions);
  let isNewChat = $derived(messages.length === 0 && status === "idle");
  let autoModelRequested = $derived(session?.autoModelRequested ?? false);
  let sessionEffortLevel = $derived(session?.effortLevel ?? null);
  let pendingApprovalPrompt = $derived(session?.pendingApprovalPrompt);
  let usage = $derived(session?.usage);
  let hasUsageData = $derived(
    !!usage &&
      (usage.totalInputTokens > 0 ||
        usage.totalOutputTokens > 0 ||
        usage.progressiveInputTokens > 0 ||
        usage.progressiveOutputTokens > 0)
  );
  let pendingRepoSelection = $derived(session?.pendingRepoSelection);
  let pendingTranscription = $derived(session?.pendingTranscription);
  let draftPrompt = $derived(session?.draftPrompt ?? "");
  let draftImages = $derived(session?.draftImages ?? []);
  let hasPlanningQuestions = $derived(
    isPlanMode &&
      planMode?.questions.length &&
      planMode.questions.length > 0 &&
      !planMode.isComplete
  );

  // Show completed recording header when we have recording data but session is no longer pending
  let hasCompletedRecordingData = $derived(
    !isPendingTranscription &&
      pendingTranscription &&
      (pendingTranscription.audioVisualizationHistory?.length ||
        pendingTranscription.transcript ||
        pendingTranscription.modelRecommendation ||
        pendingTranscription.repoRecommendation)
  );

  // Reference to prompt input for focus and draft access
  let promptInputRef:
    | {
        focus: () => void;
        getCurrentDraft: () => { prompt: string; images: SdkImageContent[] };
      }
    | undefined;

  // Expose focus function for external use
  export function focusPromptInput() {
    promptInputRef?.focus();
  }

  // Track previous session ID to save draft and scroll position before switching
  let prevSessionId = $state(sessionId);

  // Save draft and scroll position to old session before switching to new session
  $effect(() => {
    if (sessionId !== prevSessionId) {
      // Save scroll position for the OLD session
      if (messagesEl) {
        scrollPositions.set(prevSessionId, messagesEl.scrollTop);
      }

      // Save draft to the OLD session
      if (promptInputRef) {
        const draft = promptInputRef.getCurrentDraft();
        if (draft.prompt || draft.images.length > 0) {
          sdkSessions.updateDraft(
            prevSessionId,
            draft.prompt,
            draft.images.length > 0 ? draft.images : undefined
          );
        }
      }
      prevSessionId = sessionId;

      // Restore scroll position for the NEW session after DOM updates
      tick().then(() => {
        if (messagesEl) {
          const savedPosition = scrollPositions.get(sessionId);
          if (savedPosition !== undefined) {
            messagesEl.scrollTop = savedPosition;
          } else {
            // No saved position - scroll to bottom for new sessions
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
          // Update userIsNearBottom based on restored position
          checkIfNearBottom();
        }
      });
    }
  });

  // Repo and branch info
  let cwd = $derived(session?.cwd ?? "");
  // Return empty for auto mode (no cwd or cwd is '.')
  let repoName = $derived(
    !cwd || cwd === "." ? "" : cwd.split(/[/\\]/).pop() || cwd
  );
  let sessionModel = $derived(session?.model ?? "");
  let branch = $state<string | null>(null);
  let lastFetchedBranchCwd = '';

  // Fetch git branch when cwd actually changes (skip for auto mode)
  $effect(() => {
    // Only fetch if cwd actually changed
    if (cwd !== lastFetchedBranchCwd) {
      lastFetchedBranchCwd = cwd;
      if (cwd && cwd !== ".") {
        invoke<string>("get_git_branch", { repoPath: cwd })
          .then((b) => {
            branch = b;
          })
          .catch(() => {
            branch = null;
          });
      } else {
        branch = null;
      }
    }
  });

  // Get the first user prompt to display as session identifier
  const PROMPT_PREVIEW_LENGTH = 80;
  let firstPrompt = $derived(() => {
    const firstUserMessage = messages.find((m) => m.type === "user");
    if (!firstUserMessage?.content) return null;
    const content = firstUserMessage.content.trim();
    if (content.length <= PROMPT_PREVIEW_LENGTH) return content;
    return content.slice(0, PROMPT_PREVIEW_LENGTH) + "…";
  });

  onMount(() => {
    unsubscribe = sdkSessions.subscribe((sessions) => {
      const found = sessions.find((s) => s.id === sessionId);
      // Only update if session changed meaningfully (avoid reactive updates from audio visualization)
      if (found !== session) {
        // Check if key fields actually changed
        const statusChanged = found?.status !== session?.status;
        const messagesChanged = found?.messages.length !== session?.messages.length;
        const cwdChanged = found?.cwd !== session?.cwd;
        const modelChanged = found?.model !== session?.model;
        const usageChanged = found?.usage?.totalInputTokens !== session?.usage?.totalInputTokens ||
                            found?.usage?.totalOutputTokens !== session?.usage?.totalOutputTokens;
        const pendingChanged = found?.pendingTranscription?.status !== session?.pendingTranscription?.status ||
                              found?.pendingTranscription?.transcript !== session?.pendingTranscription?.transcript;
        const planModeChanged = found?.planMode?.isActive !== session?.planMode?.isActive ||
                              found?.planMode?.questions.length !== session?.planMode?.questions.length ||
                              found?.planMode?.answers.length !== session?.planMode?.answers.length ||
                              found?.planMode?.currentQuestionIndex !== session?.planMode?.currentQuestionIndex ||
                              found?.planMode?.isComplete !== session?.planMode?.isComplete ||
                              // Deep check for answer changes (selectedOptions)
                              JSON.stringify(found?.planMode?.answers) !== JSON.stringify(session?.planMode?.answers);

        if (!session || statusChanged || messagesChanged || cwdChanged || modelChanged ||
            usageChanged || pendingChanged || planModeChanged) {
          session = found || null;
        }
      }
    });
  });

  onDestroy(() => {
    unsubscribe?.();
  });

  // Auto-scroll on new messages, but only if user is near the bottom
  let prevMessageCount = $state(0);
  let userIsNearBottom = $state(true);

  function checkIfNearBottom() {
    if (!messagesEl) return;
    const threshold = 100;
    const distanceFromBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    userIsNearBottom = distanceFromBottom < threshold;
  }

  // Mark session as read when user interacts with the view
  function markAsReadOnInteraction() {
    if (session?.unread) {
      sdkSessions.markAsRead(sessionId);
    }
  }

  $effect(() => {
    const currentCount = messages.length;
    const hasNewMessages = currentCount > prevMessageCount;

    if (hasNewMessages && userIsNearBottom && messagesEl) {
      tick().then(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    }

    prevMessageCount = currentCount;
  });

  // Smart status based on recent messages and session state
  function getSmartStatus(): { status: string; detail?: string } {
    const msgs = messages;

    if (status === "error") {
      return { status: "error" };
    }

    if (status === "pending_transcription") {
      return {
        status: "pending_transcription",
        detail: pendingTranscription?.status,
      };
    }

    if (status === "pending_repo") {
      return { status: "pending_repo" };
    }

    if (status === "prepared") {
      return { status: "prepared" };
    }

    if (status === "pending_approval") {
      return { status: "pending_approval" };
    }

    if (status === "initializing") {
      return { status: "initializing" };
    }

    if (status === "querying") {
      // Check if we have any response content yet
      const hasAnyResponse = msgs.some(
        (m) => m.type === "text" || m.type === "tool_start"
      );

      if (!hasAnyResponse) {
        // No response yet - waiting for LLM
        return { status: "waiting_llm" };
      }

      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg.type === "tool_start") {
          let count = 1;
          const currentTool = msg.tool;

          for (let j = i - 1; j >= 0; j--) {
            const prevMsg = msgs[j];
            if (prevMsg.type === "tool_start") {
              if (prevMsg.tool === currentTool) {
                count++;
              } else {
                break;
              }
            }
          }

          const detail = count > 1 ? `${msg.tool} (x${count})` : msg.tool;
          return { status: "tool", detail };
        }
        if (msg.type === "tool_result") {
          return { status: "thinking" };
        }
        if (msg.type === "text") {
          return { status: "responding" };
        }
      }
      return { status: "thinking" };
    }

    return { status: "idle" };
  }

  function getStatusMessage(smartStatus: {
    status: string;
    detail?: string;
  }): string {
    switch (smartStatus.status) {
      case "tool":
        return `Running ${smartStatus.detail}...`;
      case "thinking":
        return "Thinking...";
      case "responding":
        return "Responding...";
      case "waiting_llm":
        return "Waiting for response...";
      case "initializing":
        return "Starting session...";
      default:
        return "Working...";
    }
  }

  let smartStatus = $derived(getSmartStatus());
  let statusMessage = $derived(getStatusMessage(smartStatus));

  // Copy functionality
  function formatInput(input: Record<string, unknown> | undefined): string {
    if (!input) return "";
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  }

  function getMessageText(msg: SdkMessage): string {
    switch (msg.type) {
      case "user":
        return msg.content ?? "";
      case "text":
        return msg.content ?? "";
      case "error":
        return `Error: ${msg.content ?? ""}`;
      case "tool_start":
        return `[Tool: ${msg.tool}]\nInput: ${formatInput(msg.input)}`;
      case "tool_result":
        return `[Tool: ${msg.tool} completed]\nOutput: ${msg.output ?? ""}`;
      default:
        return "";
    }
  }

  async function copyMessage(msg: SdkMessage) {
    const text =
      msg.type === "user" ? (msg.content ?? "") : getMessageText(msg);
    await navigator.clipboard.writeText(text);
    copiedMessageId = msg.timestamp;
    setTimeout(() => {
      copiedMessageId = null;
    }, 2000);
  }

  // Prompt handling
  async function handleSendPrompt(prompt: string, images?: SdkImageContent[]) {
    const isFirstPrompt =
      messages.filter((m) => m.type === "user").length === 0;

    if (isFirstPrompt) {
      // Track recommendations to store for display
      let storedRepoRecommendation:
        | {
            repoIndex: number;
            repoName: string;
            reasoning: string;
            confidence: string;
          }
        | undefined;
      let storedModelRecommendation:
        | {
            modelId: string;
            reasoning: string;
            effortLevel?: string;
          }
        | undefined;

      // Handle auto repo selection for sessions with no cwd
      if (
        $isAutoRepoSelected &&
        isRepoAutoSelectEnabled() &&
        $settings.repos.length > 1 &&
        (!cwd || cwd === "" || cwd === ".")
      ) {
        try {
          // Call LLM to recommend a repo based on the prompt
          const repoRecommendation = await recommendRepo(prompt, false); // false = not transcribed

          if (
            !repoRecommendation ||
            needsUserConfirmation(repoRecommendation.confidence)
          ) {
            // Need user to select - transition to pending_repo state
            // This will show the repo selection UI
            sdkSessions.createPendingRepoFromExisting(sessionId, prompt, {
              transcript: prompt,
              recommendedIndex: repoRecommendation?.repoIndex ?? null,
              reasoning:
                repoRecommendation?.reasoning ??
                "Please select a repository for this task",
              confidence: repoRecommendation?.confidence ?? "low",
            });
            return; // Don't send yet - wait for repo selection
          }

          // High confidence - update cwd and continue
          const selectedRepo = $settings.repos[repoRecommendation.repoIndex];
          if (selectedRepo) {
            console.log(
              "[SdkView] Auto selected repo:",
              selectedRepo.name,
              "-",
              repoRecommendation.reasoning
            );
            // Update session cwd and reinitialize backend with new cwd
            await sdkSessions.updateSessionCwd(sessionId, selectedRepo.path);
            // Store for display
            storedRepoRecommendation = {
              repoIndex: repoRecommendation.repoIndex,
              repoName: selectedRepo.name,
              reasoning: repoRecommendation.reasoning,
              confidence: repoRecommendation.confidence,
            };
          }
        } catch (error) {
          console.error("[SdkView] Repo recommendation failed:", error);
          // On error, transition to pending_repo for manual selection
          sdkSessions.createPendingRepoFromExisting(sessionId, prompt, {
            transcript: prompt,
            recommendedIndex: null,
            reasoning: "Failed to get recommendation - please select manually",
            confidence: "low",
          });
          return;
        }
      }

      // Handle auto model selection (check session's autoModelRequested flag, not current settings)
      if (autoModelRequested && isModelRecommendationEnabled()) {
        try {
          const recommendation = await recommendModel(prompt);
          if (recommendation) {
            // Backend filters by enabled_models, but double-check for safety
            // This also handles edge case where settings changed between recommendation and now
            if ($settings.enabled_models.includes(recommendation.modelId)) {
              await sdkSessions.updateSessionModel(
                sessionId,
                recommendation.modelId
              );
              console.log(
                "[SdkView] Auto selected model:",
                recommendation.modelId,
                "-",
                recommendation.reasoning
              );
              // Store for display
              storedModelRecommendation = {
                modelId: recommendation.modelId,
                reasoning: recommendation.reasoning,
                effortLevel: recommendation.effortLevel ?? undefined,
              };
            } else {
              console.warn(
                "[SdkView] Recommended model not in enabled_models (settings may have changed), keeping current:",
                recommendation.modelId
              );
            }
            // Apply effort level recommendation if provided (regardless of model)
            if (recommendation.effortLevel) {
              await sdkSessions.updateSessionEffort(
                sessionId,
                recommendation.effortLevel as EffortLevel
              );
              console.log(
                "[SdkView] Using recommended effort level:",
                recommendation.effortLevel
              );
            }
          }
        } catch (error) {
          console.error(
            "[SdkView] Model recommendation failed, using current model:",
            error
          );
        }
      }

      // Store recommendations for display in SessionRecordingHeader
      if (storedModelRecommendation || storedRepoRecommendation) {
        sdkSessions.setRecommendations(sessionId, {
          transcript: prompt,
          modelRecommendation: storedModelRecommendation,
          repoRecommendation: storedRepoRecommendation,
        });
      }
    }

    await sdkSessions.sendPrompt(sessionId, prompt, images);
  }

  async function handleStopQuery() {
    if (!isQuerying) return;
    await sdkSessions.stopQuery(sessionId);
  }

  // Recording for current session
  let isRecordingForCurrentSession = $state(false);

  async function handleStartRecording() {
    if ($isRecording) return;
    isRecordingForCurrentSession = true;

    // Set overlay mode to inline and show session info
    overlay.setMode("inline");
    overlay.setInlineSessionInfo({
      repoName: repoName,
      branch: branch,
      model: session?.model ?? null,
      promptPreview: firstPrompt() ?? null,
    });
    await overlay.show();

    await recording.startRecording($settings.audio.device_id || undefined);
  }

  async function handleStopRecording() {
    if (!$isRecording) return;

    // Capture Vosk transcript before stopping (for dual-source cleanup)
    const capturedVoskTranscript = get(recording).realtimeTranscript;

    const whisperTranscript = await recording.stopRecording(true);

    // Hide overlay and clear inline session info
    overlay.clearInlineSessionInfo();
    overlay.hide();

    if (!whisperTranscript || !isRecordingForCurrentSession) {
      isRecordingForCurrentSession = false;
      return;
    }

    isRecordingForCurrentSession = false;

    // Process voice commands first
    const processed = processVoiceCommands(whisperTranscript, capturedVoskTranscript);

    // Handle cancel command
    if (processed.detectedCommand === 'cancel') {
      console.log('[SdkView] Cancel command detected, discarding recording');
      recording.clearTranscript();
      return;
    }

    // Handle transcribe command (paste instead of send)
    if (processed.detectedCommand === 'transcribe') {
      console.log('[SdkView] Transcribe command detected, pasting to input');
      // Update draft with the transcript instead of sending
      sdkSessions.updateDraft(sessionId, processed.transcript, undefined);
      recording.clearTranscript();
      return;
    }

    // Check if transcript is empty after voice command processing
    if (processed.isEmpty) {
      console.log('[SdkView] Transcript empty after voice command processing');
      recording.clearTranscript();
      return;
    }

    // Run LLM transcription cleanup with dual-source support
    let finalTranscript = processed.transcript;

    if (isTranscriptionCleanupEnabled()) {
      // Get repo context for cleanup
      const currentRepo = cwd && cwd !== '.'
        ? $settings.repos.find(r => r.path === cwd)
        : null;
      const repoContext = currentRepo ? buildSingleRepoContext(currentRepo) : undefined;

      try {
        const cleanupResult = await cleanupTranscript(
          processed.transcript,
          processed.voskTranscript,
          repoContext
        );
        finalTranscript = cleanupResult.text;

        if (cleanupResult.wasCleanedUp) {
          console.log(
            '[SdkView] Transcription cleaned up:',
            cleanupResult.corrections,
            cleanupResult.usedDualSource ? '(dual-source)' : ''
          );
        }
      } catch (error) {
        console.error('[SdkView] Transcription cleanup failed, using original:', error);
      }
    }

    await sdkSessions.sendPrompt(sessionId, finalTranscript);
    recording.clearTranscript();
  }

  // Handlers for pending transcription sessions
  function handleRetryTranscription() {
    // Dispatch event to parent to retry transcription
    window.dispatchEvent(
      new CustomEvent("retry-transcription", { detail: { sessionId } })
    );
  }

  function handleCancelPendingTranscription() {
    // Cancel recording if still recording
    if ($isRecording) {
      recording.cancelRecording();
      // Hide overlay since recording is canceled
      overlay.hide();
      overlay.clearSessionInfo();
    }
    // Remove the pending session
    sdkSessions.cancelPendingTranscription(sessionId);
  }

  // Handlers for pending approval sessions
  function handleApprove(editedPrompt?: string) {
    // Dispatch event to parent to complete the approval
    // The parent (+page.svelte) will handle building system prompt and calling approveAndSend
    window.dispatchEvent(
      new CustomEvent("approve-transcription", {
        detail: { sessionId, editedPrompt },
      })
    );
  }

  function handleCancelApproval() {
    sdkSessions.cancelApproval(sessionId);
  }

  // Handlers for prepared sessions
  function handleLaunchPrepared(editedPrompt?: string) {
    window.dispatchEvent(
      new CustomEvent("launch-prepared", {
        detail: { sessionId, editedPrompt },
      })
    );
  }

  function handleCancelPrepared() {
    sdkSessions.cancelPrepared(sessionId);
  }

  function handleSelectPreparedRepo(repoCwd: string) {
    sdkSessions.updatePreparedRepo(sessionId, repoCwd);
  }

  // Model and effort change handlers
  function handleModelChange(newModel: string) {
    sdkSessions.updateSessionModel(sessionId, newModel);
  }

  function handleEffortChange(newLevel: EffortLevel) {
    sdkSessions.updateSessionEffort(sessionId, newLevel);
  }

  function handleCwdChange(newCwd: string) {
    sdkSessions.updateSessionCwd(sessionId, newCwd);
  }

  function handleDraftChange(prompt: string, images: SdkImageContent[]) {
    sdkSessions.updateDraft(
      sessionId,
      prompt,
      images.length > 0 ? images : undefined
    );
  }

  // Plan mode handlers
  function handlePlanningAnswerChange(answer: PlanningAnswer) {
    sdkSessions.updatePlanningAnswer(sessionId, answer);
  }

  function handlePlanningNavigate(index: number) {
    sdkSessions.setCurrentQuestionIndex(sessionId, index);
  }

  function handlePlanningSubmit() {
    sdkSessions.submitPlanningAnswers(sessionId);
  }

  async function handleImplementPlan() {
    const implSessionId =
      await sdkSessions.spawnImplementationSession(sessionId);
    if (implSessionId) {
      // Dispatch event to switch to the new implementation session
      window.dispatchEvent(
        new CustomEvent("switch-to-session", {
          detail: { sessionId: implSessionId },
        })
      );
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="sdk-view" onclick={markAsReadOnInteraction}>
  {#if isPlanMode && planMode}
    <PlanModeBanner {planMode} />
  {/if}

  {#if hasUsageData && usage}
    <SdkUsageBar {usage} {isQuerying} />
  {/if}

  <div
    class="messages"
    bind:this={messagesEl}
    onscroll={() => {
      checkIfNearBottom();
      markAsReadOnInteraction();
    }}
  >
    <!-- Recording/transcription header for pending sessions -->
    {#if isPendingTranscription && pendingTranscription}
      <SessionRecordingHeader
        {pendingTranscription}
        {sessionId}
        onRetry={handleRetryTranscription}
        onCancel={handleCancelPendingTranscription}
        autoModelEffort={$settings.llm?.features?.auto_model_effort}
      />
    {/if}

    <!-- Approval UI for pending_approval sessions -->
    {#if isPendingApproval && pendingTranscription && pendingApprovalPrompt}
      <SessionRecordingHeader
        {pendingTranscription}
        {sessionId}
        showApproval={true}
        approvalPrompt={pendingApprovalPrompt}
        {repoName}
        onApprove={handleApprove}
        onCancelApproval={handleCancelApproval}
        autoModelEffort={$settings.llm?.features?.auto_model_effort}
      />
    {/if}

    <!-- Prepared session UI -->
    {#if isPrepared && pendingTranscription}
      <SessionRecordingHeader
        {pendingTranscription}
        {sessionId}
        showPrepared={true}
        {preparedPrompt}
        onLaunch={handleLaunchPrepared}
        onCancelPrepared={handleCancelPrepared}
        repos={$settings.repos}
        {preparedRepoRecommendation}
        selectedRepoCwd={cwd}
        onSelectRepo={handleSelectPreparedRepo}
        autoModelEffort={$settings.llm?.features?.auto_model_effort}
      />
    {/if}

    <!-- Completed recording context shown at the top of active sessions -->
    {#if hasCompletedRecordingData && pendingTranscription && !isPendingApproval && !isPrepared}
      <SessionRecordingHeader
        {pendingTranscription}
        {sessionId}
        completed={true}
        autoModelEffort={$settings.llm?.features?.auto_model_effort}
      />
    {/if}

    {#each renderItems() as item, index (item.type === 'message' ? item.message.timestamp : `tool-group-${index}`)}
      {#if item.type === 'message'}
        <SdkMessageComponent
          message={item.message}
          {copiedMessageId}
          onCopy={copyMessage}
          sessionCwd={cwd}
          {sessionModel}
        />
      {:else if item.type === 'tool_group'}
        <SdkToolGrid tools={item.tools} />
      {/if}
    {/each}

    {#if isLoading}
      <SdkLoadingIndicator {statusMessage} />
    {/if}

    {#if showQuickActions}
      <SdkQuickActions
        onSendPrompt={(prompt) => handleSendPrompt(prompt)}
        generatedActions={generatedQuickActions}
      />
    {/if}

    {#if hasPlanningQuestions && planMode}
      <PlanningWizard
        questions={planMode.questions}
        answers={planMode.answers}
        currentQuestionIndex={planMode.currentQuestionIndex}
        isComplete={planMode.isComplete}
        planFilePath={planMode.planFilePath}
        featureName={planMode.featureName}
        planSummary={planMode.planSummary}
        onAnswerChange={handlePlanningAnswerChange}
        onNavigate={handlePlanningNavigate}
        onSubmit={handlePlanningSubmit}
        onImplement={handleImplementPlan}
      />
    {:else if planMode?.isComplete}
      <PlanningWizard
        questions={planMode.questions}
        answers={planMode.answers}
        currentQuestionIndex={planMode.currentQuestionIndex}
        isComplete={true}
        planFilePath={planMode.planFilePath}
        featureName={planMode.featureName}
        planSummary={planMode.planSummary}
        onAnswerChange={handlePlanningAnswerChange}
        onNavigate={handlePlanningNavigate}
        onSubmit={handlePlanningSubmit}
        onImplement={handleImplementPlan}
      />
    {/if}
  </div>

  {#if !isPrepared}
    <SdkPromptInput
      bind:this={promptInputRef}
      {sessionId}
      {isQuerying}
      isRecording={$isRecording}
      isTranscribing={$isTranscribing && isRecordingForCurrentSession}
      {isRecordingForCurrentSession}
      {draftPrompt}
      {draftImages}
      onSendPrompt={handleSendPrompt}
      onStopQuery={handleStopQuery}
      onStartRecording={handleStartRecording}
      onStopRecording={handleStopRecording}
      onDraftChange={handleDraftChange}
    />
  {/if}
</div>

<style>
  .sdk-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-background);
    color: var(--color-text-primary);
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
      monospace;
  }

  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    user-select: text;
  }

  .new-chat-selectors {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    border-top: 1px solid var(--color-border);
    background: var(--color-surface);
  }
</style>
