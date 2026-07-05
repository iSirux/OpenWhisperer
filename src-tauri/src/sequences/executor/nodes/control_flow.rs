//! Control-flow node executors: approval, wait, loop, parallel, foreach,
//! subsequence.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tauri::Manager;
use tokio::sync::{Notify, Semaphore};

use crate::sequences::duration::parse_duration_to_secs;
use crate::sequences::error::SequenceError;
use crate::sequences::executor::engine::WaitStrategyResolved;
use crate::sequences::executor::{eval_bool, render, resolve_cwd, with_extra, SequenceExecutor};
use crate::sequences::persistence;
use crate::sequences::rate_limiter::SequenceRateLimiter;
use crate::sequences::types::*;

/// Build the per-iteration `loop` context object shared by loop/foreach nodes.
fn loop_meta(index: usize, total: usize, item: Option<&Value>) -> Value {
    let mut obj = serde_json::json!({
        "index": index,
        "iteration": index + 1,
        "total": total,
        "first": index == 0,
        "last": total > 0 && index == total - 1,
    });
    if let Some(item) = item {
        obj.as_object_mut()
            .unwrap()
            .insert("item".to_string(), item.clone());
    }
    obj
}

impl SequenceExecutor {
    // ─── Approval Node ───────────────────────────────────────────────────────

    pub(crate) async fn execute_approval(
        &self,
        node: &NodeDefinition,
        approval: &ApprovalNode,
        context: &serde_json::Value,
        execution_id: &str,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let rendered_message = render(&approval.message, context)?;

        crate::util::emit_or_log(
            &self.app,
            &format!("sequence-approval-{}", execution_id),
            serde_json::json!({
                "node_id": node.id,
                "message": rendered_message,
                "timeout": node.timeout,
            }),
        );

        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
        if let Some(manager) = self.app.try_state::<crate::sequences::SequenceManager>() {
            manager.approval_channels.lock().insert(execution_id.to_string(), tx);
        } else {
            return Err(SequenceError::other("SequenceManager not found in app state"));
        }

        let timeout_secs = node.timeout.unwrap_or(3600);
        match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await {
            Ok(Ok(true)) => Ok(Some(serde_json::json!({ "approved": true }))),
            Ok(Ok(false)) => Err(SequenceError::other("Approval rejected")),
            Ok(Err(_)) => Err(SequenceError::other("Approval channel dropped")),
            Err(_) => match &approval.on_timeout {
                Some(TimeoutAction::Skip) => {
                    Ok(Some(serde_json::json!({ "approved": false, "timed_out": true })))
                }
                Some(TimeoutAction::Fail) | None => Err(SequenceError::timeout(format!(
                    "Approval timed out after {}s",
                    timeout_secs
                ))),
                Some(TimeoutAction::Goto(target)) => Ok(Some(serde_json::json!({
                    "approved": false,
                    "timed_out": true,
                    "next": target,
                }))),
            },
        }
    }

    // ─── Wait Node ───────────────────────────────────────────────────────────

    pub(crate) async fn execute_wait(
        &self,
        node: &NodeDefinition,
        wait: &WaitNode,
        context: &serde_json::Value,
        cancel_flag: Arc<AtomicBool>,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let poll_interval = wait.poll_interval.unwrap_or(10);
        let timeout_secs = node.timeout.unwrap_or(300);
        let start = std::time::Instant::now();

        loop {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err(SequenceError::cancelled("Wait cancelled"));
            }

            if start.elapsed().as_secs() > timeout_secs {
                return match &wait.on_timeout {
                    Some(TimeoutAction::Skip) => Ok(Some(serde_json::json!({
                        "condition_met": false,
                        "timed_out": true,
                    }))),
                    Some(TimeoutAction::Fail) | None => Err(SequenceError::timeout(format!(
                        "Wait timed out after {}s",
                        timeout_secs
                    ))),
                    Some(TimeoutAction::Goto(target)) => Ok(Some(serde_json::json!({
                        "condition_met": false,
                        "timed_out": true,
                        "next": target,
                    }))),
                };
            }

            let condition_met = if let Some(ref condition) = wait.poll_condition {
                eval_bool(condition, context)?
            } else if let Some(ref poll_command) = wait.poll_command {
                let rendered_cmd = render(poll_command, context)?;
                let cwd = resolve_cwd(context);
                let out = crate::proc::run_shell_async(std::path::Path::new(&cwd), &rendered_cmd)
                    .await
                    .map_err(SequenceError::command)?;
                out.success
            } else {
                return Err(SequenceError::other(
                    "Wait node must have either 'condition' or 'poll_command'",
                ));
            };

            if condition_met {
                return Ok(Some(serde_json::json!({ "condition_met": true })));
            }

            tokio::time::sleep(std::time::Duration::from_secs(poll_interval)).await;
        }
    }

    // ─── Loop Node ───────────────────────────────────────────────────────────

    pub(crate) async fn execute_loop(
        &self,
        _node: &NodeDefinition,
        loop_node: &LoopNode,
        context: &serde_json::Value,
        execution_id: &str,
        cancel_flag: Arc<AtomicBool>,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let max_iterations = loop_node.max_iterations.unwrap_or(100);
        let mut iteration: u32 = 0;
        let mut node_outputs: serde_json::Map<String, Value> = serde_json::Map::new();

        loop {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err(SequenceError::cancelled("Loop cancelled"));
            }

            if iteration >= max_iterations {
                return match loop_node.on_max_iterations {
                    Some(MaxIterationsAction::Fail) => Err(SequenceError::other(format!(
                        "Loop reached max iterations ({})",
                        max_iterations
                    ))),
                    // Stop or unset: complete with a partial result.
                    _ => Ok(Some(serde_json::json!({
                        "iterations": iteration,
                        "completed": false,
                        "reason": "max_iterations_reached",
                    }))),
                };
            }

            let iterations_left = max_iterations.saturating_sub(iteration + 1);
            let loop_obj = serde_json::json!({
                "index": iteration,
                "iteration": iteration + 1,
                "iterations_left": iterations_left,
                "total": max_iterations,
                "first": iteration == 0,
                "last": iteration + 1 >= max_iterations,
                "nodes": node_outputs.clone(),
            });
            let mut iter_context = with_extra(context, vec![("loop", loop_obj)]);

            let mut should_break = false;
            let mut should_continue = false;

            for inner_node in &loop_node.nodes {
                let output = self
                    .execute_node(inner_node, &iter_context, execution_id, cancel_flag.clone())
                    .await?;

                if let Some(ref out) = output {
                    node_outputs.insert(inner_node.id.clone(), out.clone());

                    if let Value::Object(ref mut ctx_map) = iter_context {
                        if let Some(Value::Object(ref mut loop_obj)) = ctx_map.get_mut("loop") {
                            if let Some(Value::Object(ref mut nodes_obj)) = loop_obj.get_mut("nodes") {
                                nodes_obj.insert(inner_node.id.clone(), out.clone());
                            }
                        }
                    }

                    if out.get("_break").and_then(|v| v.as_bool()).unwrap_or(false) {
                        should_break = true;
                        break;
                    }
                    if out.get("_continue").and_then(|v| v.as_bool()).unwrap_or(false) {
                        should_continue = true;
                        break;
                    }
                }
            }

            iteration += 1;

            if should_break {
                let mut result = serde_json::json!({
                    "iterations": iteration,
                    "completed": true,
                    "reason": "break",
                });
                if let Some(ref on_break) = loop_node.on_break {
                    result
                        .as_object_mut()
                        .unwrap()
                        .insert("next".to_string(), Value::String(on_break.clone()));
                }
                return Ok(Some(result));
            }

            if should_continue {
                if let Some(ref delay_str) = loop_node.delay {
                    let rendered_delay = render(delay_str, &iter_context)?;
                    let secs = parse_duration_to_secs(&rendered_delay).map_err(SequenceError::other)?;
                    tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
                }
                continue;
            }

            if let Some(ref until_expr) = loop_node.until {
                if eval_bool(until_expr, &iter_context)? {
                    return Ok(Some(serde_json::json!({ "iterations": iteration, "completed": true })));
                }
            }

            if let Some(ref delay_str) = loop_node.delay {
                let rendered_delay = render(delay_str, &iter_context)?;
                let secs = parse_duration_to_secs(&rendered_delay).map_err(SequenceError::other)?;
                tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
            }
        }
    }

    // ─── Parallel Node (S4: JoinSet + Semaphore) ─────────────────────────────

    pub(crate) async fn execute_parallel(
        &self,
        _node: &NodeDefinition,
        parallel: &ParallelNode,
        context: &serde_json::Value,
        execution_id: &str,
        cancel_flag: Arc<AtomicBool>,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let strategy = match &parallel.wait {
            None => WaitStrategyResolved::All,
            Some(WaitStrategy::Named(WaitStrategyKind::All)) => WaitStrategyResolved::All,
            Some(WaitStrategy::Named(WaitStrategyKind::First)) => WaitStrategyResolved::First,
            Some(WaitStrategy::Named(WaitStrategyKind::Any)) => WaitStrategyResolved::Any,
            Some(WaitStrategy::Count(n)) => WaitStrategyResolved::Count(*n),
        };

        let mut branch_futs = Vec::new();
        for (branch_index, (branch_name, branch_nodes)) in parallel.branches.iter().enumerate() {
            let branch_nodes = branch_nodes.clone();
            let ctx = context.clone();
            let exec_id = execution_id.to_string();
            let flag = cancel_flag.clone();
            let executor = self.child();
            let stagger = SequenceRateLimiter::stagger_delay_ms(branch_index);

            let fut = async move {
                let mut last_output: Option<Value> = None;
                for inner_node in &branch_nodes {
                    last_output = executor
                        .execute_node(inner_node, &ctx, &exec_id, flag.clone())
                        .await?;
                }
                Ok(last_output)
            };
            branch_futs.push((branch_name.clone(), stagger, fut));
        }

        self.collect_branches(
            branch_futs,
            strategy,
            parallel.on_branch_error,
            parallel.max_parallel,
            cancel_flag,
        )
        .await
    }

    // ─── ForEach Node ────────────────────────────────────────────────────────

    pub(crate) async fn execute_foreach(
        &self,
        _node: &NodeDefinition,
        foreach: &ForEachNode,
        context: &serde_json::Value,
        execution_id: &str,
        cancel_flag: Arc<AtomicBool>,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let rendered_items = render(&foreach.items, context)?;
        let items: Vec<Value> = serde_json::from_str(&rendered_items)
            .map_err(|e| SequenceError::other(format!("ForEach items must be a JSON array: {}", e)))?;

        let variable = foreach.variable.as_deref().unwrap_or("item");
        let total = items.len();
        let mut results: Vec<Value> = Vec::new();
        let mut items_failed: usize = 0;

        let continues_on_error = foreach.on_item_error.map(|p| p.continues()).unwrap_or(false);

        if matches!(foreach.mode, Some(ExecutionMode::Parallel)) {
            // Concurrency cap for parallel items (finding S10).
            let semaphore = foreach
                .max_parallel
                .filter(|n| *n > 0)
                .map(|n| Arc::new(Semaphore::new(n as usize)));

            let mut handles = Vec::new();
            for (index, item) in items.iter().enumerate() {
                let iter_context = with_extra(
                    context,
                    vec![
                        (variable, item.clone()),
                        ("loop", loop_meta(index, total, Some(item))),
                    ],
                );
                let nodes = foreach.nodes.clone();
                let exec_id = execution_id.to_string();
                let flag = cancel_flag.clone();
                let executor = self.child();
                let sem = semaphore.clone();

                handles.push(tokio::spawn(async move {
                    let _permit = match &sem {
                        Some(s) => s.clone().acquire_owned().await.ok(),
                        None => None,
                    };
                    let mut last_output: Option<Value> = None;
                    for inner_node in &nodes {
                        last_output = executor
                            .execute_node(inner_node, &iter_context, &exec_id, flag.clone())
                            .await?;
                    }
                    Ok::<Option<Value>, SequenceError>(last_output)
                }));
            }

            // Await in spawn order so results stay aligned with the input array.
            for handle in handles {
                match handle.await {
                    Ok(Ok(output)) => results.push(output.unwrap_or(Value::Null)),
                    Ok(Err(e)) => {
                        if continues_on_error {
                            items_failed += 1;
                            results.push(serde_json::json!({ "error": e.to_string() }));
                        } else {
                            return Err(e);
                        }
                    }
                    Err(e) => return Err(SequenceError::other(format!("Task join error: {}", e))),
                }
            }
        } else {
            // Sequential (default)
            for (index, item) in items.iter().enumerate() {
                if cancel_flag.load(Ordering::Relaxed) {
                    return Err(SequenceError::cancelled("ForEach cancelled"));
                }

                let iter_context = with_extra(
                    context,
                    vec![
                        (variable, item.clone()),
                        ("loop", loop_meta(index, total, Some(item))),
                    ],
                );

                let mut last_output: Option<Value> = None;
                let mut item_errored = false;
                for inner_node in &foreach.nodes {
                    match self
                        .execute_node(inner_node, &iter_context, execution_id, cancel_flag.clone())
                        .await
                    {
                        Ok(output) => last_output = output,
                        Err(e) => {
                            if continues_on_error {
                                items_failed += 1;
                                last_output = Some(serde_json::json!({ "error": e.to_string() }));
                                item_errored = true;
                                break;
                            }
                            return Err(e);
                        }
                    }
                }
                let _ = item_errored;
                results.push(last_output.unwrap_or(Value::Null));
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

    // ─── SubSequence Node ────────────────────────────────────────────────────

    pub(crate) async fn execute_subsequence(
        &self,
        _node: &NodeDefinition,
        sub: &SubSequenceNode,
        context: &serde_json::Value,
        _execution_id: &str,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let definitions = persistence::load_definitions().map_err(SequenceError::other)?;
        let rendered_seq_id = render(&sub.sequence, context)?;
        let sub_def = definitions
            .into_iter()
            .find(|d| d.id == rendered_seq_id)
            .ok_or_else(|| SequenceError::other(format!("SubSequence '{}' not found", rendered_seq_id)))?;

        let mut sub_inputs: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
        if let Some(ref input_map) = sub.inputs {
            for (key, value) in input_map {
                let resolved = if let Some(s) = value.as_str() {
                    let rendered = render(s, context)?;
                    serde_json::from_str(&rendered).unwrap_or_else(|_| Value::String(rendered))
                } else {
                    value.clone()
                };
                sub_inputs.insert(key.clone(), resolved);
            }
        }

        // Fresh executor: the sub-sequence carries its own defaults / AI sink.
        let sub_executor =
            SequenceExecutor::new(self.app.clone(), self.sidecar.clone(), self.rate_limiter.clone());
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let pause_signal = Arc::new(Notify::new());
        let sub_exec_id = uuid::Uuid::new_v4().to_string();

        let exec_id = sub_executor
            .execute(sub_exec_id, sub_def, sub_inputs, false, cancel_flag, pause_signal, None)
            .await?;

        let execution = persistence::load_execution(&exec_id).map_err(SequenceError::other)?;
        Ok(Some(serde_json::json!({
            "execution_id": exec_id,
            "status": serde_json::to_value(&execution.status).unwrap_or_default(),
            "total_cost": execution.total_cost,
        })))
    }
}
