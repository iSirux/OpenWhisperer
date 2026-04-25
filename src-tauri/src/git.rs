use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Information about a git worktree
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
    pub is_main: bool,
    pub is_detached: bool,
}

/// Result of creating a worktree with setup
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeCreationResult {
    pub worktree_path: String,
    pub branch: String,
}

/// Result of a single worktree post-setup step
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeSetupStepResult {
    pub description: String,
    pub success: bool,
    pub output: Option<String>,
}

#[allow(dead_code)]
pub struct GitManager;

#[allow(dead_code)]
impl GitManager {
    pub fn is_git_repo(path: &str) -> bool {
        Path::new(path).join(".git").exists()
    }

    pub fn get_current_branch(repo_path: &str) -> Result<String, String> {
        let mut cmd = Command::new("git");
        cmd.args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(repo_path);

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    pub fn create_branch(repo_path: &str, branch_name: &str) -> Result<(), String> {
        let mut cmd = Command::new("git");
        cmd.args(["checkout", "-b", branch_name])
            .current_dir(repo_path);

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        Ok(())
    }

    pub fn create_worktree(
        repo_path: &str,
        branch_name: &str,
        worktree_path: &str,
        start_point: Option<&str>,
    ) -> Result<(), String> {
        let mut cmd = Command::new("git");
        // Use --no-track to prevent the new branch from automatically tracking the
        // start point (e.g., origin/master). Without this, `git push` would push
        // directly to the base branch instead of the feature branch's own remote.
        let mut args = vec![
            "worktree",
            "add",
            "--no-track",
            "-b",
            branch_name,
            worktree_path,
        ];
        if let Some(sp) = start_point {
            args.push(sp);
        }
        cmd.args(&args).current_dir(repo_path);

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        Ok(())
    }

    /// Detect the default remote branch (e.g., "origin/main" or "origin/master")
    pub fn get_default_remote_branch(repo_path: &str) -> Result<String, String> {
        // Try git symbolic-ref refs/remotes/origin/HEAD first
        let mut cmd = Command::new("git");
        cmd.args(["symbolic-ref", "refs/remotes/origin/HEAD"])
            .current_dir(repo_path);

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        if let Ok(output) = cmd.output() {
            if output.status.success() {
                let full_ref = String::from_utf8_lossy(&output.stdout).trim().to_string();
                // Convert refs/remotes/origin/main → origin/main
                if let Some(short) = full_ref.strip_prefix("refs/remotes/") {
                    return Ok(short.to_string());
                }
            }
        }

        // Fallback: check if origin/main or origin/master exists
        for candidate in &["origin/main", "origin/master"] {
            let mut cmd = Command::new("git");
            cmd.args(["rev-parse", "--verify", candidate])
                .current_dir(repo_path);

            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);

            if let Ok(output) = cmd.output() {
                if output.status.success() {
                    return Ok(candidate.to_string());
                }
            }
        }

        Err(
            "Could not detect remote default branch. Set a base branch in repo settings."
                .to_string(),
        )
    }

    /// Fetch the latest from remote for a given branch ref
    pub fn fetch_remote(repo_path: &str, remote_branch: &str) -> Result<(), String> {
        // Extract the branch name from "origin/main" → "main"
        let branch = remote_branch
            .strip_prefix("origin/")
            .unwrap_or(remote_branch);

        let mut cmd = Command::new("git");
        cmd.args(["fetch", "origin", branch]).current_dir(repo_path);

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run git fetch: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            log::warn!("[git] Fetch failed (will proceed anyway): {}", stderr);
            // Don't fail — the user might be offline; we'll still use whatever ref is available locally
        }

        Ok(())
    }

    pub fn remove_worktree(repo_path: &str, worktree_path: &str) -> Result<(), String> {
        let mut cmd = Command::new("git");
        cmd.args(["worktree", "remove", worktree_path, "--force"])
            .current_dir(repo_path);

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        Ok(())
    }

    pub fn merge_branch(repo_path: &str, branch_name: &str) -> Result<(), String> {
        let mut cmd = Command::new("git");
        cmd.args(["merge", branch_name, "--no-edit"])
            .current_dir(repo_path);

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        Ok(())
    }

    pub fn checkout_branch(repo_path: &str, branch_name: &str) -> Result<(), String> {
        let mut cmd = Command::new("git");
        cmd.args(["checkout", branch_name]).current_dir(repo_path);

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        Ok(())
    }

    pub fn delete_branch(repo_path: &str, branch_name: &str) -> Result<(), String> {
        let mut cmd = Command::new("git");
        cmd.args(["branch", "-D", branch_name])
            .current_dir(repo_path);

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        Ok(())
    }

    /// List all existing branches in the repo
    pub fn list_branches(repo_path: &str) -> Result<Vec<String>, String> {
        let mut cmd = Command::new("git");
        cmd.args(["branch", "--list", "--format=%(refname:short)"])
            .current_dir(repo_path);

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect())
    }

    /// List all worktrees for a repository using `git worktree list --porcelain`
    pub fn list_worktrees(repo_path: &str) -> Result<Vec<WorktreeInfo>, String> {
        let mut cmd = Command::new("git");
        cmd.args(["worktree", "list", "--porcelain"])
            .current_dir(repo_path);

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut worktrees = Vec::new();
        let mut current_path: Option<String> = None;
        let mut current_branch: Option<String> = None;
        let mut is_bare = false;
        let mut is_detached = false;

        for line in stdout.lines() {
            if line.starts_with("worktree ") {
                // Save previous entry if any
                if let Some(path) = current_path.take() {
                    worktrees.push(WorktreeInfo {
                        path: path.clone(),
                        branch: current_branch.take(),
                        is_main: worktrees.is_empty(), // First worktree is always the main one
                        is_detached,
                    });
                }
                current_path = Some(line.strip_prefix("worktree ").unwrap().to_string());
                current_branch = None;
                is_bare = false;
                is_detached = false;
            } else if line.starts_with("branch ") {
                let full_ref = line.strip_prefix("branch ").unwrap();
                // Convert refs/heads/branch-name → branch-name
                current_branch = Some(
                    full_ref
                        .strip_prefix("refs/heads/")
                        .unwrap_or(full_ref)
                        .to_string(),
                );
            } else if line == "bare" {
                is_bare = true;
            } else if line == "detached" {
                is_detached = true;
            } else if line.is_empty() {
                // Block separator — handled by "worktree " prefix of next block
            }
        }

        // Don't forget the last entry
        if let Some(path) = current_path.take() {
            worktrees.push(WorktreeInfo {
                path,
                branch: current_branch.take(),
                is_main: worktrees.is_empty(),
                is_detached,
            });
        }

        // Mark bare worktrees as main too (shouldn't normally appear but be safe)
        if is_bare {
            if let Some(last) = worktrees.last_mut() {
                last.is_main = true;
            }
        }

        Ok(worktrees)
    }

    /// Create a worktree without running post-setup (copy files / commands).
    pub fn create_worktree_only(
        repo_path: &str,
        branch_name: &str,
        worktree_path: Option<&str>,
        base_branch: Option<&str>,
    ) -> Result<WorktreeCreationResult, String> {
        let effective_path = match worktree_path {
            Some(p) => p.to_string(),
            None => Self::get_worktree_path(repo_path, branch_name),
        };
        let start_point = match base_branch.filter(|b| !b.is_empty()) {
            Some(b) => Some(b.to_string()),
            None => Self::get_default_remote_branch(repo_path).ok(),
        };
        if let Some(ref sp) = start_point {
            let _ = Self::fetch_remote(repo_path, sp);
        }
        Self::create_worktree(repo_path, branch_name, &effective_path, start_point.as_deref())?;
        Ok(WorktreeCreationResult { worktree_path: effective_path, branch: branch_name.to_string() })
    }

    /// Run post-setup on an existing worktree: copy files and run commands.
    pub fn run_worktree_post_setup(
        repo_path: &str,
        worktree_path: &str,
        copy_files: &[String],
        post_create_commands: &[String],
    ) -> Vec<WorktreeSetupStepResult> {
        let mut results = Vec::new();
        for file in copy_files {
            let src = Path::new(repo_path).join(file);
            let dst = Path::new(worktree_path).join(file);
            if src.exists() {
                if let Some(parent) = dst.parent() {
                    if !parent.exists() { let _ = std::fs::create_dir_all(parent); }
                }
                match std::fs::copy(&src, &dst) {
                    Ok(_) => results.push(WorktreeSetupStepResult { description: format!("Copy {}", file), success: true, output: None }),
                    Err(e) => results.push(WorktreeSetupStepResult { description: format!("Copy {}", file), success: false, output: Some(e.to_string()) }),
                }
            }
        }
        for cmd_str in post_create_commands {
            let mut cmd;
            #[cfg(windows)]
            { cmd = Command::new("cmd"); cmd.args(["/c", cmd_str]); }
            #[cfg(not(windows))]
            { cmd = Command::new("sh"); cmd.args(["-c", cmd_str]); }
            cmd.current_dir(worktree_path);
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);
            match cmd.output() {
                Ok(output) => {
                    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                    let combined = if stderr.is_empty() { stdout } else { format!("{}\n{}", stdout, stderr) };
                    results.push(WorktreeSetupStepResult {
                        description: cmd_str.clone(),
                        success: output.status.success(),
                        output: if combined.trim().is_empty() { None } else { Some(combined.trim().to_string()) },
                    });
                }
                Err(e) => results.push(WorktreeSetupStepResult { description: cmd_str.clone(), success: false, output: Some(e.to_string()) }),
            }
        }
        results
    }

    /// Create a worktree with full setup: copy files and run post-create commands
    pub fn create_worktree_with_setup(
        repo_path: &str,
        branch_name: &str,
        worktree_path: Option<&str>,
        copy_files: &[String],
        post_create_commands: &[String],
        base_branch: Option<&str>,
    ) -> Result<WorktreeCreationResult, String> {
        // Calculate worktree path if not provided
        let effective_path = match worktree_path {
            Some(p) => p.to_string(),
            None => Self::get_worktree_path(repo_path, branch_name),
        };

        // Resolve the start point: use provided base_branch, or auto-detect
        let start_point = match base_branch.filter(|b| !b.is_empty()) {
            Some(b) => Some(b.to_string()),
            None => Self::get_default_remote_branch(repo_path).ok(),
        };

        // Fetch latest from remote before creating the worktree
        if let Some(ref sp) = start_point {
            let _ = Self::fetch_remote(repo_path, sp);
        }

        // Create the worktree
        Self::create_worktree(
            repo_path,
            branch_name,
            &effective_path,
            start_point.as_deref(),
        )?;

        // Copy files from main worktree
        for file in copy_files {
            let src = Path::new(repo_path).join(file);
            let dst = Path::new(&effective_path).join(file);

            if src.exists() {
                // Create parent directories if needed
                if let Some(parent) = dst.parent() {
                    if !parent.exists() {
                        std::fs::create_dir_all(parent).map_err(|e| {
                            format!("Failed to create directory for {}: {}", file, e)
                        })?;
                    }
                }
                std::fs::copy(&src, &dst).map_err(|e| format!("Failed to copy {}: {}", file, e))?;
            }
            // Silently skip missing files — user may list files that only exist in some repos
        }

        // Run post-create commands
        for cmd_str in post_create_commands {
            let mut cmd;
            #[cfg(windows)]
            {
                cmd = Command::new("cmd");
                cmd.args(["/c", cmd_str]);
            }
            #[cfg(not(windows))]
            {
                cmd = Command::new("sh");
                cmd.args(["-c", cmd_str]);
            }

            cmd.current_dir(&effective_path);

            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);

            let output = cmd
                .output()
                .map_err(|e| format!("Failed to run post-create command '{}': {}", cmd_str, e))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                log::error!("[git] Post-create command '{}' failed: {}", cmd_str, stderr);
                // Don't fail the whole operation — the worktree is already created
                // Log the error but continue with remaining commands
            }
        }

        Ok(WorktreeCreationResult {
            worktree_path: effective_path,
            branch: branch_name.to_string(),
        })
    }

    /// Generate a fallback branch name from a prompt (used when LLM is unavailable)
    pub fn generate_branch_name(prompt: &str) -> String {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let slug: String = prompt
            .chars()
            .filter(|c| c.is_alphanumeric() || c.is_whitespace())
            .take(40)
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("-")
            .to_lowercase();

        if slug.is_empty() {
            format!("session-{}", timestamp)
        } else {
            format!("{}-{}", slug, timestamp)
        }
    }

    /// Generate a branch name that doesn't conflict with existing branches
    pub fn generate_unique_branch_name(prompt: &str, repo_path: &str) -> String {
        let base_name = Self::generate_branch_name(prompt);

        // Check for conflicts (unlikely with timestamp, but be safe)
        let existing = Self::list_branches(repo_path).unwrap_or_default();
        if !existing.contains(&base_name) {
            return base_name;
        }

        // Append a counter if there's somehow a conflict
        for i in 2..100 {
            let candidate = format!("{}-{}", base_name, i);
            if !existing.contains(&candidate) {
                return candidate;
            }
        }

        base_name
    }

    pub fn get_worktree_path(repo_path: &str, branch_name: &str) -> String {
        let repo_dir = Path::new(repo_path);
        let parent = repo_dir.parent().unwrap_or(repo_dir);
        let repo_name = repo_dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("repo");

        let sanitized_branch = branch_name.replace('/', "-");
        parent
            .join(format!("{}-worktrees", repo_name))
            .join(&sanitized_branch)
            .to_string_lossy()
            .to_string()
    }
}
