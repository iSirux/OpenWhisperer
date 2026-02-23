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
import { Codex, type ThreadEvent, type Thread } from "@openai/codex-sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as readline from "readline";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";

const OPENAI_MODEL_FALLBACK = "gpt-5.3-codex";

function isUnsupportedChatGptAccountModelError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes("model is not supported") &&
    normalized.includes("chatgpt account")
  );
}

// Planning question option schema
const PlanningQuestionOptionSchema = z.object({
  label: z.string().describe("Short label for the option"),
  description: z.string().describe("Longer description explaining this option"),
});

// Planning question schema
const PlanningQuestionSchema = z.object({
  question: z
    .string()
    .describe("The full question text to display to the user"),
  header: z
    .string()
    .max(12)
    .describe(
      'A short one-word header for the navigation chip (e.g., "Scope", "Auth", "Storage")'
    ),
  options: z
    .array(PlanningQuestionOptionSchema)
    .min(2)
    .max(4)
    .describe("Predefined options for the user to choose from (2-4 options)"),
  multiSelect: z
    .boolean()
    .describe(
      "Whether the user can select multiple options (true) or just one (false)"
    ),
});

// Create the in-process planning MCP server
const planningMcpServer = createSdkMcpServer({
  name: "planning-tools",
  version: "1.0.0",
  tools: [
    tool(
      "ask_planning_questions",
      "Present a set of planning questions to the user through a wizard-style interface. Use this to gather requirements and preferences for the feature being planned. The user will see these questions in an interactive UI and can select options or provide custom text input.",
      {
        questions: z
          .array(PlanningQuestionSchema)
          .min(1)
          .max(5)
          .describe(
            "Array of questions to present to the user (1-5 questions)"
          ),
      },
      async (args) => {
        // The actual handling happens in handleSdkMessage when it sees this tool_use
        // We just return a success message here
        return {
          content: [
            {
              type: "text",
              text: `Presented ${args.questions.length} question(s) to the user. Waiting for their responses...`,
            },
          ],
        };
      }
    ),
    tool(
      "complete_planning",
      "Signal that planning is complete. Call this after you have created the plan file and gathered all necessary information. This will show the user a completion screen with a summary and option to start implementation.",
      {
        plan_path: z
          .string()
          .describe(
            'The relative path to the plan file that was created (e.g., "plans/auth-feature.md")'
          ),
        feature_name: z
          .string()
          .describe("Human-readable name of the feature being planned"),
        summary: z
          .string()
          .describe("Brief summary of what was planned and key decisions made"),
      },
      async (args) => {
        // The actual handling happens in handleSdkMessage when it sees this tool_use
        return {
          content: [
            {
              type: "text",
              text: `Planning complete for "${args.feature_name}". Plan saved to ${args.plan_path}.\n\nSummary: ${args.summary}`,
            },
          ],
        };
      }
    ),
  ],
});

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
  plan_mode?: boolean; // Whether this is a plan mode session (enables planning tools)
  note_mode?: boolean; // Whether this is a note-taking mode session (read-only + note MCP tools)
  mcp_servers?: McpServerConfig[]; // External MCP servers to register
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
  effortLevel: string | null; // null, 'low', 'medium', 'high', 'max'
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

type InboundMessage =
  | CreateMessage
  | QueryMessage
  | CloseMessage
  | StopMessage
  | UpdateModelMessage
  | UpdateEffortMessage
  | GenerateRepoDescriptionMessage
  | GenerateRepoDescriptionWithCodexMessage;

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
  effortLevel?: string; // Effort level: null/undefined = off, 'low', 'medium', 'high', 'max'
  currentQueryId?: string; // Unique ID for the current query (to detect stale done events)
  planMode?: boolean; // Whether this is a plan mode session
  noteMode?: boolean; // Whether this is a note-taking mode session
  // OpenAI Codex-specific fields
  codexThread?: Thread; // Active Codex thread instance
  codexModel?: string; // OpenAI model to use
  codexSystemPrompt?: string; // System prompt to prepend to first Codex query (since ThreadOptions has no systemPrompt)
  appServer?: AppServerState; // Active Codex app-server process state
  appServerTurnId?: string; // Active app-server turn ID
  pendingParallelNotification?: string; // Queued notification to inject via PreToolUse hook when parallel session detected
}

const sessions = new Map<string, Session>();

// Track tool_use_id to tool_name mapping for matching tool results
const toolUseIdToName = new Map<string, string>();

// Track thinking state per session+context (key: "session_id-parentToolUseId" -> { startTime, content })
// Uses composite key to support concurrent thinking in main thread and subagents
const thinkingState = new Map<string, { startTime: number; content: string }>();

function send(msg: object): void {
  const line = JSON.stringify(msg) + "\n";
  process.stdout.write(line);
}

function sendText(id: string, content: string, parentToolUseId?: string | null): void {
  send({ type: "text", id, content, ...(parentToolUseId ? { parentToolUseId } : {}) });
}

function sendToolStart(
  id: string,
  tool: string,
  input: unknown,
  toolUseId: string,
  parentToolUseId?: string | null
): void {
  send({ type: "tool_start", id, tool, input, toolUseId, ...(parentToolUseId ? { parentToolUseId } : {}) });
}

function sendToolResult(
  id: string,
  tool: string,
  output: string,
  toolUseId: string,
  parentToolUseId?: string | null
): void {
  send({ type: "tool_result", id, tool, output, toolUseId, ...(parentToolUseId ? { parentToolUseId } : {}) });
}

function sendThinkingStart(id: string, content: string, parentToolUseId?: string | null): void {
  send({ type: "thinking_start", id, content, timestamp: Date.now(), ...(parentToolUseId ? { parentToolUseId } : {}) });
}

function sendThinkingEnd(
  id: string,
  durationMs: number,
  content: string,
  parentToolUseId?: string | null
): void {
  send({ type: "thinking_end", id, durationMs, content, ...(parentToolUseId ? { parentToolUseId } : {}) });
}

function sendDone(id: string): void {
  send({ type: "done", id });
}

function sendUsage(
  id: string,
  usage: {
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
  }
): void {
  send({ type: "progressive_usage", id, ...usage });
}

function sendError(id: string, message: string): void {
  send({ type: "error", id, message });
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
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
): void {
  send({ type: "task_completed", id, taskId, toolUseId, status, summary, usage });
}

function sendSdkSessionId(id: string, sdkSessionId: string): void {
  send({ type: "sdk_session_id", id, sdkSessionId });
}

// Planning mode specific events
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

function sendPlanningQuestions(
  id: string,
  questions: PlanningQuestion[]
): void {
  send({ type: "planning_questions", id, questions });
}

function sendPlanningComplete(
  id: string,
  planPath: string,
  featureName: string,
  summary: string
): void {
  send({ type: "planning_complete", id, planPath, featureName, summary });
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

function handleAppServerItemEvent(
  id: string,
  item: Record<string, unknown>,
  phase: "started" | "completed"
): void {
  const itemId = (item.id as string) || `item-${Date.now()}`;
  const type = normalizeItemType(item.type as string | undefined);

  if (type === "commandexecution") {
    if (phase === "started") {
      sendToolStart(id, "Bash", { command: item.command }, itemId);
    } else {
      const output =
        (item.aggregatedOutput as string) ||
        (item.aggregated_output as string) ||
        (item.stdout as string) ||
        (item.stderr as string) ||
        `exit code: ${String(item.exitCode ?? item.exit_code ?? "unknown")}`;
      sendToolResult(id, "Bash", output, itemId);
    }
    return;
  }

  if (type === "filechange") {
    const changes = (item.changes as Array<Record<string, unknown>>) || [];
    if (phase === "started") {
      const files = changes.map((c) => c.path).filter(Boolean).join(", ");
      sendToolStart(id, "Edit", { files: files || "unknown" }, itemId);
    } else {
      const summary =
        changes
          .map((c) => `${String(c.kind || "change")}: ${String(c.path || "")}`)
          .join("\n") || "File changes applied";
      sendToolResult(id, "Edit", summary, itemId);
    }
    return;
  }

  if (type === "mcptoolcall") {
    const server = String(item.server || "");
    const tool = String(item.tool || "");
    const toolName = tool ? `mcp__${server}__${tool}` : `mcp__${server}`;
    if (phase === "started") {
      sendToolStart(id, toolName, item.arguments, itemId);
    } else {
      const err = item.error as Record<string, unknown> | undefined;
      const result = item.result;
      const output = err
        ? `Error: ${String(err.message || "Unknown MCP error")}`
        : typeof result === "string"
          ? result
          : JSON.stringify(result ?? "");
      sendToolResult(id, toolName, output, itemId);
    }
    return;
  }

  if (type === "reasoning") {
    if (phase === "started") {
      sendThinkingStart(id, String(item.text || ""));
    } else {
      sendThinkingEnd(id, 0, String(item.text || ""));
    }
    return;
  }

  if (type === "agentmessage" && phase === "completed") {
    const text = item.text;
    if (typeof text === "string" && text) {
      sendText(id, text);
    }
  }
}

function handleAppServerNotification(id: string, notification: JsonRpcNotification): void {
  const session = sessions.get(id);
  if (!session) return;

  const params = (notification.params || {}) as Record<string, unknown>;
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
    case "thread/started": {
      const thread = params.thread as Record<string, unknown> | undefined;
      const threadId = thread?.id;
      if (typeof threadId === "string" && threadId) {
        setSessionSdkSessionId(session, threadId, id);
      }
      break;
    }
    case "item/agentMessage/delta": {
      // Intentionally ignore deltas: emit only completed full assistant message.
      break;
    }
    case "item/started": {
      const item = params.item as Record<string, unknown> | undefined;
      if (item) handleAppServerItemEvent(id, item, "started");
      break;
    }
    case "item/completed": {
      const item = params.item as Record<string, unknown> | undefined;
      if (item) handleAppServerItemEvent(id, item, "completed");
      break;
    }
    case "turn/completed": {
      const turn = params.turn as Record<string, unknown> | undefined;
      const turnId = turn?.id;
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
    case "thread/tokenUsage/updated": {
      // TokenCountEvent: { info: TokenUsageInfo | null, rate_limits: ... }
      // TokenUsageInfo: { total_token_usage: TokenUsage, last_token_usage: TokenUsage, model_context_window: number | null }
      // TokenUsage: { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens }
      const info = params.info as Record<string, unknown> | undefined;
      if (info) {
        const lastUsage = info.last_token_usage as Record<string, number> | undefined;
        const totalUsage = info.total_token_usage as Record<string, number> | undefined;
        const contextWindow = (info.model_context_window as number) || 200000;

        if (lastUsage) {
          sendUsage(id, {
            inputTokens: lastUsage.input_tokens || 0,
            outputTokens: lastUsage.output_tokens || 0,
            cacheReadTokens: lastUsage.cached_input_tokens || 0,
            cacheCreationTokens: 0,
            totalCostUsd: 0, // App server doesn't report cost
            durationMs: 0,
            durationApiMs: 0,
            numTurns: 1,
            contextWindow,
          });
        }

        // Also send progressive usage with cumulative totals for live context bar updates
        if (totalUsage) {
          sendProgressiveUsage(id, {
            inputTokens: totalUsage.input_tokens || 0,
            outputTokens: totalUsage.output_tokens || 0,
            cacheReadTokens: totalUsage.cached_input_tokens || 0,
            cacheCreationTokens: 0,
          });
        }
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
  let child: ChildProcessWithoutNullStreams;
  if (globalThis.process.platform === "win32") {
    // On Windows, .cmd shims require launching via cmd.exe.
    const cmd = codexExecutable === "codex"
      ? "codex app-server"
      : `"${codexExecutable}" app-server`;
    child = spawn("cmd.exe", ["/d", "/s", "/c", cmd], {
      cwd: session.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } else {
    child = spawn(codexExecutable, ["app-server"], {
      cwd: session.cwd,
      stdio: ["pipe", "pipe", "pipe"],
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
      name: "claude_whisperer",
      title: "Claude Whisperer",
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

    const inputItems: Array<Record<string, unknown>> = [];
    if (session.codexSystemPrompt) {
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

    const turnResult = (await appServerRequest(
      appServer,
      "turn/start",
      {
        threadId,
        input: inputItems.length > 0 ? inputItems : [{ type: "text", text: "" }],
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
          totalCostUsd: 0, // Codex SDK doesn't report cost directly
          durationMs: 0,
          durationApiMs: 0,
          numTurns: 1,
          contextWindow: 200000,
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
  item: ThreadEvent extends { item: infer I } ? I : never,
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
  };

  switch (typedItem.type) {
    case "agent_message":
      if (phase === "completed" && typedItem.text) {
        sendText(id, typedItem.text);
      } else if (phase === "updated" && typedItem.text) {
        // Stream partial text as it comes in
        sendText(id, typedItem.text);
      }
      break;

    case "reasoning":
      if (phase === "started") {
        sendThinkingStart(id, typedItem.text || "");
      } else if (phase === "completed") {
        sendThinkingEnd(id, 0, typedItem.text || "");
      }
      break;

    case "command_execution":
      if (phase === "started") {
        sendToolStart(
          id,
          "Bash",
          { command: typedItem.command },
          typedItem.id
        );
      } else if (phase === "completed") {
        sendToolResult(
          id,
          "Bash",
          typedItem.aggregated_output || `exit code: ${typedItem.exit_code}`,
          typedItem.id
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
          typedItem.id
        );
      } else if (phase === "completed") {
        const summary =
          typedItem.changes
            ?.map((c) => `${c.kind}: ${c.path}`)
            .join("\n") || "File changes applied";
        sendToolResult(id, "Edit", summary, typedItem.id);
      }
      break;

    case "mcp_tool_call":
      if (phase === "started") {
        const toolName = typedItem.tool
          ? `mcp__${typedItem.server}__${typedItem.tool}`
          : `mcp__${typedItem.server}`;
        sendToolStart(id, toolName, typedItem.arguments, typedItem.id);
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
        sendToolResult(id, toolName, output, typedItem.id);
      }
      break;

    case "web_search":
      if (phase === "started") {
        sendToolStart(
          id,
          "WebSearch",
          { query: typedItem.query },
          typedItem.id
        );
      } else if (phase === "completed") {
        sendToolResult(id, "WebSearch", "Search completed", typedItem.id);
      }
      break;

    case "error":
      if (phase === "completed") {
        sendError(id, (typedItem as { message?: string }).message || "Unknown error");
      }
      break;
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

      if (resumeId) {
        send({
          type: "debug",
          id: msg.id,
          message: `Resuming Codex thread: ${resumeId}`,
        });
        session.codexThread = codex.resumeThread(resumeId);
      } else {
        send({
          type: "debug",
          id: msg.id,
          message: `Starting new Codex thread in ${session.cwd}`,
        });
        session.codexThread = codex.startThread({
          workingDirectory: session.cwd,
          model: session.codexModel,
          approvalPolicy: "never",
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

async function handleCreate(msg: CreateMessage): Promise<void> {
  const options: Options = {
    cwd: msg.cwd,
    permissionMode: "acceptEdits",
    // Load CLAUDE.md and settings from filesystem like Claude Code does
    settingSources: ["user", "project", "local"],
    ...(msg.model && { model: msg.model }),
    ...(msg.system_prompt && { systemPrompt: msg.system_prompt }),
    ...msg.options,
    // Allow all MCP tools to execute without permission prompts
    // This callback fires when Claude would show a permission prompt
    canUseTool: async (toolName: string, input: unknown) => {
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

  // Add in-process MCP server for plan mode at creation time
  // Using createSdkMcpServer for reliable in-process tool registration
  if (msg.plan_mode) {
    send({
      type: "debug",
      id: msg.id,
      message:
        "Plan mode: configuring in-process MCP server with planning tools",
    });

    options.mcpServers = {
      ...options.mcpServers,
      "planning-tools": planningMcpServer,
    };

    options.allowedTools = [
      ...(options.allowedTools || []),
      "mcp__planning-tools__ask_planning_questions",
      "mcp__planning-tools__complete_planning",
    ];
  }

  // Configure note mode with read-only tools + MCP note tools
  if (msg.note_mode) {
    send({
      type: "debug",
      id: msg.id,
      message: "Note mode: configuring read-only access with note MCP tools",
    });

    // Don't load user/project/local settings for note mode - this prevents Claude
    // from seeing all the tool descriptions in its system prompt. We only want
    // Claude to see the read-only tools and MCP tools that are actually allowed.
    options.settingSources = [];

    // Start with read-only codebase tools only
    // MCP tool patterns will be added below when MCP servers are registered
    options.allowedTools = [
      "Read",
      "Glob",
      "Grep",
    ];
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

  const provider = msg.provider || "claude";
  const openaiMode: OpenAiExecutionMode =
    provider === "openai" && msg.codex_mode === "AppServer"
      ? "app_server"
      : "sdk";

  sessions.set(msg.id, {
    cwd: msg.cwd,
    provider,
    openaiMode,
    options,
    passedSdkSessionId: msg.sdk_session_id, // SDK session ID for proper resume
    conversationHistory: msg.messages, // Store conversation history for restored sessions (DEPRECATED)
    planMode: msg.plan_mode,
    noteMode: msg.note_mode,
    codexModel: provider === "openai" ? msg.model : undefined,
    codexSystemPrompt: provider === "openai" ? msg.system_prompt : undefined,
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

  if (msg.plan_mode) {
    send({
      type: "debug",
      id: msg.id,
      message: "Session created in PLAN MODE - planning tools enabled",
    });
  }

  if (msg.note_mode) {
    send({
      type: "debug",
      id: msg.id,
      message: "Session created in NOTE MODE - read-only tools + note MCP enabled",
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

// Create an async iterable that yields a single SDKUserMessage for multimodal prompts
async function* createUserMessageStream(
  prompt: string,
  images: ImageData[],
  sessionId: string
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
      const queryId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      // Claim query ownership before preempting so stale completions can't close the new run.
      session.currentQueryId = queryId;
      if (session.abortController || session.appServerTurnId) {
        send({
          type: "debug",
          id: msg.id,
          message:
            "[app-server query] previous query still in progress; stopping it before starting a new turn",
        });
        await handleStop({ type: "stop", id: msg.id });
      }
      return handleCodexAppServerQuery(msg, queryId);
    }
    return handleCodexQuery(msg);
  }

  // === Claude provider path (unchanged) ===

  // Generate a unique query ID to track this specific query
  // This prevents stale done/error events from affecting newer queries
  const queryId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // If there's already a query in progress, interrupt it first
  // This prevents race conditions where the old query's 'done' event arrives after the new query starts
  if (session.queryIterator) {
    send({
      type: "debug",
      id: msg.id,
      message: "Previous query still in progress, interrupting it first...",
    });
    try {
      await session.queryIterator.interrupt();
      send({
        type: "debug",
        id: msg.id,
        message: "Previous query interrupted successfully",
      });
    } catch (err) {
      send({
        type: "debug",
        id: msg.id,
        message: `Error interrupting previous query: ${err}`,
      });
      // Fall back to abort controller if interrupt fails
      if (session.abortController) {
        session.abortController.abort();
      }
    }
    session.queryIterator = undefined;
    session.abortController = undefined;
  }

  // Set this as the current query BEFORE starting
  session.currentQueryId = queryId;

  const hasImages = msg.images && msg.images.length > 0;

  // Determine the SDK session ID to use for resume:
  // 1. If we have a captured sdkSessionId from a previous query, use that
  // 2. If we have a passedSdkSessionId from the frontend (restored session), use that
  // 3. Otherwise, no resume
  const resumeSessionId = session.sdkSessionId || session.passedSdkSessionId;

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

    // Build the prompt - for images we need to use AsyncIterable<SDKUserMessage>
    // For text-only prompts we can use a simple string
    let promptInput: string | AsyncGenerator<SDKUserMessageForInput>;
    if (hasImages) {
      // Use the session ID if we have one, otherwise use the message ID as placeholder
      const sessionId = session.sdkSessionId || msg.id;
      promptInput = createUserMessageStream(
        promptToSend,
        msg.images!,
        sessionId
      );
      send({
        type: "debug",
        id: msg.id,
        message: `Built multimodal prompt stream with ${
          msg.images!.length
        } image(s)`,
      });
    } else {
      promptInput = promptToSend;
    }

    // Common options for both text and multimodal queries
    const queryOptions: Options & { abortController: AbortController } = {
      ...session.options,
      abortController,
      // Resume from previous session if we have one (either captured or passed from frontend)
      resume: resumeSessionId,
      // Capture stderr for debugging
      stderr: (data: string) => {
        send({ type: "debug", id: msg.id, message: `[stderr] ${data}` });
      },
      // Hook callbacks for subagent lifecycle events and parallel agent detection
      hooks: {
        PreToolUse: [
          {
            hooks: [
              (async (_input: PreToolUseHookInput) => {
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
              async (input: SubagentStartHookInput) => {
                sendSubagentStart(msg.id, input.agent_id, input.agent_type);
                // If a parallel session was detected, inject context into new subagents
                // so they're aware of concurrent work (subagents don't inherit parent hooks)
                const s = sessions.get(msg.id);
                if (s?.pendingParallelNotification) {
                  send({
                    type: "debug",
                    id: msg.id,
                    message: `Injecting parallel agent notification into subagent ${input.agent_id} via additionalContext`,
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
              },
            ],
          },
        ],
        SubagentStop: [
          {
            hooks: [
              async (input: SubagentStopHookInput) => {
                sendSubagentStop(
                  msg.id,
                  input.agent_id,
                  input.agent_transcript_path
                );
                return { continue: true };
              },
            ],
          },
        ],
      },
    };

    // Note: MCP servers for plan mode are configured in handleCreate() at session creation time
    // The session.options already include mcpServers and allowedTools for planning tools
    if (session.planMode) {
      send({
        type: "debug",
        id: msg.id,
        message: `Plan mode query - MCP servers configured: ${Object.keys(
          session.options.mcpServers || {}
        ).join(", ")}`,
      });
    }

    // Use the query function from the SDK
    let queryIterator;
    try {
      // The SDK accepts either a string or AsyncIterable<SDKUserMessage> for prompt
      queryIterator = query({
        prompt: promptInput as string, // Type assertion - SDK accepts both
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
    for await (const message of queryIterator) {
      messageCount++;
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
    if (session.currentQueryId === queryId) {
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
    if (session.currentQueryId === queryId) {
      sendError(msg.id, errorMessage);
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
    }
  }
}

function handleSdkMessage(id: string, message: SDKMessage): void {
  switch (message.type) {
    case "assistant": {
      // Assistant message with content blocks
      // Extract parent_tool_use_id for task/subagent scoping
      const parentToolUseId = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id || null;
      const thinkingKey = `${id}-${parentToolUseId || "main"}`;
      send({
        type: "debug",
        id,
        message: `Assistant message has ${message.message.content.length} content blocks (parent: ${parentToolUseId || "main"})`,
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
            sendThinkingStart(id, thinkingContent, parentToolUseId);
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
          sendThinkingEnd(id, durationMs, state.content, parentToolUseId);
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
          sendText(id, block.text, parentToolUseId);
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
          sendToolStart(id, block.name, block.input, toolUseId, parentToolUseId);

          // Handle planning-specific tools (both direct names and MCP-prefixed names)
          const toolName = block.name;
          const isAskPlanningQuestions =
            toolName === "ask_planning_questions" ||
            toolName === "mcp__planning-tools__ask_planning_questions";
          const isCompletePlanning =
            toolName === "complete_planning" ||
            toolName === "mcp__planning-tools__complete_planning";

          if (isAskPlanningQuestions) {
            const input = block.input as { questions?: PlanningQuestion[] };
            if (input.questions && Array.isArray(input.questions)) {
              send({
                type: "debug",
                id,
                message: `Planning questions tool called with ${input.questions.length} questions`,
              });
              sendPlanningQuestions(id, input.questions);
            }
          } else if (isCompletePlanning) {
            const input = block.input as {
              plan_path?: string;
              feature_name?: string;
              summary?: string;
            };
            if (input.plan_path && input.feature_name && input.summary) {
              send({
                type: "debug",
                id,
                message: `Planning complete: ${input.feature_name}`,
              });
              sendPlanningComplete(
                id,
                input.plan_path,
                input.feature_name,
                input.summary
              );
            }
          }
        }
      }
      // Send progressive usage data from assistant message if available
      if (message.message.usage) {
        const usage = message.message.usage;
        sendProgressiveUsage(id, {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
        });
      }
      break;
    }

    case "partial_assistant": {
      // Streaming partial message
      const partialParentToolUseId = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id || null;
      if (message.delta?.text) {
        sendText(id, message.delta.text, partialParentToolUseId);
      }
      break;
    }

    case "result":
      // Final result message - send usage data and handle errors
      if (message.subtype === "success") {
        // Extract usage data from successful result
        const modelUsageValues = Object.values(message.modelUsage || {});
        const contextWindow =
          modelUsageValues.length > 0
            ? modelUsageValues[0].contextWindow
            : 200000;

        sendUsage(id, {
          inputTokens: message.usage?.input_tokens || 0,
          outputTokens: message.usage?.output_tokens || 0,
          cacheReadTokens: message.usage?.cache_read_input_tokens || 0,
          cacheCreationTokens: message.usage?.cache_creation_input_tokens || 0,
          totalCostUsd: message.total_cost_usd || 0,
          durationMs: message.duration_ms || 0,
          durationApiMs: message.duration_api_ms || 0,
          numTurns: message.num_turns || 0,
          contextWindow,
        });
      } else if (
        message.subtype === "error" ||
        message.subtype === "error_tool_use"
      ) {
        // Still send usage data even for errors (if available)
        if (message.usage) {
          const modelUsageValues = Object.values(message.modelUsage || {});
          const contextWindow =
            modelUsageValues.length > 0
              ? modelUsageValues[0].contextWindow
              : 200000;

          sendUsage(id, {
            inputTokens: message.usage?.input_tokens || 0,
            outputTokens: message.usage?.output_tokens || 0,
            cacheReadTokens: message.usage?.cache_read_input_tokens || 0,
            cacheCreationTokens:
              message.usage?.cache_creation_input_tokens || 0,
            totalCostUsd: message.total_cost_usd || 0,
            durationMs: message.duration_ms || 0,
            durationApiMs: message.duration_api_ms || 0,
            numTurns: message.num_turns || 0,
            contextWindow,
          });
        }
        sendError(id, message.error || "Unknown error");
      }
      // Don't send result.result as text - it duplicates the assistant message content
      break;

    case "user": {
      // User messages contain tool results
      // Extract parent_tool_use_id for task/subagent scoping
      const userParentToolUseId = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id || null;
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
            if (typeof toolResultBlock.content === "string") {
              output = toolResultBlock.content;
            } else if (Array.isArray(toolResultBlock.content)) {
              // Content can be array of text/image blocks
              output = toolResultBlock.content
                .filter((c) => c.type === "text")
                .map((c) => c.text || "")
                .join("\n");
            }

            send({
              type: "debug",
              id,
              message: `Tool result for ${toolName} (${toolUseId}): ${output.slice(
                0,
                100
              )}...`,
            });
            sendToolResult(id, toolName, output, toolUseId, userParentToolUseId);

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
      if (sysMsg.subtype === "task_started") {
        send({
          type: "debug",
          id,
          message: `Task started: ${sysMsg.task_id} (toolUseId: ${sysMsg.tool_use_id}, desc: ${sysMsg.description?.slice(0, 80)})`,
        });
        sendTaskStarted(id, sysMsg.task_id!, sysMsg.tool_use_id, sysMsg.description || "", sysMsg.task_type);
      } else if (sysMsg.subtype === "task_notification") {
        send({
          type: "debug",
          id,
          message: `Task completed: ${sysMsg.task_id} (status: ${sysMsg.status}, summary: ${sysMsg.summary?.slice(0, 80)})`,
        });
        sendTaskCompleted(id, sysMsg.task_id!, sysMsg.tool_use_id, sysMsg.status || "completed", sysMsg.summary || "", sysMsg.usage);
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

  // Use interrupt() on the query iterator - this is the proper way to stop
  // the query and all subagents. The abort controller alone doesn't properly
  // stop subagents that are already running.
  if (session.queryIterator) {
    send({
      type: "debug",
      id: msg.id,
      message: "Interrupting query via iterator.interrupt()...",
    });
    try {
      await session.queryIterator.interrupt();
      send({
        type: "debug",
        id: msg.id,
        message: "Query interrupted successfully",
      });
    } catch (err) {
      send({
        type: "debug",
        id: msg.id,
        message: `Error interrupting query: ${err}`,
      });
      // Fall back to abort controller if interrupt fails
      if (session.abortController) {
        session.abortController.abort();
      }
    }
    session.queryIterator = undefined;
    session.abortController = undefined;
  } else if (session.abortController) {
    send({
      type: "debug",
      id: msg.id,
      message: "No query iterator, falling back to abortController.abort()...",
    });
    session.abortController.abort();
    session.abortController = undefined;
  } else {
    send({ type: "debug", id: msg.id, message: "No active query to stop" });
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

  // Update the effort level in the session
  session.effortLevel = msg.effortLevel ?? undefined;

  // For Claude provider: set native effort option (SDK 0.2.49+ passes --effort to CLI)
  if (session.provider === "claude") {
    session.options.effort = (msg.effortLevel as Options["effort"]) ?? undefined;
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
