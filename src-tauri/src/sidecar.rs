use crate::config::McpServerConfig;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter, Manager};

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
                .get_password("claude-whisperer", "anthropic-api-key")
            {
                cmd.env("ANTHROPIC_API_KEY", key);
            }
            if let Ok(Some(key)) = app
                .keyring()
                .get_password("claude-whisperer", "openai-api-key")
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

        // Spawn stdout reader thread
        let app_clone = app.clone();
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
            log::error!("[sidecar] Reader thread exited");
        });

        Ok(())
    }

    fn handle_message(app: &AppHandle, msg: InboundMessage) {
        match msg {
            InboundMessage::Ready => {
                log::info!("[sidecar] Ready");
            }
            InboundMessage::Created { id } => {
                log::info!("[sidecar] Emitting sdk-created-{}", id);
                let _ = app.emit(&format!("sdk-created-{}", id), ());
            }
            InboundMessage::Text {
                id,
                ref content,
                ref parent_tool_use_id,
                ref turn_uuid,
            } => {
                log::info!(
                    "[sidecar] Emitting sdk-text-{} with {} bytes",
                    id,
                    content.len()
                );
                let result = app.emit(
                    &format!("sdk-text-{}", id),
                    serde_json::json!({ "content": content, "parentToolUseId": parent_tool_use_id, "turnUuid": turn_uuid }),
                );
                if let Err(e) = result {
                    log::error!("[sidecar] Failed to emit text event: {}", e);
                }
            }
            InboundMessage::ToolStart {
                id,
                tool,
                input,
                tool_use_id,
                parent_tool_use_id,
                ref turn_uuid,
            } => {
                let _ = app.emit(
                    &format!("sdk-tool-start-{}", id),
                    serde_json::json!({ "tool": tool, "input": input, "toolUseId": tool_use_id, "parentToolUseId": parent_tool_use_id, "turnUuid": turn_uuid }),
                );
            }
            InboundMessage::ToolResult {
                id,
                tool,
                output,
                tool_use_id,
                parent_tool_use_id,
                ref turn_uuid,
            } => {
                let _ = app.emit(
                    &format!("sdk-tool-result-{}", id),
                    serde_json::json!({ "tool": tool, "output": output, "toolUseId": tool_use_id, "parentToolUseId": parent_tool_use_id, "turnUuid": turn_uuid }),
                );
            }
            InboundMessage::ThinkingStart {
                id,
                content,
                timestamp,
                parent_tool_use_id,
                ref turn_uuid,
            } => {
                let _ = app.emit(
                    &format!("sdk-thinking-start-{}", id),
                    serde_json::json!({ "content": content, "timestamp": timestamp, "parentToolUseId": parent_tool_use_id, "turnUuid": turn_uuid }),
                );
            }
            InboundMessage::ThinkingEnd {
                id,
                duration_ms,
                content,
                parent_tool_use_id,
                ref turn_uuid,
            } => {
                let _ = app.emit(
                    &format!("sdk-thinking-end-{}", id),
                    serde_json::json!({ "durationMs": duration_ms, "content": content, "parentToolUseId": parent_tool_use_id, "turnUuid": turn_uuid }),
                );
            }
            InboundMessage::Done { id } => {
                log::info!("[sidecar] Emitting sdk-done-{}", id);
                let result = app.emit(&format!("sdk-done-{}", id), ());
                if let Err(e) = result {
                    log::error!("[sidecar] Failed to emit done event: {}", e);
                }
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
                    "[sidecar] Emitting sdk-usage-{}: {} input, {} output, ${:.4}",
                    id,
                    input_tokens,
                    output_tokens,
                    total_cost_usd
                );
                let mut payload = serde_json::json!({
                    "inputTokens": input_tokens,
                    "outputTokens": output_tokens,
                    "cacheReadTokens": cache_read_tokens,
                    "cacheCreationTokens": cache_creation_tokens,
                    "totalCostUsd": total_cost_usd,
                    "durationMs": duration_ms,
                    "durationApiMs": duration_api_ms,
                    "numTurns": num_turns,
                    "contextWindow": context_window,
                });
                // Conditionally include main-agent-only tokens for accurate context bar
                if let Some(v) = main_agent_input_tokens {
                    payload["mainAgentInputTokens"] = serde_json::json!(v);
                }
                if let Some(v) = main_agent_output_tokens {
                    payload["mainAgentOutputTokens"] = serde_json::json!(v);
                }
                if let Some(v) = main_agent_cache_read_tokens {
                    payload["mainAgentCacheReadTokens"] = serde_json::json!(v);
                }
                if let Some(v) = main_agent_cache_creation_tokens {
                    payload["mainAgentCacheCreationTokens"] = serde_json::json!(v);
                }
                let _ = app.emit(&format!("sdk-usage-{}", id), payload);
            }
            InboundMessage::ProgressiveUsage {
                id,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_creation_tokens,
            } => {
                let _ = app.emit(
                    &format!("sdk-progressive-usage-{}", id),
                    serde_json::json!({
                        "inputTokens": input_tokens,
                        "outputTokens": output_tokens,
                        "cacheReadTokens": cache_read_tokens,
                        "cacheCreationTokens": cache_creation_tokens,
                    }),
                );
            }
            InboundMessage::ModelUpdated { id, model } => {
                log::info!("[sidecar] Model updated for {}: {}", id, model);
                let _ = app.emit(&format!("sdk-model-updated-{}", id), &model);
            }
            InboundMessage::Closed { id } => {
                let _ = app.emit(&format!("sdk-closed-{}", id), ());
            }
            InboundMessage::Error { id, message } => {
                let _ = app.emit(&format!("sdk-error-{}", id), &message);
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
                let _ = app.emit(
                    &format!("sdk-subagent-start-{}", id),
                    serde_json::json!({
                        "agentId": agent_id,
                        "agentType": agent_type,
                    }),
                );
            }
            InboundMessage::SubagentStop {
                id,
                agent_id,
                transcript_path,
            } => {
                log::info!(
                    "[sidecar] Subagent stopped: {} for session {}",
                    agent_id,
                    id
                );
                let _ = app.emit(
                    &format!("sdk-subagent-stop-{}", id),
                    serde_json::json!({
                        "agentId": agent_id,
                        "transcriptPath": transcript_path,
                    }),
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
                let _ = app.emit(
                    &format!("sdk-task-started-{}", id),
                    serde_json::json!({
                        "taskId": task_id,
                        "toolUseId": tool_use_id,
                        "description": description,
                        "taskType": task_type,
                    }),
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
                let _ = app.emit(
                    &format!("sdk-task-completed-{}", id),
                    serde_json::json!({
                        "taskId": task_id,
                        "toolUseId": tool_use_id,
                        "status": status,
                        "summary": summary,
                        "usage": usage,
                    }),
                );
            }
            InboundMessage::EffortUpdated { id, effort_level } => {
                log::info!("[sidecar] Effort updated for {}: {:?}", id, effort_level);
                let _ = app.emit(&format!("sdk-effort-updated-{}", id), &effort_level);
            }
            InboundMessage::PlanningQuestions { id, questions } => {
                log::info!(
                    "[sidecar] Planning questions for session {}: {} questions",
                    id,
                    questions.len()
                );
                let _ = app.emit(
                    &format!("sdk-planning-questions-{}", id),
                    serde_json::to_value(&questions).unwrap_or_default(),
                );
            }
            InboundMessage::PlanningComplete {
                id,
                plan_path,
                feature_name,
                summary,
            } => {
                log::info!(
                    "[sidecar] Planning complete for session {}: {}",
                    id,
                    feature_name
                );
                let _ = app.emit(
                    &format!("sdk-planning-complete-{}", id),
                    serde_json::json!({
                        "planPath": plan_path,
                        "featureName": feature_name,
                        "summary": summary,
                    }),
                );
            }
            InboundMessage::AskUserQuestions { id, questions } => {
                log::info!(
                    "[sidecar] AskUserQuestion for session {}: {} questions",
                    id,
                    questions.len()
                );
                let _ = app.emit(
                    &format!("sdk-ask-user-questions-{}", id),
                    serde_json::to_value(&questions).unwrap_or_default(),
                );
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
                let _ = app.emit(
                    &format!("sdk-plan-approval-request-{}", id),
                    serde_json::json!({
                        "allowedPrompts": allowed_prompts,
                        "plan": plan,
                    }),
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
                let _ = app.emit(
                    &format!("repo-description-result-{}", id),
                    serde_json::json!({
                        "description": description,
                        "keywords": keywords,
                        "vocabulary": vocabulary,
                        "icon": icon,
                        "color": color,
                    }),
                );
            }
            InboundMessage::RepoDescriptionError { id, error } => {
                log::error!("[sidecar] Repo description error for {}: {}", id, error);
                let _ = app.emit(&format!("repo-description-error-{}", id), &error);
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
                let _ = app.emit(
                    &format!("launch-profile-result-{}", id),
                    serde_json::json!({
                        "commands": commands,
                        "profiles": profiles,
                    }),
                );
            }
            InboundMessage::LaunchProfileError { id, error } => {
                log::error!("[sidecar] Launch profile error for {}: {}", id, error);
                let _ = app.emit(&format!("launch-profile-error-{}", id), &error);
            }
            InboundMessage::SdkSessionId { id, sdk_session_id } => {
                log::info!("[sidecar] SDK session ID for {}: {}", id, sdk_session_id);
                let _ = app.emit(&format!("sdk-session-id-{}", id), &sdk_session_id);
            }
            InboundMessage::ParallelSessionNotification { id, message } => {
                log::info!(
                    "[sidecar] Parallel session notification for {}: {}",
                    id,
                    message
                );
                let _ = app.emit(&format!("sdk-parallel-notification-{}", id), &message);
            }
        }
    }

    pub fn send(&self, msg: OutboundMessage) -> Result<(), String> {
        let mut stdin = self.stdin.lock();
        if let Some(ref mut stdin) = *stdin {
            let json =
                serde_json::to_string(&msg).map_err(|e| format!("Serialize error: {}", e))?;
            writeln!(stdin, "{}", json).map_err(|e| format!("Write error: {}", e))?;
            stdin.flush().map_err(|e| format!("Flush error: {}", e))?;
            Ok(())
        } else {
            Err("Sidecar not started".to_string())
        }
    }

    pub fn is_started(&self) -> bool {
        *self.started.lock()
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
