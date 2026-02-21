// =============================================================================
// Sequence Definition Types (mirrors types.rs)
// =============================================================================

export interface SequenceDefinition {
  id: string;
  name: string;
  description?: string;
  version?: string;
  tags: string[];
  defaults?: SequenceDefaults;
  inputs: SequenceInput[];
  nodes: NodeDefinition[];
  cleanup: NodeDefinition[];
  triggers: SequenceTrigger[];
  repos: string[];
}

export interface SequenceInput {
  name: string;
  type: InputType;
  description?: string;
  required: boolean;
  default?: unknown;
  validation?: InputValidation;
}

export type InputType = "string" | "number" | "boolean" | "repo_list";

export interface InputValidation {
  min_length?: number;
  max_length?: number;
  pattern?: string;
  enum?: string[];
  min?: number;
  max?: number;
  integer?: boolean;
}

export interface SequenceDefaults {
  model?: string;
  effort?: string;
  repo?: string;
  isolation?: boolean;
  timeout?: number;
  on_error?: ErrorStrategy;
}

export interface NodeDefinition {
  id: string;
  name?: string;
  type: string; // discriminator
  condition?: string;
  timeout?: number;
  on_error?: ErrorStrategy;
  retry_count?: number;
  retry_delay?: number;
  retry_backoff?: number;
  next?: string;
  outputs: OutputMapping[];
  _editor_position?: { x: number; y: number };
  // Node-specific fields are flattened
  [key: string]: unknown;
}

export type ErrorStrategy =
  | "stop"
  | "retry"
  | "skip"
  | { goto: { target: string } };

export interface OutputMapping {
  name: string;
  value: string;
}

export interface PromptNode {
  prompt: string;
  model?: string;
  provider?: string;
  effort?: string;
  system_prompt?: string;
  output_format?: string;
  images: string[];
  tools?: string[];
  mcp_servers?: string[];
  session?: SessionConfig;
}

export interface SessionConfig {
  mode?: string;
  id?: string;
}

export interface RouteNode {
  eval?: string;
  prompt?: string;
  context?: string;
  model?: string;
  branches: Record<string, RouteBranch>;
  default?: string;
  multi?: boolean;
  min?: number;
  max?: number;
  execution?: string;
}

export type RouteBranch = string | RouteBranchLong;

export interface RouteBranchLong {
  description?: string;
  next: string;
}

export interface ScriptNode {
  command: string;
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface NotifyNode {
  channel?: string;
  message: string;
  title?: string;
  preset?: string;
  webhook?: string;
  on_notify_error?: string;
  blocks?: unknown;
  embed?: unknown;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface DelayNode {
  duration: string;
  message?: string;
}

export interface TransformNode {
  input: string;
  operations: TransformOperation[];
}

export interface TransformOperation {
  type: "regex" | "json_path" | "template";
  pattern?: string;
  replacement?: string;
  path?: string;
  template?: string;
}

export interface ApprovalNode {
  message: string;
  timeout?: number;
  on_timeout?: string;
  notify?: string;
}

export interface LoopNode {
  max_iterations?: number;
  until?: string;
  delay?: string;
  nodes: NodeDefinition[];
  on_max_iterations?: string;
  on_break?: string;
}

export interface ParallelNode {
  branches: Record<string, NodeDefinition[]>;
  wait?: "all" | "first" | "any" | number;
  on_branch_error?: "ignore" | "skip" | "cancel_others" | "fail";
  next?: string;
}

export interface ForEachNode {
  items: string;
  variable?: string;
  mode?: "sequential" | "parallel";
  max_parallel?: number;
  on_item_error?: string;
  nodes: NodeDefinition[];
  outputs?: OutputMapping[];
}

// Git nodes
export interface GitBranchNode {
  branch_name: string;
  from?: string;
}

export interface GitWorktreeNode {
  branch_name: string;
  worktree_path?: string;
}

export interface GitCommitNode {
  message: string;
  add?: string[];
  files?: string[];
}

export interface GitPushNode {
  remote?: string;
  force?: boolean;
}

export interface GitDeleteBranchNode {
  branch: string;
  remote?: boolean;
}

export interface GitDeleteWorktreeNode {
  path: string;
}

// GitHub nodes
export interface GitHubPrNode {
  title: string;
  body?: string;
  target_branch?: string;
  draft?: boolean;
  labels?: string[];
  reviewers?: string[];
  outputs?: OutputMapping[];
}

export interface GitHubPrWaitNode {
  pr: string;
  wait_for: string;
  poll_interval?: number;
  timeout?: number;
  outputs?: OutputMapping[];
}

export interface GitHubPrMergeNode {
  pr: string;
  method?: string;
  delete_branch?: boolean;
}

// Action nodes
export interface WaitNode {
  condition?: string;
  poll_interval?: number;
  timeout?: number;
  poll_command?: string;
  on_timeout?: string;
  on_success?: string;
  on_failure?: string;
}

export interface FileNode {
  operation: string;
  path?: string;
  content?: string;
  source?: string;
  destination?: string;
  outputs?: OutputMapping[];
}

export interface HttpNode {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  expected_status?: number[];
  outputs?: OutputMapping[];
}

export interface SubSequenceNode {
  sequence: string;
  inputs?: Record<string, unknown>;
  outputs?: OutputMapping[];
}

// Triggers
export type SequenceTrigger =
  | { type: "manual" }
  | { type: "schedule"; cron: string; timezone?: string; inputs?: Record<string, unknown> }
  | {
      type: "event";
      event_type: string;
      filter?: Record<string, string>;
      inputs?: Record<string, string>;
      cooldown?: number;
      max_per_day?: number;
      once_per_day?: boolean;
    };

// =============================================================================
// Execution State Types (mirrors state.rs)
// =============================================================================

export type ExecutionStatus =
  | { status: "initializing" }
  | { status: "running" }
  | { status: "paused" }
  | { status: "waiting_for_approval"; node_id: string }
  | { status: "waiting_for_condition"; node_id: string }
  | { status: "completed" }
  | { status: "failed" }
  | { status: "cancelled" }
  | { status: "cleaning_up" };

export type NodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "waiting_approval"
  | "retrying";

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_creation: number;
}

export interface NodeResult {
  status: NodeStatus;
  started_at?: string;
  finished_at?: string;
  output?: unknown;
  error?: string;
  retry_count: number;
  sdk_session_id?: string;
  duration_ms?: number;
  cost?: number;
  tokens?: TokenUsage;
}

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogEntry {
  timestamp: string;
  node_id?: string;
  level: LogLevel;
  message: string;
}

export interface SequenceExecution {
  id: string;
  sequence_id: string;
  sequence_name: string;
  sequence_version?: string;
  started_at: string;
  completed_at?: string;
  paused_at?: string;
  status: ExecutionStatus;
  current_node_id?: string;
  node_results: Record<string, NodeResult>;
  session_ids: string[];
  inputs: Record<string, unknown>;
  total_tokens: TokenUsage;
  total_cost: number;
  log: LogEntry[];
  error?: string;
  completed_node_ids: string[];
  total_nodes: number;
}

export interface ExecutionSummary {
  id: string;
  sequence_id: string;
  sequence_name: string;
  status: ExecutionStatus;
  started_at: string;
  completed_at?: string;
  total_cost: number;
  completed_nodes: number;
  total_nodes: number;
  error?: string;
}

// =============================================================================
// Event Payload Types (for Tauri events)
// =============================================================================

export interface SequenceNodeStartEvent {
  execution_id: string;
  node_id: string;
  node_name?: string;
  node_type: string;
}

export interface SequenceNodeCompleteEvent {
  execution_id: string;
  node_id: string;
  output?: unknown;
  duration_ms: number;
  cost?: number;
}

export interface SequenceNodeErrorEvent {
  execution_id: string;
  node_id: string;
  error: string;
}

export interface SequenceStatusEvent {
  execution_id: string;
  status: ExecutionStatus;
}

export interface SequenceLogEvent {
  execution_id: string;
  entry: LogEntry;
}

// =============================================================================
// Schedule Types (for Phase 4B)
// =============================================================================

export interface ScheduleInfo {
  sequence_id: string;
  sequence_name: string;
  cron: string;
  timezone?: string;
  enabled: boolean;
  next_fire?: string;
  last_run?: string;
}

// =============================================================================
// Event Trigger Types
// =============================================================================

export interface EventTriggerInfo {
  sequence_id: string;
  sequence_name: string;
  event_type: string;
  cooldown_ms: number;
  max_per_day: number;
  once_per_day: boolean;
  last_fired?: string;
  today_count: number;
  active: boolean;
}
