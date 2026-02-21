use crate::config::{AppConfig, RepoConfig};
use crate::git::GitManager;
use tauri::State;
use parking_lot::Mutex;
use std::process::Command;

pub type ConfigState = Mutex<AppConfig>;

#[tauri::command]
pub fn get_config(config: State<ConfigState>) -> AppConfig {
    config.lock().clone()
}

#[tauri::command]
pub fn save_config(config: State<ConfigState>, new_config: AppConfig) -> Result<(), String> {
    let mut cfg = config.lock();
    *cfg = new_config;
    cfg.save()
}

#[tauri::command]
pub fn add_repo(config: State<ConfigState>, path: String, name: String) -> Result<(), String> {
    println!("[add_repo] Called with path: {}, name: {}", path, name);
    let mut cfg = config.lock();
    cfg.repos.push(RepoConfig { path: path.clone(), name: name.clone(), description: None, keywords: None, vocabulary: None, mcp_servers: None, note_mcp_servers: None });
    println!("[add_repo] Repo added to config, total repos: {}", cfg.repos.len());
    let result = cfg.save();
    match &result {
        Ok(()) => println!("[add_repo] Config saved successfully"),
        Err(e) => println!("[add_repo] Failed to save config: {}", e),
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
        cfg.save()
    } else {
        Err("Invalid repo index".to_string())
    }
}

#[tauri::command]
pub fn set_active_repo(config: State<ConfigState>, index: usize) -> Result<(), String> {
    let mut cfg = config.lock();
    if index < cfg.repos.len() {
        cfg.active_repo_index = index;
        cfg.auto_repo_mode = false; // Disable auto mode when selecting specific repo
        cfg.save()
    } else {
        Err("Invalid repo index".to_string())
    }
}

#[tauri::command]
pub fn set_auto_repo_mode(config: State<ConfigState>, enabled: bool) -> Result<(), String> {
    let mut cfg = config.lock();
    cfg.auto_repo_mode = enabled;
    cfg.save()
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
        let terminals = [
            ("gnome-terminal", vec!["--", "bash", "-c", &format!("{}; exec bash", command)]),
            ("konsole", vec!["-e", "bash", "-c", &format!("{}; exec bash", command)]),
            ("xfce4-terminal", vec!["-e", &format!("bash -c '{}; exec bash'", command)]),
            ("xterm", vec!["-e", &format!("bash -c '{}; exec bash'", command)]),
        ];

        let mut launched = false;
        for (term, args) in terminals {
            if Command::new(term)
                .args(&args)
                .spawn()
                .is_ok()
            {
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
