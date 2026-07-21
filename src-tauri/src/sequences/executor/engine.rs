//! Orchestration loop and node dispatch for [`SequenceExecutor`].
//!
//! The former ~320-line `execute` method is broken into named phases:
//! `mark_trigger_nodes`, `resolve_entry_node`, `run_node_with_retry`,
//! `apply_output_mappings`, `handle_node_error`, `run_cleanup`, `finalize`
//! (finding #20 / S1).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::{Notify, Semaphore};
use tokio::task::JoinSet;

use crate::sequences::error::SequenceError;
use crate::sequences::persistence;
use crate::sequences::state::*;
use crate::sequences::types::*;

use super::SequenceExecutor;

/// Minimum wall-clock gap between throttled mid-run persistence writes (S6).
const SAVE_THROTTLE: Duration = Duration::from_secs(3);

/// Resolved parallel-wait strategy (parsed from [`WaitStrategy`]).
#[derive(Debug, Clone, Copy)]
pub(crate) enum WaitStrategyResolved {
    All,
    First,
    Any,
    Count(usize),
}

impl WaitStrategyResolved {
    fn label(&self) -> &'static str {
        match self {
            WaitStrategyResolved::All => "all",
            WaitStrategyResolved::First => "first",
            WaitStrategyResolved::Any => "any",
            WaitStrategyResolved::Count(_) => "count",
        }
    }
}

/// Throttled, dirty-flagged persistence for a running execution (finding S6).
///
/// Previously the entire `SequenceExecution` (all node results + full log + full
/// context) was re-serialized to disk after **every** node — O(n²) I/O for long
/// or looping sequences.  Now we save at most once per [`SAVE_THROTTLE`], plus
/// unconditionally on state transitions and completion (`force`).
struct ThrottledSaver {
    last: Instant,
}

impl ThrottledSaver {
    fn new() -> Self {
        // Start "stale" so the first save always goes through.
        Self {
            last: Instant::now() - SAVE_THROTTLE * 2,
        }
    }

    fn save(&mut self, execution: &Arc<Mutex<SequenceExecution>>, force: bool) {
        if !force && self.last.elapsed() < SAVE_THROTTLE {
            return;
        }
        self.last = Instant::now();
        let snapshot = execution.lock().clone();
        let _ = persistence::save_execution(&snapshot);
    }
}

impl SequenceExecutor {
    /// Execute a sequence definition with the given inputs.
    ///
    /// Returns the execution ID on success.  If `dry_run` is true the sequence is
    /// validated but no nodes are executed.
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

        // Publish the sequence-level defaults so node executors can fall back to
        // them (model/effort for prompt nodes, timeout generally — S10).
        *self.shared.defaults.lock() = definition.defaults.clone().unwrap_or_default();

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

        let mut saver = ThrottledSaver::new();

        // 4. Mark running and persist initial state
        {
            let mut exec = execution.lock();
            exec.update_status(ExecutionStatus::Running);
            self.mark_trigger_nodes(&mut exec, &definition, entry_node_id.as_deref());
        }
        self.emit_status(&execution_id, &ExecutionStatus::Running);
        saver.save(&execution, true);

        // 5. Execute node loop
        let mut current_node_id = self.resolve_entry_node(&definition, entry_node_id.as_deref());

        while let Some(node_id) = current_node_id.take() {
            // --- Cancellation / pause checks ---
            if cancel_flag.load(Ordering::Relaxed) {
                execution.lock().update_status(ExecutionStatus::Cancelled);
                break;
            }
            let is_paused = execution.lock().status == ExecutionStatus::Paused;
            if is_paused {
                pause_signal.notified().await;
                if cancel_flag.load(Ordering::Relaxed) {
                    execution.lock().update_status(ExecutionStatus::Cancelled);
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
                    drop(exec);
                    self.emit_done(&execution_id, &ExecutionStatus::Failed);
                    return Err(msg);
                }
            };

            // --- Evaluate condition ---
            if let Some(ref condition) = node_def.condition {
                let ctx_value = execution.lock().context.to_value();
                let result = super::eval_bool(condition, &ctx_value).map_err(|e| {
                    format!("Condition eval error for '{}': {}", node_id, e)
                })?;
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

            // --- Execute with retry logic (S7) ---
            let strategy = node_def
                .on_error
                .clone()
                .or_else(|| definition.defaults.as_ref().and_then(|d| d.on_error.clone()))
                .unwrap_or(ErrorStrategy::Stop);
            let node_result = self
                .run_node_with_retry(
                    &node_def,
                    &execution,
                    &execution_id,
                    cancel_flag.clone(),
                    &strategy,
                )
                .await;

            // --- Drain AI logs accumulated during node execution ---
            self.drain_ai_logs(&execution_id, &execution);

            // --- Process result ---
            match node_result {
                Ok(output) => {
                    self.apply_output_mappings(&execution, &node_def, &node_id, output.as_ref());

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
                    // Attach the openable-session snapshot (prompt nodes) so the
                    // completed node can be reopened as a real SDK session.
                    if let Some(capture) = self.drain_ai_session(&node_id) {
                        execution.lock().set_node_session(&node_id, capture);
                    }
                    self.emit_node_complete(&execution_id, &node_id, 0, ai_cost);

                    current_node_id = self.next_node_id(&node_def, &definition, output.as_ref());
                    saver.save(&execution, false);
                }
                Err(error) => {
                    let error_str = error.to_string();
                    execution.lock().record_node_error(&node_id, &error_str);
                    self.emit_node_error(&execution_id, &node_id, &error_str);

                    match self.handle_node_error(&execution, &node_def, &definition, &node_id, error_str)
                    {
                        Some(next) => current_node_id = next,
                        None => {
                            saver.save(&execution, true);
                            break;
                        }
                    }
                    saver.save(&execution, true);
                }
            }
        }

        // 6. Run cleanup nodes
        self.run_cleanup(&definition, &execution, &execution_id, cancel_flag.clone())
            .await;

        // 7. Finalize
        self.finalize(&execution);

        let final_exec = execution.lock().clone();
        let _ = persistence::save_execution(&final_exec);
        self.emit_done(&execution_id, &final_exec.status);

        Ok(execution_id)
    }

    // ─── Phase: mark trigger nodes ───────────────────────────────────────────

    /// Mark trigger nodes as processed so they don't appear perpetually pending:
    /// the selected trigger is completed, the rest skipped.
    fn mark_trigger_nodes(
        &self,
        exec: &mut SequenceExecution,
        definition: &SequenceDefinition,
        entry_node_id: Option<&str>,
    ) {
        let trigger_nodes: Vec<&NodeDefinition> = definition
            .nodes
            .iter()
            .filter(|n| matches!(n.node_type, NodeType::Trigger(_)))
            .collect();
        if trigger_nodes.is_empty() {
            return;
        }

        let selected_trigger_idx = if let Some(entry_id) = entry_node_id {
            definition.triggers.iter().position(|t| match t {
                SequenceTrigger::Manual { entry_node_id }
                | SequenceTrigger::Schedule { entry_node_id, .. }
                | SequenceTrigger::Event { entry_node_id, .. } => {
                    entry_node_id.as_deref() == Some(entry_id)
                }
            })
        } else {
            definition
                .triggers
                .iter()
                .position(|t| matches!(t, SequenceTrigger::Manual { .. }))
        }
        .or(Some(0));

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

    // ─── Phase: resolve entry node ───────────────────────────────────────────

    fn resolve_entry_node(
        &self,
        definition: &SequenceDefinition,
        entry_node_id: Option<&str>,
    ) -> Option<String> {
        if let Some(eid) = entry_node_id {
            Some(eid.to_string())
        } else {
            definition
                .nodes
                .iter()
                .find(|n| !matches!(n.node_type, NodeType::Trigger(_)))
                .map(|n| n.id.clone())
        }
    }

    // ─── Phase: run node with retry (S7) ─────────────────────────────────────

    /// Run a node, retrying on retryable failures.
    ///
    /// Retry rule (unified — finding S7):
    /// - If `node.retry_count` is set, it is the retry budget.
    /// - Otherwise, if the effective error strategy is `retry`, a sensible
    ///   default of 3 is used (previously `on_error: retry` silently retried
    ///   zero times).
    /// - Template / cancellation errors are never retried (finding T1).
    async fn run_node_with_retry(
        &self,
        node_def: &NodeDefinition,
        execution: &Arc<Mutex<SequenceExecution>>,
        execution_id: &str,
        cancel_flag: Arc<AtomicBool>,
        strategy: &ErrorStrategy,
    ) -> Result<Option<Value>, SequenceError> {
        let base_retries = node_def.retry_count.unwrap_or(0);
        let max_retries = if base_retries > 0 {
            base_retries
        } else if matches!(strategy, ErrorStrategy::Retry) {
            3
        } else {
            0
        };

        let mut retry_count = 0u32;
        loop {
            let ctx_value = execution.lock().context.to_value();
            let result = self
                .execute_node(node_def, &ctx_value, execution_id, cancel_flag.clone())
                .await;

            match &result {
                Ok(_) => return result,
                Err(e) => {
                    if retry_count < max_retries && e.is_retryable() {
                        retry_count += 1;
                        execution.lock().add_log(
                            Some(&node_def.id),
                            LogLevel::Warn,
                            &format!("Retry {}/{}: {}", retry_count, max_retries, e),
                        );
                        let delay = node_def.retry_delay.unwrap_or(5);
                        let backoff = node_def.retry_backoff.unwrap_or(1.0);
                        let sleep_secs = (delay as f64 * backoff.powi(retry_count as i32 - 1)) as u64;
                        tokio::time::sleep(Duration::from_secs(sleep_secs)).await;
                    } else {
                        return result;
                    }
                }
            }
        }
    }

    // ─── Phase: apply output mappings ────────────────────────────────────────

    fn apply_output_mappings(
        &self,
        execution: &Arc<Mutex<SequenceExecution>>,
        node_def: &NodeDefinition,
        node_id: &str,
        output: Option<&Value>,
    ) {
        let Some(out) = output else { return };
        let mut exec = execution.lock();
        exec.context.set_node_output(node_id, "result", out.clone());

        for mapping in &node_def.outputs {
            let ctx_value = exec.context.to_value();
            match super::render(&mapping.value, &ctx_value) {
                Ok(rendered) => exec.context.set_node_output(
                    node_id,
                    &mapping.name,
                    serde_json::Value::String(rendered),
                ),
                Err(e) => log::warn!(
                    "[sequence] output mapping '{}' on node '{}' failed to render: {}",
                    mapping.name,
                    node_id,
                    e
                ),
            }
        }
    }

    // ─── Phase: handle node error ────────────────────────────────────────────

    /// Apply the error strategy after a node has finally failed.
    /// Returns `Some(next_node)` to continue, or `None` to stop the sequence.
    fn handle_node_error(
        &self,
        execution: &Arc<Mutex<SequenceExecution>>,
        node_def: &NodeDefinition,
        definition: &SequenceDefinition,
        node_id: &str,
        error: String,
    ) -> Option<Option<String>> {
        let strategy = node_def
            .on_error
            .clone()
            .or_else(|| definition.defaults.as_ref().and_then(|d| d.on_error.clone()))
            .unwrap_or(ErrorStrategy::Stop);

        match strategy {
            // `Retry` reaches here only after the retry budget in
            // `run_node_with_retry` is exhausted — treat as a hard failure.
            ErrorStrategy::Stop | ErrorStrategy::Retry => {
                let mut exec = execution.lock();
                exec.update_status(ExecutionStatus::Failed);
                exec.error = Some(error);
                None
            }
            ErrorStrategy::Skip => {
                execution.lock().record_node_skipped(node_id);
                Some(self.next_node_id(node_def, definition, None))
            }
            ErrorStrategy::Goto { target } => Some(Some(target)),
        }
    }

    // ─── Phase: cleanup ──────────────────────────────────────────────────────

    async fn run_cleanup(
        &self,
        definition: &SequenceDefinition,
        execution: &Arc<Mutex<SequenceExecution>>,
        execution_id: &str,
        cancel_flag: Arc<AtomicBool>,
    ) {
        if definition.cleanup.is_empty() {
            return;
        }

        {
            let mut exec = execution.lock();
            if exec.status == ExecutionStatus::Running || exec.status == ExecutionStatus::Cancelled {
                exec.update_status(ExecutionStatus::CleaningUp);
            }
        }

        for cleanup_node in &definition.cleanup {
            let ctx_value = execution.lock().context.to_value();
            if let Err(e) = self
                .execute_node(cleanup_node, &ctx_value, execution_id, cancel_flag.clone())
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

    // ─── Phase: finalize ─────────────────────────────────────────────────────

    fn finalize(&self, execution: &Arc<Mutex<SequenceExecution>>) {
        let mut exec = execution.lock();
        if exec.status == ExecutionStatus::Running || exec.status == ExecutionStatus::CleaningUp {
            exec.update_status(ExecutionStatus::Completed);
        }
        exec.completed_at = Some(Utc::now());
    }

    // ─── Input / node validation ─────────────────────────────────────────────

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
                    InputType::RepoList => {}
                }
            }
        }
        Ok(())
    }

    fn validate_nodes(&self, definition: &SequenceDefinition) -> Result<(), String> {
        if definition.nodes.is_empty() {
            return Err("Sequence has no nodes".to_string());
        }

        let node_ids: Vec<&str> = definition.nodes.iter().map(|n| n.id.as_str()).collect();

        let mut seen = std::collections::HashSet::new();
        for id in &node_ids {
            if !seen.insert(*id) {
                return Err(format!("Duplicate node id: '{}'", id));
            }
        }

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

    // ─── Next node resolution ────────────────────────────────────────────────

    fn next_node_id(
        &self,
        node_def: &NodeDefinition,
        definition: &SequenceDefinition,
        output: Option<&serde_json::Value>,
    ) -> Option<String> {
        // Route/branch resolution: the node output carries a `"next"` override.
        if matches!(node_def.node_type, NodeType::Route(_)) {
            if let Some(out) = output {
                if let Some(next) = out.get("next").and_then(|v| v.as_str()) {
                    return Some(next.to_string());
                }
            }
        }

        if let Some(ref next) = node_def.next {
            return Some(next.clone());
        }

        let idx = definition.nodes.iter().position(|n| n.id == node_def.id);
        idx.and_then(|i| {
            definition.nodes[i + 1..]
                .iter()
                .find(|n| !matches!(n.node_type, NodeType::Trigger(_)))
                .map(|n| n.id.clone())
        })
    }

    // ─── Node dispatch ───────────────────────────────────────────────────────

    pub(crate) fn execute_node<'a>(
        &'a self,
        node: &'a NodeDefinition,
        context: &'a serde_json::Value,
        execution_id: &'a str,
        cancel_flag: Arc<AtomicBool>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Option<serde_json::Value>, SequenceError>> + Send + 'a>,
    > {
        Box::pin(async move {
            match &node.node_type {
                NodeType::Prompt(p) => self.execute_prompt(node, p, context, execution_id).await,
                NodeType::Route(r) => self.execute_route(node, r, context).await,
                NodeType::Script(s) => self.execute_script(node, s, context, cancel_flag).await,
                NodeType::Notify(n) => self.execute_notify(node, n, context, execution_id).await,
                NodeType::Delay(d) => self.execute_delay(node, d, context).await,
                NodeType::Transform(t) => self.execute_transform(node, t, context),
                NodeType::Approval(a) => self.execute_approval(node, a, context, execution_id).await,
                NodeType::GitBranch(g) => self.execute_git_branch(node, g, context).await,
                NodeType::GitWorktree(g) => self.execute_git_worktree(node, g, context).await,
                NodeType::GitCommit(g) => self.execute_git_commit(node, g, context).await,
                NodeType::GitPush(g) => self.execute_git_push(node, g, context).await,
                NodeType::GitDeleteBranch(g) => self.execute_git_delete_branch(node, g, context).await,
                NodeType::GitDeleteWorktree(g) => {
                    self.execute_git_delete_worktree(node, g, context).await
                }
                NodeType::GithubPr(g) => self.execute_github_pr(node, g, context).await,
                NodeType::GithubPrWait(g) => {
                    self.execute_github_pr_wait(node, g, context, cancel_flag).await
                }
                NodeType::GithubPrMerge(g) => self.execute_github_pr_merge(node, g, context).await,
                NodeType::Wait(w) => self.execute_wait(node, w, context, cancel_flag).await,
                NodeType::File(f) => self.execute_file(node, f, context).await,
                NodeType::Http(h) => self.execute_http(node, h, context).await,
                NodeType::Loop(l) => {
                    self.execute_loop(node, l, context, execution_id, cancel_flag).await
                }
                NodeType::Parallel(p) => {
                    self.execute_parallel(node, p, context, execution_id, cancel_flag).await
                }
                NodeType::ForEach(f) => {
                    self.execute_foreach(node, f, context, execution_id, cancel_flag).await
                }
                NodeType::SubSequence(s) => self.execute_subsequence(node, s, context, execution_id).await,
                NodeType::Trigger(_) => Ok(None),
            }
        })
    }

    // ─── Parallel branch collection (S4) ─────────────────────────────────────

    /// Spawn a set of named branches with an optional `max_parallel` concurrency
    /// cap (via a [`Semaphore`]) and collect them according to `strategy` — the
    /// single helper replacing the four hand-rolled 50ms busy-poll schedulers
    /// (finding S4 / S10).
    ///
    /// Each entry is `(branch_name, stagger_ms, future)`.
    pub(crate) async fn collect_branches<F>(
        &self,
        branches: Vec<(String, u64, F)>,
        strategy: WaitStrategyResolved,
        on_branch_error: Option<BranchErrorPolicy>,
        max_parallel: Option<u32>,
        cancel_flag: Arc<AtomicBool>,
    ) -> Result<Option<Value>, SequenceError>
    where
        F: std::future::Future<Output = Result<Option<Value>, SequenceError>> + Send + 'static,
    {
        let semaphore = max_parallel
            .filter(|n| *n > 0)
            .map(|n| Arc::new(Semaphore::new(n as usize)));

        let mut set: JoinSet<(String, Result<Option<Value>, SequenceError>)> = JoinSet::new();
        for (name, stagger, fut) in branches {
            let sem = semaphore.clone();
            set.spawn(async move {
                // Concurrency cap: hold a permit for the branch's lifetime.
                let _permit = match &sem {
                    Some(s) => Some(s.clone().acquire_owned().await.ok()),
                    None => None,
                };
                if stagger > 0 {
                    tokio::time::sleep(Duration::from_millis(stagger)).await;
                }
                let out = fut.await;
                (name, out)
            });
        }

        let mut branches_output = serde_json::Map::new();

        match strategy {
            WaitStrategyResolved::First => {
                if let Some(joined) = set.join_next().await {
                    let (name, result) = joined.map_err(|e| SequenceError::other(format!("Task join error: {}", e)))?;
                    match result {
                        Ok(output) => {
                            branches_output.insert(name, output.unwrap_or(Value::Null));
                        }
                        Err(e) => {
                            branches_output.insert(name, serde_json::json!({ "error": e.to_string() }));
                        }
                    }
                }
                Ok(Some(serde_json::json!({ "branches": branches_output, "strategy": "first" })))
            }
            WaitStrategyResolved::Any => {
                while let Some(joined) = set.join_next().await {
                    let (name, result) = joined.map_err(|e| SequenceError::other(format!("Task join error: {}", e)))?;
                    match result {
                        Ok(output) => {
                            branches_output.insert(name, output.unwrap_or(Value::Null));
                            return Ok(Some(
                                serde_json::json!({ "branches": branches_output, "strategy": "any" }),
                            ));
                        }
                        Err(e) => {
                            branches_output.insert(name, serde_json::json!({ "error": e.to_string() }));
                        }
                    }
                }
                Err(SequenceError::other("All parallel branches failed"))
            }
            WaitStrategyResolved::Count(target) => {
                let mut completed = 0usize;
                while completed < target {
                    let Some(joined) = set.join_next().await else { break };
                    let (name, result) = joined.map_err(|e| SequenceError::other(format!("Task join error: {}", e)))?;
                    match result {
                        Ok(output) => {
                            branches_output.insert(name, output.unwrap_or(Value::Null));
                            completed += 1;
                        }
                        Err(e) => match on_branch_error {
                            Some(BranchErrorPolicy::Ignore) | Some(BranchErrorPolicy::Skip) => {
                                branches_output.insert(name, serde_json::json!({ "error": e.to_string() }));
                            }
                            Some(BranchErrorPolicy::CancelOthers) => {
                                cancel_flag.store(true, Ordering::Relaxed);
                                return Err(e);
                            }
                            _ => return Err(e),
                        },
                    }
                }
                Ok(Some(serde_json::json!({
                    "branches": branches_output,
                    "strategy": "count",
                    "completed": completed,
                    "target": target,
                })))
            }
            WaitStrategyResolved::All => {
                let mut had_error = false;
                while let Some(joined) = set.join_next().await {
                    let (name, result) = joined.map_err(|e| SequenceError::other(format!("Task join error: {}", e)))?;
                    match result {
                        Ok(output) => {
                            branches_output.insert(name, output.unwrap_or(Value::Null));
                        }
                        Err(e) => {
                            had_error = true;
                            match on_branch_error {
                                Some(BranchErrorPolicy::CancelOthers) => {
                                    cancel_flag.store(true, Ordering::Relaxed);
                                    return Err(SequenceError::other(format!(
                                        "Branch '{}' failed: {}",
                                        name, e
                                    )));
                                }
                                _ => {
                                    branches_output
                                        .insert(name, serde_json::json!({ "error": e.to_string() }));
                                }
                            }
                        }
                    }
                }
                if had_error
                    && !matches!(
                        on_branch_error,
                        Some(BranchErrorPolicy::Ignore)
                            | Some(BranchErrorPolicy::Skip)
                            | Some(BranchErrorPolicy::CancelOthers)
                    )
                {
                    return Err(SequenceError::other(format!(
                        "One or more parallel branches failed: {:?}",
                        branches_output
                    )));
                }
                Ok(Some(serde_json::json!({
                    "branches": branches_output,
                    "strategy": strategy.label(),
                })))
            }
        }
    }

    // ─── AI logging helpers ──────────────────────────────────────────────────

    fn drain_ai_logs(&self, exec_id: &str, execution: &Arc<Mutex<SequenceExecution>>) {
        let logs: Vec<_> = self.shared.ai_logs.lock().drain(..).collect();
        for log in logs {
            let entry = LogEntry {
                timestamp: Utc::now(),
                node_id: Some(log.node_id),
                level: log.level,
                message: log.message,
            };
            crate::util::emit_or_log(
                &self.app,
                &format!("sequence-log-{}", exec_id),
                serde_json::json!({ "entry": entry }),
            );
            execution.lock().log.push(entry);
        }
    }

    fn drain_ai_usage(&self, node_id: &str) -> Option<(TokenUsage, f64)> {
        self.shared
            .ai_usage
            .lock()
            .remove(node_id)
            .map(|u| (u.tokens, u.cost))
    }

    fn drain_ai_session(
        &self,
        node_id: &str,
    ) -> Option<crate::sequences::state::PromptSessionCapture> {
        self.shared.ai_sessions.lock().remove(node_id)
    }

    // ─── Event emission helpers (T6: short_id + emit_or_log) ─────────────────

    fn emit_status(&self, exec_id: &str, status: &ExecutionStatus) {
        log::info!("[sequence][{}] emit status: {:?}", crate::util::short_id(exec_id), status);
        crate::util::emit_or_log(
            &self.app,
            &format!("sequence-status-{}", exec_id),
            serde_json::to_value(status).unwrap_or_default(),
        );
    }

    fn emit_node_start(&self, exec_id: &str, node: &NodeDefinition) {
        log::info!(
            "[sequence][{}] emit node-start: {} ({:?})",
            crate::util::short_id(exec_id),
            node.id,
            node.name
        );
        crate::util::emit_or_log(
            &self.app,
            &format!("sequence-node-start-{}", exec_id),
            serde_json::json!({
                "node_id": node.id,
                "node_name": node.name,
                "node_type": format!("{:?}", std::mem::discriminant(&node.node_type)),
            }),
        );
    }

    fn emit_node_complete(&self, exec_id: &str, node_id: &str, duration_ms: u64, cost: Option<f64>) {
        log::info!("[sequence][{}] emit node-complete: {}", crate::util::short_id(exec_id), node_id);
        crate::util::emit_or_log(
            &self.app,
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
            crate::util::short_id(exec_id),
            node_id,
            error
        );
        crate::util::emit_or_log(
            &self.app,
            &format!("sequence-node-error-{}", exec_id),
            serde_json::json!({ "node_id": node_id, "error": error }),
        );
    }

    pub(crate) fn emit_done(&self, exec_id: &str, status: &ExecutionStatus) {
        log::info!("[sequence][{}] emit done: {:?}", crate::util::short_id(exec_id), status);
        crate::util::emit_or_log(
            &self.app,
            &format!("sequence-done-{}", exec_id),
            serde_json::to_value(status).unwrap_or_default(),
        );
    }
}
