use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::proc::{run_git, run_shell};

/// Errors from git operations. Kept internal; converted to `String` at the
/// command boundary (all public `GitManager` methods return `Result<_, String>`
/// for Tauri compatibility) via `impl From<GitError> for String`.
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    /// A git invocation failed; carries the trimmed stderr / spawn error.
    #[error("{0}")]
    Command(String),
    #[error("Could not detect remote default branch. Set a base branch in repo settings.")]
    NoRemoteDefault,
}

impl From<GitError> for String {
    fn from(e: GitError) -> String {
        e.to_string()
    }
}

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

pub struct GitManager;

impl GitManager {
    /// Run `git <args>` in `repo_path`, mapping proc errors into [`GitError`].
    fn git(repo_path: &str, args: &[&str]) -> Result<String, GitError> {
        run_git(repo_path, args).map_err(GitError::Command)
    }

    pub fn get_current_branch(repo_path: &str) -> Result<String, String> {
        Ok(Self::git(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"])?)
    }

    pub fn create_branch(repo_path: &str, branch_name: &str) -> Result<(), String> {
        Self::git(repo_path, &["checkout", "-b", branch_name])?;
        Ok(())
    }

    pub fn create_worktree(
        repo_path: &str,
        branch_name: &str,
        worktree_path: &str,
        start_point: Option<&str>,
    ) -> Result<(), String> {
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
        Self::git(repo_path, &args)?;
        Ok(())
    }

    /// Detect the default remote branch (e.g., "origin/main" or "origin/master")
    pub fn get_default_remote_branch(repo_path: &str) -> Result<String, String> {
        // Try git symbolic-ref refs/remotes/origin/HEAD first
        if let Ok(full_ref) = Self::git(repo_path, &["symbolic-ref", "refs/remotes/origin/HEAD"]) {
            // Convert refs/remotes/origin/main → origin/main
            if let Some(short) = full_ref.strip_prefix("refs/remotes/") {
                return Ok(short.to_string());
            }
        }

        // Fallback: check if origin/main or origin/master exists
        for candidate in &["origin/main", "origin/master"] {
            if Self::git(repo_path, &["rev-parse", "--verify", candidate]).is_ok() {
                return Ok(candidate.to_string());
            }
        }

        Err(GitError::NoRemoteDefault.into())
    }

    /// Fetch the latest from remote for a given branch ref. Non-fatal: logs and
    /// returns Ok on failure (the user may be offline).
    pub fn fetch_remote(repo_path: &str, remote_branch: &str) -> Result<(), String> {
        // Extract the branch name from "origin/main" → "main"
        let branch = remote_branch
            .strip_prefix("origin/")
            .unwrap_or(remote_branch);

        if let Err(e) = Self::git(repo_path, &["fetch", "origin", branch]) {
            log::warn!("[git] Fetch failed (will proceed anyway): {}", e);
            // Don't fail — we'll still use whatever ref is available locally.
        }

        Ok(())
    }

    pub fn remove_worktree(repo_path: &str, worktree_path: &str) -> Result<(), String> {
        Self::git(repo_path, &["worktree", "remove", worktree_path, "--force"])?;
        Ok(())
    }

    pub fn checkout_branch(repo_path: &str, branch_name: &str) -> Result<(), String> {
        Self::git(repo_path, &["checkout", branch_name])?;
        Ok(())
    }

    /// List all existing branches in the repo
    pub fn list_branches(repo_path: &str) -> Result<Vec<String>, String> {
        let stdout = Self::git(
            repo_path,
            &["branch", "--list", "--format=%(refname:short)"],
        )?;
        Ok(stdout
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect())
    }

    /// List all worktrees for a repository using `git worktree list --porcelain`
    pub fn list_worktrees(repo_path: &str) -> Result<Vec<WorktreeInfo>, String> {
        let stdout = Self::git(repo_path, &["worktree", "list", "--porcelain"])?;

        let mut worktrees = Vec::new();
        let mut current_path: Option<String> = None;
        let mut current_branch: Option<String> = None;
        let mut is_detached = false;

        for line in stdout.lines() {
            if let Some(path) = line.strip_prefix("worktree ") {
                // Save previous entry if any
                if let Some(prev_path) = current_path.take() {
                    worktrees.push(WorktreeInfo {
                        path: prev_path,
                        branch: current_branch.take(),
                        is_main: worktrees.is_empty(), // First worktree is always the main one
                        is_detached,
                    });
                }
                current_path = Some(path.to_string());
                current_branch = None;
                is_detached = false;
            } else if let Some(full_ref) = line.strip_prefix("branch ") {
                // Convert refs/heads/branch-name → branch-name
                current_branch = Some(
                    full_ref
                        .strip_prefix("refs/heads/")
                        .unwrap_or(full_ref)
                        .to_string(),
                );
            } else if line == "detached" {
                is_detached = true;
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
        Ok(WorktreeCreationResult {
            worktree_path: effective_path,
            branch: branch_name.to_string(),
        })
    }

    /// Shared post-setup for a worktree: copy files from `src_base` into the
    /// worktree, then run each post-create command in the worktree. Each step is
    /// collected as a [`WorktreeSetupStepResult`]; the pass never aborts (the
    /// worktree already exists, so partial failures are reported, not fatal).
    fn apply_worktree_setup(
        src_base: &str,
        worktree_path: &str,
        copy_files: &[String],
        post_create_commands: &[String],
    ) -> Vec<WorktreeSetupStepResult> {
        let mut results = Vec::new();

        for file in copy_files {
            let src = Path::new(src_base).join(file);
            let dst = Path::new(worktree_path).join(file);
            // Silently skip missing files — user may list files that only exist in some repos.
            if !src.exists() {
                continue;
            }
            if let Some(parent) = dst.parent() {
                if !parent.exists() {
                    let _ = std::fs::create_dir_all(parent);
                }
            }
            match std::fs::copy(&src, &dst) {
                Ok(_) => results.push(WorktreeSetupStepResult {
                    description: format!("Copy {}", file),
                    success: true,
                    output: None,
                }),
                Err(e) => results.push(WorktreeSetupStepResult {
                    description: format!("Copy {}", file),
                    success: false,
                    output: Some(e.to_string()),
                }),
            }
        }

        for cmd_str in post_create_commands {
            match run_shell(Path::new(worktree_path), cmd_str) {
                Ok(out) => {
                    let stdout = out.stdout;
                    let stderr = out.stderr;
                    let combined = if stderr.trim().is_empty() {
                        stdout
                    } else {
                        format!("{}\n{}", stdout, stderr)
                    };
                    results.push(WorktreeSetupStepResult {
                        description: cmd_str.clone(),
                        success: out.success,
                        output: if combined.trim().is_empty() {
                            None
                        } else {
                            Some(combined.trim().to_string())
                        },
                    });
                }
                Err(e) => results.push(WorktreeSetupStepResult {
                    description: cmd_str.clone(),
                    success: false,
                    output: Some(e),
                }),
            }
        }

        results
    }

    /// Run post-setup on an existing worktree: copy files and run commands.
    pub fn run_worktree_post_setup(
        repo_path: &str,
        worktree_path: &str,
        copy_files: &[String],
        post_create_commands: &[String],
    ) -> Vec<WorktreeSetupStepResult> {
        Self::apply_worktree_setup(repo_path, worktree_path, copy_files, post_create_commands)
    }

    /// Create a worktree with full setup: copy files and run post-create commands.
    pub fn create_worktree_with_setup(
        repo_path: &str,
        branch_name: &str,
        worktree_path: Option<&str>,
        copy_files: &[String],
        post_create_commands: &[String],
        base_branch: Option<&str>,
    ) -> Result<WorktreeCreationResult, String> {
        let created =
            Self::create_worktree_only(repo_path, branch_name, worktree_path, base_branch)?;

        // The worktree exists; setup failures are reported/logged but not fatal.
        let steps = Self::apply_worktree_setup(
            repo_path,
            &created.worktree_path,
            copy_files,
            post_create_commands,
        );
        for step in &steps {
            if !step.success {
                log::error!(
                    "[git] Worktree setup step '{}' failed: {}",
                    step.description,
                    step.output.as_deref().unwrap_or("")
                );
            }
        }

        Ok(created)
    }

    /// Generate a fallback branch name from a prompt (used when LLM is unavailable)
    pub fn generate_branch_name(prompt: &str) -> String {
        let timestamp = crate::util::now_secs();

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
