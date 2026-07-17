//! Tauri commands for the native Validation pipeline. Thin wrappers over
//! [`ValidationManager`]; all long-running work happens in the per-run tokio task
//! the manager spawns, which streams results back via `validation-update`,
//! `validation-log`, and `validation-fix-request` events.

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::validation::types::{RunOptions, ValidationFinding, ValidationRun};
use crate::validation::ValidationManager;

/// Start a validation run for a session. The run id is generated backend-side
/// and returned. Errors if the session already has an active run.
///
/// All commands here are `async` so they run on the tokio runtime — the manager
/// spawns the per-run task with `tokio::spawn`, which panics (and takes the app
/// down) when called from the sync-command thread pool.
#[tauri::command]
pub async fn validation_start_run(
    app: AppHandle,
    manager: State<'_, Arc<ValidationManager>>,
    session_id: String,
    cwd: String,
    repo_id: Option<String>,
    intent: String,
    options: RunOptions,
) -> Result<String, String> {
    let run_id = format!("validation-{}", uuid::Uuid::new_v4());
    manager
        .inner()
        .start_run(app, run_id, session_id, cwd, repo_id, intent, options)
}

/// Return the current full snapshot of a run — the same shape the
/// `validation-update-{run_id}` event carries — so the frontend can resync any
/// initial state emitted before its listeners were attached.
#[tauri::command]
pub async fn validation_get_run(
    manager: State<'_, Arc<ValidationManager>>,
    run_id: String,
) -> Result<ValidationRun, String> {
    manager.get_run(&run_id)
}

/// Answer a findings / fix_review / ci_failure gate (`approve` | `skip` | `fix`).
#[tauri::command]
pub async fn validation_respond(
    manager: State<'_, Arc<ValidationManager>>,
    run_id: String,
    action: String,
    finding_ids: Option<Vec<String>>,
    instructions: Option<String>,
    added_findings: Option<Vec<ValidationFinding>>,
) -> Result<(), String> {
    manager
        .respond(run_id, action, finding_ids, instructions, added_findings)
}

/// Answer a "ship" gate: commit / push / open PR with the (edited) proposal.
#[tauri::command]
pub async fn validation_execute_ship(
    manager: State<'_, Arc<ValidationManager>>,
    run_id: String,
    commit_message: String,
    pr_title: String,
    pr_body: String,
) -> Result<(), String> {
    manager
        .execute_ship(run_id, commit_message, pr_title, pr_body)
}

/// Report that the session's fix turn finished (drives the pending fix loop).
#[tauri::command]
pub async fn validation_fix_done(
    manager: State<'_, Arc<ValidationManager>>,
    run_id: String,
    fix_summary: Option<String>,
) -> Result<(), String> {
    manager.fix_done(run_id, fix_summary)
}

/// Report that the session's fix turn errored (backend turns the step into a gate).
#[tauri::command]
pub async fn validation_fix_failed(
    manager: State<'_, Arc<ValidationManager>>,
    run_id: String,
    error: String,
) -> Result<(), String> {
    manager.fix_failed(run_id, error)
}

/// Cancel a run (never interrupts an in-flight session turn).
#[tauri::command]
pub async fn validation_cancel(
    app: AppHandle,
    manager: State<'_, Arc<ValidationManager>>,
    run_id: String,
) -> Result<(), String> {
    manager.inner().cancel(app, run_id)
}
