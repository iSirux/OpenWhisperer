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
  import {
    recording,
    isRecording,
    isTranscribing,
  } from "$lib/stores/recording";
  import { settings } from "$lib/stores/settings";
  import { repos, isAutoRepoSelected } from "$lib/stores/repos";
  import { overlay } from "$lib/stores/overlay";
  import { invoke } from "@tauri-apps/api/core";
  import SdkUsageBar from "./sdk/SdkUsageBar.svelte";
  import SdkMessageComponent from "./sdk/SdkMessage.svelte";
  import SdkLoadingIndicator from "./sdk/SdkLoadingIndicator.svelte";
  import SdkPromptInput from "./sdk/SdkPromptInput.svelte";
  import SessionRecordingHeader from "./sdk/SessionRecordingHeader.svelte";
  import SdkQuickActions from "./sdk/SdkQuickActions.svelte";
  import PlanningWizard from "./sdk/PlanningWizard.svelte";
  import AskUserQuestionWizard from "./sdk/AskUserQuestionWizard.svelte";
  import PlanApprovalDialog from "./sdk/PlanApprovalDialog.svelte";
  import PlanModeBanner from "./sdk/PlanModeBanner.svelte";
  import SdkToolGrid from "./sdk/SdkToolGrid.svelte";
  import LaunchBar from "./sdk/LaunchBar.svelte";
  import { launchStore, getLaunchRuntime, queuedLaunch } from "$lib/stores/launchProfiles";
  import { findRepoById } from "$lib/stores/repos";
  import SdkTaskBlock from "./sdk/SdkTaskBlock.svelte";
  import ModelSelector from "./ModelSelector.svelte";
  import EffortToggle from "./EffortToggle.svelte";
  import RepoSelector from "./RepoSelector.svelte";
  import {
    processSdkMessages,
    buildRenderItems,
    type RenderItem,
  } from "./sdk/sdkViewMessageProcessing";
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

  // Persist across SdkView component remounts (session switches can recreate component instances).
  type SessionScrollState = { scrollTop: number; stickToBottom: boolean };
  const globalScrollStateKey =
    "__claudeWhispererSdkViewScrollStates__" as const;
  type GlobalWithSdkScrollStates = typeof globalThis & {
    [globalScrollStateKey]?: Map<string, SessionScrollState>;
  };
  const scrollStates =
    (globalThis as GlobalWithSdkScrollStates)[globalScrollStateKey] ??
    (((globalThis as GlobalWithSdkScrollStates)[globalScrollStateKey] =
      new Map<string, SessionScrollState>()));

  let messages = $derived(session?.messages ?? []);
  let processedMessages = $derived(processSdkMessages(messages));
  let renderItems = $derived(
    buildRenderItems(processedMessages, $settings.tool_display_mode === "grid"),
  );

  let status = $derived(session?.status ?? "idle");
  let isQuerying = $derived(status === "querying");
  let isPendingRepo = $derived(status === "pending_repo");
  let isInitializing = $derived(status === "initializing");
  let isPendingTranscription = $derived(status === "pending_transcription");
  let isPendingApproval = $derived(status === "pending_approval");
  let isPrepared = $derived(status === "prepared");
  let preparedPrompt = $derived(session?.preparedPrompt ?? "");
  let preparedRepoRecommendation = $derived(
    session?.preparedRepoRecommendation,
  );
  // Note: isLoading is suppressed when the session is waiting for user input
  // (plan approval or AskUserQuestion) to avoid showing a spinner alongside the dialog.
  let isWaitingForUserInput = $derived(!!session?.pendingPlanApproval || !!(session?.askUserQuestion?.questions?.length));
  let isLoading = $derived((isQuerying || isInitializing) && !isWaitingForUserInput);

  // Plan mode state (must be defined before showQuickActions which uses isPlanMode)
  let planMode = $derived(session?.planMode);
  let isPlanMode = $derived(planMode?.isActive ?? false);

  let showQuickActions = $derived(
    status === "idle" &&
      messages.length > 0 &&
      !isPendingRepo &&
      !isPendingTranscription &&
      !isPendingApproval &&
      !isPlanMode,
  );
  let generatedQuickActions = $derived(session?.aiMetadata?.quickActions);
  let sessionOutcome = $derived(session?.aiMetadata?.outcome);
  let sessionCategory = $derived(session?.aiMetadata?.category);
  let isNewChat = $derived(messages.length === 0 && status === "idle");
  let autoModelRequested = $derived(session?.autoModelRequested ?? false);
  let sessionEffortLevel = $derived(session?.effortLevel ?? null);
  let forkSourceLabel = $derived(session?.forkedFromSessionLabel ?? "");
  let isForkSession = $derived(!!session?.forkedFromSessionId);
  let pendingApprovalPrompt = $derived(session?.pendingApprovalPrompt);
  let usage = $derived(session?.usage);
  let hasUsageData = $derived(
    !!usage &&
      (usage.totalInputTokens > 0 ||
        usage.totalOutputTokens > 0 ||
        usage.totalCacheReadTokens > 0 ||
        usage.totalCacheCreationTokens > 0 ||
        usage.progressiveInputTokens > 0 ||
        usage.progressiveOutputTokens > 0 ||
        usage.progressiveCacheReadTokens > 0 ||
        usage.progressiveCacheCreationTokens > 0),
  );
  // Determine if user is paying via API key (show cost) vs OAuth/subscription (hide cost)
  let usesApiKey = $state(false);
  $effect(() => {
    const provider = session?.provider;
    // Re-run when provider changes
    (async () => {
      try {
        if (provider === "openai") {
          usesApiKey = await invoke<boolean>("has_openai_api_key");
        } else {
          const auth = await invoke<{
            hasEnvKey: boolean;
            hasOAuth: boolean;
            hasKeyringKey: boolean;
          }>("check_claude_auth");
          usesApiKey = auth.hasEnvKey || auth.hasKeyringKey;
        }
      } catch {
        usesApiKey = false;
      }
    })();
  });

  let pendingRepoSelection = $derived(session?.pendingRepoSelection);
  let pendingTranscription = $derived(session?.pendingTranscription);
  let draftPrompt = $derived(session?.draftPrompt ?? "");
  let draftImages = $derived(session?.draftImages ?? []);
  let hasPlanningQuestions = $derived(
    isPlanMode &&
      planMode?.questions.length &&
      planMode.questions.length > 0 &&
      !planMode.isComplete,
  );

  // AskUserQuestion state
  let askUserQuestion = $derived(session?.askUserQuestion);
  let hasAskUserQuestions = $derived(!!(askUserQuestion?.questions?.length));

  // Plan approval state (ExitPlanMode interception)
  let pendingPlanApproval = $derived(session?.pendingPlanApproval);
  let hasPlanApproval = $derived(!!pendingPlanApproval);
  let planApprovalAnchorIndex = $derived.by(() => {
    if (!hasPlanApproval || !pendingPlanApproval) return -1;

    const isPlanApprovalToolMessage = (msg: SdkMessage) =>
      (msg.type === "tool_start" || msg.type === "tool_result") &&
      (msg.tool === "ExitPlanMode" || msg.tool === "complete_planning" || msg.tool === "mcp__planning-tools__complete_planning");

    // Prefer anchoring directly after the plan-approval tool (ExitPlanMode or complete_planning).
    for (let i = renderItems.length - 1; i >= 0; i -= 1) {
      const item = renderItems[i];
      if (
        (item.type === "message" && isPlanApprovalToolMessage(item.message)) ||
        (item.type === "tool_group" &&
          item.tools.some((toolMsg) => isPlanApprovalToolMessage(toolMsg)))
      ) {
        return i;
      }
    }

    return -1;
  });

  // Show completed recording header when we have recording data but session is no longer pending
  let hasCompletedRecordingData = $derived(
    !isPendingTranscription &&
      pendingTranscription &&
      (pendingTranscription.audioVisualizationHistory?.length ||
        pendingTranscription.transcript ||
        pendingTranscription.modelRecommendation ||
        pendingTranscription.repoRecommendation),
  );

  // Reference to prompt input for focus and draft access
  let promptInputRef:
    | {
        focus: () => void;
        clearInput: () => void;
        getCurrentDraft: () => { prompt: string; images: SdkImageContent[] };
        appendToPrompt: (text: string) => void;
      }
    | undefined;

  // Expose focus function for external use
  export function focusPromptInput() {
    promptInputRef?.focus();
  }

  // Track previous session ID to save draft and scroll position before switching
  let prevSessionId = $state(sessionId);
  let restoredSessionId = $state<string | null>(null);

  function persistCurrentScrollState(targetSessionId = sessionId) {
    if (!messagesEl) return;
    const threshold = 100;
    const distanceFromBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    const stickToBottom = distanceFromBottom < threshold;
    scrollStates.set(targetSessionId, {
      scrollTop: messagesEl.scrollTop,
      stickToBottom,
    });
  }

  async function restoreScrollState(targetSessionId = sessionId) {
    if (!messagesEl) return;
    await tick();
    const savedState = scrollStates.get(targetSessionId);
    if (savedState) {
      messagesEl.scrollTop = savedState.stickToBottom
        ? messagesEl.scrollHeight
        : savedState.scrollTop;
    } else {
      // No saved position - scroll to bottom for new sessions
      messagesEl.scrollTop = messagesEl.scrollHeight;
      persistCurrentScrollState(targetSessionId);
    }
    checkIfNearBottom();
  }

  // Save draft and scroll position to old session before switching to new session
  $effect(() => {
    if (sessionId !== prevSessionId) {
      // Save scroll position for the OLD session
      if (messagesEl) {
        persistCurrentScrollState(prevSessionId);
      }

      prevSessionId = sessionId;
      restoredSessionId = null;

      // Restore scroll position for the NEW session after DOM updates
      restoreScrollState(sessionId).then(() => {
        restoredSessionId = sessionId;
      });
    }
  });

  // Initial mount/restoration path for the currently active session.
  $effect(() => {
    if (!messagesEl || restoredSessionId === sessionId) return;
    restoreScrollState(sessionId).then(() => {
      restoredSessionId = sessionId;
    });
  });

  // Repo and branch info
  let cwd = $derived(session?.cwd ?? "");
  // Return empty for auto mode (no cwd or cwd is '.')
  let repoName = $derived(
    !cwd || cwd === "." ? "" : cwd.split(/[/\\]/).pop() || cwd,
  );
  let sessionModel = $derived(session?.model ?? "");
  let forkedMessageCount = $derived(session?.forkedMessageCount ?? 0);

  // Launch profiles for the current repo
  let sessionRepoId = $derived(session?.repoId ?? "");
  let sessionRepo = $derived(
    sessionRepoId ? findRepoById($repos.list, sessionRepoId) : null,
  );
  let repoLaunchProfiles = $derived(sessionRepo?.launch_profiles ?? []);
  let repoLaunchCommands = $derived(sessionRepo?.launch_commands ?? []);
  let hasLaunchProfiles = $derived(repoLaunchProfiles.length > 0);
  let branch = $state<string | null>(null);
  let lastFetchedBranchCwd = "";

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
        const messagesChanged =
          found?.messages.length !== session?.messages.length;
        const cwdChanged = found?.cwd !== session?.cwd;
        const modelChanged = found?.model !== session?.model;
        const usageChanged =
          found?.usage?.totalInputTokens !== session?.usage?.totalInputTokens ||
          found?.usage?.totalOutputTokens !==
            session?.usage?.totalOutputTokens ||
          found?.usage?.totalCacheReadTokens !==
            session?.usage?.totalCacheReadTokens ||
          found?.usage?.totalCacheCreationTokens !==
            session?.usage?.totalCacheCreationTokens ||
          found?.usage?.contextUsagePercent !==
            session?.usage?.contextUsagePercent ||
          found?.usage?.contextWindow !== session?.usage?.contextWindow ||
          found?.usage?.progressiveInputTokens !==
            session?.usage?.progressiveInputTokens ||
          found?.usage?.progressiveOutputTokens !==
            session?.usage?.progressiveOutputTokens ||
          found?.usage?.progressiveCacheReadTokens !==
            session?.usage?.progressiveCacheReadTokens ||
          found?.usage?.progressiveCacheCreationTokens !==
            session?.usage?.progressiveCacheCreationTokens;
        const pendingChanged =
          found?.pendingTranscription?.status !==
            session?.pendingTranscription?.status ||
          found?.pendingTranscription?.transcript !==
            session?.pendingTranscription?.transcript;
        const aiMetadataChanged =
          found?.aiMetadata?.outcome !== session?.aiMetadata?.outcome ||
          found?.aiMetadata?.category !== session?.aiMetadata?.category ||
          found?.aiMetadata?.name !== session?.aiMetadata?.name ||
          found?.aiMetadata?.quickActions?.length !==
            session?.aiMetadata?.quickActions?.length;
        const planModeChanged =
          found?.planMode?.isActive !== session?.planMode?.isActive ||
          found?.planMode?.questions.length !==
            session?.planMode?.questions.length ||
          found?.planMode?.answers.length !==
            session?.planMode?.answers.length ||
          found?.planMode?.currentQuestionIndex !==
            session?.planMode?.currentQuestionIndex ||
          found?.planMode?.isComplete !== session?.planMode?.isComplete ||
          // Deep check for answer changes (selectedOptions)
          JSON.stringify(found?.planMode?.answers) !==
            JSON.stringify(session?.planMode?.answers);
        const askUserQuestionChanged =
          found?.askUserQuestion?.questions.length !==
            session?.askUserQuestion?.questions.length ||
          found?.askUserQuestion?.answers.length !==
            session?.askUserQuestion?.answers.length ||
          found?.askUserQuestion?.currentQuestionIndex !==
            session?.askUserQuestion?.currentQuestionIndex ||
          JSON.stringify(found?.askUserQuestion?.answers) !==
            JSON.stringify(session?.askUserQuestion?.answers);
        const draftChanged =
          found?.draftPrompt !== session?.draftPrompt ||
          JSON.stringify(found?.draftImages ?? []) !==
            JSON.stringify(session?.draftImages ?? []);
        const planApprovalChanged =
          JSON.stringify(found?.pendingPlanApproval) !==
            JSON.stringify(session?.pendingPlanApproval);

        if (
          !session ||
          statusChanged ||
          messagesChanged ||
          cwdChanged ||
          modelChanged ||
          usageChanged ||
          pendingChanged ||
          aiMetadataChanged ||
          planModeChanged ||
          askUserQuestionChanged ||
          draftChanged ||
          planApprovalChanged
        ) {
          session = found || null;
        }
      }
    });
  });

  onDestroy(() => {
    persistCurrentScrollState(sessionId);
    unsubscribe?.();
  });

  // Keep bottom lock behavior when new content arrives.
  let userIsNearBottom = $state(true);
  let showGoToTop = $state(false);
  const GO_TO_TOP_SCROLL_THRESHOLD = 300;

  function checkIfNearBottom() {
    if (!messagesEl) return;
    const threshold = 100;
    const distanceFromBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    userIsNearBottom = distanceFromBottom < threshold;
    showGoToTop = messagesEl.scrollTop > GO_TO_TOP_SCROLL_THRESHOLD;
    persistCurrentScrollState(sessionId);
  }

  function scrollToTop() {
    messagesEl?.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Mark session as read when user interacts with the view
  function markAsReadOnInteraction() {
    if (session?.unread) {
      sdkSessions.markAsRead(sessionId);
    }
  }

  $effect(() => {
    // Re-run when messages or rendered content shape changes.
    const _messagesLength = messages.length;
    const _renderItemCount = renderItems.length;
    const _lastMessage = messages.length ? messages[messages.length - 1] : null;
    const _lastContent = _lastMessage?.content ?? _lastMessage?.output ?? "";

    if (!messagesEl) return;
    const state = scrollStates.get(sessionId);
    const shouldStick = state?.stickToBottom ?? userIsNearBottom;
    if (!shouldStick) return;

    tick().then(() => {
      if (!messagesEl) return;
      const latest = scrollStates.get(sessionId);
      if (latest?.stickToBottom ?? true) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
        checkIfNearBottom();
      }
    });
  });

  // Auto-scroll when the session starts waiting for user input (plan approval / AskUserQuestion).
  // These dialogs render below the messages but no new message is added, so the regular
  // auto-scroll doesn't trigger. Without this the dialog may appear just below the fold.
  let prevWaitingForInput = $state(false);
  $effect(() => {
    const waiting = isWaitingForUserInput;
    if (waiting && !prevWaitingForInput && messagesEl) {
      tick().then(() => {
        if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    }
    prevWaitingForInput = waiting;
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
        (m) => m.type === "text" || m.type === "tool_start",
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

  /** Check if a message is inherited from a parent fork session (displayed as read-only context) */
  function isForkedContextMessage(msg: SdkMessage): boolean {
    if (!forkedMessageCount) return false;
    const idx = getOriginalMessageIndex(msg);
    return idx >= 0 && idx < forkedMessageCount;
  }

  /** Check if a render item (message, tool_group, or task) belongs to the forked context */
  function isForkedContextItem(item: RenderItem): boolean {
    if (!forkedMessageCount) return false;
    if (item.type === "message") return isForkedContextMessage(item.message);
    if (item.type === "tool_group") return item.tools.length > 0 && item.tools.every(t => isForkedContextMessage(t));
    if (item.type === "task") return isForkedContextMessage(item.taskStarted);
    return false;
  }

  /** Track if we've passed the fork boundary for divider rendering */
  let lastWasForkedContext = false;

  /** Find the original index of a processed message in the raw messages array (for fork support) */
  function getOriginalMessageIndex(msg: SdkMessage): number {
    // Use timestamp + type as a key to find the original message
    // The processedMessages step merges tool_start into tool_result, so for merged messages
    // we search by toolUseId first, then fall back to timestamp matching
    if (msg.toolUseId) {
      const idx = messages.findIndex(m => m.toolUseId === msg.toolUseId && m.type === msg.type);
      if (idx >= 0) return idx;
    }
    // Fall back to timestamp matching (works for user, text, thinking, etc.)
    return messages.findIndex(m => m.timestamp === msg.timestamp && m.type === msg.type);
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
    // Clear completion metadata immediately so prior outcome/actions don't linger
    // while pre-send recommendation calls are running.
    sdkSessions.clearAiCompletionMetadata(sessionId);

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
        $repos.list.filter((r) => r.active !== false).length > 1 &&
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
          const selectedRepo = $repos.list[repoRecommendation.repoIndex];
          if (selectedRepo) {
            console.log(
              "[SdkView] Auto selected repo:",
              selectedRepo.name,
              "-",
              repoRecommendation.reasoning,
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
                recommendation.modelId,
              );
              console.log(
                "[SdkView] Auto selected model:",
                recommendation.modelId,
                "-",
                recommendation.reasoning,
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
                recommendation.modelId,
              );
            }
            // Apply effort level recommendation if provided (regardless of model)
            if (recommendation.effortLevel) {
              await sdkSessions.updateSessionEffort(
                sessionId,
                recommendation.effortLevel as EffortLevel,
              );
              console.log(
                "[SdkView] Using recommended effort level:",
                recommendation.effortLevel,
              );
            }
          }
        } catch (error) {
          console.error(
            "[SdkView] Model recommendation failed, using current model:",
            error,
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
  // Tracks post-transcription processing (LLM cleanup, sending prompt)
  let isProcessingRecording = $state(false);

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
    isProcessingRecording = true;

    try {
      // Process voice commands first
      const processed = processVoiceCommands(
        whisperTranscript,
        capturedVoskTranscript,
      );

      // Handle cancel command
      if (processed.detectedCommand === "cancel") {
        console.log("[SdkView] Cancel command detected, discarding recording");
        recording.clearTranscript();
        return;
      }

      // Handle transcribe command (paste instead of send)
      if (processed.detectedCommand === "transcribe") {
        console.log("[SdkView] Transcribe command detected, pasting to input");
        // Update draft with the transcript instead of sending
        sdkSessions.updateDraft(sessionId, processed.transcript, undefined);
        recording.clearTranscript();
        return;
      }

      // Check if transcript is empty after voice command processing
      if (processed.isEmpty) {
        console.log("[SdkView] Transcript empty after voice command processing");
        recording.clearTranscript();
        return;
      }

      // Run LLM transcription cleanup with dual-source support
      let finalTranscript = processed.transcript;

      if (isTranscriptionCleanupEnabled()) {
        // Get repo context for cleanup
        const currentRepo =
          cwd && cwd !== "." ? $repos.list.find((r) => r.path === cwd) : null;
        const repoContext = currentRepo
          ? buildSingleRepoContext(currentRepo)
          : undefined;

        try {
          const cleanupResult = await cleanupTranscript(
            processed.transcript,
            processed.voskTranscript,
            repoContext,
          );
          finalTranscript = cleanupResult.text;

          if (cleanupResult.wasCleanedUp) {
            console.log(
              "[SdkView] Transcription cleaned up:",
              cleanupResult.corrections,
              cleanupResult.usedDualSource ? "(dual-source)" : "",
            );
          }
        } catch (error) {
          console.error(
            "[SdkView] Transcription cleanup failed, using original:",
            error,
          );
        }
      }

      // Clear the input box before sending so any typed draft doesn't linger
      promptInputRef?.clearInput();
      await sdkSessions.sendPrompt(sessionId, finalTranscript);
      recording.clearTranscript();
    } finally {
      isProcessingRecording = false;
    }
  }

  // Inline recording (record and append to prompt, does not send)
  let isInlineRecordingForCurrentSession = $state(false);
  let isInlineTranscribing = $state(false);

  async function handleStartInlineRecording() {
    if ($isRecording) return;
    isInlineRecordingForCurrentSession = true;
    await recording.startRecording($settings.audio.device_id || undefined);
  }

  async function handleStopInlineRecording() {
    if (!$isRecording) return;

    // Capture Vosk transcript before stopping (for dual-source cleanup)
    const capturedVoskTranscript = get(recording).realtimeTranscript;

    isInlineRecordingForCurrentSession = false;
    isInlineTranscribing = true;

    try {
      const whisperTranscript = await recording.stopRecording(true);

      if (!whisperTranscript) return;

      // Apply LLM transcription cleanup (same as existing flow, but no voice commands)
      let finalTranscript = whisperTranscript;

      if (isTranscriptionCleanupEnabled()) {
        const currentRepo =
          cwd && cwd !== "." ? $repos.list.find((r) => r.path === cwd) : null;
        const repoContext = currentRepo
          ? buildSingleRepoContext(currentRepo)
          : undefined;

        try {
          const cleanupResult = await cleanupTranscript(
            whisperTranscript,
            capturedVoskTranscript,
            repoContext,
          );
          finalTranscript = cleanupResult.text;

          if (cleanupResult.wasCleanedUp) {
            console.log(
              "[SdkView] Inline transcription cleaned up:",
              cleanupResult.corrections,
              cleanupResult.usedDualSource ? "(dual-source)" : "",
            );
          }
        } catch (error) {
          console.error(
            "[SdkView] Inline transcription cleanup failed, using original:",
            error,
          );
        }
      }

      // Append to prompt instead of sending
      promptInputRef?.appendToPrompt(finalTranscript);
    } finally {
      isInlineTranscribing = false;
      recording.clearTranscript();
    }
  }

  // Handlers for pending transcription sessions
  function handleRetryTranscription() {
    // Dispatch event to parent to retry transcription
    window.dispatchEvent(
      new CustomEvent("retry-transcription", { detail: { sessionId } }),
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
      }),
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
      }),
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

  function handleDraftChange(
    targetSessionId: string,
    prompt: string,
    images: SdkImageContent[],
  ) {
    sdkSessions.updateDraft(
      targetSessionId,
      prompt,
      images.length > 0 ? images : undefined,
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
        }),
      );
    }
  }

  // AskUserQuestion handlers
  function handleAskUserAnswerChange(answer: PlanningAnswer) {
    sdkSessions.updateAskUserAnswer(sessionId, answer);
  }

  function handleAskUserNavigate(index: number) {
    sdkSessions.setAskUserQuestionIndex(sessionId, index);
  }

  function handleAskUserSubmit() {
    sdkSessions.submitAskUserAnswers(sessionId);
  }

  function handleAskUserDismiss() {
    sdkSessions.clearAskUserQuestion(sessionId);
  }

  // Plan approval handlers
  function handleApprovePlan(feedback?: string) {
    sdkSessions.approvePlan(sessionId, feedback);
  }
  function handleApprovePlanNewSession() {
    sdkSessions.approvePlanNewSession(sessionId);
  }
  function handleDenyPlan(feedback: string) {
    sdkSessions.denyPlan(sessionId, feedback);
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

  <div class="messages-wrapper">
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
          repos={$repos.list.filter((r) => r.active !== false)}
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

      {#if isForkSession}
        <div class="fork-session-banner">
          <svg viewBox="0 0 16 16" fill="currentColor" class="fork-session-banner-icon">
            <path fill-rule="evenodd" d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM5 5.372a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5v2.128a2.251 2.251 0 1 0 1.5 0V8.5h1.5a2.25 2.25 0 0 0 2.25-2.25v-.878a2.25 2.25 0 1 0-1.5 0v.878a.75.75 0 0 1-.75.75h-4.5A.75.75 0 0 1 5 6.25v-.878ZM8.75 12.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.25 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" />
          </svg>
          <span>{forkSourceLabel ? `Forked from ${forkSourceLabel}` : "Forked session"}</span>
        </div>
      {/if}

      {#each renderItems as item, index (item.type === "message" ? item.message.timestamp : item.type === "task" ? `task-${item.taskStarted.taskId || item.taskStarted.toolUseId || index}` : `tool-group-${index}`)}
        {@const isForked = isForkedContextItem(item)}
        {@const showForkDivider = !isForked && forkedMessageCount > 0 && index > 0 && (() => { const prevItem = renderItems[index - 1]; return prevItem ? isForkedContextItem(prevItem) : false; })()}
        {#if showForkDivider}
          <div class="fork-divider">
            <span class="fork-divider-line"></span>
            <span class="fork-divider-label">
              <svg viewBox="0 0 16 16" fill="currentColor" class="fork-divider-icon">
                <path fill-rule="evenodd" d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM5 5.372a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5v2.128a2.251 2.251 0 1 0 1.5 0V8.5h1.5a2.25 2.25 0 0 0 2.25-2.25v-.878a2.25 2.25 0 1 0-1.5 0v.878a.75.75 0 0 1-.75.75h-4.5A.75.75 0 0 1 5 6.25v-.878ZM8.75 12.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.25 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" />
              </svg>
              Forked from here
            </span>
            <span class="fork-divider-line"></span>
          </div>
        {/if}
        {#if item.type === "message"}
          <div class:forked-context={isForked}>
            <SdkMessageComponent
              message={item.message}
              {copiedMessageId}
              onCopy={copyMessage}
              sessionCwd={cwd}
              {sessionModel}
              {sessionEffortLevel}
              {sessionId}
              messageIndex={getOriginalMessageIndex(item.message)}
              session={session ?? undefined}
            />
          </div>
        {:else if item.type === "tool_group"}
          <div class:forked-context={isForked}>
            <SdkToolGrid tools={item.tools} />
          </div>
        {:else if item.type === "task"}
          <div class:forked-context={isForked}>
          <SdkTaskBlock
            taskStarted={item.taskStarted}
            children={item.children}
            taskCompleted={item.taskCompleted}
            {copiedMessageId}
            onCopy={copyMessage}
            sessionCwd={cwd}
            {sessionModel}
            {sessionEffortLevel}
          />
          </div>
        {/if}

        {#if hasPlanApproval && pendingPlanApproval && index === planApprovalAnchorIndex}
          <PlanApprovalDialog
            {pendingPlanApproval}
            onApprove={handleApprovePlan}
            onApproveNewSession={handleApprovePlanNewSession}
            onDeny={handleDenyPlan}
          />
        {/if}
      {/each}

      {#if isLoading}
        <SdkLoadingIndicator {statusMessage} />
      {/if}

      {#if showQuickActions && sessionOutcome}
        <div class="session-outcome">
          {#if sessionCategory}
            <span class="outcome-category">{sessionCategory}</span>
          {/if}
          <span class="outcome-text">{sessionOutcome}</span>
        </div>
      {/if}

      {#if showQuickActions}
        <SdkQuickActions
          onSendPrompt={(prompt) => handleSendPrompt(prompt)}
          generatedActions={generatedQuickActions}
          hasOutcomeAbove={!!sessionOutcome}
        />
      {/if}

      {#if hasAskUserQuestions && askUserQuestion}
        <AskUserQuestionWizard
          questions={askUserQuestion.questions}
          answers={askUserQuestion.answers}
          currentQuestionIndex={askUserQuestion.currentQuestionIndex}
          onAnswerChange={handleAskUserAnswerChange}
          onNavigate={handleAskUserNavigate}
          onSubmit={handleAskUserSubmit}
          onDismiss={handleAskUserDismiss}
        />
      {/if}

      {#if hasPlanApproval && pendingPlanApproval && planApprovalAnchorIndex === -1}
        <PlanApprovalDialog
          {pendingPlanApproval}
          onApprove={handleApprovePlan}
          onApproveNewSession={handleApprovePlanNewSession}
          onDeny={handleDenyPlan}
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

    {#if showGoToTop}
      <button
        class="go-to-top-button"
        onclick={scrollToTop}
        title="Scroll to top"
      >
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path
            fill-rule="evenodd"
            d="M8 15a.5.5 0 0 0 .5-.5V2.707l3.146 3.147a.5.5 0 0 0 .708-.708l-4-4a.5.5 0 0 0-.708 0l-4 4a.5.5 0 1 0 .708.708L7.5 2.707V14.5a.5.5 0 0 0 .5.5z"
          />
        </svg>
        <span>Top</span>
      </button>
    {/if}
  </div>

  {#if hasLaunchProfiles && sessionRepoId}
    <LaunchBar
      repoId={sessionRepoId}
      repoPath={cwd}
      profiles={repoLaunchProfiles}
      commands={repoLaunchCommands}
      runtime={$launchStore.runtimes[sessionRepoId] ?? null}
      queued={$queuedLaunch?.repoId === sessionRepoId ? $queuedLaunch : null}
      isAgentRunning={isQuerying}
      {sessionId}
    />
  {/if}

  {#if !isPrepared}
    <SdkPromptInput
      bind:this={promptInputRef}
      {sessionId}
      {isQuerying}
      isRecording={$isRecording}
      isTranscribing={($isTranscribing && isRecordingForCurrentSession) || isProcessingRecording}
      {isRecordingForCurrentSession}
      isInlineRecording={isInlineRecordingForCurrentSession && $isRecording}
      {isInlineTranscribing}
      {draftPrompt}
      {draftImages}
      onSendPrompt={handleSendPrompt}
      onStopQuery={handleStopQuery}
      onStartRecording={handleStartRecording}
      onStopRecording={handleStopRecording}
      onStartInlineRecording={handleStartInlineRecording}
      onStopInlineRecording={handleStopInlineRecording}
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

  .messages-wrapper {
    position: relative;
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  .messages {
    height: 100%;
    overflow-y: auto;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    user-select: text;
  }

  .go-to-top-button {
    position: absolute;
    bottom: 1rem;
    right: 1.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 0.375rem 0.625rem;
    font-size: 0.75rem;
    cursor: pointer;
    transition:
      background 0.2s,
      color 0.2s,
      box-shadow 0.2s;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    z-index: 10;
    animation: fadeInUp 0.2s ease-out;
  }

  @keyframes fadeInUp {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .go-to-top-button:hover {
    background: var(--color-border);
    color: var(--color-text-primary);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  }

  .go-to-top-button svg {
    width: 14px;
    height: 14px;
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

  .session-outcome {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0 0;
    border-top: 1px dashed var(--color-border);
    font-size: 0.8rem;
    color: var(--color-text-muted);
  }

  .outcome-category {
    display: inline-flex;
    padding: 0.125rem 0.5rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    font-size: 0.7rem;
    color: var(--color-text-secondary);
    text-transform: capitalize;
    white-space: nowrap;
  }

  .outcome-text {
    color: var(--color-text-secondary);
  }

  /* Forked session context - inherited messages shown dimmed */
  .forked-context {
    opacity: 0.5;
    transition: opacity 0.2s;
  }

  .forked-context:hover {
    opacity: 0.75;
  }

  .fork-session-banner {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin: 0 0 0.9rem;
    padding: 0.55rem 0.75rem;
    border: 1px solid rgba(251, 191, 36, 0.28);
    border-radius: 0.7rem;
    background: rgba(251, 191, 36, 0.08);
    color: rgb(251, 191, 36);
    font-size: 0.82rem;
    font-weight: 500;
  }

  .fork-session-banner-icon {
    width: 0.9rem;
    height: 0.9rem;
    flex-shrink: 0;
  }

  /* Fork divider between inherited and new messages */
  .fork-divider {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 0.75rem 0;
    padding: 0 0.5rem;
  }

  .fork-divider-line {
    flex: 1;
    height: 1px;
    background: var(--color-border);
  }

  .fork-divider-label {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    white-space: nowrap;
  }

  .fork-divider-icon {
    width: 12px;
    height: 12px;
  }
</style>
