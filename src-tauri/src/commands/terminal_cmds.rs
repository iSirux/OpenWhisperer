use crate::config::AppConfig;
use crate::terminal::{TerminalManager, TerminalSession};
use parking_lot::Mutex;
use std::sync::Arc;
use tauri::{AppHandle, State};

pub type TerminalState = Arc<TerminalManager>;
pub type ConfigState = Mutex<AppConfig>;

#[tauri::command]
pub fn create_terminal_session(
    app: AppHandle,
    terminal_manager: State<TerminalState>,
    config: State<ConfigState>,
    prompt: String,
) -> Result<String, String> {
    let cfg = config.lock();

    let repo = cfg
        .get_active_repo()
        .ok_or("No active repository configured")?;

    // CWD is now resolved by the frontend (main repo path or worktree path).
    // The old git branch/worktree creation logic has been replaced by
    // per-session worktree selection in the session setup UI.
    let working_path = repo.path.clone();

    let model = Some(cfg.default_model.clone());
    let terminal_mode = cfg.get_effective_terminal_mode();
    let sdk_provider = cfg.sdk_provider.clone();
    let skip_permissions = cfg.skip_permissions;
    drop(cfg);

    terminal_manager.create_session(
        app,
        working_path,
        prompt,
        model,
        terminal_mode,
        sdk_provider,
        skip_permissions,
    )
}

#[tauri::command]
pub fn create_interactive_session(
    app: AppHandle,
    terminal_manager: State<TerminalState>,
    config: State<ConfigState>,
) -> Result<String, String> {
    use crate::config::TerminalMode;

    let cfg = config.lock();

    let repo = cfg
        .get_active_repo()
        .ok_or("No active repository configured")?;

    let working_path = repo.path.clone();
    let model = Some(cfg.default_model.clone());
    let sdk_provider = cfg.sdk_provider.clone();
    let effective_mode = cfg.get_effective_terminal_mode();
    let skip_permissions = cfg.skip_permissions;
    drop(cfg);

    // Use provider-aware PTY mode. For Claude, keep interactive behavior.
    // For OpenAI App Server mode, launch codex app-server.
    let launch_mode = if effective_mode == TerminalMode::CodexAppServer {
        TerminalMode::CodexAppServer
    } else {
        TerminalMode::Interactive
    };
    terminal_manager.create_session(
        app,
        working_path,
        String::new(), // Empty prompt - user types directly
        model,
        launch_mode,
        sdk_provider,
        skip_permissions,
    )
}

#[tauri::command]
pub fn write_to_terminal(
    terminal_manager: State<TerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    terminal_manager.write_to_session(&session_id, &data)
}

#[tauri::command]
pub fn resize_terminal(
    terminal_manager: State<TerminalState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    terminal_manager.resize_session(&session_id, rows, cols)
}

#[tauri::command]
pub fn close_terminal(
    terminal_manager: State<TerminalState>,
    session_id: String,
) -> Result<(), String> {
    terminal_manager.close_session(&session_id)
}

#[tauri::command]
pub fn get_terminal_sessions(terminal_manager: State<TerminalState>) -> Vec<TerminalSession> {
    terminal_manager.get_sessions()
}

#[tauri::command]
pub fn get_terminal_session(
    terminal_manager: State<TerminalState>,
    session_id: String,
) -> Option<TerminalSession> {
    terminal_manager.get_session(&session_id)
}
