//! Tauri commands for the `no-mistakes` git-push validation integration.
//! Thin wrappers that delegate to [`NoMistakesManager`]; all long-running work
//! happens in tasks spawned by the manager, which streams results back via
//! `nm-log`/`nm-status`/`nm-gate`/`nm-done` events.

use crate::no_mistakes::{NmCheckResult, NoMistakesManager};
use std::sync::Arc;
use tauri::{AppHandle, State};

/// Official installer entry points (see the no-mistakes installation guide).
#[cfg(target_os = "windows")]
const NM_INSTALL_URL: &str =
    "https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.ps1";
#[cfg(not(target_os = "windows"))]
const NM_INSTALL_URL: &str =
    "https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh";

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

/// Run `no-mistakes init` in `cwd` (non-interactive) — sets up the gate repo,
/// hooks, and the `no-mistakes` git remote. Returns the CLI's combined output.
#[tauri::command]
pub async fn nm_init(
    manager: State<'_, Arc<NoMistakesManager>>,
    cwd: String,
) -> Result<String, String> {
    manager.init_repo(cwd).await
}

/// Run the official no-mistakes installer in a visible terminal window. The
/// user watches it complete there, then re-checks from the app; the freshly
/// installed binary is found via its known install location even though this
/// process' PATH predates the install (see `no_mistakes::nm_bin`).
#[tauri::command]
pub fn nm_install() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use crate::config::AppConfig;
        use std::process::Command;

        // A script file (single argument to `start cmd /k`) avoids the outer
        // cmd re-parsing the `|` in the installer one-liner.
        let dir = AppConfig::config_dir();
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
        let script = format!(
            "@echo off\r\n\
             echo === OpenWhisperer: installing no-mistakes ===\r\n\
             powershell -NoProfile -ExecutionPolicy Bypass -Command \"irm {url} | iex\"\r\n\
             if errorlevel 1 goto :fail\r\n\
             echo.\r\n\
             echo === Done. Return to OpenWhisperer and click \"Check again\". ===\r\n\
             goto :eof\r\n\
             :fail\r\n\
             echo.\r\n\
             echo *** FAILED - see the errors above. ***\r\n",
            url = NM_INSTALL_URL,
        );
        let path = dir.join("install-no-mistakes.cmd");
        std::fs::write(&path, script)
            .map_err(|e| format!("Failed to write install script: {}", e))?;
        Command::new("cmd")
            .args(["/c", "start", "cmd", "/k", &path.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        super::settings_cmds::run_in_terminal(format!("curl -fsSL {} | sh", NM_INSTALL_URL))
    }
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
