import { writable, derived, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { settings } from './settings';
import { repos } from './repos';
import { playCompletionSound } from '$lib/utils/sound';
import { usageStats } from './usageStats';
import { saveSessionsToDisk } from './sessionPersistence';
import { analyzeSessionCompletion, generateSessionNameFromPrompt, isLlmEnabled, type QuickAction } from '$lib/utils/llm';
import { isAutoModel, modelSupportsEffort, resolveModelForApi, type SdkProvider } from '$lib/utils/models';
import type { McpServerConfig } from '$lib/types/mcp';

// =============================================================================
// Debounced Save
// =============================================================================

let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 2000;

function debouncedSave(): void {
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
  }
  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null;
    saveSessionsToDisk();
  }, SAVE_DEBOUNCE_MS);
}

// =============================================================================
// Types
// =============================================================================

export interface SdkImageContent {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  base64Data: string;
  width?: number;
  height?: number;
}

export interface SdkMessage {
  type: 'user' | 'text' | 'tool_start' | 'tool_result' | 'done' | 'error' | 'subagent_start' | 'subagent_stop' | 'thinking' | 'notification' | 'task_started' | 'task_completed';
  content?: string;
  images?: SdkImageContent[];
  tool?: string;
  toolUseId?: string;
  parentToolUseId?: string | null;
  input?: Record<string, unknown>;
  output?: string;
  agentId?: string;
  agentType?: string;
  transcriptPath?: string;
  thinkingDurationMs?: number;
  // Task lifecycle fields
  taskId?: string;
  description?: string;
  taskType?: string;
  taskStatus?: string;
  summary?: string;
  taskUsage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  timestamp: number;
}

export interface SdkUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  contextWindow: number;
}

export interface SdkProgressiveUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface SdkSessionUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  totalDurationMs: number;
  totalDurationApiMs: number;
  totalTurns: number;
  contextWindow: number;
  contextUsagePercent: number;
  queryUsage: SdkUsage[];
  progressiveInputTokens: number;
  progressiveOutputTokens: number;
  progressiveCacheReadTokens: number;
  progressiveCacheCreationTokens: number;
}

export interface SessionAiMetadata {
  name?: string;
  category?: string;
  outcome?: string;
  needsInteraction?: boolean;
  interactionReason?: string;
  interactionUrgency?: string;
  waitingFor?: string;
  quickActions?: QuickAction[];
}

export interface PlanningQuestionOption {
  label: string;
  description: string;
}

export interface PlanningQuestion {
  question: string;
  header: string;
  options: PlanningQuestionOption[];
  multiSelect: boolean;
}

export interface PlanningAnswer {
  questionIndex: number;
  selectedOptions: number[];
  textInput?: string;
}

export interface PlanModeState {
  isActive: boolean;
  questions: PlanningQuestion[];
  answers: PlanningAnswer[];
  currentQuestionIndex: number;
  planFilePath?: string;
  featureName?: string;
  planSummary?: string;
  isComplete: boolean;
}

export interface NoteModeState {
  isActive: boolean;
  /** Track if the initial note was created */
  noteCreated: boolean;
}

export type EffortLevel = null | 'low' | 'medium' | 'high' | 'max';
export type SettingsEffortLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

/** @deprecated Use EffortLevel instead */
export type ThinkingLevel = EffortLevel;
/** @deprecated Use SettingsEffortLevel instead */
export type SettingsThinkingLevel = SettingsEffortLevel;

export function settingsToStoreEffort(level: SettingsEffortLevel): EffortLevel {
  return level === 'off' ? null : level;
}

export function storeToSettingsEffort(level: EffortLevel): SettingsEffortLevel {
  return level === null ? 'off' : level;
}

/** @deprecated Use settingsToStoreEffort instead */
export function settingsToStoreThinking(level: string): EffortLevel {
  if (level === 'off') return null;
  if (level === 'on') return 'high'; // Legacy: 'on' maps to 'high' effort
  return level as EffortLevel;
}

/** @deprecated Use storeToSettingsEffort instead */
export function storeToSettingsThinking(level: EffortLevel): SettingsEffortLevel {
  return storeToSettingsEffort(level);
}

export interface PendingRepoSelection {
  transcript: string;
  recommendedIndex: number | null;
  reasoning: string;
  confidence: string;
}

export type PendingTranscriptionStatus = 'recording' | 'transcribing' | 'processing';

export interface PendingTranscriptionInfo {
  status: PendingTranscriptionStatus;
  audioVisualizationHistory?: number[][];
  recordingStartedAt?: number;
  recordingDurationMs?: number;
  audioData?: Uint8Array;
  transcript?: string;
  transcriptionError?: string;
  voskTranscript?: string;
  cleanedTranscript?: string;
  wasCleanedUp?: boolean;
  cleanupCorrections?: string[];
  usedDualSource?: boolean;
  modelRecommendation?: {
    modelId: string;
    reasoning: string;
    effortLevel?: string;
    /** @deprecated Use effortLevel */
    thinkingLevel?: string;
  };
  repoRecommendation?: {
    repoIndex: number;
    repoName: string;
    reasoning: string;
    confidence: string;
  };
}

export interface SdkSession {
  id: string;
  cwd: string;
  model: string;
  provider?: SdkProvider;
  autoModelRequested?: boolean;
  effortLevel: EffortLevel;
  /** @deprecated Use effortLevel */
  thinkingLevel?: EffortLevel;
  messages: SdkMessage[];
  status: 'setup' | 'pending_transcription' | 'pending_repo' | 'pending_approval' | 'prepared' | 'initializing' | 'idle' | 'querying' | 'done' | 'error';
  createdAt: number;
  startedAt?: number;
  accumulatedDurationMs: number;
  currentWorkStartedAt?: number;
  usage?: SdkSessionUsage;
  unread?: boolean;
  aiMetadata?: SessionAiMetadata;
  pendingRepoSelection?: PendingRepoSelection;
  pendingPrompt?: string;
  pendingApprovalPrompt?: string;
  pendingTranscription?: PendingTranscriptionInfo;
  planMode?: PlanModeState;
  noteMode?: NoteModeState;
  draftPrompt?: string;
  draftImages?: SdkImageContent[];
  /** SDK session ID for proper resume after app restart (persisted) */
  sdkSessionId?: string;
  /** Prompt stored for a prepared session (ready to launch) */
  preparedPrompt?: string;
  /** System prompt stored for a prepared session */
  preparedSystemPrompt?: string;
  /** Repo recommendation stored for a prepared session (low-confidence case) */
  preparedRepoRecommendation?: { recommendedIndex: number | null; reasoning: string; confidence: string };
  /** Queued system notifications to prepend to the next query (e.g., parallel agent alerts) */
  pendingSystemNotifications?: string[];
}

export type HistoryMessage =
  | { type: 'user'; content: string }
  | { type: 'assistant'; content: string }
  | { type: 'tool_use'; tool: string; input: unknown }
  | { type: 'tool_result'; tool: string; output: string };

// =============================================================================
// Helper Functions
// =============================================================================

/** Create default usage object for new sessions */
function createDefaultUsage(contextWindow = 200000): SdkSessionUsage {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCostUsd: 0,
    totalDurationMs: 0,
    totalDurationApiMs: 0,
    totalTurns: 0,
    contextWindow,
    contextUsagePercent: 0,
    queryUsage: [],
    progressiveInputTokens: 0,
    progressiveOutputTokens: 0,
    progressiveCacheReadTokens: 0,
    progressiveCacheCreationTokens: 0,
  };
}

/** Convert SDK messages to history messages for session restoration */
function convertToHistoryMessages(messages: SdkMessage[]): HistoryMessage[] {
  const history: HistoryMessage[] = [];

  for (const msg of messages) {
    switch (msg.type) {
      case 'user':
        if (msg.content) {
          history.push({ type: 'user', content: msg.content });
        }
        break;
      case 'text':
        if (msg.content) {
          history.push({ type: 'assistant', content: msg.content });
        }
        break;
      case 'tool_start':
        if (msg.tool && msg.input) {
          history.push({ type: 'tool_use', tool: msg.tool, input: msg.input });
        }
        break;
      case 'tool_result':
        if (msg.tool && msg.output) {
          history.push({ type: 'tool_result', tool: msg.tool, output: msg.output });
        }
        break;
    }
  }

  return history;
}

/** Calculate work period time and return updated accumulated duration */
function calculateWorkPeriod(session: SdkSession): { accumulatedDurationMs: number; currentWorkStartedAt: undefined } {
  const now = Date.now();
  const workPeriodMs = session.currentWorkStartedAt ? now - session.currentWorkStartedAt : 0;
  return {
    accumulatedDurationMs: session.accumulatedDurationMs + workPeriodMs,
    currentWorkStartedAt: undefined,
  };
}

/** Process final usage from a query and return updated session usage */
function processQueryUsage(prevUsage: SdkSessionUsage | undefined, queryUsage: SdkUsage): SdkSessionUsage {
  const prev = prevUsage || createDefaultUsage(queryUsage.contextWindow);
  const contextWindow = queryUsage.contextWindow || prev.contextWindow || 200000;
  // Total input tokens includes uncached + cached tokens (cache_read + cache_creation)
  // See: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
  const totalInputTokens = queryUsage.inputTokens + queryUsage.cacheReadTokens + queryUsage.cacheCreationTokens;
  const currentContextTokens = totalInputTokens + queryUsage.outputTokens;
  const contextUsagePercent = Math.min(100, (currentContextTokens / contextWindow) * 100);

  return {
    totalInputTokens: prev.totalInputTokens + queryUsage.inputTokens,
    totalOutputTokens: prev.totalOutputTokens + queryUsage.outputTokens,
    totalCacheReadTokens: prev.totalCacheReadTokens + queryUsage.cacheReadTokens,
    totalCacheCreationTokens: prev.totalCacheCreationTokens + queryUsage.cacheCreationTokens,
    totalCostUsd: prev.totalCostUsd + queryUsage.totalCostUsd,
    totalDurationMs: prev.totalDurationMs + queryUsage.durationMs,
    totalDurationApiMs: prev.totalDurationApiMs + queryUsage.durationApiMs,
    totalTurns: prev.totalTurns + queryUsage.numTurns,
    contextWindow,
    contextUsagePercent,
    queryUsage: [...prev.queryUsage, queryUsage],
    progressiveInputTokens: 0,
    progressiveOutputTokens: 0,
    progressiveCacheReadTokens: 0,
    progressiveCacheCreationTokens: 0,
  };
}

/** Process progressive usage and return updated session usage */
function processProgressiveUsage(prevUsage: SdkSessionUsage | undefined, progressiveUsage: SdkProgressiveUsage): SdkSessionUsage {
  const prev = prevUsage || createDefaultUsage();
  // Progressive usage values from the SDK are cumulative for the current request, not deltas
  // So we use the latest values directly instead of accumulating
  const progressiveInputTokens = progressiveUsage.inputTokens;
  const progressiveOutputTokens = progressiveUsage.outputTokens;
  const progressiveCacheReadTokens = progressiveUsage.cacheReadTokens;
  const progressiveCacheCreationTokens = progressiveUsage.cacheCreationTokens;
  // Total tokens includes uncached + cached tokens for accurate context usage
  const liveCurrentTokens = progressiveInputTokens + progressiveCacheReadTokens + progressiveCacheCreationTokens + progressiveOutputTokens;
  const contextUsagePercent = Math.min(100, (liveCurrentTokens / prev.contextWindow) * 100);

  return {
    ...prev,
    contextUsagePercent,
    progressiveInputTokens,
    progressiveOutputTokens,
    progressiveCacheReadTokens,
    progressiveCacheCreationTokens,
  };
}

// =============================================================================
// Store Implementation
// =============================================================================

function createSdkSessionsStore() {
  const { subscribe, set, update } = writable<SdkSession[]>([]);
  const listeners = new Map<string, UnlistenFn[]>();
  const liveSessions = new Set<string>();
  let sidecarStarted = false;

  // ---------------------------------------------------------------------------
  // Event Listener Setup (Single implementation, used by all initialization paths)
  // ---------------------------------------------------------------------------

  async function setupEventListeners(id: string): Promise<UnlistenFn[]> {
    const unlisteners: UnlistenFn[] = [];

    // Text events (payload includes parentToolUseId for task scoping)
    unlisteners.push(
      await listen<{ content: string; parentToolUseId?: string | null }>(`sdk-text-${id}`, (e) => {
        const { content, parentToolUseId } = e.payload;
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? {
                  ...s,
                  startedAt: s.startedAt || Date.now(),
                  currentWorkStartedAt: s.currentWorkStartedAt || Date.now(),
                  messages: [...s.messages, { type: 'text' as const, content, parentToolUseId: parentToolUseId || undefined, timestamp: Date.now() }],
                }
              : s
          )
        );
        debouncedSave();
      })
    );

    // Tool start events
    unlisteners.push(
      await listen<{ tool: string; input: Record<string, unknown>; toolUseId: string; parentToolUseId?: string | null }>(
        `sdk-tool-start-${id}`,
        (e) => {
          usageStats.trackToolCall(e.payload.tool);
          update(sessions =>
            sessions.map(s =>
              s.id === id
                ? {
                    ...s,
                    startedAt: s.startedAt || Date.now(),
                    currentWorkStartedAt: s.currentWorkStartedAt || Date.now(),
                    messages: [
                      ...s.messages,
                      {
                        type: 'tool_start' as const,
                        tool: e.payload.tool,
                        toolUseId: e.payload.toolUseId,
                        input: e.payload.input,
                        parentToolUseId: e.payload.parentToolUseId || undefined,
                        timestamp: Date.now(),
                      },
                    ],
                  }
                : s
            )
          );
          debouncedSave();
        }
      )
    );

    // Tool result events
    unlisteners.push(
      await listen<{ tool: string; output: string; toolUseId: string; parentToolUseId?: string | null }>(`sdk-tool-result-${id}`, (e) => {
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? {
                  ...s,
                  messages: [
                    ...s.messages,
                    {
                      type: 'tool_result' as const,
                      tool: e.payload.tool,
                      toolUseId: e.payload.toolUseId,
                      output: e.payload.output,
                      parentToolUseId: e.payload.parentToolUseId || undefined,
                      timestamp: Date.now(),
                    },
                  ],
                }
              : s
          )
        );
        debouncedSave();
      })
    );

    // Thinking start events
    unlisteners.push(
      await listen<{ content: string; timestamp: number; parentToolUseId?: string | null }>(`sdk-thinking-start-${id}`, (e) => {
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? {
                  ...s,
                  messages: [
                    ...s.messages,
                    { type: 'thinking' as const, content: e.payload.content, parentToolUseId: e.payload.parentToolUseId || undefined, timestamp: e.payload.timestamp },
                  ],
                }
              : s
          )
        );
      })
    );

    // Thinking end events
    unlisteners.push(
      await listen<{ durationMs: number; content: string; parentToolUseId?: string | null }>(`sdk-thinking-end-${id}`, (e) => {
        const payloadParent = e.payload.parentToolUseId || undefined;
        update(sessions =>
          sessions.map(s => {
            if (s.id !== id) return s;
            const messages = [...s.messages];
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].type === 'thinking' && !messages[i].thinkingDurationMs && messages[i].parentToolUseId === payloadParent) {
                messages[i] = { ...messages[i], thinkingDurationMs: e.payload.durationMs, content: e.payload.content };
                break;
              }
            }
            return { ...s, messages };
          })
        );
      })
    );

    // Done events
    unlisteners.push(
      await listen(`sdk-done-${id}`, async () => {
        const currentSettings = get(settings);
        let sessionMessages: SdkMessage[] = [];
        let needsAiAnalysis = false;

        update(sessions =>
          sessions.map(s => {
            if (s.id !== id) return s;

            const workPeriod = calculateWorkPeriod(s);
            const updatedMessages = [...s.messages, { type: 'done' as const, timestamp: Date.now() }];
            sessionMessages = updatedMessages;
            needsAiAnalysis = isLlmEnabled() && !s.planMode?.isActive && (!s.aiMetadata?.outcome || s.aiMetadata?.needsInteraction === undefined);

            return {
              ...s,
              status: 'idle' as const,
              ...workPeriod,
              messages: updatedMessages,
              unread: currentSettings.mark_sessions_unread ? true : s.unread,
            };
          })
        );
        debouncedSave();

        if (currentSettings.audio.play_sound_on_completion) {
          playCompletionSound();
        }

        if (needsAiAnalysis && sessionMessages.length > 0) {
          analyzeSessionCompletion(sessionMessages)
            .then(aiMetadata => {
              if (Object.keys(aiMetadata).length > 0) {
                update(sessions =>
                  sessions.map(s => s.id === id ? { ...s, aiMetadata: { ...s.aiMetadata, ...aiMetadata } } : s)
                );
                debouncedSave();
              }
            })
            .catch(err => console.error('[sdkSessions] Failed to analyze session completion:', err));
        }
      })
    );

    // Error events
    unlisteners.push(
      await listen<string>(`sdk-error-${id}`, (e) => {
        const currentSettings = get(settings);
        update(sessions =>
          sessions.map(s => {
            if (s.id !== id) return s;
            const workPeriod = calculateWorkPeriod(s);
            return {
              ...s,
              status: 'error' as const,
              ...workPeriod,
              messages: [...s.messages, { type: 'error' as const, content: e.payload, timestamp: Date.now() }],
              unread: currentSettings.mark_sessions_unread ? true : s.unread,
            };
          })
        );
        debouncedSave();
      })
    );

    // Usage events
    unlisteners.push(
      await listen<SdkUsage>(`sdk-usage-${id}`, (e) => {
        const queryUsage = e.payload;
        usageStats.trackTokenUsage(
          queryUsage.inputTokens,
          queryUsage.outputTokens,
          queryUsage.cacheReadTokens,
          queryUsage.cacheCreationTokens,
          queryUsage.totalCostUsd
        );

        update(sessions =>
          sessions.map(s => s.id === id ? { ...s, usage: processQueryUsage(s.usage, queryUsage) } : s)
        );
      })
    );

    // Progressive usage events
    unlisteners.push(
      await listen<SdkProgressiveUsage>(`sdk-progressive-usage-${id}`, (e) => {
        update(sessions =>
          sessions.map(s => s.id === id ? { ...s, usage: processProgressiveUsage(s.usage, e.payload) } : s)
        );
      })
    );

    // Subagent start events
    unlisteners.push(
      await listen<{ agentId: string; agentType: string }>(`sdk-subagent-start-${id}`, (e) => {
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? {
                  ...s,
                  messages: [
                    ...s.messages,
                    { type: 'subagent_start' as const, agentId: e.payload.agentId, agentType: e.payload.agentType, timestamp: Date.now() },
                  ],
                }
              : s
          )
        );
        debouncedSave();
      })
    );

    // Subagent stop events
    unlisteners.push(
      await listen<{ agentId: string; transcriptPath: string }>(`sdk-subagent-stop-${id}`, (e) => {
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? {
                  ...s,
                  messages: [
                    ...s.messages,
                    { type: 'subagent_stop' as const, agentId: e.payload.agentId, transcriptPath: e.payload.transcriptPath, timestamp: Date.now() },
                  ],
                }
              : s
          )
        );
        debouncedSave();
      })
    );

    // Task started events (from SDK task_started system messages)
    unlisteners.push(
      await listen<{ taskId: string; toolUseId?: string; description: string; taskType?: string }>(`sdk-task-started-${id}`, (e) => {
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? {
                  ...s,
                  messages: [
                    ...s.messages,
                    {
                      type: 'task_started' as const,
                      taskId: e.payload.taskId,
                      toolUseId: e.payload.toolUseId,
                      description: e.payload.description,
                      taskType: e.payload.taskType,
                      timestamp: Date.now(),
                    },
                  ],
                }
              : s
          )
        );
        debouncedSave();
      })
    );

    // Task completed events (from SDK task_notification system messages)
    unlisteners.push(
      await listen<{ taskId: string; toolUseId?: string; status: string; summary: string; usage?: { total_tokens: number; tool_uses: number; duration_ms: number } }>(`sdk-task-completed-${id}`, (e) => {
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? {
                  ...s,
                  messages: [
                    ...s.messages,
                    {
                      type: 'task_completed' as const,
                      taskId: e.payload.taskId,
                      toolUseId: e.payload.toolUseId,
                      taskStatus: e.payload.status,
                      summary: e.payload.summary,
                      taskUsage: e.payload.usage,
                      timestamp: Date.now(),
                    },
                  ],
                }
              : s
          )
        );
        debouncedSave();
      })
    );

    // Planning questions events
    unlisteners.push(
      await listen<PlanningQuestion[]>(`sdk-planning-questions-${id}`, (e) => {
        update(sessions =>
          sessions.map(s => {
            if (s.id !== id || !s.planMode) return s;
            return {
              ...s,
              planMode: {
                ...s.planMode,
                questions: [...s.planMode.questions, ...e.payload],
                currentQuestionIndex: s.planMode.currentQuestionIndex >= s.planMode.questions.length
                  ? s.planMode.questions.length
                  : s.planMode.currentQuestionIndex,
              },
            };
          })
        );
        debouncedSave();
      })
    );

    // Planning complete events
    unlisteners.push(
      await listen<{ planPath: string; featureName: string; summary: string }>(`sdk-planning-complete-${id}`, (e) => {
        update(sessions =>
          sessions.map(s => {
            if (s.id !== id || !s.planMode) return s;
            return {
              ...s,
              planMode: { ...s.planMode, isComplete: true, planFilePath: e.payload.planPath, featureName: e.payload.featureName, planSummary: e.payload.summary },
              aiMetadata: { ...s.aiMetadata, name: `Plan: ${e.payload.featureName}` },
            };
          })
        );
        debouncedSave();
      })
    );

    // SDK session ID events - capture for proper resume after app restart
    unlisteners.push(
      await listen<string>(`sdk-session-id-${id}`, (e) => {
        console.log(`[sdkSessions] Captured SDK session ID for ${id}: ${e.payload}`);
        update(sessions =>
          sessions.map(s => s.id === id ? { ...s, sdkSessionId: e.payload } : s)
        );
        debouncedSave();
      })
    );

    // Parallel session notification - another session was started in the same CWD
    unlisteners.push(
      await listen<string>(`sdk-parallel-notification-${id}`, (e) => {
        console.log(`[sdkSessions] Parallel session notification for ${id}: ${e.payload}`);
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? {
                  ...s,
                  messages: [...s.messages, {
                    type: 'notification' as const,
                    content: e.payload,
                    timestamp: Date.now(),
                  }],
                }
              : s
          )
        );
        debouncedSave();
      })
    );

    return unlisteners;
  }

  // ---------------------------------------------------------------------------
  // Backend Session Registration
  // ---------------------------------------------------------------------------

  async function registerSessionWithBackend(
    id: string,
    cwd: string,
    model: string,
    effortLevel: EffortLevel,
    systemPrompt?: string | null,
    historyMessages?: HistoryMessage[] | null,
    sdkSessionId?: string | null, // SDK session ID for proper resume (preferred over historyMessages)
    planMode?: boolean,
    noteMode?: boolean,
    provider?: string
  ): Promise<void> {
    const currentSettings = get(settings);
    const resolvedModel = resolveModelForApi(model, currentSettings.enabled_models);

    // Determine which MCP servers to use
    // For note mode: use note_mcp_servers from repo config
    // For regular mode: use mcp_servers from repo config or all enabled global servers
    let mcpServers = null;
    console.log('[MCP Debug] Total MCP servers in settings:', currentSettings.mcp?.servers?.length ?? 0);
    if (currentSettings.mcp?.servers?.length > 0) {
      const repo = get(repos).list.find((r) => r.path === cwd);
      console.log('[MCP Debug] Session cwd:', cwd);
      console.log('[MCP Debug] Found repo:', repo?.name, 'with mcp_servers:', repo?.mcp_servers, 'note_mcp_servers:', repo?.note_mcp_servers);
      let servers: McpServerConfig[];

      if (noteMode) {
        // Note mode: only use note_mcp_servers from repo config
        if (repo?.note_mcp_servers?.length) {
          servers = currentSettings.mcp.servers.filter(
            (s) => s.enabled && repo.note_mcp_servers!.includes(s.id)
          );
          console.log('[MCP Debug] Note mode: using repo note_mcp_servers:', servers.length);
        } else {
          // No note MCP servers configured - note mode won't have MCP tools
          servers = [];
          console.log('[MCP Debug] Note mode: no note_mcp_servers configured');
        }
      } else if (repo?.mcp_servers?.length) {
        // Use repo-specific servers
        servers = currentSettings.mcp.servers.filter(
          (s) => s.enabled && repo.mcp_servers!.includes(s.id)
        );
        console.log('[MCP Debug] Using repo-specific servers:', servers.length);
      } else {
        // Use all enabled global servers
        servers = currentSettings.mcp.servers.filter((s) => s.enabled);
        console.log('[MCP Debug] Using all enabled global servers:', servers.length);
      }
      console.log('[MCP Debug] Servers to register:', servers.map(s => ({ id: s.id, name: s.name, enabled: s.enabled, type: s.server_type })));

      // Inject auth headers for HTTP/SSE servers that have authentication configured
      mcpServers = await Promise.all(
        servers.map(async (server) => {
          // Skip stdio servers (they don't use headers)
          if (server.server_type === 'stdio') {
            return server;
          }

          // Skip servers without auth
          if (!server.auth_type || server.auth_type === 'none') {
            return server;
          }

          // Get auth header from secure storage
          try {
            const authHeader = await invoke<string | null>('get_mcp_auth_header', {
              serverId: server.id,
            });

            if (authHeader) {
              // Inject Authorization header
              return {
                ...server,
                headers: {
                  ...server.headers,
                  Authorization: authHeader,
                },
              };
            }
          } catch (e) {
            console.warn(`Failed to get auth header for MCP server ${server.name}:`, e);
          }

          return server;
        })
      );
    }

    console.log('[MCP Debug] Final mcpServers to send:', mcpServers?.length ?? 0, mcpServers);

    // Prefer SDK session ID for proper resume, fall back to history messages
    // The SDK session ID allows proper conversation continuation without re-sending all history
    const usesSdkSessionId = sdkSessionId && sdkSessionId.length > 0;
    if (usesSdkSessionId) {
      console.log(`[sdkSessions] Using SDK session ID for resume: ${sdkSessionId}`);
    } else if (historyMessages && historyMessages.length > 0) {
      console.log(`[sdkSessions] Using legacy history messages: ${historyMessages.length} messages`);
    }

    await invoke('create_sdk_session', {
      id,
      cwd,
      model: resolvedModel,
      codexMode: provider === 'openai' ? currentSettings.codex_mode : null,
      systemPrompt: systemPrompt ?? null,
      // Only send history messages if we don't have an SDK session ID (legacy fallback)
      messages: !usesSdkSessionId && historyMessages && historyMessages.length > 0 ? historyMessages : null,
      sdkSessionId: usesSdkSessionId ? sdkSessionId : null,
      planMode: planMode ?? null,
      noteMode: noteMode ?? null,
      mcpServers: mcpServers && mcpServers.length > 0 ? mcpServers : null,
      provider: provider ?? null,
    });

    if (effortLevel && modelSupportsEffort(model)) {
      await invoke('update_sdk_effort', { id, effortLevel });
    }

    liveSessions.add(id);
  }

  // ---------------------------------------------------------------------------
  // Store Methods
  // ---------------------------------------------------------------------------

  return {
    subscribe,
    set,

    async ensureSidecarStarted(): Promise<void> {
      if (sidecarStarted) return;
      await invoke('start_sidecar');
      sidecarStarted = true;
    },

    async createSession(cwd: string, model: string, effortLevel: EffortLevel = null, systemPrompt?: string, planMode?: boolean, provider?: SdkProvider): Promise<string> {
      await this.ensureSidecarStarted();

      const id = crypto.randomUUID();
      const autoModelRequested = isAutoModel(model);

      const effectiveEffort = modelSupportsEffort(model) ? effortLevel : null;

      const session: SdkSession = {
        id,
        cwd,
        model,
        provider,
        autoModelRequested,
        effortLevel: effectiveEffort,
        messages: [],
        status: 'idle',
        createdAt: Date.now(),
        accumulatedDurationMs: 0,
      };

      update(sessions => [...sessions, session]);

      // For Codex sessions in the same CWD, queue pending notifications
      // (Claude sessions are handled by the sidecar via PreToolUse hook + parallel_session_notification event)
      const currentSettings = get(settings);
      if (currentSettings.notify_parallel_agents && provider === 'openai') {
        let currentSessions: SdkSession[] = [];
        subscribe(s => { currentSessions = s; })();

        const parallelCodexSessions = currentSessions.filter(
          s => s.id !== id
            && s.cwd === cwd
            && s.provider === 'openai'
            && !['done', 'error', 'setup'].includes(s.status)
        );

        if (parallelCodexSessions.length > 0) {
          const notificationText =
            '<system-message>\n' +
            'Another AI agent session was just started in this same repository. ' +
            'Multiple agents are now working here simultaneously. ' +
            'Re-check the current state of any files before modifying them to avoid conflicts.\n' +
            '</system-message>';

          update(sessions =>
            sessions.map(s => {
              if (parallelCodexSessions.some(p => p.id === s.id)) {
                return {
                  ...s,
                  messages: [...s.messages, {
                    type: 'notification' as const,
                    content: 'Another agent session was started in this repository. Multiple agents are now working here simultaneously.',
                    timestamp: Date.now(),
                  }],
                  pendingSystemNotifications: [
                    ...(s.pendingSystemNotifications || []),
                    notificationText,
                  ],
                };
              }
              return s;
            })
          );
        }
      }

      const unlisteners = await setupEventListeners(id);
      listeners.set(id, unlisteners);

      await registerSessionWithBackend(id, cwd, model, effectiveEffort, systemPrompt, null, null, planMode, undefined, provider);

      const resolvedModel = resolveModelForApi(model, currentSettings.enabled_models);
      usageStats.trackSession('sdk', resolvedModel, cwd);

      return id;
    },

    async ensureSessionLive(id: string): Promise<void> {
      if (liveSessions.has(id)) return;

      let session: SdkSession | undefined;
      subscribe(sessions => { session = sessions.find(s => s.id === id); })();

      if (!session) throw new Error(`Session ${id} not found`);

      await this.ensureSidecarStarted();

      const unlisteners = await setupEventListeners(id);
      listeners.set(id, unlisteners);

      // Prefer SDK session ID for proper resume (avoids context bloat from prepending history)
      // Fall back to history messages only if no SDK session ID is available (legacy sessions)
      const historyMessages = session.sdkSessionId ? null : convertToHistoryMessages(session.messages);
      await registerSessionWithBackend(id, session.cwd, session.model, session.effortLevel, null, historyMessages, session.sdkSessionId, undefined, undefined, session.provider);
    },

    async sendPrompt(id: string, prompt: string, images?: SdkImageContent[]): Promise<void> {
      await this.ensureSessionLive(id);

      let sessionCwd: string | undefined;
      let needsNameGeneration = false;
      subscribe(sessions => {
        const session = sessions.find(s => s.id === id);
        sessionCwd = session?.cwd;
        needsNameGeneration = !session?.aiMetadata?.name && session?.messages.filter(m => m.type === 'user').length === 0;
      })();

      usageStats.trackPrompt(sessionCwd);

      update(sessions =>
        sessions.map(s =>
          s.id === id
            ? {
                ...s,
                status: 'querying' as const,
                messages: [...s.messages, { type: 'user' as const, content: prompt, images, timestamp: Date.now() }],
                aiMetadata: s.aiMetadata ? { ...s.aiMetadata, needsInteraction: undefined, interactionReason: undefined, interactionUrgency: undefined, waitingFor: undefined } : s.aiMetadata,
              }
            : s
        )
      );

      if (needsNameGeneration && isLlmEnabled()) {
        generateSessionNameFromPrompt(prompt)
          .then(aiMetadata => {
            if (aiMetadata.name) {
              update(sessions => sessions.map(s => s.id === id ? { ...s, aiMetadata: { ...s.aiMetadata, ...aiMetadata } } : s));
            }
          })
          .catch(err => console.error('[sdkSessions] Failed to generate session name:', err));
      }

      // Check for and consume pending system notifications (e.g., parallel agent alerts)
      let finalPrompt = prompt;
      let pendingNotifications: string[] | undefined;
      subscribe(sessions => {
        pendingNotifications = sessions.find(s => s.id === id)?.pendingSystemNotifications;
      })();

      if (pendingNotifications?.length) {
        finalPrompt = pendingNotifications.join('\n\n') + '\n\n' + prompt;
        update(sessions =>
          sessions.map(s =>
            s.id === id ? { ...s, pendingSystemNotifications: undefined } : s
          )
        );
      }

      try {
        await invoke('send_sdk_prompt', { id, prompt: finalPrompt, images: images ?? null });
      } catch (error) {
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? { ...s, status: 'error' as const, messages: [...s.messages, { type: 'error' as const, content: String(error), timestamp: Date.now() }] }
              : s
          )
        );
        throw error;
      }
    },

    async stopQuery(id: string): Promise<void> {
      if (!liveSessions.has(id)) {
        update(sessions => sessions.map(s => s.id === id ? { ...s, status: 'idle' as const } : s));
        return;
      }

      await invoke('stop_sdk_query', { id });
      update(sessions => sessions.map(s => s.id === id ? { ...s, status: 'idle' as const } : s));
    },

    async closeSession(id: string): Promise<void> {
      // Capture session data for archiving before removing
      let sessionToArchive: SdkSession | undefined;
      subscribe(sessions => {
        sessionToArchive = sessions.find(s => s.id === id);
      })();

      // Only try to close sidecar session if it was actually started
      if (liveSessions.has(id)) {
        try {
          await invoke('close_sdk_session', { id });
        } catch (error) {
          console.error('Failed to close SDK session:', error);
        }
      }

      const unlisteners = listeners.get(id);
      if (unlisteners) {
        for (const unlisten of unlisteners) unlisten();
        listeners.delete(id);
      }

      liveSessions.delete(id);
      update(sessions => sessions.filter(s => s.id !== id));

      // Archive the session (only if it has messages worth archiving)
      if (sessionToArchive && sessionToArchive.messages.length > 0) {
        try {
          const { sdkSessionToPersisted } = await import('./sessionPersistence');
          const persisted = sdkSessionToPersisted(sessionToArchive);
          await invoke('archive_sdk_session', { session: persisted });
          // Trim archive to configured max
          const currentSettings = get(settings);
          await invoke('trim_archive', {
            maxEntries: currentSettings.session_persistence?.max_archived_sessions ?? 500,
          });
          // Refresh archive count for sidebar
          const { archive } = await import('./archive');
          archive.refreshCount();
        } catch (error) {
          console.error('[sdkSessions] Failed to archive session:', error);
        }
      }

      await saveSessionsToDisk();
    },

    getSession(id: string): SdkSession | undefined {
      let result: SdkSession | undefined;
      subscribe(sessions => { result = sessions.find(s => s.id === id); })();
      return result;
    },

    async updateSessionModel(id: string, model: string): Promise<void> {
      const currentSettings = get(settings);
      const shouldResolve = liveSessions.has(id) && isAutoModel(model);
      const resolvedModel = shouldResolve ? resolveModelForApi(model, currentSettings.enabled_models) : model;

      update(sessions => sessions.map(s => s.id === id ? { ...s, model: resolvedModel } : s));

      if (!liveSessions.has(id)) return;

      try {
        await invoke('update_sdk_model', { id, model: resolvedModel });
      } catch (error) {
        console.error('Failed to update SDK model:', error);
      }
    },

    async updateSessionEffort(id: string, effortLevel: EffortLevel): Promise<void> {
      update(sessions => sessions.map(s => s.id === id ? { ...s, effortLevel } : s));

      if (!liveSessions.has(id)) return;

      // Get the session's model to check effort support
      const session = get({ subscribe }).find(s => s.id === id);
      const effectiveEffort = session && modelSupportsEffort(session.model) ? effortLevel : null;

      try {
        await invoke('update_sdk_effort', { id, effortLevel: effectiveEffort });
      } catch (error) {
        console.error('Failed to update SDK effort:', error);
      }
    },

    /** @deprecated Use updateSessionEffort instead */
    async updateSessionThinking(id: string, effortLevel: EffortLevel): Promise<void> {
      return this.updateSessionEffort(id, effortLevel);
    },

    async updateSessionCwd(id: string, cwd: string): Promise<void> {
      let session: SdkSession | undefined;
      subscribe(sessions => { session = sessions.find(s => s.id === id); })();

      if (!session || session.status !== 'idle' || session.messages.length > 0) return;

      update(sessions => sessions.map(s => s.id === id ? { ...s, cwd } : s));

      if (liveSessions.has(id)) {
        try {
          await invoke('close_sdk_session', { id });
          await registerSessionWithBackend(id, cwd, session.model, session.effortLevel, undefined, undefined, undefined, undefined, undefined, session.provider);
        } catch (error) {
          console.error('[sdkSessions] Failed to reinitialize backend session:', error);
        }
      }
    },

    markAsRead(id: string): void {
      update(sessions => sessions.map(s => s.id === id ? { ...s, unread: false } : s));
    },

    updateDraft(id: string, draftPrompt?: string, draftImages?: SdkImageContent[]): void {
      update(sessions => sessions.map(s => s.id === id ? { ...s, draftPrompt, draftImages } : s));
    },

    createSetupSession(model: string, effortLevel: EffortLevel, planMode: boolean = false, provider?: SdkProvider, initialCwd: string = ''): string {
      const id = crypto.randomUUID();

      const session: SdkSession = {
        id,
        cwd: initialCwd,
        model,
        provider,
        effortLevel,
        messages: [],
        status: 'setup',
        createdAt: Date.now(),
        accumulatedDurationMs: 0,
        planMode: planMode ? { isActive: true, questions: [], answers: [], currentQuestionIndex: 0, isComplete: false } : undefined,
      };

      update(sessions => [...sessions, session]);
      return id;
    },

    async startSetupSession(id: string, config: { prompt: string; images?: SdkImageContent[]; cwd: string; model: string; effortLevel: EffortLevel; planMode: boolean; noteMode?: boolean; systemPrompt?: string; provider?: SdkProvider }): Promise<void> {
      const session = get({ subscribe }).find(s => s.id === id);
      if (!session || session.status !== 'setup') return;

      update(sessions =>
        sessions.map(s =>
          s.id === id
            ? {
                ...s,
                cwd: config.cwd,
                model: config.noteMode ? 'claude-haiku-4-5-20251001' : config.model, // Note mode always uses Haiku
                effortLevel: config.noteMode ? null : config.effortLevel, // Note mode doesn't use effort
                status: 'initializing' as const,
                planMode: config.planMode ? { isActive: true, questions: [], answers: [], currentQuestionIndex: 0, isComplete: false } : undefined,
                noteMode: config.noteMode ? { isActive: true, noteCreated: false } : undefined,
              }
            : s
        )
      );

      try {
        let finalSystemPrompt = config.systemPrompt;
        if (config.noteMode) {
          const { getNoteModeSystemPrompt } = await import('$lib/prompts/noteMode');
          finalSystemPrompt = getNoteModeSystemPrompt();
        } else if (config.planMode) {
          const { getPlanModeSystemPrompt } = await import('$lib/prompts/planMode');
          finalSystemPrompt = getPlanModeSystemPrompt();
        }

        await this.ensureSidecarStarted();

        const unlisteners = await setupEventListeners(id);
        listeners.set(id, unlisteners);

        // Note mode uses Haiku and no effort
        const finalModel = config.noteMode ? 'claude-haiku-4-5-20251001' : config.model;
        const finalEffort = config.noteMode ? null : config.effortLevel;

        await registerSessionWithBackend(id, config.cwd, finalModel, finalEffort, finalSystemPrompt, null, null, config.planMode, config.noteMode, config.provider);

        const currentSettings = get(settings);
        const resolvedModel = resolveModelForApi(finalModel, currentSettings.enabled_models);
        usageStats.trackSession('sdk', resolvedModel, config.cwd);

        update(sessions => sessions.map(s => s.id === id ? { ...s, status: 'idle' as const } : s));

        if (config.prompt.trim() || (config.images && config.images.length > 0)) {
          await this.sendPrompt(id, config.prompt, config.images);
        }
      } catch (error) {
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? { ...s, status: 'error' as const, messages: [...s.messages, { type: 'error' as const, content: String(error), timestamp: Date.now() }] }
              : s
          )
        );
      }
    },

    cancelSetupSession(id: string): void {
      update(sessions => sessions.filter(s => s.id !== id || s.status !== 'setup'));
    },

    createPendingTranscriptionSession(model: string, effortLevel: EffortLevel, provider?: SdkProvider): string {
      const id = crypto.randomUUID();

      const session: SdkSession = {
        id,
        cwd: '',
        model,
        provider,
        effortLevel: modelSupportsEffort(model) ? effortLevel : null,
        messages: [],
        status: 'pending_transcription',
        createdAt: Date.now(),
        accumulatedDurationMs: 0,
        pendingTranscription: { status: 'recording', audioVisualizationHistory: [], recordingStartedAt: Date.now() },
      };

      update(sessions => [...sessions, session]);
      return id;
    },

    updatePendingTranscription(id: string, updates: Partial<PendingTranscriptionInfo>): void {
      update(sessions =>
        sessions.map(s => {
          if (s.id !== id || !s.pendingTranscription) return s;

          let finalUpdates = { ...updates };
          if (updates.status && updates.status !== 'recording' && s.pendingTranscription.status === 'recording' && s.pendingTranscription.recordingStartedAt) {
            finalUpdates.recordingDurationMs = Date.now() - s.pendingTranscription.recordingStartedAt;
          }

          return { ...s, pendingTranscription: { ...s.pendingTranscription, ...finalUpdates } };
        })
      );
    },

    setRecommendations(id: string, options: { modelRecommendation?: { modelId: string; reasoning: string; effortLevel?: string; thinkingLevel?: string }; repoRecommendation?: { repoIndex: number; repoName: string; reasoning: string; confidence: string }; transcript?: string }): void {
      update(sessions =>
        sessions.map(s => {
          if (s.id !== id) return s;
          const existingPending = s.pendingTranscription;
          return {
            ...s,
            pendingTranscription: {
              status: existingPending?.status ?? 'processing' as PendingTranscriptionStatus,
              ...existingPending,
              ...(options.transcript && { transcript: options.transcript }),
              ...(options.modelRecommendation && { modelRecommendation: options.modelRecommendation }),
              ...(options.repoRecommendation && { repoRecommendation: options.repoRecommendation }),
            },
          };
        })
      );
    },

    addAudioVisualizationSnapshot(id: string, data: number[]): void {
      update(sessions =>
        sessions.map(s =>
          s.id === id && s.pendingTranscription
            ? {
                ...s,
                pendingTranscription: {
                  ...s.pendingTranscription,
                  audioVisualizationHistory: [...(s.pendingTranscription.audioVisualizationHistory || []), data].slice(-100),
                },
              }
            : s
        )
      );
    },

    storeAudioData(id: string, audioData: Uint8Array): void {
      update(sessions =>
        sessions.map(s =>
          s.id === id && s.pendingTranscription
            ? { ...s, pendingTranscription: { ...s.pendingTranscription, audioData } }
            : s
        )
      );
    },

    async completePendingTranscription(id: string, cwd: string, transcript: string, systemPrompt?: string, pendingRepoSelection?: PendingRepoSelection): Promise<void> {
      let session: SdkSession | undefined;
      subscribe(sessions => { session = sessions.find(s => s.id === id); })();

      if (!session || session.status !== 'pending_transcription') return;

      if (pendingRepoSelection) {
        update(sessions =>
          sessions.map(s => s.id === id ? { ...s, status: 'pending_repo' as const, pendingRepoSelection, pendingPrompt: transcript } : s)
        );
      } else {
        update(sessions =>
          sessions.map(s => s.id === id ? { ...s, cwd, status: 'initializing' as const, pendingPrompt: transcript } : s)
        );

        try {
          await this.initializeSession(id, cwd, session.model, session.effortLevel, systemPrompt, transcript, session.provider);
        } catch (error) {
          update(sessions =>
            sessions.map(s =>
              s.id === id
                ? { ...s, status: 'error' as const, messages: [...s.messages, { type: 'error' as const, content: error instanceof Error ? error.message : 'Failed to initialize session', timestamp: Date.now() }] }
                : s
            )
          );
          throw error;
        }
      }
    },

    cancelPendingTranscription(id: string): void {
      update(sessions => sessions.filter(s => s.id !== id));
    },

    setPendingApproval(id: string, prompt: string, cwd?: string): void {
      update(sessions =>
        sessions.map(s => s.id === id ? { ...s, status: 'pending_approval' as const, pendingApprovalPrompt: prompt, cwd: cwd || s.cwd } : s)
      );
    },

    cancelApproval(id: string): void {
      update(sessions => sessions.filter(s => s.id !== id));
    },

    setPrepared(id: string, prompt: string, cwd: string, systemPrompt?: string, repoRecommendation?: { recommendedIndex: number | null; reasoning: string; confidence: string }): void {
      update(sessions =>
        sessions.map(s => s.id === id ? {
          ...s,
          status: 'prepared' as const,
          cwd,
          preparedPrompt: prompt,
          preparedSystemPrompt: systemPrompt,
          preparedRepoRecommendation: repoRecommendation,
          pendingTranscription: s.pendingTranscription ? { ...s.pendingTranscription, status: 'processing' as PendingTranscriptionStatus } : s.pendingTranscription,
        } : s)
      );
      debouncedSave();
    },

    updatePreparedRepo(id: string, cwd: string): void {
      update(sessions =>
        sessions.map(s => s.id === id && s.status === 'prepared' ? { ...s, cwd } : s)
      );
      debouncedSave();
    },

    async launchPrepared(id: string, editedPrompt?: string): Promise<void> {
      let session: SdkSession | undefined;
      subscribe(sessions => { session = sessions.find(s => s.id === id); })();

      if (!session || session.status !== 'prepared') return;

      if (!session.cwd) throw new Error('No repository selected for prepared session');

      const prompt = editedPrompt || session.preparedPrompt;
      if (!prompt) throw new Error('No prompt to send');

      update(sessions =>
        sessions.map(s => s.id === id ? {
          ...s,
          status: 'initializing' as const,
          pendingPrompt: prompt,
          preparedPrompt: undefined,
          preparedRepoRecommendation: undefined,
        } : s)
      );

      try {
        await this.initializeSession(id, session.cwd, session.model, session.effortLevel, session.preparedSystemPrompt, prompt, session.provider);
      } catch (error) {
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? { ...s, status: 'error' as const, messages: [...s.messages, { type: 'error' as const, content: error instanceof Error ? error.message : 'Failed to launch prepared session', timestamp: Date.now() }] }
              : s
          )
        );
        throw error;
      }
    },

    cancelPrepared(id: string): void {
      update(sessions => sessions.filter(s => s.id !== id));
    },

    async approveAndSend(id: string, editedPrompt?: string, systemPrompt?: string): Promise<void> {
      let session: SdkSession | undefined;
      subscribe(sessions => { session = sessions.find(s => s.id === id); })();

      if (!session || session.status !== 'pending_approval') return;

      const prompt = editedPrompt || session.pendingApprovalPrompt;
      if (!prompt) throw new Error('No prompt to send');

      update(sessions =>
        sessions.map(s => s.id === id ? { ...s, status: 'initializing' as const, pendingPrompt: prompt, pendingApprovalPrompt: undefined } : s)
      );

      try {
        await this.initializeSession(id, session.cwd, session.model, session.effortLevel, systemPrompt, prompt, session.provider);
      } catch (error) {
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? { ...s, status: 'error' as const, messages: [...s.messages, { type: 'error' as const, content: error instanceof Error ? error.message : 'Failed to initialize session', timestamp: Date.now() }] }
              : s
          )
        );
        throw error;
      }
    },

    createPendingRepoSession(model: string, effortLevel: EffortLevel, pendingRepoSelection: PendingRepoSelection, provider?: SdkProvider): string {
      const id = crypto.randomUUID();

      const session: SdkSession = {
        id,
        cwd: '',
        model,
        provider,
        effortLevel,
        messages: [],
        status: 'pending_repo',
        createdAt: Date.now(),
        accumulatedDurationMs: 0,
        pendingRepoSelection,
        pendingPrompt: pendingRepoSelection.transcript,
      };

      update(sessions => [...sessions, session]);
      return id;
    },

    createPendingRepoFromExisting(id: string, prompt: string, pendingRepoSelection: PendingRepoSelection): void {
      update(sessions =>
        sessions.map(s => s.id === id ? { ...s, status: 'pending_repo' as const, pendingRepoSelection, pendingPrompt: prompt } : s)
      );
    },

    createInitializingSession(cwd: string, model: string, effortLevel: EffortLevel, pendingPrompt: string, provider?: SdkProvider): string {
      const id = crypto.randomUUID();

      const session: SdkSession = {
        id,
        cwd,
        model,
        provider,
        effortLevel,
        messages: [],
        status: 'initializing',
        createdAt: Date.now(),
        accumulatedDurationMs: 0,
        pendingPrompt,
      };

      update(sessions => [...sessions, session]);
      return id;
    },

    async completeRepoSelection(id: string, cwd: string, systemPrompt?: string, cleanedTranscript?: string): Promise<void> {
      let session: SdkSession | undefined;
      subscribe(sessions => { session = sessions.find(s => s.id === id); })();

      if (!session || session.status !== 'pending_repo') return;

      const pendingPrompt = cleanedTranscript || session.pendingPrompt;

      update(sessions =>
        sessions.map(s => s.id === id ? { ...s, cwd, status: 'initializing' as const, pendingRepoSelection: undefined, pendingPrompt } : s)
      );

      try {
        await this.initializeSession(id, cwd, session.model, session.effortLevel, systemPrompt, pendingPrompt, session.provider);
      } catch (error) {
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? { ...s, status: 'error' as const, messages: [...s.messages, { type: 'error' as const, content: error instanceof Error ? error.message : 'Failed to initialize session', timestamp: Date.now() }] }
              : s
          )
        );
        throw error;
      }
    },

    async initializeSession(id: string, cwd: string, model: string, effortLevel: EffortLevel, systemPrompt?: string, pendingPrompt?: string, provider?: SdkProvider): Promise<void> {
      await this.ensureSidecarStarted();

      const unlisteners = await setupEventListeners(id);
      listeners.set(id, unlisteners);

      const currentSettings = get(settings);
      const resolvedModel = resolveModelForApi(model, currentSettings.enabled_models);
      if (resolvedModel !== model) {
        update(sessions => sessions.map(s => s.id === id ? { ...s, model: resolvedModel } : s));
      }

      await registerSessionWithBackend(id, cwd, resolvedModel, effortLevel, systemPrompt, undefined, undefined, undefined, undefined, provider);
      usageStats.trackSession('sdk', resolvedModel, cwd);

      if (pendingPrompt) {
        await this.sendPrompt(id, pendingPrompt);
      } else {
        update(sessions => sessions.map(s => s.id === id ? { ...s, status: 'idle' as const, pendingPrompt: undefined } : s));
      }
    },

    updateStatus(id: string, status: SdkSession['status']): void {
      update(sessions => sessions.map(s => s.id === id ? { ...s, status } : s));
    },

    async createPlanModeSession(cwd: string, model: string, effortLevel: EffortLevel = null): Promise<string> {
      const { getPlanModeSystemPrompt } = await import('$lib/prompts/planMode');
      const systemPrompt = getPlanModeSystemPrompt();

      const id = await this.createSession(cwd, model, effortLevel, systemPrompt, true);

      update(sessions =>
        sessions.map(s =>
          s.id === id
            ? {
                ...s,
                planMode: { isActive: true, questions: [], answers: [], currentQuestionIndex: 0, isComplete: false },
                aiMetadata: { ...s.aiMetadata, name: 'New Plan', category: 'planning' },
              }
            : s
        )
      );

      return id;
    },

    /**
     * Create a note-taking mode session.
     * Note mode sessions:
     * - Always use Haiku for speed and cost efficiency
     * - Have read-only codebase access (Read, Glob, Grep)
     * - Use note_mcp_servers from repo config for note-taking tools
     * - No thinking level (null)
     */
    async createNoteModeSession(cwd: string): Promise<string> {
      await this.ensureSidecarStarted();

      const { getNoteModeSystemPrompt } = await import('$lib/prompts/noteMode');
      const systemPrompt = getNoteModeSystemPrompt();

      const id = crypto.randomUUID();
      // Note mode always uses Haiku for speed and cost efficiency
      const model = 'claude-haiku-4-5-20251001';

      const session: SdkSession = {
        id,
        cwd,
        model,
        effortLevel: null,
        messages: [],
        status: 'idle',
        createdAt: Date.now(),
        accumulatedDurationMs: 0,
        noteMode: { isActive: true, noteCreated: false },
      };

      update(sessions => [...sessions, session]);

      const unlisteners = await setupEventListeners(id);
      listeners.set(id, unlisteners);

      await registerSessionWithBackend(id, cwd, model, null, systemPrompt, null, null, false, true);

      usageStats.trackSession('sdk', model, cwd);

      // Set initial metadata
      update(sessions =>
        sessions.map(s =>
          s.id === id
            ? { ...s, aiMetadata: { ...s.aiMetadata, name: 'New Note', category: 'note' } }
            : s
        )
      );

      return id;
    },

    /**
     * Create a pending transcription session for note mode.
     * Similar to createPendingTranscriptionSession but with noteMode flag.
     */
    createPendingNoteSession(): string {
      const id = crypto.randomUUID();
      // Note mode always uses Haiku
      const model = 'claude-haiku-4-5-20251001';

      const session: SdkSession = {
        id,
        cwd: '',
        model,
        effortLevel: null,
        messages: [],
        status: 'pending_transcription',
        createdAt: Date.now(),
        accumulatedDurationMs: 0,
        noteMode: { isActive: true, noteCreated: false },
        pendingTranscription: { status: 'recording', audioVisualizationHistory: [], recordingStartedAt: Date.now() },
      };

      update(sessions => [...sessions, session]);
      return id;
    },

    /**
     * Complete a pending note session and send the transcribed note.
     */
    async completePendingNoteSession(id: string, cwd: string, transcript: string): Promise<void> {
      let session: SdkSession | undefined;
      subscribe(sessions => { session = sessions.find(s => s.id === id); })();

      if (!session || session.status !== 'pending_transcription' || !session.noteMode?.isActive) return;

      const { getNoteModeSystemPrompt } = await import('$lib/prompts/noteMode');
      const systemPrompt = getNoteModeSystemPrompt();

      update(sessions =>
        sessions.map(s => s.id === id ? { ...s, cwd, status: 'initializing' as const, pendingPrompt: transcript } : s)
      );

      try {
        await this.ensureSidecarStarted();

        const unlisteners = await setupEventListeners(id);
        listeners.set(id, unlisteners);

        await registerSessionWithBackend(id, cwd, session.model, null, systemPrompt, null, null, false, true);

        usageStats.trackSession('sdk', session.model, cwd);

        // Send the transcript as the initial prompt
        await this.sendPrompt(id, transcript);

        // Update metadata
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? { ...s, aiMetadata: { ...s.aiMetadata, name: 'New Note', category: 'note' } }
              : s
          )
        );
      } catch (error) {
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? { ...s, status: 'error' as const, messages: [...s.messages, { type: 'error' as const, content: error instanceof Error ? error.message : 'Failed to initialize note session', timestamp: Date.now() }] }
              : s
          )
        );
        throw error;
      }
    },

    /**
     * Mark a note session as having created the note.
     */
    markNoteCreated(id: string): void {
      update(sessions =>
        sessions.map(s => {
          if (s.id !== id || !s.noteMode) return s;
          return { ...s, noteMode: { ...s.noteMode, noteCreated: true } };
        })
      );
    },

    updatePlanModeQuestions(id: string, questions: PlanningQuestion[]): void {
      update(sessions =>
        sessions.map(s => {
          if (s.id !== id || !s.planMode) return s;
          return {
            ...s,
            planMode: {
              ...s.planMode,
              questions: [...s.planMode.questions, ...questions],
              currentQuestionIndex: s.planMode.currentQuestionIndex >= s.planMode.questions.length
                ? s.planMode.questions.length
                : s.planMode.currentQuestionIndex,
            },
          };
        })
      );
      debouncedSave();
    },

    setCurrentQuestionIndex(id: string, index: number): void {
      update(sessions =>
        sessions.map(s => {
          if (s.id !== id || !s.planMode) return s;
          return {
            ...s,
            planMode: {
              ...s.planMode,
              currentQuestionIndex: Math.max(0, Math.min(index, s.planMode.questions.length - 1)),
            },
          };
        })
      );
    },

    updatePlanningAnswer(id: string, answer: PlanningAnswer): void {
      update(sessions =>
        sessions.map(s => {
          if (s.id !== id || !s.planMode) return s;

          const existingIndex = s.planMode.answers.findIndex(a => a.questionIndex === answer.questionIndex);
          const newAnswers = [...s.planMode.answers];
          if (existingIndex >= 0) {
            newAnswers[existingIndex] = answer;
          } else {
            newAnswers.push(answer);
          }

          return { ...s, planMode: { ...s.planMode, answers: newAnswers } };
        })
      );
    },

    async submitPlanningAnswers(id: string): Promise<void> {
      let session: SdkSession | undefined;
      subscribe(sessions => { session = sessions.find(s => s.id === id); })();

      if (!session?.planMode) throw new Error('Session not in plan mode');

      const formattedAnswers = session.planMode.answers.map(answer => {
        const question = session!.planMode!.questions[answer.questionIndex];
        const selectedLabels = answer.selectedOptions.map(i => question.options[i]?.label || `Option ${i}`);
        return {
          question: question.question,
          header: question.header,
          selectedOptions: selectedLabels,
          customInput: answer.textInput || null,
        };
      });

      const answerText = `Here are my answers to the planning questions:\n\n${JSON.stringify(formattedAnswers, null, 2)}`;

      this.clearPlanningQuestions(id);
      await this.sendPrompt(id, answerText);
    },

    clearPlanningQuestions(id: string): void {
      update(sessions =>
        sessions.map(s => {
          if (s.id !== id || !s.planMode) return s;
          return { ...s, planMode: { ...s.planMode, questions: [], answers: [], currentQuestionIndex: 0 } };
        })
      );
    },

    completePlanMode(id: string, planFilePath: string, featureName: string, planSummary: string): void {
      update(sessions =>
        sessions.map(s => {
          if (s.id !== id || !s.planMode) return s;
          return {
            ...s,
            planMode: { ...s.planMode, isComplete: true, planFilePath, featureName, planSummary },
            aiMetadata: { ...s.aiMetadata, name: `Plan: ${featureName}` },
          };
        })
      );
      debouncedSave();
    },

    async spawnImplementationSession(planSessionId: string): Promise<string | null> {
      let planSession: SdkSession | undefined;
      subscribe(sessions => { planSession = sessions.find(s => s.id === planSessionId); })();

      if (!planSession?.planMode?.isComplete || !planSession.planMode.planFilePath) {
        console.error('[sdkSessions] Cannot spawn implementation: plan not complete');
        return null;
      }

      const { planFilePath, featureName } = planSession.planMode;

      const implementationId = await this.createSession(planSession.cwd, planSession.model, planSession.effortLevel);

      update(sessions =>
        sessions.map(s =>
          s.id === implementationId
            ? { ...s, aiMetadata: { ...s.aiMetadata, name: `Implementing: ${featureName}`, category: 'implementation' } }
            : s
        )
      );

      const implementationPrompt = `Please implement the plan defined in \`${planFilePath}\`.

Read the plan file first to understand what needs to be done, then proceed with the implementation step by step. As you complete each task, update the plan file to mark completed items with [x].

Focus on quality and maintainability. Ask questions if any requirements are unclear.`;

      await this.sendPrompt(implementationId, implementationPrompt);
      return implementationId;
    },

    selectSession(id: string): void {
      activeSdkSessionId.set(id);
    },

    clearSelection(): void {
      activeSdkSessionId.set(null);
    },
  };
}

export const activeSdkSessionId = writable<string | null>(null);

export const sdkSessions = createSdkSessionsStore();

export const activeSdkSession = derived(
  [sdkSessions, activeSdkSessionId],
  ([$sdkSessions, $activeSdkSessionId]) => {
    return $sdkSessions.find(s => s.id === $activeSdkSessionId) || null;
  }
);

export const appSessionUsage = derived(
  sdkSessions,
  ($sdkSessions) => {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCostUsd = 0;
    let progressiveInputTokens = 0;
    let progressiveOutputTokens = 0;

    for (const session of $sdkSessions) {
      if (session.usage) {
        totalInputTokens += session.usage.totalInputTokens;
        totalOutputTokens += session.usage.totalOutputTokens;
        totalCacheReadTokens += session.usage.totalCacheReadTokens;
        totalCacheCreationTokens += session.usage.totalCacheCreationTokens;
        totalCostUsd += session.usage.totalCostUsd;
        progressiveInputTokens += session.usage.progressiveInputTokens;
        progressiveOutputTokens += session.usage.progressiveOutputTokens;
      }
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      totalCostUsd,
      progressiveInputTokens,
      progressiveOutputTokens,
    };
  }
);
