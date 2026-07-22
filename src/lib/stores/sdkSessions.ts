import { writable, derived, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { settings } from './settings';
import { repos, findRepoById } from './repos';
import { touchRepoForCwd } from './repoRecency';
import { playCompletionSound, playQuestionSound } from '$lib/utils/sound';
import { usageStats } from './usageStats';
import { rateLimits, codexRateLimits } from './rateLimits';
import { saveSessionsToDisk, saveSdkSessionsPartial } from './sessionPersistence';
import { analyzeSessionCompletion, generateSessionNameFromPrompt, isLlmEnabled, pickNickname, type QuickAction } from '$lib/utils/llm';
import { clampEffortForModel, DEFAULT_MODEL_ID, getMaxContextTokens, getProviderForModel, isAutoModel, modelSupportsEffort, resolveModelAlias, resolveModelForApi, type SdkProvider } from '$lib/utils/models';
import { SCREENSHOT_PROMPT_NOTICE, hasScreenshotImage } from '$lib/utils/screenshot';
import type { McpServerConfig } from '$lib/types/mcp';
import { shouldQueue, providerExhaustion, nextWindowResetAt } from './queueDetection';
import { panes, focusedPaneSessionId, onScreenSessionIds } from './panes';
import { defaultAccountIdForRepo } from '$lib/utils/accounts';
// Type-only import (erased at build; no runtime cycle with the validation store,
// which value-imports from here).
import type { PersistedValidationRun } from './validation';

// =============================================================================
// Debounced Save
// =============================================================================

let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let saveMaxWaitTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 3000;
// Max-wait cap: continuous mutations keep resetting the debounce, so bound how
// long a pending save can be starved before it's forced to flush.
const SAVE_MAX_WAIT_MS = 12000;

// Dirty tracking for partial saves. `dirtySdkIds` collects the sessions whose
// content changed via `debouncedSave(id)`; `needsFullSave` is set by structural
// changes (add/remove/reorder) via `debouncedSave()` with no id, which force a
// full `saveSessionsToDisk` (terminal sessions + stale cleanup + overflow).
let dirtySdkIds = new Set<string>();
let needsFullSave = false;

function normalizeSdkProvider(provider: unknown, model: string): SdkProvider {
  const modelProvider = getProviderForModel(model);
  if (provider === 'openai' || provider === 'OpenAI') {
    return modelProvider === 'openai' ? 'openai' : modelProvider;
  }
  if (provider === 'claude' || provider === 'Claude') {
    return modelProvider === 'claude' ? 'claude' : modelProvider;
  }
  return modelProvider;
}

/**
 * Normalize an epoch timestamp to milliseconds. The mid-run rate-limit event's `resetsAt`
 * may arrive in seconds or ms; reset times are in the near future (~1.7e12 ms / ~1.7e9 s),
 * so anything below 1e12 is treated as seconds. Returns undefined for null/invalid input.
 */
function normalizeEpochMs(value: number | null | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return value < 1e12 ? value * 1000 : value;
}

/**
 * Flush the pending save. Chooses the full save when a structural change is
 * pending (or nothing was tagged dirty), otherwise a cheap partial upsert of
 * just the dirty sessions.
 */
function flushSave(): void {
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
  }
  if (saveMaxWaitTimer) {
    clearTimeout(saveMaxWaitTimer);
    saveMaxWaitTimer = null;
  }

  const full = needsFullSave;
  const ids = dirtySdkIds;
  needsFullSave = false;
  dirtySdkIds = new Set();

  if (full) {
    saveSessionsToDisk();
  } else if (ids.size > 0) {
    saveSdkSessionsPartial(ids);
  }
}

/**
 * Schedule a debounced save. Pass a session `id` for a content-only change
 * (persisted via a partial upsert); omit it for a structural change that must
 * go through the full save path.
 */
function debouncedSave(sessionId?: string): void {
  if (sessionId) {
    dirtySdkIds.add(sessionId);
  } else {
    needsFullSave = true;
  }

  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
  }
  saveDebounceTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);

  // Start (but never reset) the max-wait cap so a steady stream of mutations
  // can't indefinitely postpone the flush.
  if (!saveMaxWaitTimer) {
    saveMaxWaitTimer = setTimeout(flushSave, SAVE_MAX_WAIT_MS);
  }
}

/** Resolve a repo ID from a cwd path by looking up the repos list. */
function resolveRepoId(cwd: string): string | undefined {
  if (!cwd || cwd === '.') return undefined;
  const reposList = get(repos).list;
  const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const normalizedCwd = normalize(cwd);

  // Exact repo root match
  const exact = reposList.find(r => normalize(r.path) === normalizedCwd)?.id;
  if (exact) return exact;

  // Heuristic: worktree paths are typically under "<repoPath>-worktrees/<branch>"
  // Example: F:/Repos/my-repo-worktrees/feature-x -> repo F:/Repos/my-repo
  const fromWorktree = reposList.find((r) => {
    const repoBase = normalize(r.path);
    return normalizedCwd.startsWith(`${repoBase}-worktrees/`);
  })?.id;

  return fromWorktree || undefined;
}

// =============================================================================
// Types
// =============================================================================

export interface SdkImageContent {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  base64Data: string;
  width?: number;
  height?: number;
  /** Set for auto-captured recording screenshots — triggers the "may be irrelevant" prompt notice. */
  source?: 'screenshot';
}

export interface SdkMessage {
  type: 'user' | 'text' | 'tool_start' | 'tool_result' | 'done' | 'stopped' | 'error' | 'subagent_start' | 'subagent_stop' | 'thinking' | 'notification' | 'task_started' | 'task_completed';
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
  /** SDK assistant turn UUID (for fork support - identifies the conversation turn) */
  turnUuid?: string;
  /**
   * Set on a deliberately-parked user turn that has NOT been sent yet (Smart Queue
   * "send when idle" / "send at next reset"). The value is the send-timing that
   * created it (a subset of `SendTiming`: 'session_idle' | 'repo_idle' | 'reset_5h').
   * While set, the message is pulled out of the scrolling transcript and rendered as
   * a pinned "ghost" bubble; it's cleared when the turn actually sends
   * (`continueRateLimited`) or removed entirely on cancel (`clearRateLimited`).
   */
  queued?: 'session_idle' | 'repo_idle' | 'reset_5h';
  timestamp: number;
}

export interface SdkUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  // True when inputTokens already includes cached tokens (OpenAI/Codex usage semantics).
  inputTokensIncludeCache?: boolean;
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  contextWindow: number;
  // Main-agent-only tokens for accurate context bar (excludes subagent usage)
  mainAgentInputTokens?: number;
  mainAgentOutputTokens?: number;
  mainAgentCacheReadTokens?: number;
  mainAgentCacheCreationTokens?: number;
}

export interface SdkProgressiveUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  // True when inputTokens already includes cached tokens (OpenAI/Codex usage semantics).
  inputTokensIncludeCache?: boolean;
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
  /** Short speakable callsign for referring to the session by voice (e.g. "Falcon") */
  nickname?: string;
  category?: string;
  outcome?: string;
  needsInteraction?: boolean;
  interactionReason?: string;
  interactionUrgency?: string;
  waitingFor?: string;
  quickActions?: QuickAction[];
}

function clearCompletionMetadata(
  aiMetadata?: SessionAiMetadata,
): SessionAiMetadata | undefined {
  if (!aiMetadata) return aiMetadata;
  return {
    ...aiMetadata,
    category: undefined,
    outcome: undefined,
    quickActions: undefined,
    needsInteraction: undefined,
    interactionReason: undefined,
    interactionUrgency: undefined,
    waitingFor: undefined,
  };
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

export interface AskUserQuestionState {
  questions: PlanningQuestion[];
  answers: PlanningAnswer[];
  currentQuestionIndex: number;
}

export interface PlanApprovalState {
  allowedPrompts: Array<{ tool: string; prompt: string }>;
  plan?: string;
}

export type EffortLevel = null | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type SelectableEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type SettingsEffortLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** @deprecated Use EffortLevel instead */
export type ThinkingLevel = EffortLevel;
/** @deprecated Use SettingsEffortLevel instead */
export type SettingsThinkingLevel = SettingsEffortLevel;

export function normalizeEffortLevel(level: EffortLevel | undefined): SelectableEffortLevel {
  return level ?? 'low';
}

export function settingsToStoreEffort(level: SettingsEffortLevel): SelectableEffortLevel {
  return level === 'off' ? 'low' : level;
}

export function storeToSettingsEffort(level: EffortLevel): SettingsEffortLevel {
  return level === null ? 'low' : level;
}

/** @deprecated Use settingsToStoreEffort instead */
export function settingsToStoreThinking(level: string): EffortLevel {
  if (level === 'off') return 'low';
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
  /** Debug-recordings log entry for the originating recording, so the post-selection
   *  LLM cleanup pass can attach its result to the log. */
  debugRecordingId?: string;
}

export type PendingTranscriptionStatus = 'recording' | 'transcribing' | 'processing';

export interface PendingTranscriptionInfo {
  status: PendingTranscriptionStatus;
  audioVisualizationHistory?: number[][];
  recordingStartedAt?: number;
  recordingDurationMs?: number;
  audioData?: Uint8Array;
  /** Debug-recordings log entry for this recording, so retries and later LLM
   *  stages attach to the same log entry. */
  debugRecordingId?: string;
  transcript?: string;
  transcriptionError?: string;
  realtimeTranscript?: string;
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
  /** Screenshots captured when the recording(s) started; attached to the first prompt on send. */
  screenshots?: SdkImageContent[];
}

/**
 * A follow-up recording made for a LIVE session whose transcription failed
 * (service down/error). Kept attached to the session so it can be retried in place
 * — the recording was intended for THIS conversation, not the pile. The audio is
 * stored durably (via `save_pile_audio`, keyed by `audioId`) so retry survives an
 * app restart; only string/number fields live here, so this auto-persists.
 */
export interface FailedRecording {
  /** Durable audio stored via save_pile_audio, keyed by this id. */
  audioId: string;
  /** What to do with the transcript on a successful retry. */
  mode: 'send' | 'append';
  realtimeTranscript?: string;
  error: string;
  createdAt: number;
  /** Debug-recordings log entry for this recording, so a successful retry can
   *  attach its Whisper/cleanup stages to the log. */
  debugRecordingId?: string;
}

/** Why a session is sitting in the `queued` state. */
export type QueueReason = 'rate_limit' | 'scheduled' | 'after_sessions';

/** Which usage window a queued/rate-limited session is waiting on. */
export type QueueWindow = '5h' | '7d';

/** What an 'after_sessions' parked turn waits on: just its own session, or every
 *  session in the same repo+worktree (same cwd). */
export type AfterSessionsScope = 'session' | 'worktree';

/**
 * Attached to a `status: 'queued'` session (a never-launched session parked
 * until its provider's usage window resets or a scheduled window boundary).
 * The prompt itself lives on the prepared fields so `launchPrepared` dispatches it.
 */
export interface QueueInfo {
  reason: QueueReason;
  provider: SdkProvider;
  window?: QueueWindow;
  queuedAt: number;
  /** Snapshot of the target window's reset time (epoch ms), for display/scheduling. */
  targetStartAt?: number;
}

/**
 * A pending turn on a LIVE session that couldn't be sent right now. Either triggered by a
 * rate limit (mid-run rejection or a deferred follow-up), or deliberately scheduled by the
 * user to fire on the next window reset. Holds the exact prompt/images to re-send later.
 */
export interface RateLimitedState {
  reason: QueueReason;
  provider: SdkProvider;
  window?: QueueWindow;
  resetsAt?: number;
  /** For a user-scheduled turn: snapshot of the target window's reset time (epoch ms). */
  targetStartAt?: number;
  /** For 'after_sessions': what to wait on. Absent = 'worktree' (pre-existing persisted turns). */
  scope?: AfterSessionsScope;
  prompt: string;
  images?: SdkImageContent[];
  /**
   * What the parked turn does when it fires. Absent/'prompt' = send `prompt` as a
   * normal turn. 'compact' = run history compaction instead (provider-correct:
   * Claude sends the `/compact` slash command, Codex calls `compact_sdk_session`).
   */
  action?: 'compact';
  queuedAt: number;
}

/** Normalize a filesystem path for equality checks (Windows-tolerant: slashes + case). */
export function normalizeScopePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * "After sessions" scope check: is any session in the same repo+worktree (same cwd)
 * still actively working? Used by the Smart Queue's `after_sessions` trigger and the
 * launch-profile "queue until repo is idle" watcher.
 */
export function hasBusySessionsInScope(sessions: SdkSession[], cwd: string, excludeId?: string): boolean {
  if (!cwd || cwd === '.') return false;
  const scope = normalizeScopePath(cwd);
  return sessions.some(
    (s) =>
      s.id !== excludeId &&
      (s.status === 'querying' || s.status === 'initializing') &&
      !!s.cwd &&
      normalizeScopePath(s.cwd) === scope
  );
}

/**
 * A parked ("queued") ghost turn is pinned to the bottom of the transcript while it
 * waits, but in the `messages` array it can end up buried mid-stream — the still-running
 * turn keeps appending streamed assistant text/tool calls after it. When the parked turn
 * finally fires we drop its `queued` flag; since the transcript renders in array order,
 * we also relocate it to the end (with a fresh timestamp) so it lands at the bottom where
 * the user last saw it instead of snapping back to its original scheduled slot.
 */
function releaseQueuedToEnd(messages: SdkMessage[]): SdkMessage[] {
  if (!messages.some(m => m.queued)) return messages;
  const now = Date.now();
  const rest = messages.filter(m => !m.queued);
  const released = messages.filter(m => m.queued).map(m => ({ ...m, queued: undefined, timestamp: now }));
  return [...rest, ...released];
}

/** Summary of the PR detected for a session's branch (badges in header/list).
 *  Live detail (checks, mergeability) lives in the sessionPrs store. */
export interface SessionPrSummary {
  number: number;
  url: string;
  /** "open" | "merged" | "closed" */
  state: string;
  title: string;
  isDraft?: boolean;
}

/** Compact summary of the latest Validation run for a session (badge in header/list).
 *  Full run state lives in the validation store (in-memory); this mirror survives
 *  restart so a "last run: <status>" badge can render. */
export interface SessionValidationSummary {
  runId: string;
  /** RunStatus: "running" | "gate" | "passed" | "failed" | "cancelled" */
  status: string;
  /** StepName currently in focus, if any. */
  step?: string;
  /** Findings at the active gate (or the active step). */
  findingCount: number;
  /** PR URL if the run created/updated one. */
  prUrl?: string;
  /** When this summary was last updated (epoch ms). */
  updatedAt: number;
}

export interface SdkSession {
  id: string;
  cwd: string;
  /** Setup-only selected repository path (main repo, not worktree path). */
  setupRepoPath?: string;
  /** Setup-only selected worktree mode. */
  setupWorktreeMode?: 'main' | 'new' | 'existing';
  /** Setup-only selected existing worktree path. */
  setupWorktreePath?: string;
  /** Stable reference to the repository entity by ID. Used for display/icon/color resolution.
   *  Survives worktree path changes — the cwd may point to a worktree while this links to the parent repo. */
  repoId?: string;
  /** Branch at the time this session was first tied to a repo. */
  createdBranch?: string | null;
  /** Most recently fetched branch for this session's cwd. */
  currentBranch?: string | null;
  /** Number of uncommitted changed files in this session's cwd (working-tree, like VS Code).
   *  Refreshed alongside branch metadata. Undefined until first sync. */
  changedFileCount?: number;
  /** PR detected for this session's branch. Null = checked, none found; undefined = never checked. Persisted. */
  pr?: SessionPrSummary | null;
  /** Whether the PR dock panel was left open for this session. Persisted so the dock reopens after restart. */
  prPanelOpen?: boolean;
  /** Compact summary of the latest Validation run for this session (drives header/list badge). Persisted. */
  validation?: SessionValidationSummary | null;
  /** Full latest Validation run snapshot (steps/gate/outcome/panel-open state) so the whole
   *  panel — not just the badge — survives restart. Restored read-only (the backend run is gone
   *  after a real restart). Cleared when the run is dismissed. Persisted. */
  validationRun?: PersistedValidationRun | null;
  model: string;
  provider?: SdkProvider;
  /** Agent account this session is pinned to (isolated login profile). Undefined = machine default. */
  accountId?: string;
  autoModelRequested?: boolean;
  effortLevel: EffortLevel;
  /** @deprecated Use effortLevel */
  thinkingLevel?: EffortLevel;
  messages: SdkMessage[];
  status: 'setup' | 'pending_transcription' | 'pending_repo' | 'prepared' | 'queued' | 'initializing' | 'idle' | 'querying' | 'done' | 'error';
  createdAt: number;
  lastActivityAt: number;
  startedAt?: number;
  accumulatedDurationMs: number;
  currentWorkStartedAt?: number;
  usage?: SdkSessionUsage;
  unread?: boolean;
  /** Pinned sessions sort to the top of the session list. Persisted. */
  pinned?: boolean;
  /** When the session was pinned (epoch ms). Newly pinned items sort below earlier pins. Persisted. */
  pinnedAt?: number;
  aiMetadata?: SessionAiMetadata;
  pendingRepoSelection?: PendingRepoSelection;
  pendingPrompt?: string;
  pendingTranscription?: PendingTranscriptionInfo;
  /** A follow-up recording for this live session whose transcription failed; retriable in place. */
  failedRecording?: FailedRecording;
  askUserQuestion?: AskUserQuestionState;
  pendingPlanApproval?: PlanApprovalState;
  draftPrompt?: string;
  draftImages?: SdkImageContent[];
  /** SDK session ID for proper resume after app restart (persisted) */
  sdkSessionId?: string;
  /** Prompt stored for a prepared session (ready to launch) */
  preparedPrompt?: string;
  /** Pre-toggled prompt chips carried into a prepared session (e.g. from a pile item) */
  preparedChips?: string[];
  /** System prompt stored for a prepared session */
  preparedSystemPrompt?: string;
  /** Repo recommendation stored for a prepared session (low-confidence case) */
  preparedRepoRecommendation?: { recommendedIndex: number | null; reasoning: string; confidence: string };
  /** Smart Queue: set on a `status: 'queued'` session (rate-limited first-launch or a scheduled launch). Persisted. */
  queueInfo?: QueueInfo | null;
  /** Smart Queue: a pending turn on a live session waiting to be re-sent (mid-run rejection or deferred follow-up). Persisted. */
  rateLimited?: RateLimitedState | null;
  /** Smart Queue (transient, not persisted): the exact prompt of the turn currently in flight, so a mid-run rejection can recover it. */
  inFlightPrompt?: string | null;
  /** Smart Queue (transient, not persisted): the images of the turn currently in flight. */
  inFlightImages?: SdkImageContent[] | null;
  /** Queued system notifications to prepend to the next query (e.g., parallel agent alerts) */
  pendingSystemNotifications?: string[];
  /** User requested stop for the active query; used to tag terminal state as stopped. */
  stopRequestedAt?: number;
  /** App-level parent session ID this was forked from (for display/linking) */
  forkedFromSessionId?: string;
  /** SDK session ID to fork from (consumed on first query registration) */
  forkFromSdkSessionId?: string;
  /** Message UUID to fork at - resumeSessionAt (consumed on first query registration) */
  forkAtMessageUuid?: string;
  /** Number of messages inherited from parent session (displayed as read-only context) */
  forkedMessageCount?: number;
  /** Friendly label for the parent session, used in fork UI surfaces */
  forkedFromSessionLabel?: string;
  /** Notion card linked to this session (set when created from kanban board) */
  notionCard?: { id: string; title: string };
  /** Pile item this session was launched from */
  pileItem?: { id: string; title: string };
  /** GitHub issue this session was launched from (repo Issues view) */
  githubIssue?: { number: number; title: string; url: string };
  /** Spare Tokens library prompt this session was launched from (auto = fired by auto-mode) */
  spareTokens?: { promptId: string; auto: boolean };
  /** Sequence prompt node this session was materialized from (via "Open session"). */
  sequenceNode?: { executionId: string; nodeId: string; sequenceName?: string; nodeName?: string };
  /** True when the session has received a terminal "Prompt is too long" error — cannot be resumed; user must fork or start fresh. */
  contextOverflow?: boolean;
  /** Active auto-recovery from a "prompt is too long" overflow: fire /compact, then re-send the prompt that overflowed.
   *  Transient (not persisted). Cleared once the retry completes or recovery is abandoned. */
  overflowRecovery?: OverflowRecovery | null;
  /** Claude-only: whether auto-compaction is enabled for this session.
   *  When false, sidecar sets DISABLE_AUTO_COMPACT=1 (the only real disable — PCT_OVERRIDE gets clamped).
   *  When true, no override is set; Claude's built-in default applies (~83.5% trigger with a
   *  33K-token reserved summarization buffer — that IS the optimum, and PCT_OVERRIDE is clamped to it). */
  autocompactEnabled?: boolean;
  /** Runtime-only. agent_ids of subagents that started but haven't stopped yet.
   *  Since Claude Code v2.1.198, subagents launch in the BACKGROUND by default, so the SDK emits
   *  its `result` message (→ sdk-done) as soon as the MAIN agent finishes a turn with no tool
   *  calls — while these subagents are still working. We track them here so a done that arrives
   *  with subagents live is treated as a "semi-stop": real completion (Done status, completion
   *  sound, unread marker, AI analysis) is DEFERRED, otherwise the session reads as "Done" and
   *  post-completion actions fire on a half-finished transcript. The last subagent_stop does NOT
   *  finalize either — it arms a grace timer, because the SDK normally re-invokes the main agent
   *  with the subagent's result right after (see scheduleDeferredFinalize).
   *  Not persisted — nothing is live after an app restart. */
  liveSubagentIds?: string[];
  /** Runtime-only. Background tasks (from SDK task_started/task_notification) still running,
   *  classified by kind:
   *  - 'agent'   — a background subagent (non-bash task types). These DEFER completion just like
   *                liveSubagentIds: the same agents also arrive via SubagentStart/Stop hooks, but
   *                the in-stream task_started can see them before (or without) the hook event —
   *                blocking on both channels is what keeps a turn that ends right after spawning
   *                background subagents from completing prematurely.
   *  - 'command' — a backgrounded bash command that is expected to finish (build, test run…).
   *                These DEFER completion like subagents: the session stays busy until they settle.
   *  - 'server'  — a backgrounded bash command matching `settings.server_command_patterns`
   *                (dev servers etc.). Shown as running, but can run indefinitely so they never
   *                block completion.
   *  Foreground bash ALSO emits task_started/task_notification (the vast majority of task events
   *  in practice) — those are filtered out at the task_started handler via the tool_use block's
   *  run_in_background flag; the tool spinner already covers a blocking foreground run.
   *  Not persisted — nothing is live after an app restart. */
  liveBackgroundTasks?: LiveBackgroundTask[];
  /** Runtime-only. Set when sdk-done arrived while subagents/blocking tasks were still live and
   *  completion was deferred. Consumed by the real completion, which is either the continuation's
   *  own sdk-done (the SDK re-invoked the main agent after the background work settled) or the
   *  deferred-completion grace timer if no re-invocation follows the drain. Not persisted. */
  completionDeferred?: boolean;
  /** Actual model used by each subagent, keyed by the Task/Agent tool's toolUseId. Reported by the
   *  sidecar from the subagent's own assistant messages (Claude only — Codex collab agents inherit
   *  the parent thread's model). Persisted so restored sessions keep their task model badges. */
  subagentModels?: Record<string, string>;
}

export type BackgroundTaskKind = 'agent' | 'command' | 'server';

export interface LiveBackgroundTask {
  taskId: string;
  toolUseId?: string;
  kind: BackgroundTaskKind;
  /** The bash command for local_bash tasks (resolved from the tool_use input), else the task description. */
  label: string;
  startedAt: number;
}

/** Word-boundary substring match of any configured server pattern against the command text.
 *  Word-boundary so "vite" matches "npx vite" but not "vitest run". */
function matchesServerCommand(text: string): boolean {
  const patterns = get(settings).server_command_patterns ?? [];
  const lower = text.toLowerCase();
  return patterns.some(p => {
    const pat = p.trim().toLowerCase();
    if (!pat) return false;
    const escaped = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`).test(lower);
  });
}

export type OverflowRecovery = {
  pendingPrompt: string;
  pendingImages?: SdkImageContent[];
  phase: 'compacting' | 'resending';
  attempts: number;
};

/** Max compact-and-retry cycles per "prompt is too long" overflow before falling back to the terminal banner. */
const MAX_OVERFLOW_RECOVERY_ATTEMPTS = 1;

/** Matches the context-overflow errors Claude surfaces, whether the overflow happens on the user's
 *  prompt or mid-turn while Claude is working (both arrive via sdk-error with the raw API text). */
function isContextOverflowError(text: string): boolean {
  return /prompt is too long|exceed.*context limit|context (?:window|length).*exceed|too many tokens/i.test(text);
}

function findLastIndex<T>(arr: T[], predicate: (value: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}

function normalizeDraftPrompt(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeDraftImages(value: unknown): SdkImageContent[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const images = value.filter((image): image is SdkImageContent => {
    return !!image &&
      typeof image === 'object' &&
      typeof (image as SdkImageContent).mediaType === 'string' &&
      typeof (image as SdkImageContent).base64Data === 'string';
  });

  return images.length > 0 ? images : undefined;
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

function getSessionDisplayLabel(session: SdkSession): string | undefined {
  const aiName = session.aiMetadata?.name?.trim();
  if (aiName) return aiName;

  const firstUserMessage = session.messages.find((message) => message.type === 'user')?.content?.trim();
  if (firstUserMessage) {
    return firstUserMessage.length > 48
      ? `${firstUserMessage.slice(0, 48).trimEnd()}...`
      : firstUserMessage;
  }

  const draftPrompt = session.draftPrompt?.trim();
  if (draftPrompt) {
    return draftPrompt.length > 48
      ? `${draftPrompt.slice(0, 48).trimEnd()}...`
      : draftPrompt;
  }

  return undefined;
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

/**
 * Resolve the context window to display. The SDK reports a stale 200k window for the
 * 1M-context Claude models, so we trust the model's declared maximum (from models.ts)
 * whenever it exceeds the reported/base window — the bar reflects the true 1M limit
 * immediately rather than only once usage nears 200k. The window never shrinks below
 * what we've already shown or what this query reports.
 *
 * @param reportedWindow Window reported for this query (from the sidecar/SDK)
 * @param model The session's model id (used to look up the true maximum)
 * @param prevWindow The window already shown for this session
 */
function resolveContextWindow(
  reportedWindow: number,
  model: string | undefined,
  prevWindow: number,
): number {
  // Never shrink below what we've already shown or what this query reports.
  let window = Math.max(reportedWindow || 0, prevWindow || 0) || 200000;
  // Trust the model's known maximum (e.g. 1M) over a stale, smaller SDK-reported window.
  const modelMax = model ? getMaxContextTokens(model) : 0;
  if (modelMax > window) {
    window = modelMax;
  }
  return window;
}

/** Process final usage from a query and return updated session usage */
function processQueryUsage(prevUsage: SdkSessionUsage | undefined, queryUsage: SdkUsage, model?: string): SdkSessionUsage {
  const prev = prevUsage || createDefaultUsage(queryUsage.contextWindow);
  const reportedWindow = queryUsage.contextWindow || prev.contextWindow || 200000;
  // For context bar: use main-agent-only tokens if available (excludes subagent usage)
  // Falls back to total tokens for backward compatibility (no subagents or old sidecar)
  const contextInputTokens = queryUsage.mainAgentInputTokens ?? queryUsage.inputTokens;
  const contextOutputTokens = queryUsage.mainAgentOutputTokens ?? queryUsage.outputTokens;
  const contextCacheReadTokens = queryUsage.mainAgentCacheReadTokens ?? queryUsage.cacheReadTokens;
  const contextCacheCreationTokens = queryUsage.mainAgentCacheCreationTokens ?? queryUsage.cacheCreationTokens;
  // Claude usage reports cached tokens separately from input tokens.
  // Codex/OpenAI usage reports cached tokens as part of input_tokens.
  const totalContextInputTokens = queryUsage.inputTokensIncludeCache
    ? contextInputTokens
    : contextInputTokens + contextCacheReadTokens + contextCacheCreationTokens;
  const currentContextTokens = totalContextInputTokens + contextOutputTokens;
  const contextWindow = resolveContextWindow(reportedWindow, model, prev.contextWindow);
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
function processProgressiveUsage(prevUsage: SdkSessionUsage | undefined, progressiveUsage: SdkProgressiveUsage, model?: string): SdkSessionUsage {
  const prev = prevUsage || createDefaultUsage();
  // Progressive usage values from the SDK are cumulative for the current request, not deltas
  // So we use the latest values directly instead of accumulating
  const progressiveInputTokens = progressiveUsage.inputTokens;
  const progressiveOutputTokens = progressiveUsage.outputTokens;
  const progressiveCacheReadTokens = progressiveUsage.cacheReadTokens;
  const progressiveCacheCreationTokens = progressiveUsage.cacheCreationTokens;
  // Claude progressive usage reports cached tokens separately from input tokens.
  // Codex/OpenAI progressive usage reports cached tokens as part of input_tokens.
  const liveContextInputTokens = progressiveUsage.inputTokensIncludeCache
    ? progressiveInputTokens
    : progressiveInputTokens + progressiveCacheReadTokens + progressiveCacheCreationTokens;
  const liveCurrentTokens = liveContextInputTokens + progressiveOutputTokens;
  const contextWindow = resolveContextWindow(prev.contextWindow, model, prev.contextWindow);
  const contextUsagePercent = Math.min(100, (liveCurrentTokens / contextWindow) * 100);

  return {
    ...prev,
    contextWindow,
    contextUsagePercent,
    progressiveInputTokens,
    progressiveOutputTokens,
    progressiveCacheReadTokens,
    progressiveCacheCreationTokens,
  };
}

/** Clear progressive ("live") usage values once a query is no longer running.
 *  Preserves the contextUsagePercent already set by processQueryUsage() —
 *  that value is based on the last query's tokens which already represent
 *  the full conversation context (Claude includes all history in each API call).
 *  Recalculating from accumulated totals across all queries would overcount. */
function clearProgressiveUsage(prevUsage: SdkSessionUsage | undefined): SdkSessionUsage | undefined {
  if (!prevUsage) return prevUsage;

  return {
    ...prevUsage,
    progressiveInputTokens: 0,
    progressiveOutputTokens: 0,
    progressiveCacheReadTokens: 0,
    progressiveCacheCreationTokens: 0,
  };
}

function findOpenThinkingMessageIndex(
  messages: SdkMessage[],
  parentToolUseId: string | undefined,
  turnUuid: string | undefined
): number {
  if (turnUuid) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (
        msg.type === 'thinking' &&
        !msg.thinkingDurationMs &&
        msg.parentToolUseId === parentToolUseId &&
        msg.turnUuid === turnUuid
      ) {
        return i;
      }
    }
  }

  if (!turnUuid) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (
        msg.type === 'thinking' &&
        !msg.thinkingDurationMs &&
        msg.parentToolUseId === parentToolUseId &&
        !msg.turnUuid
      ) {
        return i;
      }
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg.type === 'thinking' &&
      !msg.thinkingDurationMs &&
      msg.parentToolUseId === parentToolUseId
    ) {
      return i;
    }
  }

  return -1;
}

function closeOpenThinkingMessages(messages: SdkMessage[], closedAt: number): SdkMessage[] {
  let hasOpenThinking = false;
  for (const msg of messages) {
    if (msg.type === 'thinking' && !msg.thinkingDurationMs) {
      hasOpenThinking = true;
      break;
    }
  }
  if (!hasOpenThinking) return messages;

  return messages.map((msg) => {
    if (msg.type !== 'thinking' || msg.thinkingDurationMs) return msg;
    return {
      ...msg,
      thinkingDurationMs: Math.max(0, closedAt - msg.timestamp),
    };
  });
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
  // Completion
  // ---------------------------------------------------------------------------

  /**
   * Deferred-completion grace timers, keyed by session id.
   *
   * When completion was deferred (sdk-done arrived while background subagents / blocking
   * tasks were live) and the live set then DRAINS, the turn is usually NOT over: a background
   * subagent or command finishing is exactly what makes the SDK re-invoke the main agent with
   * the result (task notification), and that continuation ends in its own `result` → sdk-done.
   * Finalizing right at the drain therefore produced a false stop — Done status, completion
   * sound, unread marker, and AI analysis fired seconds before the agent visibly resumed.
   *
   * So the drain only ARMS this grace timer. Any fresh agent activity (text, tool, thinking,
   * new subagent/task) cancels it — the continuation is underway and its own sdk-done will
   * finalize through the normal path. Only a fully silent grace window finalizes here, which
   * covers the case where the SDK never re-invokes so sessions can't hang at "querying".
   */
  const DEFERRED_COMPLETION_GRACE_MS = 120_000;
  const deferredFinalizeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function cancelDeferredFinalize(id: string): void {
    const timer = deferredFinalizeTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      deferredFinalizeTimers.delete(id);
    }
  }

  function scheduleDeferredFinalize(id: string): void {
    cancelDeferredFinalize(id);
    deferredFinalizeTimers.set(id, setTimeout(() => {
      deferredFinalizeTimers.delete(id);
      // Re-check at fire time: anything that settled the turn meanwhile (real sdk-done,
      // stop, error, new prompt) cleared completionDeferred; new work re-filled the live sets.
      let s: SdkSession | undefined;
      subscribe(ss => { s = ss.find(x => x.id === id); })();
      if (
        !s ||
        !s.completionDeferred ||
        s.stopRequestedAt ||
        (s.liveSubagentIds ?? []).length > 0 ||
        (s.liveBackgroundTasks ?? []).some(t => t.kind !== 'server')
      ) {
        return;
      }
      console.log(`[sdkSessions] no main-agent re-invocation within grace window — running deferred completion (session: ${id})`);
      finalizeCompletion(id, false);
    }, DEFERRED_COMPLETION_GRACE_MS));
  }

  /**
   * Run the real end-of-turn completion: append the terminal marker, flip to idle,
   * mark unread, clear progressive usage, play the completion sound, and kick off AI
   * analysis of the (now complete) transcript.
   *
   * Called either directly from the sdk-done handler (no subagents in flight) or, when
   * completion was DEFERRED because background subagents were still running, from the
   * grace timer above once the live set drained AND no continuation activity followed.
   * Deferring matters because the SDK emits its `result` (→ sdk-done) as soon as the
   * main agent's turn ends — background subagents keep running past that point, and
   * finalizing early would mark the session Done, play the sound, and analyze a
   * half-finished transcript.
   */
  function finalizeCompletion(id: string, wasStoppedByUser: boolean): void {
    cancelDeferredFinalize(id);
    const currentSettings = get(settings);
    const now = Date.now();
    let sessionMessages: SdkMessage[] = [];
    let needsAiAnalysis = false;

    update(sessions =>
      sessions.map(s => {
        if (s.id !== id) return s;

        const workPeriod = calculateWorkPeriod(s);
        const closedThinkingMessages = closeOpenThinkingMessages(s.messages, now);
        const terminalType = wasStoppedByUser ? 'stopped' as const : 'done' as const;
        const updatedMessages = [...closedThinkingMessages, { type: terminalType, timestamp: now }];
        sessionMessages = updatedMessages;
        needsAiAnalysis = !wasStoppedByUser && isLlmEnabled() && (!s.aiMetadata?.outcome || s.aiMetadata?.needsInteraction === undefined);

        // On-screen (not just pane-assigned): while on settings/usage/etc. the pane
        // area is unmounted, so completions there must still mark the session unread.
        const isActiveSession = get(onScreenSessionIds).has(id);
        return {
          ...s,
          status: 'idle' as const,
          stopRequestedAt: undefined,
          // Clear semi-stop tracking: this turn is now truly finished.
          completionDeferred: false,
          liveSubagentIds: [],
          ...workPeriod,
          usage: clearProgressiveUsage(s.usage),
          messages: updatedMessages,
          unread: currentSettings.mark_sessions_unread && !isActiveSession ? true : s.unread,
        };
      })
    );
    debouncedSave(id);

    if (!wasStoppedByUser && currentSettings.audio.play_sound_on_completion) {
      playCompletionSound();
    }

    if (needsAiAnalysis && sessionMessages.length > 0) {
      // Analysis can resolve minutes later (rate-limited LLM calls retry after the
      // provider's suggested delay). If a newer turn started meanwhile, its sendPrompt
      // cleared the completion metadata expecting a fresh analysis — don't clobber it
      // with results for the old transcript.
      const analyzedUserTurns = sessionMessages.filter(m => m.type === 'user').length;
      analyzeSessionCompletion(sessionMessages)
        .then(aiMetadata => {
          if (Object.keys(aiMetadata).length > 0) {
            update(sessions =>
              sessions.map(s =>
                s.id === id && s.messages.filter(m => m.type === 'user').length === analyzedUserTurns
                  ? { ...s, aiMetadata: { ...s.aiMetadata, ...aiMetadata } }
                  : s
              )
            );
            debouncedSave(id);
          }
        })
        .catch(err => console.error('[sdkSessions] Failed to analyze session completion:', err));
    }
  }

  /**
   * Catch-all safety net behind the subagent-deferral logic: if any fresh agent activity arrives
   * AFTER a session was marked done, the "done" was wrong (the agent is still working) — so flip
   * the status back to "querying" and strip the premature trailing 'done' marker. The next real
   * sdk-done will re-finalize correctly.
   *
   * Only resurrects from a clean completion (trailing 'done' marker). A user-initiated stop
   * ('stopped' marker / stopRequestedAt) and errors are intentional terminal states and are left
   * alone. During a deferred completion the status is already 'querying', so this is a no-op there.
   *
   * Returns the (possibly reactivated) session; callers then append their new activity message.
   */
  function reactivateOnActivity(s: SdkSession, now: number): SdkSession {
    if (s.status !== 'idle' && s.status !== 'done') return s;
    if (s.stopRequestedAt) return s;
    const last = s.messages[s.messages.length - 1];
    if (last?.type !== 'done') return s;
    return {
      ...s,
      status: 'querying' as const,
      currentWorkStartedAt: s.currentWorkStartedAt || now,
      messages: s.messages.slice(0, -1),
    };
  }

  // ---------------------------------------------------------------------------
  // Event Listener Setup (Single implementation, used by all initialization paths)
  // ---------------------------------------------------------------------------

  async function setupEventListeners(id: string): Promise<UnlistenFn[]> {
    const unlisteners: UnlistenFn[] = [];

    // Text events (payload includes parentToolUseId for task scoping, turnUuid for fork support)
    unlisteners.push(
      await listen<{ content: string; parentToolUseId?: string | null; turnUuid?: string | null }>(`sdk-text-${id}`, (e) => {
        const { content, parentToolUseId, turnUuid } = e.payload;
        // Fresh agent activity: the main agent resumed after the background work settled —
        // a pending grace finalize would be a false stop, so cancel it.
        cancelDeferredFinalize(id);
        update(sessions =>
          sessions.map(s => {
            if (s.id !== id) return s;
            const now = Date.now();
            const base = reactivateOnActivity(s, now);
            return {
              ...base,
              startedAt: base.startedAt || now,
              currentWorkStartedAt: base.currentWorkStartedAt || now,
              messages: [...base.messages, { type: 'text' as const, content, parentToolUseId: parentToolUseId || undefined, turnUuid: turnUuid || undefined, timestamp: now }],
            };
          })
        );
        debouncedSave(id);
      })
    );

    // Tool start events
    unlisteners.push(
      await listen<{ tool: string; input: Record<string, unknown>; toolUseId: string; parentToolUseId?: string | null; turnUuid?: string | null }>(
        `sdk-tool-start-${id}`,
        (e) => {
          usageStats.trackToolCall(e.payload.tool);

          // Detect ExitPlanMode / AskUserQuestion tool calls directly from the
          // streaming path.  The sidecar also sends dedicated events for these via
          // canUseTool, but those events may not arrive reliably (stdout buffering
          // on Windows, SDK version differences in permission handling).  Detecting
          // them here from the tool_start is more robust because this event is
          // proven to work — it already renders the tool card in the UI.
          const toolName = e.payload.tool;
          const isPlanApprovalTool = toolName === 'ExitPlanMode';
          const isAskUserQuestion = toolName === 'AskUserQuestion';

          if (isPlanApprovalTool) {
            console.log(`[sdkSessions] Plan approval tool detected via tool_start: ${toolName} (session: ${id})`);
          }

          // Extract allowedPrompts and plan from ExitPlanMode input
          const exitPlanAllowedPrompts = isPlanApprovalTool
            ? ((e.payload.input as { allowedPrompts?: Array<{ tool: string; prompt: string }> })?.allowedPrompts || [])
            : undefined;
          const exitPlanContent = isPlanApprovalTool
            ? ((e.payload.input as { plan?: string })?.plan || undefined)
            : undefined;

          // Extract questions from AskUserQuestion input
          const askQuestions = isAskUserQuestion
            ? ((e.payload.input as { questions?: PlanningQuestion[] })?.questions || [])
            : undefined;

          // Fresh agent activity cancels a pending deferred-completion grace finalize.
          cancelDeferredFinalize(id);
          // Track whether this event newly raises a question, so we alert once.
          let raisedQuestion = false;
          update(sessions =>
            sessions.map(s => {
              if (s.id !== id) return s;
              const now = Date.now();
              const base = reactivateOnActivity(s, now);
              if (isAskUserQuestion && askQuestions && askQuestions.length > 0 && !s.askUserQuestion) {
                raisedQuestion = true;
              }
              return {
                ...base,
                startedAt: base.startedAt || now,
                currentWorkStartedAt: base.currentWorkStartedAt || now,
                messages: [
                  ...base.messages,
                  {
                    type: 'tool_start' as const,
                    tool: e.payload.tool,
                    toolUseId: e.payload.toolUseId,
                    input: e.payload.input,
                    parentToolUseId: e.payload.parentToolUseId || undefined,
                    turnUuid: e.payload.turnUuid || undefined,
                    timestamp: now,
                  },
                ],
                // Set pendingPlanApproval when ExitPlanMode is detected
                ...(isPlanApprovalTool ? {
                  pendingPlanApproval: {
                    allowedPrompts: exitPlanAllowedPrompts!,
                    plan: exitPlanContent,
                  },
                } : {}),
                // Set askUserQuestion when AskUserQuestion is detected
                ...(isAskUserQuestion && askQuestions && askQuestions.length > 0 ? {
                  askUserQuestion: {
                    questions: askQuestions,
                    answers: [] as PlanningAnswer[],
                    currentQuestionIndex: 0,
                  },
                } : {}),
              };
            })
          );
          if (raisedQuestion && get(settings).audio.play_sound_on_question) {
            playQuestionSound();
          }
          debouncedSave(id);
        }
      )
    );

    // Tool result events
    unlisteners.push(
      await listen<{ tool: string; output: string; toolUseId: string; parentToolUseId?: string | null; turnUuid?: string | null; images?: { mediaType: string; base64Data: string }[] | null }>(`sdk-tool-result-${id}`, (e) => {
        const toolName = e.payload.tool;
        const isPlanApprovalResult = toolName === 'ExitPlanMode';
        if (isPlanApprovalResult) {
          console.log(`[sdkSessions] Plan approval tool_result received: ${toolName} (session: ${id}, output: ${e.payload.output.slice(0, 100)})`);
        }
        const images: SdkImageContent[] | undefined = e.payload.images?.map(img => ({
          mediaType: img.mediaType as SdkImageContent['mediaType'],
          base64Data: img.base64Data,
        }));
        // Fresh agent activity cancels a pending deferred-completion grace finalize.
        cancelDeferredFinalize(id);
        update(sessions =>
          sessions.map(s =>
            s.id !== id ? s : (() => {
              const now = Date.now();
              const base = reactivateOnActivity(s, now);
              return {
                ...base,
                messages: [
                  ...base.messages,
                  {
                    type: 'tool_result' as const,
                    tool: e.payload.tool,
                    toolUseId: e.payload.toolUseId,
                    output: e.payload.output,
                    parentToolUseId: e.payload.parentToolUseId || undefined,
                    turnUuid: e.payload.turnUuid || undefined,
                    images: images && images.length > 0 ? images : undefined,
                    timestamp: now,
                  },
                ],
              };
            })()
          )
        );
        debouncedSave(id);
      })
    );

    // Thinking start events
    unlisteners.push(
      await listen<{ content: string; timestamp: number; parentToolUseId?: string | null; turnUuid?: string | null }>(`sdk-thinking-start-${id}`, (e) => {
        // Fresh agent activity cancels a pending deferred-completion grace finalize.
        cancelDeferredFinalize(id);
        update(sessions =>
          sessions.map(s => {
            if (s.id !== id) return s;
            const base = reactivateOnActivity(s, Date.now());
            return {
              ...base,
              messages: [
                ...base.messages,
                { type: 'thinking' as const, content: e.payload.content, parentToolUseId: e.payload.parentToolUseId || undefined, turnUuid: e.payload.turnUuid || undefined, timestamp: e.payload.timestamp },
              ],
            };
          })
        );
      })
    );

    // Thinking end events
    unlisteners.push(
      await listen<{ durationMs: number; content: string; parentToolUseId?: string | null; turnUuid?: string | null }>(`sdk-thinking-end-${id}`, (e) => {
        const payloadParent = e.payload.parentToolUseId || undefined;
        const payloadTurnUuid = e.payload.turnUuid || undefined;
        update(sessions =>
          sessions.map(s => {
            if (s.id !== id) return s;
            const messages = [...s.messages];
            const matchIndex = findOpenThinkingMessageIndex(messages, payloadParent, payloadTurnUuid);
            if (matchIndex >= 0) {
              messages[matchIndex] = {
                ...messages[matchIndex],
                thinkingDurationMs: e.payload.durationMs,
                content: e.payload.content,
                turnUuid: payloadTurnUuid || messages[matchIndex].turnUuid,
              };
            }
            return { ...s, messages };
          })
        );
      })
    );

    // Done events
    unlisteners.push(
      await listen(`sdk-done-${id}`, async () => {
        // A real result supersedes any pending deferred-completion grace finalize:
        // whatever branch we take below is the authoritative settling of this turn.
        cancelDeferredFinalize(id);
        // Peek current session state to branch on overflow-recovery / stop / live subagents.
        let snapshot: SdkSession | undefined;
        subscribe(ss => { snapshot = ss.find(s => s.id === id); })();
        if (!snapshot) return;

        const wasStoppedByUser = !!snapshot.stopRequestedAt;
        const recovery = snapshot.overflowRecovery ?? null;

        // --- Context-overflow auto-recovery state machine ---
        // Mid-recovery: the intermediate /compact turn just finished. This isn't a real turn
        // completion — keep the session "in progress" and resend the prompt that overflowed.
        if (recovery?.phase === 'compacting' && !wasStoppedByUser) {
          update(sessions =>
            sessions.map(s => {
              if (s.id !== id) return s;
              const workPeriod = calculateWorkPeriod(s);
              return {
                ...s,
                status: 'querying' as const,
                ...workPeriod,
                usage: clearProgressiveUsage(s.usage),
                overflowRecovery: { ...recovery, phase: 'resending' as const },
              };
            })
          );
          debouncedSave(id);
          try {
            await storeApi.sendPrompt(id, recovery.pendingPrompt, recovery.pendingImages);
          } catch (err) {
            console.error('[sdkSessions] overflow auto-retry failed:', err);
            update(sessions =>
              sessions.map(s => (s.id === id ? { ...s, status: 'error' as const, contextOverflow: true, overflowRecovery: null } : s))
            );
            debouncedSave(id);
          }
          // The /compact turn isn't a real completion — skip sound and AI analysis.
          return;
        }
        if (recovery && wasStoppedByUser) {
          // User interrupted mid-recovery — abandon it, then fall through to normal completion.
          update(sessions => sessions.map(s => (s.id === id ? { ...s, overflowRecovery: null } : s)));
          debouncedSave(id);
        } else if (recovery?.phase === 'resending') {
          // The retried prompt completed successfully — recovery is done. Fall through to complete.
          update(sessions => sessions.map(s => (s.id === id ? { ...s, overflowRecovery: null } : s)));
          debouncedSave(id);
        }

        // --- Semi-stop detection ---
        // The SDK fires `result` (→ this event) as soon as the MAIN agent produces a turn with no
        // tool calls. Since Claude Code v2.1.198 subagents run in the BACKGROUND by default, so they
        // can still be working at this point. If any are live, this is a "semi-stop": stay busy and
        // DEFER real completion until the last subagent_stop, so we don't prematurely mark the
        // session Done / play the completion sound / run AI analysis on a partial transcript.
        //
        // Background AGENT tasks (kind 'agent') block too: they're the same subagents seen through
        // the in-stream task_started channel, which can register them before (or without) the
        // SubagentStart hook event arriving — without this, a turn that ends right after spawning
        // background subagents reads as Done and plays the completion sound while they still work.
        // Background bash COMMANDS (kind 'command') also defer completion — they're expected to
        // finish (builds, test runs…). Commands matching the server patterns (kind 'server') can
        // run indefinitely, so they never block; they only drive the "server running" indicator.
        const liveSubagents = snapshot.liveSubagentIds ?? [];
        const liveBlockingTasks = (snapshot.liveBackgroundTasks ?? []).filter(t => t.kind !== 'server');
        if (!wasStoppedByUser && (liveSubagents.length > 0 || liveBlockingTasks.length > 0)) {
          update(sessions =>
            sessions.map(s => {
              if (s.id !== id) return s;
              return {
                ...s,
                // Stay "querying": background subagents are still doing real work. Keep the work
                // timer running (don't call calculateWorkPeriod) so the wait counts toward duration;
                // the drain of the live set arms the grace timer, and either the continuation's
                // own sdk-done or a silent grace window runs finalizeCompletion.
                status: 'querying' as const,
                completionDeferred: true,
                usage: clearProgressiveUsage(s.usage),
              };
            })
          );
          debouncedSave(id);
          console.log(`[sdkSessions] sdk-done deferred: ${liveSubagents.length} subagent(s), ${liveBlockingTasks.length} background task(s) still running (session: ${id})`);
          return;
        }

        if (snapshot.pendingPlanApproval) {
          console.log(`[sdkSessions] sdk-done fired while pendingPlanApproval is set (session: ${id}, wasStoppedByUser: ${wasStoppedByUser})`);
        }
        if (snapshot.askUserQuestion) {
          console.log(`[sdkSessions] sdk-done fired while askUserQuestion is set (session: ${id}, wasStoppedByUser: ${wasStoppedByUser})`);
        }

        finalizeCompletion(id, wasStoppedByUser);
      })
    );

    // Error events
    unlisteners.push(
      await listen<string>(`sdk-error-${id}`, async (e) => {
        // An error settles the turn — drop any pending deferred-completion grace finalize.
        cancelDeferredFinalize(id);
        const currentSettings = get(settings);
        const now = Date.now();
        const payload = e.payload ?? '';
        const isContextOverflow = isContextOverflowError(payload);
        let startRecovery = false;
        update(sessions =>
          sessions.map(s => {
            if (s.id !== id) return s;
            const workPeriod = calculateWorkPeriod(s);
            const closedThinkingMessages = closeOpenThinkingMessages(s.messages, now);

            // A user-requested stop takes precedence over everything. This error is the interrupt
            // landing (or a real error racing the stop) — settle the turn as a clean stop, never as an
            // error banner and NEVER auto-compacting. `stopRequestedAt` is set synchronously in
            // stopQuery() before the interrupt, so it's reliably visible here. (Mirrors sdk-done's stop
            // path; without this, stopping near the context limit could fire a spurious /compact.)
            if (s.stopRequestedAt) {
              return {
                ...s,
                status: 'idle' as const,
                stopRequestedAt: undefined,
                completionDeferred: false,
                liveSubagentIds: [],
                liveBackgroundTasks: [],
                ...workPeriod,
                usage: clearProgressiveUsage(s.usage),
                messages: [...closedThinkingMessages, { type: 'stopped' as const, timestamp: now }],
                overflowRecovery: null,
              };
            }

            // Auto-recover from context overflow — covers BOTH overflowing on the user's prompt and
            // running out of context mid-turn while Claude is working. Compact, then re-run the turn's
            // originating prompt. Gated to Claude sessions with auto-compaction on, one cycle per overflow.
            const canAutoRecover =
              isContextOverflow &&
              s.provider !== 'openai' &&
              s.autocompactEnabled !== false &&
              (s.overflowRecovery?.attempts ?? 0) < MAX_OVERFLOW_RECOVERY_ATTEMPTS;
            const lastUserIdx = canAutoRecover
              ? findLastIndex(closedThinkingMessages, m => m.type === 'user')
              : -1;
            if (canAutoRecover && lastUserIdx !== -1) {
              const failed = closedThinkingMessages[lastUserIdx];
              // If the prompt overflowed before any work happened (it's the trailing message), strip it so
              // the resend isn't a duplicate. If Claude was mid-turn (work follows it), keep the transcript.
              const overflowedOnSend = lastUserIdx === closedThinkingMessages.length - 1;
              const baseMessages = overflowedOnSend
                ? closedThinkingMessages.filter((_, i) => i !== lastUserIdx)
                : closedThinkingMessages;
              startRecovery = true;
              return {
                ...s,
                // Stay busy: the /compact query is queued immediately after this update.
                status: 'querying' as const,
                ...workPeriod,
                usage: clearProgressiveUsage(s.usage),
                messages: [
                  ...baseMessages,
                  { type: 'notification' as const, content: 'Context limit reached — auto-compacting and retrying…', timestamp: now },
                ],
                overflowRecovery: {
                  pendingPrompt: failed.content ?? '',
                  pendingImages: failed.images,
                  phase: 'compacting' as const,
                  attempts: (s.overflowRecovery?.attempts ?? 0) + 1,
                },
              };
            }

            return {
              ...s,
              status: 'error' as const,
              completionDeferred: false,
              liveSubagentIds: [],
              liveBackgroundTasks: [],
              ...workPeriod,
              usage: clearProgressiveUsage(s.usage),
              messages: [...closedThinkingMessages, { type: 'error' as const, content: payload, timestamp: now }],
              unread: currentSettings.mark_sessions_unread && !get(onScreenSessionIds).has(id) ? true : s.unread,
              contextOverflow: isContextOverflow ? true : s.contextOverflow,
              overflowRecovery: null,
            };
          })
        );
        debouncedSave(id);

        if (startRecovery) {
          try {
            await storeApi.sendPrompt(id, '/compact');
          } catch (err) {
            console.error('[sdkSessions] auto-compact after overflow failed:', err);
            update(sessions =>
              sessions.map(s =>
                s.id === id ? { ...s, status: 'error' as const, contextOverflow: true, overflowRecovery: null } : s
              )
            );
            debouncedSave(id);
          }
        }
      })
    );

    // Mid-run rate-limit rejection events (Smart Queue). The SDK signalled that the
    // provider's usage window is exhausted; instead of erroring, keep the session alive and
    // stash the in-flight turn in `rateLimited` so it can be re-sent when the window resets.
    unlisteners.push(
      await listen<{ status: string; resetsAt: number | null; utilization: number | null }>(`sdk-rate-limit-${id}`, (e) => {
        if (e.payload.status !== 'rejected') return;
        const now = Date.now();
        update(sessions =>
          sessions.map(s => {
            if (s.id !== id) return s;
            const provider = s.provider ?? getProviderForModel(s.model);
            const exhaustion = providerExhaustion(provider, s.accountId);
            // Prefer the explicit event reset time (normalized to ms); fall back to the store-derived one.
            const eventReset = normalizeEpochMs(e.payload.resetsAt);
            const resetsAt = eventReset ?? exhaustion.resetsAt;
            // Recover the turn that was rejected: the stashed in-flight prompt, else the last user message.
            const lastUserMsg = [...s.messages].reverse().find(m => m.type === 'user');
            const workPeriod = calculateWorkPeriod(s);
            const closedThinkingMessages = closeOpenThinkingMessages(s.messages, now);
            return {
              ...s,
              // The query is done (rejected) — settle to idle, DO NOT flag as error.
              status: 'idle' as const,
              completionDeferred: false,
              liveSubagentIds: [],
              liveBackgroundTasks: [],
              ...workPeriod,
              usage: clearProgressiveUsage(s.usage),
              messages: closedThinkingMessages,
              rateLimited: {
                reason: 'rate_limit' as const,
                provider,
                window: exhaustion.window,
                resetsAt: resetsAt ?? undefined,
                prompt: s.inFlightPrompt ?? lastUserMsg?.content ?? '',
                images: s.inFlightImages ?? undefined,
                queuedAt: now,
              },
              inFlightPrompt: null,
              inFlightImages: null,
            };
          })
        );
        debouncedSave(id);
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
          sessions.map(s => s.id === id ? { ...s, usage: processQueryUsage(s.usage, queryUsage, s.model) } : s)
        );
      })
    );

    // Progressive usage events
    unlisteners.push(
      await listen<SdkProgressiveUsage>(`sdk-progressive-usage-${id}`, (e) => {
        update(sessions =>
          sessions.map(s => s.id === id ? { ...s, usage: processProgressiveUsage(s.usage, e.payload, s.model) } : s)
        );
      })
    );

    // Subagent start events — track the agent as live so a subsequent sdk-done defers completion.
    unlisteners.push(
      await listen<{ agentId: string; agentType: string }>(`sdk-subagent-start-${id}`, (e) => {
        // New live work supersedes a pending deferred-completion grace finalize.
        cancelDeferredFinalize(id);
        update(sessions =>
          sessions.map(s => {
            if (s.id !== id) return s;
            const base = reactivateOnActivity(s, Date.now());
            const live = base.liveSubagentIds ?? [];
            return {
              ...base,
              liveSubagentIds: live.includes(e.payload.agentId) ? live : [...live, e.payload.agentId],
              messages: [
                ...base.messages,
                { type: 'subagent_start' as const, agentId: e.payload.agentId, agentType: e.payload.agentType, timestamp: Date.now() },
              ],
            };
          })
        );
        debouncedSave(id);
      })
    );

    // Subagent stop events — drop the agent from the live set. If completion was deferred waiting
    // on subagents and this was the last one, DON'T finalize yet: the SDK is usually about to
    // re-invoke the main agent with the subagent's result. Arm the grace timer instead — fresh
    // activity cancels it, a silent window finalizes (see scheduleDeferredFinalize).
    unlisteners.push(
      await listen<{ agentId: string; transcriptPath: string }>(`sdk-subagent-stop-${id}`, (e) => {
        let shouldScheduleFinalize = false;
        update(sessions =>
          sessions.map(s => {
            if (s.id !== id) return s;
            const live = (s.liveSubagentIds ?? []).filter(aid => aid !== e.payload.agentId);
            if (
              s.completionDeferred &&
              live.length === 0 &&
              !(s.liveBackgroundTasks ?? []).some(t => t.kind !== 'server') &&
              !s.stopRequestedAt
            ) {
              shouldScheduleFinalize = true;
            }
            return {
              ...s,
              liveSubagentIds: live,
              messages: [
                ...s.messages,
                { type: 'subagent_stop' as const, agentId: e.payload.agentId, transcriptPath: e.payload.transcriptPath, timestamp: Date.now() },
              ],
            };
          })
        );
        debouncedSave(id);
        if (shouldScheduleFinalize) {
          console.log(`[sdkSessions] last subagent stopped — arming deferred-completion grace timer (session: ${id})`);
          scheduleDeferredFinalize(id);
        }
      })
    );

    // Subagent model events — the subagent's actual model, reported once per Task toolUseId
    // from the subagent's first assistant message. Drives the model badge on task blocks.
    unlisteners.push(
      await listen<{ toolUseId: string; model: string }>(`sdk-subagent-model-${id}`, (e) => {
        update(sessions =>
          sessions.map(s => s.id === id
            ? { ...s, subagentModels: { ...(s.subagentModels ?? {}), [e.payload.toolUseId]: e.payload.model } }
            : s)
        );
        debouncedSave(id);
      })
    );

    // Task started events (from SDK task_started system messages)
    unlisteners.push(
      await listen<{ taskId: string; toolUseId?: string; description: string; taskType?: string }>(`sdk-task-started-${id}`, (e) => {
        // New live work supersedes a pending deferred-completion grace finalize.
        cancelDeferredFinalize(id);
        update(sessions =>
          sessions.map(s => {
            if (s.id !== id) return s;
            const base = reactivateOnActivity(s, Date.now());
            const live = base.liveBackgroundTasks ?? [];
            if (live.some(t => t.taskId === e.payload.taskId)) return base;

            const isBash = e.payload.taskType === 'local_bash';
            // The SDK emits task_started for FOREGROUND bash too (real logs: ~1900 foreground
            // events, zero backgrounded). Only track bash explicitly launched with
            // run_in_background — a blocking foreground run is already covered by the tool
            // spinner. The tool_use block (correlated via toolUseId) is the source of truth for
            // both the flag and the command; the task description can be just a human label.
            let label = e.payload.description;
            if (isBash) {
              const toolMsg = e.payload.toolUseId
                ? base.messages.find(m => m.type === 'tool_start' && m.toolUseId === e.payload.toolUseId)
                : undefined;
              if (toolMsg?.input?.run_in_background !== true) return base;
              const cmd = toolMsg.input?.command;
              if (typeof cmd === 'string' && cmd.trim()) label = cmd;
            }
            const kind: BackgroundTaskKind = !isBash
              ? 'agent'
              : matchesServerCommand(`${label} ${e.payload.description}`) ? 'server' : 'command';

            return {
              ...base,
              liveBackgroundTasks: [
                ...live,
                { taskId: e.payload.taskId, toolUseId: e.payload.toolUseId, kind, label, startedAt: Date.now() },
              ],
              // local_bash tasks already render as their Bash tool_use block — track only,
              // don't append a duplicate transcript message.
              messages: isBash
                ? base.messages
                : [
                    ...base.messages,
                    {
                      type: 'task_started' as const,
                      taskId: e.payload.taskId,
                      toolUseId: e.payload.toolUseId,
                      description: e.payload.description,
                      taskType: e.payload.taskType,
                      timestamp: Date.now(),
                    },
                  ],
            };
          })
        );
        debouncedSave(id);
      })
    );

    // Task completed events (from SDK task_notification system messages). If completion was
    // deferred and this was the last piece of blocking background work, arm the grace timer —
    // a finished background task normally re-invokes the main agent to process its result,
    // so finalizing at the drain would be a false stop (see scheduleDeferredFinalize).
    unlisteners.push(
      await listen<{ taskId: string; toolUseId?: string; status: string; summary: string; taskType?: string; usage?: { total_tokens: number; tool_uses: number; duration_ms: number } }>(`sdk-task-completed-${id}`, (e) => {
        let shouldScheduleFinalize = false;
        update(sessions =>
          sessions.map(s => {
            if (s.id !== id) return s;
            const settled = (s.liveBackgroundTasks ?? []).find(t => t.taskId === e.payload.taskId);
            const live = (s.liveBackgroundTasks ?? []).filter(t => t.taskId !== e.payload.taskId);
            if (
              s.completionDeferred &&
              !s.stopRequestedAt &&
              (s.liveSubagentIds ?? []).length === 0 &&
              !live.some(t => t.kind !== 'server')
            ) {
              shouldScheduleFinalize = true;
            }
            // Real task_notifications arrive with taskType undefined — determine bash-ness from
            // the tracked task, else by correlating the tool_use (untracked foreground bash also
            // emits notifications; those must not become transcript messages).
            const isBash = settled
              ? settled.kind !== 'agent'
              : e.payload.taskType === 'local_bash' ||
                (!!e.payload.toolUseId &&
                  s.messages.some(m => m.type === 'tool_start' && m.toolUseId === e.payload.toolUseId && m.tool === 'Bash'));
            return {
              ...s,
              liveBackgroundTasks: live,
              messages: isBash
                ? s.messages
                : [
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
            };
          })
        );
        debouncedSave(id);
        if (shouldScheduleFinalize) {
          console.log(`[sdkSessions] last blocking background task settled — arming deferred-completion grace timer (session: ${id})`);
          scheduleDeferredFinalize(id);
        }
      })
    );

    // AskUserQuestion events - interactive questions from Claude
    unlisteners.push(
      await listen<PlanningQuestion[]>(`sdk-ask-user-questions-${id}`, (e) => {
        let raisedQuestion = false;
        update(sessions =>
          sessions.map(s => {
            if (s.id !== id) return s;
            if (!s.askUserQuestion && e.payload.length > 0) {
              raisedQuestion = true;
            }
            return {
              ...s,
              askUserQuestion: {
                questions: e.payload,
                answers: [],
                currentQuestionIndex: 0,
              },
            };
          })
        );
        if (raisedQuestion && get(settings).audio.play_sound_on_question) {
          playQuestionSound();
        }
      })
    );

    // Plan approval request - ExitPlanMode intercepted, waiting for user decision
    unlisteners.push(
      await listen<{ allowedPrompts: Array<{ tool: string; prompt: string }>; plan?: string | null }>(
        `sdk-plan-approval-request-${id}`, (e) => {
          console.log(`[sdkSessions] Plan approval request received (session: ${id}, allowedPrompts: ${e.payload.allowedPrompts.length}, hasPlan: ${!!e.payload.plan})`);
          update(sessions => sessions.map(s => {
            if (s.id !== id) return s;
            // Pause the timer while waiting for plan approval - avoids 24h+ display if user waits overnight
            const workPeriod = calculateWorkPeriod(s);
            return {
              ...s,
              ...workPeriod,
              pendingPlanApproval: {
                allowedPrompts: e.payload.allowedPrompts,
                plan: e.payload.plan || undefined,
              },
            };
          }));
        }
      )
    );

    // SDK session ID events - capture for proper resume after app restart
    unlisteners.push(
      await listen<string>(`sdk-session-id-${id}`, (e) => {
        console.log(`[sdkSessions] Captured SDK session ID for ${id}: ${e.payload}`);
        update(sessions =>
          sessions.map(s => s.id === id ? { ...s, sdkSessionId: e.payload } : s)
        );
        debouncedSave(id);
      })
    );

    // Parallel session notification - another session was started in the same CWD
    // Deduplicate within the whole chat session: if already present anywhere, refresh timestamp.
    unlisteners.push(
      await listen<string>(`sdk-parallel-notification-${id}`, (e) => {
        console.log(`[sdkSessions] Parallel session notification for ${id}: ${e.payload}`);
        update(sessions =>
          sessions.map(s => {
            if (s.id !== id) return s;
            let existingIndex = -1;
            for (let i = s.messages.length - 1; i >= 0; i--) {
              const m = s.messages[i];
              if (m.type === 'notification' && m.content === e.payload) {
                existingIndex = i;
                break;
              }
            }
            if (existingIndex !== -1) {
              // Already shown in this chat - just update timestamp.
              const updatedMessages = [...s.messages];
              const existingMsg = updatedMessages[existingIndex];
              updatedMessages[existingIndex] = { ...existingMsg, timestamp: Date.now() };
              return { ...s, messages: updatedMessages };
            }
            return {
              ...s,
              messages: [...s.messages, {
                type: 'notification' as const,
                content: e.payload,
                timestamp: Date.now(),
              }],
            };
          })
        );
        debouncedSave(id);
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
    provider?: string,
    forkFromSdkSessionId?: string | null, // SDK session ID to fork from
    forkAtMessageUuid?: string | null, // Message UUID to fork at (resumeSessionAt)
    autocompactEnabled?: boolean | null
  ): Promise<void> {
    const currentSettings = get(settings);
    const resolvedModel = resolveModelForApi(model, currentSettings.enabled_models);
    const resolvedProvider = normalizeSdkProvider(provider, resolvedModel);

    // Determine which MCP servers to use
    // Use mcp_servers from repo config or all enabled global servers
    let mcpServers: McpServerConfig[] | null = null;
    console.log('[MCP Debug] Total MCP servers in settings:', currentSettings.mcp?.servers?.length ?? 0);
    if (currentSettings.mcp?.servers?.length > 0) {
      const repo = get(repos).list.find((r) => r.path === cwd);
      console.log('[MCP Debug] Session cwd:', cwd);
      console.log('[MCP Debug] Found repo:', repo?.name, 'with mcp_servers:', repo?.mcp_servers);
      let servers: McpServerConfig[];

      if (repo?.mcp_servers?.length) {
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

    // Pin gh to the repo's configured GitHub account (backend resolves the token).
    const sessionRepoId = resolveRepoId(cwd);
    const repoForSession = findRepoById(get(repos).list, sessionRepoId);
    const ghUser = repoForSession?.gh_user ?? null;

    // Pin the session to an agent account (the backend injects the profile env var).
    // Prefer an id already set on the session (explicit setup/fork choice); otherwise
    // derive from the repo whitelist/preference. Store it before invoking so restores,
    // rate-limit re-sends and forks stay pinned to the same account.
    const existingAccountId = get({ subscribe }).find((s) => s.id === id)?.accountId;
    const resolvedAccountId =
      existingAccountId ??
      defaultAccountIdForRepo(
        currentSettings.accounts,
        repoForSession,
        resolvedProvider === 'openai' ? 'OpenAI' : 'Claude',
      );
    if (resolvedAccountId && resolvedAccountId !== existingAccountId) {
      update((all) => all.map((s) => (s.id === id ? { ...s, accountId: resolvedAccountId } : s)));
    }

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
      codexMode: resolvedProvider === 'openai' ? 'AppServer' : null,
      systemPrompt: systemPrompt ?? null,
      // Only send history messages if we don't have an SDK session ID (legacy fallback)
      messages: !usesSdkSessionId && historyMessages && historyMessages.length > 0 ? historyMessages : null,
      sdkSessionId: usesSdkSessionId ? sdkSessionId : null,
      mcpServers: mcpServers && mcpServers.length > 0 ? mcpServers : null,
      provider: resolvedProvider,
      forkFromSdkSessionId: forkFromSdkSessionId ?? null,
      forkAtMessageUuid: forkAtMessageUuid ?? null,
      // Translate boolean to pct at the IPC boundary.
      //   false -> 0    : sidecar sets DISABLE_AUTO_COMPACT=1 (PCT_OVERRIDE cannot disable — clamped).
      //   true  -> null : no override; let Claude's built-in default (~83.5%) apply. That IS the optimal —
      //                   it's derived from a hardcoded 33K-token buffer, and the override is clamped so we
      //                   can't go higher. Any lower value just wastes context without preventing single-turn
      //                   tool-result overflows (those require the full 33K buffer regardless).
      autocompactPct:
        resolvedProvider === 'claude' && autocompactEnabled === false ? 0 : null,
      ghUser,
      accountId: resolvedAccountId ?? null,
    });

    if (effortLevel && modelSupportsEffort(model)) {
      // Clamp to a value the target provider actually supports (OpenAI/Codex caps at 'high')
      const clamped = clampEffortForModel(effortLevel, resolvedModel);
      await invoke('update_sdk_effort', { id, effortLevel: clamped });
    }

    liveSessions.add(id);
  }

  async function syncSessionBranchMetadata(id: string, cwd: string): Promise<void> {
    if (!cwd || cwd === '.') {
      update(allSessions =>
        allSessions.map(s => (s.id === id ? { ...s, currentBranch: null } : s))
      );
      return;
    }

    let currentBranch: string | null = null;
    try {
      currentBranch = await invoke<string>('get_git_branch', { repoPath: cwd });
    } catch {
      currentBranch = null;
    }

    let changedFileCount: number | undefined;
    try {
      changedFileCount = await invoke<number>('get_git_changed_count', { repoPath: cwd });
    } catch {
      changedFileCount = undefined;
    }

    update(allSessions =>
      allSessions.map(s => {
        if (s.id !== id) return s;
        return {
          ...s,
          currentBranch,
          changedFileCount,
          // Don't lock in createdBranch during the setup phase — the user hasn't
          // committed to a cwd yet and may switch worktree modes several times.
          // Once the session transitions past 'setup' (in startSetupSession), the
          // first call here will set createdBranch from the actual committed cwd.
          ...(s.status !== 'setup' ? { createdBranch: s.createdBranch ?? currentBranch } : {}),
        };
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Store Methods
  // ---------------------------------------------------------------------------

  const storeApi = {
    subscribe,
    set,

    async ensureSidecarStarted(): Promise<void> {
      if (sidecarStarted) return;
      await invoke('start_sidecar');
      sidecarStarted = true;
    },

    async createSession(cwd: string, model: string, effortLevel: EffortLevel = 'low', systemPrompt?: string, provider?: SdkProvider): Promise<string> {
      await this.ensureSidecarStarted();

      const id = crypto.randomUUID();
      const autoModelRequested = isAutoModel(model);
      const resolvedProvider = normalizeSdkProvider(provider, model);

      const effectiveEffort = modelSupportsEffort(model) ? normalizeEffortLevel(effortLevel) : null;

      const initialSettings = get(settings);
      const autocompactEnabled = resolvedProvider === 'claude' ? initialSettings.default_autocompact_enabled : undefined;

      // Assign a voice callsign deterministically from the curated pool (no LLM),
      // avoiding collisions with nicknames already in use across sessions.
      let existingNicknames: string[] = [];
      subscribe(sessions => {
        existingNicknames = sessions
          .map(s => s.aiMetadata?.nickname)
          .filter((n): n is string => !!n);
      })();
      const nickname = pickNickname(existingNicknames);

      const session: SdkSession = {
        id,
        cwd,
        repoId: resolveRepoId(cwd),
        model,
        provider: resolvedProvider,
        autoModelRequested,
        effortLevel: effectiveEffort,
        messages: [],
        status: 'idle',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        accumulatedDurationMs: 0,
        autocompactEnabled,
        aiMetadata: { nickname },
      };

      update(sessions => [...sessions, session]);

      // For Codex sessions in the same CWD, queue pending notifications
      // (Claude sessions are handled by the sidecar via PreToolUse hook + parallel_session_notification event)
      const currentSettings = get(settings);
      if (currentSettings.notify_parallel_agents && resolvedProvider === 'openai') {
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

          const notificationContent = 'Another agent session was started in this repository. Multiple agents are now working here simultaneously.';

          update(sessions =>
            sessions.map(s => {
              if (parallelCodexSessions.some(p => p.id === s.id)) {
                // Deduplicate within the whole chat session.
                let existingIndex = -1;
                for (let i = s.messages.length - 1; i >= 0; i--) {
                  const m = s.messages[i];
                  if (m.type === 'notification' && m.content === notificationContent) {
                    existingIndex = i;
                    break;
                  }
                }
                let messages: typeof s.messages;
                if (existingIndex !== -1) {
                  messages = [...s.messages];
                  const existingMsg = messages[existingIndex];
                  messages[existingIndex] = { ...existingMsg, timestamp: Date.now() };
                } else {
                  messages = [...s.messages, {
                    type: 'notification' as const,
                    content: notificationContent,
                    timestamp: Date.now(),
                  }];
                }
                const pendingSystemNotifications = s.pendingSystemNotifications || [];
                return {
                  ...s,
                  messages,
                  pendingSystemNotifications: pendingSystemNotifications.includes(notificationText)
                    ? pendingSystemNotifications
                    : [...pendingSystemNotifications, notificationText],
                };
              }
              return s;
            })
          );
        }
      }

      const unlisteners = await setupEventListeners(id);
      listeners.set(id, unlisteners);

      await registerSessionWithBackend(id, cwd, model, effectiveEffort, systemPrompt, null, null, resolvedProvider, undefined, undefined, autocompactEnabled ?? null);
      await syncSessionBranchMetadata(id, cwd);

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

      // Detach any existing listeners first — a session attached live from a
      // sequence node already has a listener set; re-attaching without detaching
      // would double every streamed event.
      const existingListeners = listeners.get(id);
      if (existingListeners) {
        existingListeners.forEach(unlisten => unlisten());
        listeners.delete(id);
      }
      const unlisteners = await setupEventListeners(id);
      listeners.set(id, unlisteners);

      // Prefer SDK session ID for proper resume (avoids context bloat from prepending history)
      // Fall back to history messages only if no SDK session ID is available (legacy sessions)
      const historyMessages = session.sdkSessionId ? null : convertToHistoryMessages(session.messages);
      await registerSessionWithBackend(
        id, session.cwd, session.model, session.effortLevel,
        null, historyMessages, session.sdkSessionId,
        session.provider,
        session.forkFromSdkSessionId, session.forkAtMessageUuid,
        session.autocompactEnabled ?? null
      );
    },

    /**
     * Set the session's display name up front. A preset name also makes
     * sendPrompt skip LLM auto-naming for the first prompt.
     */
    setSessionName(id: string, name: string): void {
      update(sessions =>
        sessions.map(s => (s.id === id ? { ...s, aiMetadata: { ...s.aiMetadata, name } } : s))
      );
      debouncedSave(id);
    },

    dismissContextOverflow(id: string): void {
      update(sessions =>
        sessions.map(s => (s.id === id ? { ...s, contextOverflow: false } : s))
      );
      debouncedSave();
    },

    /**
     * Fork a session from a specific message, creating a new session that branches off
     * with the full conversation context up to that message.
     * Uses the Claude SDK's native resume + resumeSessionAt + forkSession support.
     */
    async forkSession(sourceSessionId: string, messageIndex: number): Promise<string | null> {
      let sourceSession: SdkSession | undefined;
      subscribe(sessions => { sourceSession = sessions.find(s => s.id === sourceSessionId); })();

      if (!sourceSession) return null;

      // Determine the fork point UUID
      const targetMessage = sourceSession.messages[messageIndex];
      if (!targetMessage) return null;

      let forkAtUuid: string | undefined;

      if (targetMessage.type === 'user') {
        // Fork from user message: use the preceding assistant turn's UUID
        // This includes context up to BEFORE this user prompt, so user can type a new one
        for (let i = messageIndex - 1; i >= 0; i--) {
          if (sourceSession.messages[i].turnUuid) {
            forkAtUuid = sourceSession.messages[i].turnUuid;
            break;
          }
        }
        // First user message (no preceding assistant turn) → create fresh session with prompt pre-filled
        if (!forkAtUuid) {
          const newId = this.createSetupSession(
            sourceSession.model,
            sourceSession.effortLevel,
            sourceSession.provider,
            sourceSession.cwd
          );
          this.updateDraft(newId, targetMessage.content || '', targetMessage.images);
          return newId;
        }
      } else {
        // Fork from assistant/tool/thinking message: use its turnUuid or search backward
        forkAtUuid = targetMessage.turnUuid;
        if (!forkAtUuid) {
          for (let i = messageIndex; i >= 0; i--) {
            if (sourceSession.messages[i].turnUuid) {
              forkAtUuid = sourceSession.messages[i].turnUuid;
              break;
            }
          }
        }
      }

      // Need both sdkSessionId and forkAtUuid for SDK forking
      if (!forkAtUuid || !sourceSession.sdkSessionId) return null;

      // Copy parent messages up to fork point for display
      const parentMessages: SdkMessage[] = [];
      for (let i = 0; i <= messageIndex; i++) {
        parentMessages.push({ ...sourceSession.messages[i] });
      }

      const id = crypto.randomUUID();
      const parentLabel = getSessionDisplayLabel(sourceSession);

      const session: SdkSession = {
        id,
        cwd: sourceSession.cwd,
        repoId: sourceSession.repoId,
        model: sourceSession.model,
        provider: sourceSession.provider,
        // Resumability is account-locked: a fork inherits its source's account.
        accountId: sourceSession.accountId,
        effortLevel: sourceSession.effortLevel,
        messages: parentMessages,
        status: 'setup',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        accumulatedDurationMs: 0,
        forkedFromSessionId: sourceSessionId,
        forkedFromSessionLabel: parentLabel,
        forkFromSdkSessionId: sourceSession.sdkSessionId,
        forkAtMessageUuid: forkAtUuid,
        forkedMessageCount: parentMessages.length,
      };

      update(sessions => [...sessions, session]);

      return id;
    },

    /**
     * Attach to a sequence prompt node's agent run as a LIVE SDK session the
     * moment the node starts (id = the sidecar session id). The session appears
     * in the session list immediately and streams in real time off the same
     * `sdk-*` events, exactly like a normal live session — no post-hoc capture.
     * Its `sdkSessionId` is captured live, so it resumes/forks after completion.
     * Idempotent: a second call for the same session id is a no-op.
     */
    attachSequenceNodeSession(params: {
      executionId: string;
      sessionId: string;
      nodeId: string;
      sequenceName?: string;
      nodeName?: string;
      cwd?: string | null;
      model?: string | null;
      provider?: string | null;
      effort?: string | null;
      prompt?: string | null;
    }): void {
      const { executionId, sessionId, nodeId, sequenceName, nodeName } = params;
      if (!sessionId) return;

      // Idempotent (loops re-emit; the create event may also arrive twice).
      let exists = false;
      subscribe(sessions => { exists = sessions.some(s => s.id === sessionId); })();
      if (exists) return;

      const cwd = params.cwd ?? '';
      // The node stores a shorthand model ("opus") — resolve it to a concrete id
      // so the model selector/labels match what ran; provider/effort follow suit.
      const model = resolveModelAlias(params.model ?? DEFAULT_MODEL_ID);
      const provider = normalizeSdkProvider(params.provider ?? undefined, model);
      const rawEffort = (params.effort ?? undefined) as EffortLevel | undefined;
      const effortLevel: EffortLevel =
        rawEffort && rawEffort !== ('off' as unknown as EffortLevel) && modelSupportsEffort(model)
          ? clampEffortForModel(rawEffort, model)
          : null;

      const now = Date.now();
      const messages: SdkMessage[] = params.prompt
        ? [{ type: 'user', content: params.prompt, timestamp: now }]
        : [];

      const label = nodeName
        ? `${sequenceName ? `${sequenceName} · ` : ''}${nodeName}`
        : (sequenceName ?? 'Sequence session');

      const session: SdkSession = {
        id: sessionId,
        cwd,
        repoId: resolveRepoId(cwd),
        model,
        provider,
        effortLevel,
        messages,
        status: 'querying',
        createdAt: now,
        lastActivityAt: now,
        startedAt: now,
        currentWorkStartedAt: now,
        accumulatedDurationMs: 0,
        usage: createDefaultUsage(getMaxContextTokens(model)),
        aiMetadata: { name: label },
        sequenceNode: { executionId, nodeId, sequenceName, nodeName },
      };

      update(sessions => [...sessions, session]);
      // Attach to the live sidecar stream (the sequence engine drives the query;
      // these listeners populate the session's messages/usage/status/sdkSessionId).
      void setupEventListeners(sessionId).then(unlisteners => {
        listeners.set(sessionId, unlisteners);
      });
      debouncedSave(sessionId);
    },

    async sendPrompt(id: string, prompt: string, images?: SdkImageContent[]): Promise<void> {
      update(sessions =>
        sessions.map(s =>
          s.id === id
            ? {
                ...s,
                aiMetadata: clearCompletionMetadata(s.aiMetadata),
              }
            : s
        )
      );

      await this.ensureSessionLive(id);

      let sessionCwd: string | undefined;
      let sessionProvider: SdkProvider = 'claude';
      let sessionAccountId: string | undefined;
      let needsNameGeneration = false;
      let recordingScreenshots: SdkImageContent[] | undefined;
      subscribe(sessions => {
        const session = sessions.find(s => s.id === id);
        sessionCwd = session?.cwd;
        sessionProvider = session?.provider ?? getProviderForModel(session?.model ?? '');
        sessionAccountId = session?.accountId;
        const isFirstUserMessage = session?.messages.filter(m => m.type === 'user').length === 0;
        needsNameGeneration = !session?.aiMetadata?.name && isFirstUserMessage;
        // Recording screenshots ride on the pending session until the first prompt goes out
        if (isFirstUserMessage) recordingScreenshots = session?.pendingTranscription?.screenshots;
      })();

      if (recordingScreenshots && recordingScreenshots.length > 0) {
        images = [...(images ?? []), ...recordingScreenshots];
      }

      usageStats.trackPrompt(sessionCwd);
      // Every sent turn heats up the session's repo so the pickers rank the
      // repos the user actually works in first (worktree cwds resolve to their repo).
      touchRepoForCwd(sessionCwd);

      // Sending a prompt is a good moment to recover the rate-limit indicator if a
      // prior fetch failed transiently (e.g. a startup network blip left it hidden).
      // fetchIfStale() respects the in-flight guard and only refetches when data is
      // stale/missing, so rapid sends won't hammer the usage API.
      void ((sessionProvider as SdkProvider) === 'openai' ? codexRateLimits : rateLimits).fetchIfStale();

      // New turn supersedes any prior semi-stop — including an armed grace timer.
      cancelDeferredFinalize(id);
      update(sessions =>
        sessions.map(s =>
          s.id === id
            ? {
                ...s,
                status: 'querying' as const,
                lastActivityAt: Date.now(),
                messages: [...s.messages, { type: 'user' as const, content: prompt, images, timestamp: Date.now() }],
                aiMetadata: clearCompletionMetadata(s.aiMetadata),
                // New turn supersedes any prior semi-stop: reset subagent tracking so a stale
                // deferred completion (or a prior turn's subagent_stop) can't fire against it.
                // Background tasks are deliberately KEPT — a dev server or long build from a
                // prior turn is still running and should keep showing (and, for commands,
                // keep deferring completion) across turns.
                liveSubagentIds: [],
                completionDeferred: false,
                // A fresh turn is never a "stop": clear any pending stop flag so a not-yet-landed
                // terminal event from the prior turn can't settle this turn as stopped.
                stopRequestedAt: undefined,
                draftPrompt: undefined,
                draftImages: undefined,
                // Screenshots now live in the message — clear them so later prompts don't re-attach
                pendingTranscription: s.pendingTranscription?.screenshots
                  ? { ...s.pendingTranscription, screenshots: undefined }
                  : s.pendingTranscription,
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

      // Label auto-captured screenshots as potentially irrelevant (send-time only, not shown in UI)
      if (hasScreenshotImage(images)) {
        finalPrompt = finalPrompt + '\n\n' + SCREENSHOT_PROMPT_NOTICE;
      }

      // Smart Queue (follow-up gate): if the provider's usage window is exhausted, don't dispatch.
      // The user message stays in the transcript so the queued turn is visible; the turn itself is
      // parked in `rateLimited` and re-sent later by the driver (or manually via "Continue now").
      if (shouldQueue(sessionProvider, sessionAccountId)) {
        const { window: rlWindow, resetsAt } = providerExhaustion(sessionProvider, sessionAccountId);
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? {
                  ...s,
                  status: 'idle' as const,
                  rateLimited: {
                    reason: 'rate_limit' as const,
                    provider: sessionProvider,
                    window: rlWindow,
                    resetsAt,
                    prompt: finalPrompt,
                    images: images ?? undefined,
                    queuedAt: Date.now(),
                  },
                }
              : s
          )
        );
        debouncedSave();
        return;
      }

      // Stash the in-flight turn so a mid-run rate-limit rejection can recover and re-send it.
      update(sessions =>
        sessions.map(s => (s.id === id ? { ...s, inFlightPrompt: finalPrompt, inFlightImages: images ?? null } : s))
      );

      try {
        await invoke('send_sdk_prompt', { id, prompt: finalPrompt, images: images ?? null });
      } catch (error) {
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? { ...s, status: 'error' as const, inFlightPrompt: null, inFlightImages: null, messages: [...s.messages, { type: 'error' as const, content: String(error), timestamp: Date.now() }] }
              : s
          )
        );
        throw error;
      }
    },

    /**
     * Compact the session's conversation history (provider-correct).
     * - Claude: `/compact` is a native slash command — send it as a normal turn.
     * - Codex: history compaction is a dedicated app-server RPC, so route through
     *   the `compact_sdk_session` command (sending "/compact" as text would just
     *   feed the literal string to the model). A "/compact" marker turn is pushed
     *   to the transcript and the session goes `querying` until the backend emits
     *   `sdk-done` for the compaction turn.
     */
    async compactSession(id: string): Promise<void> {
      let session: SdkSession | undefined;
      subscribe(sessions => { session = sessions.find(s => s.id === id); })();
      if (!session) return;
      const provider = session.provider ?? getProviderForModel(session.model);

      if (provider !== 'openai') {
        await this.sendPrompt(id, '/compact');
        return;
      }

      await this.ensureSessionLive(id);
      const now = Date.now();
      update(sessions =>
        sessions.map(s =>
          s.id === id
            ? {
                ...s,
                status: 'querying' as const,
                lastActivityAt: now,
                messages: [...s.messages, { type: 'user' as const, content: '/compact', timestamp: now }],
              }
            : s
        )
      );
      try {
        await invoke('compact_sdk_session', { id });
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
      // A user stop settles the turn — drop any pending deferred-completion grace finalize.
      cancelDeferredFinalize(id);
      if (!liveSessions.has(id)) {
        const now = Date.now();
        update(sessions => sessions.map(s => {
          if (s.id !== id) return s;
          const workPeriod = calculateWorkPeriod(s);
          const closedThinkingMessages = closeOpenThinkingMessages(s.messages, now);
          return {
            ...s,
            status: 'idle' as const,
            stopRequestedAt: undefined,
            completionDeferred: false,
            liveSubagentIds: [],
            liveBackgroundTasks: [],
            ...workPeriod,
            usage: clearProgressiveUsage(s.usage),
            messages: [...closedThinkingMessages, { type: 'stopped' as const, timestamp: now }],
          };
        }));
        debouncedSave();
        return;
      }

      update(sessions => sessions.map(s => {
        if (s.id !== id) return s;
        if (s.pendingPlanApproval) {
          console.log(`[sdkSessions] Clearing pendingPlanApproval due to stop (session: ${id})`);
        }
        if (s.askUserQuestion) {
          console.log(`[sdkSessions] Clearing askUserQuestion due to stop (session: ${id})`);
        }
        return {
          ...s,
          status: 'idle' as const,
          stopRequestedAt: Date.now(),
          // A stop is a real end-of-turn: drop semi-stop tracking so a late subagent_stop
          // can't trigger a deferred completion after the user already stopped.
          completionDeferred: false,
          liveSubagentIds: [],
          liveBackgroundTasks: [],
          // Clear stale blocking-UI state so dialogs don't persist after stop
          pendingPlanApproval: undefined,
          askUserQuestion: undefined,
        };
      }));

      try {
        await invoke('stop_sdk_query', { id });
      } catch (error) {
        update(sessions => sessions.map(s =>
          s.id === id ? { ...s, stopRequestedAt: undefined } : s
        ));
        throw error;
      }
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
      cancelDeferredFinalize(id);

      liveSessions.delete(id);

      // Clean up durable audio for a not-yet-retried failed follow-up recording.
      if (sessionToArchive?.failedRecording) {
        invoke('delete_pile_audio', {
          id: sessionToArchive.failedRecording.audioId,
        }).catch(() => {});
      }

      update(sessions => sessions.filter(s => s.id !== id));
      panes.clearSession(id);

      // Archive the session (only if it has messages worth archiving)
      if (sessionToArchive && sessionToArchive.messages.length > 0) {
        try {
          const { sdkSessionToPersisted } = await import('./sessionPersistence');
          const persisted = sdkSessionToPersisted(sessionToArchive);
          await invoke('archive_sdk_session', { session: persisted });
          // Record as reopenable (Ctrl+Shift+T), browser-tab style.
          const { pushRecentlyClosed } = await import('./recentlyClosed');
          pushRecentlyClosed(id, 'sdk');
          // Trim archive to configured max
          const currentSettings = get(settings);
          await invoke('trim_archive', {
            maxEntries: currentSettings.session_persistence?.max_archived_sessions ?? 500,
          });
          // Refresh archive metadata and list
          const { archive } = await import('./archive');
          await archive.refresh();
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
      const normalizedEffort = normalizeEffortLevel(effortLevel);
      update(sessions => sessions.map(s => s.id === id ? { ...s, effortLevel: normalizedEffort } : s));

      if (!liveSessions.has(id)) return;

      // Get the session's model to check effort support
      const session = get({ subscribe }).find(s => s.id === id);
      // Clamp to a value the target provider actually supports (OpenAI/Codex caps at 'high')
      const effectiveEffort = session && modelSupportsEffort(session.model)
        ? clampEffortForModel(normalizedEffort, session.model)
        : null;

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

      update(sessions => sessions.map(s => s.id === id ? { ...s, cwd, repoId: resolveRepoId(cwd) } : s));
      await syncSessionBranchMetadata(id, cwd);

      if (liveSessions.has(id)) {
        try {
          await invoke('close_sdk_session', { id });
          await registerSessionWithBackend(id, cwd, session.model, session.effortLevel, undefined, undefined, undefined, session.provider, undefined, undefined, session.autocompactEnabled ?? null);
        } catch (error) {
          console.error('[sdkSessions] Failed to reinitialize backend session:', error);
        }
      }
    },

    markAsRead(id: string): void {
      update(sessions => sessions.map(s => s.id === id ? { ...s, unread: false } : s));
    },

    togglePin(id: string): void {
      update(sessions => sessions.map(s => s.id === id ? { ...s, pinned: !s.pinned, pinnedAt: !s.pinned ? Date.now() : undefined } : s));
      debouncedSave(id);
    },

    /**
     * Sync setup-session config back to the store so the session list
     * (and any other store consumers) reflect changes made in SessionSetupView.
     * Only touches sessions that are still in 'setup' status.
     */
    updateSetupConfig(id: string, config: {
      model?: string;
      effortLevel?: EffortLevel;
      cwd?: string;
      setupRepoPath?: string;
      setupWorktreeMode?: 'main' | 'new' | 'existing';
      setupWorktreePath?: string;
      repoId?: string;
      currentBranch?: string | null;
      provider?: SdkProvider;
      accountId?: string;
    }): void {
      update(sessions => sessions.map(s => {
        if (s.id !== id || s.status !== 'setup') return s;
        const updated = { ...s };
        if ('accountId' in config) updated.accountId = config.accountId;
        if (config.model !== undefined) {
          updated.model = config.model;
          updated.provider = normalizeSdkProvider(config.provider ?? s.provider, config.model);
        }
        if (config.effortLevel !== undefined) updated.effortLevel = config.effortLevel;
        if (config.cwd !== undefined) {
          updated.cwd = config.cwd;
          // Explicit repoId takes priority (e.g. worktree cwd won't resolve to a repo)
          updated.repoId = config.repoId ?? resolveRepoId(config.cwd);
        }
        if (config.setupRepoPath !== undefined) updated.setupRepoPath = config.setupRepoPath;
        if (config.setupWorktreeMode !== undefined) updated.setupWorktreeMode = config.setupWorktreeMode;
        if (config.setupWorktreePath !== undefined) updated.setupWorktreePath = config.setupWorktreePath;
        if (config.currentBranch !== undefined) updated.currentBranch = config.currentBranch;
        if (config.provider !== undefined) updated.provider = normalizeSdkProvider(config.provider, updated.model);
        return updated;
      }));
      debouncedSave();
    },

    updateDraft(id: string, draftPrompt?: string, draftImages?: SdkImageContent[]): void {
      const normalizedPrompt = normalizeDraftPrompt(draftPrompt);
      const normalizedImages = normalizeDraftImages(draftImages);
      update(sessions => sessions.map(s => s.id === id ? { ...s, draftPrompt: normalizedPrompt, draftImages: normalizedImages } : s));
      debouncedSave();
    },

    /** Set the PR summary detected for a session's branch (drives header/list badges). */
    setSessionPr(id: string, pr: SessionPrSummary | null): void {
      update(sessions => sessions.map(s => s.id === id ? { ...s, pr } : s));
      debouncedSave();
    },

    /** Persist whether the PR dock panel is open for a session (survives restart). */
    setSessionPrPanelOpen(id: string, open: boolean): void {
      update(sessions => sessions.map(s => s.id === id ? { ...s, prPanelOpen: open } : s));
      debouncedSave(id);
    },

    /** Mirror the latest Validation run summary onto a session (drives header/list badge). */
    setSessionValidation(id: string, validation: SessionValidationSummary | null): void {
      update(sessions => sessions.map(s => s.id === id ? { ...s, validation } : s));
      debouncedSave(id);
    },

    /** Persist the full latest Validation run snapshot onto a session so the whole panel
     *  survives restart. Null clears it (e.g. when a run is dismissed). */
    setSessionValidationRun(id: string, validationRun: PersistedValidationRun | null): void {
      update(sessions => sessions.map(s => s.id === id ? { ...s, validationRun } : s));
      debouncedSave(id);
    },

    clearAiCompletionMetadata(id: string): void {
      update(sessions =>
        sessions.map(s =>
          s.id === id
            ? {
                ...s,
                aiMetadata: clearCompletionMetadata(s.aiMetadata),
              }
            : s
        )
      );
    },

    createSetupSession(model: string, effortLevel: EffortLevel, provider?: SdkProvider, initialCwd: string = ''): string {
      const id = crypto.randomUUID();
      const resolvedProvider = normalizeSdkProvider(provider, model);

      const session: SdkSession = {
        id,
        cwd: initialCwd,
        setupRepoPath: initialCwd,
        setupWorktreeMode: 'main',
        setupWorktreePath: undefined,
        repoId: resolveRepoId(initialCwd),
        model,
        provider: resolvedProvider,
        effortLevel,
        messages: [],
        status: 'setup',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        accumulatedDurationMs: 0,
      };

      update(sessions => [...sessions, session]);
      return id;
    },

    async startSetupSession(id: string, config: { prompt: string; images?: SdkImageContent[]; cwd: string; repoId?: string; model: string; effortLevel: EffortLevel; systemPrompt?: string; provider?: SdkProvider; accountId?: string; createdBranch?: string; worktreePostSetup?: { repoPath: string; copyFiles: string[]; postCreateCommands: string[] }; schedule?: QueueWindow | 'after_sessions' }): Promise<void> {
      const session = get({ subscribe }).find(s => s.id === id);
      if (!session || session.status !== 'setup') return;

      const gatedModel = config.model;
      const gatedProvider = normalizeSdkProvider(config.provider, gatedModel);
      const hasPrompt = config.prompt.trim().length > 0;

      // Smart Queue (first-launch gate): park this session as `queued` instead of launching when
      // either the user explicitly scheduled it for a later window (`config.schedule`, fire-and-forget
      // from the New Session view) or the provider's usage window is currently exhausted. Its prompt
      // is baked onto the prepared fields; the driver later dispatches it via launchPrepared.
      if (hasPrompt && (config.schedule || shouldQueue(gatedProvider, config.accountId))) {
        const finalSystemPrompt = config.systemPrompt;
        const exhaustion = providerExhaustion(gatedProvider, config.accountId);
        const queuedAt = Date.now();
        // Scheduled launches target the user-chosen window boundary; rate-limit queueing targets
        // the current exhausted window's reset time. 'after_sessions' has no time target — it
        // fires when the repo+worktree scope goes idle.
        const isAfterSessions = config.schedule === 'after_sessions';
        const queueReason = isAfterSessions
          ? ('after_sessions' as const)
          : config.schedule
            ? ('scheduled' as const)
            : ('rate_limit' as const);
        const queueWindow = isAfterSessions ? undefined : (config.schedule as QueueWindow | undefined) ?? exhaustion.window;
        const targetStartAt = isAfterSessions
          ? undefined
          : config.schedule
            ? nextWindowResetAt(gatedProvider, config.schedule as QueueWindow, config.accountId)
            : exhaustion.resetsAt;
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? {
                  ...s,
                  cwd: config.cwd,
                  repoId: config.repoId ?? resolveRepoId(config.cwd),
                  model: gatedModel,
                  effortLevel: config.effortLevel,
                  provider: gatedProvider,
                  ...(config.accountId ? { accountId: config.accountId } : {}),
                  status: 'queued' as const,
                  preparedPrompt: config.prompt,
                  preparedSystemPrompt: finalSystemPrompt,
                  draftPrompt: undefined,
                  draftImages: undefined,
                  setupRepoPath: undefined,
                  setupWorktreeMode: undefined,
                  setupWorktreePath: undefined,
                  ...(config.createdBranch ? { createdBranch: config.createdBranch } : {}),
                  queueInfo: { reason: queueReason, provider: gatedProvider, window: queueWindow, queuedAt, targetStartAt },
                }
              : s
          )
        );
        void syncSessionBranchMetadata(id, config.cwd);
        debouncedSave();
        return;
      }

      update(sessions =>
        sessions.map(s =>
          s.id === id
            ? {
                ...s,
                cwd: config.cwd,
                repoId: config.repoId ?? resolveRepoId(config.cwd),
                model: config.model,
                effortLevel: config.effortLevel,
                ...(config.accountId ? { accountId: config.accountId } : {}),
                status: 'initializing' as const,
                // Setup drafts should not carry into the live SDK composer.
                // If they remain on the session while SdkView mounts, the prompt input
                // can briefly hydrate with the setup prompt and then get cleared by
                // sendPrompt(), leaving textarea sizing out of sync.
                draftPrompt: undefined,
                draftImages: undefined,
                setupRepoPath: undefined,
                setupWorktreeMode: undefined,
                setupWorktreePath: undefined,
                // Pre-populate createdBranch from worktree creation so the header shows the correct
                // branch immediately, without waiting for (or being overwritten by) the git query.
                ...(config.createdBranch ? { createdBranch: config.createdBranch } : {}),
              }
            : s
        )
      );

      try {
        const finalSystemPrompt = config.systemPrompt;

        await this.ensureSidecarStarted();

        const unlisteners = await setupEventListeners(id);
        listeners.set(id, unlisteners);

        const finalModel = config.model;
        const finalEffort = config.effortLevel;
        const finalProvider = normalizeSdkProvider(config.provider, finalModel);

        await registerSessionWithBackend(
          id,
          config.cwd,
          finalModel,
          finalEffort,
          finalSystemPrompt,
          null,
          null,
          finalProvider,
          session.forkFromSdkSessionId,
          session.forkAtMessageUuid,
          undefined
        );
        await syncSessionBranchMetadata(id, config.cwd);

        const currentSettings = get(settings);
        const resolvedModel = resolveModelForApi(finalModel, currentSettings.enabled_models);
        usageStats.trackSession('sdk', resolvedModel, config.cwd);

        update(sessions => sessions.map(s => s.id === id ? { ...s, status: 'idle' as const } : s));

        if (config.worktreePostSetup) {
          const { repoPath, copyFiles, postCreateCommands } = config.worktreePostSetup;
          const totalSteps = copyFiles.length + postCreateCommands.length;
          if (totalSteps > 0) {
            let tsCounter = Date.now();
            const appendMsg = (msg: SdkMessage) => update(sessions => sessions.map(s => s.id === id ? { ...s, messages: [...s.messages, msg] } : s));
            appendMsg({ type: 'notification', content: `Setting up worktree (${totalSteps} step${totalSteps > 1 ? 's' : ''})...`, timestamp: tsCounter++ });
            try {
              const results = await invoke<{ description: string; success: boolean; output: string | null }[]>('run_worktree_post_setup', {
                repoPath, worktreePath: config.cwd, copyFiles, postCreateCommands,
              });
              for (const r of results) {
                const icon = r.success ? '✓' : '✗';
                const msg = r.output ? `${icon} ${r.description}: ${r.output}` : `${icon} ${r.description}`;
                appendMsg({ type: 'notification', content: msg, timestamp: tsCounter++ });
              }
            } catch (err) {
              appendMsg({ type: 'error', content: `Worktree post-setup failed: ${err}`, timestamp: tsCounter++ });
            }
          }
        }

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
      panes.clearSession(id);
    },

    createPendingTranscriptionSession(model: string, effortLevel: EffortLevel, provider?: SdkProvider): string {
      const id = crypto.randomUUID();
      const resolvedProvider = normalizeSdkProvider(provider, model);

      const session: SdkSession = {
        id,
        cwd: '',
        model,
        provider: resolvedProvider,
        effortLevel: modelSupportsEffort(model) ? effortLevel : null,
        messages: [],
        status: 'pending_transcription',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
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

    /** Attach a failed follow-up recording to a live session (retriable in place). */
    setFailedRecording(id: string, info: FailedRecording): void {
      update(sessions =>
        sessions.map(s => (s.id === id ? { ...s, failedRecording: info } : s))
      );
    },

    /** Clear a session's failed follow-up recording (after retry success or discard). */
    clearFailedRecording(id: string): void {
      update(sessions =>
        sessions.map(s => (s.id === id ? { ...s, failedRecording: undefined } : s))
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
          sessions.map(s => s.id === id ? { ...s, cwd, repoId: resolveRepoId(cwd), status: 'initializing' as const, pendingPrompt: transcript } : s)
        );
        await syncSessionBranchMetadata(id, cwd);

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
      panes.clearSession(id);
    },

    async launchPrepared(id: string, editedPrompt?: string): Promise<void> {
      let session: SdkSession | undefined;
      subscribe(sessions => { session = sessions.find(s => s.id === id); })();

      // Accept both a normal prepared session and a queued one (rate-limit or scheduled): the
      // Smart Queue driver dispatches queued sessions through this same path.
      if (!session || (session.status !== 'prepared' && session.status !== 'queued')) return;

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
          queueInfo: null,
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

    /**
     * Turn an in-flight `pending_transcription` session into an editable `setup` draft: the
     * transcript becomes the setup-view prompt draft and the session opens in the New Session
     * view with full controls (model/effort/repo/worktree/schedule). Any recording screenshots
     * are carried over as draft images. This is the "prepare"/draft entry point for voice and
     * selection recordings (replacing the old prepared-session panel).
     */
    setupFromPending(id: string, config: { prompt: string; cwd: string; images?: SdkImageContent[] }): void {
      update(sessions =>
        sessions.map(s => {
          if (s.id !== id) return s;
          const carriedImages = (config.images && config.images.length > 0)
            ? config.images
            : s.pendingTranscription?.screenshots;
          return {
            ...s,
            status: 'setup' as const,
            cwd: config.cwd,
            setupRepoPath: config.cwd || undefined,
            setupWorktreeMode: s.setupWorktreeMode ?? 'main',
            repoId: config.cwd ? resolveRepoId(config.cwd) : s.repoId,
            draftPrompt: config.prompt,
            draftImages: carriedImages && carriedImages.length > 0 ? carriedImages : undefined,
            pendingTranscription: undefined,
          };
        })
      );
      if (config.cwd) void syncSessionBranchMetadata(id, config.cwd);
      debouncedSave();
    },

    createPendingRepoSession(model: string, effortLevel: EffortLevel, pendingRepoSelection: PendingRepoSelection, provider?: SdkProvider): string {
      const id = crypto.randomUUID();
      const resolvedProvider = normalizeSdkProvider(provider, model);

      const session: SdkSession = {
        id,
        cwd: '',
        model,
        provider: resolvedProvider,
        effortLevel,
        messages: [],
        status: 'pending_repo',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
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
      const resolvedProvider = normalizeSdkProvider(provider, model);

      const session: SdkSession = {
        id,
        cwd,
        repoId: resolveRepoId(cwd),
        model,
        provider: resolvedProvider,
        effortLevel,
        messages: [],
        status: 'initializing',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        accumulatedDurationMs: 0,
        pendingPrompt,
      };

      update(sessions => [...sessions, session]);
      void syncSessionBranchMetadata(id, cwd);
      return id;
    },

    async completeRepoSelection(id: string, cwd: string, systemPrompt?: string, cleanedTranscript?: string): Promise<void> {
      let session: SdkSession | undefined;
      subscribe(sessions => { session = sessions.find(s => s.id === id); })();

      if (!session || session.status !== 'pending_repo') return;

      const pendingPrompt = cleanedTranscript || session.pendingPrompt;

      update(sessions =>
        sessions.map(s => s.id === id ? { ...s, cwd, repoId: resolveRepoId(cwd), status: 'initializing' as const, pendingRepoSelection: undefined, pendingPrompt } : s)
      );
      await syncSessionBranchMetadata(id, cwd);

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
      const sessionForInit = get({ subscribe }).find(s => s.id === id);
      const sessionProvider = provider ?? sessionForInit?.provider ?? getProviderForModel(model);
      const sessionAccountId = sessionForInit?.accountId;

      // Smart Queue (first-launch gate): only a prompt-bearing launch consumes the rate limit, so
      // only defer when there is a pending prompt. Park as `queued` (prompt on prepared fields) so
      // launchPrepared can dispatch it later, then return before registering/sending.
      if (pendingPrompt && pendingPrompt.trim().length > 0 && shouldQueue(sessionProvider, sessionAccountId)) {
        const { window: rlWindow, resetsAt } = providerExhaustion(sessionProvider, sessionAccountId);
        const queuedAt = Date.now();
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? {
                  ...s,
                  cwd,
                  repoId: resolveRepoId(cwd),
                  model,
                  effortLevel,
                  provider: sessionProvider,
                  status: 'queued' as const,
                  preparedPrompt: pendingPrompt,
                  preparedSystemPrompt: systemPrompt,
                  pendingPrompt: undefined,
                  queueInfo: { reason: 'rate_limit' as const, provider: sessionProvider, window: rlWindow, queuedAt, targetStartAt: resetsAt },
                }
              : s
          )
        );
        void syncSessionBranchMetadata(id, cwd);
        debouncedSave();
        return;
      }

      await this.ensureSidecarStarted();

      const unlisteners = await setupEventListeners(id);
      listeners.set(id, unlisteners);

      const currentSettings = get(settings);
      const resolvedModel = resolveModelForApi(model, currentSettings.enabled_models);
      if (resolvedModel !== model) {
        update(sessions => sessions.map(s => s.id === id ? { ...s, model: resolvedModel } : s));
      }

      await registerSessionWithBackend(id, cwd, resolvedModel, effortLevel, systemPrompt, undefined, undefined, provider);
      await syncSessionBranchMetadata(id, cwd);
      usageStats.trackSession('sdk', resolvedModel, cwd);

      if (pendingPrompt) {
        await this.sendPrompt(id, pendingPrompt);
      } else {
        update(sessions => sessions.map(s => s.id === id ? { ...s, status: 'idle' as const, pendingPrompt: undefined } : s));
      }
    },

    /**
     * Smart Queue ("Send on next reset"): from a live/active session, queue a follow-up turn to
     * fire on the next 5h/7d window reset instead of sending it now. Pushes the user message to the
     * transcript (so the queued turn is visible, like a normal send) but does NOT invoke the backend;
     * the turn is parked in `rateLimited` with reason 'scheduled'. The driver re-sends it at the
     * window boundary via `continueRateLimited` (which is prompt-agnostic and handles it unchanged).
     */
    async queueTurnForWindow(id: string, prompt: string, images: SdkImageContent[] | undefined, window: QueueWindow, action?: 'compact'): Promise<void> {
      let session: SdkSession | undefined;
      subscribe(sessions => { session = sessions.find(s => s.id === id); })();
      if (!session) return;

      const provider = session.provider ?? getProviderForModel(session.model);
      const targetStartAt = nextWindowResetAt(provider, window, session.accountId);
      const now = Date.now();

      update(sessions =>
        sessions.map(s =>
          s.id === id
            ? {
                ...s,
                // Keep the session out of an active/error state — the turn is deferred, not running.
                status: s.status === 'querying' ? ('idle' as const) : s.status,
                lastActivityAt: now,
                messages: [...s.messages, { type: 'user' as const, content: prompt, images, queued: 'reset_5h' as const, timestamp: now }],
                draftPrompt: undefined,
                draftImages: undefined,
                rateLimited: {
                  reason: 'scheduled' as const,
                  provider,
                  window,
                  targetStartAt,
                  resetsAt: targetStartAt,
                  prompt,
                  images,
                  action,
                  queuedAt: now,
                },
              }
            : s
        )
      );
      debouncedSave();
    },

    /**
     * Smart Queue ("Send when repo is idle" / "Send when this session is idle"): from a live
     * session, park a follow-up turn until the waited-on scope goes idle — for 'worktree' that's
     * every session in the same repo+worktree (same cwd) including this one; for 'session' just
     * this session's own running query. If already idle, this is just a normal send. Unlike
     * queueTurnForWindow, the session's own status is left untouched: a still-running query on
     * this session keeps the scope busy, so the parked turn fires right after it completes
     * instead of interrupting it.
     */
    async queueTurnAfterSessions(id: string, prompt: string, images?: SdkImageContent[], scope: AfterSessionsScope = 'worktree', action?: 'compact'): Promise<void> {
      const sessions = get({ subscribe });
      const session = sessions.find(s => s.id === id);
      if (!session) return;

      // Nothing to wait for (own session included) — run immediately.
      if (
        (scope === 'session' || !hasBusySessionsInScope(sessions, session.cwd, id)) &&
        session.status !== 'querying' &&
        session.status !== 'initializing'
      ) {
        if (action === 'compact') await this.compactSession(id);
        else await this.sendPrompt(id, prompt, images);
        return;
      }

      const provider = session.provider ?? getProviderForModel(session.model);
      const now = Date.now();
      update(list =>
        list.map(s =>
          s.id === id
            ? {
                ...s,
                lastActivityAt: now,
                messages: [...s.messages, { type: 'user' as const, content: prompt, images, queued: scope === 'session' ? ('session_idle' as const) : ('repo_idle' as const), timestamp: now }],
                draftPrompt: undefined,
                draftImages: undefined,
                rateLimited: {
                  reason: 'after_sessions' as const,
                  provider,
                  scope,
                  prompt,
                  images,
                  action,
                  queuedAt: now,
                },
              }
            : s
        )
      );
      debouncedSave();
    },

    /**
     * Smart Queue: re-send a `rateLimited` pending turn WITHOUT duplicating the user message
     * (it's already in the transcript). Used by the "Continue now" button and the drain driver.
     * Re-stashes the in-flight turn so a fresh mid-run rejection can recover it. If the provider
     * is still exhausted, the query will be rejected again and re-parked in `rateLimited`.
     */
    async continueRateLimited(id: string): Promise<void> {
      let session: SdkSession | undefined;
      subscribe(sessions => { session = sessions.find(s => s.id === id); })();
      if (!session || !session.rateLimited) return;
      const rl = session.rateLimited;

      await this.ensureSessionLive(id);

      // A parked compaction fires through the provider-correct compact path
      // (Codex uses a dedicated RPC), not as a text turn. Drop the ghost flag so
      // the "/compact" marker renders as a normal turn, then delegate.
      if (rl.action === 'compact') {
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? {
                  ...s,
                  rateLimited: null,
                  messages: releaseQueuedToEnd(s.messages),
                }
              : s
          )
        );
        // compactSession pushes its own "/compact" marker for Codex; for Claude
        // it sends the slash command as a turn. Either way the ghost we just
        // un-flagged stands in, so route through the raw provider action here.
        const provider = rl.provider;
        if (provider === 'openai') {
          update(sessions => sessions.map(s => s.id === id ? { ...s, status: 'querying' as const, lastActivityAt: Date.now() } : s));
          try {
            await invoke('compact_sdk_session', { id });
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
        } else {
          // Claude: '/compact' is a valid slash command sent as a normal turn.
          update(sessions => sessions.map(s => s.id === id ? { ...s, status: 'querying' as const, lastActivityAt: Date.now(), inFlightPrompt: '/compact', inFlightImages: null } : s));
          try {
            await invoke('send_sdk_prompt', { id, prompt: '/compact', images: null });
          } catch (error) {
            update(sessions =>
              sessions.map(s =>
                s.id === id
                  ? { ...s, status: 'error' as const, inFlightPrompt: null, inFlightImages: null, messages: [...s.messages, { type: 'error' as const, content: String(error), timestamp: Date.now() }] }
                  : s
              )
            );
            throw error;
          }
        }
        return;
      }

      update(sessions =>
        sessions.map(s =>
          s.id === id
            ? {
                ...s,
                status: 'querying' as const,
                lastActivityAt: Date.now(),
                rateLimited: null,
                // The parked ghost turn is now sending — drop the queued flag AND
                // move it to the end with a fresh timestamp. While parked it was
                // pinned to the bottom of the transcript, but in the array it can be
                // buried mid-stream (streamed assistant text/tools appended after it
                // while the scope stayed busy). buildRenderItems orders by array
                // position, so re-appending keeps it at the bottom where the user
                // last saw it instead of snapping back to its original slot.
                messages: releaseQueuedToEnd(s.messages),
                inFlightPrompt: rl.prompt,
                inFlightImages: rl.images ?? null,
              }
            : s
        )
      );

      try {
        await invoke('send_sdk_prompt', { id, prompt: rl.prompt, images: rl.images ?? null });
      } catch (error) {
        update(sessions =>
          sessions.map(s =>
            s.id === id
              ? { ...s, status: 'error' as const, inFlightPrompt: null, inFlightImages: null, messages: [...s.messages, { type: 'error' as const, content: String(error), timestamp: Date.now() }] }
              : s
          )
        );
        throw error;
      }
    },

    /**
     * Smart Queue: cancel a parked `rateLimited` pending turn.
     * - For a user-deferred turn (`reason === 'scheduled'` or `'after_sessions'`), the user
     *   message was pushed but never sent — remove it, but ONLY when it's the trailing message
     *   AND its text matches the cleared prompt (so a real turn is never deleted).
     * - For a rate-limit turn (`reason === 'rate_limit'`, a real turn that got rejected mid-run),
     *   leave the transcript untouched — just clear `rateLimited`.
     */
    clearRateLimited(id: string): void {
      update(sessions =>
        sessions.map(s => {
          if (s.id !== id || !s.rateLimited) return s;
          const rl = s.rateLimited;
          let messages = s.messages;
          if (rl.reason !== 'rate_limit') {
            // Drop the parked ghost bubble. It carries a `queued` flag and may be
            // buried mid-transcript (a still-running turn keeps appending after it),
            // so remove by flag rather than assuming it's the trailing message. Fall
            // back to the legacy trailing prompt-match for pre-flag persisted turns.
            if (messages.some(m => m.queued)) {
              messages = messages.filter(m => !m.queued);
            } else {
              const last = messages[messages.length - 1];
              if (last && last.type === 'user' && last.content === rl.prompt) {
                messages = messages.slice(0, -1);
              }
            }
          }
          return { ...s, rateLimited: null, messages };
        })
      );
      debouncedSave();
    },

    /**
     * Smart Queue "Remove from queue": revert ANY `queued` session (scheduled OR rate-limit) back
     * to an editable `setup` draft, clearing queueInfo. The baked prompt is restored as the
     * setup-view draft prompt so the user lands back in the New Session view to edit or re-launch.
     */
    unschedule(id: string): void {
      update(sessions =>
        sessions.map(s => {
          if (s.id !== id || s.status !== 'queued') return s;
          return {
            ...s,
            status: 'setup' as const,
            draftPrompt: s.preparedPrompt ?? s.draftPrompt,
            setupRepoPath: s.cwd || s.setupRepoPath,
            setupWorktreeMode: s.setupWorktreeMode ?? 'main',
            preparedPrompt: undefined,
            preparedSystemPrompt: undefined,
            preparedRepoRecommendation: undefined,
            queueInfo: null,
          };
        })
      );
      debouncedSave();
    },

    updateStatus(id: string, status: SdkSession['status']): void {
      update(sessions => sessions.map(s => s.id === id ? { ...s, status } : s));
    },

    async refreshSessionBranch(id: string): Promise<void> {
      const session = get({ subscribe }).find(s => s.id === id);
      if (!session) return;
      await syncSessionBranchMetadata(id, session.cwd);
    },

    // AskUserQuestion methods
    updateAskUserAnswer(id: string, answer: PlanningAnswer): void {
      update(sessions =>
        sessions.map(s => {
          if (s.id !== id || !s.askUserQuestion) return s;
          const existingIndex = s.askUserQuestion.answers.findIndex(
            a => a.questionIndex === answer.questionIndex
          );
          const newAnswers = [...s.askUserQuestion.answers];
          if (existingIndex >= 0) {
            newAnswers[existingIndex] = answer;
          } else {
            newAnswers.push(answer);
          }
          return { ...s, askUserQuestion: { ...s.askUserQuestion, answers: newAnswers } };
        })
      );
    },

    setAskUserQuestionIndex(id: string, index: number): void {
      update(sessions =>
        sessions.map(s => {
          if (s.id !== id || !s.askUserQuestion) return s;
          return {
            ...s,
            askUserQuestion: {
              ...s.askUserQuestion,
              currentQuestionIndex: Math.max(0, Math.min(index, s.askUserQuestion.questions.length - 1)),
            },
          };
        })
      );
    },

    async submitAskUserAnswers(id: string): Promise<void> {
      let session: SdkSession | undefined;
      subscribe(sessions => { session = sessions.find(s => s.id === id); })();

      if (!session?.askUserQuestion) throw new Error('No pending AskUserQuestion');

      // Build answers map: question text -> selected label(s), per SDK AskUserQuestionOutput format
      const answers: Record<string, string> = {};
      for (const answer of session.askUserQuestion.answers) {
        const question = session.askUserQuestion.questions[answer.questionIndex];
        if (!question) continue;

        const parts: string[] = [];
        for (const optIdx of answer.selectedOptions) {
          const opt = question.options[optIdx];
          if (opt) parts.push(opt.label);
        }
        if (answer.textInput) {
          parts.push(answer.textInput);
        }
        answers[question.question] = parts.join(', ');
      }

      this.clearAskUserQuestion(id);
      // Send answers to sidecar via Tauri command (resolves the pending canUseTool callback)
      await invoke('answer_ask_user_question', { id, answers });
    },

    clearAskUserQuestion(id: string): void {
      update(sessions =>
        sessions.map(s => {
          if (s.id !== id) return s;
          return { ...s, askUserQuestion: undefined };
        })
      );
    },

    // --- Plan Approval (ExitPlanMode interception) ---

    async approvePlan(id: string, feedback?: string): Promise<void> {
      console.log(`[sdkSessions] Approving plan (session: ${id}, feedback: ${feedback ? 'yes' : 'no'})`);
      this.clearPlanApproval(id);
      await invoke('answer_plan_approval', { id, action: 'approve', feedback: feedback ?? null });
    },

    async approvePlanNewSession(id: string): Promise<void> {
      let session: SdkSession | undefined;
      subscribe(sessions => { session = sessions.find(s => s.id === id); })();

      this.clearPlanApproval(id);
      // Allow ExitPlanMode so the planning session completes cleanly
      await invoke('answer_plan_approval', { id, action: 'approve_new_session', feedback: null });

      // Mark planning session as done
      update(sessions => sessions.map(s =>
        s.id === id ? { ...s, status: 'done' as const } : s
      ));

      if (!session) return;

      // Spawn a fresh session in the same workspace and ask Claude to implement
      // whatever plan it wrote during the planning conversation.
      const implementationId = await this.createSession(session.cwd, session.model, session.effortLevel);
      const fallbackPrompt = `The previous planning session just finished. Please review any plan files or notes created during planning (e.g. PLAN.md, TODO.md, or any file written during the last session), then implement the plan step by step.\n\nFocus on quality and maintainability. Ask if any requirements are unclear.`;
      await this.sendPrompt(implementationId, fallbackPrompt);
    },

    async denyPlan(id: string, feedback: string): Promise<void> {
      console.log(`[sdkSessions] Denying plan (session: ${id})`);
      this.clearPlanApproval(id);
      await invoke('answer_plan_approval', { id, action: 'deny', feedback });
    },

    clearPlanApproval(id: string): void {
      console.log(`[sdkSessions] Clearing plan approval (session: ${id})`);
      update(sessions => sessions.map(s => {
        if (s.id !== id) return s;
        return { ...s, pendingPlanApproval: undefined };
      }));
    },

    selectSession(id: string): void {
      activeSdkSessionId.set(id);
    },

    clearSelection(): void {
      activeSdkSessionId.set(null);
    },
  };

  return storeApi;
}

export const activeSdkSessionId = {
  subscribe: focusedPaneSessionId.subscribe,
  set: (id: string | null) => panes.assignToFocusedPane(id),
};

export const sdkSessions = createSdkSessionsStore();

export const activeSdkSession = derived(
  [sdkSessions, activeSdkSessionId],
  ([$sdkSessions, $activeSdkSessionId]) => {
    return $sdkSessions.find(s => s.id === $activeSdkSessionId) || null;
  }
);

// Most-recently-active-first stack of session ids the user has viewed. Lets a
// close fall back to the session viewed before the one being closed (MRU),
// rather than dropping the user on an empty view or the next list item.
const activationHistory: string[] = [];
activeSdkSessionId.subscribe(id => {
  if (!id) return;
  const existing = activationHistory.indexOf(id);
  if (existing !== -1) activationHistory.splice(existing, 1);
  activationHistory.unshift(id);
});

/**
 * The session to activate after closing `closedId`: the most recently active
 * session that still exists and isn't the one being closed. Returns null when
 * there's no prior session to fall back to. Call this *before* closing the
 * session, while it (and its history entry) still exist.
 */
export function previousActiveSessionId(closedId: string): string | null {
  const live = new Set(get(sdkSessions).map(s => s.id));
  for (const id of activationHistory) {
    if (id !== closedId && live.has(id)) return id;
  }
  return null;
}

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
