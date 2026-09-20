use crate::config::{AppConfig, LaunchCommand};
use crate::launch::LaunchManager;
use parking_lot::Mutex;
use std::sync::Arc;
use tauri::State;

type ConfigState = Mutex<AppConfig>;

/// Launch a specific profile by its ID for a given repo.
/// `cwd` overrides the repo's configured path as the working directory (e.g. a worktree).
#[tauri::command]
pub fn launch_profile(
    launch_mgr: State<Arc<LaunchManager>>,
    config: State<ConfigState>,
    repo_id: String,
    profile_id: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let cfg = config.lock();
    let repo = cfg
        .repos
        .iter()
        .find(|r| r.id.as_deref() == Some(&repo_id))
        .ok_or_else(|| format!("Repo not found: {}", repo_id))?;

    let profile = repo
        .launch_profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Profile not found: {}", profile_id))?;

    let commands_to_launch: Vec<LaunchCommand> = profile
        .command_ids
        .iter()
        .filter_map(|cid| repo.launch_commands.iter().find(|c| c.id == *cid))
        .cloned()
        .collect();

    if commands_to_launch.is_empty() {
        return Err("No commands found for this profile".to_string());
    }

    // Use the provided cwd override (worktree path) if given, otherwise fall back to the repo's configured path.
    let repo_path = cwd.unwrap_or_else(|| repo.path.clone());
    let terminal = cfg.system.launch_terminal.clone();
    let task_options = (profile.execution_type == crate::config::LaunchExecutionType::Task)
        .then_some(profile.close_on_success);
    drop(cfg);

    launch_mgr.launch_commands(
        &repo_id,
        &repo_path,
        &commands_to_launch,
        &terminal,
        task_options,
    )
}

/// Launch specific commands directly (for ad-hoc subset launches)
#[tauri::command]
pub fn launch_commands(
    launch_mgr: State<Arc<LaunchManager>>,
    config: State<ConfigState>,
    repo_id: String,
    repo_path: String,
    commands: Vec<LaunchCommand>,
) -> Result<(), String> {
    let terminal = config.lock().system.launch_terminal.clone();
    launch_mgr.launch_commands(&repo_id, &repo_path, &commands, &terminal, None)
}

/// Stop all running processes for a given repo
#[tauri::command]
pub fn stop_launch_profile(
    launch_mgr: State<Arc<LaunchManager>>,
    repo_id: String,
) -> Result<(), String> {
    launch_mgr.stop_all(&repo_id)
}

/// Get the list of currently running command IDs for a repo
#[tauri::command]
pub fn get_launch_status(launch_mgr: State<Arc<LaunchManager>>, repo_id: String) -> Vec<String> {
    launch_mgr.get_running_command_ids(&repo_id)
}

#[tauri::command]
pub fn get_launch_task_status(
    launch_mgr: State<Arc<LaunchManager>>,
    repo_id: String,
) -> crate::launch::TaskStatus {
    launch_mgr.task_status(&repo_id)
}
