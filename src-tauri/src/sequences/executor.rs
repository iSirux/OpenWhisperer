use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use chrono::Utc;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::Notify;

use crate::config::AppConfig;
use crate::git::GitManager;
use crate::llm::LlmClient;
use crate::sequences::notifications::{NotificationSender, NotifyExtra};
use crate::sequences::persistence;
use crate::sequences::rate_limiter::SequenceRateLimiter;
use crate::sequences::state::*;
use crate::sequences::template::TemplateEngine;
use crate::sequences::types::*;
use crate::sidecar::{OutboundMessage, SidecarManager};

#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
#[allow(dead_code)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ─── AI Node Metadata ────────────────────────────────────────────────────────

/// Captured metadata from AI node executions (prompt nodes, route AI nodes).
/// Accumulated during execute_node and drained in the main loop for
/// persistence and event emission.
struct AiNodeLog {
    node_id: String,
    level: LogLevel,
    message: String,
}

struct AiNodeUsage {
    tokens: TokenUsage,
    cost: f64,
}

// ─── SequenceExecutor ────────────────────────────────────────────────────────

/// The execution engine for sequence definitions.
///
/// Drives node-by-node execution through a sequence, handling retries,
/// conditions, error strategies, cleanup, and event emission.
pub struct SequenceExecutor {
    app: AppHandle,
    sidecar: Arc<SidecarManager>,
    rate_limiter: Arc<SequenceRateLimiter>,
    /// Logs captured during AI node execution, drained after each node completes.
    ai_logs: Mutex<Vec<AiNodeLog>>,
    /// Token usage captured from SDK usage events, keyed by node_id.
    ai_usage: Mutex<HashMap<String, AiNodeUsage>>,
}

impl SequenceExecutor {
    pub fn new(
        app: AppHandle,
        sidecar: Arc<SidecarManager>,
        rate_limiter: Arc<SequenceRateLimiter>,
    ) -> Self {
        Self {
            app,
            sidecar,
            rate_limiter,
            ai_logs: Mutex::new(Vec::new()),
            ai_usage: Mutex::new(HashMap::new()),
        }
    }

    /// Execute a sequence definition with the given inputs.
    ///
    /// Returns the execution ID on success.
    ///
    /// If `dry_run` is true the sequence is validated but no nodes are executed.
    /// The caller provides shared `cancel_flag` and `pause_signal` handles so the
    /// execution can be cancelled or paused externally.
    pub async fn execute(
        &self,
        execution_id: String,
        definition: SequenceDefinition,
        inputs: HashMap<String, serde_json::Value>,
        dry_run: bool,
        cancel_flag: Arc<AtomicBool>,
        pause_signal: Arc<Notify>,
        entry_node_id: Option<String>,
    ) -> Result<String, String> {
        log::info!(
            "[sequence] Executor starting with id={}, sequence={} ({} nodes)",
            execution_id,
            definition.name,
            definition.nodes.len()
        );

        // 1. Validate required inputs
        self.validate_inputs(&definition, &inputs)?;

        // 2. Create execution state
        let execution = Arc::new(Mutex::new(SequenceExecution::new(
            execution_id.clone(),
            definition.id.clone(),
            definition.name.clone(),
            definition.version.clone(),
            definition.nodes.len(),
            inputs,
        )));

        // 3. Dry-run: validate and return early
        if dry_run {
            self.validate_nodes(&definition)?;
            let mut exec = execution.lock();
            exec.update_status(ExecutionStatus::Completed);
            exec.add_log(None, LogLevel::Info, "Dry-run validation passed");
            return Ok(execution_id);
        }

        // 4. Mark running and persist initial state
        {
            let mut exec = execution.lock();
            exec.update_status(ExecutionStatus::Running);

            // Mark trigger nodes as processed so they don't appear as perpetually
            // pending in execution views. We mark the selected trigger (if any)
            // as completed and the rest as skipped.
            let trigger_nodes: Vec<&NodeDefinition> = definition
                .nodes
                .iter()
                .filter(|n| matches!(n.node_type, NodeType::Trigger(_)))
                .collect();

            if !trigger_nodes.is_empty() {
                let selected_trigger_idx = if let Some(ref entry_id) = entry_node_id {
                    definition.triggers.iter().position(|t| match t {
                        SequenceTrigger::Manual { entry_node_id }
                        | SequenceTrigger::Schedule { entry_node_id, .. }
                        | SequenceTrigger::Event { entry_node_id, .. } => {
                            entry_node_id.as_ref() == Some(entry_id)
                        }
                    })
                } else {
                    definition
                        .triggers
                        .iter()
                        .position(|t| matches!(t, SequenceTrigger::Manual { .. }))
                };

                let selected_trigger_idx = selected_trigger_idx.or(Some(0));

                for (idx, trigger_node) in trigger_nodes.iter().enumerate() {
                    if selected_trigger_idx == Some(idx) {
                        exec.record_node_complete(
                            &trigger_node.id,
                            Some(serde_json::json!({ "trigger": true })),
                            None,
                            None,
                        );
                    } else {
                        exec.record_node_skipped(&trigger_node.id);
                    }
                }
            }
        }
        self.emit_status(&execution_id, &ExecutionStatus::Running);
        let _ = persistence::save_execution(&execution.lock());

        // 5. Execute node loop
        let mut current_node_id: Option<String> = if let Some(ref eid) = entry_node_id {
            // Explicit entry point from trigger
            Some(eid.clone())
        } else {
            // Default: first non-trigger node
            definition
                .nodes
                .iter()
                .find(|n| !matches!(n.node_type, NodeType::Trigger(_)))
                .map(|n| n.id.clone())
        };

        while let Some(node_id) = current_node_id.take() {
            // --- Cancellation check ---
            if cancel_flag.load(Ordering::Relaxed) {
                let mut exec = execution.lock();
                exec.update_status(ExecutionStatus::Cancelled);
                break;
            }

            // --- Pause check ---
            let is_paused = {
                let exec = execution.lock();
                exec.status == ExecutionStatus::Paused
            };
            if is_paused {
                pause_signal.notified().await;
                // Re-check cancellation after resume
                if cancel_flag.load(Ordering::Relaxed) {
                    let mut exec = execution.lock();
                    exec.update_status(ExecutionStatus::Cancelled);
                    break;
                }
            }

            // --- Find node definition ---
            let node_def = match definition.nodes.iter().find(|n| n.id == node_id) {
                Some(n) => n.clone(),
                None => {
                    let mut exec = execution.lock();
                    let msg = format!("Node '{}' not found in sequence", node_id);
                    exec.update_status(ExecutionStatus::Failed);
                    exec.error = Some(msg.clone());
                    self.emit_done(&execution_id, &ExecutionStatus::Failed);
                    return Err(msg);
                }
            };

            // --- Evaluate condition ---
            if let Some(ref condition) = node_def.condition {
                let ctx_value = execution.lock().context.to_value();
                let result = TemplateEngine::eval_bool(condition, &ctx_value)
                    .map_err(|e| format!("Condition eval error for '{}': {}", node_id, e))?;
                if !result {
                    execution.lock().record_node_skipped(&node_id);
                    current_node_id = self.next_node_id(&node_def, &definition, None);
                    continue;
                }
            }

            // --- Record node start ---
            {
                let mut exec = execution.lock();
                exec.record_node_start(&node_id);
                exec.current_node_id = Some(node_id.clone());
            }
            self.emit_node_start(&execution_id, &node_def);

            // --- Execute with retry logic ---
            let max_retries = node_def.retry_count.unwrap_or(0);
            let mut retry_count = 0u32;
            let mut node_result: Result<Option<serde_json::Value>, String>;

            loop {
                let ctx_value = execution.lock().context.to_value();

                node_result = self
                    .execute_node(&node_def, &ctx_value, &execution_id, cancel_flag.clone())
                    .await;

                match &node_result {
                    Ok(_) => break,
                    Err(e) => {
                        if retry_count < max_retries {
                            retry_count += 1;
                            execution.lock().add_log(
                                Some(&node_id),
                                LogLevel::Warn,
                                &format!("Retry {}/{}: {}", retry_count, max_retries, e),
                            );
                            let delay = node_def.retry_delay.unwrap_or(5);
                            let backoff = node_def.retry_backoff.unwrap_or(1.0);
                            let sleep_secs =
                                (delay as f64 * backoff.powi(retry_count as i32 - 1)) as u64;
                            tokio::time::sleep(std::time::Duration::from_secs(sleep_secs)).await;
                        } else {
                            break;
                        }
                    }
                }
            }

            // --- Drain AI logs accumulated during node execution ---
            self.drain_ai_logs(&execution_id, &execution);

            // --- Process result ---
            match node_result {
                Ok(output) => {
                    // Store output in context and process output mappings
                    if let Some(ref out) = output {
                        let mut exec = execution.lock();
                        exec.context
                            .set_node_output(&node_id, "result", out.clone());

                        for mapping in &node_def.outputs {
                            let ctx_value = exec.context.to_value();
                            if let Ok(rendered) = TemplateEngine::render(&mapping.value, &ctx_value)
                            {
                                exec.context.set_node_output(
                                    &node_id,
                                    &mapping.name,
                                    serde_json::Value::String(rendered),
                                );
                            }
                        }
                    }

                    // Drain AI usage data (tokens, cost) captured during execution
                    let (ai_tokens, ai_cost) = self
                        .drain_ai_usage(&node_id)
                        .map(|(t, c)| (Some(t), Some(c)))
                        .unwrap_or((None, None));

                    execution.lock().record_node_complete(
                        &node_id,
                        output.clone(),
                        ai_tokens,
                        ai_cost,
                    );
                    self.emit_node_complete(&execution_id, &node_id, 0, ai_cost);

                    // Determine next node.
                    // For route nodes the branch output overrides the static `next` field.
                    current_node_id = self.next_node_id(&node_def, &definition, output.as_ref());
                }
                Err(error) => {
                    execution.lock().record_node_error(&node_id, &error);
                    self.emit_node_error(&execution_id, &node_id, &error);

                    // Determine error strategy
                    let strategy = node_def
                        .on_error
                        .clone()
                        .or_else(|| {
                            definition
                                .defaults
                                .as_ref()
                                .and_then(|d| d.on_error.clone())
                        })
                        .unwrap_or(ErrorStrategy::Stop);

                    match strategy {
                        ErrorStrategy::Stop => {
                            let mut exec = execution.lock();
                            exec.update_status(ExecutionStatus::Failed);
                            exec.error = Some(error);
                            break;
                        }
                        ErrorStrategy::Skip => {
                            execution.lock().record_node_skipped(&node_id);
                            current_node_id = self.next_node_id(&node_def, &definition, None);
                        }
                        ErrorStrategy::Retry => {
                            // Retries already exhausted in the loop above — treat as failure.
                            let mut exec = execution.lock();
                            exec.update_status(ExecutionStatus::Failed);
                            exec.error = Some(error);
                            break;
                        }
                        ErrorStrategy::Goto { target } => {
                            current_node_id = Some(target);
                        }
                    }
                }
            }

            // Persist after each node
            let _ = persistence::save_execution(&execution.lock());
        }

        // 6. Run cleanup nodes
        if !definition.cleanup.is_empty() {
            {
                let mut exec = execution.lock();
                if exec.status == ExecutionStatus::Running
                    || exec.status == ExecutionStatus::Cancelled
                {
                    exec.update_status(ExecutionStatus::CleaningUp);
                }
            }

            for cleanup_node in &definition.cleanup {
                let ctx_value = execution.lock().context.to_value();
                if let Err(e) = self
                    .execute_node(cleanup_node, &ctx_value, &execution_id, cancel_flag.clone())
                    .await
                {
                    execution.lock().add_log(
                        Some(&cleanup_node.id),
                        LogLevel::Error,
                        &format!("Cleanup error (ignored): {}", e),
                    );
                }
            }
        }

        // 7. Finalize
        {
            let mut exec = execution.lock();
            if exec.status == ExecutionStatus::Running || exec.status == ExecutionStatus::CleaningUp
            {
                exec.update_status(ExecutionStatus::Completed);
            }
            exec.completed_at = Some(Utc::now());
        }

        let final_exec = execution.lock().clone();
        let _ = persistence::save_execution(&final_exec);
        self.emit_done(&execution_id, &final_exec.status);

        Ok(execution_id)
    }

    // ─── Input Validation ────────────────────────────────────────────────────

    fn validate_inputs(
        &self,
        definition: &SequenceDefinition,
        inputs: &HashMap<String, serde_json::Value>,
    ) -> Result<(), String> {
        for input_def in &definition.inputs {
            if input_def.required {
                let has_value = inputs.get(&input_def.name).map_or(false, |v| !v.is_null());
                let has_default = input_def.default.is_some();
                if !has_value && !has_default {
                    return Err(format!(
                        "Required input '{}' not provided and has no default",
                        input_def.name
                    ));
                }
            }

            // Type validation
            if let Some(value) = inputs.get(&input_def.name) {
                match input_def.input_type {
                    InputType::String => {
                        if !value.is_string() && !value.is_null() {
                            return Err(format!("Input '{}' must be a string", input_def.name));
                        }
                    }
                    InputType::Number => {
                        if !value.is_number() && !value.is_null() {
                            return Err(format!("Input '{}' must be a number", input_def.name));
                        }
                    }
                    InputType::Boolean => {
                        if !value.is_boolean() && !value.is_null() {
                            return Err(format!("Input '{}' must be a boolean", input_def.name));
                        }
                    }
                    InputType::RepoList => {
                        // Accept string or array
                    }
                }
            }
        }
        Ok(())
    }

    /// Lightweight structural validation of node graph.
    fn validate_nodes(&self, definition: &SequenceDefinition) -> Result<(), String> {
        if definition.nodes.is_empty() {
            return Err("Sequence has no nodes".to_string());
        }

        let node_ids: Vec<&str> = definition.nodes.iter().map(|n| n.id.as_str()).collect();

        // Check for duplicate IDs
        let mut seen = std::collections::HashSet::new();
        for id in &node_ids {
            if !seen.insert(*id) {
                return Err(format!("Duplicate node id: '{}'", id));
            }
        }

        // Validate `next` references
        for node in &definition.nodes {
            if let Some(ref next) = node.next {
                if !node_ids.contains(&next.as_str()) {
                    return Err(format!(
                        "Node '{}' references unknown next node '{}'",
                        node.id, next
                    ));
                }
            }
        }

        Ok(())
    }

    // ─── Next Node Resolution ────────────────────────────────────────────────

    /// Determine the next node to execute.
    ///
    /// For route nodes the branch output carries a `"next"` field that overrides
    /// the static `node.next`.  For all other nodes we fall back to `node.next`
    /// and then to positional auto-advance.
    fn next_node_id(
        &self,
        node_def: &NodeDefinition,
        definition: &SequenceDefinition,
        output: Option<&serde_json::Value>,
    ) -> Option<String> {
        // Route node branch resolution
        if matches!(node_def.node_type, NodeType::Route(_)) {
            if let Some(out) = output {
                if let Some(next) = out.get("next").and_then(|v| v.as_str()) {
                    return Some(next.to_string());
                }
            }
        }

        // Explicit next
        if let Some(ref next) = node_def.next {
            return Some(next.clone());
        }

        // Positional auto-advance (skip trigger nodes)
        let idx = definition.nodes.iter().position(|n| n.id == node_def.id);
        idx.and_then(|i| {
            definition.nodes[i + 1..]
                .iter()
                .find(|n| !matches!(n.node_type, NodeType::Trigger(_)))
                .map(|n| n.id.clone())
        })
    }

    // ─── Node Dispatch ───────────────────────────────────────────────────────

    fn execute_node<'a>(
        &'a self,
        node: &'a NodeDefinition,
        context: &'a serde_json::Value,
        execution_id: &'a str,
        cancel_flag: Arc<AtomicBool>,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<Option<serde_json::Value>, String>> + Send + 'a,
        >,
    > {
        Box::pin(async move {
            match &node.node_type {
                NodeType::Prompt(p) => self.execute_prompt(node, p, context, execution_id).await,
                NodeType::Route(r) => self.execute_route(node, r, context).await,
                NodeType::Script(s) => self.execute_script(node, s, context, cancel_flag).await,
                NodeType::Notify(n) => self.execute_notify(node, n, context, execution_id).await,
                NodeType::Delay(d) => self.execute_delay(node, d, context).await,
                NodeType::Transform(t) => self.execute_transform(node, t, context),
                NodeType::Approval(a) => {
                    self.execute_approval(node, a, context, execution_id).await
                }
                NodeType::GitBranch(g) => self.execute_git_branch(node, g, context).await,
                NodeType::GitWorktree(g) => self.execute_git_worktree(node, g, context).await,
                NodeType::GitCommit(g) => self.execute_git_commit(node, g, context).await,
                NodeType::GitPush(g) => self.execute_git_push(node, g, context).await,
                NodeType::GitDeleteBranch(g) => {
                    self.execute_git_delete_branch(node, g, context).await
                }
                NodeType::GitDeleteWorktree(g) => {
                    self.execute_git_delete_worktree(node, g, context).await
                }
                NodeType::GithubPr(g) => self.execute_github_pr(node, g, context).await,
                NodeType::GithubPrWait(g) => {
                    self.execute_github_pr_wait(node, g, context, cancel_flag)
                        .await
                }
                NodeType::GithubPrMerge(g) => self.execute_github_pr_merge(node, g, context).await,
                NodeType::Wait(w) => self.execute_wait(node, w, context, cancel_flag).await,
                NodeType::File(f) => self.execute_file(node, f, context).await,
                NodeType::Http(h) => self.execute_http(node, h, context).await,
                NodeType::Loop(l) => {
                    self.execute_loop(node, l, context, execution_id, cancel_flag)
                        .await
                }
                NodeType::Parallel(p) => {
                    self.execute_parallel(node, p, context, execution_id, cancel_flag)
                        .await
                }
                NodeType::ForEach(f) => {
                    self.execute_foreach(node, f, context, execution_id, cancel_flag)
                        .await
                }
                NodeType::SubSequence(s) => {
                    self.execute_subsequence(node, s, context, execution_id)
                        .await
                }
                NodeType::Trigger(_) => {
                    // Trigger nodes are entry-point markers; no-op at execution time
                    Ok(None)
                }
            }
        })
    }

    // ─── Prompt Node ─────────────────────────────────────────────────────────

    async fn execute_prompt(
        &self,
        node: &NodeDefinition,
        prompt_node: &PromptNode,
        context: &serde_json::Value,
        execution_id: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        // 0. Rate limiting: check provider rate and acquire permit
        let provider = prompt_node.provider.as_deref().unwrap_or("claude");
        if let Some(delay_ms) = self.rate_limiter.check_provider_rate(provider) {
            log::info!(
                "[sequence] Rate limit: waiting {}ms for provider '{}'",
                delay_ms,
                provider
            );
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }
        let _permit = self.rate_limiter.acquire_prompt_permit().await?;
        self.rate_limiter.record_request(provider);

        // 1. Ensure sidecar is started
        if !self.sidecar.is_started() {
            self.sidecar
                .start(self.app.clone())
                .map_err(|e| format!("Failed to start sidecar: {}", e))?;
        }

        // 2. Render prompt template
        let rendered_prompt = TemplateEngine::render(&prompt_node.prompt, context)
            .map_err(|e| format!("Template error: {}", e))?;

        // 3. Determine model and effort
        let model = prompt_node.model.clone();
        let effort = prompt_node.effort.clone();

        // 3a. Log the prompt being sent
        {
            let model_label = model.as_deref().unwrap_or("default");
            let effort_label = effort.as_deref().unwrap_or("default");
            let prompt_preview = Self::truncate_for_log(&rendered_prompt, 200);
            self.push_ai_log(
                &node.id,
                LogLevel::Info,
                format!(
                    "Sending prompt (model: {}, effort: {}): {}",
                    model_label, effort_label, prompt_preview
                ),
            );
        }

        // 4. Create SDK session
        let session_id = format!("seq-{}-{}", execution_id, node.id);

        // Resolve cwd from context (repo.path) or fall back to current directory
        let cwd = context
            .get("repo")
            .and_then(|r| r.get("path"))
            .and_then(|p| p.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string()
            });

        // Render system prompt if present
        let system_prompt = match &prompt_node.system_prompt {
            Some(sp) => Some(
                TemplateEngine::render(sp, context)
                    .map_err(|e| format!("System prompt template error: {}", e))?,
            ),
            None => None,
        };

        self.sidecar
            .send(OutboundMessage::Create {
                id: session_id.clone(),
                cwd: cwd.clone(),
                provider: prompt_node.provider.clone(),
                codex_mode: None,
                model: model.clone(),
                system_prompt,
                messages: None,
                sdk_session_id: None,
                plan_mode: None,
                note_mode: None,
                read_only_mode: None,
                mcp_servers: None,
                fork_from_sdk_session_id: None,
                fork_at_message_uuid: None,
                autocompact_pct: None,
                disable_hooks: None,
            })
            .map_err(|e| format!("Sidecar send error: {}", e))?;

        // Wait for Created event via oneshot channel
        let (created_tx, created_rx) = tokio::sync::oneshot::channel::<()>();
        let created_tx = Arc::new(Mutex::new(Some(created_tx)));
        let created_event = format!("sdk-created-{}", session_id);
        let _created_listener = self.app.listen(created_event, move |_event| {
            if let Some(tx) = created_tx.lock().take() {
                let _ = tx.send(());
            }
        });

        tokio::time::timeout(std::time::Duration::from_secs(30), created_rx)
            .await
            .map_err(|_| "Timeout waiting for session creation".to_string())?
            .map_err(|_| "Session creation channel dropped".to_string())?;

        // 5. Set effort level if specified
        if let Some(ref effort_val) = effort {
            let _ = self.sidecar.send(OutboundMessage::UpdateEffort {
                id: session_id.clone(),
                effort_level: Some(effort_val.clone()),
            });
        }

        // 6. Send query
        self.sidecar
            .send(OutboundMessage::Query {
                id: session_id.clone(),
                prompt: rendered_prompt,
                images: None,
            })
            .map_err(|e| format!("Query send error: {}", e))?;

        // 7. Accumulate text and wait for done/error
        let accumulated_text = Arc::new(Mutex::new(String::new()));

        // Listen for text events
        let text_acc = accumulated_text.clone();
        let text_event = format!("sdk-text-{}", session_id);
        let _text_listener = self.app.listen(text_event, move |event| {
            let payload = event.payload();
            if let Ok(s) = serde_json::from_str::<String>(payload) {
                text_acc.lock().push_str(&s);
            }
        });

        // Listen for usage events (emitted before done)
        let usage_data: Arc<Mutex<Option<(TokenUsage, f64, u64, u64)>>> =
            Arc::new(Mutex::new(None));
        let usage_capture = usage_data.clone();
        let usage_event = format!("sdk-usage-{}", session_id);
        let _usage_listener = self.app.listen(usage_event, move |event| {
            if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                let tokens = TokenUsage {
                    input_tokens: payload
                        .get("inputTokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    output_tokens: payload
                        .get("outputTokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    cache_read: payload
                        .get("cacheReadTokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    cache_creation: payload
                        .get("cacheCreationTokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                };
                let cost = payload
                    .get("totalCostUsd")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                let duration_ms = payload
                    .get("durationMs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let num_turns = payload
                    .get("numTurns")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                *usage_capture.lock() = Some((tokens, cost, duration_ms, num_turns));
            }
        });

        // Wait for done or error
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let done_tx = Arc::new(Mutex::new(Some(done_tx)));

        let done_tx_ok = done_tx.clone();
        let done_event = format!("sdk-done-{}", session_id);
        let _done_listener = self.app.listen(done_event, move |_event| {
            if let Some(tx) = done_tx_ok.lock().take() {
                let _ = tx.send(Ok(()));
            }
        });

        let done_tx_err = done_tx.clone();
        let error_event = format!("sdk-error-{}", session_id);
        let _error_listener = self.app.listen(error_event, move |event| {
            let msg = serde_json::from_str::<String>(event.payload())
                .unwrap_or_else(|_| "Unknown error".to_string());
            if let Some(tx) = done_tx_err.lock().take() {
                let _ = tx.send(Err(msg));
            }
        });

        // Apply timeout
        let timeout_secs = node.timeout.unwrap_or(300);
        let result = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), done_rx)
            .await
            .map_err(|_| {
                format!(
                    "Prompt node '{}' timed out after {}s",
                    node.id, timeout_secs
                )
            })?
            .map_err(|_| "Done channel dropped".to_string())?;

        // 8. Close session
        let _ = self.sidecar.send(OutboundMessage::Close { id: session_id });

        // 9. Log response and capture usage
        match &result {
            Ok(()) => {
                let text = accumulated_text.lock().clone();

                // Log usage data if captured
                if let Some((tokens, cost, duration_ms, num_turns)) = usage_data.lock().take() {
                    self.push_ai_log(
                        &node.id,
                        LogLevel::Info,
                        format!(
                            "AI responded ({} input, {} output, {} cache_read tokens, ${:.4}, {}ms, {} turns): {}",
                            tokens.input_tokens,
                            tokens.output_tokens,
                            tokens.cache_read,
                            cost,
                            duration_ms,
                            num_turns,
                            Self::truncate_for_log(&text, 200),
                        ),
                    );
                    self.store_ai_usage(&node.id, tokens, cost);
                } else {
                    self.push_ai_log(
                        &node.id,
                        LogLevel::Info,
                        format!(
                            "AI responded (no usage data): {}",
                            Self::truncate_for_log(&text, 200),
                        ),
                    );
                }
            }
            Err(e) => {
                self.push_ai_log(
                    &node.id,
                    LogLevel::Error,
                    format!("AI prompt failed: {}", e),
                );
            }
        }

        // Return result
        match result {
            Ok(()) => {
                let text = accumulated_text.lock().clone();
                if prompt_node.output_format.as_deref() == Some("json") {
                    match serde_json::from_str::<serde_json::Value>(&text) {
                        Ok(v) => Ok(Some(v)),
                        Err(_) => Ok(Some(serde_json::Value::String(text))),
                    }
                } else {
                    Ok(Some(serde_json::Value::String(text)))
                }
            }
            Err(e) => Err(e),
        }
    }

    // ─── Route Node ──────────────────────────────────────────────────────────

    async fn execute_route(
        &self,
        node: &NodeDefinition,
        route: &RouteNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, String> {
        // Expression-based routing
        if let Some(ref eval_expr) = route.eval {
            let result = TemplateEngine::eval_string(eval_expr, context)?;
            let branch_key = result.trim().to_string();

            if let Some(branch) = route.branches.get(&branch_key) {
                return Ok(Some(serde_json::json!({
                    "branch": branch_key,
                    "next": branch.target(),
                })));
            } else if let Some(ref default) = route.default {
                return Ok(Some(serde_json::json!({
                    "branch": "default",
                    "next": default,
                })));
            } else {
                return Err(format!(
                    "No matching branch for '{}' and no default",
                    branch_key
                ));
            }
        }

        // AI classification routing via LLM
        if let Some(ref prompt_template) = route.prompt {
            return self
                .execute_route_ai(node, route, prompt_template, context)
                .await;
        }

        Err("Route node must have either 'eval' or 'prompt'".to_string())
    }

    /// AI-based route classification using the configured LLM provider.
    async fn execute_route_ai(
        &self,
        node: &NodeDefinition,
        route: &RouteNode,
        prompt_template: &str,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, String> {
        // Build system prompt listing available branches
        let mut branch_descriptions = Vec::new();
        for (key, branch) in &route.branches {
            let desc = match branch {
                RouteBranch::Long {
                    description: Some(d),
                    ..
                } => format!("- {}: {}", key, d),
                _ => format!("- {}", key),
            };
            branch_descriptions.push(desc);
        }

        let is_multi = route.multi.unwrap_or(false);
        let classification_mode = if is_multi {
            "multi-select"
        } else {
            "single-select"
        };

        let system_prompt = format!(
            "You are a classifier. Given the user's input, select the most appropriate branch(es).\n\n\
             Mode: {}\n\n\
             Available branches:\n{}\n\n\
             {}{}Respond with ONLY the branch key name(s), nothing else. \
             {}",
            classification_mode,
            branch_descriptions.join("\n"),
            if let Some(min) = route.min { format!("Minimum selections: {}\n", min) } else { String::new() },
            if let Some(max) = route.max { format!("Maximum selections: {}\n", max) } else { String::new() },
            if is_multi {
                "For multi-select, respond with branch keys separated by commas (e.g., 'branch1,branch2')."
            } else {
                "Respond with exactly one branch key."
            }
        );

        // Render the user prompt
        let user_prompt = TemplateEngine::render(prompt_template, context)?;

        // Add context if provided
        let full_prompt = if let Some(ref ctx_template) = route.context {
            let rendered_ctx = TemplateEngine::render(ctx_template, context)?;
            format!("{}\n\nContext:\n{}", system_prompt, rendered_ctx)
        } else {
            system_prompt
        };

        let combined_prompt = format!("{}\n\nUser input:\n{}", full_prompt, user_prompt);

        // Create LLM client from app config
        let llm_client = create_llm_client_from_app(&self.app)?;

        // Log the classification request
        let branch_keys: Vec<&String> = route.branches.keys().collect();
        self.push_ai_log(
            &node.id,
            LogLevel::Info,
            format!(
                "Route AI classification via LLM (branches: {:?}): {}",
                branch_keys,
                Self::truncate_for_log(&user_prompt, 200),
            ),
        );

        // Send to LLM
        let result: crate::llm::GenerationResult<String> = llm_client
            .generate_with_usage::<String>(&combined_prompt, None)
            .await
            .map_err(|e| {
                self.push_ai_log(
                    &node.id,
                    LogLevel::Error,
                    format!("Route AI classification failed: {}", e),
                );
                format!("Route AI classification failed: {}", e)
            })?;

        let response = result.data.trim().to_string();

        // Log the classification result with usage
        self.push_ai_log(
            &node.id,
            LogLevel::Info,
            format!(
                "LLM classified as '{}' ({} input, {} output tokens)",
                response, result.usage.input_tokens, result.usage.output_tokens,
            ),
        );

        // Store LLM usage for this route node
        {
            let tokens = TokenUsage {
                input_tokens: result.usage.input_tokens,
                output_tokens: result.usage.output_tokens,
                cache_read: 0,
                cache_creation: 0,
            };
            // LLM providers don't report cost directly, so use 0
            self.store_ai_usage(&node.id, tokens, 0.0);
        }

        if is_multi {
            // Multi-select: parse comma-separated branch keys
            let selected: Vec<String> = response
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();

            let mut matched_branches = Vec::new();
            let mut matched_targets = Vec::new();

            for key in &selected {
                let lower_key = key.to_lowercase();
                if let Some((matched_key, branch)) = route
                    .branches
                    .iter()
                    .find(|(k, _)| k.to_lowercase() == lower_key)
                {
                    matched_branches.push(matched_key.clone());
                    matched_targets.push(branch.target().to_string());
                }
            }

            if matched_branches.is_empty() {
                // Fall back to default
                if let Some(ref default) = route.default {
                    return Ok(Some(serde_json::json!({
                        "branch": "default",
                        "next": default,
                        "ai_classified": true,
                    })));
                }
                return Err(format!(
                    "AI classification returned '{}' which matched no branches",
                    response
                ));
            }

            let execution_mode = route.execution.as_deref().unwrap_or("sequential");

            Ok(Some(serde_json::json!({
                "branches": matched_branches,
                "targets": matched_targets,
                "execution": execution_mode,
                "ai_classified": true,
            })))
        } else {
            // Single-select: match branch key (case-insensitive)
            let lower_response = response.to_lowercase();
            if let Some((matched_key, branch)) = route
                .branches
                .iter()
                .find(|(k, _)| k.to_lowercase() == lower_response)
            {
                return Ok(Some(serde_json::json!({
                    "branch": matched_key,
                    "next": branch.target(),
                    "ai_classified": true,
                })));
            }

            // Fall back to default
            if let Some(ref default) = route.default {
                return Ok(Some(serde_json::json!({
                    "branch": "default",
                    "next": default,
                    "ai_classified": true,
                })));
            }

            Err(format!(
                "AI classification returned '{}' which matched no branch and no default set",
                response
            ))
        }
    }

    // ─── Script Node ─────────────────────────────────────────────────────────

    async fn execute_script(
        &self,
        node: &NodeDefinition,
        script: &ScriptNode,
        context: &serde_json::Value,
        _cancel_flag: Arc<AtomicBool>,
    ) -> Result<Option<serde_json::Value>, String> {
        let rendered_cmd = TemplateEngine::render(&script.command, context)?;

        let cwd = match &script.cwd {
            Some(c) => TemplateEngine::render(c, context)?,
            None => std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
        };

        let timeout_secs = node.timeout.unwrap_or(120);

        let mut cmd = tokio::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" });
        if cfg!(windows) {
            cmd.args(["/C", &rendered_cmd]);
        } else {
            cmd.args(["-c", &rendered_cmd]);
        }
        cmd.current_dir(&cwd);

        // Set environment variables
        if let Some(ref env) = script.env {
            for (k, v) in env {
                let rendered_v = TemplateEngine::render(v, context).unwrap_or_else(|_| v.clone());
                cmd.env(k, rendered_v);
            }
        }

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn script: {}", e))?;

        let output = tokio::time::timeout(
            std::time::Duration::from_secs(timeout_secs),
            child.wait_with_output(),
        )
        .await
        .map_err(|_| format!("Script timed out after {}s", timeout_secs))?
        .map_err(|e| format!("Script execution error: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if !output.status.success() {
            let detail = if stderr.is_empty() { &stdout } else { &stderr };
            return Err(format!(
                "Script failed (exit {}): {}",
                output.status.code().unwrap_or(-1),
                detail
            ));
        }

        Ok(Some(serde_json::json!({
            "stdout": stdout.trim(),
            "stderr": stderr.trim(),
            "exit_code": output.status.code().unwrap_or(0),
        })))
    }

    // ─── Notify Node ─────────────────────────────────────────────────────────

    async fn execute_notify(
        &self,
        _node: &NodeDefinition,
        notify: &NotifyNode,
        context: &serde_json::Value,
        execution_id: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        let rendered_message = TemplateEngine::render(&notify.message, context)?;
        let rendered_title = match &notify.title {
            Some(t) => Some(TemplateEngine::render(t, context)?),
            None => None,
        };

        let title_str = rendered_title.unwrap_or_else(|| "Sequence Notification".to_string());

        // Emit Tauri event for the frontend to display
        // Includes built-in notification flags so the frontend can handle system notifications and sounds
        log::info!(
            "[sequence][{}] emit notification: title={:?}, play_sound={}, system_notification={}, sound={}",
            &execution_id[..8.min(execution_id.len())],
            title_str,
            notify.play_sound,
            notify.system_notification,
            notify.sound.unwrap_or(1),
        );
        let _ = self.app.emit(
            &format!("sequence-notification-{}", execution_id),
            serde_json::json!({
                "title": title_str,
                "message": rendered_message,
                "channel": notify.channel,
                "preset": notify.preset,
                "system_notification": notify.system_notification,
                "play_sound": notify.play_sound,
                "sound": notify.sound.unwrap_or(1),
            }),
        );

        // Also emit a global notification event so frontend handling does not
        // depend on per-execution listener registration timing.
        let _ = self.app.emit(
            "sequence-notification",
            serde_json::json!({
                "execution_id": execution_id,
                "title": title_str,
                "message": rendered_message,
                "channel": notify.channel,
                "preset": notify.preset,
                "system_notification": notify.system_notification,
                "play_sound": notify.play_sound,
                "sound": notify.sound.unwrap_or(1),
            }),
        );

        // Resolve the channel config for external delivery
        let channel_config: Option<crate::config::NotificationChannelConfig> =
            if let Some(ref channel_id) = notify.channel {
                // Look up named channel from app config
                let config: tauri::State<parking_lot::Mutex<AppConfig>> = self.app.state();
                let config_guard = config.lock();
                config_guard
                    .sequences
                    .notification_channels
                    .iter()
                    .find(|c| c.id == *channel_id)
                    .cloned()
            } else if let Some(ref url) = notify.url {
                // Inline webhook channel from url field
                Some(crate::config::NotificationChannelConfig {
                    id: "inline".to_string(),
                    name: "Inline Webhook".to_string(),
                    channel_type: crate::config::NotificationChannelType::Webhook,
                    webhook_url: Some(url.clone()),
                    headers: None,
                    enabled: true,
                })
            } else if let Some(ref webhook) = notify.webhook {
                // Legacy webhook field
                Some(crate::config::NotificationChannelConfig {
                    id: "inline-legacy".to_string(),
                    name: "Inline Webhook (legacy)".to_string(),
                    channel_type: crate::config::NotificationChannelType::Webhook,
                    webhook_url: Some(webhook.clone()),
                    headers: None,
                    enabled: true,
                })
            } else {
                // No channel specified — system-only notification (already emitted via Tauri event)
                None
            };

        // If we have a channel config, send the external notification
        if let Some(ref channel) = channel_config {
            // Build NotifyExtra from the notify node fields
            let extra = NotifyExtra {
                blocks: notify.blocks.clone(),
                embed: notify.embed.clone(),
                body: notify
                    .body
                    .as_ref()
                    .map(|b| TemplateEngine::render(b, context).unwrap_or_else(|_| b.clone())),
                method: notify.method.clone(),
                headers: notify.headers.clone(),
            };

            let sender = NotificationSender::new();
            let result = sender
                .send(channel, &title_str, &rendered_message, Some(&extra))
                .await;

            if let Err(ref err) = result {
                let on_error = notify.on_notify_error.as_deref().unwrap_or("stop");

                match on_error {
                    "warn" => {
                        log::error!(
                            "[notifications] Warning: notification delivery failed: {}",
                            err
                        );
                        // Continue — return Ok
                    }
                    _ => {
                        // "stop" or unset: propagate the error
                        return Err(format!("Notification delivery failed: {}", err));
                    }
                }
            }
        }

        Ok(Some(serde_json::json!({
            "notified": true,
            "message": rendered_message,
        })))
    }

    // ─── Delay Node ──────────────────────────────────────────────────────────

    async fn execute_delay(
        &self,
        _node: &NodeDefinition,
        delay: &DelayNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, String> {
        let rendered_duration = TemplateEngine::render(&delay.duration, context)?;
        let secs = parse_duration_to_secs(&rendered_duration)?;

        if let Some(ref message) = delay.message {
            let rendered = TemplateEngine::render(message, context)?;
            log::info!("[sequence] Delay {}s: {}", secs, rendered);
        }

        tokio::time::sleep(std::time::Duration::from_secs(secs)).await;

        Ok(Some(serde_json::json!({
            "delayed_seconds": secs,
        })))
    }

    // ─── Transform Node ──────────────────────────────────────────────────────

    fn execute_transform(
        &self,
        _node: &NodeDefinition,
        transform: &TransformNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, String> {
        // Resolve the input value via template rendering
        let mut current = TemplateEngine::render(&transform.input, context)?;

        for op in &transform.operations {
            match op.op_type {
                TransformOpType::Regex => {
                    let pattern = op
                        .pattern
                        .as_ref()
                        .ok_or("Regex transform requires 'pattern'")?;
                    let replacement = op.replacement.as_deref().unwrap_or("");
                    let re = regex::Regex::new(pattern)
                        .map_err(|e| format!("Invalid regex '{}': {}", pattern, e))?;
                    current = re.replace_all(&current, replacement).to_string();
                }
                TransformOpType::JsonPath => {
                    // Simple dot-path extraction from a JSON string
                    let path = op
                        .path
                        .as_ref()
                        .ok_or("JsonPath transform requires 'path'")?;
                    let parsed: serde_json::Value = serde_json::from_str(&current)
                        .map_err(|e| format!("JSON parse error: {}", e))?;
                    let parts: Vec<&str> = path.split('.').collect();
                    let mut val = &parsed;
                    for part in &parts {
                        val = val
                            .get(*part)
                            .ok_or_else(|| format!("Path '{}' not found in JSON", path))?;
                    }
                    current = match val {
                        serde_json::Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                }
                TransformOpType::Template => {
                    let tmpl = op
                        .template
                        .as_ref()
                        .ok_or("Template transform requires 'template'")?;
                    // Build a context that includes the current value as "value"
                    let mut ctx = match context.clone() {
                        serde_json::Value::Object(m) => m,
                        _ => serde_json::Map::new(),
                    };
                    ctx.insert(
                        "value".to_string(),
                        serde_json::Value::String(current.clone()),
                    );
                    let ctx_val = serde_json::Value::Object(ctx);
                    current = TemplateEngine::render(tmpl, &ctx_val)?;
                }
            }
        }

        // Try to parse the final result as JSON; fall back to string
        let result = serde_json::from_str::<serde_json::Value>(&current)
            .unwrap_or_else(|_| serde_json::Value::String(current));

        Ok(Some(result))
    }

    // ─── Approval Node ───────────────────────────────────────────────────────

    async fn execute_approval(
        &self,
        node: &NodeDefinition,
        approval: &ApprovalNode,
        context: &serde_json::Value,
        execution_id: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        let rendered_message = TemplateEngine::render(&approval.message, context)?;

        // Emit approval request event
        let _ = self.app.emit(
            &format!("sequence-approval-{}", execution_id),
            serde_json::json!({
                "node_id": node.id,
                "message": rendered_message,
                "timeout": node.timeout,
            }),
        );

        // Create a oneshot channel for the approval response.
        // The SequenceManager stores the sender so `approve_node` / `reject_node`
        // can resolve it.
        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();

        // Store the sender in the app's managed SequenceManager
        if let Some(manager) = self.app.try_state::<crate::sequences::SequenceManager>() {
            manager
                .approval_channels
                .lock()
                .insert(execution_id.to_string(), tx);
        } else {
            return Err("SequenceManager not found in app state".to_string());
        }

        let timeout_secs = node.timeout.unwrap_or(3600);

        let result = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await;

        match result {
            Ok(Ok(true)) => Ok(Some(serde_json::json!({
                "approved": true,
            }))),
            Ok(Ok(false)) => Err("Approval rejected".to_string()),
            Ok(Err(_)) => Err("Approval channel dropped".to_string()),
            Err(_) => {
                // Timeout
                match approval.on_timeout.as_deref() {
                    Some("skip") => Ok(Some(serde_json::json!({
                        "approved": false,
                        "timed_out": true,
                    }))),
                    Some("fail") | None => {
                        Err(format!("Approval timed out after {}s", timeout_secs))
                    }
                    Some(target_node) => {
                        // Return a routing hint — the caller can handle this
                        Ok(Some(serde_json::json!({
                            "approved": false,
                            "timed_out": true,
                            "next": target_node,
                        })))
                    }
                }
            }
        }
    }

    // ─── Git Branch Node ──────────────────────────────────────────────────────

    async fn execute_git_branch(
        &self,
        _node: &NodeDefinition,
        git_branch: &GitBranchNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, String> {
        let rendered_branch = TemplateEngine::render(&git_branch.branch_name, context)?;
        let cwd = resolve_cwd(context);

        // If `from` is specified, checkout that branch first
        if let Some(ref from_ref) = git_branch.from {
            let rendered_from = TemplateEngine::render(from_ref, context)?;
            GitManager::checkout_branch(&cwd, &rendered_from).map_err(|e| {
                format!("Failed to checkout base branch '{}': {}", rendered_from, e)
            })?;
        }

        GitManager::create_branch(&cwd, &rendered_branch)
            .map_err(|e| format!("Failed to create branch '{}': {}", rendered_branch, e))?;

        Ok(Some(serde_json::json!({
            "branch": rendered_branch,
        })))
    }

    // ─── Git Worktree Node ──────────────────────────────────────────────────

    async fn execute_git_worktree(
        &self,
        _node: &NodeDefinition,
        git_wt: &GitWorktreeNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, String> {
        let rendered_branch = TemplateEngine::render(&git_wt.branch_name, context)?;
        let cwd = resolve_cwd(context);

        let worktree_path = match &git_wt.worktree_path {
            Some(p) => TemplateEngine::render(p, context)?,
            None => GitManager::get_worktree_path(&cwd, &rendered_branch),
        };

        let start_point = git_wt
            .base_branch
            .as_ref()
            .map(|b| TemplateEngine::render(b, context))
            .transpose()?;

        GitManager::create_worktree(
            &cwd,
            &rendered_branch,
            &worktree_path,
            start_point.as_deref(),
        )
        .map_err(|e| format!("Failed to create worktree: {}", e))?;

        Ok(Some(serde_json::json!({
            "branch": rendered_branch,
            "worktree_path": worktree_path,
        })))
    }

    // ─── Git Commit Node ────────────────────────────────────────────────────

    async fn execute_git_commit(
        &self,
        _node: &NodeDefinition,
        git_commit: &GitCommitNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, String> {
        let rendered_message = TemplateEngine::render(&git_commit.message, context)?;
        let cwd = resolve_cwd(context);

        // Stage files via `git add` if specified
        if let Some(ref add_patterns) = git_commit.add {
            for pattern in add_patterns {
                let rendered_pattern = TemplateEngine::render(pattern, context)?;
                let mut cmd = tokio::process::Command::new("git");
                cmd.args(["add", &rendered_pattern]);
                cmd.current_dir(&cwd);
                #[cfg(windows)]
                cmd.creation_flags(CREATE_NO_WINDOW);
                cmd.stdout(std::process::Stdio::piped());
                cmd.stderr(std::process::Stdio::piped());
                let output = cmd
                    .output()
                    .await
                    .map_err(|e| format!("Failed to run git add: {}", e))?;
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    return Err(format!("git add '{}' failed: {}", rendered_pattern, stderr));
                }
            }
        }

        // Build commit command
        let mut cmd = tokio::process::Command::new("git");
        cmd.arg("commit");
        cmd.args(["-m", &rendered_message]);

        // Add specific files to the commit if specified
        if let Some(ref files) = git_commit.files {
            for file in files {
                let rendered_file = TemplateEngine::render(file, context)?;
                cmd.arg(&rendered_file);
            }
        }

        cmd.current_dir(&cwd);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to run git commit: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git commit failed: {}", stderr));
        }

        Ok(Some(serde_json::json!({
            "message": rendered_message,
        })))
    }

    // ─── Git Push Node ──────────────────────────────────────────────────────

    async fn execute_git_push(
        &self,
        _node: &NodeDefinition,
        git_push: &GitPushNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, String> {
        let cwd = resolve_cwd(context);
        let remote = git_push.remote.as_deref().unwrap_or("origin");

        let mut cmd = tokio::process::Command::new("git");
        cmd.arg("push");
        cmd.arg(remote);
        if git_push.force.unwrap_or(false) {
            cmd.arg("--force");
        }
        cmd.current_dir(&cwd);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to run git push: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git push failed: {}", stderr));
        }

        Ok(Some(serde_json::json!({
            "pushed": true,
            "remote": remote,
        })))
    }

    // ─── Git Delete Branch Node ─────────────────────────────────────────────

    async fn execute_git_delete_branch(
        &self,
        _node: &NodeDefinition,
        git_del: &GitDeleteBranchNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, String> {
        let rendered_branch = TemplateEngine::render(&git_del.branch, context)?;
        let cwd = resolve_cwd(context);

        // Delete local branch
        let mut cmd = tokio::process::Command::new("git");
        cmd.args(["branch", "-D", &rendered_branch]);
        cmd.current_dir(&cwd);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to run git branch -D: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "git branch -D '{}' failed: {}",
                rendered_branch, stderr
            ));
        }

        // Also delete remote branch if requested
        if git_del.remote.unwrap_or(false) {
            let mut cmd = tokio::process::Command::new("git");
            cmd.args(["push", "origin", "--delete", &rendered_branch]);
            cmd.current_dir(&cwd);
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());

            let output = cmd
                .output()
                .await
                .map_err(|e| format!("Failed to run git push --delete: {}", e))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!(
                    "git push origin --delete '{}' failed: {}",
                    rendered_branch, stderr
                ));
            }
        }

        Ok(Some(serde_json::json!({
            "deleted": rendered_branch,
        })))
    }

    // ─── Git Delete Worktree Node ───────────────────────────────────────────

    async fn execute_git_delete_worktree(
        &self,
        _node: &NodeDefinition,
        git_del_wt: &GitDeleteWorktreeNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, String> {
        let rendered_path = TemplateEngine::render(&git_del_wt.path, context)?;
        let cwd = resolve_cwd(context);

        GitManager::remove_worktree(&cwd, &rendered_path)
            .map_err(|e| format!("Failed to remove worktree '{}': {}", rendered_path, e))?;

        Ok(Some(serde_json::json!({
            "removed": rendered_path,
        })))
    }

    // ─── GitHub PR Node ─────────────────────────────────────────────────────

    async fn execute_github_pr(
        &self,
        _node: &NodeDefinition,
        gh_pr: &GitHubPrNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, String> {
        let rendered_title = TemplateEngine::render(&gh_pr.title, context)?;
        let cwd = resolve_cwd(context);

        let mut cmd = tokio::process::Command::new("gh");
        cmd.args(["pr", "create", "--title", &rendered_title]);

        if let Some(ref body) = gh_pr.body {
            let rendered_body = TemplateEngine::render(body, context)?;
            cmd.args(["--body", &rendered_body]);
        }

        if gh_pr.draft.unwrap_or(false) {
            cmd.arg("--draft");
        }

        if let Some(ref target) = gh_pr.target_branch {
            let rendered_target = TemplateEngine::render(target, context)?;
            cmd.args(["--base", &rendered_target]);
        }

        if let Some(ref labels) = gh_pr.labels {
            for label in labels {
                let rendered_label = TemplateEngine::render(label, context)?;
                cmd.args(["--label", &rendered_label]);
            }
        }

        if let Some(ref reviewers) = gh_pr.reviewers {
            for reviewer in reviewers {
                let rendered_reviewer = TemplateEngine::render(reviewer, context)?;
                cmd.args(["--reviewer", &rendered_reviewer]);
            }
        }

        cmd.current_dir(&cwd);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to run gh pr create: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("gh pr create failed: {}", stderr));
        }

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();

        // Parse PR URL and number from stdout (gh outputs the PR URL)
        let pr_url = stdout.clone();
        let pr_number = pr_url
            .rsplit('/')
            .next()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);

        Ok(Some(serde_json::json!({
            "pr_url": pr_url,
            "pr_number": pr_number,
        })))
    }

    // ─── GitHub PR Wait Node ────────────────────────────────────────────────

    async fn execute_github_pr_wait(
        &self,
        node: &NodeDefinition,
        gh_wait: &GitHubPrWaitNode,
        context: &serde_json::Value,
        cancel_flag: Arc<AtomicBool>,
    ) -> Result<Option<serde_json::Value>, String> {
        let rendered_pr = TemplateEngine::render(&gh_wait.pr, context)?;
        let cwd = resolve_cwd(context);
        let poll_interval = gh_wait.poll_interval.unwrap_or(30);
        let timeout_secs = node.timeout.unwrap_or(3600);
        let start = std::time::Instant::now();

        loop {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err("Wait cancelled".to_string());
            }

            if start.elapsed().as_secs() > timeout_secs {
                return Err(format!(
                    "PR wait timed out after {}s waiting for '{}'",
                    timeout_secs, gh_wait.wait_for
                ));
            }

            let ready = match gh_wait.wait_for.as_str() {
                "checks" => {
                    // gh pr checks returns exit 0 when all checks pass
                    let mut cmd = tokio::process::Command::new("gh");
                    cmd.args(["pr", "checks", &rendered_pr]);
                    cmd.current_dir(&cwd);
                    #[cfg(windows)]
                    cmd.creation_flags(CREATE_NO_WINDOW);
                    cmd.stdout(std::process::Stdio::piped());
                    cmd.stderr(std::process::Stdio::piped());
                    let output = cmd
                        .output()
                        .await
                        .map_err(|e| format!("Failed to run gh pr checks: {}", e))?;
                    output.status.success()
                }
                "reviews" => {
                    let mut cmd = tokio::process::Command::new("gh");
                    cmd.args([
                        "pr",
                        "view",
                        &rendered_pr,
                        "--json",
                        "reviewDecision",
                        "-q",
                        ".reviewDecision",
                    ]);
                    cmd.current_dir(&cwd);
                    #[cfg(windows)]
                    cmd.creation_flags(CREATE_NO_WINDOW);
                    cmd.stdout(std::process::Stdio::piped());
                    cmd.stderr(std::process::Stdio::piped());
                    let output = cmd
                        .output()
                        .await
                        .map_err(|e| format!("Failed to run gh pr view: {}", e))?;
                    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    stdout == "APPROVED"
                }
                "merge" => {
                    let mut cmd = tokio::process::Command::new("gh");
                    cmd.args([
                        "pr",
                        "view",
                        &rendered_pr,
                        "--json",
                        "state",
                        "-q",
                        ".state",
                    ]);
                    cmd.current_dir(&cwd);
                    #[cfg(windows)]
                    cmd.creation_flags(CREATE_NO_WINDOW);
                    cmd.stdout(std::process::Stdio::piped());
                    cmd.stderr(std::process::Stdio::piped());
                    let output = cmd
                        .output()
                        .await
                        .map_err(|e| format!("Failed to run gh pr view: {}", e))?;
                    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    stdout == "MERGED"
                }
                other => {
                    return Err(format!("Unknown wait_for value: '{}'", other));
                }
            };

            if ready {
                return Ok(Some(serde_json::json!({
                    "condition_met": true,
                    "wait_for": gh_wait.wait_for,
                    "pr": rendered_pr,
                })));
            }

            tokio::time::sleep(std::time::Duration::from_secs(poll_interval)).await;
        }
    }

    // ─── GitHub PR Merge Node ───────────────────────────────────────────────

    async fn execute_github_pr_merge(
        &self,
        _node: &NodeDefinition,
        gh_merge: &GitHubPrMergeNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, String> {
        let rendered_pr = TemplateEngine::render(&gh_merge.pr, context)?;
        let cwd = resolve_cwd(context);

        let mut cmd = tokio::process::Command::new("gh");
        cmd.args(["pr", "merge", &rendered_pr]);

        match gh_merge.method.as_deref() {
            Some("squash") => {
                cmd.arg("--squash");
            }
            Some("rebase") => {
                cmd.arg("--rebase");
            }
            Some("merge") | None => {
                cmd.arg("--merge");
            }
            Some(other) => {
                return Err(format!("Unknown merge method: '{}'", other));
            }
        }

        if gh_merge.delete_branch.unwrap_or(false) {
            cmd.arg("--delete-branch");
        }

        cmd.current_dir(&cwd);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to run gh pr merge: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("gh pr merge failed: {}", stderr));
        }

        Ok(Some(serde_json::json!({
            "merged": true,
            "pr": rendered_pr,
        })))
    }

    // ─── Wait Node ──────────────────────────────────────────────────────────

    async fn execute_wait(
        &self,
        node: &NodeDefinition,
        wait: &WaitNode,
        context: &serde_json::Value,
        cancel_flag: Arc<AtomicBool>,
    ) -> Result<Option<serde_json::Value>, String> {
        let poll_interval = wait.poll_interval.unwrap_or(10);
        let timeout_secs = node.timeout.unwrap_or(300);
        let start = std::time::Instant::now();

        loop {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err("Wait cancelled".to_string());
            }

            if start.elapsed().as_secs() > timeout_secs {
                // Handle timeout via on_timeout
                match wait.on_timeout.as_deref() {
                    Some("skip") => {
                        return Ok(Some(serde_json::json!({
                            "condition_met": false,
                            "timed_out": true,
                        })));
                    }
                    Some("fail") | None => {
                        return Err(format!("Wait timed out after {}s", timeout_secs));
                    }
                    Some(target_node) => {
                        return Ok(Some(serde_json::json!({
                            "condition_met": false,
                            "timed_out": true,
                            "next": target_node,
                        })));
                    }
                }
            }

            let condition_met = if let Some(ref condition) = wait.poll_condition {
                TemplateEngine::eval_bool(condition, context)?
            } else if let Some(ref poll_command) = wait.poll_command {
                let rendered_cmd = TemplateEngine::render(poll_command, context)?;
                let cwd = resolve_cwd(context);

                let mut cmd =
                    tokio::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" });
                if cfg!(windows) {
                    cmd.args(["/C", &rendered_cmd]);
                } else {
                    cmd.args(["-c", &rendered_cmd]);
                }
                cmd.current_dir(&cwd);
                #[cfg(windows)]
                cmd.creation_flags(CREATE_NO_WINDOW);
                cmd.stdout(std::process::Stdio::piped());
                cmd.stderr(std::process::Stdio::piped());

                let output = cmd
                    .output()
                    .await
                    .map_err(|e| format!("Poll command failed: {}", e))?;
                output.status.success()
            } else {
                return Err("Wait node must have either 'condition' or 'poll_command'".to_string());
            };

            if condition_met {
                return Ok(Some(serde_json::json!({
                    "condition_met": true,
                })));
            }

            tokio::time::sleep(std::time::Duration::from_secs(poll_interval)).await;
        }
    }

    // ─── File Node ──────────────────────────────────────────────────────────

    async fn execute_file(
        &self,
        _node: &NodeDefinition,
        file_node: &FileNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, String> {
        match file_node.operation.as_str() {
            "read" => {
                let path = file_node.path.as_ref().ok_or("File read requires 'path'")?;
                let rendered_path = TemplateEngine::render(path, context)?;
                let content = tokio::fs::read_to_string(&rendered_path)
                    .await
                    .map_err(|e| format!("Failed to read file '{}': {}", rendered_path, e))?;
                Ok(Some(serde_json::json!({
                    "content": content,
                    "path": rendered_path,
                })))
            }
            "write" => {
                let path = file_node
                    .path
                    .as_ref()
                    .ok_or("File write requires 'path'")?;
                let rendered_path = TemplateEngine::render(path, context)?;
                let content = file_node
                    .content
                    .as_ref()
                    .ok_or("File write requires 'content'")?;
                let rendered_content = TemplateEngine::render(content, context)?;

                // Ensure parent directory exists
                if let Some(parent) = std::path::Path::new(&rendered_path).parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|e| format!("Failed to create parent directory: {}", e))?;
                }

                tokio::fs::write(&rendered_path, &rendered_content)
                    .await
                    .map_err(|e| format!("Failed to write file '{}': {}", rendered_path, e))?;
                Ok(Some(serde_json::json!({
                    "written": true,
                    "path": rendered_path,
                    "bytes": rendered_content.len(),
                })))
            }
            "append" => {
                let path = file_node
                    .path
                    .as_ref()
                    .ok_or("File append requires 'path'")?;
                let rendered_path = TemplateEngine::render(path, context)?;
                let content = file_node
                    .content
                    .as_ref()
                    .ok_or("File append requires 'content'")?;
                let rendered_content = TemplateEngine::render(content, context)?;

                use tokio::io::AsyncWriteExt;
                let mut file = tokio::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&rendered_path)
                    .await
                    .map_err(|e| format!("Failed to open file '{}': {}", rendered_path, e))?;
                file.write_all(rendered_content.as_bytes())
                    .await
                    .map_err(|e| format!("Failed to append to file '{}': {}", rendered_path, e))?;
                Ok(Some(serde_json::json!({
                    "appended": true,
                    "path": rendered_path,
                    "bytes": rendered_content.len(),
                })))
            }
            "copy" => {
                let source = file_node
                    .source
                    .as_ref()
                    .ok_or("File copy requires 'source'")?;
                let destination = file_node
                    .destination
                    .as_ref()
                    .ok_or("File copy requires 'destination'")?;
                let rendered_source = TemplateEngine::render(source, context)?;
                let rendered_dest = TemplateEngine::render(destination, context)?;

                // Ensure parent directory of destination exists
                if let Some(parent) = std::path::Path::new(&rendered_dest).parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|e| format!("Failed to create parent directory: {}", e))?;
                }

                tokio::fs::copy(&rendered_source, &rendered_dest)
                    .await
                    .map_err(|e| {
                        format!(
                            "Failed to copy '{}' to '{}': {}",
                            rendered_source, rendered_dest, e
                        )
                    })?;
                Ok(Some(serde_json::json!({
                    "copied": true,
                    "source": rendered_source,
                    "destination": rendered_dest,
                })))
            }
            other => Err(format!("Unknown file operation: '{}'", other)),
        }
    }

    // ─── HTTP Node ──────────────────────────────────────────────────────────

    async fn execute_http(
        &self,
        node: &NodeDefinition,
        http_node: &HttpNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, String> {
        let rendered_url = TemplateEngine::render(&http_node.url, context)?;
        let method_str = http_node.method.as_deref().unwrap_or("GET").to_uppercase();
        let timeout_secs = node.timeout.unwrap_or(60);

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(timeout_secs))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        let method = method_str
            .parse::<reqwest::Method>()
            .map_err(|e| format!("Invalid HTTP method '{}': {}", method_str, e))?;

        let mut request = client.request(method, &rendered_url);

        // Add headers
        if let Some(ref headers) = http_node.headers {
            for (key, value) in headers {
                let rendered_value = TemplateEngine::render(value, context)?;
                request = request.header(key.as_str(), rendered_value);
            }
        }

        // Add body
        if let Some(ref body) = http_node.body {
            let rendered_body = TemplateEngine::render(body, context)?;
            request = request.body(rendered_body);
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("HTTP request to '{}' failed: {}", rendered_url, e))?;

        let status = response.status().as_u16();

        // Check expected status
        if let Some(ref expected) = http_node.expected_status {
            if !expected.contains(&status) {
                return Err(format!(
                    "HTTP request returned status {} (expected one of {:?})",
                    status, expected
                ));
            }
        }

        // Collect response headers
        let resp_headers: HashMap<String, String> = response
            .headers()
            .iter()
            .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();

        let resp_body = response
            .text()
            .await
            .map_err(|e| format!("Failed to read HTTP response body: {}", e))?;

        Ok(Some(serde_json::json!({
            "status": status,
            "body": resp_body,
            "headers": resp_headers,
        })))
    }

    // ─── Loop Node ──────────────────────────────────────────────────────────

    async fn execute_loop(
        &self,
        _node: &NodeDefinition,
        loop_node: &LoopNode,
        context: &serde_json::Value,
        execution_id: &str,
        cancel_flag: Arc<AtomicBool>,
    ) -> Result<Option<serde_json::Value>, String> {
        let max_iterations = loop_node.max_iterations.unwrap_or(100);
        let mut iteration: u32 = 0;
        let mut node_outputs: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();

        loop {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err("Loop cancelled".to_string());
            }

            if iteration >= max_iterations {
                match loop_node.on_max_iterations.as_deref() {
                    Some("fail") => {
                        return Err(format!("Loop reached max iterations ({})", max_iterations));
                    }
                    _ => {
                        // Default: complete with partial result
                        return Ok(Some(serde_json::json!({
                            "iterations": iteration,
                            "completed": false,
                            "reason": "max_iterations_reached",
                        })));
                    }
                }
            }

            // Build context with enhanced loop variables
            let mut loop_ctx = match context.clone() {
                serde_json::Value::Object(m) => m,
                _ => serde_json::Map::new(),
            };
            let iterations_left = max_iterations.saturating_sub(iteration + 1);
            loop_ctx.insert(
                "loop".to_string(),
                serde_json::json!({
                    "index": iteration,
                    "iteration": iteration + 1,
                    "iterations_left": iterations_left,
                    "total": max_iterations,
                    "first": iteration == 0,
                    "last": iteration + 1 >= max_iterations,
                    // Per-node outputs from previous iterations
                    "nodes": node_outputs.clone(),
                }),
            );
            let mut iter_context = serde_json::Value::Object(loop_ctx);

            // Execute all nodes in the loop body sequentially
            let mut should_break = false;
            let mut should_continue = false;

            for inner_node in &loop_node.nodes {
                let output = self
                    .execute_node(inner_node, &iter_context, execution_id, cancel_flag.clone())
                    .await?;

                // Store per-node output for `until` condition and next iterations
                if let Some(ref out) = output {
                    node_outputs.insert(inner_node.id.clone(), out.clone());

                    // Update the iter_context so subsequent nodes in same iteration can see it
                    if let serde_json::Value::Object(ref mut ctx_map) = iter_context {
                        if let Some(serde_json::Value::Object(ref mut loop_obj)) =
                            ctx_map.get_mut("loop")
                        {
                            if let Some(serde_json::Value::Object(ref mut nodes_obj)) =
                                loop_obj.get_mut("nodes")
                            {
                                nodes_obj.insert(inner_node.id.clone(), out.clone());
                            }
                        }
                    }

                    // Check for _break signal
                    if out.get("_break").and_then(|v| v.as_bool()).unwrap_or(false) {
                        should_break = true;
                        break;
                    }
                    // Check for _continue signal
                    if out
                        .get("_continue")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                    {
                        should_continue = true;
                        break;
                    }
                }
            }

            iteration += 1;

            if should_break {
                // Exit loop; use on_break target if specified
                let mut result = serde_json::json!({
                    "iterations": iteration,
                    "completed": true,
                    "reason": "break",
                });
                if let Some(ref on_break) = loop_node.on_break {
                    result.as_object_mut().unwrap().insert(
                        "next".to_string(),
                        serde_json::Value::String(on_break.clone()),
                    );
                }
                return Ok(Some(result));
            }

            if should_continue {
                // Skip the rest, proceed to next iteration (delay still applies)
                if let Some(ref delay_str) = loop_node.delay {
                    let rendered_delay = TemplateEngine::render(delay_str, &iter_context)?;
                    let secs = parse_duration_to_secs(&rendered_delay)?;
                    tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
                }
                continue;
            }

            // Check `until` condition after each iteration
            if let Some(ref until_expr) = loop_node.until {
                if TemplateEngine::eval_bool(until_expr, &iter_context)? {
                    return Ok(Some(serde_json::json!({
                        "iterations": iteration,
                        "completed": true,
                    })));
                }
            }

            // Delay between iterations
            if let Some(ref delay_str) = loop_node.delay {
                let rendered_delay = TemplateEngine::render(delay_str, &iter_context)?;
                let secs = parse_duration_to_secs(&rendered_delay)?;
                tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
            }
        }
    }

    // ─── Parallel Node ──────────────────────────────────────────────────────

    async fn execute_parallel(
        &self,
        _node: &NodeDefinition,
        parallel: &ParallelNode,
        context: &serde_json::Value,
        execution_id: &str,
        cancel_flag: Arc<AtomicBool>,
    ) -> Result<Option<serde_json::Value>, String> {
        // Parse wait strategy: string for named strategies, number for count-based
        let (wait_strategy, wait_count) = match &parallel.wait {
            Some(serde_json::Value::String(s)) => (s.as_str().to_string(), None),
            Some(serde_json::Value::Number(n)) => {
                let count = n.as_u64().unwrap_or(0) as usize;
                ("count".to_string(), Some(count))
            }
            _ => ("all".to_string(), None),
        };
        let context = context.clone();
        let execution_id = execution_id.to_string();

        // Collect branch info to spawn tasks
        let mut handles: Vec<(
            String,
            tokio::task::JoinHandle<Result<Option<serde_json::Value>, String>>,
        )> = Vec::new();

        for (branch_index, (branch_name, branch_nodes)) in parallel.branches.iter().enumerate() {
            let branch_name = branch_name.clone();
            let branch_nodes = branch_nodes.clone();
            let ctx = context.clone();
            let exec_id = execution_id.clone();
            let flag = cancel_flag.clone();
            let app = self.app.clone();
            let sidecar = self.sidecar.clone();
            let rl = self.rate_limiter.clone();
            let stagger = SequenceRateLimiter::stagger_delay_ms(branch_index);

            let handle = tokio::spawn(async move {
                // Stagger parallel branch starts to avoid thundering herd
                if stagger > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(stagger)).await;
                }
                let executor = SequenceExecutor::new(app, sidecar, rl);
                let mut last_output: Option<serde_json::Value> = None;
                for inner_node in &branch_nodes {
                    last_output = executor
                        .execute_node(inner_node, &ctx, &exec_id, flag.clone())
                        .await?;
                }
                Ok(last_output)
            });

            handles.push((branch_name, handle));
        }

        match wait_strategy.as_str() {
            "first" => {
                // Return when the first branch completes (success or failure)
                let mut branches_output = serde_json::Map::new();
                let mut found: Option<(String, Result<Option<serde_json::Value>, String>)> = None;
                while found.is_none() {
                    for i in 0..handles.len() {
                        if handles[i].1.is_finished() {
                            let (name, handle) = handles.remove(i);
                            let result = handle
                                .await
                                .map_err(|e| format!("Task join error: {}", e))?;
                            found = Some((name, result));
                            break;
                        }
                    }
                    if found.is_none() {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                }
                let (first_name, first_result) = found.unwrap();
                match first_result {
                    Ok(output) => {
                        branches_output
                            .insert(first_name, output.unwrap_or(serde_json::Value::Null));
                    }
                    Err(e) => {
                        branches_output.insert(first_name, serde_json::json!({ "error": e }));
                    }
                }
                Ok(Some(serde_json::json!({
                    "branches": branches_output,
                    "strategy": "first",
                })))
            }
            "any" => {
                // Return when any branch succeeds
                let mut branches_output = serde_json::Map::new();
                let mut remaining = handles;
                loop {
                    if remaining.is_empty() {
                        return Err("All parallel branches failed".to_string());
                    }
                    for i in 0..remaining.len() {
                        if remaining[i].1.is_finished() {
                            let (name, handle) = remaining.remove(i);
                            let result = handle
                                .await
                                .map_err(|e| format!("Task join error: {}", e))?;
                            match result {
                                Ok(output) => {
                                    branches_output
                                        .insert(name, output.unwrap_or(serde_json::Value::Null));
                                    return Ok(Some(serde_json::json!({
                                        "branches": branches_output,
                                        "strategy": "any",
                                    })));
                                }
                                Err(e) => {
                                    branches_output.insert(name, serde_json::json!({ "error": e }));
                                }
                            }
                            break; // restart loop since we modified the vec
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
            "count" => {
                // Wait for N branches to complete, then return
                let target_count = wait_count.unwrap_or(1);
                let mut branches_output = serde_json::Map::new();
                let mut remaining = handles;
                let mut completed = 0usize;

                loop {
                    if completed >= target_count || remaining.is_empty() {
                        break;
                    }
                    for i in 0..remaining.len() {
                        if remaining[i].1.is_finished() {
                            let (name, handle) = remaining.remove(i);
                            let result = handle
                                .await
                                .map_err(|e| format!("Task join error: {}", e))?;
                            match result {
                                Ok(output) => {
                                    branches_output
                                        .insert(name, output.unwrap_or(serde_json::Value::Null));
                                    completed += 1;
                                }
                                Err(e) => match parallel.on_branch_error.as_deref() {
                                    Some("ignore") | Some("skip") => {
                                        branches_output
                                            .insert(name, serde_json::json!({ "error": e }));
                                    }
                                    Some("cancel_others") => {
                                        cancel_flag.store(true, Ordering::Relaxed);
                                        return Err(e);
                                    }
                                    _ => return Err(e),
                                },
                            }
                            break;
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }

                Ok(Some(serde_json::json!({
                    "branches": branches_output,
                    "strategy": "count",
                    "completed": completed,
                    "target": target_count,
                })))
            }
            _ => {
                // "all" (default): wait for all branches
                let mut branches_output = serde_json::Map::new();
                let mut had_error = false;
                for (branch_name, handle) in handles {
                    let result = handle
                        .await
                        .map_err(|e| format!("Task join error: {}", e))?;
                    match result {
                        Ok(output) => {
                            branches_output
                                .insert(branch_name, output.unwrap_or(serde_json::Value::Null));
                        }
                        Err(e) => {
                            had_error = true;
                            match parallel.on_branch_error.as_deref() {
                                Some("cancel_others") => {
                                    cancel_flag.store(true, Ordering::Relaxed);
                                    return Err(format!("Branch '{}' failed: {}", branch_name, e));
                                }
                                _ => {
                                    branches_output
                                        .insert(branch_name, serde_json::json!({ "error": e }));
                                }
                            }
                        }
                    }
                }
                if had_error {
                    match parallel.on_branch_error.as_deref() {
                        Some("ignore") | Some("skip") | Some("cancel_others") => { /* continue */ }
                        _ => {
                            return Err(format!(
                                "One or more parallel branches failed: {:?}",
                                branches_output
                            ));
                        }
                    }
                }
                Ok(Some(serde_json::json!({
                    "branches": branches_output,
                    "strategy": "all",
                })))
            }
        }
    }

    // ─── ForEach Node ───────────────────────────────────────────────────────

    async fn execute_foreach(
        &self,
        _node: &NodeDefinition,
        foreach: &ForEachNode,
        context: &serde_json::Value,
        execution_id: &str,
        cancel_flag: Arc<AtomicBool>,
    ) -> Result<Option<serde_json::Value>, String> {
        // Resolve items from context: render the template expression then parse as JSON array
        let rendered_items = TemplateEngine::render(&foreach.items, context)?;
        let items: Vec<serde_json::Value> = serde_json::from_str(&rendered_items)
            .map_err(|e| format!("ForEach items must be a JSON array: {}", e))?;

        let variable = foreach.variable.as_deref().unwrap_or("item");
        let mode = foreach.mode.as_deref().unwrap_or("sequential");
        let total = items.len();
        let mut results: Vec<serde_json::Value> = Vec::new();
        let mut items_failed: usize = 0;

        if mode == "parallel" {
            // Parallel execution
            let mut handles: Vec<
                tokio::task::JoinHandle<Result<Option<serde_json::Value>, String>>,
            > = Vec::new();

            for (index, item) in items.iter().enumerate() {
                let mut iter_ctx = match context.clone() {
                    serde_json::Value::Object(m) => m,
                    _ => serde_json::Map::new(),
                };
                iter_ctx.insert(variable.to_string(), item.clone());
                iter_ctx.insert(
                    "loop".to_string(),
                    serde_json::json!({
                        "index": index,
                        "iteration": index + 1,
                        "item": item,
                        "total": total,
                        "first": index == 0,
                        "last": index == total - 1,
                    }),
                );
                let iter_context = serde_json::Value::Object(iter_ctx);

                let nodes = foreach.nodes.clone();
                let exec_id = execution_id.to_string();
                let flag = cancel_flag.clone();
                let app = self.app.clone();
                let sidecar = self.sidecar.clone();
                let rl = self.rate_limiter.clone();

                let handle = tokio::spawn(async move {
                    let executor = SequenceExecutor::new(app, sidecar, rl);
                    let mut last_output: Option<serde_json::Value> = None;
                    for inner_node in &nodes {
                        last_output = executor
                            .execute_node(inner_node, &iter_context, &exec_id, flag.clone())
                            .await?;
                    }
                    Ok(last_output)
                });

                handles.push(handle);
            }

            for handle in handles {
                let result = handle
                    .await
                    .map_err(|e| format!("Task join error: {}", e))?;
                match result {
                    Ok(output) => {
                        results.push(output.unwrap_or(serde_json::Value::Null));
                    }
                    Err(e) => match foreach.on_item_error.as_deref() {
                        Some("skip") | Some("ignore") | Some("continue") => {
                            items_failed += 1;
                            results.push(serde_json::json!({ "error": e }));
                        }
                        _ => return Err(e),
                    },
                }
            }
        } else {
            // Sequential execution (default)
            for (index, item) in items.iter().enumerate() {
                if cancel_flag.load(Ordering::Relaxed) {
                    return Err("ForEach cancelled".to_string());
                }

                let mut iter_ctx = match context.clone() {
                    serde_json::Value::Object(m) => m,
                    _ => serde_json::Map::new(),
                };
                iter_ctx.insert(variable.to_string(), item.clone());
                iter_ctx.insert(
                    "loop".to_string(),
                    serde_json::json!({
                        "index": index,
                        "iteration": index + 1,
                        "item": item,
                        "total": total,
                        "first": index == 0,
                        "last": index == total - 1,
                    }),
                );
                let iter_context = serde_json::Value::Object(iter_ctx);

                let mut last_output: Option<serde_json::Value> = None;
                for inner_node in &foreach.nodes {
                    match self
                        .execute_node(inner_node, &iter_context, execution_id, cancel_flag.clone())
                        .await
                    {
                        Ok(output) => {
                            last_output = output;
                        }
                        Err(e) => match foreach.on_item_error.as_deref() {
                            Some("skip") | Some("ignore") | Some("continue") => {
                                items_failed += 1;
                                last_output = Some(serde_json::json!({ "error": e }));
                                break; // break inner node loop, continue to next item
                            }
                            _ => return Err(e),
                        },
                    }
                }
                results.push(last_output.unwrap_or(serde_json::Value::Null));
            }
        }

        let items_succeeded = results.len() - items_failed;

        Ok(Some(serde_json::json!({
            "items_processed": results.len(),
            "items_succeeded": items_succeeded,
            "items_failed": items_failed,
            "results": results,
        })))
    }

    // ─── SubSequence Node ───────────────────────────────────────────────────

    async fn execute_subsequence(
        &self,
        _node: &NodeDefinition,
        sub: &SubSequenceNode,
        context: &serde_json::Value,
        _execution_id: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        // Load the referenced sequence definition
        let definitions = persistence::load_definitions()?;
        let rendered_seq_id = TemplateEngine::render(&sub.sequence, context)?;
        let sub_def = definitions
            .into_iter()
            .find(|d| d.id == rendered_seq_id)
            .ok_or_else(|| format!("SubSequence '{}' not found", rendered_seq_id))?;

        // Merge inputs: start with current context inputs, overlay sub-sequence inputs
        let mut sub_inputs: HashMap<String, serde_json::Value> = HashMap::new();

        if let Some(ref input_map) = sub.inputs {
            for (key, value) in input_map {
                // Template-render string values
                let resolved = if let Some(s) = value.as_str() {
                    let rendered = TemplateEngine::render(s, context)?;
                    // Try to parse as JSON, fall back to string
                    serde_json::from_str(&rendered)
                        .unwrap_or_else(|_| serde_json::Value::String(rendered))
                } else {
                    value.clone()
                };
                sub_inputs.insert(key.clone(), resolved);
            }
        }

        // Create a new executor and run inline
        let sub_executor = SequenceExecutor::new(
            self.app.clone(),
            self.sidecar.clone(),
            self.rate_limiter.clone(),
        );
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let pause_signal = Arc::new(Notify::new());
        let sub_exec_id = uuid::Uuid::new_v4().to_string();

        let exec_id = sub_executor
            .execute(
                sub_exec_id,
                sub_def,
                sub_inputs,
                false,
                cancel_flag,
                pause_signal,
                None,
            )
            .await?;

        // Load the completed execution to extract outputs
        let execution = persistence::load_execution(&exec_id)?;

        // Collect outputs from the sub-sequence
        let output = serde_json::json!({
            "execution_id": exec_id,
            "status": serde_json::to_value(&execution.status).unwrap_or_default(),
            "total_cost": execution.total_cost,
        });

        Ok(Some(output))
    }

    // ─── AI Logging Helpers ────────────────────────────────────────────────

    /// Push a log entry for an AI node execution. These are accumulated during
    /// node execution and drained in the main loop for persistence + emission.
    fn push_ai_log(&self, node_id: &str, level: LogLevel, message: String) {
        self.ai_logs.lock().push(AiNodeLog {
            node_id: node_id.to_string(),
            level,
            message,
        });
    }

    /// Store captured token usage for a node (from sdk-usage events).
    fn store_ai_usage(&self, node_id: &str, tokens: TokenUsage, cost: f64) {
        self.ai_usage
            .lock()
            .insert(node_id.to_string(), AiNodeUsage { tokens, cost });
    }

    /// Drain accumulated AI logs, add them to the execution state, and emit
    /// as `sequence-log-{exec_id}` events to the frontend.
    fn drain_ai_logs(&self, exec_id: &str, execution: &Arc<Mutex<SequenceExecution>>) {
        let logs: Vec<AiNodeLog> = self.ai_logs.lock().drain(..).collect();
        for log in logs {
            let entry = LogEntry {
                timestamp: Utc::now(),
                node_id: Some(log.node_id),
                level: log.level,
                message: log.message,
            };
            // Emit to frontend
            let _ = self.app.emit(
                &format!("sequence-log-{}", exec_id),
                serde_json::json!({ "entry": entry }),
            );
            // Persist in execution state
            execution.lock().log.push(entry);
        }
    }

    /// Drain captured AI usage for a node, returning tokens and cost if present.
    fn drain_ai_usage(&self, node_id: &str) -> Option<(TokenUsage, f64)> {
        self.ai_usage
            .lock()
            .remove(node_id)
            .map(|u| (u.tokens, u.cost))
    }

    /// Truncate a string for log display, appending "..." if truncated.
    fn truncate_for_log(s: &str, max_len: usize) -> String {
        if s.len() <= max_len {
            s.to_string()
        } else {
            format!("{}...", &s[..max_len])
        }
    }

    // ─── Event Emission Helpers ──────────────────────────────────────────────

    fn emit_status(&self, exec_id: &str, status: &ExecutionStatus) {
        log::info!("[sequence][{}] emit status: {:?}", &exec_id[..8], status);
        let _ = self.app.emit(
            &format!("sequence-status-{}", exec_id),
            serde_json::to_value(status).unwrap_or_default(),
        );
    }

    fn emit_node_start(&self, exec_id: &str, node: &NodeDefinition) {
        log::info!(
            "[sequence][{}] emit node-start: {} ({:?})",
            &exec_id[..8],
            node.id,
            node.name
        );
        let _ = self.app.emit(
            &format!("sequence-node-start-{}", exec_id),
            serde_json::json!({
                "node_id": node.id,
                "node_name": node.name,
                "node_type": format!("{:?}", std::mem::discriminant(&node.node_type)),
            }),
        );
    }

    fn emit_node_complete(
        &self,
        exec_id: &str,
        node_id: &str,
        duration_ms: u64,
        cost: Option<f64>,
    ) {
        log::info!(
            "[sequence][{}] emit node-complete: {}",
            &exec_id[..8],
            node_id
        );
        let _ = self.app.emit(
            &format!("sequence-node-complete-{}", exec_id),
            serde_json::json!({
                "node_id": node_id,
                "duration_ms": duration_ms,
                "cost": cost,
            }),
        );
    }

    fn emit_node_error(&self, exec_id: &str, node_id: &str, error: &str) {
        log::info!(
            "[sequence][{}] emit node-error: {} — {}",
            &exec_id[..8],
            node_id,
            error
        );
        let _ = self.app.emit(
            &format!("sequence-node-error-{}", exec_id),
            serde_json::json!({
                "node_id": node_id,
                "error": error,
            }),
        );
    }

    fn emit_done(&self, exec_id: &str, status: &ExecutionStatus) {
        log::info!("[sequence][{}] emit done: {:?}", &exec_id[..8], status);
        let _ = self.app.emit(
            &format!("sequence-done-{}", exec_id),
            serde_json::to_value(status).unwrap_or_default(),
        );
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Resolve repository paths from a list that may contain `tagged:X` syntax.
///
/// - Plain paths are returned as-is
/// - `tagged:X` entries are expanded to all repo paths whose `tags` contain `X`
#[allow(dead_code)]
fn resolve_repos(repo_specs: &[String], app: &AppHandle) -> Vec<String> {
    let config: Option<tauri::State<parking_lot::Mutex<AppConfig>>> = app.try_state();
    let cfg = match config {
        Some(ref c) => c.lock(),
        None => return repo_specs.to_vec(),
    };

    let mut resolved = Vec::new();
    for spec in repo_specs {
        if let Some(tag) = spec.strip_prefix("tagged:") {
            let tag_lower = tag.to_lowercase();
            for repo in &cfg.repos {
                if repo.tags.iter().any(|t| t.to_lowercase() == tag_lower) {
                    resolved.push(repo.path.clone());
                }
            }
        } else {
            resolved.push(spec.clone());
        }
    }
    resolved
}

/// Resolve the working directory from context (repo.path) or fall back to cwd.
fn resolve_cwd(context: &serde_json::Value) -> String {
    context
        .get("repo")
        .and_then(|r| r.get("path"))
        .and_then(|p| p.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        })
}

/// Create an LLM client from the app's managed config state.
///
/// Reuses the same pattern as `sequence_cmds::create_llm_client()`.
fn create_llm_client_from_app(app: &AppHandle) -> Result<LlmClient, String> {
    use crate::config::LlmProvider;
    use tauri_plugin_keyring::KeyringExt;

    const KEYRING_SERVICE: &str = "claude-whisperer";
    const KEYRING_LLM_KEY: &str = "llm-api-key";

    let config: tauri::State<parking_lot::Mutex<AppConfig>> = app
        .try_state()
        .ok_or_else(|| "App config not available".to_string())?;
    let cfg = config.lock();
    let llm_config = &cfg.llm;

    let api_key = if matches!(llm_config.provider, LlmProvider::Local) {
        app.keyring()
            .get_password(KEYRING_SERVICE, KEYRING_LLM_KEY)
            .ok()
            .flatten()
            .unwrap_or_default()
    } else {
        match app.keyring().get_password(KEYRING_SERVICE, KEYRING_LLM_KEY) {
            Ok(Some(key)) => key,
            Ok(None) => {
                return Err("LLM API key not set. Configure it in Settings → LLM.".to_string())
            }
            Err(e) => return Err(format!("Failed to get LLM API key: {}", e)),
        }
    };

    Ok(LlmClient::new(
        api_key,
        llm_config.model.clone(),
        llm_config.provider.clone(),
        llm_config.endpoint.clone(),
        llm_config.auto_model,
        llm_config.model_priority.clone(),
    ))
}

/// Parse a human-friendly duration string into seconds.
///
/// Supported formats: `"5s"`, `"30s"`, `"1m"`, `"2m30s"`, `"1h"`, `"1h30m"`,
/// `"90"` (plain number = seconds).
fn parse_duration_to_secs(s: &str) -> Result<u64, String> {
    let s = s.trim();

    // Plain numeric
    if let Ok(n) = s.parse::<u64>() {
        return Ok(n);
    }

    let mut total: u64 = 0;
    let mut current_num = String::new();

    for ch in s.chars() {
        if ch.is_ascii_digit() {
            current_num.push(ch);
        } else {
            let n: u64 = current_num
                .parse()
                .map_err(|_| format!("Invalid duration: '{}'", s))?;
            current_num.clear();
            match ch {
                'h' | 'H' => total += n * 3600,
                'm' | 'M' => total += n * 60,
                's' | 'S' => total += n,
                _ => return Err(format!("Unknown duration unit '{}' in '{}'", ch, s)),
            }
        }
    }

    // Trailing number without unit treated as seconds
    if !current_num.is_empty() {
        let n: u64 = current_num
            .parse()
            .map_err(|_| format!("Invalid duration: '{}'", s))?;
        total += n;
    }

    if total == 0 && s != "0s" && s != "0" {
        return Err(format!("Could not parse duration from '{}'", s));
    }

    Ok(total)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_duration_seconds() {
        assert_eq!(parse_duration_to_secs("5s").unwrap(), 5);
        assert_eq!(parse_duration_to_secs("30s").unwrap(), 30);
        assert_eq!(parse_duration_to_secs("0s").unwrap(), 0);
    }

    #[test]
    fn test_parse_duration_minutes() {
        assert_eq!(parse_duration_to_secs("1m").unwrap(), 60);
        assert_eq!(parse_duration_to_secs("5m").unwrap(), 300);
    }

    #[test]
    fn test_parse_duration_hours() {
        assert_eq!(parse_duration_to_secs("1h").unwrap(), 3600);
        assert_eq!(parse_duration_to_secs("2h").unwrap(), 7200);
    }

    #[test]
    fn test_parse_duration_combined() {
        assert_eq!(parse_duration_to_secs("1h30m").unwrap(), 5400);
        assert_eq!(parse_duration_to_secs("2m30s").unwrap(), 150);
        assert_eq!(parse_duration_to_secs("1h2m3s").unwrap(), 3723);
    }

    #[test]
    fn test_parse_duration_plain_number() {
        assert_eq!(parse_duration_to_secs("90").unwrap(), 90);
        assert_eq!(parse_duration_to_secs("0").unwrap(), 0);
    }

    #[test]
    fn test_parse_duration_invalid() {
        assert!(parse_duration_to_secs("abc").is_err());
        assert!(parse_duration_to_secs("5x").is_err());
    }
}
