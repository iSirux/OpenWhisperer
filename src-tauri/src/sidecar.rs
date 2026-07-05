use crate::config::McpServerConfig;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Image data for multimodal prompts
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageData {
    #[serde(rename = "mediaType")]
    pub media_type: String,
    #[serde(rename = "base64Data")]
    pub base64_data: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

/// A message from the conversation history for session restoration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HistoryMessage {
    User {
        content: String,
    },
    Assistant {
        content: String,
    },
    ToolUse {
        tool: String,
        input: serde_json::Value,
    },
    ToolResult {
        tool: String,
        output: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutboundMessage {
    Create {
        id: String,
        cwd: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        codex_mode: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        system_prompt: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        messages: Option<Vec<HistoryMessage>>,
        /// SDK session ID for proper resume (preferred over messages)
        #[serde(skip_serializing_if = "Option::is_none")]
        sdk_session_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        plan_mode: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        note_mode: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        read_only_mode: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        mcp_servers: Option<Vec<McpServerConfig>>,
        /// SDK session ID to fork from (creates a new branch from parent session)
        #[serde(skip_serializing_if = "Option::is_none")]
        fork_from_sdk_session_id: Option<String>,
        /// Message UUID to fork at (resumeSessionAt - include messages up to this point)
        #[serde(skip_serializing_if = "Option::is_none")]
        fork_at_message_uuid: Option<String>,
        /// Claude-only auto-compact policy:
        ///   0        -> sidecar sets DISABLE_AUTO_COMPACT=1
        ///   1..=99   -> sidecar sets CLAUDE_AUTOCOMPACT_PCT_OVERRIDE to this value
        ///   None/100 -> neither var set; Claude's built-in default (~83%) applies
        #[serde(skip_serializing_if = "Option::is_none")]
        autocompact_pct: Option<u32>,
        /// Skip project/local settings to disable filesystem hooks (lint, build, etc.)
        #[serde(skip_serializing_if = "Option::is_none")]
        disable_hooks: Option<bool>,
    },
    Query {
        id: String,
        prompt: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<Vec<ImageData>>,
    },
    Stop {
        id: String,
    },
    UpdateModel {
        id: String,
        model: String,
    },
    UpdateEffort {
        id: String,
        #[serde(rename = "effortLevel")]
        effort_level: Option<String>,
    },
    UpdateAutocompactPct {
        id: String,
        /// 1-100 percent threshold, or null to clear the override.
        pct: Option<u32>,
    },
    UpdateDisableHooks {
        id: String,
        disable: bool,
    },
    Close {
        id: String,
    },
    /// Generate repository description using Claude SDK
    GenerateRepoDescription {
        id: String,
        repo_path: String,
        repo_name: String,
    },
    /// Generate repository description using Codex SDK
    GenerateRepoDescriptionWithCodex {
        id: String,
        repo_path: String,
        repo_name: String,
    },
    /// Generate launch profile (commands + profiles) using Claude SDK
    GenerateLaunchProfile {
        id: String,
        repo_path: String,
        repo_name: String,
    },
    /// Generate launch profile (commands + profiles) using Codex SDK
    GenerateLaunchProfileWithCodex {
        id: String,
        repo_path: String,
        repo_name: String,
    },
    /// User's answers to AskUserQuestion tool
    AnswerAskUserQuestion {
        id: String,
        answers: std::collections::HashMap<String, String>,
    },
    /// User's decision on ExitPlanMode plan approval
    AnswerPlanApproval {
        id: String,
        action: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        feedback: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InboundMessage {
    Ready,
    Created {
        id: String,
    },
    Text {
        id: String,
        content: String,
        #[serde(rename = "parentToolUseId")]
        parent_tool_use_id: Option<String>,
        #[serde(rename = "turnUuid", default)]
        turn_uuid: Option<String>,
    },
    ToolStart {
        id: String,
        tool: String,
        input: serde_json::Value,
        #[serde(rename = "toolUseId")]
        tool_use_id: String,
        #[serde(rename = "parentToolUseId")]
        parent_tool_use_id: Option<String>,
        #[serde(rename = "turnUuid", default)]
        turn_uuid: Option<String>,
    },
    ToolResult {
        id: String,
        tool: String,
        output: String,
        #[serde(rename = "toolUseId")]
        tool_use_id: String,
        #[serde(rename = "parentToolUseId")]
        parent_tool_use_id: Option<String>,
        #[serde(rename = "turnUuid", default)]
        turn_uuid: Option<String>,
        #[serde(default)]
        images: Option<Vec<serde_json::Value>>,
    },
    ThinkingStart {
        id: String,
        content: String,
        timestamp: u64,
        #[serde(rename = "parentToolUseId")]
        parent_tool_use_id: Option<String>,
        #[serde(rename = "turnUuid", default)]
        turn_uuid: Option<String>,
    },
    ThinkingEnd {
        id: String,
        #[serde(rename = "durationMs")]
        duration_ms: u64,
        content: String,
        #[serde(rename = "parentToolUseId")]
        parent_tool_use_id: Option<String>,
        #[serde(rename = "turnUuid", default)]
        turn_uuid: Option<String>,
    },
    Done {
        id: String,
    },
    Usage {
        id: String,
        #[serde(rename = "inputTokens")]
        input_tokens: u64,
        #[serde(rename = "outputTokens")]
        output_tokens: u64,
        #[serde(rename = "cacheReadTokens")]
        cache_read_tokens: u64,
        #[serde(rename = "cacheCreationTokens")]
        cache_creation_tokens: u64,
        #[serde(rename = "totalCostUsd")]
        total_cost_usd: f64,
        #[serde(rename = "durationMs")]
        duration_ms: u64,
        #[serde(rename = "durationApiMs")]
        duration_api_ms: u64,
        #[serde(rename = "numTurns")]
        num_turns: u64,
        #[serde(rename = "contextWindow")]
        context_window: u64,
        // Main-agent-only tokens for accurate context bar (excludes subagent usage)
        #[serde(rename = "mainAgentInputTokens", default)]
        main_agent_input_tokens: Option<u64>,
        #[serde(rename = "mainAgentOutputTokens", default)]
        main_agent_output_tokens: Option<u64>,
        #[serde(rename = "mainAgentCacheReadTokens", default)]
        main_agent_cache_read_tokens: Option<u64>,
        #[serde(rename = "mainAgentCacheCreationTokens", default)]
        main_agent_cache_creation_tokens: Option<u64>,
    },
    ProgressiveUsage {
        id: String,
        #[serde(rename = "inputTokens")]
        input_tokens: u64,
        #[serde(rename = "outputTokens")]
        output_tokens: u64,
        #[serde(rename = "cacheReadTokens")]
        cache_read_tokens: u64,
        #[serde(rename = "cacheCreationTokens")]
        cache_creation_tokens: u64,
    },
    ModelUpdated {
        id: String,
        model: String,
    },
    EffortUpdated {
        id: String,
        #[serde(rename = "effortLevel")]
        effort_level: Option<String>,
    },
    Closed {
        id: String,
    },
    Error {
        id: String,
        message: String,
    },
    RateLimit {
        id: String,
        status: String,
        #[serde(rename = "resetsAt")]
        resets_at: Option<f64>,
        utilization: Option<f64>,
    },
    Debug {
        id: String,
        message: String,
    },
    SubagentStart {
        id: String,
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "agentType")]
        agent_type: String,
    },
    SubagentStop {
        id: String,
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "transcriptPath")]
        transcript_path: String,
    },
    TaskStarted {
        id: String,
        #[serde(rename = "taskId")]
        task_id: String,
        #[serde(rename = "toolUseId")]
        tool_use_id: Option<String>,
        description: String,
        #[serde(rename = "taskType")]
        task_type: Option<String>,
    },
    TaskCompleted {
        id: String,
        #[serde(rename = "taskId")]
        task_id: String,
        #[serde(rename = "toolUseId")]
        tool_use_id: Option<String>,
        status: String,
        summary: String,
        usage: Option<serde_json::Value>,
    },
    PlanningQuestions {
        id: String,
        questions: Vec<PlanningQuestion>,
    },
    PlanningComplete {
        id: String,
        #[serde(rename = "planPath")]
        plan_path: String,
        #[serde(rename = "featureName")]
        feature_name: String,
        summary: String,
    },
    /// AskUserQuestion tool - interactive questions for the user
    AskUserQuestions {
        id: String,
        questions: Vec<PlanningQuestion>,
    },
    /// ExitPlanMode intercepted - plan ready for user approval
    PlanApprovalRequest {
        id: String,
        #[serde(rename = "allowedPrompts")]
        allowed_prompts: Vec<serde_json::Value>,
        plan: Option<String>,
    },
    /// Result from Claude SDK repo description generation
    RepoDescriptionResult {
        id: String,
        description: String,
        keywords: Vec<String>,
        vocabulary: Vec<String>,
        icon: Option<String>,
        color: Option<String>,
    },
    /// Error from Claude SDK repo description generation
    RepoDescriptionError {
        id: String,
        error: String,
    },
    /// Result from launch profile generation (commands + profiles)
    LaunchProfileResult {
        id: String,
        commands: Vec<LaunchProfileCommandResult>,
        profiles: Vec<LaunchProfileGroupResult>,
    },
    /// Error from launch profile generation
    LaunchProfileError {
        id: String,
        error: String,
    },
    /// SDK session ID captured from system/init message for session persistence
    SdkSessionId {
        id: String,
        #[serde(rename = "sdkSessionId")]
        sdk_session_id: String,
    },
    /// Notification that a parallel session was detected in the same CWD
    ParallelSessionNotification {
        id: String,
        message: String,
    },
}

/// A command result from launch profile generation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchProfileCommandResult {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub working_dir: Option<String>,
}

/// A profile group result from launch profile generation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchProfileGroupResult {
    pub name: String,
    pub command_names: Vec<String>,
}

/// Planning question option
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanningQuestionOption {
    pub label: String,
    pub description: String,
}

/// Planning question from Claude
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanningQuestion {
    pub question: String,
    pub header: String,
    pub options: Vec<PlanningQuestionOption>,
    #[serde(rename = "multiSelect")]
    pub multi_select: bool,
}

/// Internal error kinds for the sidecar IPC channel (T1). Converted to `String`
/// at the Tauri command boundary; the `NotStarted` message keeps the
/// "Sidecar not started" prefix the rest of the app expects.
#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    #[error("Sidecar not started. Call start_sidecar first.")]
    NotStarted,
    #[error("Sidecar not running (process exited). Call start_sidecar to restart.")]
    NotRunning,
    #[error("Sidecar protocol (serialize) error: {0}")]
    Protocol(#[from] serde_json::Error),
    #[error("Sidecar transport error: {0}")]
    Transport(#[from] std::io::Error),
}

impl From<SidecarError> for String {
    fn from(e: SidecarError) -> Self {
        e.to_string()
    }
}

// ── Typed event payloads (I1) ─────────────────────────────────────────────────
// Each payload struct serializes to exactly the JSON keys the frontend consumes.
// The `#[serde(rename)]` attributes below MUST match the historical `json!`
// blocks byte-for-byte; unit / bare-string / array payloads are emitted directly.

#[derive(Serialize, Clone)]
struct TextPayload {
    content: String,
    #[serde(rename = "parentToolUseId")]
    parent_tool_use_id: Option<String>,
    #[serde(rename = "turnUuid")]
    turn_uuid: Option<String>,
}

#[derive(Serialize, Clone)]
struct ToolStartPayload {
    tool: String,
    input: serde_json::Value,
    #[serde(rename = "toolUseId")]
    tool_use_id: String,
    #[serde(rename = "parentToolUseId")]
    parent_tool_use_id: Option<String>,
    #[serde(rename = "turnUuid")]
    turn_uuid: Option<String>,
}

#[derive(Serialize, Clone)]
struct ToolResultPayload {
    tool: String,
    output: String,
    #[serde(rename = "toolUseId")]
    tool_use_id: String,
    #[serde(rename = "parentToolUseId")]
    parent_tool_use_id: Option<String>,
    #[serde(rename = "turnUuid")]
    turn_uuid: Option<String>,
    images: Option<Vec<serde_json::Value>>,
}

#[derive(Serialize, Clone)]
struct ThinkingStartPayload {
    content: String,
    timestamp: u64,
    #[serde(rename = "parentToolUseId")]
    parent_tool_use_id: Option<String>,
    #[serde(rename = "turnUuid")]
    turn_uuid: Option<String>,
}

#[derive(Serialize, Clone)]
struct ThinkingEndPayload {
    #[serde(rename = "durationMs")]
    duration_ms: u64,
    content: String,
    #[serde(rename = "parentToolUseId")]
    parent_tool_use_id: Option<String>,
    #[serde(rename = "turnUuid")]
    turn_uuid: Option<String>,
}

#[derive(Serialize, Clone)]
struct UsagePayload {
    #[serde(rename = "inputTokens")]
    input_tokens: u64,
    #[serde(rename = "outputTokens")]
    output_tokens: u64,
    #[serde(rename = "cacheReadTokens")]
    cache_read_tokens: u64,
    #[serde(rename = "cacheCreationTokens")]
    cache_creation_tokens: u64,
    #[serde(rename = "totalCostUsd")]
    total_cost_usd: f64,
    #[serde(rename = "durationMs")]
    duration_ms: u64,
    #[serde(rename = "durationApiMs")]
    duration_api_ms: u64,
    #[serde(rename = "numTurns")]
    num_turns: u64,
    #[serde(rename = "contextWindow")]
    context_window: u64,
    // Conditionally included (skipped when None) to match the historical payload.
    #[serde(rename = "mainAgentInputTokens", skip_serializing_if = "Option::is_none")]
    main_agent_input_tokens: Option<u64>,
    #[serde(
        rename = "mainAgentOutputTokens",
        skip_serializing_if = "Option::is_none"
    )]
    main_agent_output_tokens: Option<u64>,
    #[serde(
        rename = "mainAgentCacheReadTokens",
        skip_serializing_if = "Option::is_none"
    )]
    main_agent_cache_read_tokens: Option<u64>,
    #[serde(
        rename = "mainAgentCacheCreationTokens",
        skip_serializing_if = "Option::is_none"
    )]
    main_agent_cache_creation_tokens: Option<u64>,
}

#[derive(Serialize, Clone)]
struct ProgressiveUsagePayload {
    #[serde(rename = "inputTokens")]
    input_tokens: u64,
    #[serde(rename = "outputTokens")]
    output_tokens: u64,
    #[serde(rename = "cacheReadTokens")]
    cache_read_tokens: u64,
    #[serde(rename = "cacheCreationTokens")]
    cache_creation_tokens: u64,
}

#[derive(Serialize, Clone)]
struct RateLimitPayload {
    status: String,
    #[serde(rename = "resetsAt")]
    resets_at: Option<f64>,
    utilization: Option<f64>,
}

#[derive(Serialize, Clone)]
struct SubagentStartPayload {
    #[serde(rename = "agentId")]
    agent_id: String,
    #[serde(rename = "agentType")]
    agent_type: String,
}

#[derive(Serialize, Clone)]
struct SubagentStopPayload {
    #[serde(rename = "agentId")]
    agent_id: String,
    #[serde(rename = "transcriptPath")]
    transcript_path: String,
}

#[derive(Serialize, Clone)]
struct TaskStartedPayload {
    #[serde(rename = "taskId")]
    task_id: String,
    #[serde(rename = "toolUseId")]
    tool_use_id: Option<String>,
    description: String,
    #[serde(rename = "taskType")]
    task_type: Option<String>,
}

#[derive(Serialize, Clone)]
struct TaskCompletedPayload {
    #[serde(rename = "taskId")]
    task_id: String,
    #[serde(rename = "toolUseId")]
    tool_use_id: Option<String>,
    status: String,
    summary: String,
    usage: Option<serde_json::Value>,
}

#[derive(Serialize, Clone)]
struct PlanningCompletePayload {
    #[serde(rename = "planPath")]
    plan_path: String,
    #[serde(rename = "featureName")]
    feature_name: String,
    summary: String,
}

#[derive(Serialize, Clone)]
struct PlanApprovalRequestPayload {
    #[serde(rename = "allowedPrompts")]
    allowed_prompts: Vec<serde_json::Value>,
    plan: Option<String>,
}

#[derive(Serialize, Clone)]
struct RepoDescriptionResultPayload {
    description: String,
    keywords: Vec<String>,
    vocabulary: Vec<String>,
    icon: Option<String>,
    color: Option<String>,
}

#[derive(Serialize, Clone)]
struct LaunchProfileResultPayload {
    commands: Vec<LaunchProfileCommandResult>,
    profiles: Vec<LaunchProfileGroupResult>,
}

impl InboundMessage {
    /// Event-name suffix derived from the variant (I1). Empty for pure
    /// log-only variants (Ready/Debug) that emit nothing.
    fn event_suffix(&self) -> &'static str {
        match self {
            InboundMessage::Ready => "",
            InboundMessage::Created { .. } => "sdk-created",
            InboundMessage::Text { .. } => "sdk-text",
            InboundMessage::ToolStart { .. } => "sdk-tool-start",
            InboundMessage::ToolResult { .. } => "sdk-tool-result",
            InboundMessage::ThinkingStart { .. } => "sdk-thinking-start",
            InboundMessage::ThinkingEnd { .. } => "sdk-thinking-end",
            InboundMessage::Done { .. } => "sdk-done",
            InboundMessage::Usage { .. } => "sdk-usage",
            InboundMessage::ProgressiveUsage { .. } => "sdk-progressive-usage",
            InboundMessage::ModelUpdated { .. } => "sdk-model-updated",
            InboundMessage::EffortUpdated { .. } => "sdk-effort-updated",
            InboundMessage::Closed { .. } => "sdk-closed",
            InboundMessage::Error { .. } => "sdk-error",
            InboundMessage::RateLimit { .. } => "sdk-rate-limit",
            InboundMessage::Debug { .. } => "",
            InboundMessage::SubagentStart { .. } => "sdk-subagent-start",
            InboundMessage::SubagentStop { .. } => "sdk-subagent-stop",
            InboundMessage::TaskStarted { .. } => "sdk-task-started",
            InboundMessage::TaskCompleted { .. } => "sdk-task-completed",
            InboundMessage::PlanningQuestions { .. } => "sdk-planning-questions",
            InboundMessage::PlanningComplete { .. } => "sdk-planning-complete",
            InboundMessage::AskUserQuestions { .. } => "sdk-ask-user-questions",
            InboundMessage::PlanApprovalRequest { .. } => "sdk-plan-approval-request",
            InboundMessage::RepoDescriptionResult { .. } => "repo-description-result",
            InboundMessage::RepoDescriptionError { .. } => "repo-description-error",
            InboundMessage::LaunchProfileResult { .. } => "launch-profile-result",
            InboundMessage::LaunchProfileError { .. } => "launch-profile-error",
            InboundMessage::SdkSessionId { .. } => "sdk-session-id",
            InboundMessage::ParallelSessionNotification { .. } => "sdk-parallel-notification",
        }
    }
}

pub struct SidecarManager {
    process: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
    started: Arc<Mutex<bool>>,
}

impl Default for SidecarManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            process: Arc::new(Mutex::new(None)),
            stdin: Arc::new(Mutex::new(None)),
            started: Arc::new(Mutex::new(false)),
        }
    }

    pub fn start(&self, app: AppHandle) -> Result<(), String> {
        // Check if already started
        {
            let started = self.started.lock();
            if *started {
                return Ok(());
            }
        }

        // Try multiple possible sidecar locations
        let exe_dir = std::env::current_exe()
            .map_err(|e| format!("Failed to get exe path: {}", e))?
            .parent()
            .ok_or("Failed to get exe directory")?
            .to_path_buf();

        let cwd = std::env::current_dir().map_err(|e| format!("Failed to get cwd: {}", e))?;

        // Get resource directory for bundled release
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to get resource dir: {}", e))?;

        // Possible paths (in order of priority):
        // 1. <resource_dir>/dist/index.js (bundled release - "sidecar/dist/" becomes "dist/")
        // 2. <resource_dir>/sidecar/dist/index.js (bundled release alternate)
        // 3. <cwd>/sidecar/dist/index.js (when cwd is src-tauri during dev)
        // 4. <cwd>/src-tauri/sidecar/dist/index.js (when cwd is project root)
        // 5. <exe_dir>/sidecar/dist/index.js (fallback)
        let possible_paths = [
            resource_dir.join("dist").join("index.js"),
            resource_dir.join("sidecar").join("dist").join("index.js"),
            cwd.join("sidecar").join("dist").join("index.js"),
            cwd.join("src-tauri")
                .join("sidecar")
                .join("dist")
                .join("index.js"),
            exe_dir.join("sidecar").join("dist").join("index.js"),
        ];

        let path = possible_paths
            .iter()
            .find(|p| {
                log::info!("[sidecar] Checking path: {:?} exists={}", p, p.exists());
                p.exists()
            })
            .cloned()
            .ok_or_else(|| {
                format!(
                    "Sidecar not found. Tried:\n{}",
                    possible_paths
                        .iter()
                        .map(|p| format!("  - {:?}", p))
                        .collect::<Vec<_>>()
                        .join("\n")
                )
            })?;

        // Convert to string and strip Windows extended path prefix if present
        let path_str = path.to_string_lossy().to_string();
        let path_str = path_str
            .strip_prefix(r"\\?\")
            .unwrap_or(&path_str)
            .to_string();

        log::info!("[sidecar] Using sidecar at: {}", path_str);

        // Get the sidecar base directory (contains dist/ and node_modules/)
        let sidecar_base = std::path::Path::new(&path_str)
            .parent() // dist/
            .and_then(|p| p.parent()) // sidecar/
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string());

        log::info!("[sidecar] Sidecar base directory: {}", sidecar_base);

        let mut cmd = Command::new("node");
        cmd.arg(&path_str)
            .current_dir(&sidecar_base)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Inject API keys from keyring into sidecar environment
        {
            use tauri_plugin_keyring::KeyringExt;
            if let Ok(Some(key)) = app
                .keyring()
                .get_password("open-whisperer", "anthropic-api-key")
            {
                cmd.env("ANTHROPIC_API_KEY", key);
            }
            if let Ok(Some(key)) = app
                .keyring()
                .get_password("open-whisperer", "openai-api-key")
            {
                cmd.env("OPENAI_API_KEY", key);
            }
        }

        // On Windows, prevent the CMD window from appearing
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

        let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
        let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
        let stderr = child.stderr.take();

        *self.stdin.lock() = Some(stdin);
        *self.process.lock() = Some(child);
        *self.started.lock() = true;

        // Spawn stderr reader thread
        if let Some(stderr) = stderr {
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    if let Ok(line) = line {
                        log::error!("[sidecar stderr] {}", line);
                    }
                }
            });
        }

        // Spawn stdout reader thread. On exit (the Node process died or closed
        // stdout) reset the manager state so `is_started()`/`send()` report the
        // truth, and emit `sidecar-exited` so the frontend can react (I2).
        let app_clone = app.clone();
        let started_ref = Arc::clone(&self.started);
        let stdin_ref = Arc::clone(&self.stdin);
        let process_ref = Arc::clone(&self.process);
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    match serde_json::from_str::<InboundMessage>(&line) {
                        Ok(msg) => {
                            Self::handle_message(&app_clone, msg);
                        }
                        Err(e) => {
                            log::error!("[sidecar] Failed to parse message: {} - {}", e, line);
                        }
                    }
                }
            }
            log::error!("[sidecar] Reader thread exited — resetting sidecar state");
            *started_ref.lock() = false;
            *stdin_ref.lock() = None;
            *process_ref.lock() = None;
            crate::util::emit_or_log(&app_clone, "sidecar-exited", ());
        });

        Ok(())
    }

    /// Emit `<suffix>-<id>` with a serializable payload, logging emit failures.
    fn emit<S: Serialize + Clone>(app: &AppHandle, suffix: &str, id: &str, payload: S) {
        crate::util::emit_or_log(app, &format!("{}-{}", suffix, id), payload);
    }

    fn handle_message(app: &AppHandle, msg: InboundMessage) {
        // Event suffix is derived once from the variant (I1); the arms below only
        // build the payload and any per-variant log line.
        let suffix = msg.event_suffix();
        match msg {
            InboundMessage::Ready => {
                log::info!("[sidecar] Ready");
            }
            InboundMessage::Created { id } => {
                log::info!("[sidecar] Emitting {}-{}", suffix, id);
                Self::emit(app, suffix, &id, ());
            }
            InboundMessage::Text {
                id,
                content,
                parent_tool_use_id,
                turn_uuid,
            } => {
                log::info!("[sidecar] Emitting {}-{} with {} bytes", suffix, id, content.len());
                Self::emit(
                    app,
                    suffix,
                    &id,
                    TextPayload {
                        content,
                        parent_tool_use_id,
                        turn_uuid,
                    },
                );
            }
            InboundMessage::ToolStart {
                id,
                tool,
                input,
                tool_use_id,
                parent_tool_use_id,
                turn_uuid,
            } => {
                Self::emit(
                    app,
                    suffix,
                    &id,
                    ToolStartPayload {
                        tool,
                        input,
                        tool_use_id,
                        parent_tool_use_id,
                        turn_uuid,
                    },
                );
            }
            InboundMessage::ToolResult {
                id,
                tool,
                output,
                tool_use_id,
                parent_tool_use_id,
                turn_uuid,
                images,
            } => {
                Self::emit(
                    app,
                    suffix,
                    &id,
                    ToolResultPayload {
                        tool,
                        output,
                        tool_use_id,
                        parent_tool_use_id,
                        turn_uuid,
                        images,
                    },
                );
            }
            InboundMessage::ThinkingStart {
                id,
                content,
                timestamp,
                parent_tool_use_id,
                turn_uuid,
            } => {
                Self::emit(
                    app,
                    suffix,
                    &id,
                    ThinkingStartPayload {
                        content,
                        timestamp,
                        parent_tool_use_id,
                        turn_uuid,
                    },
                );
            }
            InboundMessage::ThinkingEnd {
                id,
                duration_ms,
                content,
                parent_tool_use_id,
                turn_uuid,
            } => {
                Self::emit(
                    app,
                    suffix,
                    &id,
                    ThinkingEndPayload {
                        duration_ms,
                        content,
                        parent_tool_use_id,
                        turn_uuid,
                    },
                );
            }
            InboundMessage::Done { id } => {
                log::info!("[sidecar] Emitting {}-{}", suffix, id);
                Self::emit(app, suffix, &id, ());
            }
            InboundMessage::Usage {
                id,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                total_cost_usd,
                duration_ms,
                duration_api_ms,
                num_turns,
                context_window,
                main_agent_input_tokens,
                main_agent_output_tokens,
                main_agent_cache_read_tokens,
                main_agent_cache_creation_tokens,
            } => {
                log::info!(
                    "[sidecar] Emitting {}-{}: {} input, {} output, ${:.4}",
                    suffix,
                    id,
                    input_tokens,
                    output_tokens,
                    total_cost_usd
                );
                Self::emit(
                    app,
                    suffix,
                    &id,
                    UsagePayload {
                        input_tokens,
                        output_tokens,
                        cache_read_tokens,
                        cache_creation_tokens,
                        total_cost_usd,
                        duration_ms,
                        duration_api_ms,
                        num_turns,
                        context_window,
                        main_agent_input_tokens,
                        main_agent_output_tokens,
                        main_agent_cache_read_tokens,
                        main_agent_cache_creation_tokens,
                    },
                );
            }
            InboundMessage::ProgressiveUsage {
                id,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_creation_tokens,
            } => {
                Self::emit(
                    app,
                    suffix,
                    &id,
                    ProgressiveUsagePayload {
                        input_tokens,
                        output_tokens,
                        cache_read_tokens,
                        cache_creation_tokens,
                    },
                );
            }
            InboundMessage::ModelUpdated { id, model } => {
                log::info!("[sidecar] Model updated for {}: {}", id, model);
                Self::emit(app, suffix, &id, model);
            }
            InboundMessage::Closed { id } => {
                Self::emit(app, suffix, &id, ());
            }
            InboundMessage::Error { id, message } => {
                Self::emit(app, suffix, &id, message);
            }
            InboundMessage::RateLimit {
                id,
                status,
                resets_at,
                utilization,
            } => {
                log::info!(
                    "[sidecar] Rate limit ({}) for session {} (resetsAt: {:?}, utilization: {:?})",
                    status,
                    id,
                    resets_at,
                    utilization
                );
                Self::emit(
                    app,
                    suffix,
                    &id,
                    RateLimitPayload {
                        status,
                        resets_at,
                        utilization,
                    },
                );
            }
            InboundMessage::Debug { id, message } => {
                log::info!("[sidecar debug][{}] {}", id, message);
            }
            InboundMessage::SubagentStart {
                id,
                agent_id,
                agent_type,
            } => {
                log::info!(
                    "[sidecar] Subagent started: {} (type: {}) for session {}",
                    agent_id,
                    agent_type,
                    id
                );
                Self::emit(
                    app,
                    suffix,
                    &id,
                    SubagentStartPayload {
                        agent_id,
                        agent_type,
                    },
                );
            }
            InboundMessage::SubagentStop {
                id,
                agent_id,
                transcript_path,
            } => {
                log::info!("[sidecar] Subagent stopped: {} for session {}", agent_id, id);
                Self::emit(
                    app,
                    suffix,
                    &id,
                    SubagentStopPayload {
                        agent_id,
                        transcript_path,
                    },
                );
            }
            InboundMessage::TaskStarted {
                id,
                task_id,
                tool_use_id,
                description,
                task_type,
            } => {
                log::info!(
                    "[sidecar] Task started: {} (toolUseId: {:?}) for session {}",
                    task_id,
                    tool_use_id,
                    id
                );
                Self::emit(
                    app,
                    suffix,
                    &id,
                    TaskStartedPayload {
                        task_id,
                        tool_use_id,
                        description,
                        task_type,
                    },
                );
            }
            InboundMessage::TaskCompleted {
                id,
                task_id,
                tool_use_id,
                status,
                summary,
                usage,
            } => {
                log::info!(
                    "[sidecar] Task completed: {} ({}) for session {}",
                    task_id,
                    status,
                    id
                );
                Self::emit(
                    app,
                    suffix,
                    &id,
                    TaskCompletedPayload {
                        task_id,
                        tool_use_id,
                        status,
                        summary,
                        usage,
                    },
                );
            }
            InboundMessage::EffortUpdated { id, effort_level } => {
                log::info!("[sidecar] Effort updated for {}: {:?}", id, effort_level);
                Self::emit(app, suffix, &id, effort_level);
            }
            InboundMessage::PlanningQuestions { id, questions } => {
                log::info!(
                    "[sidecar] Planning questions for session {}: {} questions",
                    id,
                    questions.len()
                );
                Self::emit(app, suffix, &id, questions);
            }
            InboundMessage::PlanningComplete {
                id,
                plan_path,
                feature_name,
                summary,
            } => {
                log::info!("[sidecar] Planning complete for session {}: {}", id, feature_name);
                Self::emit(
                    app,
                    suffix,
                    &id,
                    PlanningCompletePayload {
                        plan_path,
                        feature_name,
                        summary,
                    },
                );
            }
            InboundMessage::AskUserQuestions { id, questions } => {
                log::info!(
                    "[sidecar] AskUserQuestion for session {}: {} questions",
                    id,
                    questions.len()
                );
                Self::emit(app, suffix, &id, questions);
            }
            InboundMessage::PlanApprovalRequest {
                id,
                allowed_prompts,
                plan,
            } => {
                log::info!(
                    "[sidecar] Plan approval request for session {}: {} allowed prompts, has_plan: {}",
                    id,
                    allowed_prompts.len(),
                    plan.is_some()
                );
                Self::emit(
                    app,
                    suffix,
                    &id,
                    PlanApprovalRequestPayload {
                        allowed_prompts,
                        plan,
                    },
                );
            }
            InboundMessage::RepoDescriptionResult {
                id,
                description,
                keywords,
                vocabulary,
                icon,
                color,
            } => {
                log::info!(
                    "[sidecar] Repo description result for {}: {}",
                    id,
                    description.chars().take(50).collect::<String>()
                );
                Self::emit(
                    app,
                    suffix,
                    &id,
                    RepoDescriptionResultPayload {
                        description,
                        keywords,
                        vocabulary,
                        icon,
                        color,
                    },
                );
            }
            InboundMessage::RepoDescriptionError { id, error } => {
                log::error!("[sidecar] Repo description error for {}: {}", id, error);
                Self::emit(app, suffix, &id, error);
            }
            InboundMessage::LaunchProfileResult {
                id,
                commands,
                profiles,
            } => {
                log::info!(
                    "[sidecar] Launch profile result for {}: {} commands, {} profiles",
                    id,
                    commands.len(),
                    profiles.len()
                );
                Self::emit(
                    app,
                    suffix,
                    &id,
                    LaunchProfileResultPayload { commands, profiles },
                );
            }
            InboundMessage::LaunchProfileError { id, error } => {
                log::error!("[sidecar] Launch profile error for {}: {}", id, error);
                Self::emit(app, suffix, &id, error);
            }
            InboundMessage::SdkSessionId { id, sdk_session_id } => {
                log::info!("[sidecar] SDK session ID for {}: {}", id, sdk_session_id);
                Self::emit(app, suffix, &id, sdk_session_id);
            }
            InboundMessage::ParallelSessionNotification { id, message } => {
                log::info!("[sidecar] Parallel session notification for {}: {}", id, message);
                Self::emit(app, suffix, &id, message);
            }
        }
    }

    /// Send a message to the sidecar. The started/alive guard (I3) lives here so
    /// commands don't have to repeat it. Errors are stringified at the boundary
    /// via `From<SidecarError>`.
    pub fn send(&self, msg: OutboundMessage) -> Result<(), String> {
        self.send_inner(msg).map_err(String::from)
    }

    fn send_inner(&self, msg: OutboundMessage) -> Result<(), SidecarError> {
        // Detect a dead process so callers get a clear "not running" error
        // instead of an opaque write failure (I2).
        {
            let mut process = self.process.lock();
            match process.as_mut() {
                None => return Err(SidecarError::NotStarted),
                Some(child) => {
                    if let Ok(Some(_)) = child.try_wait() {
                        return Err(SidecarError::NotRunning);
                    }
                }
            }
        }

        let mut stdin = self.stdin.lock();
        let stdin = stdin.as_mut().ok_or(SidecarError::NotStarted)?;
        let json = serde_json::to_string(&msg)?;
        writeln!(stdin, "{}", json)?;
        stdin.flush()?;
        Ok(())
    }

    /// Send `msg`, auto-starting the sidecar first if it isn't running (I3).
    pub fn send_or_start(&self, app: AppHandle, msg: OutboundMessage) -> Result<(), String> {
        if !self.is_started() {
            self.start(app)?;
        }
        self.send(msg)
    }

    /// Whether the sidecar is started AND its child process is still alive (I2).
    pub fn is_started(&self) -> bool {
        if !*self.started.lock() {
            return false;
        }
        let mut process = self.process.lock();
        match process.as_mut() {
            Some(child) => !matches!(child.try_wait(), Ok(Some(_))),
            None => false,
        }
    }

    pub fn shutdown(&self) {
        let mut process = self.process.lock();
        if let Some(ref mut child) = *process {
            log::info!("[sidecar] Shutting down sidecar process");
            let _ = child.kill();
            let _ = child.wait();
        }
        *process = None;
        *self.stdin.lock() = None;
        *self.started.lock() = false;
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}
