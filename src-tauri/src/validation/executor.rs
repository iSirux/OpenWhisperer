//! Validation run orchestration. Mirrors `NoMistakesManager`'s shape (a runs map
//! with per-run abort handles and a tokio task per run) but replaces the external
//! child-process orchestration with native, sequential step execution driving the
//! sidecar one-shot agents and streaming typed events.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, EventId, Listener, Manager};
use tokio::sync::{mpsc, oneshot};
use tokio::task::AbortHandle;

use crate::commands::settings_cmds::ConfigState;
use crate::config::{AppConfig, RepoConfig, ValidationConfig};
use crate::git::GitManager;
use crate::proc::{run_command_async, run_shell_async};
use crate::sidecar::{OutboundMessage, SidecarManager};
use crate::util::{emit_or_log, now_ms};

use super::prompts;
use super::ship;
use super::types::*;

/// Idle window for a one-shot validation agent: reset on every streamed
/// progress event (tool call / text), so a working agent is never cut off.
/// The overall cap is configurable (`agent_timeout_minutes`).
const AGENT_IDLE_TIMEOUT_SECS: u64 = 600;
/// Tail length kept for command/log proof and CI log excerpts.
const OUTPUT_TAIL: usize = 2000;
const CI_LOG_TAIL: usize = 32_000;

/// Live agent activity forwarded to the frontend
/// (`validation-agent-activity-{runId}`), one event per reviewer tool call or
/// text block.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentActivityPayload {
    /// "review" | "verify" | "evidence" | "docs" | "lint"
    role: String,
    /// "tool" | "text"
    kind: String,
    tool: Option<String>,
    detail: Option<String>,
    text: Option<String>,
}

/// A user/frontend signal that unblocks a parked run.
#[derive(Debug)]
pub enum RunSignal {
    Respond {
        action: String,
        finding_ids: Option<Vec<String>>,
        instructions: Option<String>,
        added_findings: Option<Vec<ValidationFinding>>,
    },
    Ship {
        commit_message: String,
        pr_title: String,
        pr_body: String,
    },
    FixDone {
        fix_summary: Option<String>,
    },
    FixFailed {
        error: String,
    },
}

/// Per-run control state stored in the manager map.
struct RunHandle {
    session_id: String,
    abort: Option<AbortHandle>,
    signal_tx: mpsc::UnboundedSender<RunSignal>,
    /// Mirror of the latest run snapshot, so cancel can emit a final update.
    shared: Arc<Mutex<ValidationRun>>,
}

/// Manages active validation runs. Registered as Tauri state (`Arc<ValidationManager>`).
pub struct ValidationManager {
    runs: Mutex<HashMap<String, RunHandle>>,
}

impl ValidationManager {
    pub fn new() -> Self {
        Self {
            runs: Mutex::new(HashMap::new()),
        }
    }

    /// Start a run. Errors if the session already has an active run.
    pub fn start_run(
        self: &Arc<Self>,
        app: AppHandle,
        run_id: String,
        session_id: String,
        cwd: String,
        repo_id: Option<String>,
        intent: String,
        options: RunOptions,
    ) -> Result<String, String> {
        {
            let runs = self.runs.lock();
            if runs.contains_key(&run_id) {
                return Err(format!("A validation run '{}' already exists", run_id));
            }
            if runs.values().any(|h| h.session_id == session_id) {
                return Err("A validation run is already active for this session".to_string());
            }
        }

        // Build the initial run snapshot (only the user-selected steps, fixed order).
        let steps: Vec<ValidationStep> = StepName::ORDER
            .iter()
            .filter(|s| options.steps.contains(s))
            .map(|s| ValidationStep::new(*s))
            .collect();

        if steps.is_empty() {
            return Err("No validation steps selected".to_string());
        }

        let run = ValidationRun {
            id: run_id.clone(),
            session_id: session_id.clone(),
            cwd: cwd.clone(),
            status: RunStatus::Running,
            steps,
            gate: None,
            intent,
            options,
            pr_url: None,
            error: None,
            pending_fix: false,
            started_at: now_ms(),
            finished_at: None,
        };

        let shared = Arc::new(Mutex::new(run.clone()));
        let (signal_tx, signal_rx) = mpsc::unbounded_channel::<RunSignal>();

        // Snapshot the config bits the run needs (never re-read stale state mid-run).
        let (validation_cfg, repo_cfg, gh_user, default_model) = {
            let state = app.state::<ConfigState>();
            let cfg = state.lock();
            let repo = resolve_repo(&cfg, repo_id.as_deref(), &cwd);
            let gh_user = repo.as_ref().and_then(|r| r.gh_user.clone());
            (
                cfg.validation.clone(),
                repo,
                gh_user,
                cfg.default_model.clone(),
            )
        };

        self.runs.lock().insert(
            run_id.clone(),
            RunHandle {
                session_id,
                abort: None,
                signal_tx,
                shared: Arc::clone(&shared),
            },
        );

        let ctx = RunCtx {
            app: app.clone(),
            run,
            shared: Arc::clone(&shared),
            signal_rx,
            reviewer_session_id: None,
            validation_cfg,
            repo_cfg,
            gh_user,
            default_model,
        };

        let manager = Arc::clone(self);
        let run_id_for_task = run_id.clone();
        let handle = tokio::spawn(async move {
            let mut ctx = ctx;
            ctx.execute().await;
            // Remove the finished run from the manager map.
            manager.runs.lock().remove(&run_id_for_task);
        });

        if let Some(h) = self.runs.lock().get_mut(&run_id) {
            h.abort = Some(handle.abort_handle());
        }

        // Emit the initial snapshot so the panel renders immediately.
        emit_or_log(&app, &format!("validation-update-{}", run_id), shared.lock().clone());
        Ok(run_id)
    }

    /// Return the current full snapshot of a run (for post-listener resync).
    pub fn get_run(&self, run_id: &str) -> Result<ValidationRun, String> {
        let runs = self.runs.lock();
        runs.get(run_id)
            .map(|h| h.shared.lock().clone())
            .ok_or_else(|| format!("Unknown validation run '{}'", run_id))
    }

    /// Route a signal to the run's executor task.
    fn send_signal(&self, run_id: &str, signal: RunSignal) -> Result<(), String> {
        let runs = self.runs.lock();
        let handle = runs
            .get(run_id)
            .ok_or_else(|| format!("Unknown validation run '{}'", run_id))?;
        handle
            .signal_tx
            .send(signal)
            .map_err(|_| "Validation run is not accepting input".to_string())
    }

    pub fn respond(
        &self,
        run_id: String,
        action: String,
        finding_ids: Option<Vec<String>>,
        instructions: Option<String>,
        added_findings: Option<Vec<ValidationFinding>>,
    ) -> Result<(), String> {
        self.send_signal(
            &run_id,
            RunSignal::Respond {
                action,
                finding_ids,
                instructions,
                added_findings,
            },
        )
    }

    pub fn execute_ship(
        &self,
        run_id: String,
        commit_message: String,
        pr_title: String,
        pr_body: String,
    ) -> Result<(), String> {
        self.send_signal(
            &run_id,
            RunSignal::Ship {
                commit_message,
                pr_title,
                pr_body,
            },
        )
    }

    pub fn fix_done(&self, run_id: String, fix_summary: Option<String>) -> Result<(), String> {
        self.send_signal(&run_id, RunSignal::FixDone { fix_summary })
    }

    pub fn fix_failed(&self, run_id: String, error: String) -> Result<(), String> {
        self.send_signal(&run_id, RunSignal::FixFailed { error })
    }

    /// Cancel a run: mark cancelled, emit a final update, abort the task. Never
    /// touches an in-flight session turn (fixes are frontend-mediated).
    pub fn cancel(&self, app: AppHandle, run_id: String) -> Result<(), String> {
        let handle = {
            let mut runs = self.runs.lock();
            runs.remove(&run_id)
                .ok_or_else(|| format!("Unknown validation run '{}'", run_id))?
        };
        {
            let mut run = handle.shared.lock();
            if !run.is_finished() {
                run.status = RunStatus::Cancelled;
                run.gate = None;
                run.pending_fix = false;
                run.finished_at = Some(now_ms());
            }
            emit_or_log(&app, &format!("validation-update-{}", run_id), run.clone());
        }
        if let Some(h) = handle.abort {
            h.abort();
        }
        log::info!("[validation] run '{}' cancelled", run_id);
        Ok(())
    }
}

impl Default for ValidationManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolve the repo config for a run by id, then by cwd prefix.
fn resolve_repo(cfg: &AppConfig, repo_id: Option<&str>, cwd: &str) -> Option<RepoConfig> {
    if let Some(id) = repo_id {
        if let Some(r) = cfg
            .repos
            .iter()
            .find(|r| r.id.as_deref() == Some(id))
        {
            return Some(r.clone());
        }
    }
    // Fall back to the repo whose path is a prefix of the cwd (worktrees).
    let cwd_norm = cwd.replace('\\', "/");
    cfg.repos
        .iter()
        .find(|r| cwd_norm.starts_with(&r.path.replace('\\', "/")))
        .cloned()
}

// ── The per-run executor ────────────────────────────────────────────────────

struct RunCtx {
    app: AppHandle,
    run: ValidationRun,
    shared: Arc<Mutex<ValidationRun>>,
    signal_rx: mpsc::UnboundedReceiver<RunSignal>,
    reviewer_session_id: Option<String>,
    validation_cfg: ValidationConfig,
    repo_cfg: Option<RepoConfig>,
    gh_user: Option<String>,
    default_model: String,
}

/// Outcome of a fix wait.
enum FixResult {
    Done(Option<String>),
    Failed(String),
    Cancelled,
}

/// Result of a step's gate cycle.
enum StepEnd {
    Passed,
    Skipped,
    Failed(String),
    Cancelled,
}

/// Structured output from a one-shot agent.
struct AgentOutcome {
    structured: serde_json::Value,
    transcript: Option<String>,
    sdk_session_id: Option<String>,
}

impl RunCtx {
    fn cwd(&self) -> String {
        self.run.cwd.clone()
    }

    fn gh_user(&self) -> Option<&str> {
        self.gh_user.as_deref()
    }

    /// Mirror the current run into the shared cell and emit a full update.
    fn emit_update(&self) {
        *self.shared.lock() = self.run.clone();
        emit_or_log(
            &self.app,
            &format!("validation-update-{}", self.run.id),
            self.run.clone(),
        );
    }

    fn log(&self, line: impl Into<String>) {
        #[derive(Serialize, Clone)]
        struct LogPayload {
            line: String,
        }
        emit_or_log(
            &self.app,
            &format!("validation-log-{}", self.run.id),
            LogPayload { line: line.into() },
        );
    }

    /// Main entry: run each selected step in fixed order.
    async fn execute(&mut self) {
        let step_names: Vec<StepName> = self.run.steps.iter().map(|s| s.name).collect();
        for name in step_names {
            let end = self.run_step(name).await;
            match end {
                StepEnd::Passed | StepEnd::Skipped => continue,
                StepEnd::Cancelled => {
                    // Cancel path already handled via the manager; just stop.
                    return;
                }
                StepEnd::Failed(err) => {
                    self.finish(RunStatus::Failed, Some(err));
                    return;
                }
            }
        }
        self.finish(RunStatus::Passed, None);
    }

    fn finish(&mut self, status: RunStatus, error: Option<String>) {
        self.run.status = status;
        self.run.gate = None;
        self.run.pending_fix = false;
        self.run.error = error;
        self.run.finished_at = Some(now_ms());
        self.emit_update();
        log::info!(
            "[validation] run '{}' finished: {:?}",
            self.run.id,
            self.run.status
        );
    }

    fn set_step_status(&mut self, name: StepName, status: StepStatus) {
        if let Some(step) = self.run.step_mut(name) {
            step.status = status;
            if matches!(status, StepStatus::Running) && step.started_at.is_none() {
                step.started_at = Some(now_ms());
            }
        }
        self.run.status = RunStatus::Running;
        self.emit_update();
    }

    // ── Signal helpers ──────────────────────────────────────────────────────

    /// Await a gate response (respond/ship). Ignores stray fix signals. `None` =
    /// the channel closed (run cancelled/aborted).
    async fn await_gate(&mut self) -> Option<RunSignal> {
        loop {
            match self.signal_rx.recv().await {
                Some(sig @ (RunSignal::Respond { .. } | RunSignal::Ship { .. })) => {
                    return Some(sig)
                }
                Some(_) => continue, // stray fix signal; ignore
                None => return None,
            }
        }
    }

    /// Await a fix result (fix_done/fix_failed). Ignores stray gate signals.
    async fn await_fix(&mut self) -> FixResult {
        loop {
            match self.signal_rx.recv().await {
                Some(RunSignal::FixDone { fix_summary }) => return FixResult::Done(fix_summary),
                Some(RunSignal::FixFailed { error }) => return FixResult::Failed(error),
                Some(_) => continue,
                None => return FixResult::Cancelled,
            }
        }
    }

    /// Emit a fix request to the frontend (which drives the session's agent) and
    /// wait for it to report back.
    async fn request_fix(
        &mut self,
        step: StepName,
        findings: Vec<ValidationFinding>,
        instructions: Option<String>,
        round: u32,
        trigger: &str,
    ) -> FixResult {
        #[derive(Serialize, Clone)]
        struct FixRequestPayload {
            step: StepName,
            findings: Vec<ValidationFinding>,
            instructions: Option<String>,
            round: u32,
            trigger: String,
        }
        self.set_step_status(step, StepStatus::Fixing);
        self.run.pending_fix = true;
        self.run.gate = None;
        self.emit_update();
        self.log(format!(
            "{}: requesting fix for {} finding(s) ({})",
            step.key(),
            findings.len(),
            trigger
        ));
        emit_or_log(
            &self.app,
            &format!("validation-fix-request-{}", self.run.id),
            FixRequestPayload {
                step,
                findings,
                instructions,
                round,
                trigger: trigger.to_string(),
            },
        );
        let result = self.await_fix().await;
        self.run.pending_fix = false;
        self.emit_update();
        result
    }

    // ── Sidecar one-shot agent rail ─────────────────────────────────────────

    /// Reviewer model, resolving the "session" sentinel to the default model
    /// (the backend can't see the live session's model).
    fn reviewer_model(&self) -> String {
        let m = &self.run.options.reviewer_model;
        if m == "session" || m.trim().is_empty() {
            self.default_model.clone()
        } else {
            m.clone()
        }
    }

    /// Run a one-shot validation agent and await its structured result.
    async fn run_agent(
        &self,
        role: &str,
        prompt: String,
        resume: Option<String>,
    ) -> Result<AgentOutcome, String> {
        let sidecar = self.app.state::<Arc<SidecarManager>>();
        let agent_id = format!("val-{}-{}", self.run.id, uuid::Uuid::new_v4());

        // RAII listener guard.
        struct Listeners {
            app: AppHandle,
            ids: Vec<EventId>,
        }
        impl Drop for Listeners {
            fn drop(&mut self) {
                for id in self.ids.drain(..) {
                    self.app.unlisten(id);
                }
            }
        }
        let mut guard = Listeners {
            app: self.app.clone(),
            ids: Vec::new(),
        };

        let (tx, rx) = oneshot::channel::<Result<AgentOutcome, String>>();
        let tx = Arc::new(Mutex::new(Some(tx)));

        let tx_ok = Arc::clone(&tx);
        let result_event = format!("validation-agent-result-{}", agent_id);
        guard.ids.push(self.app.listen(result_event, move |event| {
            let parsed: Result<AgentOutcome, String> =
                match serde_json::from_str::<serde_json::Value>(event.payload()) {
                    Ok(v) => Ok(AgentOutcome {
                        structured: v.get("structured").cloned().unwrap_or(serde_json::Value::Null),
                        transcript: v
                            .get("transcript")
                            .and_then(|t| t.as_str())
                            .map(|s| s.to_string()),
                        sdk_session_id: v
                            .get("sdkSessionId")
                            .and_then(|t| t.as_str())
                            .map(|s| s.to_string()),
                    }),
                    Err(e) => Err(format!("Failed to parse agent result: {}", e)),
                };
            if let Some(tx) = tx_ok.lock().take() {
                let _ = tx.send(parsed);
            }
        }));

        let tx_err = Arc::clone(&tx);
        let error_event = format!("validation-agent-error-{}", agent_id);
        guard.ids.push(self.app.listen(error_event, move |event| {
            let msg = serde_json::from_str::<serde_json::Value>(event.payload())
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(|s| s.to_string()))
                .unwrap_or_else(|| "Unknown validation agent error".to_string());
            if let Some(tx) = tx_err.lock().take() {
                let _ = tx.send(Err(msg));
            }
        }));

        // Streamed progress: re-emit as run-scoped live activity for the UI and
        // signal the timeout loop so the idle window resets while the agent is
        // demonstrably working.
        let (activity_tx, mut activity_rx) = mpsc::unbounded_channel::<()>();
        let progress_role = role.to_string();
        let progress_run_id = self.run.id.clone();
        let progress_app = self.app.clone();
        let progress_event = format!("validation-agent-progress-{}", agent_id);
        guard.ids.push(self.app.listen(progress_event, move |event| {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                let s = |key: &str| v.get(key).and_then(|x| x.as_str()).map(String::from);
                emit_or_log(
                    &progress_app,
                    &format!("validation-agent-activity-{}", progress_run_id),
                    AgentActivityPayload {
                        role: progress_role.clone(),
                        kind: s("kind").unwrap_or_default(),
                        tool: s("tool"),
                        detail: s("detail"),
                        text: s("text"),
                    },
                );
            }
            let _ = activity_tx.send(());
        }));

        sidecar
            .send_or_start(
                self.app.clone(),
                OutboundMessage::ValidationAgent {
                    id: agent_id,
                    cwd: self.cwd(),
                    role: role.to_string(),
                    prompt,
                    model: self.reviewer_model(),
                    effort: self.run.options.reviewer_effort.clone(),
                    resume_session_id: resume,
                },
            )
            .map_err(|e| format!("Failed to start validation agent: {}", e))?;

        // Activity-aware timeout: the idle window resets on every streamed
        // progress event, so only a genuinely stalled agent times out; the
        // overall cap bounds runaway agents.
        let cap_minutes = self.validation_cfg.agent_timeout_minutes.max(1);
        let deadline =
            tokio::time::Instant::now() + std::time::Duration::from_secs(cap_minutes as u64 * 60);
        let idle = std::time::Duration::from_secs(AGENT_IDLE_TIMEOUT_SECS);
        let mut rx = rx;
        loop {
            tokio::select! {
                res = &mut rx => {
                    return match res {
                        Ok(r) => r,
                        Err(_) => Err("Validation agent channel dropped".to_string()),
                    };
                }
                _ = tokio::time::sleep_until(deadline) => {
                    return Err(format!(
                        "Validation agent hit the overall time cap ({} min, configurable in Settings → Validation)",
                        cap_minutes
                    ));
                }
                _ = tokio::time::sleep(idle) => {
                    return Err(format!(
                        "Validation agent produced no activity for {} minutes",
                        AGENT_IDLE_TIMEOUT_SECS / 60
                    ));
                }
                Some(_) = activity_rx.recv() => {
                    // Activity — loop to reset the idle window.
                }
            }
        }
    }

    // ── Step dispatch ───────────────────────────────────────────────────────

    async fn run_step(&mut self, name: StepName) -> StepEnd {
        self.log(format!("Starting step: {}", name.key()));
        let end = match name {
            StepName::Review => self.run_findings_step(name).await,
            StepName::Docs => self.run_findings_step(name).await,
            StepName::Lint => self.run_findings_step(name).await,
            StepName::Test => self.run_findings_step(name).await,
            StepName::Ship => self.run_ship().await,
            StepName::Ci => self.run_ci().await,
        };
        // Stamp terminal step status + finished timestamp.
        let status = match &end {
            StepEnd::Passed => Some(StepStatus::Passed),
            StepEnd::Skipped => Some(StepStatus::Skipped),
            StepEnd::Failed(_) => Some(StepStatus::Failed),
            StepEnd::Cancelled => None,
        };
        if let Some(status) = status {
            if let Some(step) = self.run.step_mut(name) {
                step.status = status;
                step.finished_at = Some(now_ms());
            }
            self.emit_update();
        }
        end
    }

    /// Produce findings for a findings-style step (review/test/docs/lint) and set
    /// step-level fields (proof/risk/evidence/transcript). `round` is 0-based.
    async fn produce_findings(&mut self, name: StepName) -> Result<Vec<ValidationFinding>, String> {
        match name {
            StepName::Review => self.produce_review().await,
            StepName::Test => self.produce_test().await,
            StepName::Docs => self.produce_docs().await,
            StepName::Lint => self.produce_lint().await,
            _ => Ok(Vec::new()),
        }
    }

    /// The shared findings-step engine: initial run, auto-fix loop, gate cycle,
    /// user-fix + fix_review gate.
    async fn run_findings_step(&mut self, name: StepName) -> StepEnd {
        self.set_step_status(name, StepStatus::Running);

        // A step can early-skip (e.g. test with no command + evidence disabled).
        let mut findings = match self.produce_findings(name).await {
            Ok(f) => f,
            Err(e) => return StepEnd::Failed(format!("{}: {}", name.key(), e)),
        };
        if matches!(
            self.run.step_mut(name).map(|s| s.status),
            Some(StepStatus::Skipped)
        ) {
            return StepEnd::Skipped;
        }

        self.record_round(name, "initial", &findings, &[]);
        self.set_step_findings(name, findings.clone());

        let limit = self.validation_cfg.auto_fix_limit(name.key());
        let mut auto_used = 0u32;
        let mut round: u32 = 1;
        let mut fix_review_diff: Option<String> = None;

        loop {
            let blocking: Vec<ValidationFinding> =
                findings.iter().filter(|f| f.blocks()).cloned().collect();
            let auto: Vec<ValidationFinding> = findings
                .iter()
                .filter(|f| f.is_auto_fixable())
                .cloned()
                .collect();

            // Auto-fix loop (disabled once we're in a user-driven fix_review).
            if fix_review_diff.is_none() && !auto.is_empty() && auto_used < limit {
                let auto_ids: Vec<String> = auto.iter().map(|f| f.id.clone()).collect();
                match self
                    .request_fix(name, auto.clone(), None, round, "auto_fix")
                    .await
                {
                    FixResult::Done(_) => {
                        auto_used += 1;
                        round += 1;
                        self.set_step_status(name, StepStatus::Running);
                        findings = match self.produce_findings(name).await {
                            Ok(f) => f,
                            Err(e) => return StepEnd::Failed(format!("{}: {}", name.key(), e)),
                        };
                        self.record_round(name, "auto_fix", &findings, &auto_ids);
                        self.set_step_findings(name, findings.clone());
                        continue;
                    }
                    FixResult::Failed(e) => {
                        // Fall through to a user gate.
                        self.log(format!("{}: auto-fix failed: {}", name.key(), e));
                        auto_used = limit;
                        continue;
                    }
                    FixResult::Cancelled => return StepEnd::Cancelled,
                }
            }

            let in_fix_review = fix_review_diff.is_some();
            if !in_fix_review && blocking.is_empty() {
                return StepEnd::Passed;
            }

            // Park a gate (findings or fix_review).
            let kind = if in_fix_review { "fix_review" } else { "findings" };
            self.set_step_status(
                name,
                if in_fix_review {
                    StepStatus::FixReview
                } else {
                    StepStatus::Gate
                },
            );
            self.run.status = RunStatus::Gate;
            self.run.gate = Some(GateState {
                step: name,
                kind: kind.to_string(),
                findings: findings.clone(),
                ship: None,
                diff: fix_review_diff.clone(),
            });
            self.emit_update();

            let signal = match self.await_gate().await {
                Some(s) => s,
                None => return StepEnd::Cancelled,
            };
            self.run.gate = None;

            let RunSignal::Respond {
                action,
                finding_ids,
                instructions,
                added_findings,
            } = signal
            else {
                // A ship signal at a findings gate is meaningless; ignore + re-loop.
                continue;
            };

            match action.as_str() {
                "approve" => return StepEnd::Passed,
                "skip" => {
                    self.set_step_note(name, "Step skipped by user");
                    return StepEnd::Skipped;
                }
                "fix" => {
                    // Compose the selected findings (+ user-added) for the fixer.
                    let selected_ids = finding_ids.unwrap_or_default();
                    let mut to_fix: Vec<ValidationFinding> = findings
                        .iter()
                        .filter(|f| selected_ids.contains(&f.id))
                        .cloned()
                        .collect();
                    if let Some(added) = added_findings {
                        for (i, mut f) in added.into_iter().enumerate() {
                            if f.id.trim().is_empty() {
                                f.id = format!("user-{}", i + 1);
                            }
                            f.source = "user".to_string();
                            to_fix.push(f);
                        }
                    }
                    if to_fix.is_empty() {
                        to_fix = findings.iter().filter(|f| f.blocks()).cloned().collect();
                    }
                    let selected_for_round: Vec<String> =
                        to_fix.iter().map(|f| f.id.clone()).collect();

                    let head = self.git_head().await;
                    match self
                        .request_fix(name, to_fix, instructions, round, "user_fix")
                        .await
                    {
                        FixResult::Done(summary) => {
                            round += 1;
                            self.set_step_status(name, StepStatus::Running);
                            findings = match self.produce_findings(name).await {
                                Ok(f) => f,
                                Err(e) => {
                                    return StepEnd::Failed(format!("{}: {}", name.key(), e))
                                }
                            };
                            self.record_round_with_summary(
                                name,
                                "user_fix",
                                &findings,
                                &selected_for_round,
                                summary,
                            );
                            self.set_step_findings(name, findings.clone());
                            let diff = self.compute_fix_diff(&head).await;
                            if let Some(step) = self.run.step_mut(name) {
                                step.fix_review_diff = Some(diff.clone());
                            }
                            fix_review_diff = Some(diff);
                            continue;
                        }
                        FixResult::Failed(e) => {
                            self.log(format!("{}: fix reported failed: {}", name.key(), e));
                            // Re-park as a findings gate so the user decides.
                            fix_review_diff = None;
                            continue;
                        }
                        FixResult::Cancelled => return StepEnd::Cancelled,
                    }
                }
                other => {
                    self.log(format!("{}: unknown gate action '{}'", name.key(), other));
                    continue;
                }
            }
        }
    }

    // ── Step producers ──────────────────────────────────────────────────────

    async fn produce_review(&mut self) -> Result<Vec<ValidationFinding>, String> {
        let base = self.base_branch();
        let guidelines = self
            .repo_cfg
            .as_ref()
            .and_then(|r| r.review_guidelines.clone());
        let ignored = self.ignored_findings(StepName::Review);
        let resume = self.reviewer_session_id.clone();
        let prompt = if resume.is_some() {
            prompts::re_review_prompt(&self.run.intent, &base, guidelines.as_deref(), &ignored)
        } else {
            prompts::review_prompt(&self.run.intent, &base, guidelines.as_deref())
        };

        let outcome = self.run_agent("review", prompt, resume).await?;
        if let Some(sid) = &outcome.sdk_session_id {
            self.reviewer_session_id = Some(sid.clone());
        }

        let mut findings = parse_findings(&outcome.structured);
        assign_agent_finding_ids(StepName::Review, &mut findings);

        // Adversarial verify each `error` finding.
        if self.run.options.adversarial_verify {
            findings = self.verify_error_findings(findings).await;
        }

        if let Some(step) = self.run.step_mut(StepName::Review) {
            step.transcript = outcome.transcript;
            step.risk_level = outcome
                .structured
                .get("risk_level")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            step.risk_rationale = outcome
                .structured
                .get("risk_rationale")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if let Some(summary) = outcome.structured.get("summary").and_then(|v| v.as_str()) {
                step.note = Some(summary.to_string());
            }
        }
        Ok(findings)
    }

    async fn verify_error_findings(
        &self,
        findings: Vec<ValidationFinding>,
    ) -> Vec<ValidationFinding> {
        let mut kept = Vec::new();
        for f in findings {
            if !matches!(f.severity, ValidationSeverity::Error) {
                kept.push(f);
                continue;
            }
            let prompt = prompts::verify_prompt(&f);
            match self.run_agent("verify", prompt, None).await {
                Ok(outcome) => {
                    let verdict = outcome
                        .structured
                        .get("verdict")
                        .and_then(|v| v.as_str())
                        .unwrap_or("confirmed");
                    if verdict.eq_ignore_ascii_case("refuted") {
                        self.log(format!("Verify refuted finding {} (dropped)", f.id));
                    } else {
                        kept.push(f);
                    }
                }
                // On verify error, keep the finding (fail-closed).
                Err(e) => {
                    self.log(format!("Verify errored for {} ({}); keeping", f.id, e));
                    kept.push(f);
                }
            }
        }
        kept
    }

    async fn produce_docs(&mut self) -> Result<Vec<ValidationFinding>, String> {
        let prompt = prompts::docs_prompt(&self.run.intent);
        let outcome = self.run_agent("docs", prompt, None).await?;
        let mut findings = parse_findings(&outcome.structured);
        assign_agent_finding_ids(StepName::Docs, &mut findings);
        if let Some(step) = self.run.step_mut(StepName::Docs) {
            step.transcript = outcome.transcript;
        }
        Ok(findings)
    }

    async fn produce_lint(&mut self) -> Result<Vec<ValidationFinding>, String> {
        // Configured lint command wins; otherwise use the lint agent.
        if let Some(cmd) = self.repo_command(|c| c.lint.clone()) {
            let (proof, non_zero, tail) = self.run_command(&cmd).await;
            if let Some(step) = self.run.step_mut(StepName::Lint) {
                step.proof = Some(proof);
            }
            let mut findings = Vec::new();
            if non_zero {
                findings.push(command_finding(
                    ValidationSeverity::Warning,
                    FindingAction::AutoFix,
                    format!("Lint command failed:\n{}", tail),
                ));
                assign_agent_finding_ids(StepName::Lint, &mut findings);
            }
            return Ok(findings);
        }

        let prompt = prompts::lint_prompt(&self.run.intent);
        let outcome = self.run_agent("lint", prompt, None).await?;
        let mut findings = parse_findings(&outcome.structured);
        assign_agent_finding_ids(StepName::Lint, &mut findings);
        if let Some(step) = self.run.step_mut(StepName::Lint) {
            step.transcript = outcome.transcript;
        }
        Ok(findings)
    }

    async fn produce_test(&mut self) -> Result<Vec<ValidationFinding>, String> {
        let mut findings = Vec::new();
        let mut ran_something = false;

        // 1. Configured test command.
        if let Some(cmd) = self.repo_command(|c| c.test.clone()) {
            ran_something = true;
            let (proof, non_zero, tail) = self.run_command(&cmd).await;
            if let Some(step) = self.run.step_mut(StepName::Test) {
                step.proof = Some(proof);
            }
            if non_zero {
                findings.push(command_finding(
                    ValidationSeverity::Error,
                    FindingAction::AutoFix,
                    format!("Test command failed:\n{}", tail),
                ));
            }
        }

        // 2. Evidence agent.
        if self.validation_cfg.evidence_enabled {
            ran_something = true;
            let prompt = prompts::evidence_prompt(&self.run.intent);
            match self.run_agent("evidence", prompt, None).await {
                Ok(outcome) => {
                    let mut evidence_findings = parse_findings(&outcome.structured);
                    findings.append(&mut evidence_findings);
                    if let Some(step) = self.run.step_mut(StepName::Test) {
                        step.transcript = outcome.transcript;
                        step.evidence = Some(parse_evidence(&outcome.structured));
                    }
                }
                Err(e) => return Err(format!("evidence agent: {}", e)),
            }
        }

        if !ran_something {
            // No command, evidence disabled → skip.
            if let Some(step) = self.run.step_mut(StepName::Test) {
                step.status = StepStatus::Skipped;
                step.note = Some("No test command configured and evidence disabled".to_string());
            }
            self.emit_update();
            return Ok(Vec::new());
        }

        assign_agent_finding_ids(StepName::Test, &mut findings);
        Ok(findings)
    }

    // ── Ship step ───────────────────────────────────────────────────────────

    async fn run_ship(&mut self) -> StepEnd {
        self.set_step_status(StepName::Ship, StepStatus::Running);
        let summary = self.validation_summary();
        let base_override = self.run.options.base_branch.clone();
        let proposal = match ship::compute_ship_proposal(
            &self.app,
            &self.cwd(),
            self.gh_user(),
            &self.run.intent,
            base_override.as_deref(),
            &summary,
        )
        .await
        {
            Ok(p) => p,
            Err(e) => return StepEnd::Failed(format!("ship: {}", e)),
        };

        // Always gate with the editable proposal.
        self.run.status = RunStatus::Gate;
        self.run.gate = Some(GateState {
            step: StepName::Ship,
            kind: "ship".to_string(),
            findings: Vec::new(),
            ship: Some(proposal.clone()),
            diff: None,
        });
        if let Some(step) = self.run.step_mut(StepName::Ship) {
            step.status = StepStatus::Gate;
        }
        self.emit_update();

        let signal = match self.await_gate().await {
            Some(s) => s,
            None => return StepEnd::Cancelled,
        };
        self.run.gate = None;

        let (commit_message, pr_title, pr_body) = match signal {
            RunSignal::Ship {
                commit_message,
                pr_title,
                pr_body,
            } => (commit_message, pr_title, pr_body),
            RunSignal::Respond { action, .. } if action == "skip" => {
                self.set_step_note(StepName::Ship, "Ship skipped by user");
                return StepEnd::Skipped;
            }
            _ => return StepEnd::Skipped,
        };

        // Apply user edits over the computed proposal.
        let mut final_proposal = proposal;
        if !commit_message.trim().is_empty() {
            final_proposal.commit_message = commit_message;
        }
        if !pr_title.trim().is_empty() {
            final_proposal.pr_title = pr_title;
        }
        if !pr_body.trim().is_empty() {
            final_proposal.pr_body = pr_body;
        }

        self.set_step_status(StepName::Ship, StepStatus::Running);
        self.log("ship: committing and pushing");
        match ship::execute_ship(&self.cwd(), self.gh_user(), &final_proposal).await {
            Ok(outcome) => {
                if let Some(url) = &outcome.pr_url {
                    self.run.pr_url = Some(url.clone());
                }
                if let Some(step) = self.run.step_mut(StepName::Ship) {
                    if !outcome.notes.is_empty() {
                        step.note = Some(outcome.notes.join("; "));
                    }
                }
                self.emit_update();
                StepEnd::Passed
            }
            Err(e) => {
                self.log(format!("ship: failed: {}", e));
                StepEnd::Failed(format!("ship: {}", e))
            }
        }
    }

    // ── CI step ─────────────────────────────────────────────────────────────

    async fn run_ci(&mut self) -> StepEnd {
        self.set_step_status(StepName::Ci, StepStatus::Running);
        let branch = match GitManager::get_current_branch(&self.cwd()) {
            Ok(b) => b,
            Err(e) => return StepEnd::Failed(format!("ci: {}", e)),
        };

        // Requires a PR (from ship or pre-existing).
        let pr = crate::commands::github_cmds::fetch_branch_pr_status(
            &self.cwd(),
            self.gh_user(),
            &branch,
        )
        .await
        .ok()
        .flatten();
        if pr.is_none() {
            self.set_step_note(StepName::Ci, "No PR for this branch; CI skipped");
            return StepEnd::Skipped;
        }

        let idle_timeout_ms = self.validation_cfg.ci_timeout_minutes as u64 * 60 * 1000;
        let started = now_ms();
        let mut last_change = started;
        let mut last_signature: Option<String> = None;
        let mut last_fixed_signature: Option<String> = None;
        let mut ci_fix_used = 0u32;
        let ci_limit = self.validation_cfg.auto_fix_limit("ci");

        loop {
            let elapsed = now_ms().saturating_sub(started);
            let interval = if elapsed > 5 * 60 * 1000 { 60 } else { 30 };
            tokio::time::sleep(std::time::Duration::from_secs(interval)).await;

            let pr = match crate::commands::github_cmds::fetch_branch_pr_status(
                &self.cwd(),
                self.gh_user(),
                &branch,
            )
            .await
            {
                Ok(Some(p)) => p,
                Ok(None) => {
                    self.set_step_note(StepName::Ci, "PR closed during CI polling");
                    return StepEnd::Passed;
                }
                Err(e) => {
                    self.log(format!("ci: poll error: {}", e));
                    continue;
                }
            };

            // Gate reconciliation: merged/closed out of band = done.
            if pr.state == "merged" || pr.state == "closed" {
                self.set_step_note(
                    StepName::Ci,
                    format!("PR {} during CI polling", pr.state),
                );
                return StepEnd::Passed;
            }

            let signature = ci_signature(&pr.checks);
            if last_signature.as_deref() != Some(&signature) {
                last_change = now_ms();
                last_signature = Some(signature.clone());
                self.log(format!("ci: {}", signature));
            }

            let all_settled = pr.checks.iter().all(|c| c.status != "pending");
            let failing: Vec<&crate::commands::github_cmds::GitHubPrCheck> = pr
                .checks
                .iter()
                .filter(|c| c.status == "fail")
                .collect();

            if all_settled && failing.is_empty() {
                self.set_step_note(StepName::Ci, "All checks passed");
                return StepEnd::Passed;
            }

            if all_settled && !failing.is_empty() {
                let fail_sig = failing
                    .iter()
                    .map(|c| c.name.clone())
                    .collect::<Vec<_>>()
                    .join(",");

                // Build findings from failing checks.
                let mut findings = Vec::new();
                for check in &failing {
                    let log_tail = self.fetch_ci_log(&check.name).await;
                    findings.push(command_finding(
                        ValidationSeverity::Error,
                        FindingAction::AutoFix,
                        format!("CI check '{}' failed\n{}", check.name, log_tail),
                    ));
                }
                assign_agent_finding_ids(StepName::Ci, &mut findings);
                self.set_step_findings(StepName::Ci, findings.clone());

                // Dedup: don't re-fix the same failing set twice in a row → gate.
                let same_as_last_fix = last_fixed_signature.as_deref() == Some(&fail_sig);
                if ci_fix_used < ci_limit && !same_as_last_fix {
                    self.record_round(StepName::Ci, "auto_fix", &findings, &[]);
                    match self
                        .request_fix(
                            StepName::Ci,
                            findings.clone(),
                            None,
                            ci_fix_used + 1,
                            "auto_fix",
                        )
                        .await
                    {
                        FixResult::Done(_) => {
                            // Commit + push the fix, then resume polling.
                            match GitManager::commit_all(&self.cwd(), "Fix CI failures").await {
                                Ok(_) => {
                                    if let Err(e) = GitManager::push(&self.cwd(), false).await {
                                        self.log(format!("ci: push after fix failed: {}", e));
                                    }
                                }
                                Err(e) => self.log(format!("ci: commit after fix failed: {}", e)),
                            }
                            ci_fix_used += 1;
                            last_fixed_signature = Some(fail_sig);
                            last_change = now_ms();
                            last_signature = None; // force a fresh signature log
                            self.set_step_status(StepName::Ci, StepStatus::Running);
                            continue;
                        }
                        FixResult::Failed(_) | FixResult::Cancelled => {
                            // Fall through to a gate below.
                        }
                    }
                }

                // Park a ci_failure gate.
                match self.ci_failure_gate(StepName::Ci, findings).await {
                    StepEnd::Passed => return StepEnd::Passed,
                    StepEnd::Skipped => return StepEnd::Skipped,
                    StepEnd::Cancelled => return StepEnd::Cancelled,
                    StepEnd::Failed(e) => return StepEnd::Failed(e),
                }
            }

            // Idle timeout → gate.
            if now_ms().saturating_sub(last_change) > idle_timeout_ms {
                self.log("ci: idle timeout reached");
                let findings = self
                    .run
                    .step_mut(StepName::Ci)
                    .map(|s| s.findings.clone())
                    .unwrap_or_default();
                match self.ci_failure_gate(StepName::Ci, findings).await {
                    StepEnd::Passed => return StepEnd::Passed,
                    StepEnd::Skipped => return StepEnd::Skipped,
                    StepEnd::Cancelled => return StepEnd::Cancelled,
                    StepEnd::Failed(e) => return StepEnd::Failed(e),
                }
            }
        }
    }

    /// Park a CI-failure gate (approve = accept as passed, skip = skip, fix =
    /// one more fix round then resume — resolved by re-entering the CI loop).
    async fn ci_failure_gate(
        &mut self,
        name: StepName,
        findings: Vec<ValidationFinding>,
    ) -> StepEnd {
        self.set_step_status(name, StepStatus::Gate);
        self.run.status = RunStatus::Gate;
        self.run.gate = Some(GateState {
            step: name,
            kind: "ci_failure".to_string(),
            findings: findings.clone(),
            ship: None,
            diff: None,
        });
        self.emit_update();

        let signal = match self.await_gate().await {
            Some(s) => s,
            None => return StepEnd::Cancelled,
        };
        self.run.gate = None;

        match signal {
            RunSignal::Respond { action, finding_ids, instructions, added_findings } => {
                match action.as_str() {
                    "approve" => StepEnd::Passed,
                    "skip" => {
                        self.set_step_note(name, "CI failures skipped by user");
                        StepEnd::Skipped
                    }
                    "fix" => {
                        let selected_ids = finding_ids.unwrap_or_default();
                        let mut to_fix: Vec<ValidationFinding> = findings
                            .iter()
                            .filter(|f| selected_ids.contains(&f.id))
                            .cloned()
                            .collect();
                        if let Some(added) = added_findings {
                            for (i, mut f) in added.into_iter().enumerate() {
                                if f.id.trim().is_empty() {
                                    f.id = format!("user-{}", i + 1);
                                }
                                f.source = "user".to_string();
                                to_fix.push(f);
                            }
                        }
                        if to_fix.is_empty() {
                            to_fix = findings;
                        }
                        match self.request_fix(name, to_fix, instructions, 1, "user_fix").await {
                            FixResult::Done(_) => {
                                match GitManager::commit_all(&self.cwd(), "Fix CI failures").await {
                                    Ok(_) => {
                                        let _ = GitManager::push(&self.cwd(), false).await;
                                    }
                                    Err(e) => self.log(format!("ci: commit after fix failed: {}", e)),
                                }
                                // Resume polling by re-entering the CI loop.
                                self.set_step_status(name, StepStatus::Running);
                                Box::pin(self.run_ci()).await
                            }
                            FixResult::Failed(_) | FixResult::Cancelled => StepEnd::Skipped,
                        }
                    }
                    _ => StepEnd::Skipped,
                }
            }
            _ => StepEnd::Skipped,
        }
    }

    async fn fetch_ci_log(&self, check_name: &str) -> String {
        // Best-effort: find a failing run id and fetch its failing logs.
        // `gh run list` for the branch, then `gh run view <id> --log-failed`.
        let branch = GitManager::get_current_branch(&self.cwd()).unwrap_or_default();
        let list_args: Vec<String> = vec![
            "run".into(),
            "list".into(),
            "--branch".into(),
            branch,
            "--json".into(),
            "databaseId,conclusion,name".into(),
            "--limit".into(),
            "20".into(),
        ];
        let runs = crate::commands::github_cmds::run_gh(&self.cwd(), self.gh_user(), &list_args)
            .await
            .ok();
        let run_id = runs.and_then(|s| find_failing_run_id(&s, check_name));
        let Some(run_id) = run_id else {
            return "(no CI logs available)".to_string();
        };
        let view_args: Vec<String> = vec![
            "run".into(),
            "view".into(),
            run_id,
            "--log-failed".into(),
        ];
        match crate::commands::github_cmds::run_gh(&self.cwd(), self.gh_user(), &view_args).await {
            Ok(log) => tail(&log, CI_LOG_TAIL),
            Err(e) => format!("(failed to fetch CI logs: {})", e),
        }
    }

    // ── Small helpers ───────────────────────────────────────────────────────

    fn base_branch(&self) -> String {
        if let Some(b) = self
            .run
            .options
            .base_branch
            .as_deref()
            .filter(|b| !b.trim().is_empty())
        {
            return b.strip_prefix("origin/").unwrap_or(b).to_string();
        }
        GitManager::get_default_remote_branch(&self.cwd())
            .map(|b| b.strip_prefix("origin/").unwrap_or(&b).to_string())
            .unwrap_or_else(|_| "main".to_string())
    }

    /// Extract a per-repo command via the accessor.
    fn repo_command(&self, f: impl Fn(&crate::config::ValidationCommands) -> Option<String>) -> Option<String> {
        self.repo_cfg
            .as_ref()
            .and_then(|r| r.validation_commands.as_ref())
            .and_then(f)
            .filter(|c| !c.trim().is_empty())
    }

    /// Run a shell command in the cwd, streaming lines to the log; returns
    /// (proof, non_zero_exit, output_tail).
    async fn run_command(&self, command: &str) -> (StepProof, bool, String) {
        self.log(format!("$ {}", command));
        let out = run_shell_async(Path::new(&self.cwd()), command).await;
        match out {
            Ok(o) => {
                let combined = if o.stderr.trim().is_empty() {
                    o.stdout.clone()
                } else {
                    format!("{}\n{}", o.stdout, o.stderr)
                };
                for line in combined.lines() {
                    self.log(line.to_string());
                }
                let tail_s = tail(&combined, OUTPUT_TAIL);
                let non_zero = !o.success;
                (
                    StepProof {
                        command: Some(command.to_string()),
                        exit_code: o.code,
                        output_tail: Some(tail_s.clone()),
                    },
                    non_zero,
                    tail_s,
                )
            }
            Err(e) => {
                self.log(format!("command failed to start: {}", e));
                (
                    StepProof {
                        command: Some(command.to_string()),
                        exit_code: None,
                        output_tail: Some(e.clone()),
                    },
                    true,
                    e,
                )
            }
        }
    }

    async fn git_head(&self) -> String {
        let out = run_command_async(
            "git",
            &["rev-parse".into(), "HEAD".into()],
            Some(Path::new(&self.cwd())),
            &[],
        )
        .await;
        match out {
            Ok(o) if o.success => o.stdout.trim().to_string(),
            _ => String::new(),
        }
    }

    /// Diff of everything changed since `pre_head`, plus untracked file names.
    async fn compute_fix_diff(&self, pre_head: &str) -> String {
        let cwd = self.cwd();
        let path = Path::new(&cwd);
        let mut out = String::new();
        if !pre_head.is_empty() {
            if let Ok(o) = run_command_async(
                "git",
                &["diff".into(), pre_head.to_string()],
                Some(path),
                &[],
            )
            .await
            {
                out.push_str(&o.stdout);
            }
        }
        if let Ok(o) = run_command_async(
            "git",
            &[
                "ls-files".into(),
                "--others".into(),
                "--exclude-standard".into(),
            ],
            Some(path),
            &[],
        )
        .await
        {
            let untracked = o.stdout.trim();
            if !untracked.is_empty() {
                out.push_str("\n\nUntracked files:\n");
                out.push_str(untracked);
            }
        }
        if out.trim().is_empty() {
            "(no changes detected)".to_string()
        } else {
            tail(&out, CI_LOG_TAIL)
        }
    }

    fn ignored_findings(&self, name: StepName) -> Vec<ValidationFinding> {
        // Findings the user approved/skipped over in prior rounds of this step.
        self.run
            .steps
            .iter()
            .find(|s| s.name == name)
            .map(|s| {
                s.rounds
                    .iter()
                    .flat_map(|r| r.findings.iter())
                    .filter(|f| !r_selected(s, f))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    }

    fn record_round(
        &mut self,
        name: StepName,
        trigger: &str,
        findings: &[ValidationFinding],
        selected_ids: &[String],
    ) {
        self.record_round_with_summary(name, trigger, findings, selected_ids, None);
    }

    fn record_round_with_summary(
        &mut self,
        name: StepName,
        trigger: &str,
        findings: &[ValidationFinding],
        selected_ids: &[String],
        fix_summary: Option<String>,
    ) {
        if let Some(step) = self.run.step_mut(name) {
            let round = step.rounds.len() as u32;
            step.rounds.push(StepRound {
                round,
                trigger: trigger.to_string(),
                findings: findings.to_vec(),
                selected_ids: selected_ids.to_vec(),
                fix_summary,
            });
        }
        self.emit_update();
    }

    fn set_step_findings(&mut self, name: StepName, findings: Vec<ValidationFinding>) {
        if let Some(step) = self.run.step_mut(name) {
            step.findings = findings;
        }
        self.emit_update();
    }

    fn set_step_note(&mut self, name: StepName, note: impl Into<String>) {
        if let Some(step) = self.run.step_mut(name) {
            step.note = Some(note.into());
        }
    }

    /// A compact per-step outcome summary used in the ship draft/PR body.
    fn validation_summary(&self) -> String {
        let mut lines = Vec::new();
        for step in &self.run.steps {
            let mut line = format!("- {}: {:?}", step.name.key(), step.status);
            if step.name == StepName::Review {
                if let Some(risk) = &step.risk_level {
                    line.push_str(&format!(" (risk: {})", risk));
                }
            }
            if let Some(ev) = &step.evidence {
                if !ev.testing_summary.trim().is_empty() {
                    line.push_str(&format!(" — {}", ev.testing_summary));
                }
                if !ev.artifacts.is_empty() {
                    let names: Vec<String> =
                        ev.artifacts.iter().map(|a| a.label.clone()).collect();
                    line.push_str(&format!(" [artifacts: {}]", names.join(", ")));
                }
            }
            lines.push(line);
        }
        lines.join("\n")
    }
}

// ── Free helpers ────────────────────────────────────────────────────────────

/// Whether a finding was among the round's selected (fixed) ids.
fn r_selected(step: &ValidationStep, finding: &ValidationFinding) -> bool {
    step.rounds
        .iter()
        .any(|r| r.selected_ids.contains(&finding.id))
}

/// Parse the `findings` array from a submit-tool structured output.
fn parse_findings(structured: &serde_json::Value) -> Vec<ValidationFinding> {
    let arr = match structured.get("findings").and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return Vec::new(),
    };
    arr.iter()
        .filter_map(|v| serde_json::from_value::<RawAgentFinding>(v.clone()).ok())
        .map(|r| r.into_finding())
        .collect()
}

/// Parse the evidence report from the evidence submit tool output.
fn parse_evidence(structured: &serde_json::Value) -> EvidenceReport {
    let tested = structured
        .get("tested")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let testing_summary = structured
        .get("testing_summary")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let artifacts = structured
        .get("artifacts")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| serde_json::from_value::<EvidenceArtifact>(v.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    EvidenceReport {
        tested,
        testing_summary,
        artifacts,
    }
}

/// Build a synthetic finding from a command/CI failure.
fn command_finding(
    severity: ValidationSeverity,
    action: FindingAction,
    description: String,
) -> ValidationFinding {
    ValidationFinding {
        id: String::new(),
        severity,
        file: None,
        line: None,
        description,
        action,
        source: "agent".to_string(),
        user_instructions: None,
    }
}

/// Last `n` characters of a string (char-safe).
fn tail(s: &str, n: usize) -> String {
    let count = s.chars().count();
    if count <= n {
        return s.to_string();
    }
    s.chars().skip(count - n).collect()
}

/// A stable signature of the current CI check states for change detection.
fn ci_signature(checks: &[crate::commands::github_cmds::GitHubPrCheck]) -> String {
    let mut parts: Vec<String> = checks
        .iter()
        .map(|c| format!("{}={}", c.name, c.status))
        .collect();
    parts.sort();
    parts.join(",")
}

/// Find the databaseId of a failing workflow run matching (or near) a check name.
fn find_failing_run_id(json: &str, check_name: &str) -> Option<String> {
    let arr: serde_json::Value = serde_json::from_str(json).ok()?;
    let runs = arr.as_array()?;
    // Prefer an exact/substring name match; else the first failing run.
    let pick = runs
        .iter()
        .find(|r| {
            let name = r.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let concl = r.get("conclusion").and_then(|v| v.as_str()).unwrap_or("");
            (name == check_name || check_name.contains(name) || name.contains(check_name))
                && concl == "failure"
        })
        .or_else(|| {
            runs.iter().find(|r| {
                r.get("conclusion").and_then(|v| v.as_str()) == Some("failure")
            })
        })?;
    pick.get("databaseId")
        .and_then(|v| v.as_i64())
        .map(|id| id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_findings_maps_and_fails_closed() {
        let structured = serde_json::json!({
            "findings": [
                { "severity": "error", "file": "a.rs", "description": "x", "action": "auto-fix" },
                { "severity": "info", "description": "y" }  // missing action -> ask-user
            ],
            "summary": "ok"
        });
        let findings = parse_findings(&structured);
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[0].action, FindingAction::AutoFix);
        assert_eq!(findings[1].action, FindingAction::AskUser);
    }

    #[test]
    fn parse_evidence_reads_fields() {
        let structured = serde_json::json!({
            "tested": ["login flow"],
            "testing_summary": "logged in ok",
            "artifacts": [{ "kind": "screenshot", "label": "login", "path": "/tmp/a.png" }]
        });
        let ev = parse_evidence(&structured);
        assert_eq!(ev.tested, vec!["login flow"]);
        assert_eq!(ev.testing_summary, "logged in ok");
        assert_eq!(ev.artifacts.len(), 1);
        assert_eq!(ev.artifacts[0].kind, "screenshot");
    }

    #[test]
    fn tail_is_char_safe() {
        assert_eq!(tail("hello", 3), "llo");
        assert_eq!(tail("hi", 5), "hi");
    }

    #[test]
    fn ci_signature_is_order_independent() {
        use crate::commands::github_cmds::GitHubPrCheck;
        let a = vec![
            GitHubPrCheck { name: "build".into(), status: "pass".into(), url: None },
            GitHubPrCheck { name: "test".into(), status: "fail".into(), url: None },
        ];
        let b = vec![
            GitHubPrCheck { name: "test".into(), status: "fail".into(), url: None },
            GitHubPrCheck { name: "build".into(), status: "pass".into(), url: None },
        ];
        assert_eq!(ci_signature(&a), ci_signature(&b));
    }

    #[test]
    fn find_failing_run_id_prefers_matching_failure() {
        let json = r#"[
            {"databaseId": 1, "conclusion": "success", "name": "build"},
            {"databaseId": 2, "conclusion": "failure", "name": "test"}
        ]"#;
        assert_eq!(find_failing_run_id(json, "test"), Some("2".to_string()));
        assert_eq!(find_failing_run_id(json, "unknown"), Some("2".to_string()));
    }
}
