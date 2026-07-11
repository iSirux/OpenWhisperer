use crate::commands::usage_cmds::UsageStatsState;
use crate::config::AppConfig;
use crate::git::{GitManager, WorktreeCreationResult, WorktreeInfo, WorktreeSetupStepResult};
use parking_lot::Mutex;
use tauri::{AppHandle, State};

type ConfigState = Mutex<AppConfig>;

/// List all worktrees for a repository
#[tauri::command]
pub fn list_git_worktrees(repo_path: String) -> Result<Vec<WorktreeInfo>, String> {
    GitManager::list_worktrees(&repo_path)
}

/// Count uncommitted changed files in a repo/worktree (working-tree changes,
/// like VS Code). Returns 0 when the path is not a git repo or has no changes.
#[tauri::command]
pub async fn get_git_changed_count(repo_path: String) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || GitManager::count_changed_files(&repo_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

/// Count uncommitted changed files summed across a repo's main worktree and all
/// its linked worktrees. Returns 0 when the path is not a git repo.
#[tauri::command]
pub async fn get_git_changed_count_all_worktrees(repo_path: String) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || GitManager::count_changed_files_all_worktrees(&repo_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

/// Create a new worktree with full setup (copy files, run post-create commands)
#[tauri::command]
pub async fn create_git_worktree_with_setup(
    repo_path: String,
    branch_name: String,
    worktree_path: Option<String>,
    copy_files: Vec<String>,
    post_create_commands: Vec<String>,
    base_branch: Option<String>,
) -> Result<WorktreeCreationResult, String> {
    // Run in a blocking task since git operations and shell commands are blocking
    tokio::task::spawn_blocking(move || {
        GitManager::create_worktree_with_setup(
            &repo_path,
            &branch_name,
            worktree_path.as_deref(),
            &copy_files,
            &post_create_commands,
            base_branch.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Create a new worktree without post-setup (copy files / commands)
#[tauri::command]
pub async fn create_git_worktree_only(
    repo_path: String,
    branch_name: String,
    worktree_path: Option<String>,
    base_branch: Option<String>,
) -> Result<WorktreeCreationResult, String> {
    tokio::task::spawn_blocking(move || {
        GitManager::create_worktree_only(&repo_path, &branch_name, worktree_path.as_deref(), base_branch.as_deref())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Run post-setup on an existing worktree (copy files, run commands)
#[tauri::command]
pub async fn run_worktree_post_setup(
    repo_path: String,
    worktree_path: String,
    copy_files: Vec<String>,
    post_create_commands: Vec<String>,
) -> Result<Vec<WorktreeSetupStepResult>, String> {
    Ok(tokio::task::spawn_blocking(move || {
        GitManager::run_worktree_post_setup(&repo_path, &worktree_path, &copy_files, &post_create_commands)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?)
}

/// Generate a branch name for a new worktree using LLM (with fallback)
#[tauri::command]
pub async fn generate_worktree_branch_name(
    app: AppHandle,
    config: State<'_, ConfigState>,
    stats: State<'_, UsageStatsState>,
    prompt: String,
    repo_path: String,
) -> Result<String, String> {
    let cfg = config.lock().clone();

    // Check if LLM branch naming is enabled
    if !cfg.llm.features.generate_branch_names {
        return Ok(GitManager::generate_unique_branch_name(&prompt, &repo_path));
    }

    // Get existing branches to avoid conflicts
    let existing_branches = GitManager::list_branches(&repo_path).unwrap_or_default();

    // Try LLM-generated name first. `client_from_config` errors for non-local
    // providers with no key (falls through to the fallback), and allows an empty
    // key for the Local provider.
    if cfg.llm.enabled {
        if let Ok(client) = crate::llm::client_from_config(&app, &cfg) {
            // Truncate prompt to 10k chars (char-safe) for branch naming.
            let truncated_prompt = crate::util::truncate_chars(&prompt, 10000);

            match client
                .generate_branch_name_with_usage(&truncated_prompt, &existing_branches)
                .await
            {
                Ok(result) => {
                    // Track LLM usage
                    let mut s = stats.lock();
                    s.track_llm_token_usage(
                        "branch_name",
                        result.usage.input_tokens,
                        result.usage.output_tokens,
                    );
                    let _ = s.save();

                    let name = result.data.branch_name;

                    // Validate the name: must be non-empty, no spaces, reasonable length
                    if !name.is_empty()
                        && !name.contains(' ')
                        && name.len() <= 80
                        && !existing_branches.contains(&name)
                    {
                        return Ok(name);
                    }
                    // If LLM returned something invalid, fall through to fallback
                }
                Err(e) => {
                    log::error!("[git] LLM branch name generation failed: {}", e);
                    // Fall through to fallback
                }
            }
        }
    }

    // Fallback: auto-generated name
    Ok(GitManager::generate_unique_branch_name(&prompt, &repo_path))
}

/// Open a path in VS Code
#[tauri::command]
pub fn open_in_vscode(path: String) -> Result<(), String> {
    use std::process::Command;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        Command::new("cmd")
            .args(["/c", "code", &path])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("Failed to open VS Code: {}", e))?;
    }

    #[cfg(not(windows))]
    {
        Command::new("code")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open VS Code: {}", e))?;
    }

    Ok(())
}

/// Open a terminal at a specific path
#[tauri::command]
pub fn open_in_terminal(path: String) -> Result<(), String> {
    use std::process::Command;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        Command::new("cmd")
            .args(["/c", "start", "cmd", "/k", &format!("cd /d \"{}\"", path)])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            r#"tell application "Terminal"
                activate
                do script "cd '{}'"
            end tell"#,
            path.replace("'", "'\\''")
        );
        Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        let xterm_cmd = format!("cd '{}' && bash", path);
        let terminals = [
            ("gnome-terminal", vec!["--working-directory", &path]),
            ("konsole", vec!["--workdir", &path]),
            ("xfce4-terminal", vec!["--working-directory", &path]),
            ("xterm", vec!["-e", &xterm_cmd]),
        ];

        let mut launched = false;
        for (term, args) in terminals {
            if Command::new(term).args(&args).spawn().is_ok() {
                launched = true;
                break;
            }
        }

        if !launched {
            return Err(
                "No supported terminal emulator found (tried gnome-terminal, konsole, xfce4-terminal, xterm)"
                    .to_string(),
            );
        }
    }

    Ok(())
}

/// Open a file explorer at a specific path
#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    use std::process::Command;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        Command::new("explorer")
            .arg(&path)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        let openers = ["xdg-open", "nautilus", "dolphin", "thunar", "nemo"];
        let mut launched = false;
        for opener in openers {
            if Command::new(opener).arg(&path).spawn().is_ok() {
                launched = true;
                break;
            }
        }
        if !launched {
            return Err("No supported file manager found".to_string());
        }
    }

    Ok(())
}
