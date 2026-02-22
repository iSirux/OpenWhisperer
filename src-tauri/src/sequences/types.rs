use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ─── Sequence Definition (top-level YAML structure) ──────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceDefinition {
    /// Derived from filename stem when loaded from disk
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default = "default_version")]
    pub version: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub defaults: Option<SequenceDefaults>,
    #[serde(default)]
    pub inputs: Vec<SequenceInput>,
    pub nodes: Vec<NodeDefinition>,
    #[serde(default)]
    pub cleanup: Vec<NodeDefinition>,
    #[serde(default)]
    pub triggers: Vec<SequenceTrigger>,
    /// Restrict this sequence to specific repository paths
    #[serde(default)]
    pub repos: Vec<String>,
}

fn default_version() -> Option<String> {
    Some("1.0".to_string())
}

// ─── Sequence Inputs ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceInput {
    pub name: String,
    #[serde(rename = "type")]
    pub input_type: InputType,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default = "default_true")]
    pub required: bool,
    #[serde(default)]
    pub default: Option<serde_json::Value>,
    #[serde(default)]
    pub validation: Option<InputValidation>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum InputType {
    String,
    Number,
    Boolean,
    RepoList,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputValidation {
    #[serde(default)]
    pub min_length: Option<usize>,
    #[serde(default)]
    pub max_length: Option<usize>,
    #[serde(default)]
    pub pattern: Option<String>,
    #[serde(default, rename = "enum")]
    pub enum_values: Option<Vec<String>>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub integer: Option<bool>,
}

// ─── Sequence Defaults ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceDefaults {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub isolation: Option<bool>,
    /// Default timeout in seconds
    #[serde(default)]
    pub timeout: Option<u64>,
    #[serde(default)]
    pub on_error: Option<ErrorStrategy>,
}

// ─── Node Definition ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeDefinition {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(flatten)]
    pub node_type: NodeType,
    /// Template expression evaluated to determine if this node should execute
    #[serde(default)]
    pub condition: Option<String>,
    /// Timeout in seconds
    #[serde(default)]
    pub timeout: Option<u64>,
    #[serde(default)]
    pub on_error: Option<ErrorStrategy>,
    #[serde(default)]
    pub retry_count: Option<u32>,
    /// Retry delay in seconds
    #[serde(default)]
    pub retry_delay: Option<u64>,
    /// Retry backoff multiplier
    #[serde(default)]
    pub retry_backoff: Option<f64>,
    /// Next node id to execute after this one
    #[serde(default)]
    pub next: Option<String>,
    #[serde(default)]
    pub outputs: Vec<OutputMapping>,
}

// ─── Node Types (tagged union) ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NodeType {
    Prompt(PromptNode),
    Route(RouteNode),
    Script(ScriptNode),
    Notify(NotifyNode),
    Delay(DelayNode),
    Transform(TransformNode),
    GitBranch(GitBranchNode),
    GitWorktree(GitWorktreeNode),
    GitCommit(GitCommitNode),
    GitPush(GitPushNode),
    GitDeleteBranch(GitDeleteBranchNode),
    GitDeleteWorktree(GitDeleteWorktreeNode),
    GithubPr(GitHubPrNode),
    GithubPrWait(GitHubPrWaitNode),
    GithubPrMerge(GitHubPrMergeNode),
    Approval(ApprovalNode),
    Wait(WaitNode),
    File(FileNode),
    Http(HttpNode),
    Loop(LoopNode),
    Parallel(ParallelNode),
    ForEach(ForEachNode),
    SubSequence(SubSequenceNode),
    Trigger(TriggerNodeConfig),
}

// ─── Prompt Node ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptNode {
    /// Template string for the prompt
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Output format hint (e.g., "json")
    #[serde(default)]
    pub output_format: Option<String>,
    /// Image paths to include in the prompt
    #[serde(default)]
    pub images: Vec<String>,
    /// Restrict which tools Claude can use
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    /// MCP servers to enable for this prompt
    #[serde(default)]
    pub mcp_servers: Option<Vec<String>>,
    #[serde(default)]
    pub session: Option<SessionConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfig {
    /// Session mode: new, continue, shared, note
    #[serde(default)]
    pub mode: Option<String>,
    /// Session id for continue/shared modes
    #[serde(default)]
    pub id: Option<String>,
}

// ─── Route Node ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteNode {
    /// Template expression for evaluation-based routing
    #[serde(default)]
    pub eval: Option<String>,
    /// AI classification prompt for LLM-based routing
    #[serde(default)]
    pub prompt: Option<String>,
    /// Additional context for AI routing
    #[serde(default)]
    pub context: Option<String>,
    /// Model for AI routing
    #[serde(default)]
    pub model: Option<String>,
    /// Branch definitions mapping keys to targets
    #[serde(default)]
    pub branches: HashMap<String, RouteBranch>,
    /// Default branch node id when no branch matches
    #[serde(default)]
    pub default: Option<String>,
    /// Enable multi-select routing
    #[serde(default)]
    pub multi: Option<bool>,
    /// Minimum selections for multi-select
    #[serde(default)]
    pub min: Option<usize>,
    /// Maximum selections for multi-select
    #[serde(default)]
    pub max: Option<usize>,
    /// Execution mode for multi-select: "sequential" or "parallel"
    #[serde(default)]
    pub execution: Option<String>,
}

/// Route branch can be either a short-form string (just the target node id)
/// or a long-form object with description and next target.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RouteBranch {
    /// Short form: just the target node id
    Short(String),
    /// Long form: description + target node id
    Long {
        #[serde(default)]
        description: Option<String>,
        next: String,
    },
}

impl RouteBranch {
    /// Get the target node id regardless of form
    pub fn target(&self) -> &str {
        match self {
            RouteBranch::Short(id) => id,
            RouteBranch::Long { next, .. } => next,
        }
    }
}

// ─── Script Node ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptNode {
    pub command: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
}

// ─── Notify Node ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotifyNode {
    /// Show a system notification (built-in, always available)
    #[serde(default = "default_true")]
    pub system_notification: bool,
    /// Play a notification sound (built-in, always available)
    #[serde(default)]
    pub play_sound: bool,
    /// Which sound to play (1-10), defaults to 1
    #[serde(default)]
    pub sound: Option<u8>,
    /// Notification channel id (for external channels: Slack, Discord, Webhook)
    #[serde(default)]
    pub channel: Option<String>,
    /// Message template
    pub message: String,
    #[serde(default)]
    pub title: Option<String>,
    /// Notification preset name
    #[serde(default)]
    pub preset: Option<String>,
    /// Webhook URL (deprecated, use url)
    #[serde(default)]
    pub webhook: Option<String>,
    /// Error handling: warn, stop, retry
    #[serde(default)]
    pub on_notify_error: Option<String>,
    /// Slack blocks payload
    #[serde(default)]
    pub blocks: Option<serde_json::Value>,
    /// Discord embed payload
    #[serde(default)]
    pub embed: Option<serde_json::Value>,
    /// Webhook URL
    #[serde(default)]
    pub url: Option<String>,
    /// HTTP method
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    /// Body template
    #[serde(default)]
    pub body: Option<String>,
}

// ─── Delay Node ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelayNode {
    /// Duration string (e.g., "5s", "1m", "2h")
    pub duration: String,
    #[serde(default)]
    pub message: Option<String>,
}

// ─── Transform Node ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformNode {
    /// Template expression for the input data
    pub input: String,
    pub operations: Vec<TransformOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformOperation {
    #[serde(rename = "type")]
    pub op_type: TransformOpType,
    #[serde(default)]
    pub pattern: Option<String>,
    #[serde(default)]
    pub replacement: Option<String>,
    /// JSON path expression
    #[serde(default)]
    pub path: Option<String>,
    /// Template string
    #[serde(default)]
    pub template: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TransformOpType {
    Regex,
    JsonPath,
    Template,
}

// ─── Git Nodes ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitBranchNode {
    pub branch_name: String,
    /// Base branch/ref to create from
    #[serde(default)]
    pub from: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitWorktreeNode {
    pub branch_name: String,
    #[serde(default)]
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommitNode {
    /// Commit message template
    pub message: String,
    /// Glob patterns to stage
    #[serde(default)]
    pub add: Option<Vec<String>>,
    /// Specific files to stage
    #[serde(default)]
    pub files: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitPushNode {
    #[serde(default)]
    pub remote: Option<String>,
    #[serde(default)]
    pub force: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitDeleteBranchNode {
    pub branch: String,
    /// Also delete the remote branch
    #[serde(default)]
    pub remote: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitDeleteWorktreeNode {
    pub path: String,
}

// ─── GitHub Nodes ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubPrNode {
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub target_branch: Option<String>,
    #[serde(default)]
    pub draft: Option<bool>,
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    #[serde(default)]
    pub reviewers: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubPrWaitNode {
    /// PR number or template expression
    pub pr: String,
    /// What to wait for: "checks", "reviews", "merge"
    pub wait_for: String,
    /// Poll interval in seconds
    #[serde(default)]
    pub poll_interval: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubPrMergeNode {
    /// PR number or template expression
    pub pr: String,
    /// Merge method: "merge", "squash", "rebase"
    #[serde(default)]
    pub method: Option<String>,
    /// Delete branch after merge
    #[serde(default)]
    pub delete_branch: Option<bool>,
}

// ─── Control Flow Nodes ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalNode {
    /// Message to display for approval request
    pub message: String,
    /// Action on timeout (node id or "skip"/"fail")
    #[serde(default)]
    pub on_timeout: Option<String>,
    /// Notification channel to send approval request
    #[serde(default)]
    pub notify: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaitNode {
    /// Template expression that must evaluate to truthy (renamed from `condition`
    /// to avoid conflict with NodeDefinition.condition which controls whether the
    /// node should execute at all)
    #[serde(default)]
    pub poll_condition: Option<String>,
    /// Poll interval in seconds
    #[serde(default)]
    pub poll_interval: Option<u64>,
    /// Command to run for polling
    #[serde(default)]
    pub poll_command: Option<String>,
    /// Action on timeout (node id or "skip"/"fail")
    #[serde(default)]
    pub on_timeout: Option<String>,
    /// Node to go to on success
    #[serde(default)]
    pub on_success: Option<String>,
    /// Node to go to on failure
    #[serde(default)]
    pub on_failure: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    /// Operation: "read", "write", "copy", "append"
    pub operation: String,
    #[serde(default)]
    pub path: Option<String>,
    /// Content template for write/append
    #[serde(default)]
    pub content: Option<String>,
    /// Source path for copy
    #[serde(default)]
    pub source: Option<String>,
    /// Destination path for copy
    #[serde(default)]
    pub destination: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpNode {
    /// HTTP method (default: GET)
    #[serde(default)]
    pub method: Option<String>,
    pub url: String,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    /// Body template
    #[serde(default)]
    pub body: Option<String>,
    /// Expected HTTP status codes
    #[serde(default)]
    pub expected_status: Option<Vec<u16>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopNode {
    #[serde(default)]
    pub max_iterations: Option<u32>,
    /// Template expression: loop until this evaluates to truthy
    #[serde(default)]
    pub until: Option<String>,
    /// Delay between iterations (e.g., "5s")
    #[serde(default)]
    pub delay: Option<String>,
    pub nodes: Vec<NodeDefinition>,
    /// Action when max iterations reached
    #[serde(default)]
    pub on_max_iterations: Option<String>,
    /// Action on explicit break
    #[serde(default)]
    pub on_break: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParallelNode {
    /// Named branches to execute in parallel
    pub branches: HashMap<String, Vec<NodeDefinition>>,
    /// Wait strategy: "all", "first", "any", or a number for count-based waiting
    #[serde(default)]
    pub wait: Option<serde_json::Value>,
    /// Error handling for individual branches: "ignore", "skip", "cancel_others", "fail"
    #[serde(default)]
    pub on_branch_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForEachNode {
    /// Template expression that evaluates to an iterable
    pub items: String,
    /// Variable name for the current item (default: "item")
    #[serde(default)]
    pub variable: Option<String>,
    /// Execution mode: "sequential" or "parallel"
    #[serde(default)]
    pub mode: Option<String>,
    /// Max concurrent items when mode is "parallel"
    #[serde(default)]
    pub max_parallel: Option<u32>,
    /// Error handling for individual items
    #[serde(default)]
    pub on_item_error: Option<String>,
    pub nodes: Vec<NodeDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubSequenceNode {
    /// Sequence id or filename to invoke
    pub sequence: String,
    #[serde(default)]
    pub inputs: Option<HashMap<String, serde_json::Value>>,
}

// ─── Trigger Node ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerNodeConfig {
    pub trigger_type: TriggerNodeType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "trigger_kind", rename_all = "snake_case")]
pub enum TriggerNodeType {
    Manual,
    Schedule {
        cron: String,
        #[serde(default)]
        timezone: Option<String>,
    },
    Event {
        event_type: String,
        #[serde(default)]
        filter: Option<HashMap<String, String>>,
        #[serde(default)]
        cooldown: Option<u64>,
        #[serde(default)]
        max_per_day: Option<u32>,
        #[serde(default)]
        once_per_day: Option<bool>,
    },
}

// ─── Error Strategy ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "strategy", rename_all = "snake_case")]
pub enum ErrorStrategy {
    Stop,
    Retry,
    Skip,
    Goto { target: String },
}

// Allow simple string deserialization for common cases by using an untagged
// wrapper. The tagged form is the canonical representation but we also support
// bare strings "stop", "retry", "skip" in YAML for ergonomics.
// We achieve this through a custom deserializer.

impl ErrorStrategy {
    /// Try to parse a plain string into an ErrorStrategy variant
    #[allow(dead_code)]
    fn from_str_opt(s: &str) -> Option<Self> {
        match s {
            "stop" => Some(ErrorStrategy::Stop),
            "retry" => Some(ErrorStrategy::Retry),
            "skip" => Some(ErrorStrategy::Skip),
            _ => None,
        }
    }
}

// ─── Output Mapping ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputMapping {
    pub name: String,
    /// Template expression for the output value
    pub value: String,
}

// ─── Sequence Triggers ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SequenceTrigger {
    Manual {
        #[serde(default)]
        entry_node_id: Option<String>,
    },
    Schedule {
        cron: String,
        #[serde(default)]
        timezone: Option<String>,
        #[serde(default)]
        inputs: Option<HashMap<String, serde_json::Value>>,
        #[serde(default)]
        entry_node_id: Option<String>,
    },
    Event {
        /// Event type: "session_end", "sequence_end", "recording_end", "app_start"
        event_type: String,
        /// Key-value filter to match against event payload
        #[serde(default)]
        filter: Option<HashMap<String, String>>,
        /// Template expressions for mapping event data to sequence inputs
        #[serde(default)]
        inputs: Option<HashMap<String, String>>,
        /// Cooldown in milliseconds between firings
        #[serde(default)]
        cooldown: Option<u64>,
        /// Maximum number of times this trigger can fire per day
        #[serde(default)]
        max_per_day: Option<u32>,
        /// For app_start: only fire once per day
        #[serde(default)]
        once_per_day: Option<bool>,
        #[serde(default)]
        entry_node_id: Option<String>,
    },
}
