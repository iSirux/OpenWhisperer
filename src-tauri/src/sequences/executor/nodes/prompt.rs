//! Prompt and route (evaluation + AI classification) node executors.

use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{AppHandle, EventId, Listener};

use crate::sequences::error::SequenceError;
use crate::sequences::executor::{create_llm_client_from_app, eval_string, render, resolve_cwd, SequenceExecutor};
use crate::sequences::state::{LogLevel, TokenUsage};
use crate::sequences::types::{NodeDefinition, PromptNode, RouteBranch, RouteNode};
use crate::sidecar::OutboundMessage;

/// RAII guard that unregisters Tauri event listeners on drop (finding S3).
///
/// `execute_prompt` registers 5 `app.listen(...)` handlers per prompt node.
/// Dropping the returned `EventId` does **not** unregister the listener, so the
/// previous code permanently leaked 5 handlers (and their captured `Arc`s) on
/// every prompt node — looping sequences compounded this without bound.
struct SdkSessionListeners {
    app: AppHandle,
    ids: Vec<EventId>,
}

impl SdkSessionListeners {
    fn new(app: AppHandle) -> Self {
        Self { app, ids: Vec::new() }
    }

    fn push(&mut self, id: EventId) {
        self.ids.push(id);
    }
}

impl Drop for SdkSessionListeners {
    fn drop(&mut self) {
        for id in self.ids.drain(..) {
            self.app.unlisten(id);
        }
    }
}

impl SequenceExecutor {
    // ─── Prompt Node ─────────────────────────────────────────────────────────

    pub(crate) async fn execute_prompt(
        &self,
        node: &NodeDefinition,
        prompt_node: &PromptNode,
        context: &serde_json::Value,
        execution_id: &str,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
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
        let _permit = self
            .rate_limiter
            .acquire_prompt_permit()
            .await
            .map_err(SequenceError::other)?;
        self.rate_limiter.record_request(provider);

        // 1. Ensure sidecar is started
        if !self.sidecar.is_started() {
            self.sidecar
                .start(self.app.clone())
                .map_err(|e| SequenceError::command(format!("Failed to start sidecar: {}", e)))?;
        }

        // 2. Render prompt template
        let rendered_prompt = render(&prompt_node.prompt, context)?;

        // 3. Determine model/effort/timeout, falling back to sequence defaults (S10)
        let (default_model, default_effort, default_timeout) = {
            let d = self.shared.defaults.lock();
            (d.model.clone(), d.effort.clone(), d.timeout)
        };
        let model = prompt_node.model.clone().or(default_model);
        let effort = prompt_node.effort.clone().or(default_effort);

        {
            let model_label = model.as_deref().unwrap_or("default");
            let effort_label = effort.as_deref().unwrap_or("default");
            let prompt_preview = crate::util::truncate_chars(&rendered_prompt, 200);
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
        let cwd = resolve_cwd(context);

        let system_prompt = match &prompt_node.system_prompt {
            Some(sp) => Some(render(sp, context)?),
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
            .map_err(|e| SequenceError::command(format!("Sidecar send error: {}", e)))?;

        // All SDK listeners registered below are unregistered on drop of this guard.
        let mut listeners = SdkSessionListeners::new(self.app.clone());

        // Wait for Created event via oneshot channel
        let (created_tx, created_rx) = tokio::sync::oneshot::channel::<()>();
        let created_tx = Arc::new(Mutex::new(Some(created_tx)));
        let created_event = format!("sdk-created-{}", session_id);
        listeners.push(self.app.listen(created_event, move |_event| {
            if let Some(tx) = created_tx.lock().take() {
                let _ = tx.send(());
            }
        }));

        tokio::time::timeout(std::time::Duration::from_secs(30), created_rx)
            .await
            .map_err(|_| SequenceError::timeout("Timeout waiting for session creation"))?
            .map_err(|_| SequenceError::other("Session creation channel dropped"))?;

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
            .map_err(|e| SequenceError::command(format!("Query send error: {}", e)))?;

        // 7. Accumulate text and wait for done/error
        let accumulated_text = Arc::new(Mutex::new(String::new()));
        let text_acc = accumulated_text.clone();
        let text_event = format!("sdk-text-{}", session_id);
        listeners.push(self.app.listen(text_event, move |event| {
            if let Ok(s) = serde_json::from_str::<String>(event.payload()) {
                text_acc.lock().push_str(&s);
            }
        }));

        let usage_data: Arc<Mutex<Option<(TokenUsage, f64, u64, u64)>>> = Arc::new(Mutex::new(None));
        let usage_capture = usage_data.clone();
        let usage_event = format!("sdk-usage-{}", session_id);
        listeners.push(self.app.listen(usage_event, move |event| {
            if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                let tokens = TokenUsage {
                    input_tokens: payload.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0),
                    output_tokens: payload.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0),
                    cache_read: payload.get("cacheReadTokens").and_then(|v| v.as_u64()).unwrap_or(0),
                    cache_creation: payload
                        .get("cacheCreationTokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                };
                let cost = payload.get("totalCostUsd").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let duration_ms = payload.get("durationMs").and_then(|v| v.as_u64()).unwrap_or(0);
                let num_turns = payload.get("numTurns").and_then(|v| v.as_u64()).unwrap_or(0);
                *usage_capture.lock() = Some((tokens, cost, duration_ms, num_turns));
            }
        }));

        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let done_tx = Arc::new(Mutex::new(Some(done_tx)));

        let done_tx_ok = done_tx.clone();
        let done_event = format!("sdk-done-{}", session_id);
        listeners.push(self.app.listen(done_event, move |_event| {
            if let Some(tx) = done_tx_ok.lock().take() {
                let _ = tx.send(Ok(()));
            }
        }));

        let done_tx_err = done_tx.clone();
        let error_event = format!("sdk-error-{}", session_id);
        listeners.push(self.app.listen(error_event, move |event| {
            let msg = serde_json::from_str::<String>(event.payload())
                .unwrap_or_else(|_| "Unknown error".to_string());
            if let Some(tx) = done_tx_err.lock().take() {
                let _ = tx.send(Err(msg));
            }
        }));

        // Apply timeout (node timeout, else sequence default, else 300s)
        let timeout_secs = node.timeout.or(default_timeout).unwrap_or(300);
        let result = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), done_rx)
            .await
            .map_err(|_| {
                SequenceError::timeout(format!(
                    "Prompt node '{}' timed out after {}s",
                    node.id, timeout_secs
                ))
            })?
            .map_err(|_| SequenceError::other("Done channel dropped"))?;

        // 8. Close session
        let _ = self.sidecar.send(OutboundMessage::Close { id: session_id });

        // 9. Log response and capture usage
        match &result {
            Ok(()) => {
                let text = accumulated_text.lock().clone();
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
                            crate::util::truncate_chars(&text, 200),
                        ),
                    );
                    self.store_ai_usage(&node.id, tokens, cost);
                } else {
                    self.push_ai_log(
                        &node.id,
                        LogLevel::Info,
                        format!("AI responded (no usage data): {}", crate::util::truncate_chars(&text, 200)),
                    );
                }
            }
            Err(e) => {
                self.push_ai_log(&node.id, LogLevel::Error, format!("AI prompt failed: {}", e));
            }
        }

        // Return result (listeners guard unregisters on scope exit)
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
            Err(e) => Err(SequenceError::command(e)),
        }
    }

    // ─── Route Node ──────────────────────────────────────────────────────────

    pub(crate) async fn execute_route(
        &self,
        node: &NodeDefinition,
        route: &RouteNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        // Expression-based routing
        if let Some(ref eval_expr) = route.eval {
            let result = eval_string(eval_expr, context)?;
            let branch_key = result.trim().to_string();

            if let Some(branch) = route.branches.get(&branch_key) {
                return Ok(Some(serde_json::json!({
                    "branch": branch_key,
                    "next": branch.target(),
                })));
            } else if let Some(ref default) = route.default {
                return Ok(Some(serde_json::json!({ "branch": "default", "next": default })));
            } else {
                return Err(SequenceError::other(format!(
                    "No matching branch for '{}' and no default",
                    branch_key
                )));
            }
        }

        // AI classification routing via LLM
        if let Some(ref prompt_template) = route.prompt {
            return self.execute_route_ai(node, route, prompt_template, context).await;
        }

        Err(SequenceError::other("Route node must have either 'eval' or 'prompt'"))
    }

    /// AI-based single-select route classification using the configured LLM.
    async fn execute_route_ai(
        &self,
        node: &NodeDefinition,
        route: &RouteNode,
        prompt_template: &str,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        // Build system prompt listing available branches
        let mut branch_descriptions = Vec::new();
        for (key, branch) in &route.branches {
            let desc = match branch {
                RouteBranch::Long { description: Some(d), .. } => format!("- {}: {}", key, d),
                _ => format!("- {}", key),
            };
            branch_descriptions.push(desc);
        }

        let system_prompt = format!(
            "You are a classifier. Given the user's input, select the most appropriate branch.\n\n\
             Available branches:\n{}\n\n\
             Respond with ONLY the branch key name, nothing else. Respond with exactly one branch key.",
            branch_descriptions.join("\n"),
        );

        let user_prompt = render(prompt_template, context)?;

        let full_prompt = if let Some(ref ctx_template) = route.context {
            let rendered_ctx = render(ctx_template, context)?;
            format!("{}\n\nContext:\n{}", system_prompt, rendered_ctx)
        } else {
            system_prompt
        };

        let combined_prompt = format!("{}\n\nUser input:\n{}", full_prompt, user_prompt);

        let llm_client = create_llm_client_from_app(&self.app).map_err(SequenceError::other)?;

        let branch_keys: Vec<&String> = route.branches.keys().collect();
        self.push_ai_log(
            &node.id,
            LogLevel::Info,
            format!(
                "Route AI classification via LLM (branches: {:?}): {}",
                branch_keys,
                crate::util::truncate_chars(&user_prompt, 200),
            ),
        );

        let result: crate::llm::GenerationResult<String> = llm_client
            .generate_with_usage::<String>(&combined_prompt, None)
            .await
            .map_err(|e| {
                self.push_ai_log(
                    &node.id,
                    LogLevel::Error,
                    format!("Route AI classification failed: {}", e),
                );
                SequenceError::command(format!("Route AI classification failed: {}", e))
            })?;

        let response = result.data.trim().to_string();

        self.push_ai_log(
            &node.id,
            LogLevel::Info,
            format!(
                "LLM classified as '{}' ({} input, {} output tokens)",
                response, result.usage.input_tokens, result.usage.output_tokens,
            ),
        );

        // Store LLM usage for this route node (providers don't report cost → 0)
        self.store_ai_usage(
            &node.id,
            TokenUsage {
                input_tokens: result.usage.input_tokens,
                output_tokens: result.usage.output_tokens,
                cache_read: 0,
                cache_creation: 0,
            },
            0.0,
        );

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

        if let Some(ref default) = route.default {
            return Ok(Some(serde_json::json!({
                "branch": "default",
                "next": default,
                "ai_classified": true,
            })));
        }

        Err(SequenceError::other(format!(
            "AI classification returned '{}' which matched no branch and no default set",
            response
        )))
    }
}
