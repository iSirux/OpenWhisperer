//! Sequence execution engine.
//!
//! Split out of a former 3,100-line god-file into:
//! - [`engine`] — the orchestration loop (broken into named phases), node
//!   dispatch, retry/error handling, cleanup, finalize, event emission.
//! - [`nodes`] — one submodule per node-type family, each an `impl SequenceExecutor`
//!   block.
//!
//! The [`SequenceExecutor`] struct and its shared state live here (in the parent
//! module) so every submodule can reach its private fields.

mod engine;
mod nodes;

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{AppHandle, Manager};

use crate::config::AppConfig;
use crate::llm::LlmClient;
use crate::sequences::error::SequenceError;
use crate::sequences::rate_limiter::SequenceRateLimiter;
use crate::sequences::state::{LogLevel, TokenUsage};
use crate::sequences::template::TemplateEngine;
use crate::sequences::types::SequenceDefaults;
use crate::sidecar::SidecarManager;

// ─── AI Node Metadata ────────────────────────────────────────────────────────

/// Captured metadata from AI node executions (prompt nodes, route AI nodes).
struct AiNodeLog {
    node_id: String,
    level: LogLevel,
    message: String,
}

struct AiNodeUsage {
    tokens: TokenUsage,
    cost: f64,
}

/// State shared between a parent executor and any child executors it spawns for
/// parallel / foreach branches.
///
/// Hoisting `ai_logs`/`ai_usage` here (behind an `Arc`) fixes the correctness bug
/// where child executors accumulated AI logs and usage into their own throwaway
/// maps, so the parent drained nothing — AI cost accounting for anything inside a
/// parallel/foreach/subsequence node silently vanished (finding S2).
///
/// `defaults` carries the sequence-level `SequenceDefaults` so node executors can
/// fall back to them (model/effort/timeout — finding S10).
pub(crate) struct ExecutorShared {
    ai_logs: Mutex<Vec<AiNodeLog>>,
    ai_usage: Mutex<HashMap<String, AiNodeUsage>>,
    defaults: Mutex<SequenceDefaults>,
}

impl ExecutorShared {
    fn new() -> Self {
        Self {
            ai_logs: Mutex::new(Vec::new()),
            ai_usage: Mutex::new(HashMap::new()),
            defaults: Mutex::new(SequenceDefaults::default()),
        }
    }
}

// ─── SequenceExecutor ────────────────────────────────────────────────────────

/// The execution engine for sequence definitions.
///
/// Drives node-by-node execution through a sequence, handling retries,
/// conditions, error strategies, cleanup, and event emission.
pub struct SequenceExecutor {
    pub(crate) app: AppHandle,
    pub(crate) sidecar: Arc<SidecarManager>,
    pub(crate) rate_limiter: Arc<SequenceRateLimiter>,
    pub(crate) shared: Arc<ExecutorShared>,
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
            shared: Arc::new(ExecutorShared::new()),
        }
    }

    /// Create a child executor that **shares** this executor's AI sink and
    /// defaults (used for parallel / foreach branches so logs and usage flow
    /// back to the parent — finding S2).
    pub(crate) fn child(&self) -> Self {
        Self {
            app: self.app.clone(),
            sidecar: self.sidecar.clone(),
            rate_limiter: self.rate_limiter.clone(),
            shared: self.shared.clone(),
        }
    }

    // ─── AI Logging Helpers ────────────────────────────────────────────────

    /// Push a log entry for an AI node execution. Accumulated during node
    /// execution and drained in the main loop for persistence + emission.
    pub(crate) fn push_ai_log(&self, node_id: &str, level: LogLevel, message: String) {
        self.shared.ai_logs.lock().push(AiNodeLog {
            node_id: node_id.to_string(),
            level,
            message,
        });
    }

    /// Store captured token usage for a node (from sdk-usage events).
    pub(crate) fn store_ai_usage(&self, node_id: &str, tokens: TokenUsage, cost: f64) {
        self.shared
            .ai_usage
            .lock()
            .insert(node_id.to_string(), AiNodeUsage { tokens, cost });
    }
}

// ─── Template helpers (typed errors) ─────────────────────────────────────────

/// Render a template string, tagging failures as [`SequenceError::Template`] so
/// the retry logic never retries an authoring bug (finding T1).
pub(crate) fn render(template_str: &str, context: &serde_json::Value) -> Result<String, SequenceError> {
    TemplateEngine::render(template_str, context).map_err(SequenceError::template)
}

pub(crate) fn eval_bool(expr: &str, context: &serde_json::Value) -> Result<bool, SequenceError> {
    TemplateEngine::eval_bool(expr, context).map_err(SequenceError::template)
}

pub(crate) fn eval_string(expr: &str, context: &serde_json::Value) -> Result<String, SequenceError> {
    TemplateEngine::eval_string(expr, context).map_err(SequenceError::template)
}

// ─── Context helpers ─────────────────────────────────────────────────────────

/// Resolve the working directory from context (`repo.path`) or fall back to the
/// current directory.  Deduplicated from an inline copy in `execute_prompt`
/// (finding S11).
pub(crate) fn resolve_cwd(context: &serde_json::Value) -> String {
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

/// Clone `context` into an object map and insert extra entries — the "build an
/// augmented context" pattern that was written out 4× (finding S11).
pub(crate) fn with_extra(
    context: &serde_json::Value,
    entries: Vec<(&str, serde_json::Value)>,
) -> serde_json::Value {
    let mut map = match context.clone() {
        serde_json::Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    for (k, v) in entries {
        map.insert(k.to_string(), v);
    }
    serde_json::Value::Object(map)
}

/// Resolve repository paths from a list that may contain `tagged:X` syntax.
#[allow(dead_code)]
pub(crate) fn resolve_repos(repo_specs: &[String], app: &AppHandle) -> Vec<String> {
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

/// Create an LLM client from the app's managed config state.
/// Thin wrapper around the shared `crate::llm::client_from_config` (T5).
pub(crate) fn create_llm_client_from_app(app: &AppHandle) -> Result<LlmClient, String> {
    let config: tauri::State<parking_lot::Mutex<AppConfig>> = app
        .try_state()
        .ok_or_else(|| "App config not available".to_string())?;
    let cfg = config.lock().clone();
    crate::llm::client_from_config(app, &cfg)
}

// ─── Process helper ──────────────────────────────────────────────────────────

/// Run a program asynchronously via the shared [`crate::proc`] helpers, mapping
/// spawn failures to [`SequenceError::Command`].  Centralizes the T2 command
/// runner adoption for git / gh nodes.
pub(crate) async fn run_prog(
    program: &str,
    args: &[&str],
    cwd: &str,
) -> Result<crate::proc::ProcOutput, SequenceError> {
    let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    crate::proc::run_command_async(program, &owned, Some(std::path::Path::new(cwd)), &[])
        .await
        .map_err(SequenceError::command)
}
