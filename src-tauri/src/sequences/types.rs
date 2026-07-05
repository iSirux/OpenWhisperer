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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SequenceDefaults {
    /// Fallback model for prompt nodes that don't specify one.
    #[serde(default)]
    pub model: Option<String>,
    /// Fallback effort/thinking level for prompt nodes that don't specify one.
    #[serde(default)]
    pub effort: Option<String>,
    /// Default timeout in seconds, applied to nodes without their own timeout.
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
    /// Start point for the new worktree (e.g., "origin/main"). If None, uses current HEAD.
    #[serde(default)]
    pub base_branch: Option<String>,
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
    /// What to wait for.
    pub wait_for: WaitTarget,
    /// Poll interval in seconds
    #[serde(default)]
    pub poll_interval: Option<u64>,
}

/// Condition a `github_pr_wait` node polls for.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitTarget {
    Checks,
    Reviews,
    Merge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubPrMergeNode {
    /// PR number or template expression
    pub pr: String,
    /// Merge method (default: merge).
    #[serde(default)]
    pub method: Option<MergeMethod>,
    /// Delete branch after merge
    #[serde(default)]
    pub delete_branch: Option<bool>,
}

/// GitHub PR merge strategy.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

// ─── Control Flow Nodes ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalNode {
    /// Message to display for approval request
    pub message: String,
    /// Action on timeout ("skip"/"fail" or a node id to jump to)
    #[serde(default)]
    pub on_timeout: Option<TimeoutAction>,
}

/// What to do when an approval / wait node times out.
///
/// Accepts the bare keywords `skip` and `fail`, or any other string interpreted
/// as a node id to jump to. Serialized back as the same plain string so on-disk
/// YAML is unchanged (finding S5).
#[derive(Debug, Clone, PartialEq)]
pub enum TimeoutAction {
    Skip,
    Fail,
    Goto(String),
}

impl<'de> Deserialize<'de> for TimeoutAction {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(match s.as_str() {
            "skip" => TimeoutAction::Skip,
            "fail" => TimeoutAction::Fail,
            _ => TimeoutAction::Goto(s),
        })
    }
}

impl Serialize for TimeoutAction {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            TimeoutAction::Skip => serializer.serialize_str("skip"),
            TimeoutAction::Fail => serializer.serialize_str("fail"),
            TimeoutAction::Goto(s) => serializer.serialize_str(s),
        }
    }
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
    /// Action on timeout ("skip"/"fail" or a node id to jump to)
    #[serde(default)]
    pub on_timeout: Option<TimeoutAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    /// File operation to perform.
    pub operation: FileOperation,
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

/// Filesystem operation for a `file` node.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileOperation {
    Read,
    Write,
    Append,
    Copy,
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
    /// Action when max iterations reached (default: complete with a partial result).
    #[serde(default)]
    pub on_max_iterations: Option<MaxIterationsAction>,
    /// Action on explicit break
    #[serde(default)]
    pub on_break: Option<String>,
}

/// What to do when a loop hits its iteration cap.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaxIterationsAction {
    /// Stop the loop and complete with a partial result (same as the default).
    Stop,
    /// Fail the node with an error.
    Fail,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParallelNode {
    /// Named branches to execute in parallel
    pub branches: HashMap<String, Vec<NodeDefinition>>,
    /// Wait strategy: `all`/`first`/`any`, or a number for count-based waiting.
    #[serde(default)]
    pub wait: Option<WaitStrategy>,
    /// Error handling for individual branches (default: fail).
    #[serde(default)]
    pub on_branch_error: Option<BranchErrorPolicy>,
    /// Max concurrent branches; unlimited when unset (finding S10).
    #[serde(default)]
    pub max_parallel: Option<u32>,
}

/// Wait strategy for a parallel node.  Accepts the strings `all`/`first`/`any`
/// or a bare number (count of branches to wait for).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum WaitStrategy {
    Named(WaitStrategyKind),
    Count(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitStrategyKind {
    All,
    First,
    Any,
}

/// Per-branch error handling for a parallel node.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BranchErrorPolicy {
    Ignore,
    Skip,
    CancelOthers,
    Fail,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForEachNode {
    /// Template expression that evaluates to an iterable
    pub items: String,
    /// Variable name for the current item (default: "item")
    #[serde(default)]
    pub variable: Option<String>,
    /// Execution mode (default: sequential).
    #[serde(default)]
    pub mode: Option<ExecutionMode>,
    /// Max concurrent items when mode is "parallel" (unlimited when unset).
    #[serde(default)]
    pub max_parallel: Option<u32>,
    /// Error handling for individual items (default: stop).
    #[serde(default)]
    pub on_item_error: Option<ItemErrorPolicy>,
    pub nodes: Vec<NodeDefinition>,
}

/// Execution mode for a foreach node.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Sequential,
    Parallel,
}

/// Per-item error handling for a foreach node.  `skip`/`ignore`/`continue` all
/// mean "record the failure and keep going"; `stop` propagates the error.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemErrorPolicy {
    Skip,
    Ignore,
    Continue,
    Stop,
}

impl ItemErrorPolicy {
    /// Whether execution should continue past a failed item.
    pub fn continues(&self) -> bool {
        !matches!(self, ItemErrorPolicy::Stop)
    }
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
