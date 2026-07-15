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
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { playVoiceCommandSound } from "$lib/utils/sound";
  import SdkUsageBar from "./sdk/SdkUsageBar.svelte";
  import SdkMessageComponent from "./sdk/SdkMessage.svelte";
  import SdkLoadingIndicator from "./sdk/SdkLoadingIndicator.svelte";
  import SdkPromptInput from "./sdk/SdkPromptInput.svelte";
  import SessionRecordingHeader from "./sdk/SessionRecordingHeader.svelte";
  import SdkQuickActions from "./sdk/SdkQuickActions.svelte";
  import NoMistakesPanel from "./sdk/NoMistakesPanel.svelte";
  import { nmRuns, noMistakes } from "$lib/stores/noMistakes";
  import AskUserQuestionWizard from "./sdk/AskUserQuestionWizard.svelte";
  import PlanApprovalDialog from "./sdk/PlanApprovalDialog.svelte";
  import ContextOverflowBanner from "./sdk/ContextOverflowBanner.svelte";
  import RateLimitBanner from "./sdk/RateLimitBanner.svelte";
  import { type QueueWindow } from "$lib/stores/queueDetection";
  import SdkToolGrid from "./sdk/SdkToolGrid.svelte";
  import LaunchBar from "./sdk/LaunchBar.svelte";
  import { launchStore, getLaunchRuntime, queuedLaunch } from "$lib/stores/launchProfiles";
  import { findRepoById } from "$lib/stores/repos";
  import SdkTaskBlock from "./sdk/SdkTaskBlock.svelte";
  import ModelSelector from "./ModelSelector.svelte";
  import EffortToggle from "./EffortToggle.svelte";
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
  import { pile, sidebarTab } from "$lib/stores/pile";
  import { debugRecordings } from "$lib/stores/debugRecordings";
  import { activeSdkSessionId } from "$lib/stores/sdkSessions";
  import { focusedPaneSessionId } from "$lib/stores/panes";
  import { get } from "svelte/store";

  let { sessionId }: { sessionId: string } = $props();

  let copiedMessageId = $state<number | null>(null);
  let messagesEl: HTMLDivElement;
  let session = $state<SdkSession | null>(null);
  let unsubscribe: (() => void) | undefined;

  // Persist across SdkView component remounts (session switches can recreate component instances).
  type SessionScrollState = { scrollTop: number; stickToBottom: boolean };
  const SCROLL_STATE_KEY = "__openWhispererSdkViewScrollStates__";
  type GlobalWithSdkScrollStates = typeof globalThis & {
    __openWhispererSdkViewScrollStates__?: Map<string, SessionScrollState>;
  };
  const scrollStates =
    (globalThis as GlobalWithSdkScrollStates)[SCROLL_STATE_KEY] ??
    (((globalThis as GlobalWithSdkScrollStates)[SCROLL_STATE_KEY] =
      new Map<string, SessionScrollState>()));

  let messages = $derived(session?.messages ?? []);
  let processedMessages = $derived(processSdkMessages(messages));
  let renderItems = $derived(
    buildRenderItems(processedMessages, $settings.tool_display_mode === "grid"),
  );

  // --- Render windowing -----------------------------------------------------
  // Long-running sessions accumulate thousands of messages (observed 2400+).
  // Mounting every message component at once on session switch (this view is
  // rebuilt via {#key sessionId}) runs markdown + syntax highlighting for each
  // synchronously and blocks the WebView main thread long enough to freeze the
  // whole UI. Render only the most recent window; older items are revealed on
  // demand. Reset happens for free because {#key sessionId} recreates this view.
  const RENDER_WINDOW_INITIAL = 200;
  const RENDER_WINDOW_STEP = 300;
  let renderWindow = $state(RENDER_WINDOW_INITIAL);
  let hiddenItemCount = $derived.by(() => {
    let hidden = Math.max(0, renderItems.length - renderWindow);
    // Never hide the plan-approval anchor (lives near the tail, but guard anyway)
    // or its inline dialog would vanish while awaiting approval.
    if (planApprovalAnchorIndex >= 0 && hidden > planApprovalAnchorIndex) {
      hidden = planApprovalAnchorIndex;
    }
    return hidden;
  });
  let visibleRenderItems = $derived(
    hiddenItemCount > 0 ? renderItems.slice(hiddenItemCount) : renderItems,
  );

  // Collision-free keys for the message {#each}. Raw values are NOT unique:
  // message timestamps (ms) can collide within an event burst, and continuing a
  // background agent via SendMessage re-emits task_started with the SAME taskId
  // as the original Agent launch. Duplicate keys hang Svelte's keyed-each
  // reconciliation — observed as a whole-app freeze on any session containing a
  // continued agent. The occurrence counter is deterministic because item order
  // is stable across recomputes.
  let keyedVisibleItems = $derived.by(() => {
    const seen = new Map<string, number>();
    return visibleRenderItems.map((item) => {
      let base: string;
      if (item.type === "message") {
        base = `msg-${item.message.timestamp}`;
      } else if (item.type === "task") {
        base = `task-${item.taskStarted.toolUseId || item.taskStarted.taskId || item.taskStarted.timestamp}`;
      } else {
        base = `tool-group-${item.tools[0]?.timestamp ?? 0}`;
      }
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return { item, key: n === 0 ? base : `${base}#${n}` };
    });
  });

  let status = $derived(session?.status ?? "idle");
  let isQuerying = $derived(status === "querying");
  let isPendingRepo = $derived(status === "pending_repo");
  let isInitializing = $derived(status === "initializing");
  let isPendingTranscription = $derived(status === "pending_transcription");
  let isPendingApproval = $derived(status === "pending_approval");
  // Note: isLoading is suppressed when the session is waiting for user input
  // (plan approval or AskUserQuestion) to avoid showing a spinner alongside the dialog.
  let isWaitingForUserInput = $derived(!!session?.pendingPlanApproval || !!(session?.askUserQuestion?.questions?.length));
  let isLoading = $derived((isQuerying || isInitializing) && !isWaitingForUserInput);

  let showQuickActions = $derived(
    status === "idle" &&
      messages.length > 0 &&
      !isPendingRepo &&
      !isPendingTranscription &&
      !isPendingApproval,
  );
  let generatedQuickActions = $derived(session?.aiMetadata?.quickActions);
  let sessionOutcome = $derived(session?.aiMetadata?.outcome);
  let sessionCategory = $derived(session?.aiMetadata?.category);
  let isNewChat = $derived(messages.length === 0 && status === "idle");
  // Semi-stop state: the main agent's turn ended (sdk-done) but background subagents or
  // background commands are still running, so completion was deferred. Server-classified
  // commands can linger past a Done/idle status — surface everything so the UI never reads
  // as fully finished while real work continues. See SdkSession.liveSubagentIds /
  // liveBackgroundTasks.
  let completionDeferred = $derived(session?.completionDeferred ?? false);
  let liveSubagentCount = $derived(session?.liveSubagentIds?.length ?? 0);
  let liveBackgroundTasks = $derived(session?.liveBackgroundTasks ?? []);
  // Background agents are seen through two channels (SubagentStart/Stop hooks and the task
  // system) with uncorrelatable ids — take the max rather than double-counting.
  let liveAgentCount = $derived(
    Math.max(liveSubagentCount, liveBackgroundTasks.filter((t) => t.kind === "agent").length),
  );
  let liveCommandTasks = $derived(liveBackgroundTasks.filter((t) => t.kind === "command"));
  let liveServerTasks = $derived(liveBackgroundTasks.filter((t) => t.kind === "server"));
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

  // AskUserQuestion state
  let askUserQuestion = $derived(session?.askUserQuestion);
  let hasAskUserQuestions = $derived(!!(askUserQuestion?.questions?.length));

  // Plan approval state (ExitPlanMode interception)
  let pendingPlanApprovalRaw = $derived(session?.pendingPlanApproval);
  let hasPlanApproval = $derived(!!pendingPlanApprovalRaw);
  // Enrich pendingPlanApproval with plan content from ExitPlanMode message input
  // (fallback for sessions where plan wasn't extracted into state)
  let pendingPlanApproval = $derived.by(() => {
    if (!pendingPlanApprovalRaw) return undefined;
    if (pendingPlanApprovalRaw.plan) return pendingPlanApprovalRaw;
    // Find the ExitPlanMode message and extract plan from its input
    const messages = session?.messages;
    if (!messages) return pendingPlanApprovalRaw;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'tool_start' && msg.tool === 'ExitPlanMode') {
        const plan = (msg.input as { plan?: string })?.plan;
        if (plan) {
          return { ...pendingPlanApprovalRaw, plan };
        }
        break;
      }
    }
    return pendingPlanApprovalRaw;
  });
  $effect(() => {
    if (hasPlanApproval) {
      console.log(`[SdkView] Plan approval dialog should render (session: ${sessionId}, anchorIndex: ${planApprovalAnchorIndex}, renderItems: ${renderItems.length})`);
    }
  });
  let planApprovalAnchorIndex = $derived.by(() => {
    if (!hasPlanApproval || !pendingPlanApproval) return -1;

    const isPlanApprovalToolMessage = (msg: SdkMessage) =>
      (msg.type === "tool_start" || msg.type === "tool_result") &&
      msg.tool === "ExitPlanMode";

    // Prefer anchoring directly after the plan-approval tool (ExitPlanMode).
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

  export async function startInlineRecording() {
    await handleStartInlineRecording();
  }

  export async function stopInlineRecording() {
    await handleStopInlineRecording();
  }

  // Record-and-send variant (the mic-button flow) for the page-level
  // Shift+Space hold: transcribes and sends to the session on stop.
  export async function startSendRecording() {
    await handleStartRecording();
  }

  export async function stopSendRecording() {
    await handleStopRecording();
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
  let firstPrompt = $derived(() => {
    const firstUserMessage = messages.find((m) => m.type === "user");
    if (!firstUserMessage?.content) return null;
    return firstUserMessage.content.trim() || null;
  });

  // Scoped voice commands: while THIS view owns the live recording, a spoken
  // command ("send it", "cancel that", ...) stops the recording here — the
  // stop path's transcript processing routes cancel/transcribe/send within
  // this session. The global voice-command handler deliberately ignores
  // view-owned recordings (recording.getOwner() !== 'global'), so without
  // this listener spoken commands would only apply on manual stop.
  let unlistenVoiceCommand: UnlistenFn | null = null;

  onMount(() => {
    console.log(`[SdkView] Mount (session: ${sessionId})`);

    listen("voice-command-triggered", async () => {
      // Only the pane that started the recording reacts (multiple SdkViews
      // can be mounted in split panes).
      if (!isRecordingForCurrentSession || !get(isRecording)) return;
      if (get(settings).audio.play_sound_on_voice_command) {
        playVoiceCommandSound();
      }
      await handleStopRecording();
    }).then((unlisten) => {
      unlistenVoiceCommand = unlisten;
    });

    unsubscribe = sdkSessions.subscribe((sessions) => {
      const found = sessions.find((s) => s.id === sessionId);
      if (!session && found?.pendingPlanApproval) {
        console.log(`[SdkView] Initial mount found pendingPlanApproval (session: ${sessionId})`);
      }
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
        const autocompactChanged =
          found?.autocompactEnabled !== session?.autocompactEnabled;
        const contextOverflowChanged =
          !!found?.contextOverflow !== !!session?.contextOverflow;
        const failedRecordingChanged =
          found?.failedRecording?.audioId !==
            session?.failedRecording?.audioId ||
          found?.failedRecording?.error !== session?.failedRecording?.error;

        if (
          !session ||
          statusChanged ||
          messagesChanged ||
          cwdChanged ||
          modelChanged ||
          usageChanged ||
          pendingChanged ||
          aiMetadataChanged ||
          askUserQuestionChanged ||
          draftChanged ||
          planApprovalChanged ||
          autocompactChanged ||
          contextOverflowChanged ||
          failedRecordingChanged
        ) {
          if (planApprovalChanged) {
            console.log(`[SdkView] pendingPlanApproval changed (session: ${sessionId}, was: ${!!session?.pendingPlanApproval}, now: ${!!found?.pendingPlanApproval})`);
          }
          session = found || null;
        }
      }
    });
  });

  onDestroy(() => {
    console.log(`[SdkView] Destroy (session: ${sessionId}, hasPlanApproval: ${hasPlanApproval})`);
    persistCurrentScrollState(sessionId);
    unsubscribe?.();
    unlistenVoiceCommand?.();
    unlistenVoiceCommand = null;
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
    if (messagesEl) messagesEl.scrollTop = 0;
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

    if (status === "pending_approval") {
      return { status: "pending_approval" };
    }

    if (status === "initializing") {
      return { status: "initializing" };
    }

    if (status === "querying") {
      // Deferred completion: the main turn is done, we're just waiting on background
      // subagents and/or background commands.
      if (completionDeferred && liveAgentCount > 0) {
        return { status: "subagents", detail: String(liveAgentCount) };
      }
      if (completionDeferred && liveCommandTasks.length > 0) {
        return { status: "background_commands", detail: String(liveCommandTasks.length) };
      }

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
      case "subagents":
        return smartStatus.detail === "1"
          ? "Finishing 1 background agent..."
          : `Finishing ${smartStatus.detail} background agents...`;
      case "background_commands":
        return smartStatus.detail === "1"
          ? "Waiting for 1 background command..."
          : `Waiting for ${smartStatus.detail} background commands...`;
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

    // Capture realtime transcript before stopping (for dual-source cleanup)
    const capturedRealtimeTranscript = get(recording).realtimeTranscript;

    // Own the debug-recordings id so the LLM cleanup stage lands in the log.
    const debugId = recording.newRecordingId();

    let whisperTranscript: string | null;
    try {
      whisperTranscript = await recording.stopRecording(true, debugId);
    } catch (error) {
      // Transcription failed — keep the recording attached to THIS session (it was
      // meant for this conversation, not the pile) as a durable, retriable failed
      // recording rather than throwing and losing the audio.
      overlay.clearInlineSessionInfo();
      overlay.hide();
      isRecordingForCurrentSession = false;
      await salvageInSessionRecording(
        "send",
        capturedRealtimeTranscript,
        error instanceof Error ? error.message : "Transcription failed",
        debugId,
      );
      return;
    }

    // Hide overlay and clear inline session info
    overlay.clearInlineSessionInfo();
    overlay.hide();

    debugRecordings.update(debugId, { destination: "session" });

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
        capturedRealtimeTranscript,
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
            processed.realtimeTranscript,
            repoContext,
          );
          finalTranscript = cleanupResult.text;
          debugRecordings.update(debugId, {
            cleanedTranscript: finalTranscript,
            wasCleanedUp: cleanupResult.wasCleanedUp,
            cleanupCorrections: cleanupResult.corrections,
            usedDualSource: cleanupResult.usedDualSource,
          });

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

  /**
   * Stop the inline recording, transcribe it (+ LLM cleanup), and RETURN the
   * final text without inserting it. Returns null when nothing was transcribed
   * or the transcription failed (a failed follow-up is salvaged to this session
   * for retry). Shared by the record button/window hold (which append) and the
   * hold-Space gesture (which inserts at the caret).
   */
  async function transcribeInlineToText(): Promise<string | null> {
    if (!$isRecording) return null;

    // Capture realtime transcript before stopping (for dual-source cleanup)
    const capturedRealtimeTranscript = get(recording).realtimeTranscript;

    // Own the debug-recordings id so the LLM cleanup stage lands in the log.
    const debugId = recording.newRecordingId();

    isInlineRecordingForCurrentSession = false;
    isInlineTranscribing = true;

    try {
      let whisperTranscript: string | null;
      try {
        whisperTranscript = await recording.stopRecording(true, debugId);
      } catch (error) {
        // Transcription failed — keep the recording attached to THIS session as a
        // durable, retriable failed recording (it was meant for this conversation).
        await salvageInSessionRecording(
          "append",
          capturedRealtimeTranscript,
          error instanceof Error ? error.message : "Transcription failed",
          debugId,
        );
        return null;
      }

      if (!whisperTranscript) return null;

      debugRecordings.update(debugId, { destination: "append" });

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
            capturedRealtimeTranscript,
            repoContext,
          );
          finalTranscript = cleanupResult.text;
          debugRecordings.update(debugId, {
            cleanedTranscript: finalTranscript,
            wasCleanedUp: cleanupResult.wasCleanedUp,
            cleanupCorrections: cleanupResult.corrections,
            usedDualSource: cleanupResult.usedDualSource,
          });

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

      return finalTranscript;
    } finally {
      isInlineTranscribing = false;
      recording.clearTranscript();
    }
  }

  async function handleStopInlineRecording() {
    const text = await transcribeInlineToText();
    if (text) promptInputRef?.appendToPrompt(text);
  }

  // --- Failed follow-up recordings (transcription failed for a live session) ---
  // Kept attached to this session and retriable in place, instead of being sent to
  // the pile — the recording was intended for this conversation.
  let isRetryingFailedRecording = $state(false);

  /**
   * Persist a follow-up recording whose transcription failed to durable storage and
   * attach it to this session so it can be retried in place. Uses the in-memory audio
   * from the recording store; no-op if there is no audio.
   */
  async function salvageInSessionRecording(
    mode: "send" | "append",
    realtimeTranscript: string | undefined,
    error: string,
    debugRecordingId?: string,
  ) {
    const audioData = get(recording).audioData;
    if (!audioData) return;
    const audioId = crypto.randomUUID();
    try {
      await invoke("save_pile_audio", {
        id: audioId,
        audioData: Array.from(audioData),
      });
      sdkSessions.setFailedRecording(sessionId, {
        audioId,
        mode,
        realtimeTranscript,
        error,
        createdAt: Date.now(),
        debugRecordingId,
      });
    } catch (e) {
      console.error("[SdkView] Failed to store failed-recording audio:", e);
    }
  }

  async function handleRetryFailedRecording() {
    const fr = session?.failedRecording;
    if (!fr || isRetryingFailedRecording) return;
    isRetryingFailedRecording = true;
    try {
      const audioData = await invoke<number[]>("read_pile_audio", {
        id: fr.audioId,
      });
      const transcript = await invoke<string>("transcribe_audio", { audioData });

      if (!transcript || !transcript.trim()) {
        sdkSessions.setFailedRecording(sessionId, {
          ...fr,
          error: "No transcription returned",
        });
        return;
      }

      // Attach the successful retry to the original recording's log entry
      if (fr.debugRecordingId) {
        debugRecordings.update(fr.debugRecordingId, {
          whisperTranscript: transcript,
          error: undefined,
        });
      }

      // Apply LLM transcription cleanup (same as the live recording flow)
      let finalTranscript = transcript;
      if (isTranscriptionCleanupEnabled()) {
        const currentRepo =
          cwd && cwd !== "." ? $repos.list.find((r) => r.path === cwd) : null;
        const repoContext = currentRepo
          ? buildSingleRepoContext(currentRepo)
          : undefined;
        try {
          const cleanupResult = await cleanupTranscript(
            transcript,
            fr.realtimeTranscript,
            repoContext,
          );
          finalTranscript = cleanupResult.text;
          if (fr.debugRecordingId) {
            debugRecordings.update(fr.debugRecordingId, {
              cleanedTranscript: finalTranscript,
              wasCleanedUp: cleanupResult.wasCleanedUp,
              cleanupCorrections: cleanupResult.corrections,
              usedDualSource: cleanupResult.usedDualSource,
            });
          }
        } catch (e) {
          console.error("[SdkView] Retry cleanup failed, using original:", e);
        }
      }

      // Transcription succeeded — dispatch the transcript, THEN clean up the durable
      // audio (only once it has been consumed, so a send failure stays retriable).
      if (fr.mode === "send") {
        promptInputRef?.clearInput();
        await sdkSessions.sendPrompt(sessionId, finalTranscript);
      } else {
        promptInputRef?.appendToPrompt(finalTranscript);
      }
      invoke("delete_pile_audio", { id: fr.audioId }).catch(() => {});
      sdkSessions.clearFailedRecording(sessionId);
    } catch (error) {
      // Still failing (service down) — keep it retriable, refresh the error.
      sdkSessions.setFailedRecording(sessionId, {
        ...fr,
        error: error instanceof Error ? error.message : "Transcription failed",
      });
    } finally {
      isRetryingFailedRecording = false;
    }
  }

  async function handleDiscardFailedRecording() {
    const fr = session?.failedRecording;
    if (!fr) return;
    invoke("delete_pile_audio", { id: fr.audioId }).catch(() => {});
    sdkSessions.clearFailedRecording(sessionId);
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

  // --- Smart Queue: scheduling + queued state ---
  let isQueued = $derived(status === "queued");
  let queueInfo = $derived(session?.queueInfo);
  let sessionProvider = $derived(session?.provider ?? "claude");

  // Live countdown tick for queue/schedule labels (only runs while a countdown is shown).
  let nowTick = $state(Date.now());
  $effect(() => {
    if (!isQueued) return;
    nowTick = Date.now();
    const t = setInterval(() => {
      nowTick = Date.now();
    }, 1000);
    return () => clearInterval(t);
  });

  function formatCountdown(ms: number | undefined | null): string {
    if (ms == null) return "";
    const diff = ms - nowTick;
    if (diff <= 0) return "now";
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    const seconds = Math.floor((diff % 60_000) / 1000);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  // Queued-panel labels.
  let queueWindowLabel = $derived(
    queueInfo?.window === "7d"
      ? "weekly (7d)"
      : queueInfo?.window === "5h"
        ? "5-hour"
        : "",
  );
  let queueCountdown = $derived(formatCountdown(queueInfo?.targetStartAt));
  let queuedReasonLabel = $derived(
    queueInfo?.reason === "scheduled"
      ? "Scheduled"
      : queueInfo?.reason === "after_sessions"
        ? "Waiting for repo to go idle"
        : "Queued — rate limited",
  );

  // Only offer "send on next reset" for a live/active session that can take a
  // follow-up turn (has history and isn't querying).
  let canScheduleSend = $derived(
    (status === "idle" || status === "done") && messages.length > 0,
  );

  function handleRunQueuedNow() {
    sdkSessions.launchPrepared(sessionId);
  }

  // Revert a queued/scheduled session back to an editable New Session (setup)
  // draft so the user can change the prompt, model, repo, or schedule.
  function handleEditQueued() {
    sdkSessions.unschedule(sessionId);
  }

  // Take the session out of the queue entirely (close/discard).
  function handleRemoveQueued() {
    sdkSessions.closeSession(sessionId);
    activeSdkSessionId.set(null);
  }

  async function handleScheduleSend(
    window: QueueWindow,
    prompt: string,
    images?: SdkImageContent[],
  ) {
    await sdkSessions.queueTurnForWindow(sessionId, prompt, images, window);
  }

  // Ctrl+click Send / "Send when repo is idle": park the turn until every session
  // in this repo+worktree (including this one) has finished; sends immediately if
  // the scope is already idle.
  async function handleSendAfterIdle(prompt: string, images?: SdkImageContent[]) {
    await sdkSessions.queueTurnAfterSessions(sessionId, prompt, images);
  }

  /**
   * Demote a pending-approval prompt into the pile.
   * Carries over the session's processing results (cleanup, repo/model recs,
   * audio, waveform) so no LLM work is redone, then closes the session.
   */
  function handleDemoteToPile(prompt: string) {
    if (!session || !prompt.trim()) return;

    const pending = session.pendingTranscription;
    const repoPath = cwd;
    const repoFromRec =
      pending?.repoRecommendation != null
        ? $repos.list[pending.repoRecommendation.repoIndex]
        : undefined;
    const repoFromPath = repoPath && repoPath !== '.'
      ? $repos.list.find((r) => r.path === repoPath)
      : undefined;
    const repo = repoFromPath ?? repoFromRec;

    pile.addRecording({
      transcript: prompt.trim(),
      process: false,
      rawTranscript: pending?.transcript,
      realtimeTranscript: pending?.realtimeTranscript,
      wasCleanedUp: pending?.wasCleanedUp,
      cleanupCorrections: pending?.cleanupCorrections,
      usedDualSource: pending?.usedDualSource,
      audioData: pending?.audioData,
      recordingDurationMs:
        pending?.recordingDurationMs ??
        (pending?.recordingStartedAt ? Date.now() - pending.recordingStartedAt : undefined),
      audioVisualizationHistory: pending?.audioVisualizationHistory,
      // Pile items store a single screenshot; recordings only ever capture one
      screenshot: pending?.screenshots?.[0],
      repoId: repo?.id,
      repoConfidence: pending?.repoRecommendation?.confidence,
      repoReasoning: pending?.repoRecommendation?.reasoning,
      model: session.model,
      effortLevel: session.effortLevel,
    });

    sdkSessions.closeSession(sessionId);
    activeSdkSessionId.set(null);
    sidebarTab.set('pile');
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

  // No mistakes (validation pipeline) run for this session, if any.
  let nmRun = $derived(
    [...$nmRuns.values()].find((r) => r.sessionId === sessionId),
  );

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

<svelte:window onkeydown={(e) => {
  // Only the focused pane's instance reacts, so Escape doesn't stop every visible session.
  if (e.key === 'Escape' && isQuerying && sessionId === $focusedPaneSessionId) {
    e.preventDefault();
    handleStopQuery();
  }
}} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="sdk-view" onclick={markAsReadOnInteraction}>
  {#if session?.contextOverflow}
    <ContextOverflowBanner session={session} />
  {/if}

  {#if session?.rateLimited}
    <RateLimitBanner session={session} />
  {/if}

  {#if hasUsageData && usage}
    <SdkUsageBar
      {usage}
      {isQuerying}
      autocompactBufferTokens={session?.provider === 'claude' && session?.autocompactEnabled !== false ? 33000 : null}
    />
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
          onDemoteToPile={handleDemoteToPile}
          autoModelEffort={$settings.llm?.features?.auto_model_effort}
        />
      {/if}

      <!-- Queued session UI (rate-limited first launch or a scheduled launch) -->
      {#if isQueued}
        <div class="queued-panel" class:scheduled={queueInfo?.reason !== "rate_limit"}>
          <div class="queued-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <div class="queued-body">
            <div class="queued-title">{queuedReasonLabel}</div>
            <div class="queued-sub">
              {#if queueInfo?.reason === "scheduled"}
                Will launch at the next{queueWindowLabel ? ` ${queueWindowLabel}` : ""} reset{queueCountdown ? ` — in ${queueCountdown}` : ""}.
              {:else if queueInfo?.reason === "after_sessions"}
                Will launch once every other session in this repo/worktree has finished.
              {:else}
                Waiting for the{queueWindowLabel ? ` ${queueWindowLabel}` : ""} usage window to reset{queueCountdown ? ` — in ${queueCountdown}` : ""}.
              {/if}
            </div>
            {#if session?.preparedPrompt}
              <div class="queued-prompt">{session.preparedPrompt}</div>
            {/if}
            <div class="queued-actions">
              <button class="queued-btn primary" onclick={handleRunQueuedNow} title="Launch this session immediately">
                Run now
              </button>
              <button class="queued-btn" onclick={handleEditQueued} title="Move back to New Session to edit the prompt, model, or schedule">
                Edit
              </button>
              <button class="queued-btn" onclick={handleRemoveQueued} title="Take this session out of the queue and discard it">
                Remove from queue
              </button>
            </div>
          </div>
        </div>
      {/if}

      <!-- Completed recording context shown at the top of active sessions -->
      {#if hasCompletedRecordingData && pendingTranscription && !isPendingApproval}
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

      {#if hiddenItemCount > 0}
        <button
          class="load-earlier-btn"
          onclick={() => (renderWindow += RENDER_WINDOW_STEP)}
          title="Older messages are hidden to keep switching into this session fast"
        >
          Show earlier messages ({hiddenItemCount} hidden)
        </button>
      {/if}

      {#each keyedVisibleItems as keyed, visibleIndex (keyed.key)}
        {@const item = keyed.item}
        {@const index = visibleIndex + hiddenItemCount}
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
          {@const isPlanApprovalMsg = (item.message.type === "tool_start" || item.message.type === "tool_result") && item.message.tool === "ExitPlanMode"}
          {#if isPlanApprovalMsg && hasPlanApproval && pendingPlanApproval}
            <!-- Replace ExitPlanMode tool card with plan approval UI -->
            <PlanApprovalDialog
              {pendingPlanApproval}
              onApprove={handleApprovePlan}
              onApproveNewSession={handleApprovePlanNewSession}
              onDeny={handleDenyPlan}
            />
          {:else}
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
          {/if}
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
            nestedSummaries={item.nestedSummaries}
            {copiedMessageId}
            onCopy={copyMessage}
            sessionCwd={cwd}
            {sessionModel}
            {sessionEffortLevel}
            taskModel={(item.taskStarted.toolUseId &&
              session?.subagentModels?.[item.taskStarted.toolUseId]) ||
              item.taskModel ||
              ""}
          />
          </div>
        {/if}

        {#if hasPlanApproval && pendingPlanApproval && index === planApprovalAnchorIndex && item.type === "tool_group"}
          <!-- Plan approval after tool_group containing ExitPlanMode (grid mode) -->
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

      <!-- Background activity chips: agents (subagents running async), commands (backgrounded
           bash expected to finish — defers completion), and servers (pattern-matched bash that
           can run indefinitely and never blocks completion). Grouped tightly so they sit right
           under the loading indicator. -->
      {#if liveAgentCount > 0 || liveCommandTasks.length > 0 || liveServerTasks.length > 0}
        <div class="background-activity">
          {#if liveAgentCount > 0 || liveCommandTasks.length > 0}
            <div class="background-tasks-indicator">
              <span class="background-tasks-dot"></span>
              {[
                liveAgentCount > 0
                  ? `${liveAgentCount} agent${liveAgentCount === 1 ? "" : "s"}`
                  : null,
                liveCommandTasks.length > 0
                  ? `${liveCommandTasks.length} command${liveCommandTasks.length === 1 ? "" : "s"}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")} running in background
            </div>
          {/if}
          {#if liveServerTasks.length > 0}
            <div
              class="background-tasks-indicator"
              title={liveServerTasks.map((t) => t.label).join("\n")}
            >
              <span class="background-tasks-dot server-dot"></span>
              {#if liveServerTasks.length === 1}
                Server running: <span class="server-command-label">{liveServerTasks[0].label}</span>
              {:else}
                {liveServerTasks.length} servers running
              {/if}
            </div>
          {/if}
        </div>
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
          onSendAfterIdle={(prompt) => handleSendAfterIdle(prompt)}
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

  {#if nmRun}
    {@const nmRunId = nmRun.runId}
    <NoMistakesPanel
      run={nmRun}
      onRespond={(action, findingIds) => noMistakes.respond(nmRunId, action, findingIds)}
      onCancel={() => noMistakes.cancel(nmRunId)}
      onDismiss={() => noMistakes.dismiss(nmRunId)}
      onSelectFindings={(findingIds) => noMistakes.selectFindings(nmRunId, findingIds)}
    />
  {/if}

  {#if hasLaunchProfiles && sessionRepoId}
    <LaunchBar
      repoId={sessionRepoId}
      repoPath={cwd}
      repoBasePath={sessionRepo?.path ?? ''}
      profiles={repoLaunchProfiles}
      commands={repoLaunchCommands}
      runtime={$launchStore.runtimes[sessionRepoId] ?? null}
      queued={$queuedLaunch?.repoId === sessionRepoId ? $queuedLaunch : null}
      isAgentRunning={isQuerying}
      {sessionId}
    />
  {/if}

  {#if !isQueued}
    {#if session?.failedRecording}
      <div
        class="flex items-center gap-2 mx-3 mb-2 px-3 py-2 rounded-lg border border-amber-500/40 bg-amber-500/10"
      >
        <svg
          class="w-4 h-4 text-amber-500 shrink-0"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fill-rule="evenodd"
            d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
            clip-rule="evenodd"
          />
        </svg>
        <div class="flex flex-col min-w-0 flex-1">
          <span class="text-xs text-text-primary"
            >Transcription failed — recording kept for this session</span
          >
          {#if session.failedRecording.error}
            <span class="text-[10px] text-text-muted truncate"
              >{session.failedRecording.error}</span
            >
          {/if}
        </div>
        <button
          class="text-xs px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          onclick={handleRetryFailedRecording}
          disabled={isRetryingFailedRecording}
          title="Re-transcribe this recording and {session.failedRecording.mode ===
          'send'
            ? 'send it to this session'
            : 'append it to the prompt'}"
        >
          {isRetryingFailedRecording ? "Retrying…" : "Retry"}
        </button>
        <button
          class="text-xs px-2 py-1 rounded bg-surface hover:bg-background text-text-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          onclick={handleDiscardFailedRecording}
          disabled={isRetryingFailedRecording}
          title="Discard this recording"
        >
          Discard
        </button>
      </div>
    {/if}
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
      provider={sessionProvider}
      accountId={session?.accountId}
      showScheduleSend={canScheduleSend}
      onSendPrompt={handleSendPrompt}
      onScheduleSend={handleScheduleSend}
      onSendAfterIdle={handleSendAfterIdle}
      onStopQuery={handleStopQuery}
      onStartRecording={handleStartRecording}
      onStopRecording={handleStopRecording}
      onStartInlineRecording={handleStartInlineRecording}
      onStopInlineRecording={handleStopInlineRecording}
      onInlineTranscribe={transcribeInlineToText}
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

  /* Sit tight under the loading indicator: the parent .messages gap is 0.75rem,
     the negative margin halves it for this group. */
  .background-activity {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin-top: -0.375rem;
  }

  .background-tasks-indicator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.625rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    font-size: 0.75rem;
    color: var(--color-text-muted);
    width: fit-content;
  }

  .background-tasks-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-warning, #f59e0b);
    animation: background-tasks-pulse 1.6s ease-in-out infinite;
    flex-shrink: 0;
  }

  .background-tasks-dot.server-dot {
    background: var(--color-success, #10b981);
  }

  .server-command-label {
    font-family: var(--font-mono, monospace);
    max-width: 24rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @keyframes background-tasks-pulse {
    0%,
    100% {
      opacity: 0.4;
    }
    50% {
      opacity: 1;
    }
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
  .load-earlier-btn {
    display: block;
    margin: 0.5rem auto 0.75rem;
    padding: 0.375rem 0.875rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-text-secondary);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 9999px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .load-earlier-btn:hover {
    background: var(--color-surface-hover, var(--color-surface));
    color: var(--color-text);
  }

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

  /* Queued session panel */
  .queued-panel {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    margin: 0.5rem 0.75rem;
    border: 1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 40%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--color-warning, #f59e0b) 10%, transparent);
    color: var(--color-text-primary);
  }

  .queued-panel.scheduled {
    border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
    background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  }

  .queued-icon {
    flex-shrink: 0;
    color: var(--color-warning, #f59e0b);
    margin-top: 0.125rem;
  }

  .queued-panel.scheduled .queued-icon {
    color: var(--color-accent);
  }

  .queued-icon svg {
    width: 20px;
    height: 20px;
  }

  .queued-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .queued-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-warning, #f59e0b);
  }

  .queued-panel.scheduled .queued-title {
    color: var(--color-accent);
  }

  .queued-sub {
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    line-height: 1.4;
  }

  .queued-prompt {
    font-size: 0.8125rem;
    color: var(--color-text-primary);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 0.5rem 0.625rem;
    max-height: 6rem;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .queued-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.25rem;
    flex-wrap: wrap;
  }

  .queued-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 500;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text-primary);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }

  .queued-btn:hover {
    background: var(--color-border);
  }

  .queued-btn.primary {
    border-color: color-mix(in srgb, var(--color-accent) 50%, transparent);
    background: color-mix(in srgb, var(--color-accent) 18%, transparent);
  }

  .queued-btn.primary:hover {
    background: color-mix(in srgb, var(--color-accent) 28%, transparent);
  }
</style>
