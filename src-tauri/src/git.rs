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
    ) -> Result<(), String> {
        let mut cmd = Command::new("git");
        cmd.args(["worktree", "add", "-b", branch_name, worktree_path])
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
        cmd.args(["checkout", branch_name])
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

    /// Create a worktree with full setup: copy files and run post-create commands
    pub fn create_worktree_with_setup(
        repo_path: &str,
        branch_name: &str,
        worktree_path: Option<&str>,
        copy_files: &[String],
        post_create_commands: &[String],
    ) -> Result<WorktreeCreationResult, String> {
        // Calculate worktree path if not provided
        let effective_path = match worktree_path {
            Some(p) => p.to_string(),
            None => Self::get_worktree_path(repo_path, branch_name),
        };

        // Create the worktree
        Self::create_worktree(repo_path, branch_name, &effective_path)?;

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
                std::fs::copy(&src, &dst)
                    .map_err(|e| format!("Failed to copy {}: {}", file, e))?;
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
                eprintln!(
                    "[git] Post-create command '{}' failed: {}",
                    cmd_str, stderr
                );
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
