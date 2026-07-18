import {
  query,
  createSdkMcpServer,
  tool,
  type Query,
  type Options,
  type SDKMessage,
  type SubagentStartHookInput,
  type SubagentStopHookInput,
  type PreToolUseHookInput,
  type HookCallback,
} from "@anthropic-ai/claude-agent-sdk";
import {
  Codex,
  type ThreadEvent,
  type Thread,
  type ThreadOptions,
} from "@openai/codex-sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as readline from "readline";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";

const OPENAI_MODEL_FALLBACK = "gpt-5.6-terra";

function inferOpenAiContextWindow(model: string | undefined): number {
  const normalized = model?.toLowerCase() ?? "";
  // GPT-5.6 family (Sol/Terra/Luna) has a 1M context window.
  if (normalized.includes("gpt-5.6")) {
    return 1000000;
  }
  // Older GPT-5 family models use 400k context windows.
  if (normalized.includes("gpt-5")) {
    return 400000;
  }
  return 200000;
}

function inferClaudeContextWindow(model: string | undefined): number {
  const normalized = model?.toLowerCase() ?? "";
  if (
    normalized.startsWith("claude-fable-5") ||
    normalized.startsWith("claude-opus-4-8") ||
    normalized.startsWith("claude-opus-4-7") ||
    normalized.startsWith("claude-opus-4-6") ||
    normalized.startsWith("claude-sonnet-5")
  ) {
    return 1000000;
  }
  return 200000;
}

function inferProvider(
  provider: string | undefined,
  model: string | undefined
): "claude" | "openai" {
  const normalizedModel = model?.toLowerCase() ?? "";
  const modelProvider: "claude" | "openai" =
    normalizedModel.startsWith("gpt-") || normalizedModel.startsWith("codex")
      ? "openai"
      : "claude";

  const normalizedProvider = provider?.toLowerCase();
  if (normalizedProvider === "openai" || normalizedProvider === "claude") {
    return normalizedProvider === modelProvider
      ? (normalizedProvider as "claude" | "openai")
      : modelProvider;
  }

  return modelProvider;
}

function isUnsupportedChatGptAccountModelError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes("model is not supported") &&
    normalized.includes("chatgpt account")
  );
}

// Repo description result schema
const RepoDescriptionResultSchema = z.object({
  description: z
    .string()
    .describe("A concise 1-2 sentence description of the repository"),
  keywords: z
    .array(z.string())
    .describe("~20 categorical/conceptual keywords for matching user intent"),
  vocabulary: z
    .array(z.string())
    .describe("20-50 project-specific terms/jargon from the codebase"),
  icon: z
    .string()
    .optional()
    .describe("Icon key from the curated set that best represents the project"),
  color: z
    .string()
    .nullable()
    .optional()
    .describe("Primary brand color as hex string (e.g. '#6366f1'), or null if none found"),
});

// Pending repo description results (requestId -> result)
const pendingRepoDescriptions = new Map<
  string,
  z.infer<typeof RepoDescriptionResultSchema>
>();

// Create the in-process repo description MCP server
const repoDescriptionMcpServer = createSdkMcpServer({
  name: "repo-description-tools",
  version: "1.0.0",
  tools: [
    tool(
      "submit_repo_description",
      "Submit the generated repository description. You MUST call this tool with your analysis after exploring the codebase. This is required to complete the task.",
      {
        description: z
          .string()
          .describe(
            "A concise 1-2 sentence description of what the project does and its main technologies"
          ),
        keywords: z
          .array(z.string())
          .min(10)
          .max(60)
          .describe(
            "Categorical/conceptual terms for matching user intent (20-50 words): technology categories, domain concepts, feature types, action verbs"
          ),
        vocabulary: z
          .array(z.string())
          .min(15)
          .max(60)
          .describe(
            "Project-specific lingo/jargon from the codebase (20-50 words): function/class names, file names, custom types, abbreviations, framework terms"
          ),
        icon: z
          .string()
          .describe(
            "Icon key from this set that best represents the project: globe, browser, layout, paint-brush, palette, server, cloud, api, router, shield, smartphone, tablet, terminal, command-line, database, table, storage, brain, sparkles, cpu, package, puzzle, cube, book, document, pencil, flask, check-circle, bug, monitor, window, desktop, gamepad, play, chart-bar, chart-line, pie-chart, chat, mail, notification, camera, video, music, microphone, shopping-cart, credit-card, tag, lock, key, fingerprint, folder, file, archive, cloud-upload, git-branch, merge, fork, rocket, lightning, wrench, cog, heart, star, zap, code, brackets, hash, robot, users, earth"
          ),
        color: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Primary brand color as hex string (e.g. '#6366f1') found in README, package.json, CSS, config files. Set to null if no brand color found."
          ),
      },
      async (args) => {
        // Store the result - it will be picked up by the handler
        return {
          content: [
            {
              type: "text",
              text: "Repository description submitted successfully.",
            },
          ],
        };
      }
    ),
  ],
});

// Create the in-process launch profile MCP server
const launchProfileMcpServer = createSdkMcpServer({
  name: "launch-profile-tools",
  version: "1.0.0",
  tools: [
    tool(
      "submit_launch_profile",
      "Submit the discovered launch commands and profiles. You MUST call this tool after analyzing the repository. Each command is a runnable service/script. Profiles group commands into logical launch sets.",
      {
        commands: z
          .array(
            z.object({
              name: z
                .string()
                .describe(
                  "Short display name for the command (e.g., 'Frontend Dev', 'API Server', 'Database')"
                ),
              command: z
                .string()
                .describe(
                  "Shell command to run (e.g., 'npm run dev', 'docker compose up db')"
                ),
              working_dir: z
                .string()
                .optional()
                .describe(
                  "Relative path from repo root if the command must run in a subdirectory (e.g., 'frontend', 'packages/api'). Omit for repo root."
                ),
            })
          )
          .min(1)
          .max(20)
          .describe(
            "List of runnable commands/services found in the repository"
          ),
        profiles: z
          .array(
            z.object({
              name: z
                .string()
                .describe(
                  "Profile name (e.g., 'Full Stack', 'Frontend Only', 'API + DB')"
                ),
              command_names: z
                .array(z.string())
                .describe(
                  "Names of commands to include (must match the 'name' field in commands)"
                ),
            })
          )
          .min(1)
          .max(10)
          .describe(
            "Logical groupings of commands into launch profiles"
          ),
      },
      async (args) => {
        return {
          content: [
            {
              type: "text",
              text: "Launch profile submitted successfully.",
            },
          ],
        };
      }
    ),
  ],
});

// Message types for conversation history restoration
interface HistoryUserMessage {
  type: "user";
  content: string;
}

interface HistoryAssistantMessage {
  type: "assistant";
  content: string;
}

interface HistoryToolUseMessage {
  type: "tool_use";
  tool: string;
  input: unknown;
}

interface HistoryToolResultMessage {
  type: "tool_result";
  tool: string;
  output: string;
}

type HistoryMessage =
  | HistoryUserMessage
  | HistoryAssistantMessage
  | HistoryToolUseMessage
  | HistoryToolResultMessage;

// MCP Server configuration types
interface McpServerConfig {
  id: string;
  name: string;
  server_type: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
  /** Authentication type for HTTP/SSE servers */
  auth_type?: "none" | "bearer_token" | "oauth";
  /** Custom headers for HTTP/SSE servers (includes Authorization header at runtime) */
  headers?: Record<string, string>;
}

// Types for IPC messages
interface CreateMessage {
  type: "create";
  id: string;
  cwd: string;
  model?: string;
  provider?: "claude" | "openai"; // SDK provider (default: "claude")
  codex_mode?: "Sdk" | "AppServer"; // OpenAI execution mode
  system_prompt?: string;
  messages?: HistoryMessage[]; // Conversation history for restored sessions (DEPRECATED - use sdk_session_id instead)
  sdk_session_id?: string; // SDK session ID for proper resume (preferred over messages)
  options?: Partial<Options>;
  mcp_servers?: McpServerConfig[]; // External MCP servers to register
  fork_from_sdk_session_id?: string; // SDK session ID to fork from
  fork_at_message_uuid?: string; // Message UUID to fork at (resumeSessionAt)
  autocompact_pct?: number; // Claude-only: 0 = DISABLE_AUTO_COMPACT=1; 1-99 = CLAUDE_AUTOCOMPACT_PCT_OVERRIDE; null/undefined/100 = Claude default
  env?: Record<string, string>; // Extra env vars for the session's agent process (e.g., GH_TOKEN to pin a gh account per repo)
}

interface ImageData {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  base64Data: string;
  width?: number;
  height?: number;
}

interface QueryMessage {
  type: "query";
  id: string;
  prompt: string;
  images?: ImageData[];
}

interface CloseMessage {
  type: "close";
  id: string;
}

interface StopMessage {
  type: "stop";
  id: string;
}

interface UpdateModelMessage {
  type: "update_model";
  id: string;
  model: string;
}

interface UpdateEffortMessage {
  type: "update_effort";
  id: string;
  // Effort level: null, 'low', 'medium', 'high', 'xhigh', 'max'.
  // The Claude SDK accepts the full range natively; OpenAI clamps per model
  // (GPT-5.6 caps at 'xhigh', older Codex models at 'high').
  effortLevel: string | null;
}

/**
 * Map a UI-level effort value to what the underlying SDK actually accepts.
 *
 * - Claude Agent SDK natively supports: 'low' | 'medium' | 'high' | 'xhigh' |
 *   'max' (EffortLevel), and it handles its own fallback for models that don't
 *   support a given level ('xhigh' -> 'high'). So every level passes through.
 * - Codex / OpenAI: ModelReasoningEffort caps at 'xhigh'. The GPT-5.6 family
 *   accepts up to 'xhigh' ('max' is clamped to 'xhigh'); older models only
 *   accept 'low' | 'medium' | 'high' ('xhigh'/'max' clamped to 'high').
 * - `null` / `undefined` are passed through unchanged (effort off).
 */
function mapEffortForProvider(
  effort: string | null | undefined,
  provider: "claude" | "openai",
  model?: string
): string | undefined {
  if (!effort) return undefined;
  if (provider === "openai") {
    const supportsXhigh = (model ?? "").toLowerCase().includes("gpt-5.6");
    if (effort === "max") return supportsXhigh ? "xhigh" : "high";
    if (effort === "xhigh" && !supportsXhigh) return "high";
    return effort;
  }
  // Claude provider: SDK accepts the full EffortLevel range natively.
  return effort;
}

// Generate repository description using Claude SDK
interface GenerateRepoDescriptionMessage {
  type: "generate_repo_description";
  id: string; // Request ID for tracking
  repo_path: string; // Path to the repository
  repo_name: string; // Name of the repository
}

// Generate repository description using Codex SDK
interface GenerateRepoDescriptionWithCodexMessage {
  type: "generate_repo_description_with_codex";
  id: string; // Request ID for tracking
  repo_path: string; // Path to the repository
  repo_name: string; // Name of the repository
}

// Generate launch profile using Claude SDK
interface GenerateLaunchProfileMessage {
  type: "generate_launch_profile";
  id: string;
  repo_path: string;
  repo_name: string;
}

// Generate launch profile using Codex SDK
interface GenerateLaunchProfileWithCodexMessage {
  type: "generate_launch_profile_with_codex";
  id: string;
  repo_path: string;
  repo_name: string;
}

// User's answers to AskUserQuestion tool (from frontend via Rust)
interface AnswerAskUserQuestionMessage {
  type: "answer_ask_user_question";
  id: string; // Session ID
  answers: Record<string, string>; // Map of question text -> selected answer(s)
}

// User's decision on ExitPlanMode plan approval (from frontend via Rust)
interface AnswerPlanApprovalMessage {
  type: "answer_plan_approval";
  id: string; // Session ID
  action: string; // "approve" | "approve_new_session" | "deny"
  feedback?: string; // Feedback text for deny
}

// One-shot Validation pipeline agent (review/verify/evidence/docs/lint).
// Claude provider only. Runs a restricted, read-only-ish query() that must
// finish by calling a single role-specific submit tool (structured output).
type ValidationRole = "review" | "verify" | "evidence" | "docs" | "lint";
interface ValidationAgentMessage {
  type: "validation_agent";
  id: string; // Request ID for tracking (matches the emitted event suffix)
  cwd: string; // Working directory (session cwd)
  role: ValidationRole;
  prompt: string; // Fully-composed prompt (built in Rust)
  model: string; // Claude model id
  effort?: string; // UI effort level ('low'|'medium'|'high'|'xhigh'|'max'); omit/undefined = off
  resumeSessionId?: string; // SDK session id to resume (durable reviewer across rounds)
}

type InboundMessage =
  | CreateMessage
  | QueryMessage
  | CloseMessage
  | StopMessage
  | UpdateModelMessage
  | UpdateEffortMessage
  | GenerateRepoDescriptionMessage
  | GenerateRepoDescriptionWithCodexMessage
  | GenerateLaunchProfileMessage
  | GenerateLaunchProfileWithCodexMessage
  | AnswerAskUserQuestionMessage
  | AnswerPlanApprovalMessage
  | ValidationAgentMessage;

type OpenAiExecutionMode = "sdk" | "app_server";

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

interface AppServerState {
  process: ChildProcessWithoutNullStreams;
  rl: readline.Interface;
  nextRequestId: number;
  pendingRequests: Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >;
  pendingTurns: Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
    }
  >;
  completedTurns: Map<
    string,
    {
      status: string;
      errorMessage?: string;
    }
  >;
  initialized: boolean;
}

interface Session {
  cwd: string;
  provider: "claude" | "openai"; // SDK provider
  openaiMode?: OpenAiExecutionMode; // OpenAI execution mode (SDK vs app-server)
  options: Options;
  abortController?: AbortController;
  queryIterator?: Query; // The active query iterator for interrupt() (Claude only)
  sdkSessionId?: string; // Track the SDK's internal session ID for resume
  passedSdkSessionId?: string; // SDK session ID passed from frontend for restored sessions
  conversationHistory?: HistoryMessage[]; // Conversation history for restored sessions (DEPRECATED)
  effortLevel?: string; // UI effort level: null/undefined = off, 'low', 'medium', 'high', 'xhigh', 'max'
  currentQueryId?: string; // Unique ID for the current query (to detect stale done events)
  // OpenAI Codex-specific fields
  codexThread?: Thread; // Active Codex thread instance
  codexModel?: string; // OpenAI model to use
  codexSystemPrompt?: string; // System prompt to prepend to first Codex query (since ThreadOptions has no systemPrompt)
  appServer?: AppServerState; // Active Codex app-server process state
  extraEnv?: Record<string, string>; // Per-session extra env vars (e.g., GH_TOKEN) applied to spawned agent processes
  appServerTurnId?: string; // Active app-server turn ID
  pendingParallelNotification?: string; // Queued notification to inject via PreToolUse hook when parallel session detected
  claudeQueue: QueuedPrompt[]; // Pending Claude prompts (FIFO)
  claudeProcessing: boolean; // Claude queue worker active flag
  // True between the start and end of handleStop. Ensures handleQuery running
  // concurrently with stop takes the queue path instead of stream-injecting
  // into an iterator that is being torn down (which can silently drop the msg).
  claudeStopping?: boolean;
  lastAssistantTurnUuid?: string; // Last assistant message UUID for fork support
  forkFromSdkSessionId?: string; // SDK session ID to fork from (consumed on first query)
  forkAtMessageUuid?: string; // Message UUID to fork at (consumed on first query)
  // Pending AskUserQuestion response (resolve when user answers via frontend)
  pendingAskUserAnswer?: {
    resolve: (answers: Record<string, string>) => void;
    reject: (error: Error) => void;
  };
  // Pending ExitPlanMode approval (resolve when user approves/denies plan)
  pendingPlanApproval?: {
    resolve: (decision: { action: string; feedback?: string }) => void;
    reject: (error: Error) => void;
  };
  // Note: ExitPlanMode approval is handled by canUseTool which blocks the SDK
  // server-side.
  // Persistent message queue for streaming input mode. Follow-up messages
  // are enqueued here instead of calling streamInput() multiple times.
  inputQueue?: MessageQueue;
  // User prompts sent to the CLI that haven't been accounted for by a `result`
  // message yet. A follow-up stream-injected mid-run makes this 2. The CLI
  // either STEERS the injected prompt into the in-flight turn (one shared
  // result) or — when nothing can absorb it, e.g. during /compact — QUEUES it
  // as a fresh turn with its own result. In the queued case the first result
  // must NOT emit `done`: the CLI immediately starts the queued turn.
  claudePendingTurns?: number;
  // Armed when a result arrives while claudePendingTurns is still > 0 (see
  // above — we can't tell steered from queued at that moment). Any further CLI
  // message cancels it (a queued turn is running; its own result emits done);
  // if it fires, the injected prompts were steered and this done is real.
  pendingDoneTimer?: ReturnType<typeof setTimeout>;
}

interface QueuedPrompt {
  queryId: string;
  prompt: string;
  images?: ImageData[];
}

const sessions = new Map<string, Session>();

// Track tool_use_id to tool_name mapping for matching tool results
const toolUseIdToName = new Map<string, string>();

// Track thinking state per session+context (key: "session_id-parentToolUseId" -> { startTime, content })
// Uses composite key to support concurrent thinking in main thread and subagents
const thinkingState = new Map<string, { startTime: number; content: string }>();

// Subagent Task toolUseIds whose model has already been reported (key: "session_id-parentToolUseId").
// The subagent's actual model only surfaces on its assistant messages, so we forward it once
// from the first assistant message scoped to that task.
const subagentModelSent = new Set<string>();

// Track last main-agent-only usage per session for accurate context bar (excludes subagent usage)
const lastMainAgentUsage = new Map<string, {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}>();

function send(msg: object): void {
  const line = JSON.stringify(msg) + "\n";
  process.stdout.write(line);
}

function sendText(id: string, content: string, parentToolUseId?: string | null, turnUuid?: string | null): void {
  send({ type: "text", id, content, ...(parentToolUseId ? { parentToolUseId } : {}), ...(turnUuid ? { turnUuid } : {}) });
}

function sendToolStart(
  id: string,
  tool: string,
  input: unknown,
  toolUseId: string,
  parentToolUseId?: string | null,
  turnUuid?: string | null
): void {
  send({ type: "tool_start", id, tool, input, toolUseId, ...(parentToolUseId ? { parentToolUseId } : {}), ...(turnUuid ? { turnUuid } : {}) });
}

function sendToolResult(
  id: string,
  tool: string,
  output: string,
  toolUseId: string,
  parentToolUseId?: string | null,
  turnUuid?: string | null,
  images?: { mediaType: string; base64Data: string }[]
): void {
  send({ type: "tool_result", id, tool, output, toolUseId, ...(parentToolUseId ? { parentToolUseId } : {}), ...(turnUuid ? { turnUuid } : {}), ...(images && images.length > 0 ? { images } : {}) });
}

function sendThinkingStart(id: string, content: string, parentToolUseId?: string | null, turnUuid?: string | null): void {
  send({ type: "thinking_start", id, content, timestamp: Date.now(), ...(parentToolUseId ? { parentToolUseId } : {}), ...(turnUuid ? { turnUuid } : {}) });
}

function sendThinkingEnd(
  id: string,
  durationMs: number,
  content: string,
  parentToolUseId?: string | null,
  turnUuid?: string | null
): void {
  send({ type: "thinking_end", id, durationMs, content, ...(parentToolUseId ? { parentToolUseId } : {}), ...(turnUuid ? { turnUuid } : {}) });
}

function sendDone(id: string): void {
  send({ type: "done", id });
}

// Cancel a deferred done from a result that arrived with injected prompts
// still unaccounted for (see Session.pendingDoneTimer).
function cancelPendingDone(session: Session): void {
  if (session.pendingDoneTimer) {
    clearTimeout(session.pendingDoneTimer);
    session.pendingDoneTimer = undefined;
  }
}

function sendUsage(
  id: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    inputTokensIncludeCache?: boolean;
    totalCostUsd: number;
    durationMs: number;
    durationApiMs: number;
    numTurns: number;
    contextWindow: number;
    mainAgentInputTokens?: number;
    mainAgentOutputTokens?: number;
    mainAgentCacheReadTokens?: number;
    mainAgentCacheCreationTokens?: number;
  }
): void {
  send({ type: "usage", id, ...usage });
}

// Progressive usage during streaming (from assistant messages)
function sendProgressiveUsage(
  id: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    inputTokensIncludeCache?: boolean;
  }
): void {
  send({ type: "progressive_usage", id, ...usage });
}

function sendError(id: string, message: string): void {
  send({ type: "error", id, message });
}

function sendRateLimit(
  id: string,
  info: { status: string; resetsAt?: number; utilization?: number }
): void {
  send({
    type: "rate_limit",
    id,
    status: info.status,
    resetsAt: info.resetsAt,
    utilization: info.utilization,
  });
}

// Conservative case-insensitive detection of rate-limit / usage-limit errors so we can
// surface a recoverable rate-limited state (in addition to the normal error) when the SDK
// only gives us an opaque error string rather than an explicit rate_limit_event.
function isRateLimitError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("ratelimit") ||
    lower.includes("usage limit") ||
    lower.includes("429")
  );
}

function sendSubagentStart(
  id: string,
  agentId: string,
  agentType: string
): void {
  send({ type: "subagent_start", id, agentId, agentType });
}

function sendSubagentStop(
  id: string,
  agentId: string,
  transcriptPath: string
): void {
  send({ type: "subagent_stop", id, agentId, transcriptPath });
}

function sendSubagentModel(
  id: string,
  toolUseId: string,
  model: string
): void {
  send({ type: "subagent_model", id, toolUseId, model });
}

function sendTaskStarted(
  id: string,
  taskId: string,
  toolUseId: string | undefined,
  description: string,
  taskType: string | undefined
): void {
  send({ type: "task_started", id, taskId, toolUseId, description, taskType });
}

function sendTaskCompleted(
  id: string,
  taskId: string,
  toolUseId: string | undefined,
  status: string,
  summary: string,
  taskType: string | undefined,
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
): void {
  send({ type: "task_completed", id, taskId, toolUseId, status, summary, taskType, usage });
}

function sendSdkSessionId(id: string, sdkSessionId: string): void {
  send({ type: "sdk_session_id", id, sdkSessionId });
}

// Interactive question shape (shared by AskUserQuestion)
interface PlanningQuestionOption {
  label: string;
  description: string;
}

interface PlanningQuestion {
  question: string;
  header: string;
  options: PlanningQuestionOption[];
  multiSelect: boolean;
}

// AskUserQuestion events
function sendAskUserQuestions(
  id: string,
  questions: PlanningQuestion[]
): void {
  send({ type: "ask_user_questions", id, questions });
}

// Plan approval request (ExitPlanMode intercepted)
function sendPlanApprovalRequest(
  id: string,
  allowedPrompts: Array<{ tool: string; prompt: string }>,
  plan?: string
): void {
  send({ type: "plan_approval_request", id, allowedPrompts, ...(plan ? { plan } : {}) });
}

// Repo description result event
function sendRepoDescriptionResult(
  id: string,
  result: {
    description: string;
    keywords: string[];
    vocabulary: string[];
    icon?: string | null;
    color?: string | null;
  }
): void {
  send({ type: "repo_description_result", id, ...result });
}

function sendRepoDescriptionError(id: string, error: string): void {
  send({ type: "repo_description_error", id, error });
}

// Launch profile result event
function sendLaunchProfileResult(
  id: string,
  result: {
    commands: Array<{ name: string; command: string; working_dir?: string }>;
    profiles: Array<{ name: string; command_names: string[] }>;
  }
): void {
  send({ type: "launch_profile_result", id, ...result });
}

function sendLaunchProfileError(id: string, error: string): void {
  send({ type: "launch_profile_error", id, error });
}

// Validation agent result/error events.
// Rust maps `validation_agent_result` -> event `validation-agent-result-{id}`
// and `validation_agent_error` -> `validation-agent-error-{id}`.
function sendValidationAgentResult(
  id: string,
  result: {
    structured: unknown;
    transcript: string;
    sdkSessionId?: string;
    usage?: Record<string, number>;
  }
): void {
  send({
    type: "validation_agent_result",
    id,
    structured: result.structured,
    transcript: result.transcript,
    ...(result.sdkSessionId ? { sdkSessionId: result.sdkSessionId } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  });
}

function sendValidationAgentError(id: string, error: string): void {
  send({ type: "validation_agent_error", id, error });
}

// Streaming progress from a validation agent (tool calls / text), so the app
// can show live activity instead of a black box — and so the backend can
// reset its idle timeout while the agent is demonstrably working.
// Rust maps `validation_agent_progress` -> event `validation-agent-progress-{id}`.
function sendValidationAgentProgress(
  id: string,
  progress: { kind: "tool" | "text"; tool?: string; detail?: string; text?: string }
): void {
  send({ type: "validation_agent_progress", id, ...progress });
}

// =============================================================================
// OpenAI Codex SDK Integration
// =============================================================================

// Singleton Codex instance (reused across sessions)
let codexInstance: Codex | null = null;
const sidecarRuntimeRoot = process.cwd();

function getCodexInstance(): Codex {
  if (!codexInstance) {
    codexInstance = new Codex();
  }
  return codexInstance;
}

function setSessionSdkSessionId(session: Session, id: string, eventId: string): void {
  if (!id) return;
  if (session.sdkSessionId !== id) {
    session.sdkSessionId = id;
    sendSdkSessionId(eventId, id);
  }
}

function resolveCodexExecutable(): string {
  const ext = process.platform === "win32" ? ".cmd" : "";
  const localBin = path.join(
    sidecarRuntimeRoot,
    "node_modules",
    ".bin",
    `codex${ext}`
  );
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  return "codex";
}

function appServerWriteJson(
  state: AppServerState,
  payload: Record<string, unknown>
): void {
  state.process.stdin.write(JSON.stringify(payload) + "\n");
}

function appServerNotify(
  state: AppServerState,
  method: string,
  params?: Record<string, unknown>
): void {
  appServerWriteJson(state, params ? { method, params } : { method });
}

function appServerRequest(
  state: AppServerState,
  method: string,
  params?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  const id = state.nextRequestId++;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request aborted"));
      return;
    }

    const abortHandler = () => {
      state.pendingRequests.delete(id);
      reject(new Error("Request aborted"));
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    state.pendingRequests.set(id, {
      resolve: (result: unknown) => {
        signal?.removeEventListener("abort", abortHandler);
        resolve(result);
      },
      reject: (error: Error) => {
        signal?.removeEventListener("abort", abortHandler);
        reject(error);
      },
    });

    appServerWriteJson(state, params ? { method, id, params } : { method, id });
  });
}

function extractTextDeltaFromParams(params: Record<string, unknown>): string {
  const direct =
    (typeof params.delta === "string" && params.delta) ||
    (typeof params.text === "string" && params.text) ||
    (typeof params.textDelta === "string" && params.textDelta);
  if (direct) return direct;

  const nestedDelta = params.delta as Record<string, unknown> | undefined;
  if (nestedDelta && typeof nestedDelta.text === "string") {
    return nestedDelta.text;
  }
  return "";
}

function normalizeItemType(rawType: string | undefined): string {
  if (!rawType) return "";
  return rawType.replace(/_/g, "").toLowerCase();
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function getWebSearchQuery(item: Record<string, unknown>): string | undefined {
  if (typeof item.query === "string" && item.query.trim()) {
    return item.query;
  }
  if (typeof item.search_query === "string" && item.search_query.trim()) {
    return item.search_query;
  }

  const input = item.input as Record<string, unknown> | undefined;
  if (input && typeof input.query === "string" && input.query.trim()) {
    return input.query;
  }

  const args = item.arguments as Record<string, unknown> | undefined;
  if (args && typeof args.query === "string" && args.query.trim()) {
    return args.query;
  }

  const action = item.action as Record<string, unknown> | undefined;
  if (!action) return undefined;

  if (typeof action.query === "string" && action.query.trim()) {
    return action.query;
  }

  const search = action.search as Record<string, unknown> | undefined;
  if (search && typeof search.query === "string" && search.query.trim()) {
    return search.query;
  }

  return undefined;
}

function getWebSearchResultText(item: Record<string, unknown>): string {
  const error = item.error as Record<string, unknown> | undefined;
  if (error?.message) {
    return `Error: ${String(error.message)}`;
  }

  const result =
    item.result ??
    item.output ??
    item.response ??
    ((item.action as Record<string, unknown> | undefined)?.result);
  if (result !== undefined) {
    return stringifyUnknown(result);
  }

  const action = item.action as Record<string, unknown> | undefined;
  const actionType = typeof action?.type === "string" ? action.type : undefined;
  const query = getWebSearchQuery(item);

  if (actionType && query) {
    return `${actionType}: ${query}`;
  }
  if (query) {
    return query;
  }
  if (actionType) {
    return actionType;
  }

  return "Search completed";
}

function extractReasoningText(item: Record<string, unknown>): string {
  const directCandidates = [
    item.text,
    item.summary,
    item.reasoning,
    item.output_text,
    item.outputText,
    item.content,
    item.message,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  const nestedCandidates = [
    item.result,
    item.output,
    item.response,
    item.delta,
    item.reasoning_text,
  ];
  for (const candidate of nestedCandidates) {
    if (!candidate) continue;
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
    if (typeof candidate === "object" && !Array.isArray(candidate)) {
      const obj = candidate as Record<string, unknown>;
      const nestedText = [
        obj.text,
        obj.summary,
        obj.reasoning,
        obj.output_text,
        obj.outputText,
      ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (nestedText) {
        return nestedText;
      }
    }
  }

  const content = item.content;
  if (Array.isArray(content)) {
    const contentText = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") return p.text;
        if (typeof p.content === "string") return p.content;
        if (typeof p.summary === "string") return p.summary;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (contentText.trim()) {
      return contentText;
    }
  }

  return "";
}

const reasoningByItemId = new Map<string, { startTime: number; content: string }>();

function reasoningStateKey(sessionId: string, itemId: string): string {
  return `${sessionId}:${itemId}`;
}

function updateReasoningState(
  sessionId: string,
  itemId: string,
  phase: "started" | "updated" | "completed",
  content: string
): void {
  const key = reasoningStateKey(sessionId, itemId);
  const existing = reasoningByItemId.get(key);

  if (phase === "started") {
    reasoningByItemId.set(key, {
      startTime: Date.now(),
      content: content || existing?.content || "",
    });
    sendThinkingStart(sessionId, content || existing?.content || "");
    return;
  }

  if (phase === "updated") {
    if (existing) {
      if (content) {
        existing.content = content;
      }
    } else {
      reasoningByItemId.set(key, {
        startTime: Date.now(),
        content: content || "",
      });
      sendThinkingStart(sessionId, content || "");
    }
    return;
  }

  const finalContent = content || existing?.content || "";
  const durationMs = existing ? Math.max(0, Date.now() - existing.startTime) : 0;
  sendThinkingEnd(sessionId, durationMs, finalContent);
  reasoningByItemId.delete(key);
}

function toTodoWriteInput(item: Record<string, unknown>): { todos: Array<{ content: string; status: "completed" | "pending" }> } {
  const rawItems = Array.isArray(item.items)
    ? (item.items as Array<Record<string, unknown>>)
    : [];
  return {
    todos: rawItems.map((todo) => ({
      content: String(todo.text ?? ""),
      status: todo.completed === true ? "completed" : "pending",
    })),
  };
}

function extractImagesFromFileRefs(
  sessionId: string,
  output: string
): { mediaType: string; base64Data: string }[] {
  const imgs: { mediaType: string; base64Data: string }[] = [];
  const session = sessions.get(sessionId);
  if (!session) return imgs;

  // Match markdown image/link refs to local image files (png, jpg, jpeg, webp, gif)
  const fileRefPattern = /\]\(([^)]+\.(?:png|jpg|jpeg|webp|gif))\)/gi;
  let match: RegExpExecArray | null;
  while ((match = fileRefPattern.exec(output)) !== null) {
    const relPath = match[1].replace(/\\\\/g, "/").replace(/\\/g, "/");
    const absPath = path.resolve(session.cwd, relPath);
    try {
      if (fs.existsSync(absPath)) {
        const data = fs.readFileSync(absPath);
        const ext = path.extname(absPath).slice(1).toLowerCase();
        const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        imgs.push({ mediaType: mime, base64Data: data.toString("base64") });
      }
    } catch {}
  }
  return imgs;
}

function handleAppServerItemEvent(
  id: string,
  item: Record<string, unknown>,
  phase: "started" | "updated" | "completed"
): void {
  const itemId = (item.id as string) || `item-${Date.now()}`;
  const type = normalizeItemType(item.type as string | undefined);
  const parentToolUseId =
    (item.parentToolUseId as string | null | undefined) ||
    (item.parent_tool_use_id as string | null | undefined) ||
    null;
  const turnUuid =
    (item.turnUuid as string | null | undefined) ||
    (item.turn_uuid as string | null | undefined) ||
    null;

  if (type === "commandexecution") {
    if (phase === "started") {
      sendToolStart(id, "Bash", { command: item.command }, itemId, parentToolUseId, turnUuid);
    } else {
      const output =
        (item.aggregatedOutput as string) ||
        (item.aggregated_output as string) ||
        (item.stdout as string) ||
        (item.stderr as string) ||
        `exit code: ${String(item.exitCode ?? item.exit_code ?? "unknown")}`;
      sendToolResult(id, "Bash", output, itemId, parentToolUseId, turnUuid);
    }
    return;
  }

  if (type === "filechange") {
    const changes = (item.changes as Array<Record<string, unknown>>) || [];
    if (phase === "started") {
      const files = changes.map((c) => c.path).filter(Boolean).join(", ");
      sendToolStart(
        id,
        "Edit",
        { files: files || "unknown" },
        itemId,
        parentToolUseId,
        turnUuid
      );
    } else {
      const summary =
        changes
          .map((c) => `${String(c.kind || "change")}: ${String(c.path || "")}`)
          .join("\n") || "File changes applied";
      sendToolResult(id, "Edit", summary, itemId, parentToolUseId, turnUuid);
    }
    return;
  }

  if (type === "mcptoolcall") {
    const server = String(item.server || "");
    const tool = String(item.tool || "");
    const toolName = tool ? `mcp__${server}__${tool}` : `mcp__${server}`;
    if (phase === "started") {
      sendToolStart(id, toolName, item.arguments, itemId, parentToolUseId, turnUuid);
    } else {
      const err = item.error as Record<string, unknown> | undefined;
      const result = item.result;
      let output = "";
      let resultImages: { mediaType: string; base64Data: string }[] | undefined;

      if (err) {
        output = `Error: ${String(err.message || "Unknown MCP error")}`;
      } else if (typeof result === "string") {
        output = result;
      } else if (Array.isArray(result)) {
        const textParts: string[] = [];
        const imgs: { mediaType: string; base64Data: string }[] = [];
        for (const block of result) {
          if (block && block.type === "text" && block.text) {
            textParts.push(block.text);
          } else if (block && block.type === "image" && block.source?.data) {
            imgs.push({
              mediaType: block.source.media_type || "image/png",
              base64Data: block.source.data,
            });
          }
        }
        output = textParts.join("\n");
        if (imgs.length > 0) resultImages = imgs;
      } else {
        output = JSON.stringify(result ?? "");
      }
      // If no inline images but output references local image files (e.g. Playwright screenshots),
      // read them from disk and include as base64
      if (!resultImages && output) {
        const fileImgs = extractImagesFromFileRefs(id, output);
        if (fileImgs.length > 0) resultImages = fileImgs;
      }

      sendToolResult(id, toolName, output, itemId, parentToolUseId, turnUuid, resultImages);
    }
    return;
  }

  if (type === "collabtoolcall") {
    const tool = String(item.tool || "Task");
    const prompt = typeof item.prompt === "string" ? item.prompt : "";
    const agentStatus = String(item.agentStatus || item.agent_status || "");
    const agentId =
      (item.receiverThreadId as string | undefined) ||
      (item.receiver_thread_id as string | undefined) ||
      (item.newThreadId as string | undefined) ||
      (item.new_thread_id as string | undefined) ||
      itemId;
    const taskInput = {
      prompt,
      description: prompt,
      subagent_type: tool,
      senderThreadId:
        (item.senderThreadId as string | undefined) ||
        (item.sender_thread_id as string | undefined),
      receiverThreadId:
        (item.receiverThreadId as string | undefined) ||
        (item.receiver_thread_id as string | undefined),
      newThreadId:
        (item.newThreadId as string | undefined) ||
        (item.new_thread_id as string | undefined),
    };

    if (phase === "started") {
      sendTaskStarted(id, itemId, itemId, prompt, tool);
      sendToolStart(id, "Task", taskInput, itemId, parentToolUseId, turnUuid);
      sendSubagentStart(id, agentId, tool);
    } else if (phase === "completed") {
      sendToolResult(
        id,
        "Task",
        agentStatus || `Task ${String(item.status || "completed")}`,
        itemId,
        parentToolUseId,
        turnUuid
      );
      sendTaskCompleted(
        id,
        itemId,
        itemId,
        String(item.status || "completed"),
        agentStatus,
        tool,
      );
      sendSubagentStop(id, agentId, "");
    }
    return;
  }

  if (type === "websearch" || type === "websearchrequest") {
    if (phase === "started") {
      sendToolStart(
        id,
        "WebSearch",
        { query: getWebSearchQuery(item) || "unknown" },
        itemId,
        parentToolUseId,
        turnUuid
      );
    } else {
      sendToolResult(
        id,
        "WebSearch",
        getWebSearchResultText(item),
        itemId,
        parentToolUseId,
        turnUuid
      );
    }
    return;
  }

  if (type === "reasoning") {
    const reasoningText = extractReasoningText(item);
    updateReasoningState(id, itemId, phase, reasoningText);
    return;
  }

  if (type === "todolist") {
    const input = toTodoWriteInput(item);
    if (phase === "started") {
      sendToolStart(id, "TodoWrite", input, itemId, parentToolUseId, turnUuid);
    } else {
      sendToolResult(
        id,
        "TodoWrite",
        `Updated ${input.todos.length} todo item${input.todos.length === 1 ? "" : "s"}`,
        itemId,
        parentToolUseId,
        turnUuid
      );
    }
    return;
  }

  if (type === "error" && phase === "completed") {
    const message = (item.message as string) || "Unknown item error";
    sendError(id, message);
    return;
  }

  if (type === "agentmessage" && phase === "completed") {
    const text = item.text;
    if (typeof text === "string" && text) {
      sendText(id, text, parentToolUseId, turnUuid);
    }
  }
}

function handleAppServerNotification(id: string, notification: JsonRpcNotification): void {
  const session = sessions.get(id);
  if (!session) return;

  const asNumber = (value: unknown, fallback = 0): number => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
  };

  const params = (notification.params || {}) as Record<string, unknown>;
  const pickNumber = (
    obj: Record<string, unknown> | undefined,
    keys: string[]
  ): number => {
    if (!obj) return 0;
    for (const key of keys) {
      const value = obj[key];
      const parsed = asNumber(value);
      if (parsed > 0) return parsed;
    }
    return 0;
  };
  const extractTokenUsage = (
    source: Record<string, unknown> | undefined
  ):
    | {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
      }
    | null => {
    if (!source) return null;

    const candidates: Array<Record<string, unknown>> = [];
    const pushCandidate = (value: unknown) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        candidates.push(value as Record<string, unknown>);
      }
    };

    pushCandidate(source);
    pushCandidate(source.info);
    pushCandidate(source.usage);
    pushCandidate(source.result);
    pushCandidate(source.token_count);
    pushCandidate(source.tokenCount);
    pushCandidate(source.total_token_usage);
    pushCandidate(source.totalTokenUsage);
    pushCandidate(source.last_token_usage);
    pushCandidate(source.lastTokenUsage);
    const eventObj = source.event as Record<string, unknown> | undefined;
    if (eventObj) {
      pushCandidate(eventObj);
      pushCandidate(eventObj.usage);
      pushCandidate(eventObj.result);
      pushCandidate(eventObj.token_count);
      pushCandidate(eventObj.tokenCount);
      pushCandidate(eventObj.total_token_usage);
      pushCandidate(eventObj.totalTokenUsage);
      pushCandidate(eventObj.last_token_usage);
      pushCandidate(eventObj.lastTokenUsage);
    }

    for (const c of candidates) {
      const inputTokens = pickNumber(c, [
        "input_tokens",
        "inputTokens",
      ]);
      const outputTokens = pickNumber(c, [
        "output_tokens",
        "outputTokens",
      ]);
      const cacheReadTokens = pickNumber(c, [
        "cached_input_tokens",
        "cache_read_input_tokens",
        "cachedInputTokens",
        "cacheReadInputTokens",
        "cacheReadTokens",
      ]);
      const cacheCreationTokens = pickNumber(c, [
        "cache_creation_input_tokens",
        "cacheCreationInputTokens",
      ]);

      if (
        inputTokens > 0 ||
        outputTokens > 0 ||
        cacheReadTokens > 0 ||
        cacheCreationTokens > 0
      ) {
        return {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
        };
      }
    }

    return null;
  };
  const extractContextWindow = (
    source: Record<string, unknown> | undefined
  ): number => {
    const fallbackContextWindow =
      session.provider === "openai"
        ? inferOpenAiContextWindow(session.codexModel)
        : inferClaudeContextWindow(session.options.model);
    if (!source) return fallbackContextWindow;
    const direct =
      asNumber(source.model_context_window) ||
      asNumber(source.modelContextWindow) ||
      asNumber(source.context_window) ||
      asNumber(source.contextWindow);
    if (direct > 0) return direct;
    const info = source.info as Record<string, unknown> | undefined;
    if (info) {
      const infoWindow =
        asNumber(info.model_context_window) ||
        asNumber(info.modelContextWindow) ||
        asNumber(info.context_window) ||
        asNumber(info.contextWindow);
      if (infoWindow > 0) return infoWindow;
    }
    const eventObj = source.event as Record<string, unknown> | undefined;
    if (eventObj) {
      const eventWindow =
        asNumber(eventObj.model_context_window) ||
        asNumber(eventObj.modelContextWindow) ||
        asNumber(eventObj.context_window) ||
        asNumber(eventObj.contextWindow);
      if (eventWindow > 0) return eventWindow;
    }
    return fallbackContextWindow;
  };
  const emitAppServerUsage = (
    source: Record<string, unknown> | undefined,
    numTurns = 1
  ): boolean => {
    const usage = extractTokenUsage(source);
    if (!usage) return false;
    sendUsage(id, {
      ...usage,
      inputTokensIncludeCache: true,
      totalCostUsd: 0,
      durationMs: 0,
      durationApiMs: 0,
      numTurns,
      contextWindow: extractContextWindow(source),
    });
    sendProgressiveUsage(id, { ...usage, inputTokensIncludeCache: true });
    return true;
  };
  const turn = params.turn as Record<string, unknown> | undefined;
  const item = params.item as Record<string, unknown> | undefined;
  const turnId = typeof turn?.id === "string" ? turn.id : undefined;
  const itemType = typeof item?.type === "string" ? item.type : undefined;
  const itemId = typeof item?.id === "string" ? item.id : undefined;
  const pendingTurnCount = session.appServer?.pendingTurns.size ?? 0;
  const completedTurnCount = session.appServer?.completedTurns.size ?? 0;
  send({
    type: "debug",
    id,
    message:
      `[app-server event] method=${notification.method}` +
      (turnId ? ` turnId=${turnId}` : "") +
      (itemType ? ` itemType=${itemType}` : "") +
      (itemId ? ` itemId=${itemId}` : "") +
      ` pendingTurns=${pendingTurnCount} completedTurns=${completedTurnCount}`,
  });

  switch (notification.method) {
    case "thread/started":
    case "thread.started": {
      const thread = params.thread as Record<string, unknown> | undefined;
      const threadId = thread?.id;
      if (typeof threadId === "string" && threadId) {
        setSessionSdkSessionId(session, threadId, id);
      }
      break;
    }
    case "item/agentMessage/delta":
    case "item.agentMessage.delta":
    case "item/agent_message/delta":
    case "item.agent_message.delta": {
      // Intentionally ignore deltas: emit only completed full assistant message.
      break;
    }
    case "item/started":
    case "item.started": {
      const item = params.item as Record<string, unknown> | undefined;
      if (item) handleAppServerItemEvent(id, item, "started");
      break;
    }
    case "item/updated":
    case "item.updated": {
      const item = params.item as Record<string, unknown> | undefined;
      if (item) handleAppServerItemEvent(id, item, "updated");
      break;
    }
    case "item/completed":
    case "item.completed": {
      const item = params.item as Record<string, unknown> | undefined;
      if (item) handleAppServerItemEvent(id, item, "completed");
      break;
    }
    case "turn/completed":
    case "turn.completed": {
      const turn = params.turn as Record<string, unknown> | undefined;
      const turnId = turn?.id;
      emitAppServerUsage(turn, 1) || emitAppServerUsage(params, 1);

      if (typeof turnId === "string") {
        const wasActiveTurn = session.appServerTurnId === turnId;
        if (session.appServerTurnId === turnId) {
          session.appServerTurnId = undefined;
        }
        const pending = session.appServer?.pendingTurns.get(turnId);
        const status = String(turn?.status || "");
        const error = turn?.error as Record<string, unknown> | undefined;
        const errorMessage = String(error?.message || "Turn failed");
        send({
          type: "debug",
          id,
          message:
            `[app-server turn/completed] turnId=${turnId} status=${status} ` +
            `hasPending=${pending ? "yes" : "no"} activeTurnId=${session.appServerTurnId || "none"}`,
        });
        if (pending) {
          session.appServer?.pendingTurns.delete(turnId);
          if (status === "failed") {
            pending.reject(new Error(errorMessage));
          } else {
            pending.resolve();
          }
          send({
            type: "debug",
            id,
            message:
              `[app-server turn/completed] resolved pending turnId=${turnId} ` +
              `pendingTurns=${session.appServer?.pendingTurns.size ?? 0}`,
          });
        } else if (session.appServer && wasActiveTurn) {
          // turn/completed can race ahead of pendingTurns registration.
          session.appServer.completedTurns.set(turnId, {
            status,
            ...(status === "failed" ? { errorMessage } : {}),
          });
          send({
            type: "debug",
            id,
            message:
              `[app-server turn/completed] cached completion turnId=${turnId} ` +
              `completedTurns=${session.appServer.completedTurns.size}`,
          });
        }
      }
      break;
    }
    case "thread/tokenUsage/updated":
    case "thread.tokenUsage.updated":
    case "thread/token_usage/updated":
    case "thread.token_usage.updated": {
      // Official v2 payload shape:
      // { threadId, turnId, tokenUsage: { last, total, modelContextWindow } }
      const tokenUsage = params.tokenUsage as Record<string, unknown> | undefined;
      const last = tokenUsage?.last as Record<string, unknown> | undefined;
      const total = tokenUsage?.total as Record<string, unknown> | undefined;
      const contextWindow =
        asNumber(tokenUsage?.modelContextWindow) ||
        asNumber(tokenUsage?.model_context_window) ||
        asNumber(tokenUsage?.contextWindow) ||
        asNumber(tokenUsage?.context_window) ||
        asNumber(params.modelContextWindow) ||
        asNumber(params.model_context_window) ||
        asNumber(params.contextWindow) ||
        asNumber(params.context_window) ||
        (session.provider === "openai"
          ? inferOpenAiContextWindow(session.codexModel)
          : inferClaudeContextWindow(session.options.model));

      if (last || total) {
        const lastInput =
          asNumber(last?.inputTokens) || asNumber(last?.input_tokens);
        const lastOutput =
          asNumber(last?.outputTokens) || asNumber(last?.output_tokens);
        const lastCached =
          asNumber(last?.cachedInputTokens) ||
          asNumber(last?.cached_input_tokens) ||
          asNumber(last?.cacheReadTokens);
        const lastCacheCreation =
          asNumber(last?.cacheCreationInputTokens) ||
          asNumber(last?.cache_creation_input_tokens) ||
          asNumber(last?.cacheCreationTokens);

        const totalInput =
          asNumber(total?.inputTokens) || asNumber(total?.input_tokens);
        const totalOutput =
          asNumber(total?.outputTokens) || asNumber(total?.output_tokens);
        const totalCacheRead =
          asNumber(total?.cachedInputTokens) ||
          asNumber(total?.cached_input_tokens) ||
          asNumber(total?.cacheReadTokens);
        const totalCacheCreation =
          asNumber(total?.cacheCreationInputTokens) ||
          asNumber(total?.cache_creation_input_tokens) ||
          asNumber(total?.cacheCreationTokens);

        // For App Server, tokenUsage.total reflects current thread context and should
        // drive final context usage after each turn. tokenUsage.last is per-turn and
        // used only for live/progressive updates.
        const finalInput = total ? totalInput : lastInput;
        const finalOutput = total ? totalOutput : lastOutput;
        const finalCacheRead = total ? totalCacheRead : lastCached;
        const finalCacheCreation = total ? totalCacheCreation : lastCacheCreation;

        sendUsage(id, {
          inputTokens: finalInput,
          outputTokens: finalOutput,
          cacheReadTokens: finalCacheRead,
          cacheCreationTokens: finalCacheCreation,
          inputTokensIncludeCache: true,
          totalCostUsd: 0,
          durationMs: 0,
          durationApiMs: 0,
          numTurns: 1,
          contextWindow,
        });

        if (last) {
          sendProgressiveUsage(id, {
            inputTokens: lastInput,
            outputTokens: lastOutput,
            cacheReadTokens: lastCached,
            cacheCreationTokens: lastCacheCreation,
            inputTokensIncludeCache: true,
          });
        }
      } else {
        emitAppServerUsage(params.info as Record<string, unknown> | undefined, 1) ||
          emitAppServerUsage(params, 1);
      }
      break;
    }
    case "codex/event/token_count":
    case "codex.event.token_count":
    case "codex/event/tokenCount":
    case "codex.event.tokenCount": {
      const emitted = emitAppServerUsage(params, 1);
      if (!emitted) {
        send({
          type: "debug",
          id,
          message:
            `[app-server token_count] unable to parse usage payload keys=` +
            `${Object.keys(params).join(",")}`,
        });
      }
      break;
    }
    case "error": {
      const error = params.error as Record<string, unknown> | undefined;
      if (error?.message) {
        sendError(id, String(error.message));
      }
      break;
    }
    default:
      break;
  }
}

async function ensureCodexAppServer(
  id: string,
  session: Session
): Promise<AppServerState> {
  if (session.appServer) return session.appServer;

  const codexExecutable = resolveCodexExecutable();
  const spawnEnv: NodeJS.ProcessEnv = {
    ...globalThis.process.env,
    ...(session.extraEnv ?? {}),
  };
  // A session pinned to a Codex account profile (CODEX_HOME) must not be
  // overridden by the process-global OPENAI_API_KEY, which outranks auth.json.
  if (session.extraEnv?.CODEX_HOME && !session.extraEnv.OPENAI_API_KEY) {
    delete spawnEnv.OPENAI_API_KEY;
  }
  let child: ChildProcessWithoutNullStreams;
  if (globalThis.process.platform === "win32") {
    // On Windows, .cmd shims require launching via cmd.exe.
    const cmd = codexExecutable === "codex"
      ? "codex app-server"
      : `"${codexExecutable}" app-server`;
    child = spawn("cmd.exe", ["/d", "/s", "/c", cmd], {
      cwd: session.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
    });
  } else {
    child = spawn(codexExecutable, ["app-server"], {
      cwd: session.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
    });
  }
  const rl = readline.createInterface({
    input: child.stdout,
    terminal: false,
  });

  const state: AppServerState = {
    process: child,
    rl,
    nextRequestId: 1,
    pendingRequests: new Map(),
    pendingTurns: new Map(),
    completedTurns: new Map(),
    initialized: false,
  };

  child.stderr.on("data", (chunk: Buffer) => {
    send({
      type: "debug",
      id,
      message: `[app-server stderr] ${chunk.toString().trim()}`,
    });
  });

  child.on("error", (err) => {
    send({
      type: "debug",
      id,
      message: `Failed to spawn codex app-server (${codexExecutable}): ${err.message}`,
    });
    for (const [, pending] of state.pendingRequests) {
      pending.reject(err);
    }
    state.pendingRequests.clear();
    for (const [, pending] of state.pendingTurns) {
      pending.reject(err);
    }
    state.pendingTurns.clear();
    state.completedTurns.clear();
    if (session.appServer === state) {
      session.appServer = undefined;
      session.appServerTurnId = undefined;
    }
  });

  child.on("close", (code) => {
    for (const [, pending] of state.pendingRequests) {
      pending.reject(new Error(`codex app-server exited (${code ?? "unknown"})`));
    }
    state.pendingRequests.clear();
    for (const [, pending] of state.pendingTurns) {
      pending.reject(new Error(`codex app-server exited (${code ?? "unknown"})`));
    }
    state.pendingTurns.clear();
    state.completedTurns.clear();
    if (session.appServer === state) {
      session.appServer = undefined;
      session.appServerTurnId = undefined;
    }
  });

  rl.on("line", (line) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      send({
        type: "debug",
        id,
        message: `[app-server] Non-JSON line: ${line}`,
      });
      return;
    }

    if (
      typeof msg.id === "number" &&
      (Object.prototype.hasOwnProperty.call(msg, "result") ||
        Object.prototype.hasOwnProperty.call(msg, "error"))
    ) {
      const response = msg as unknown as JsonRpcResponse;
      const pending = state.pendingRequests.get(response.id);
      if (!pending) return;
      state.pendingRequests.delete(response.id);
      if (response.error) {
        pending.reject(
          new Error(
            `JSON-RPC ${response.error.code}: ${response.error.message}`
          )
        );
      } else {
        pending.resolve(response.result);
      }
      return;
    }

    if (typeof msg.method === "string") {
      if (typeof msg.id === "number") {
        // Server-initiated request not currently handled by this client.
        appServerWriteJson(state, {
          id: msg.id,
          error: {
            code: -32601,
            message: `Method ${msg.method} not handled by client`,
          },
        });
        return;
      }
      handleAppServerNotification(id, msg as unknown as JsonRpcNotification);
    }
  });

  session.appServer = state;

  const initResult = (await appServerRequest(state, "initialize", {
    clientInfo: {
      name: "open_whisperer",
      title: "OpenWhisperer",
      version: "1.0.0",
    },
  })) as Record<string, unknown>;
  appServerNotify(state, "initialized", {});
  state.initialized = true;

  const userAgent = initResult?.userAgent;
  if (typeof userAgent === "string" && userAgent) {
    send({
      type: "debug",
      id,
      message: `Codex app-server initialized: ${userAgent}`,
    });
  } else {
    send({
      type: "debug",
      id,
      message: "Codex app-server initialized",
    });
  }

  return state;
}

async function stopCodexAppServer(session: Session): Promise<void> {
  const state = session.appServer;
  if (!state) return;
  session.appServer = undefined;
  session.appServerTurnId = undefined;
  state.rl.close();
  state.process.kill();
}

function buildCodexAppServerInputItems(
  msg: QueryMessage,
  session: Session,
  includeSystemPrompt: boolean
): Array<Record<string, unknown>> {
  const inputItems: Array<Record<string, unknown>> = [];

  if (includeSystemPrompt && session.codexSystemPrompt) {
    inputItems.push({ type: "text", text: session.codexSystemPrompt });
  }
  if (msg.images && msg.images.length > 0) {
    for (const img of msg.images) {
      const tmpDir = os.tmpdir();
      const ext = img.mediaType.split("/")[1] || "png";
      const tmpPath = path.join(
        tmpDir,
        `cw-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      );
      fs.writeFileSync(tmpPath, Buffer.from(img.base64Data, "base64"));
      inputItems.push({ type: "localImage", path: tmpPath });
    }
  }
  if (msg.prompt.trim()) {
    inputItems.push({ type: "text", text: msg.prompt });
  }

  return inputItems;
}

async function handleCodexAppServerQuery(
  msg: QueryMessage,
  preassignedQueryId?: string
): Promise<void> {
  const session = sessions.get(msg.id);
  if (!session) {
    sendError(msg.id, "Session not found");
    return;
  }

  const queryId =
    preassignedQueryId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  session.currentQueryId = queryId;
  const abortController = new AbortController();
  session.abortController = abortController;

  try {
    const appServer = await ensureCodexAppServer(msg.id, session);
    send({
      type: "debug",
      id: msg.id,
      message:
        `[app-server query] start queryId=${queryId} ` +
        `resumeThreadId=${session.sdkSessionId || session.passedSdkSessionId || "none"}`,
    });

    let threadId = session.sdkSessionId || session.passedSdkSessionId;
    if (threadId) {
      send({
        type: "debug",
        id: msg.id,
        message: `[app-server query] thread/resume threadId=${threadId}`,
      });
      await appServerRequest(
        appServer,
        "thread/resume",
        {
          threadId,
          ...(session.codexModel ? { model: session.codexModel } : {}),
        },
        abortController.signal
      );
    } else {
      send({
        type: "debug",
        id: msg.id,
        message: "[app-server query] thread/start",
      });
      const result = (await appServerRequest(
        appServer,
        "thread/start",
        {
          ...(session.codexModel ? { model: session.codexModel } : {}),
          cwd: session.cwd,
          approvalPolicy: "never",
        },
        abortController.signal
      )) as Record<string, unknown>;
      const thread = result?.thread as Record<string, unknown> | undefined;
      const createdThreadId = thread?.id;
      if (typeof createdThreadId === "string" && createdThreadId) {
        threadId = createdThreadId;
      }
    }

    if (!threadId) {
      throw new Error("Failed to acquire thread ID from codex app-server");
    }
    setSessionSdkSessionId(session, threadId, msg.id);

    const inputItems = buildCodexAppServerInputItems(msg, session, true);

    const appServerEffort = mapEffortForProvider(
      session.effortLevel,
      "openai",
      session.codexModel
    );
    const turnResult = (await appServerRequest(
      appServer,
      "turn/start",
      {
        threadId,
        input: inputItems.length > 0 ? inputItems : [{ type: "text", text: "" }],
        ...(appServerEffort ? { effort: appServerEffort } : {}),
      },
      abortController.signal
    )) as Record<string, unknown>;
    const turn = turnResult?.turn as Record<string, unknown> | undefined;
    const turnId = turn?.id;
    if (typeof turnId !== "string" || !turnId) {
      throw new Error("Failed to start turn: missing turn ID");
    }
    send({
      type: "debug",
      id: msg.id,
      message:
        `[app-server query] turn/start result turnId=${turnId} ` +
        `status=${String(turn?.status || "unknown")}`,
    });
    session.appServerTurnId = turnId;

    await new Promise<void>((resolve, reject) => {
      appServer.pendingTurns.set(turnId, { resolve, reject });
      send({
        type: "debug",
        id: msg.id,
        message:
          `[app-server query] waiter attached turnId=${turnId} ` +
          `pendingTurns=${appServer.pendingTurns.size} completedTurns=${appServer.completedTurns.size}`,
      });
      const completed = appServer.completedTurns.get(turnId);
      if (completed) {
        appServer.completedTurns.delete(turnId);
        appServer.pendingTurns.delete(turnId);
        send({
          type: "debug",
          id: msg.id,
          message:
            `[app-server query] consumed cached completion turnId=${turnId} ` +
            `status=${completed.status}`,
        });
        if (completed.status === "failed") {
          reject(new Error(completed.errorMessage || "Turn failed"));
        } else {
          resolve();
        }
        return;
      }
      // If the turn already completed synchronously, settle now.
      const status = String(turn?.status || "");
      if (status === "completed" || status === "interrupted") {
        appServer.pendingTurns.delete(turnId);
        resolve();
      } else if (status === "failed") {
        appServer.pendingTurns.delete(turnId);
        const error = turn?.error as Record<string, unknown> | undefined;
        reject(new Error(String(error?.message || "Turn failed")));
      }
    });

    session.appServerTurnId = undefined;
    if (session.currentQueryId === queryId) {
      if (session.codexSystemPrompt) {
        session.codexSystemPrompt = undefined;
      }
      send({
        type: "debug",
        id: msg.id,
        message: `[app-server query] sendDone queryId=${queryId}`,
      });
      sendDone(msg.id);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    send({ type: "debug", id: msg.id, message: `App-server query error: ${errorMessage}` });

    if (
      session.currentQueryId === queryId &&
      session.codexModel !== OPENAI_MODEL_FALLBACK &&
      isUnsupportedChatGptAccountModelError(errorMessage)
    ) {
      session.codexModel = OPENAI_MODEL_FALLBACK;
      session.sdkSessionId = undefined;
      session.passedSdkSessionId = undefined;
      return handleCodexAppServerQuery(msg);
    }

    if (session.currentQueryId === queryId) {
      if (errorMessage.toLowerCase().includes("abort")) {
        sendDone(msg.id);
      } else {
        sendError(msg.id, errorMessage);
        // Fallback rate-limit detection when the SDK gives only an opaque error string.
        if (isRateLimitError(errorMessage)) {
          sendRateLimit(msg.id, { status: "rejected" });
        }
      }
    }
  } finally {
    if (session.currentQueryId === queryId) {
      session.abortController = undefined;
      session.appServerTurnId = undefined;
    }
  }
}

// Map Codex thread events to our IPC protocol
function handleCodexEvent(id: string, event: ThreadEvent): void {
  const session = sessions.get(id);
  const contextWindow = inferOpenAiContextWindow(session?.codexModel);
  switch (event.type) {
    case "thread.started":
      // Capture thread ID as SDK session ID for resume
      send({
        type: "debug",
        id,
        message: `Codex thread started: ${event.thread_id}`,
      });
      sendSdkSessionId(id, event.thread_id);
      break;

    case "turn.started":
      send({ type: "debug", id, message: "Codex turn started" });
      break;

    case "turn.completed":
      send({ type: "debug", id, message: "Codex turn completed" });
      // Send usage data
      if (event.usage) {
        sendUsage(id, {
          inputTokens: event.usage.input_tokens || 0,
          outputTokens: event.usage.output_tokens || 0,
          cacheReadTokens: event.usage.cached_input_tokens || 0,
          cacheCreationTokens: 0,
          inputTokensIncludeCache: true,
          totalCostUsd: 0, // Codex SDK doesn't report cost directly
          durationMs: 0,
          durationApiMs: 0,
          numTurns: 1,
          contextWindow,
        });
      }
      break;

    case "turn.failed":
      send({
        type: "debug",
        id,
        message: `Codex turn failed: ${event.error?.message}`,
      });
      sendError(id, event.error?.message || "Turn failed");
      break;

    case "item.started":
      handleCodexItemEvent(id, event.item, "started");
      break;

    case "item.updated":
      handleCodexItemEvent(id, event.item, "updated");
      break;

    case "item.completed":
      handleCodexItemEvent(id, event.item, "completed");
      break;

    case "error":
      send({
        type: "debug",
        id,
        message: `Codex error: ${event.message}`,
      });
      sendError(id, event.message);
      break;
  }
}

function handleCodexItemEvent(
  id: string,
  item: unknown,
  phase: "started" | "updated" | "completed"
): void {
  const typedItem = item as {
    id: string;
    type: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
    changes?: Array<{ path: string; kind: string }>;
    server?: string;
    tool?: string;
    arguments?: unknown;
    result?: { content: unknown[]; structured_content: unknown };
    error?: { message: string };
    query?: string;
    action?: Record<string, unknown>;
    items?: Array<{ text?: string; completed?: boolean }>;
    message?: string;
    parentToolUseId?: string | null;
    parent_tool_use_id?: string | null;
    turnUuid?: string | null;
    turn_uuid?: string | null;
    prompt?: string;
    status?: string;
    agentStatus?: string;
    agent_status?: string;
    senderThreadId?: string;
    sender_thread_id?: string;
    receiverThreadId?: string;
    receiver_thread_id?: string;
    newThreadId?: string;
    new_thread_id?: string;
  };
  const parentToolUseId = typedItem.parentToolUseId || typedItem.parent_tool_use_id || null;
  const turnUuid = typedItem.turnUuid || typedItem.turn_uuid || null;

  switch (typedItem.type) {
    case "agent_message":
      if (phase === "completed" && typedItem.text) {
        sendText(id, typedItem.text, parentToolUseId, turnUuid);
      } else if (phase === "updated" && typedItem.text) {
        // Stream partial text as it comes in
        sendText(id, typedItem.text, parentToolUseId, turnUuid);
      }
      break;

    case "reasoning":
      if (phase === "started") {
        updateReasoningState(
          id,
          typedItem.id || `reasoning-${Date.now()}`,
          "started",
          extractReasoningText(typedItem as unknown as Record<string, unknown>)
        );
      } else if (phase === "updated") {
        updateReasoningState(
          id,
          typedItem.id || `reasoning-${Date.now()}`,
          "updated",
          extractReasoningText(typedItem as unknown as Record<string, unknown>)
        );
      } else if (phase === "completed") {
        updateReasoningState(
          id,
          typedItem.id || `reasoning-${Date.now()}`,
          "completed",
          extractReasoningText(typedItem as unknown as Record<string, unknown>)
        );
      }
      break;

    case "command_execution":
      if (phase === "started") {
        sendToolStart(
          id,
          "Bash",
          { command: typedItem.command },
          typedItem.id,
          parentToolUseId,
          turnUuid
        );
      } else if (phase === "completed") {
        sendToolResult(
          id,
          "Bash",
          typedItem.aggregated_output || `exit code: ${typedItem.exit_code}`,
          typedItem.id,
          parentToolUseId,
          turnUuid
        );
      }
      break;

    case "file_change":
      if (phase === "started") {
        const filePaths =
          typedItem.changes?.map((c) => c.path).join(", ") || "unknown";
        sendToolStart(
          id,
          "Edit",
          { files: filePaths },
          typedItem.id,
          parentToolUseId,
          turnUuid
        );
      } else if (phase === "completed") {
        const summary =
          typedItem.changes
            ?.map((c) => `${c.kind}: ${c.path}`)
            .join("\n") || "File changes applied";
        sendToolResult(id, "Edit", summary, typedItem.id, parentToolUseId, turnUuid);
      }
      break;

    case "mcp_tool_call":
      if (phase === "started") {
        const toolName = typedItem.tool
          ? `mcp__${typedItem.server}__${typedItem.tool}`
          : `mcp__${typedItem.server}`;
        sendToolStart(id, toolName, typedItem.arguments, typedItem.id, parentToolUseId, turnUuid);
      } else if (phase === "completed") {
        const toolName = typedItem.tool
          ? `mcp__${typedItem.server}__${typedItem.tool}`
          : `mcp__${typedItem.server}`;
        let output = "";
        if (typedItem.error) {
          output = `Error: ${typedItem.error.message}`;
        } else if (typedItem.result) {
          output = JSON.stringify(typedItem.result.content);
        }
        sendToolResult(id, toolName, output, typedItem.id, parentToolUseId, turnUuid);
      }
      break;

    case "collab_tool_call":
    case "collabToolCall": {
      const taskType = typedItem.tool || "Task";
      const prompt = typedItem.prompt || "";
      const agentStatus = typedItem.agentStatus || typedItem.agent_status || "";
      const agentId =
        typedItem.receiverThreadId ||
        typedItem.receiver_thread_id ||
        typedItem.newThreadId ||
        typedItem.new_thread_id ||
        typedItem.id;
      const taskInput = {
        prompt,
        description: prompt,
        subagent_type: taskType,
        senderThreadId: typedItem.senderThreadId || typedItem.sender_thread_id,
        receiverThreadId: typedItem.receiverThreadId || typedItem.receiver_thread_id,
        newThreadId: typedItem.newThreadId || typedItem.new_thread_id,
      };

      if (phase === "started") {
        sendTaskStarted(id, typedItem.id, typedItem.id, prompt, taskType);
        sendToolStart(id, "Task", taskInput, typedItem.id, parentToolUseId, turnUuid);
        sendSubagentStart(id, agentId, taskType);
      } else if (phase === "completed") {
        sendToolResult(
          id,
          "Task",
          agentStatus || `Task ${typedItem.status || "completed"}`,
          typedItem.id,
          parentToolUseId,
          turnUuid
        );
        sendTaskCompleted(
          id,
          typedItem.id,
          typedItem.id,
          typedItem.status || "completed",
          agentStatus,
          taskType
        );
        sendSubagentStop(id, agentId, "");
      }
      break;
    }

    case "web_search":
    case "web_search_request":
      if (phase === "started") {
        const query =
          getWebSearchQuery(typedItem as unknown as Record<string, unknown>) ||
          "unknown";
        sendToolStart(
          id,
          "WebSearch",
          { query },
          typedItem.id,
          parentToolUseId,
          turnUuid
        );
      } else if (phase === "completed") {
        sendToolResult(
          id,
          "WebSearch",
          getWebSearchResultText(typedItem as unknown as Record<string, unknown>),
          typedItem.id,
          parentToolUseId,
          turnUuid
        );
      }
      break;

    case "error":
      if (phase === "completed") {
        sendError(id, (typedItem as { message?: string }).message || "Unknown error");
      }
      break;

    case "todo_list": {
      const input = toTodoWriteInput(typedItem as unknown as Record<string, unknown>);
      if (phase === "started" || phase === "updated") {
        sendToolStart(id, "TodoWrite", input, typedItem.id, parentToolUseId, turnUuid);
      } else if (phase === "completed") {
        sendToolResult(
          id,
          "TodoWrite",
          `Updated ${input.todos.length} todo item${input.todos.length === 1 ? "" : "s"}`,
          typedItem.id,
          parentToolUseId,
          turnUuid
        );
      }
      break;
    }
  }
}

async function handleCodexQuery(msg: QueryMessage): Promise<void> {
  const session = sessions.get(msg.id);
  if (!session) {
    sendError(msg.id, "Session not found");
    return;
  }

  const queryId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  session.currentQueryId = queryId;

  send({
    type: "debug",
    id: msg.id,
    message: `Starting Codex query ${queryId} with prompt: ${msg.prompt.slice(0, 100)}...`,
  });

  try {
    // Create abort controller for this query
    const abortController = new AbortController();
    session.abortController = abortController;

    // Get or create thread
    if (!session.codexThread) {
      const codex = getCodexInstance();
      const resumeId = session.sdkSessionId || session.passedSdkSessionId;
      const codexEffort = mapEffortForProvider(
        session.effortLevel,
        "openai",
        session.codexModel
      );
      const codexThreadOptions: ThreadOptions = {
        ...(session.codexModel ? { model: session.codexModel } : {}),
        ...(codexEffort
          ? {
              modelReasoningEffort:
                codexEffort as ThreadOptions["modelReasoningEffort"],
            }
          : {}),
        approvalPolicy: "never",
      };

      if (resumeId) {
        send({
          type: "debug",
          id: msg.id,
          message: `Resuming Codex thread: ${resumeId}`,
        });
        session.codexThread = codex.resumeThread(resumeId, codexThreadOptions);
      } else {
        send({
          type: "debug",
          id: msg.id,
          message: `Starting new Codex thread in ${session.cwd}`,
        });
        session.codexThread = codex.startThread({
          ...codexThreadOptions,
          workingDirectory: session.cwd,
        });
      }
    }

    // Build input - handle multimodal
    let input: string | Array<{ type: string; text?: string; path?: string }>;
    if (msg.images && msg.images.length > 0) {
      // Write images to temp files since Codex uses file paths
      const inputParts: Array<{
        type: string;
        text?: string;
        path?: string;
      }> = [];

      for (const img of msg.images) {
        const tmpDir = os.tmpdir();
        const ext = img.mediaType.split("/")[1] || "png";
        const tmpPath = path.join(
          tmpDir,
          `cw-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
        );
        fs.writeFileSync(tmpPath, Buffer.from(img.base64Data, "base64"));
        inputParts.push({ type: "local_image", path: tmpPath });
      }

      if (msg.prompt.trim()) {
        inputParts.push({ type: "text", text: msg.prompt });
      }
      input = inputParts;
    } else {
      input = msg.prompt;
    }

    // For Codex (OpenAI) sessions, prepend system prompt to first query
    // since Codex ThreadOptions has no systemPrompt field
    let shouldClearSystemPrompt = false;
    if (session.codexSystemPrompt) {
      if (typeof input === "string") {
        input = session.codexSystemPrompt + "\n\n" + input;
      } else {
        // Multimodal input: prepend as text part
        input = [{ type: "text", text: session.codexSystemPrompt }, ...input];
      }
      // Clear only after success so retries still include it.
      shouldClearSystemPrompt = true;
    }

    // Run streamed query
    const { events } = await session.codexThread.runStreamed(input as string, {
      signal: abortController.signal,
    });

    // Collect latest text per agent message item and emit only on completion.
    const latestAgentMessageTextById = new Map<string, string>();

    for await (const event of events) {
      // Track latest agent_message text updates without streaming to UI.
      if (
        event.type === "item.updated" &&
        (event.item as { type: string }).type === "agent_message"
      ) {
        const itemId = (event.item as { id?: string }).id || "agent_message";
        latestAgentMessageTextById.set(
          itemId,
          (event.item as { text?: string }).text || ""
        );
        continue;
      }

      // Emit the completed full agent message exactly once.
      if (
        event.type === "item.completed" &&
        (event.item as { type: string }).type === "agent_message"
      ) {
        const itemId = (event.item as { id?: string }).id || "agent_message";
        const finalText =
          (event.item as { text?: string }).text ||
          latestAgentMessageTextById.get(itemId) ||
          "";
        if (finalText) {
          sendText(msg.id, finalText);
        }
        continue;
      }

      handleCodexEvent(msg.id, event);
    }

    send({
      type: "debug",
      id: msg.id,
      message: `Codex query ${queryId} complete`,
    });

    if (session.currentQueryId === queryId) {
      if (shouldClearSystemPrompt) {
        session.codexSystemPrompt = undefined;
      }
      sendDone(msg.id);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    send({
      type: "debug",
      id: msg.id,
      message: `Codex query ${queryId} error: ${errorMessage}`,
    });

    if (
      session.currentQueryId === queryId &&
      session.codexModel !== OPENAI_MODEL_FALLBACK &&
      isUnsupportedChatGptAccountModelError(errorMessage)
    ) {
      send({
        type: "debug",
        id: msg.id,
        message: `Model ${session.codexModel || "<default>"} is not supported for ChatGPT-account Codex auth; retrying with ${OPENAI_MODEL_FALLBACK}`,
      });
      session.codexModel = OPENAI_MODEL_FALLBACK;
      session.codexThread = undefined;
      return handleCodexQuery(msg);
    }

    if (session.currentQueryId === queryId) {
      // Don't send error for abort
      if (errorMessage.includes("abort") || errorMessage.includes("cancel")) {
        sendDone(msg.id);
      } else {
        sendError(msg.id, errorMessage);
        // Fallback rate-limit detection when the SDK gives only an opaque error string.
        if (isRateLimitError(errorMessage)) {
          sendRateLimit(msg.id, { status: "rejected" });
        }
      }
    }
  } finally {
    if (session.currentQueryId === queryId) {
      session.abortController = undefined;
    }
  }
}

// Handler for generating repo descriptions using Claude SDK
async function handleGenerateRepoDescription(
  msg: GenerateRepoDescriptionMessage
): Promise<void> {
  const requestId = msg.id;

  send({
    type: "debug",
    id: requestId,
    message: `Starting repo description generation for: ${msg.repo_name} at ${msg.repo_path}`,
  });

  // Build the prompt that instructs Claude to explore the codebase
  const prompt = `You are analyzing a software repository to generate metadata for it. Your task is to explore the codebase and then submit a description, keywords, vocabulary, icon, and color.

Repository: ${msg.repo_name}
Path: ${msg.repo_path}

## Your Task

1. **Explore the codebase** - Use the available tools to understand the project.

2. **Generate metadata** by calling the \`submit_repo_description\` tool with:
   - **description**: A concise 1-2 sentence description of what the project does and its main technologies
   - **keywords**: ~20 categorical/conceptual terms for matching user intent:
     - Technology categories (e.g., "frontend", "backend", "database", "authentication")
     - Domain concepts (e.g., "e-commerce", "real-time", "streaming", "desktop app")
     - Feature types (e.g., "CRUD", "API", "dashboard", "CLI")
     - Action verbs users might say (e.g., "deploy", "migrate", "refactor", "test")
   - **vocabulary**: 20-50 project-specific lingo/jargon from the actual codebase:
     - Function/class/module names (e.g., "SdkSession", "useSettings", "transcribeAudio")
     - Custom types and interfaces (e.g., "RepoConfig", "WhisperProvider")
     - Project-specific terminology (e.g., "sidecar", "PTY", "hotkey")
     - Abbreviations and acronyms used (e.g., "SDK", "LLM", "MCP")
     - Library/framework specific terms (e.g., "Tauri", "Svelte", "xterm")
   - **icon**: Choose the best icon from this set: globe, browser, layout, paint-brush, palette, server, cloud, api, router, shield, smartphone, tablet, terminal, command-line, database, table, storage, brain, sparkles, cpu, package, puzzle, cube, book, document, pencil, flask, check-circle, bug, monitor, window, desktop, gamepad, play, chart-bar, chart-line, pie-chart, chat, mail, notification, camera, video, music, microphone, shopping-cart, credit-card, tag, lock, key, fingerprint, folder, file, archive, cloud-upload, git-branch, merge, fork, rocket, lightning, wrench, cog, heart, star, zap, code, brackets, hash, robot, users, earth
   - **color**: If you find a primary brand color (in README badges, package.json, CSS files, config files, logo), provide it as a hex string like "#6366f1". Otherwise set to null.

The keywords help match user prompts like "I want to add authentication" to the right repo.
The vocabulary helps speech-to-text correctly transcribe project-specific terms.

**IMPORTANT**: You MUST call the \`submit_repo_description\` tool to complete this task. Do not just output text.`;

  const options: Options = {
    cwd: msg.repo_path,
    permissionMode: "acceptEdits",
    model: "claude-haiku-4-5-20251001",
    mcpServers: {
      "repo-description-tools": repoDescriptionMcpServer,
    },
    allowedTools: [
      "mcp__repo-description-tools__submit_repo_description",
      "Read",
      "Glob",
      "Grep",
    ],
    // Don't load user/project settings for this one-shot operation
    settingSources: [],
    env: {
      ...process.env,
      CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: "120000",
    },
  };

  let result: {
    description: string;
    keywords: string[];
    vocabulary: string[];
    icon?: string | null;
    color?: string | null;
  } | null = null;

  try {
    send({ type: "debug", id: requestId, message: `Calling SDK query()...` });
    const iterator = query({
      prompt,
      options,
    });

    send({
      type: "debug",
      id: requestId,
      message: `Query iterator created, starting iteration...`,
    });
    for await (const message of iterator) {
      // Look for tool_use events with our submit tool
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (
            block.type === "tool_use" &&
            block.name ===
              "mcp__repo-description-tools__submit_repo_description"
          ) {
            // Extract the result from the tool input
            const input = block.input as {
              description: string;
              keywords: string[];
              vocabulary: string[];
              icon?: string;
              color?: string | null;
            };
            result = {
              description: input.description,
              keywords: input.keywords,
              vocabulary: input.vocabulary,
              icon: input.icon || null,
              color: input.color || null,
            };
            send({
              type: "debug",
              id: requestId,
              message: `Captured repo description result: ${result.description.slice(
                0,
                50
              )}...`,
            });
          }
        }
      }
    }

    if (result) {
      sendRepoDescriptionResult(requestId, result);
    } else {
      sendRepoDescriptionError(
        requestId,
        "Claude did not call the submit_repo_description tool"
      );
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    send({
      type: "debug",
      id: requestId,
      message: `Error generating repo description: ${errorMessage}`,
    });
    sendRepoDescriptionError(requestId, errorMessage);
  }
}

// Handler for generating repo descriptions using OpenAI Codex SDK
async function handleGenerateRepoDescriptionWithCodex(
  msg: GenerateRepoDescriptionWithCodexMessage
): Promise<void> {
  const requestId = msg.id;

  send({
    type: "debug",
    id: requestId,
    message: `Starting Codex repo description generation for: ${msg.repo_name} at ${msg.repo_path}`,
  });

  const prompt = `You are analyzing a software repository to generate metadata for it. Your task is to explore the codebase and then output a JSON result.

Repository: ${msg.repo_name}
Path: ${msg.repo_path}

## Your Task

1. **Explore the codebase** - Read key files like CLAUDE.md, README.md, package.json, Cargo.toml, etc. to understand the project.

2. **Output a JSON block** with the following fields:
   - **description**: A concise 1-2 sentence description of what the project does and its main technologies
   - **keywords**: ~20 categorical/conceptual terms for matching user intent:
     - Technology categories (e.g., "frontend", "backend", "database", "authentication")
     - Domain concepts (e.g., "e-commerce", "real-time", "streaming", "desktop app")
     - Feature types (e.g., "CRUD", "API", "dashboard", "CLI")
     - Action verbs users might say (e.g., "deploy", "migrate", "refactor", "test")
   - **vocabulary**: 20-50 project-specific lingo/jargon from the actual codebase:
     - Function/class/module names (e.g., "SdkSession", "useSettings", "transcribeAudio")
     - Custom types and interfaces (e.g., "RepoConfig", "WhisperProvider")
     - Project-specific terminology (e.g., "sidecar", "PTY", "hotkey")
     - Abbreviations and acronyms used (e.g., "SDK", "LLM", "MCP")
     - Library/framework specific terms (e.g., "Tauri", "Svelte", "xterm")
   - **icon**: Choose the best icon from this set: globe, browser, layout, paint-brush, palette, server, cloud, api, router, shield, smartphone, tablet, terminal, command-line, database, table, storage, brain, sparkles, cpu, package, puzzle, cube, book, document, pencil, flask, check-circle, bug, monitor, window, desktop, gamepad, play, chart-bar, chart-line, pie-chart, chat, mail, notification, camera, video, music, microphone, shopping-cart, credit-card, tag, lock, key, fingerprint, folder, file, archive, cloud-upload, git-branch, merge, fork, rocket, lightning, wrench, cog, heart, star, zap, code, brackets, hash, robot, users, earth
   - **color**: If you find a primary brand color (in README badges, CSS files, config files), provide it as a hex string like "#6366f1". Otherwise set to null.

**IMPORTANT**: Your final output MUST contain a JSON block wrapped in \`\`\`json ... \`\`\` fences with EXACTLY these fields:
\`\`\`json
{"description": "...", "keywords": ["..."], "vocabulary": ["..."], "icon": "...", "color": "#..." or null}
\`\`\``;

  try {
    const codex = getCodexInstance();
    const thread = codex.startThread({
      workingDirectory: msg.repo_path,
      skipGitRepoCheck: true,
    });

    send({
      type: "debug",
      id: requestId,
      message: `Codex thread started for repo description`,
    });

    // Collect all text output from Codex
    let fullText = "";
    const { events } = await thread.runStreamed(prompt, {});

    for await (const event of events) {
      // Collect text from agent_message items
      if (event.type === "item.completed") {
        const typedItem = event.item as { type: string; text?: string };
        if (typedItem.type === "agent_message" && typedItem.text) {
          fullText += typedItem.text;
        }
      }
    }

    send({
      type: "debug",
      id: requestId,
      message: `Codex response collected (${fullText.length} chars), parsing JSON...`,
    });

    // Parse JSON from the response text
    // Look for ```json ... ``` block first, then try raw JSON
    let jsonStr: string | null = null;
    const jsonBlockMatch = fullText.match(/```json\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
      jsonStr = jsonBlockMatch[1].trim();
    } else {
      // Try to find a raw JSON object
      const jsonObjMatch = fullText.match(/\{[\s\S]*"description"[\s\S]*\}/);
      if (jsonObjMatch) {
        jsonStr = jsonObjMatch[0];
      }
    }

    if (!jsonStr) {
      sendRepoDescriptionError(
        requestId,
        "Codex did not output a valid JSON block with repo description"
      );
      return;
    }

    try {
      const parsed = JSON.parse(jsonStr) as {
        description: string;
        keywords: string[];
        vocabulary: string[];
        icon?: string;
        color?: string | null;
      };

      if (!parsed.description || !parsed.keywords || !parsed.vocabulary) {
        sendRepoDescriptionError(
          requestId,
          "Codex JSON output missing required fields (description, keywords, vocabulary)"
        );
        return;
      }

      sendRepoDescriptionResult(requestId, {
        description: parsed.description,
        keywords: parsed.keywords,
        vocabulary: parsed.vocabulary,
        icon: parsed.icon || null,
        color: parsed.color || null,
      });
    } catch (parseErr) {
      sendRepoDescriptionError(
        requestId,
        `Failed to parse Codex JSON output: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
      );
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    send({
      type: "debug",
      id: requestId,
      message: `Error generating repo description with Codex: ${errorMessage}`,
    });
    sendRepoDescriptionError(requestId, errorMessage);
  }
}

// Handler for generating launch profiles using Claude SDK
async function handleGenerateLaunchProfile(
  msg: GenerateLaunchProfileMessage
): Promise<void> {
  const requestId = msg.id;

  send({
    type: "debug",
    id: requestId,
    message: `Starting launch profile generation for: ${msg.repo_name} at ${msg.repo_path}`,
  });

  const prompt = `You are analyzing a software repository to discover runnable commands and services. Your task is to explore the codebase and generate launch commands and profiles.

Repository: ${msg.repo_name}
Path: ${msg.repo_path}

## Your Task

1. **Explore the codebase** - Look at:
   - package.json files (npm/yarn/pnpm scripts like dev, start, serve, build, test)
   - docker-compose.yml / compose.yml files (services)
   - Makefile files (targets like dev, run, serve)
   - Cargo.toml files (cargo run)
   - pyproject.toml / manage.py files (Django, FastAPI, Flask)
   - Procfile, turbo.json, nx.json for task runners
   - IMPORTANT: Check subdirectories too! Monorepos often have separate frontend/, backend/, api/, packages/* folders with their own scripts.

2. **Generate commands** - Each command should be a single runnable service or script:
   - Use descriptive short names (e.g., "Frontend Dev", "API Server", "Database", "Worker")
   - For commands in subdirectories, set working_dir to the relative path (e.g., "frontend", "packages/api")
   - Include the package manager appropriate for the project (npm, yarn, pnpm, etc.)

3. **Generate profiles** - Group commands into logical sets users would launch together:
   - "Full Stack" or "All" - everything needed for full development
   - Subsets like "Frontend Only", "API + DB", etc.
   - Reference commands by their exact name

**IMPORTANT**: You MUST call the \`submit_launch_profile\` tool to complete this task. Do not just output text.`;

  const options: Options = {
    cwd: msg.repo_path,
    permissionMode: "acceptEdits",
    model: "claude-haiku-4-5-20251001",
    mcpServers: {
      "launch-profile-tools": launchProfileMcpServer,
    },
    allowedTools: [
      "mcp__launch-profile-tools__submit_launch_profile",
      "Read",
      "Glob",
      "Grep",
    ],
    settingSources: [],
    env: {
      ...process.env,
      CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: "120000",
    },
  };

  let result: {
    commands: Array<{ name: string; command: string; working_dir?: string }>;
    profiles: Array<{ name: string; command_names: string[] }>;
  } | null = null;

  try {
    send({ type: "debug", id: requestId, message: `Calling SDK query()...` });
    const iterator = query({ prompt, options });

    for await (const message of iterator) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (
            block.type === "tool_use" &&
            block.name === "mcp__launch-profile-tools__submit_launch_profile"
          ) {
            const input = block.input as {
              commands: Array<{ name: string; command: string; working_dir?: string }>;
              profiles: Array<{ name: string; command_names: string[] }>;
            };
            result = {
              commands: input.commands,
              profiles: input.profiles,
            };
            send({
              type: "debug",
              id: requestId,
              message: `Captured launch profile: ${result.commands.length} commands, ${result.profiles.length} profiles`,
            });
          }
        }
      }
    }

    if (result) {
      sendLaunchProfileResult(requestId, result);
    } else {
      sendLaunchProfileError(
        requestId,
        "Claude did not call the submit_launch_profile tool"
      );
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    send({
      type: "debug",
      id: requestId,
      message: `Error generating launch profile: ${errorMessage}`,
    });
    sendLaunchProfileError(requestId, errorMessage);
  }
}

// Handler for generating launch profiles using Codex SDK
async function handleGenerateLaunchProfileWithCodex(
  msg: GenerateLaunchProfileWithCodexMessage
): Promise<void> {
  const requestId = msg.id;

  send({
    type: "debug",
    id: requestId,
    message: `Starting Codex launch profile generation for: ${msg.repo_name} at ${msg.repo_path}`,
  });

  const prompt = `You are analyzing a software repository to discover runnable commands and services. Your task is to explore the codebase and output a JSON result.

Repository: ${msg.repo_name}
Path: ${msg.repo_path}

## Your Task

1. **Explore the codebase** - Look at:
   - package.json files (npm/yarn/pnpm scripts like dev, start, serve, build, test)
   - docker-compose.yml / compose.yml files (services)
   - Makefile files (targets like dev, run, serve)
   - Cargo.toml files (cargo run)
   - pyproject.toml / manage.py files (Django, FastAPI, Flask)
   - IMPORTANT: Check subdirectories too! Monorepos often have separate frontend/, backend/, packages/* folders.

2. **Output a JSON block** with:
   - **commands**: Array of runnable commands/services, each with:
     - \`name\`: Short display name (e.g., "Frontend Dev", "API Server")
     - \`command\`: Shell command to run (e.g., "npm run dev")
     - \`working_dir\`: (optional) Relative path from repo root for subdirectory commands
   - **profiles**: Array of launch profiles, each with:
     - \`name\`: Profile name (e.g., "Full Stack", "Frontend Only")
     - \`command_names\`: Array of command names to include

**IMPORTANT**: Output a JSON block wrapped in \`\`\`json ... \`\`\` fences:
\`\`\`json
{"commands": [{"name": "...", "command": "...", "working_dir": "..."}], "profiles": [{"name": "...", "command_names": ["..."]}]}
\`\`\``;

  try {
    const codex = getCodexInstance();
    const thread = codex.startThread({
      workingDirectory: msg.repo_path,
      skipGitRepoCheck: true,
    });

    let fullText = "";
    const { events } = await thread.runStreamed(prompt, {});

    for await (const event of events) {
      if (event.type === "item.completed") {
        const typedItem = event.item as { type: string; text?: string };
        if (typedItem.type === "agent_message" && typedItem.text) {
          fullText += typedItem.text;
        }
      }
    }

    send({
      type: "debug",
      id: requestId,
      message: `Codex response collected (${fullText.length} chars), parsing JSON...`,
    });

    let jsonStr: string | null = null;
    const jsonBlockMatch = fullText.match(/```json\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
      jsonStr = jsonBlockMatch[1].trim();
    } else {
      const jsonObjMatch = fullText.match(/\{[\s\S]*"commands"[\s\S]*\}/);
      if (jsonObjMatch) {
        jsonStr = jsonObjMatch[0];
      }
    }

    if (!jsonStr) {
      sendLaunchProfileError(
        requestId,
        "Codex did not output a valid JSON block with launch profile"
      );
      return;
    }

    try {
      const parsed = JSON.parse(jsonStr) as {
        commands: Array<{ name: string; command: string; working_dir?: string }>;
        profiles: Array<{ name: string; command_names: string[] }>;
      };

      if (!parsed.commands || !parsed.profiles) {
        sendLaunchProfileError(
          requestId,
          "Codex JSON output missing required fields (commands, profiles)"
        );
        return;
      }

      sendLaunchProfileResult(requestId, {
        commands: parsed.commands,
        profiles: parsed.profiles,
      });
    } catch (parseErr) {
      sendLaunchProfileError(
        requestId,
        `Failed to parse Codex JSON output: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
      );
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    send({
      type: "debug",
      id: requestId,
      message: `Error generating launch profile with Codex: ${errorMessage}`,
    });
    sendLaunchProfileError(requestId, errorMessage);
  }
}

// =============================================================================
// Validation pipeline one-shot agents (Claude only)
// =============================================================================

const VALIDATION_MCP_SERVER_NAME = "validation-tools";

// Shared finding shape used by review/evidence/housekeeping submit tools.
// severity: error|warning|info; action: auto-fix|ask-user|no-op.
const validationFindingShape = {
  title: z
    .string()
    .describe("Short imperative title for the finding (a few words, no file paths)"),
  severity: z.enum(["error", "warning", "info"]),
  file: z.string().optional(),
  line: z.number().optional(),
  description: z.string(),
  action: z.enum(["auto-fix", "ask-user", "no-op"]),
};

const validationSubmitAck = async () => ({
  content: [{ type: "text" as const, text: "Structured output submitted." }],
});

// Build the single role-specific submit tool for a validation agent, wrapped
// in an in-process MCP server. Returns the server + the fully-qualified tool
// name the agent must call (mcp__<server>__<tool>).
function buildValidationRole(role: ValidationRole): {
  server: ReturnType<typeof createSdkMcpServer>;
  toolName: string;
  readOnly: boolean;
} {
  let submitTool;
  let toolName: string;
  switch (role) {
    case "review": {
      toolName = "submit_review";
      submitTool = tool(
        "submit_review",
        "Submit your code review. You MUST call this exactly once to complete the review.",
        {
          // Field order is deliberate: findings before risk.
          findings: z
            .array(z.object(validationFindingShape))
            .describe("All findings from the review pass (may be empty)"),
          summary: z.string().describe("Short overall summary of the review"),
          risk_level: z
            .enum(["low", "medium", "high"])
            .describe("Overall risk level introduced by the changes"),
          risk_rationale: z
            .string()
            .describe("One or two sentences justifying the risk level"),
        },
        validationSubmitAck
      );
      break;
    }
    case "verify": {
      toolName = "submit_verification";
      submitTool = tool(
        "submit_verification",
        "Submit your adversarial verification verdict. You MUST call this exactly once.",
        {
          verdict: z
            .enum(["confirmed", "refuted"])
            .describe("confirmed = the finding is a real issue; refuted = could not confirm a concrete failure"),
          reason: z.string().describe("Justification for the verdict"),
        },
        validationSubmitAck
      );
      break;
    }
    case "evidence": {
      toolName = "submit_evidence";
      submitTool = tool(
        "submit_evidence",
        "Submit the evidence report demonstrating the intent is satisfied. You MUST call this exactly once.",
        {
          findings: z
            .array(z.object(validationFindingShape))
            .describe("Findings (e.g. a warning when sufficient evidence is not possible); may be empty"),
          tested: z
            .array(z.string())
            .describe("What was tested/demonstrated"),
          testing_summary: z
            .string()
            .describe("Summary of how the intent was verified"),
          artifacts: z
            .array(
              z.object({
                kind: z.string().describe("Artifact kind (e.g. 'transcript', 'screenshot', 'output')"),
                label: z.string().describe("Human-readable label"),
                path: z.string().describe("Path or reference to the artifact"),
              })
            )
            .describe("Product-level evidence artifacts (may be empty)"),
        },
        validationSubmitAck
      );
      break;
    }
    case "docs":
    case "lint": {
      // docs and lint both use submit_housekeeping.
      toolName = "submit_housekeeping";
      submitTool = tool(
        "submit_housekeeping",
        "Submit your housekeeping findings. You MUST call this exactly once.",
        {
          findings: z
            .array(
              z.object({
                ...validationFindingShape,
                category: z
                  .enum(["documentation", "lint"])
                  .describe("Which housekeeping category this finding belongs to"),
              })
            )
            .describe("All housekeeping findings (may be empty)"),
          summary: z.string().describe("Short overall summary"),
        },
        validationSubmitAck
      );
      break;
    }
  }

  const server = createSdkMcpServer({
    name: VALIDATION_MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [submitTool],
  });

  return {
    server,
    toolName: `mcp__${VALIDATION_MCP_SERVER_NAME}__${toolName}`,
    // review/verify/docs are read-only (git-only Bash); evidence/lint may run commands freely.
    readOnly: role === "review" || role === "verify" || role === "docs",
  };
}

interface ValidationCapture {
  structured: unknown;
  transcript: string;
  sdkSessionId?: string;
  usage?: Record<string, number>;
}

// One-line summary of a tool call's input for the live activity feed.
function summarizeValidationToolInput(toolName: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  const first = (...keys: string[]): string => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  let detail: string;
  switch (toolName) {
    case "Bash":
      detail = first("command");
      break;
    case "Read":
    case "Edit":
    case "Write":
      detail = first("file_path");
      break;
    case "Grep":
    case "Glob":
      detail = first("pattern");
      break;
    default:
      detail = first("description", "summary", "prompt", "query");
      if (!detail) {
        try {
          detail = JSON.stringify(obj);
        } catch {
          detail = "";
        }
      }
  }
  detail = detail.replace(/\s+/g, " ").trim();
  return detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
}

// Run a single one-shot validation query attempt. Throws on query failure so
// the caller can retry without `resume`.
async function runValidationQuery(
  msg: ValidationAgentMessage,
  role: ReturnType<typeof buildValidationRole>,
  resumeSessionId: string | undefined
): Promise<ValidationCapture> {
  const options: Options = {
    cwd: msg.cwd,
    permissionMode: "default",
    model: msg.model,
    mcpServers: {
      [VALIDATION_MCP_SERVER_NAME]: role.server,
    },
    allowedTools: [role.toolName, "Read", "Glob", "Grep", "Bash"],
    // One-shot: never load user/project settings, CLAUDE.md, or filesystem skills.
    settingSources: [],
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    // Guard Bash for read-only roles: only `git ` commands are allowed.
    canUseTool: async (toolName: string, input: Record<string, unknown>) => {
      if (toolName === "Bash" && role.readOnly) {
        const command = String((input as { command?: unknown }).command ?? "").trim();
        if (!command.startsWith("git ")) {
          return {
            behavior: "deny" as const,
            message:
              "You are a read-only review agent. The only shell commands you may run are git commands (e.g. `git diff`, `git log`, `git show`). Use Read/Glob/Grep to inspect files; do not run tests, builds, or other commands.",
          };
        }
      }
      return { behavior: "allow" as const, updatedInput: input };
    },
    env: {
      ...process.env,
      // Validation agents run autonomously: unlike interactive sessions there
      // can be NO SDK->CLI traffic for many minutes (long generations, built-in
      // tools that never hit canUseTool). MCP responses don't reset the CLI's
      // inactivity timer (SDK issue #114), so a short timeout closes the
      // control stream mid-run and every later in-process MCP submit_* call
      // dies with "Stream closed". Use a value larger than any run; the
      // executor enforces its own activity-aware timeout.
      CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: "14400000",
    },
  };

  // Effort: reuse the same native Claude effort plumbing sessions use.
  const mappedEffort = mapEffortForProvider(msg.effort, "claude");
  if (mappedEffort) {
    options.effort = mappedEffort as Options["effort"];
  }

  let sdkSessionId: string | undefined;
  let usage: Record<string, number> | undefined;
  const textParts: string[] = [];
  // Every submit-tool call the agent made, in order, keyed by tool_use id so
  // tool_result acks can be correlated. The agent may call the tool more than
  // once — e.g. retrying after a failed MCP call, sometimes with trimmed or
  // minimal "probe" payloads — so blindly keeping the last input can replace
  // the real review with a degenerate one.
  const submissions = new Map<string, { input: unknown; acked: boolean }>();

  const iterator = query({ prompt: msg.prompt, options });
  for await (const message of iterator) {
    if (message.type === "system" && message.subtype === "init") {
      sdkSessionId = message.session_id;
    } else if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          const text = (block as { text?: string }).text;
          if (text) {
            textParts.push(text);
            const trimmed = text.replace(/\s+/g, " ").trim();
            if (trimmed) {
              sendValidationAgentProgress(msg.id, {
                kind: "text",
                text: trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed,
              });
            }
          }
        } else if (block.type === "tool_use") {
          sendValidationAgentProgress(msg.id, {
            kind: "tool",
            tool: block.name,
            detail: summarizeValidationToolInput(
              block.name,
              (block as { input?: unknown }).input
            ),
          });
          if (block.name === role.toolName) {
            const toolUseId =
              (block as { id?: string }).id ?? `submission-${submissions.size}`;
            submissions.set(toolUseId, { input: block.input, acked: false });
          }
        }
      }
    } else if (message.type === "user") {
      // Correlate tool_result acks with submit-tool calls. A successful MCP
      // ack marks the submission as authoritative; an is_error result (e.g.
      // "Stream closed" when the CLI's inactivity timer killed the control
      // stream) leaves it unacked.
      const content = (message as { message?: { content?: unknown } }).message
        ?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as {
            type?: string;
            tool_use_id?: string;
            is_error?: boolean;
          };
          if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
            const sub = submissions.get(b.tool_use_id);
            if (sub && !b.is_error) {
              sub.acked = true;
            }
          }
        }
      }
    } else if (message.type === "result") {
      const r = message as unknown as {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        total_cost_usd?: number;
        duration_ms?: number;
      };
      if (r.usage) {
        usage = {
          inputTokens: r.usage.input_tokens || 0,
          outputTokens: r.usage.output_tokens || 0,
          cacheReadTokens: r.usage.cache_read_input_tokens || 0,
          cacheCreationTokens: r.usage.cache_creation_input_tokens || 0,
          totalCostUsd: r.total_cost_usd || 0,
          durationMs: r.duration_ms || 0,
        };
      }
    }
  }

  // Pick the authoritative submission: the newest acked one. If the MCP
  // server never acked anything (stream closed on every attempt), fall back
  // to the largest payload — failed-submit retries tend to shrink (trimmed
  // payloads, minimal probes), so the fullest attempt is the real one.
  let structured: unknown = undefined;
  const all = [...submissions.values()];
  const acked = all.filter((s) => s.acked);
  if (acked.length > 0) {
    structured = acked[acked.length - 1].input;
  } else {
    let bestLen = -1;
    for (const s of all) {
      let len = 0;
      try {
        len = JSON.stringify(s.input)?.length ?? 0;
      } catch {
        len = 0;
      }
      if (len > bestLen) {
        bestLen = len;
        structured = s.input;
      }
    }
  }

  return {
    structured,
    transcript: textParts.join("\n\n"),
    sdkSessionId,
    usage,
  };
}

async function handleValidationAgent(msg: ValidationAgentMessage): Promise<void> {
  const requestId = msg.id;
  send({
    type: "debug",
    id: requestId,
    message: `Starting validation agent (role=${msg.role}, model=${msg.model}, resume=${msg.resumeSessionId ? "yes" : "no"}) at ${msg.cwd}`,
  });

  const role = buildValidationRole(msg.role);

  try {
    let capture: ValidationCapture;
    try {
      capture = await runValidationQuery(msg, role, msg.resumeSessionId);
    } catch (err) {
      // If a resumed query errors immediately, retry once with a fresh session.
      if (msg.resumeSessionId) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        send({
          type: "debug",
          id: requestId,
          message: `Resumed validation query failed (${errorMessage}); retrying without resume`,
        });
        capture = await runValidationQuery(msg, role, undefined);
      } else {
        throw err;
      }
    }

    if (typeof capture.structured === "undefined" || capture.structured === null) {
      sendValidationAgentError(
        requestId,
        "agent did not submit structured output"
      );
      return;
    }

    sendValidationAgentResult(requestId, {
      structured: capture.structured,
      transcript: capture.transcript,
      sdkSessionId: capture.sdkSessionId,
      usage: capture.usage,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    send({
      type: "debug",
      id: requestId,
      message: `Validation agent error: ${errorMessage}`,
    });
    sendValidationAgentError(requestId, errorMessage);
  }
}

async function handleCreate(msg: CreateMessage): Promise<void> {
  const options: Options = {
    cwd: msg.cwd,
    permissionMode: "acceptEdits",
    // Load CLAUDE.md, settings, and filesystem-backed Skills like Claude Code does
    settingSources: ["user", "project", "local"],
    ...(msg.model && { model: msg.model }),
    ...msg.options,
    // Allow all MCP tools to execute without permission prompts
    // This callback fires when Claude would show a permission prompt
    canUseTool: async (toolName: string, input: Record<string, unknown>) => {
      // Intercept AskUserQuestion: emit to frontend, wait for user answers
      if (toolName === "AskUserQuestion") {
        const askInput = input as { questions?: PlanningQuestion[] };
        if (askInput.questions && Array.isArray(askInput.questions)) {
          send({ type: "debug", id: msg.id, message: `AskUserQuestion intercepted with ${askInput.questions.length} questions` });
          sendAskUserQuestions(msg.id, askInput.questions);
          const answers = await new Promise<Record<string, string>>((resolve, reject) => {
            const s = sessions.get(msg.id);
            if (s) { s.pendingAskUserAnswer = { resolve, reject }; }
            else { reject(new Error("Session not found for AskUserQuestion")); }
          });
          send({ type: "debug", id: msg.id, message: `AskUserQuestion answered: ${JSON.stringify(answers)}` });
          return { behavior: "allow" as const, updatedInput: { questions: askInput.questions, answers } };
        }
      }
      // Intercept ExitPlanMode (native SDK plan mode): block until user approves or denies.
      // canUseTool IS called for ExitPlanMode (confirmed by Anthropic engineers, issue #12288).
      // The SDK awaits this promise, so the agent genuinely pauses here.
      if (toolName === "ExitPlanMode") {
        const exitInput = input as { allowedPrompts?: Array<{ tool: string; prompt: string }>; plan?: string };
        send({ type: "debug", id: msg.id, message: `ExitPlanMode intercepted via canUseTool, waiting for user approval` });
        sendPlanApprovalRequest(msg.id, exitInput.allowedPrompts || [], exitInput.plan || undefined);

        const decision = await new Promise<{ action: string; feedback?: string }>((resolve, reject) => {
          const s = sessions.get(msg.id);
          if (s) { s.pendingPlanApproval = { resolve, reject }; }
          else { reject(new Error("Session not found for ExitPlanMode")); }
        });

        send({ type: "debug", id: msg.id, message: `ExitPlanMode decision: ${decision.action}` });

        if (decision.action === 'deny') {
          // Deny: agent stays in plan mode, sees feedback, can revise and call ExitPlanMode again.
          return {
            behavior: "deny" as const,
            message: decision.feedback
              ? `The user reviewed your plan and requested changes:\n\n${decision.feedback}\n\nPlease update the plan file to address this feedback, then call ExitPlanMode again when ready.`
              : "The user rejected the plan. Please revise it and call ExitPlanMode again when ready.",
          };
        } else if (decision.action === 'approve_new_session') {
          // Planning session ends -- deny with interrupt so the query terminates.
          // The frontend spawns a new implementation session.
          return {
            behavior: "deny" as const,
            message: "Planning complete. Implementation will start in a new session.",
            interrupt: true,
          };
        }

        // approve (plain or with note)
        if (decision.feedback) {
          const noteQueryId = `${Date.now()}-approve-note`;
          const s = sessions.get(msg.id);
          if (s) {
            s.claudeQueue.push({ queryId: noteQueryId, prompt: decision.feedback });
            send({ type: "debug", id: msg.id, message: `ExitPlanMode approve with note: queued as ${noteQueryId}` });
          }
        }
        // Allow: SDK executes ExitPlanMode, agent exits plan mode and continues.
        return { behavior: "allow" as const, updatedInput: input };
      }
      // Allow all MCP tools (they start with "mcp__")
      if (toolName.startsWith("mcp__")) {
        send({
          type: "debug",
          id: msg.id,
          message: `Auto-allowing MCP tool: ${toolName}`,
        });
        return { behavior: "allow" as const, updatedInput: input };
      }
      // For non-MCP tools, allow by default (acceptEdits handles file operations)
      return { behavior: "allow" as const, updatedInput: input };
    },
  };

  // Extend the SDK's stream-close inactivity timeout. MCP server tool responses
  // don't reset lastActivityTime (SDK issue #114), so the default timeout fires
  // prematurely during MCP tool calls, causing "Stream closed" errors on
  // subsequent tool permission requests.
  options.env = {
    ...process.env,
    ...(options.env ?? {}),
    // Per-session extras from the app (e.g., GH_TOKEN pinning a gh account per repo)
    ...(msg.env ?? {}),
    CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: "120000",
  };
  // A session pinned to a Claude account profile (CLAUDE_CONFIG_DIR) must not
  // fall back to the process-global ANTHROPIC_API_KEY — API-key auth outranks
  // the profile's OAuth credentials in Claude Code's precedence chain.
  if (msg.env?.CLAUDE_CONFIG_DIR && !msg.env.ANTHROPIC_API_KEY) {
    delete options.env.ANTHROPIC_API_KEY;
  }

  // Apply auto-compaction policy. Claude Code reads these env vars at process spawn.
  //   0            -> DISABLE_AUTO_COMPACT=1 (the PCT_OVERRIDE cannot disable — values >83 are clamped to default).
  //   1-99         -> CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (lower fires compaction earlier).
  //   null/100     -> leave unset (Claude's built-in default, ~83%).
  // We must spread process.env because setting options.env replaces the inherited env entirely.
  if (typeof msg.autocompact_pct === "number") {
    const pct = Math.round(msg.autocompact_pct);
    const nextEnv: Record<string, string | undefined> = {
      ...process.env,
      ...options.env,
    };
    if (pct <= 0) {
      nextEnv.DISABLE_AUTO_COMPACT = "1";
      delete nextEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    } else if (pct < 100) {
      nextEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(Math.max(1, pct));
      delete nextEnv.DISABLE_AUTO_COMPACT;
    }
    options.env = nextEnv;
  }

  // Preserve Claude Code's built-in prompt and tool setup so repo/global Skills
  // can load, while still appending session-specific instructions from the app.
  options.systemPrompt = buildClaudeSystemPrompt(
    msg.system_prompt,
    options.systemPrompt
  );
  if (!options.tools) {
    options.tools = { type: "preset", preset: "claude_code" };
  }

  // Register external MCP servers if provided
  // Also add a wildcard pattern to allowedTools to permit all tools from registered MCP servers
  if (msg.mcp_servers && msg.mcp_servers.length > 0) {
    const enabledServers = msg.mcp_servers.filter((s) => s.enabled);
    send({
      type: "debug",
      id: msg.id,
      message: `Registering ${enabledServers.length} external MCP servers`,
    });

    // Collect server IDs for allowedTools patterns
    const registeredServerIds: string[] = [];

    for (const server of enabledServers) {
      try {
        if (server.server_type === "stdio" && server.command) {
          // Stdio server config
          options.mcpServers = {
            ...options.mcpServers,
            [server.id]: {
              command: server.command,
              args: server.args || [],
              env: server.env,
            },
          };
          registeredServerIds.push(server.id);
          send({
            type: "debug",
            id: msg.id,
            message: `Registered stdio MCP server: ${server.name} (${server.id})`,
          });
        } else if (server.server_type === "http" && server.url) {
          // HTTP server config with optional headers (for auth)
          const httpConfig: {
            type: "http";
            url: string;
            headers?: Record<string, string>;
          } = {
            type: "http",
            url: server.url,
          };
          if (server.headers && Object.keys(server.headers).length > 0) {
            httpConfig.headers = server.headers;
            send({
              type: "debug",
              id: msg.id,
              message: `HTTP server ${server.name} has ${
                Object.keys(server.headers).length
              } custom headers`,
            });
          }
          options.mcpServers = {
            ...options.mcpServers,
            [server.id]: httpConfig,
          };
          registeredServerIds.push(server.id);
          send({
            type: "debug",
            id: msg.id,
            message: `Registered HTTP MCP server: ${server.name} (${server.id})`,
          });
        } else if (server.server_type === "sse" && server.url) {
          // SSE server config with optional headers (for auth)
          const sseConfig: {
            type: "sse";
            url: string;
            headers?: Record<string, string>;
          } = {
            type: "sse",
            url: server.url,
          };
          if (server.headers && Object.keys(server.headers).length > 0) {
            sseConfig.headers = server.headers;
            send({
              type: "debug",
              id: msg.id,
              message: `SSE server ${server.name} has ${
                Object.keys(server.headers).length
              } custom headers`,
            });
          }
          options.mcpServers = {
            ...options.mcpServers,
            [server.id]: sseConfig,
          };
          registeredServerIds.push(server.id);
          send({
            type: "debug",
            id: msg.id,
            message: `Registered SSE MCP server: ${server.name} (${server.id})`,
          });
        } else {
          send({
            type: "debug",
            id: msg.id,
            message: `Skipping MCP server ${server.name}: missing required config`,
          });
        }
      } catch (err) {
        send({
          type: "debug",
          id: msg.id,
          message: `Failed to register MCP server ${server.name}: ${err}`,
        });
      }
    }

    // Add wildcard patterns for all registered MCP servers to allowedTools
    // Pattern: mcp__<server_id>__* allows all tools from that server
    if (registeredServerIds.length > 0) {
      const mcpToolPatterns = registeredServerIds.map((id) => `mcp__${id}__*`);
      options.allowedTools = [
        ...(options.allowedTools || []),
        ...mcpToolPatterns,
      ];
      send({
        type: "debug",
        id: msg.id,
        message: `Added MCP tool patterns to allowedTools: ${mcpToolPatterns.join(
          ", "
        )}`,
      });
    }
  }

  options.allowedTools = appendAllowedTool(options.allowedTools, "Skill");

  const provider = inferProvider(msg.provider, msg.model);
  const openaiMode: OpenAiExecutionMode =
    provider === "openai" ? "app_server" : "sdk";

  sessions.set(msg.id, {
    cwd: msg.cwd,
    provider,
    openaiMode,
    options,
    passedSdkSessionId: msg.sdk_session_id, // SDK session ID for proper resume
    conversationHistory: msg.messages, // Store conversation history for restored sessions (DEPRECATED)
    codexModel: provider === "openai" ? msg.model : undefined,
    codexSystemPrompt: provider === "openai" ? msg.system_prompt : undefined,
    extraEnv: msg.env,
    claudeQueue: [],
    claudeProcessing: false,
    forkFromSdkSessionId: msg.fork_from_sdk_session_id, // Fork: SDK session ID to fork from
    forkAtMessageUuid: msg.fork_at_message_uuid, // Fork: message UUID to fork at
  });

  if (provider === "openai") {
    send({
      type: "debug",
      id: msg.id,
      message: `OpenAI mode: ${openaiMode}`,
    });
  }

  if (msg.sdk_session_id) {
    send({
      type: "debug",
      id: msg.id,
      message: `Session created with SDK session ID for resume: ${msg.sdk_session_id}`,
    });
  } else if (msg.messages && msg.messages.length > 0) {
    send({
      type: "debug",
      id: msg.id,
      message: `Session created with ${msg.messages.length} history messages (DEPRECATED - use sdk_session_id)`,
    });
  }

  if (provider === "claude") {
    const sp = options.systemPrompt;
    const systemPromptMode =
      typeof sp === "string"
        ? "custom-string"
        : sp && typeof sp === "object" && !Array.isArray(sp) && sp.type === "preset" && sp.preset === "claude_code"
          ? sp.append?.trim()
            ? "claude_code+append"
            : "claude_code"
          : "unset";
    const t = options.tools;
    const toolsMode =
      Array.isArray(t)
        ? `custom-list(${t.length})`
        : t && typeof t === "object" && !Array.isArray(t) && t.type === "preset" && t.preset === "claude_code"
          ? "claude_code"
          : "unset";
    const allowedTools = options.allowedTools;
    const skillToolAccess =
      !allowedTools
        ? "unrestricted"
        : allowedTools.includes("Skill")
          ? "explicitly-allowed"
          : "not-listed";

    send({
      type: "debug",
      id: msg.id,
      message:
        `[claude skills] systemPrompt=${systemPromptMode} ` +
        `tools=${toolsMode} ` +
        `settingSources=${options.settingSources?.join(",") || "(none)"} ` +
        `skillToolAccess=${skillToolAccess} ` +
        `allowedToolsRestricted=${Array.isArray(allowedTools)}`,
    });
  }

  // Detect parallel sessions in the same CWD and queue notifications
  const parallelNotification =
    "<system-message>\n" +
    "Another AI agent session was just started in this same repository. " +
    "Multiple agents are now working here simultaneously. " +
    "Re-check the current state of any files before modifying them to avoid conflicts.\n" +
    "</system-message>";

  for (const [existingId, existingSession] of sessions) {
    if (
      existingId !== msg.id &&
      existingSession.cwd === msg.cwd &&
      existingSession.provider === "claude"
    ) {
      existingSession.pendingParallelNotification = parallelNotification;
      // Emit event so the frontend can show an immediate UI notification
      send({
        type: "parallel_session_notification",
        id: existingId,
        message:
          "Another agent session was started in this repository. Multiple agents are now working here simultaneously.",
      } as unknown as Parameters<typeof send>[0]); // Custom event type handled by Rust bridge
      send({
        type: "debug",
        id: existingId,
        message: `Parallel session detected: queued notification (new session ${msg.id})`,
      });
    }
  }

  send({ type: "created", id: msg.id });
}

// Content block types for multimodal prompts (matching Anthropic API format)
type TextBlock = { type: "text"; text: string };
type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};
type ContentBlock = TextBlock | ImageBlock;

// SDKUserMessage type for streaming input (matches SDK types)
interface SDKUserMessageForInput {
  type: "user";
  message: {
    role: "user";
    content: string | ContentBlock[];
  };
  parent_tool_use_id: null;
  session_id: string;
}

// Persistent async message queue for streaming input mode.
// Unlike the single-shot generator, this queue keeps the SDK's streamInput()
// alive across multiple follow-up messages. The SDK's for-await loop blocks on
// next() when the queue is empty, and resumes when enqueue() pushes a new item.
// Calling done() signals completion, letting streamInput() call endInput() to
// cleanly close stdin.
class MessageQueue implements AsyncIterable<SDKUserMessageForInput> {
  private queue: SDKUserMessageForInput[] = [];
  private readResolve?: (result: IteratorResult<SDKUserMessageForInput>) => void;
  private isDone = false;
  private started = false;

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessageForInput> {
    if (this.started) throw new Error("MessageQueue can only be iterated once");
    this.started = true;
    return { next: () => this.next() };
  }

  private next(): Promise<IteratorResult<SDKUserMessageForInput>> {
    if (this.queue.length > 0) {
      return Promise.resolve({ done: false, value: this.queue.shift()! });
    }
    if (this.isDone) {
      return Promise.resolve({ done: true, value: undefined as never });
    }
    return new Promise((resolve) => { this.readResolve = resolve; });
  }

  enqueue(msg: SDKUserMessageForInput): void {
    if (this.isDone) return;
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      resolve({ done: false, value: msg });
    } else {
      this.queue.push(msg);
    }
  }

  done(): void {
    this.isDone = true;
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      resolve({ done: true, value: undefined as never });
    }
  }
}

function appendAllowedTool(
  allowedTools: string[] | undefined,
  toolName: string
): string[] | undefined {
  if (!allowedTools) return allowedTools;
  return allowedTools.includes(toolName)
    ? allowedTools
    : [...allowedTools, toolName];
}

function buildClaudeSystemPrompt(
  sessionSystemPrompt?: string,
  optionSystemPrompt?: Options["systemPrompt"]
): Options["systemPrompt"] {
  const appendParts: string[] = [];

  if (typeof optionSystemPrompt === "string" && optionSystemPrompt.trim()) {
    appendParts.push(optionSystemPrompt.trim());
  } else if (
    optionSystemPrompt &&
    typeof optionSystemPrompt === "object" &&
    !Array.isArray(optionSystemPrompt) &&
    optionSystemPrompt.type === "preset" &&
    optionSystemPrompt.preset === "claude_code" &&
    optionSystemPrompt.append?.trim()
  ) {
    appendParts.push(optionSystemPrompt.append.trim());
  }

  if (sessionSystemPrompt?.trim()) {
    appendParts.push(sessionSystemPrompt.trim());
  }

  return appendParts.length > 0
    ? {
        type: "preset",
        preset: "claude_code",
        append: appendParts.join("\n\n"),
      }
    : {
        type: "preset",
        preset: "claude_code",
      };
}

/**
 * Format conversation history into a context string for the prompt.
 * This allows Claude to understand what happened before in the conversation.
 */
function formatConversationHistory(messages: HistoryMessage[]): string {
  if (!messages || messages.length === 0) return "";

  const parts: string[] = [];
  parts.push("<conversation_history>");
  parts.push(
    "The following is the history of our previous conversation. Please continue from where we left off:"
  );
  parts.push("");

  for (const msg of messages) {
    switch (msg.type) {
      case "user":
        parts.push(`[User]: ${msg.content}`);
        break;
      case "assistant":
        parts.push(`[Assistant]: ${msg.content}`);
        break;
      case "tool_use":
        parts.push(
          `[Assistant used tool "${msg.tool}"]: ${JSON.stringify(msg.input)}`
        );
        break;
      case "tool_result":
        // Truncate very long tool outputs
        const output =
          msg.output.length > 500
            ? msg.output.slice(0, 500) + "...[truncated]"
            : msg.output;
        parts.push(`[Tool "${msg.tool}" result]: ${output}`);
        break;
    }
  }

  parts.push("");
  parts.push("</conversation_history>");
  parts.push("");
  parts.push(
    "Continue the conversation based on the history above. Here is the new request:"
  );
  parts.push("");

  return parts.join("\n");
}

// Build content blocks for multimodal prompts (text + images)
function buildContentBlocks(
  prompt: string,
  images?: ImageData[]
): ContentBlock[] {
  const contentBlocks: ContentBlock[] = [];

  // Add image blocks first
  if (images) {
    for (const img of images) {
      contentBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType,
          data: img.base64Data,
        },
      });
    }
  }

  // Only add text block if there's actual text content
  // Empty text blocks with cache_control cause API errors
  const trimmedPrompt = prompt.trim();
  if (trimmedPrompt) {
    contentBlocks.push({
      type: "text",
      text: trimmedPrompt,
    });
  }
  // If no text and no images, contentBlocks will be empty - caller should handle

  return contentBlocks;
}

// Create an async iterable that yields a single SDKUserMessage for multimodal prompts.
// IMPORTANT: The generator must stay alive after yielding the message until the
// query result is received. The SDK's streamInput() calls transport.endInput()
// (closing CLI stdin) when the generator returns. If stdin closes while tool
// permission requests are still pending (e.g. Bash commands under acceptEdits
// mode), the CLI gets "Stream closed" errors. By keeping the generator alive
// until the result, we let tool permissions complete before stdin is closed.
async function* createUserMessageStream(
  prompt: string,
  images: ImageData[],
  sessionId: string,
  donePromise?: Promise<void>
): AsyncGenerator<SDKUserMessageForInput> {
  const contentBlocks = buildContentBlocks(prompt, images);

  yield {
    type: "user",
    message: {
      role: "user",
      content: contentBlocks,
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  };

  // Keep the generator alive until the query result is received.
  // When handleSdkMessage sees a "result" message, it resolves donePromise,
  // letting the generator complete. This allows streamInput() to call
  // endInput() and the CLI process to exit cleanly -- but only AFTER all
  // tool permission requests have been processed.
  if (donePromise) {
    await donePromise;
  }
}

function startClaudeQueueWorker(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session || session.provider !== "claude" || session.claudeProcessing) {
    return;
  }

  session.claudeProcessing = true;
  send({ type: "debug", id: sessionId, message: "[claude queue] worker started" });
  void processClaudeQueue(sessionId);
}

async function processClaudeQueue(sessionId: string): Promise<void> {
  try {
    while (true) {
      const session = sessions.get(sessionId);
      if (!session || session.provider !== "claude") {
        return;
      }

      const next = session.claudeQueue.shift();
      if (!next) {
        session.claudeProcessing = false;
        send({ type: "debug", id: sessionId, message: "[claude queue] worker idle" });
        return;
      }

      send({
        type: "debug",
        id: sessionId,
        message: `[claude queue] start processing queryId=${next.queryId}`,
      });

      await runClaudeQueryItem(
        session,
        { type: "query", id: sessionId, prompt: next.prompt, images: next.images },
        next.queryId
      );

      const currentSession = sessions.get(sessionId);
      if (!currentSession || currentSession.provider !== "claude") {
        return;
      }
      send({
        type: "debug",
        id: sessionId,
        message: `[claude queue] completed queryId=${next.queryId} remaining=${currentSession.claudeQueue.length}`,
      });
    }
  } finally {
    const session = sessions.get(sessionId);
    if (session && session.provider === "claude" && session.claudeQueue.length === 0) {
      session.claudeProcessing = false;
    }
  }
}

async function runClaudeQueryItem(
  session: Session,
  msg: QueryMessage,
  queryId: string
): Promise<void> {
  if (sessions.get(msg.id) !== session) {
    return;
  }

  // Set this as the current query BEFORE starting
  session.currentQueryId = queryId;

  const hasImages = msg.images && msg.images.length > 0;

  // Determine the SDK session ID to use for resume:
  // Fork mode: use fork params for first query only, then normal resume
  // Normal mode: use captured/passed SDK session ID
  let resumeSessionId: string | undefined;
  let forkAtUuid: string | undefined;
  let isFork = false;

  if (session.forkFromSdkSessionId) {
    // FORK: Use fork parameters for first query only
    resumeSessionId = session.forkFromSdkSessionId;
    forkAtUuid = session.forkAtMessageUuid;
    isFork = true;
    // Consume fork params (subsequent queries use normal resume with new sdkSessionId)
    session.forkFromSdkSessionId = undefined;
    session.forkAtMessageUuid = undefined;
    send({
      type: "debug",
      id: msg.id,
      message: `Forking from session ${resumeSessionId} at message ${forkAtUuid}`,
    });
  } else {
    // Normal resume path
    // 1. If we have a captured sdkSessionId from a previous query, use that
    // 2. If we have a passedSdkSessionId from the frontend (restored session), use that
    // 3. Otherwise, no resume
    resumeSessionId = session.sdkSessionId || session.passedSdkSessionId;
  }

  // Only prepend history if we have NO SDK session ID to resume from (legacy fallback)
  const hasHistory =
    session.conversationHistory &&
    session.conversationHistory.length > 0 &&
    !resumeSessionId;

  send({
    type: "debug",
    id: msg.id,
    message: `Starting query ${queryId} with prompt: ${msg.prompt.slice(
      0,
      100
    )}... (images: ${msg.images?.length ?? 0}, resumeId: ${
      resumeSessionId || "none"
    }, legacyHistory: ${hasHistory ? session.conversationHistory?.length : 0})`,
  });

  try {
    // Create abort controller for this query
    const abortController = new AbortController();
    session.abortController = abortController;

    send({
      type: "debug",
      id: msg.id,
      message: `Calling SDK query()... resume=${resumeSessionId || "none"}`,
    });
    send({
      type: "debug",
      id: msg.id,
      message: `Options: cwd=${session.options.cwd}, pathToClaudeCodeExecutable=${session.options.pathToClaudeCodeExecutable}`,
    });

    // If this is a restored session without an SDK session ID, prepend conversation history
    // This is a LEGACY fallback - proper sessions should use passedSdkSessionId for resume
    let promptToSend = msg.prompt;
    if (hasHistory) {
      const historyContext = formatConversationHistory(
        session.conversationHistory!
      );
      promptToSend = historyContext + msg.prompt;
      send({
        type: "debug",
        id: msg.id,
        message: `[LEGACY] Prepended ${
          session.conversationHistory!.length
        } history messages to prompt (consider persisting SDK session ID instead)`,
      });
    }

    // Use a persistent MessageQueue as the AsyncIterable prompt. The SDK calls
    // streamInput() once with this queue. Follow-up messages are enqueued into
    // the same queue, avoiding multiple streamInput() calls which would each
    // close stdin via endInput() when their generator completes.
    const streamSessionId = session.sdkSessionId || msg.id;
    const inputQueue = new MessageQueue();
    session.inputQueue = inputQueue;

    const contentBlocks = buildContentBlocks(promptToSend, msg.images ?? []);
    // Fresh query: exactly one turn is pending (self-heals any stale count or
    // deferred done left by a torn-down predecessor query).
    session.claudePendingTurns = 1;
    cancelPendingDone(session);
    inputQueue.enqueue({
      type: "user",
      message: { role: "user", content: contentBlocks },
      parent_tool_use_id: null,
      session_id: streamSessionId,
    });

    const promptInput = inputQueue;
    send({
      type: "debug",
      id: msg.id,
      message: `Built persistent input queue${hasImages ? ` with ${msg.images!.length} image(s)` : ""} (streaming input mode)`,
    });

    // Common options for both text and multimodal queries
    const queryOptions: Options & { abortController: AbortController } = {
      ...session.options,
      abortController,
      // Resume from previous session if we have one (either captured or passed from frontend)
      resume: resumeSessionId,
      // Fork support: when forking, specify the message to fork at and create a new branch
      ...(isFork ? { resumeSessionAt: forkAtUuid, forkSession: true } : {}),
      // Capture stderr for debugging
      stderr: (data: string) => {
        send({ type: "debug", id: msg.id, message: `[stderr] ${data}` });
      },
      // Hook callbacks for subagent lifecycle events and parallel agent detection
      hooks: {
        // ExitPlanMode approval is handled by canUseTool (not PermissionRequest hooks).
        // canUseTool blocks the SDK server-side with a promise until the user approves/denies.
        // No PermissionRequest hook needed for ExitPlanMode.
        PreToolUse: [
          {
            hooks: [
              (async (_input) => {
                const s = sessions.get(msg.id);
                if (s?.pendingParallelNotification) {
                  const notification = s.pendingParallelNotification;
                  s.pendingParallelNotification = undefined;
                  send({
                    type: "debug",
                    id: msg.id,
                    message: `Injecting parallel agent notification via PreToolUse systemMessage`,
                  });
                  return { systemMessage: notification };
                }
                return {};
              }) as HookCallback,
            ],
          },
        ],
        SubagentStart: [
          {
            hooks: [
              (async (input) => {
                const hookInput = input as SubagentStartHookInput;
                sendSubagentStart(msg.id, hookInput.agent_id, hookInput.agent_type);
                const s = sessions.get(msg.id);
                if (s?.pendingParallelNotification) {
                  send({
                    type: "debug",
                    id: msg.id,
                    message: `Injecting parallel agent notification into subagent ${hookInput.agent_id} via additionalContext`,
                  });
                  return {
                    continue: true,
                    hookSpecificOutput: {
                      hookEventName: "SubagentStart" as const,
                      additionalContext: s.pendingParallelNotification,
                    },
                  };
                }
                return { continue: true };
              }) as HookCallback,
            ],
          },
        ],
        SubagentStop: [
          {
            hooks: [
              (async (input) => {
                const hookInput = input as SubagentStopHookInput;
                sendSubagentStop(
                  msg.id,
                  hookInput.agent_id,
                  hookInput.agent_transcript_path
                );
                return { continue: true };
              }) as HookCallback,
            ],
          },
        ],
      },
    };

    // Use the query function from the SDK
    let queryIterator;
    try {
      // promptInput is always AsyncIterable<SDKUserMessageForInput> (streaming input mode)
      // The SDK accepts AsyncIterable<SDKUserMessage> -- our SDKUserMessageForInput is structurally compatible
      queryIterator = query({
        prompt: promptInput as unknown as string, // SDK accepts AsyncIterable here; string cast satisfies TS
        options: queryOptions,
      });
    } catch (spawnError) {
      send({
        type: "debug",
        id: msg.id,
        message: `Failed to create query: ${spawnError}`,
      });
      sendError(msg.id, `Failed to spawn query: ${spawnError}`);
      return;
    }

    // Store the query iterator on the session so we can call interrupt() on it
    session.queryIterator = queryIterator;

    send({
      type: "debug",
      id: msg.id,
      message: `Query iterator created, starting iteration...`,
    });

    let messageCount = 0;
    // ExitPlanMode approval is handled by canUseTool which blocks server-side.
    // No iteration gate needed -- the tool won't execute until the user approves.
    while (true) {
      // Fetch next message
      const iterResult = await queryIterator.next();
      if (iterResult.done) break;

      const message = iterResult.value;

      if (sessions.get(msg.id) !== session) {
        return;
      }
      // Zombie guard: if a newer query has taken over this session (user
      // stopped this turn and sent a new prompt), this process must neither
      // keep streaming events into the shared transcript nor keep running
      // turns against the same on-disk Claude session — that produces two
      // interleaved agents in one session. Kill the process and drop the
      // message.
      if (session.currentQueryId !== queryId) {
        send({
          type: "debug",
          id: msg.id,
          message: `Query ${queryId} superseded by ${session.currentQueryId} mid-stream — aborting stale process`,
        });
        inputQueue.done();
        abortController.abort();
        return;
      }
      messageCount++;
      // A live message means the CLI is still working: a deferred done armed by
      // a prior result (injected-prompt ambiguity) would be premature. The
      // result case in handleSdkMessage re-arms it when needed.
      cancelPendingDone(session);
      send({
        type: "debug",
        id: msg.id,
        message: `Received message #${messageCount}: type=${message.type}`,
      });
      try {
        // Capture SDK session ID from system init message for resume
        if (message.type === "system" && message.subtype === "init") {
          session.sdkSessionId = message.session_id;
          send({
            type: "debug",
            id: msg.id,
            message: `Captured SDK session ID: ${message.session_id}`,
          });
          send({
            type: "debug",
            id: msg.id,
            message:
              `[claude init] model=${message.model} ` +
              `permissionMode=${message.permissionMode} ` +
              `tools=${message.tools.includes("Skill") ? "Skill-enabled" : "Skill-missing"}(${message.tools.length}) ` +
              `skills=${message.skills.length > 0 ? message.skills.join(", ") : "(none)"}`,
          });
          // Send SDK session ID to frontend so it can be persisted for proper resume
          sendSdkSessionId(msg.id, message.session_id);
        }
        handleSdkMessage(msg.id, message);
      } catch (err) {
        send({
          type: "debug",
          id: msg.id,
          message: `Error handling message: ${err}`,
        });
      }
    }

    send({
      type: "debug",
      id: msg.id,
      message: `Query ${queryId} complete, received ${messageCount} messages`,
    });

    // Only emit done if this query is still the current one
    // This prevents stale done events from affecting newer queries
    if (sessions.get(msg.id) === session && session.currentQueryId === queryId) {
      sendDone(msg.id);
    } else {
      send({
        type: "debug",
        id: msg.id,
        message: `Query ${queryId} was superseded by ${session.currentQueryId}, not emitting done`,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : "";
    send({
      type: "debug",
      id: msg.id,
      message: `Query ${queryId} error: ${errorMessage}\n${errorStack}`,
    });

    // Only emit error if this query is still the current one
    if (sessions.get(msg.id) === session && session.currentQueryId === queryId) {
      sendError(msg.id, errorMessage);
      // Fallback rate-limit detection when the SDK gives only an opaque error string.
      if (isRateLimitError(errorMessage)) {
        sendRateLimit(msg.id, { status: "rejected" });
      }
    } else {
      send({
        type: "debug",
        id: msg.id,
        message: `Query ${queryId} was superseded, not emitting error`,
      });
    }
  } finally {
    // Only clear the iterator/controller if this is still the current query
    if (session.currentQueryId === queryId) {
      session.abortController = undefined;
      session.queryIterator = undefined;
      session.claudePendingTurns = 0;
      cancelPendingDone(session);
      if (session.inputQueue) {
        session.inputQueue.done();
        session.inputQueue = undefined;
      }
    }
  }
}

async function handleQuery(msg: QueryMessage): Promise<void> {
  const session = sessions.get(msg.id);
  if (!session) {
    sendError(msg.id, "Session not found");
    return;
  }

  // Route to provider-specific handler
  if (session.provider === "openai") {
    if (session.openaiMode === "app_server") {
      const activeTurnId = session.appServerTurnId;
      const activeThreadId = session.sdkSessionId || session.passedSdkSessionId;
      if (session.appServer && activeTurnId && activeThreadId) {
        const inputItems = buildCodexAppServerInputItems(msg, session, false);
        send({
          type: "debug",
          id: msg.id,
          message:
            `[app-server query] active turn detected; steering turnId=${activeTurnId} ` +
            `threadId=${activeThreadId}`,
        });
        try {
          await appServerRequest(session.appServer, "turn/steer", {
            threadId: activeThreadId,
            input: inputItems.length > 0 ? inputItems : [{ type: "text", text: "" }],
            expectedTurnId: activeTurnId,
          });
          send({
            type: "debug",
            id: msg.id,
            message: `[app-server query] steer accepted turnId=${activeTurnId}`,
          });
          return;
        } catch (error) {
          send({
            type: "debug",
            id: msg.id,
            message:
              `[app-server query] steer failed for turnId=${activeTurnId}; ` +
              `falling back to turn/start (${error instanceof Error ? error.message : String(error)})`,
          });
        }
      }

      const queryId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return handleCodexAppServerQuery(msg, queryId);
    }
    return handleCodexQuery(msg);
  }

  // === Claude provider path ===
  // If there is an active query with a persistent input queue, enqueue the
  // follow-up message directly. The SDK's streamInput() (running in background)
  // picks it up and writes it to stdin immediately. No additional streamInput()
  // call needed — the single persistent queue avoids the endInput() bug where
  // multiple streamInput() calls would each close stdin when their generator
  // completed. The FIFO queue is kept as fallback for edge-cases (e.g. race
  // before inputQueue is assigned).
  if (session.claudeProcessing && session.inputQueue && !session.claudeStopping) {
    const injectSessionId = session.sdkSessionId || msg.id;
    const contentBlocks = buildContentBlocks(msg.prompt, msg.images ?? []);
    session.claudePendingTurns = (session.claudePendingTurns ?? 1) + 1;
    // This prompt starts (or joins) a turn whose own result settles the done.
    cancelPendingDone(session);
    session.inputQueue.enqueue({
      type: "user",
      message: { role: "user", content: contentBlocks },
      parent_tool_use_id: null,
      session_id: injectSessionId,
    });
    send({
      type: "debug",
      id: msg.id,
      message: `[claude stream-inject] enqueued prompt into persistent input queue (pending turns: ${session.claudePendingTurns})`,
    });
    return;
  }

  // Queue the prompt for sequential processing (agent idle, or streamInput() failed above).
  const queryId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  session.claudeQueue.push({ queryId, prompt: msg.prompt, images: msg.images });
  send({
    type: "debug",
    id: msg.id,
    message: `[claude queue] enqueue len=${session.claudeQueue.length} queryId=${queryId}`,
  });
  startClaudeQueueWorker(msg.id);
}

function handleSdkMessage(id: string, message: SDKMessage): void {
  switch (message.type) {
    case "assistant": {
      // Assistant message with content blocks
      // Extract parent_tool_use_id for task/subagent scoping
      const parentToolUseId = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id || null;
      // Capture the assistant message UUID for fork support
      const turnUuid = (message as { uuid?: string }).uuid || null;
      const session = sessions.get(id);
      if (session && turnUuid) {
        session.lastAssistantTurnUuid = turnUuid;
      }
      // Subagent messages carry the subagent's own model — forward it once per task
      // so the frontend can badge the task block with the model actually used.
      if (parentToolUseId) {
        const subagentModel = (message.message as { model?: string }).model;
        const modelKey = `${id}-${parentToolUseId}`;
        if (subagentModel && !subagentModelSent.has(modelKey)) {
          subagentModelSent.add(modelKey);
          sendSubagentModel(id, parentToolUseId, subagentModel);
        }
      }
      const thinkingKey = `${id}-${parentToolUseId || "main"}`;
      send({
        type: "debug",
        id,
        message: `Assistant message has ${message.message.content.length} content blocks (parent: ${parentToolUseId || "main"}, uuid: ${turnUuid || "none"})`,
      });
      for (const block of message.message.content) {
        send({
          type: "debug",
          id,
          message: `Content block type: ${block.type}`,
        });

        // Handle thinking blocks (extended thinking feature)
        if (block.type === "thinking") {
          const thinkingBlock = block as { thinking?: string };
          const thinkingContent = thinkingBlock.thinking || "";

          if (!thinkingState.has(thinkingKey)) {
            // First thinking block - start tracking
            thinkingState.set(thinkingKey, {
              startTime: Date.now(),
              content: thinkingContent,
            });
            sendThinkingStart(id, thinkingContent, parentToolUseId, turnUuid);
            send({
              type: "debug",
              id,
              message: `Thinking started: ${thinkingContent.slice(0, 100)}...`,
            });
          } else {
            // Additional thinking block - accumulate content
            const state = thinkingState.get(thinkingKey)!;
            state.content += "\n\n" + thinkingContent;
            send({
              type: "debug",
              id,
              message: `Thinking continued: ${thinkingContent.slice(
                0,
                100
              )}...`,
            });
          }
          continue;
        }

        // If we were thinking and now getting real content, end thinking
        if (thinkingState.has(thinkingKey)) {
          const state = thinkingState.get(thinkingKey)!;
          const durationMs = Date.now() - state.startTime;
          thinkingState.delete(thinkingKey);
          sendThinkingEnd(id, durationMs, state.content, parentToolUseId, turnUuid);
          send({
            type: "debug",
            id,
            message: `Thinking ended after ${durationMs}ms`,
          });
        }

        if (block.type === "text") {
          send({
            type: "debug",
            id,
            message: `Text content: ${block.text.slice(0, 100)}`,
          });
          sendText(id, block.text, parentToolUseId, turnUuid);
        } else if (block.type === "tool_use") {
          // Track tool_use_id to name mapping for matching with tool_result
          const toolUseBlock = block as {
            id?: string;
            name: string;
            input: unknown;
          };
          const toolUseId = toolUseBlock.id || `unknown-${Date.now()}`;
          if (toolUseBlock.id) {
            toolUseIdToName.set(toolUseBlock.id, toolUseBlock.name);
          }
          sendToolStart(id, block.name, block.input, toolUseId, parentToolUseId, turnUuid);

          // Note: ExitPlanMode and AskUserQuestion are handled via canUseTool callback.
          // The canUseTool callback intercepts it, emits questions, waits for answers,
          // and returns the proper updatedInput with the user's answers.
        }
      }
      // Send progressive usage data from assistant message if available
      // Only emit for main agent messages (not subagents) to keep context bar accurate
      if (message.message.usage && !parentToolUseId) {
        const usage = message.message.usage;
        const mainUsage = {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
        };
        lastMainAgentUsage.set(id, mainUsage);
        sendProgressiveUsage(id, mainUsage);
      }
      break;
    }

    case "stream_event": {
      // Streaming partial message (renamed from partial_assistant in SDK 0.3.x)
      const streamMsg = message as { event?: { type?: string; delta?: { type?: string; text?: string } }; parent_tool_use_id?: string | null };
      const partialParentToolUseId = streamMsg.parent_tool_use_id || null;
      if (streamMsg.event?.type === "content_block_delta" && streamMsg.event.delta?.text) {
        sendText(id, streamMsg.event.delta.text, partialParentToolUseId);
      }
      break;
    }

    case "result": {
      // With the persistent input queue, we do NOT close the queue on result.
      // The queue stays alive so follow-up messages can be enqueued into the
      // same query without requiring a new streamInput() call (which would
      // close stdin via endInput()). The queue is only closed on stop/cleanup.

      // Final result message - send usage data and handle errors
      // Retrieve main-agent-only usage for accurate context bar (excludes subagent tokens)
      const resultSession = sessions.get(id);
      const mainAgentUsage = lastMainAgentUsage.get(id);
      const mainAgentFields = mainAgentUsage ? {
        mainAgentInputTokens: mainAgentUsage.inputTokens,
        mainAgentOutputTokens: mainAgentUsage.outputTokens,
        mainAgentCacheReadTokens: mainAgentUsage.cacheReadTokens,
        mainAgentCacheCreationTokens: mainAgentUsage.cacheCreationTokens,
      } : {};
      lastMainAgentUsage.delete(id);

      // Both success and error results have usage/cost/duration in SDK 0.3.x
      const resultMsg = message as unknown as {
        subtype: string;
        usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
        modelUsage: Record<string, { contextWindow?: number }>;
        total_cost_usd: number;
        duration_ms: number;
        duration_api_ms: number;
        num_turns: number;
        errors?: string[];
      };
      const modelUsageValues = Object.values(resultMsg.modelUsage || {});
      // The SDK reports a stale 200k window for the 1M-context Claude models, so trust the
      // larger of the reported window and our known maximum. This keeps the displayed window
      // and the near-limit overflow detection below aligned with the model's true capacity.
      const inferredContextWindow = inferClaudeContextWindow(resultSession?.options.model);
      const reportedContextWindow =
        modelUsageValues.length > 0 ? (modelUsageValues[0].contextWindow ?? 0) : 0;
      const contextWindow = Math.max(reportedContextWindow, inferredContextWindow);

      sendUsage(id, {
        inputTokens: resultMsg.usage?.input_tokens || 0,
        outputTokens: resultMsg.usage?.output_tokens || 0,
        cacheReadTokens: resultMsg.usage?.cache_read_input_tokens || 0,
        cacheCreationTokens: resultMsg.usage?.cache_creation_input_tokens || 0,
        totalCostUsd: resultMsg.total_cost_usd || 0,
        durationMs: resultMsg.duration_ms || 0,
        durationApiMs: resultMsg.duration_api_ms || 0,
        numTurns: resultMsg.num_turns || 0,
        contextWindow,
        ...mainAgentFields,
      });

      // One pending user prompt is settled by this result. If more prompts were
      // stream-injected while this turn ran, they were either steered into it
      // (this result covers them too — done is real) or queued as a fresh turn
      // the CLI starts right after this result (done now would falsely complete
      // the session mid-work — e.g. a follow-up sent during a slow /compact).
      // We can't distinguish the two here, so defer the done briefly: any
      // further CLI message means a queued turn is running (its own result
      // emits done); silence means everything was steered.
      const remainingTurns = resultSession
        ? (resultSession.claudePendingTurns = Math.max(
            0,
            (resultSession.claudePendingTurns ?? 1) - 1
          ))
        : 0;

      if (message.subtype === "success") {
        if (remainingTurns > 0 && resultSession) {
          send({
            type: "debug",
            id,
            message: `Deferring done: ${remainingTurns} injected prompt(s) unaccounted for — waiting to see if a queued turn starts`,
          });
          cancelPendingDone(resultSession);
          resultSession.pendingDoneTimer = setTimeout(() => {
            resultSession.pendingDoneTimer = undefined;
            if (sessions.get(id) !== resultSession) return;
            resultSession.claudePendingTurns = 0;
            send({
              type: "debug",
              id,
              message: `Deferred done: no queued turn started — injected prompt(s) were steered into the finished turn`,
            });
            sendDone(id);
          }, 2000);
        } else {
          sendDone(id);
        }
      } else {
        // Error subtypes: error_during_execution, error_max_turns, error_max_budget_usd, error_max_structured_output_retries
        let errorText = resultMsg.errors?.join("; ") || `Error: ${message.subtype}`;
        // A genuine mid-turn context overflow is usually THROWN (handled in the query catch with the raw
        // "prompt is too long" text). Occasionally it instead surfaces here as a bare error_during_execution
        // with no descriptive message, so we detect that from near-limit usage and tag it, letting the
        // frontend's overflow recovery (compact + retry) still kick in.
        //
        // Two guards keep this from firing "too early" (which wrongly triggered compaction):
        //  - ONLY error_during_execution qualifies. error_max_turns / error_max_budget_usd / an interrupt's
        //    error result are NOT overflows and must never be relabelled as one.
        //  - Measure MAIN-AGENT context (what the UI's context bar shows) rather than the summed total,
        //    which also counts finished subagents' tokens — otherwise a subagent-heavy turn crosses the
        //    threshold while the visible context is still low, so compaction fires far below the real limit.
        const overflowUsage = mainAgentUsage
          ? mainAgentUsage.inputTokens +
            mainAgentUsage.cacheReadTokens +
            mainAgentUsage.cacheCreationTokens
          : (resultMsg.usage?.input_tokens || 0) +
            (resultMsg.usage?.cache_read_input_tokens || 0) +
            (resultMsg.usage?.cache_creation_input_tokens || 0);
        const nearContextLimit = contextWindow > 0 && overflowUsage >= contextWindow * 0.9;
        if (
          message.subtype === "error_during_execution" &&
          nearContextLimit &&
          !/prompt is too long/i.test(errorText)
        ) {
          errorText = `Prompt is too long: ${overflowUsage} tokens, context window ${contextWindow}. ${errorText}`;
        }
        sendError(id, errorText);
        // Fallback rate-limit detection: some rejections surface here as an error result
        // subtype (e.g. error: 'rate_limit') rather than an explicit rate_limit_event.
        if (isRateLimitError(message.subtype) || isRateLimitError(errorText)) {
          sendRateLimit(id, { status: "rejected" });
        }
      }
      break;
    }

    case "user": {
      // User messages contain tool results
      // Extract parent_tool_use_id for task/subagent scoping
      const userParentToolUseId = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id || null;
      // Use the last assistant turn UUID for tool results (they belong to the same conversational turn)
      const userSession = sessions.get(id);
      const userTurnUuid = userSession?.lastAssistantTurnUuid || null;
      // The message.message.content array contains tool_result blocks
      if (message.message?.content && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === "tool_result") {
            // tool_result blocks have tool_use_id and content (string or array)
            const toolResultBlock = block as {
              tool_use_id?: string;
              content?: string | Array<{ type: string; text?: string }>;
            };
            const toolUseId =
              toolResultBlock.tool_use_id || `unknown-${Date.now()}`;
            // Look up tool name from the tool_use_id we tracked earlier
            const toolName = toolResultBlock.tool_use_id
              ? toolUseIdToName.get(toolResultBlock.tool_use_id) || "unknown"
              : "unknown";

            let output = "";
            let historyImages: { mediaType: string; base64Data: string }[] | undefined;
            if (typeof toolResultBlock.content === "string") {
              output = toolResultBlock.content;
            } else if (Array.isArray(toolResultBlock.content)) {
              const textParts: string[] = [];
              const imgs: { mediaType: string; base64Data: string }[] = [];
              for (const c of toolResultBlock.content) {
                if (c.type === "text" && c.text) {
                  textParts.push(c.text);
                } else if (c.type === "image" && (c as any).source?.data) {
                  imgs.push({
                    mediaType: (c as any).source.media_type || "image/png",
                    base64Data: (c as any).source.data,
                  });
                }
              }
              output = textParts.join("\n");
              if (imgs.length > 0) historyImages = imgs;
            }

            send({
              type: "debug",
              id,
              message: `Tool result for ${toolName} (${toolUseId}): ${output.slice(
                0,
                100
              )}...`,
            });
            sendToolResult(id, toolName, output, toolUseId, userParentToolUseId, userTurnUuid, historyImages);

            // Clean up the mapping after use
            if (toolResultBlock.tool_use_id) {
              toolUseIdToName.delete(toolResultBlock.tool_use_id);
            }
          }
        }
      }
      break;
    }

    case "system": {
      // System messages - init is handled above in the message loop
      // Handle task lifecycle messages from the SDK
      const sysMsg = message as { subtype?: string; task_id?: string; tool_use_id?: string; description?: string; task_type?: string; status?: string; summary?: string; usage?: { total_tokens: number; tool_uses: number; duration_ms: number } };
      // The SDK emits task_started/task_notification for background-bash tasks
      // (task_type === "local_bash") in addition to the normal Bash tool_use
      // block. Forward everything — the frontend uses local_bash events for
      // live-task tracking only (no transcript message), so the tool_use/
      // tool_result pair stays the single rendering of the bash run.
      if (sysMsg.subtype === "task_started") {
        send({
          type: "debug",
          id,
          message: `Task started: ${sysMsg.task_id} (toolUseId: ${sysMsg.tool_use_id}, taskType: ${sysMsg.task_type}, desc: ${sysMsg.description?.slice(0, 80)})`,
        });
        sendTaskStarted(id, sysMsg.task_id!, sysMsg.tool_use_id, sysMsg.description || "", sysMsg.task_type);
      } else if (sysMsg.subtype === "task_notification") {
        send({
          type: "debug",
          id,
          message: `Task completed: ${sysMsg.task_id} (taskType: ${sysMsg.task_type}, status: ${sysMsg.status}, summary: ${sysMsg.summary?.slice(0, 80)})`,
        });
        sendTaskCompleted(id, sysMsg.task_id!, sysMsg.tool_use_id, sysMsg.status || "completed", sysMsg.summary || "", sysMsg.task_type, sysMsg.usage);
      }
      break;
    }

    case "auth_status":
      // Authentication status
      if (message.isAuthenticating) {
        sendText(id, "[Authenticating...]");
      }
      if (message.error) {
        sendError(id, `Authentication error: ${message.error}`);
      }
      break;

    case "tool_progress": {
      // Tool is running
      const progressParentToolUseId = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id || null;
      sendText(
        id,
        `[${message.tool_name}: ${message.elapsed_time_seconds.toFixed(1)}s]`,
        progressParentToolUseId
      );
      break;
    }

    case "rate_limit_event": {
      // SDKRateLimitEvent: rate_limit_info.{ status, resetsAt?, utilization? }
      // Only act on a hard rejection; "allowed"/"allowed_warning" are ignored for now.
      const rateLimitInfo = (message as {
        rate_limit_info?: {
          status?: string;
          resetsAt?: number;
          utilization?: number;
        };
      }).rate_limit_info;
      if (rateLimitInfo?.status === "rejected") {
        sendRateLimit(id, {
          status: "rejected",
          resetsAt: rateLimitInfo.resetsAt,
          utilization: rateLimitInfo.utilization,
        });
      }
      break;
    }

    default:
      // Log unknown message types for debugging
      send({
        type: "debug",
        id,
        message: `Unknown SDK message type: ${
          (message as { type: string }).type
        }`,
      });
  }
}

async function handleStop(msg: StopMessage): Promise<void> {
  const session = sessions.get(msg.id);
  if (!session) {
    sendError(msg.id, "Session not found");
    return;
  }

  // OpenAI Codex: use AbortController to cancel
  if (session.provider === "openai") {
    const interruptedTurnId = session.appServerTurnId;
    if (
      session.openaiMode === "app_server" &&
      session.appServer &&
      session.sdkSessionId &&
      interruptedTurnId
    ) {
      try {
        await appServerRequest(session.appServer, "turn/interrupt", {
          threadId: session.sdkSessionId,
          turnId: interruptedTurnId,
        });
      } catch (err) {
        send({
          type: "debug",
          id: msg.id,
          message: `Failed to interrupt app-server turn: ${err}`,
        });
      }
    }
    if (session.abortController) {
      send({ type: "debug", id: msg.id, message: "Aborting Codex query..." });
      session.abortController.abort();
      session.abortController = undefined;
    }
    if (session.appServer && interruptedTurnId) {
      const pending = session.appServer.pendingTurns.get(interruptedTurnId);
      if (pending) {
        session.appServer.pendingTurns.delete(interruptedTurnId);
        pending.reject(new Error("Turn interrupted"));
      }
      session.appServer.completedTurns.delete(interruptedTurnId);
    }
    session.appServerTurnId = undefined;
    return;
  }

  // Mark that a stop is in progress. handleQuery checks this flag and skips
  // the streamInject path while we tear down, so a new prompt arriving during
  // the stop is queued instead of being swallowed by an interrupted iterator.
  session.claudeStopping = true;

  // Reject any pending blocking Promises so runClaudeQueryItem / canUseTool
  // can unblock.  Without this, the queue worker stays permanently stuck if
  // stop is called while awaiting plan approval or user answers.
  if (session.pendingPlanApproval) {
    send({ type: "debug", id: msg.id, message: "Rejecting pending plan approval due to stop" });
    session.pendingPlanApproval.reject(new Error("Query stopped by user"));
    session.pendingPlanApproval = undefined;
  }
  if (session.pendingAskUserAnswer) {
    send({ type: "debug", id: msg.id, message: "Rejecting pending AskUserQuestion due to stop" });
    session.pendingAskUserAnswer.reject(new Error("Query stopped by user"));
    session.pendingAskUserAnswer = undefined;
  }
  if (session.inputQueue) {
    session.inputQueue.done();
    session.inputQueue = undefined;
  }
  // A stop settles the turn — a deferred done firing after it would emit a
  // spurious completion on the stopped (or a future) turn.
  session.claudePendingTurns = 0;
  cancelPendingDone(session);

  const pendingCount = session.claudeQueue.length;
  if (pendingCount > 0) {
    session.claudeQueue.length = 0;
    send({
      type: "debug",
      id: msg.id,
      message: `[claude queue] cleared pending=${pendingCount} due to stop`,
    });
  }

  // Snapshot and clear the iterator/abortController synchronously BEFORE
  // awaiting interrupt(). This avoids a race where handleQuery runs during
  // the interrupt await, sees queryIterator still set, and stream-injects
  // into the dying iterator. After this point any concurrent handleQuery
  // sees queryIterator=undefined and takes the queue path.
  const iterator = session.queryIterator;
  const abortController = session.abortController;
  session.queryIterator = undefined;
  session.abortController = undefined;

  if (iterator) {
    send({
      type: "debug",
      id: msg.id,
      message: "Interrupting query via iterator.interrupt()...",
    });
    const interruptPromise = iterator.interrupt().then(
      () => true,
      (err: unknown) => {
        send({
          type: "debug",
          id: msg.id,
          message: `Error interrupting query: ${err}`,
        });
        return false;
      }
    );
    // Don't let a hung interrupt() stall the sidecar's message loop forever.
    const landed = await Promise.race([
      interruptPromise,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000)),
    ]);
    if (landed === true) {
      send({
        type: "debug",
        id: msg.id,
        message: "Query interrupted successfully",
      });
    } else if (abortController) {
      // Interrupt failed or hung — hard-kill the process instead.
      abortController.abort();
    }
    // interrupt() only ends the current turn — the CLI process stays alive
    // waiting on stdin, and a follow-up prompt stream-injected before the
    // stop may already sit in its stdin buffer, ready to start a rogue turn
    // in a process we no longer track (which then runs concurrently with the
    // user's next query in the same session). Give the interrupt a moment to
    // wind down cleanly (so the final result/usage message still lands),
    // then hard-kill the process. Aborting a query whose process already
    // exited is a no-op.
    if (abortController) {
      setTimeout(() => abortController.abort(), 3000);
    }
  } else if (abortController) {
    send({
      type: "debug",
      id: msg.id,
      message: "No query iterator, falling back to abortController.abort()...",
    });
    abortController.abort();
  } else {
    send({ type: "debug", id: msg.id, message: "No active query to stop" });
  }

  // Safety: force claudeProcessing to false so new queries can start.
  // The stuck processClaudeQueue will eventually exit via catch/finally,
  // but this ensures startClaudeQueueWorker won't bail out early.
  session.claudeProcessing = false;
  session.claudeStopping = false;

  // Recovery: if a prompt arrived during the stop window and got queued,
  // handleQuery's startClaudeQueueWorker may have been a no-op because
  // claudeProcessing was still stale-true at that moment. Kick the worker
  // now so the queued prompt actually runs.
  if (session.claudeQueue.length > 0) {
    send({
      type: "debug",
      id: msg.id,
      message: `[claude queue] restarting worker for ${session.claudeQueue.length} prompt(s) queued during stop`,
    });
    startClaudeQueueWorker(msg.id);
  }
}

async function handleUpdateModel(msg: UpdateModelMessage): Promise<void> {
  const session = sessions.get(msg.id);
  if (!session) {
    sendError(msg.id, "Session not found");
    return;
  }

  if (session.provider === "openai") {
    session.codexModel = msg.model;
    // OpenAI thread needs to be recreated with new model on next query.
    session.codexThread = undefined;
    session.sdkSessionId = undefined;
    session.passedSdkSessionId = undefined;
  } else {
    session.options.model = msg.model;
  }
  send({ type: "model_updated", id: msg.id, model: msg.model });
}

async function handleUpdateEffort(msg: UpdateEffortMessage): Promise<void> {
  const session = sessions.get(msg.id);
  if (!session) {
    sendError(msg.id, "Session not found");
    return;
  }

  // Update the effort level in the session.
  session.effortLevel = msg.effortLevel ?? undefined;

  // For Claude provider: set native effort option. The SDK accepts the full
  // EffortLevel range ('low'..'max' incl. 'xhigh') and falls back internally for
  // models that don't support a given level.
  if (session.provider === "claude") {
    const mapped = mapEffortForProvider(msg.effortLevel, "claude");
    session.options.effort = (mapped as Options["effort"]) ?? undefined;
  } else {
    // OpenAI SDK mode reads effort from ThreadOptions at thread creation, so
    // drop the cached thread and resume it (sdkSessionId is kept) with the new
    // modelReasoningEffort on the next query. App-server mode passes effort on
    // each turn/start and needs no reset.
    if (session.openaiMode !== "app_server") {
      session.codexThread = undefined;
    }
  }

  send({
    type: "effort_updated",
    id: msg.id,
    effortLevel: msg.effortLevel,
  });
}

async function handleClose(msg: CloseMessage): Promise<void> {
  const session = sessions.get(msg.id);
  if (session) {
    if (session.provider === "openai") {
      // Abort any active Codex query
      if (session.abortController) {
        session.abortController.abort();
      }
      if (session.openaiMode === "app_server") {
        await stopCodexAppServer(session);
      }
      session.codexThread = undefined;
    } else {
      const pendingCount = session.claudeQueue.length;
      if (pendingCount > 0) {
        session.claudeQueue.length = 0;
        send({
          type: "debug",
          id: msg.id,
          message: `[claude queue] cleared pending=${pendingCount} due to close`,
        });
      }
      // Use interrupt() if we have an active query
      if (session.queryIterator) {
        try {
          await session.queryIterator.interrupt();
        } catch {
          // Ignore errors during close
        }
      } else if (session.abortController) {
        session.abortController.abort();
      }
    }
  }
  for (const key of reasoningByItemId.keys()) {
    if (key.startsWith(`${msg.id}:`)) {
      reasoningByItemId.delete(key);
    }
  }
  lastMainAgentUsage.delete(msg.id);
  sessions.delete(msg.id);
  send({ type: "closed", id: msg.id });
}

async function handleMessage(msg: InboundMessage): Promise<void> {
  switch (msg.type) {
    case "create":
      await handleCreate(msg);
      break;
    case "query":
      await handleQuery(msg);
      break;
    case "stop":
      await handleStop(msg);
      break;
    case "update_model":
      await handleUpdateModel(msg);
      break;
    case "update_effort":
      await handleUpdateEffort(msg);
      break;
    case "close":
      await handleClose(msg);
      break;
    case "generate_repo_description":
      await handleGenerateRepoDescription(msg);
      break;
    case "generate_repo_description_with_codex":
      await handleGenerateRepoDescriptionWithCodex(msg);
      break;
    case "generate_launch_profile":
      await handleGenerateLaunchProfile(msg);
      break;
    case "generate_launch_profile_with_codex":
      await handleGenerateLaunchProfileWithCodex(msg);
      break;
    case "validation_agent":
      await handleValidationAgent(msg);
      break;
    case "answer_ask_user_question": {
      const session = sessions.get(msg.id);
      if (session?.pendingAskUserAnswer) {
        send({ type: "debug", id: msg.id, message: "Resolving pending AskUserQuestion with user answers" });
        session.pendingAskUserAnswer.resolve(msg.answers);
        session.pendingAskUserAnswer = undefined;
      } else {
        send({ type: "debug", id: msg.id, message: "No pending AskUserQuestion to resolve" });
      }
      break;
    }
    case "answer_plan_approval": {
      const session = sessions.get(msg.id);
      if (session?.pendingPlanApproval) {
        send({ type: "debug", id: msg.id, message: `Resolving pending plan approval: ${msg.action}` });
        session.pendingPlanApproval.resolve({ action: msg.action, feedback: msg.feedback });
        session.pendingPlanApproval = undefined;
      } else {
        send({ type: "debug", id: msg.id, message: "No pending plan approval to resolve" });
      }
      break;
    }
    default:
      sendError(
        "unknown",
        `Unknown message type: ${(msg as { type: string }).type}`
      );
  }
}

// Set up readline for JSON line protocol
const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on("line", async (line: string) => {
  try {
    const msg = JSON.parse(line) as InboundMessage;
    await handleMessage(msg);
  } catch (err) {
    sendError("unknown", err instanceof Error ? err.message : String(err));
  }
});

// Handle process errors - log but don't crash
process.on("uncaughtException", (err) => {
  send({
    type: "debug",
    id: "process",
    message: `Uncaught exception: ${err.message}\n${err.stack}`,
  });
  sendError("process", `Uncaught exception: ${err.message}`);
});

process.on("unhandledRejection", (reason) => {
  send({
    type: "debug",
    id: "process",
    message: `Unhandled rejection: ${reason}`,
  });
  sendError("process", `Unhandled rejection: ${reason}`);
});

// Handle stdin close gracefully
process.stdin.on("close", () => {
  send({ type: "debug", id: "process", message: "stdin closed, exiting" });
  process.exit(0);
});

process.stdin.on("error", (err) => {
  send({
    type: "debug",
    id: "process",
    message: `stdin error: ${err.message}`,
  });
});

// Keep process alive
process.stdin.resume();

// Log startup
send({ type: "ready" });
send({ type: "debug", id: "process", message: "Sidecar started successfully" });
