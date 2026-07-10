//! Tauri commands for the `no-mistakes` git-push validation integration.
//! Thin wrappers that delegate to [`NoMistakesManager`]; all long-running work
//! happens in tasks spawned by the manager, which streams results back via
//! `nm-log`/`nm-status`/`nm-gate`/`nm-done` events.

use crate::no_mistakes::{NmCheckResult, NoMistakesManager};
use std::sync::Arc;
use tauri::{AppHandle, State};

/// Probe the environment for a run's `cwd`: binary installed, version, and
/// whether `axi status` currently succeeds.
#[tauri::command]
pub async fn nm_check(
    manager: State<'_, Arc<NoMistakesManager>>,
    cwd: String,
) -> Result<NmCheckResult, String> {
    Ok(manager.check(cwd).await)
}

/// Start a validation run. Errors if the id is taken or another run is active
/// for the same `cwd`.
#[tauri::command]
pub async fn nm_start_run(
    app: AppHandle,
    manager: State<'_, Arc<NoMistakesManager>>,
    run_id: String,
    cwd: String,
    intent: String,
) -> Result<(), String> {
    manager.inner().start_run(app, run_id, cwd, intent)
}

/// Resolve a decision gate for a run (`approve`/`fix`/`skip`, optional findings).
#[tauri::command]
pub async fn nm_respond(
    app: AppHandle,
    manager: State<'_, Arc<NoMistakesManager>>,
    run_id: String,
    action: String,
    findings: Vec<String>,
) -> Result<(), String> {
    manager.inner().respond(app, run_id, action, findings)
}

/// Cancel a run: kill its live child, emit a cancelled `nm-done`, remove it.
#[tauri::command]
pub async fn nm_cancel(
    app: AppHandle,
    manager: State<'_, Arc<NoMistakesManager>>,
    run_id: String,
) -> Result<(), String> {
    manager.inner().cancel(app, run_id)
}
