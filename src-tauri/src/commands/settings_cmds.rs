use crate::config::{AppConfig, ConfigLoadReport, RepoConfig};
use crate::git::GitManager;
use crate::ConfigLoadStatus;
use parking_lot::Mutex;
use std::fs;
use std::process::Command;
use tauri::State;

pub type ConfigState = Mutex<AppConfig>;

#[tauri::command]
pub fn get_config(config: State<ConfigState>) -> AppConfig {
    config.lock().clone()
}

/// Returns how the config load from disk went: whether it succeeded, the
/// fatal error when it fell back to defaults, and any non-fatal warnings
/// (skipped repo entries, missing repo folders).
#[tauri::command]
pub fn get_config_load_status(status: State<ConfigLoadStatus>) -> ConfigLoadReport {
    status.0.lock().clone()
}

/// Re-reads the config file from disk without restarting the app. On success
/// the managed config is replaced and saves are unblocked; on failure the
/// in-memory config is left untouched and the new failure report is returned.
#[tauri::command]
pub fn reload_config(
    config: State<ConfigState>,
    load_status: State<ConfigLoadStatus>,
) -> ConfigLoadReport {
    log::info!("[config.reload] Reloading config from disk");
    let (new_config, report) = AppConfig::load();
    if report.loaded_ok {
        *config.lock() = new_config;
        log::info!("[config.reload] Config reloaded successfully; saves unblocked");
    } else if let Some(err) = &report.error {
        log::error!("[config.reload] {}", err);
    }
    *load_status.0.lock() = report.clone();
    report
}

/// Returns the path to the config file and its parent directory.
#[tauri::command]
pub fn get_config_paths() -> (String, String) {
    let config_path = AppConfig::config_path();
    let config_dir = AppConfig::config_dir();
    (
        config_path.to_string_lossy().to_string(),
        config_dir.to_string_lossy().to_string(),
    )
}

/// Opens the config directory in the system's file explorer.
#[tauri::command]
pub fn open_config_folder() -> Result<(), String> {
    let dir = AppConfig::config_dir();

    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Failed to open config folder: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Failed to open config folder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Failed to open config folder: {}", e))?;
    }

    Ok(())
}

/// Opens the config file in the system's default editor.
#[tauri::command]
pub fn open_config_file() -> Result<(), String> {
    let path = AppConfig::config_path();

    if !path.exists() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config directory: {}", e))?;
        }

        let content = serde_json::to_string_pretty(&AppConfig::default())
            .map_err(|e| format!("Failed to serialize default config: {}", e))?;
        fs::write(&path, content).map_err(|e| format!("Failed to create config file: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/c", "start", "", &path.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("Failed to open config file: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open config file: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open config file: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn save_config(
    config: State<ConfigState>,
    load_status: State<ConfigLoadStatus>,
    new_config: AppConfig,
) -> Result<(), String> {
    // Block saves if the config was loaded from defaults due to a parse error
    let loaded_ok = load_status.0.lock().loaded_ok;
    if !loaded_ok {
        return Err(
            "Config was loaded from defaults due to a parse error — refusing to overwrite. \
             Please fix your config file manually or delete it to start fresh."
                .to_string(),
        );
    }

    // Mutate under the lock, then persist a snapshot after releasing it so the
    // mutex is never held across the fsync-ing disk write (T7).
    let snapshot = {
        let mut cfg = config.lock();
        *cfg = new_config;
        cfg.clone()
    };
    snapshot.save()
}

/// Replaces the config with built-in defaults and persists it. Repositories
/// (list, active index, auto mode) are preserved — they're user data managed
/// by dedicated commands, not settings. `redo_onboarding` controls whether the
/// first-run wizard shows again. Writing a known-good default config also
/// clears a failed-load state, unblocking saves.
#[tauri::command]
pub fn reset_config(
    config: State<ConfigState>,
    load_status: State<ConfigLoadStatus>,
    redo_onboarding: bool,
) -> Result<AppConfig, String> {
    log::info!(
        "[config.reset] Restoring default settings (redo_onboarding: {})",
        redo_onboarding
    );
    let snapshot = {
        let mut cfg = config.lock();
        let mut fresh = AppConfig::default();
        fresh.repos = std::mem::take(&mut cfg.repos);
        fresh.active_repo_index = cfg.active_repo_index;
        fresh.auto_repo_mode = cfg.auto_repo_mode;
        fresh.onboarding_completed = !redo_onboarding;
        *cfg = fresh;
        cfg.clone()
    };
    snapshot.save()?;
    *load_status.0.lock() = ConfigLoadReport {
        loaded_ok: true,
        error: None,
        warnings: Vec::new(),
    };
    Ok(snapshot)
}

#[tauri::command]
pub fn add_repo(config: State<ConfigState>, path: String, name: String) -> Result<(), String> {
    log::info!("[add_repo] Called with path: {}, name: {}", path, name);
    let mut cfg = config.lock();
    cfg.repos.push(RepoConfig {
        id: Some(uuid::Uuid::new_v4().to_string()),
        path: path.clone(),
        name: name.clone(),
        description: None,
        keywords: None,
        vocabulary: None,
        icon: None,
        color: None,
        mcp_servers: None,
        tags: Vec::new(),
        active: true,
        worktree_copy_files: Vec::new(),
        worktree_post_create_commands: Vec::new(),
        worktree_base_branch: None,
        worktree_mode: "main".to_string(),
        launch_commands: Vec::new(),
        launch_profiles: Vec::new(),
        github_url: None,
        gh_user: None,
        account_ids: Vec::new(),
    });
    log::info!(
        "[add_repo] Repo added to config, total repos: {}",
        cfg.repos.len()
    );
    let snapshot = cfg.clone();
    drop(cfg);
    let result = snapshot.save();
    match &result {
        Ok(()) => log::info!("[add_repo] Config saved successfully"),
        Err(e) => log::info!("[add_repo] Failed to save config: {}", e),
    }
    result
}

#[tauri::command]
pub fn remove_repo(config: State<ConfigState>, index: usize) -> Result<(), String> {
    let mut cfg = config.lock();
    if index < cfg.repos.len() {
        cfg.repos.remove(index);
        if cfg.active_repo_index >= cfg.repos.len() && !cfg.repos.is_empty() {
            cfg.active_repo_index = cfg.repos.len() - 1;
        }
        let snapshot = cfg.clone();
        drop(cfg);
        snapshot.save()
    } else {
        Err("Invalid repo index".to_string())
    }
}

#[tauri::command]
pub fn set_active_repo(config: State<ConfigState>, index: usize) -> Result<(), String> {
    let mut cfg = config.lock();
    if index >= cfg.repos.len() {
        return Err("Invalid repo index".to_string());
    }
    if !cfg.repos[index].active {
        return Err("Cannot select an inactive repository".to_string());
    }
    cfg.active_repo_index = index;
    cfg.auto_repo_mode = false; // Disable auto mode when selecting specific repo
    let snapshot = cfg.clone();
    drop(cfg);
    snapshot.save()
}

#[tauri::command]
pub fn set_auto_repo_mode(config: State<ConfigState>, enabled: bool) -> Result<(), String> {
    let mut cfg = config.lock();
    cfg.auto_repo_mode = enabled;
    let snapshot = cfg.clone();
    drop(cfg);
    snapshot.save()
}

#[tauri::command]
pub fn set_repo_active(
    config: State<ConfigState>,
    index: usize,
    active: bool,
) -> Result<(), String> {
    let mut cfg = config.lock();
    if index >= cfg.repos.len() {
        return Err("Invalid repo index".to_string());
    }

    cfg.repos[index].active = active;

    // If deactivating the currently active repo, switch to next active repo or auto mode
    if !active && cfg.active_repo_index == index {
        let next_active = cfg
            .repos
            .iter()
            .enumerate()
            .find(|(i, r)| *i != index && r.active)
            .map(|(i, _)| i);

        match next_active {
            Some(next_idx) => {
                cfg.active_repo_index = next_idx;
            }
            None => {
                cfg.auto_repo_mode = true;
            }
        }
    }

    let snapshot = cfg.clone();
    drop(cfg);
    snapshot.save()
}

#[tauri::command]
pub fn get_active_repo(config: State<ConfigState>) -> Option<RepoConfig> {
    let cfg = config.lock();
    cfg.get_active_repo().cloned()
}

#[tauri::command]
pub fn get_git_branch(repo_path: String) -> Result<String, String> {
    GitManager::get_current_branch(&repo_path)
}

/// Run a command in a new terminal window (cross-platform)
#[tauri::command]
pub fn run_in_terminal(command: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Windows: Use cmd /c start to open a new command prompt window
        Command::new("cmd")
            .args(["/c", "start", "cmd", "/k", &command])
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        // macOS: Use osascript to tell Terminal to run the command
        let script = format!(
            r#"tell application "Terminal"
                activate
                do script "{}"
            end tell"#,
            command.replace("\"", "\\\"")
        );
        Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Linux: Try common terminal emulators in order of preference
        let shell_cmd = format!("{}; exec bash", command);
        let wrapped_cmd = format!("bash -c '{}; exec bash'", command);
        let terminals = [
            ("gnome-terminal", vec!["--", "bash", "-c", &shell_cmd]),
            ("konsole", vec!["-e", "bash", "-c", &shell_cmd]),
            ("xfce4-terminal", vec!["-e", &wrapped_cmd]),
            ("xterm", vec!["-e", &wrapped_cmd]),
        ];

        let mut launched = false;
        for (term, args) in terminals {
            if Command::new(term).args(&args).spawn().is_ok() {
                launched = true;
                break;
            }
        }

        if !launched {
            return Err("No supported terminal emulator found. Please install gnome-terminal, konsole, xfce4-terminal, or xterm.".to_string());
        }
    }

    Ok(())
}
