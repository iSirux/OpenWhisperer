pub mod ai_generation;
pub mod event_triggers;
pub mod executor;
pub mod notifications;
pub mod persistence;
pub mod rate_limiter;
pub mod scheduler;
pub mod state;
pub mod template;
pub mod types;

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use self::event_triggers::EventTriggerManager;
use self::executor::SequenceExecutor;
use self::rate_limiter::SequenceRateLimiter;
use self::state::{ExecutionStatus, ExecutionSummary, SequenceExecution};
use self::types::SequenceDefinition;
use crate::sidecar::SidecarManager;

/// Central manager for sequence definitions and executions.
///
/// Holds the loaded definitions, active execution handles, and coordination
/// primitives (cancel flags, pause signals, approval channels).  Lives in
/// Tauri managed state so Tauri commands can access it.
pub struct SequenceManager {
    definitions: Mutex<Vec<SequenceDefinition>>,
    #[allow(dead_code)]
    executions: Mutex<HashMap<String, SequenceExecution>>,
    executor_handles: Mutex<HashMap<String, JoinHandle<()>>>,
    pause_signals: Mutex<HashMap<String, Arc<Notify>>>,
    cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub(crate) approval_channels: Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
    app: AppHandle,
    sidecar: Arc<SidecarManager>,
    pub(crate) rate_limiter: Arc<SequenceRateLimiter>,
    pub(crate) event_trigger_manager: Arc<EventTriggerManager>,
}

impl SequenceManager {
    pub fn new(
        app: AppHandle,
        sidecar: Arc<SidecarManager>,
        max_concurrent_prompts: usize,
        default_provider_rpm: u32,
    ) -> Self {
        Self {
            definitions: Mutex::new(Vec::new()),
            executions: Mutex::new(HashMap::new()),
            executor_handles: Mutex::new(HashMap::new()),
            pause_signals: Mutex::new(HashMap::new()),
            cancel_flags: Mutex::new(HashMap::new()),
            approval_channels: Mutex::new(HashMap::new()),
            rate_limiter: Arc::new(SequenceRateLimiter::new(
                max_concurrent_prompts,
                default_provider_rpm,
            )),
            event_trigger_manager: Arc::new(EventTriggerManager::new()),
            app,
            sidecar,
        }
    }

    // ─── Definition Management ───────────────────────────────────────────────

    /// Load all sequence definitions from disk.
    pub fn load_definitions(&self) -> Result<(), String> {
        let defs = persistence::load_definitions()?;
        *self.definitions.lock() = defs;
        Ok(())
    }

    /// Get all loaded definitions.
    pub fn get_definitions(&self) -> Vec<SequenceDefinition> {
        self.definitions.lock().clone()
    }

    /// Get a single definition by id.
    pub fn get_definition(&self, id: &str) -> Option<SequenceDefinition> {
        self.definitions.lock().iter().find(|d| d.id == id).cloned()
    }

    /// Save a definition to disk and reload.
    pub fn save_definition(&self, def: SequenceDefinition) -> Result<(), String> {
        persistence::save_definition(&def)?;
        self.load_definitions()
    }

    /// Delete a definition from disk and reload.
    pub fn delete_definition(&self, id: &str) -> Result<(), String> {
        persistence::delete_definition(id)?;
        self.load_definitions()
    }

    // ─── Execution Lifecycle ─────────────────────────────────────────────────

    /// Start a new execution of the given sequence.
    ///
    /// Returns the execution ID.  The execution runs in a background tokio task.
    pub fn start_execution(
        &self,
        sequence_id: &str,
        inputs: HashMap<String, serde_json::Value>,
        dry_run: bool,
    ) -> Result<String, String> {
        self.start_execution_at(sequence_id, inputs, dry_run, None)
    }

    /// Start execution with an optional pre-generated ID (for frontend callers
    /// that need to set up event listeners before execution begins).
    pub fn start_execution_with_id(
        &self,
        execution_id: Option<String>,
        sequence_id: &str,
        inputs: HashMap<String, serde_json::Value>,
        dry_run: bool,
        entry_node_id: Option<String>,
    ) -> Result<String, String> {
        self.start_execution_inner(execution_id, sequence_id, inputs, dry_run, entry_node_id)
    }

    /// Start execution at a specific entry node (used by triggers).
    pub fn start_execution_at(
        &self,
        sequence_id: &str,
        inputs: HashMap<String, serde_json::Value>,
        dry_run: bool,
        entry_node_id: Option<String>,
    ) -> Result<String, String> {
        self.start_execution_inner(None, sequence_id, inputs, dry_run, entry_node_id)
    }

    /// Shared implementation for all execution start paths.
    /// If `pre_id` is Some, uses that as the execution ID (frontend pre-generated).
    fn start_execution_inner(
        &self,
        pre_id: Option<String>,
        sequence_id: &str,
        inputs: HashMap<String, serde_json::Value>,
        dry_run: bool,
        entry_node_id: Option<String>,
    ) -> Result<String, String> {
        let definition = self
            .get_definition(sequence_id)
            .ok_or_else(|| format!("Sequence '{}' not found", sequence_id))?;

        let cancel_flag = Arc::new(AtomicBool::new(false));
        let pause_signal = Arc::new(Notify::new());

        let executor = SequenceExecutor::new(
            self.app.clone(),
            self.sidecar.clone(),
            self.rate_limiter.clone(),
        );
        let def_id = definition.id.clone();
        let def_name = definition.name.clone();
        let cancel = cancel_flag.clone();
        let pause = pause_signal.clone();

        // Use pre-generated ID from frontend, or generate one.
        let execution_id = pre_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        log::info!(
            "[sequence] start_execution_inner: id={}, sequence={}",
            execution_id,
            sequence_id
        );
        let exec_id = execution_id.clone();

        // Store coordination primitives
        self.cancel_flags
            .lock()
            .insert(execution_id.clone(), cancel_flag);
        self.pause_signals
            .lock()
            .insert(execution_id.clone(), pause_signal);

        // Emit a global execution-started event so the frontend can attach
        // per-execution listeners even for scheduler/event-triggered runs.
        let _ = self.app.emit(
            "sequence-execution-started",
            serde_json::json!({
                "execution_id": execution_id.clone(),
                "sequence_id": def_id,
                "sequence_name": def_name,
                "started_at": chrono::Utc::now().to_rfc3339(),
            }),
        );

        // Spawn the execution task
        let eid = execution_id.clone();
        let handle = tokio::spawn(async move {
            match executor
                .execute(
                    eid,
                    definition,
                    inputs,
                    dry_run,
                    cancel,
                    pause,
                    entry_node_id,
                )
                .await
            {
                Ok(id) => {
                    log::info!("[sequence] Execution {} completed", id);
                }
                Err(e) => {
                    log::error!("[sequence] Execution {} failed: {}", exec_id, e);
                }
            }
        });

        self.executor_handles
            .lock()
            .insert(execution_id.clone(), handle);

        Ok(execution_id)
    }

    /// Pause a running execution.
    ///
    /// Sets the paused flag so the executor blocks at the next node boundary.
    /// The pause signal is consumed by the executor loop which checks for it
    /// between nodes.
    pub fn pause_execution(&self, execution_id: &str) -> Result<(), String> {
        // Verify the execution exists
        if !self.pause_signals.lock().contains_key(execution_id) {
            return Err(format!("Execution '{}' not found", execution_id));
        }
        // Emit a status event so the frontend knows we're paused.
        // The executor will see the paused state and block on the pause signal.
        let _ = self.app.emit(
            &format!("sequence-status-{}", execution_id),
            serde_json::to_value(&ExecutionStatus::Paused).unwrap_or_default(),
        );
        Ok(())
    }

    /// Resume a paused execution.
    pub fn resume_execution(&self, execution_id: &str) -> Result<(), String> {
        if let Some(signal) = self.pause_signals.lock().get(execution_id) {
            signal.notify_one();
            Ok(())
        } else {
            Err(format!("Execution '{}' not found", execution_id))
        }
    }

    /// Cancel a running execution.
    pub fn cancel_execution(&self, execution_id: &str) -> Result<(), String> {
        if let Some(flag) = self.cancel_flags.lock().get(execution_id) {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
            // Also wake up if paused so it can observe the cancellation
            if let Some(signal) = self.pause_signals.lock().get(execution_id) {
                signal.notify_one();
            }
            Ok(())
        } else {
            Err(format!("Execution '{}' not found", execution_id))
        }
    }

    // ─── Approval ────────────────────────────────────────────────────────────

    /// Approve a waiting approval node.
    pub fn approve_node(&self, execution_id: &str, _node_id: &str) -> Result<(), String> {
        if let Some(tx) = self.approval_channels.lock().remove(execution_id) {
            let _ = tx.send(true);
            Ok(())
        } else {
            Err("No pending approval".to_string())
        }
    }

    /// Reject a waiting approval node.
    pub fn reject_node(
        &self,
        execution_id: &str,
        _node_id: &str,
        _reason: Option<String>,
    ) -> Result<(), String> {
        if let Some(tx) = self.approval_channels.lock().remove(execution_id) {
            let _ = tx.send(false);
            Ok(())
        } else {
            Err("No pending approval".to_string())
        }
    }

    /// Retry a failed node by re-starting the execution.
    ///
    /// This cancels the current (failed) execution and re-starts it from the
    /// failed node.  For now, we re-start the entire sequence since resuming
    /// mid-sequence requires snapshotting execution context.
    pub fn retry_node(&self, execution_id: &str, _node_id: &str) -> Result<(), String> {
        // Load the execution to get the sequence_id and inputs
        let exec = self.get_execution(execution_id)?;
        let sequence_id = exec.sequence_id;
        let inputs = exec.inputs;

        // Re-start the sequence
        self.start_execution(&sequence_id, inputs, false)?;
        Ok(())
    }

    // ─── Queries ─────────────────────────────────────────────────────────────

    /// List all execution summaries (persisted on disk).
    pub fn list_executions(&self) -> Result<Vec<ExecutionSummary>, String> {
        persistence::list_executions()
    }

    /// Load a specific execution from disk.
    pub fn get_execution(&self, exec_id: &str) -> Result<SequenceExecution, String> {
        persistence::load_execution(exec_id)
    }

    /// Delete an execution snapshot from disk (dismiss from history).
    pub fn dismiss_execution(&self, exec_id: &str) -> Result<(), String> {
        // Also clean up any in-memory state for this execution
        self.executions.lock().remove(exec_id);
        self.executor_handles.lock().remove(exec_id);
        self.pause_signals.lock().remove(exec_id);
        self.cancel_flags.lock().remove(exec_id);
        self.approval_channels.lock().remove(exec_id);
        persistence::delete_execution(exec_id)
    }

    // ─── Import / Export ─────────────────────────────────────────────────────

    /// Validate a YAML string as a sequence definition.
    pub fn validate_sequence(&self, yaml: &str) -> Result<SequenceDefinition, String> {
        serde_yaml::from_str::<SequenceDefinition>(yaml)
            .map_err(|e| format!("YAML parse error: {}", e))
    }

    /// Import a YAML string as a new sequence definition.
    pub fn import_sequence(&self, yaml: &str) -> Result<SequenceDefinition, String> {
        let def = self.validate_sequence(yaml)?;
        self.save_definition(def.clone())?;
        Ok(def)
    }

    /// Export a sequence definition as YAML.
    pub fn export_sequence(&self, id: &str) -> Result<String, String> {
        let def = self
            .get_definition(id)
            .ok_or_else(|| format!("Sequence '{}' not found", id))?;
        serde_yaml::to_string(&def).map_err(|e| format!("YAML export error: {}", e))
    }
}
