use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::proc::{run_command_async, run_git, run_shell};

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

/// Result of cleaning up a session's merged branch (worktree + local + remote).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchCleanupResult {
    pub worktree_removed: bool,
    pub local_branch_deleted: bool,
    pub remote_branch_deleted: bool,
    /// Non-fatal issues (e.g. remote branch deletion failed).
    pub warnings: Vec<String>,
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

    /// Count the number of changed files in `repo_path`'s working tree, matching
    /// VS Code's source-control badge: uncommitted changes only (staged,
    /// unstaged, and untracked-but-not-ignored files). Committed history is
    /// ignored.
    pub fn count_changed_files(repo_path: &str) -> Result<usize, String> {
        // Each porcelain line is one changed path (renames included), so a line
        // count is sufficient — no need to parse paths.
        let status = Self::git(repo_path, &["status", "--porcelain"])?;
        Ok(status.lines().filter(|l| !l.trim().is_empty()).count())
    }

    /// Sum [`count_changed_files`] across the main worktree and every linked
    /// worktree of `repo_path`. Each worktree has its own working tree, so their
    /// changes are disjoint and simply added. A worktree whose count can't be
    /// read (e.g. removed on disk) contributes 0 rather than failing the whole
    /// total.
    pub fn count_changed_files_all_worktrees(repo_path: &str) -> Result<usize, String> {
        let worktrees = match Self::list_worktrees(repo_path) {
            Ok(w) if !w.is_empty() => w.into_iter().map(|w| w.path).collect::<Vec<_>>(),
            // Fall back to just the given path if worktree listing is unavailable.
            _ => vec![repo_path.to_string()],
        };

        let mut total = 0usize;
        for path in worktrees {
            total += Self::count_changed_files(&path).unwrap_or(0);
        }
        Ok(total)
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

    /// Stage every change (`git add -A`) and commit with `message`. Returns
    /// `Ok(true)` when a commit was made, `Ok(false)` when there was nothing to
    /// commit (clean tree). Lifted from the sequences git-commit node so the
    /// interactive validation path can reuse it.
    pub async fn commit_all(cwd: &str, message: &str) -> Result<bool, String> {
        let path = Path::new(cwd);
        let add = run_command_async("git", &["add".into(), "-A".into()], Some(path), &[]).await?;
        if !add.success {
            return Err(format!("git add -A failed: {}", add.stderr.trim()));
        }
        // After staging, a clean tree has an empty porcelain status → nothing to commit.
        let status =
            run_command_async("git", &["status".into(), "--porcelain".into()], Some(path), &[])
                .await?;
        if status.stdout.trim().is_empty() {
            return Ok(false);
        }
        let commit = run_command_async(
            "git",
            &["commit".into(), "-m".into(), message.to_string()],
            Some(path),
            &[],
        )
        .await?;
        if !commit.success {
            return Err(format!("git commit failed: {}", commit.stderr.trim()));
        }
        Ok(true)
    }

    /// Push the current branch. When `set_upstream` is true, pushes with
    /// `--set-upstream origin <branch>` (first push of a new branch); otherwise a
    /// plain `git push`. Lifted from the sequences git-push node.
    pub async fn push(cwd: &str, set_upstream: bool) -> Result<(), String> {
        let path = Path::new(cwd);
        let args: Vec<String> = if set_upstream {
            let branch = Self::get_current_branch(cwd)?;
            vec![
                "push".into(),
                "--set-upstream".into(),
                "origin".into(),
                branch,
            ]
        } else {
            vec!["push".into()]
        };
        let out = run_command_async("git", &args, Some(path), &[]).await?;
        if !out.success {
            let err = out.stderr.trim();
            return Err(if err.is_empty() {
                "git push failed".to_string()
            } else {
                err.to_string()
            });
        }
        Ok(())
    }

    /// Normalize a path for equality checks (separators + case, Windows-tolerant).
    fn normalize_path(p: &str) -> String {
        p.replace('\\', "/").trim_end_matches('/').to_lowercase()
    }

    /// Clean up after a merged PR: remove the session's worktree (when given),
    /// delete the local branch, and best-effort delete the remote branch.
    ///
    /// Refuses (returns Err) unless it is safe: the working tree must have no
    /// uncommitted changes and the branch no unpushed commits. Deleting the
    /// repo's default branch is always refused. Remote deletion failure is a
    /// warning, not an error (the remote branch may already be gone).
    pub fn cleanup_merged_branch(
        repo_path: &str,
        branch: &str,
        worktree_path: Option<&str>,
    ) -> Result<BranchCleanupResult, String> {
        let branch = branch.trim();
        if branch.is_empty() {
            return Err("No branch to clean up".to_string());
        }

        // Never delete the default branch.
        if let Ok(default_remote) = Self::get_default_remote_branch(repo_path) {
            let default_tail = default_remote
                .split_once('/')
                .map(|(_, tail)| tail)
                .unwrap_or(&default_remote);
            if branch == default_tail {
                return Err(format!(
                    "Refusing to delete the default branch '{}'",
                    branch
                ));
            }
        }

        // A provided worktree path must be a registered linked worktree (not the
        // main one) — otherwise `git worktree remove` would fail confusingly or,
        // worse, we'd be pointed at the wrong directory.
        if let Some(wt) = worktree_path {
            let worktrees = Self::list_worktrees(repo_path)?;
            let normalized = Self::normalize_path(wt);
            let found = worktrees
                .iter()
                .find(|w| Self::normalize_path(&w.path) == normalized);
            match found {
                None => {
                    return Err(format!("'{}' is not a worktree of this repository", wt));
                }
                Some(w) if w.is_main => {
                    return Err("Refusing to remove the main worktree".to_string());
                }
                Some(_) => {}
            }
        }

        // Safety check 1: no uncommitted changes where the branch is checked out.
        let check_dir = worktree_path.unwrap_or(repo_path);
        let status = Self::git(check_dir, &["status", "--porcelain"])?;
        let dirty = status.lines().filter(|l| !l.trim().is_empty()).count();
        if dirty > 0 {
            return Err(format!(
                "Not cleaning up: {} uncommitted change{} in {} — commit, stash, or discard first",
                dirty,
                if dirty == 1 { "" } else { "s" },
                check_dir
            ));
        }

        let mut warnings = Vec::new();
        let branch_ref = format!("refs/heads/{}", branch);
        let branch_exists =
            Self::git(repo_path, &["rev-parse", "--verify", "--quiet", &branch_ref]).is_ok();

        // Safety check 2: every commit on the branch must be on the remote.
        if branch_exists {
            let remote_ref = format!("origin/{}", branch);
            let unpushed = if Self::git(repo_path, &["rev-parse", "--verify", "--quiet", &remote_ref])
                .is_ok()
            {
                Self::git(
                    repo_path,
                    &["rev-list", "--count", &format!("{}..{}", remote_ref, branch)],
                )?
            } else {
                // No remote-tracking ref (e.g. already deleted on GitHub): count
                // commits not reachable from ANY remote ref.
                Self::git(
                    repo_path,
                    &["rev-list", "--count", branch, "--not", "--remotes"],
                )?
            };
            let unpushed: usize = unpushed.trim().parse().unwrap_or(0);
            if unpushed > 0 {
                return Err(format!(
                    "Not cleaning up: branch '{}' has {} commit{} not on the remote",
                    branch,
                    unpushed,
                    if unpushed == 1 { "" } else { "s" }
                ));
            }
        } else {
            warnings.push(format!("Local branch '{}' not found (already deleted?)", branch));
        }

        // Remove the worktree. --force only bypasses ignored files (node_modules
        // etc.) — real changes were ruled out by the porcelain check above.
        let mut worktree_removed = false;
        if let Some(wt) = worktree_path {
            match Self::git(repo_path, &["worktree", "remove", "--force", wt]) {
                Ok(_) => worktree_removed = true,
                Err(e) => {
                    // On Windows `git worktree remove` frequently fails with
                    // "Permission denied" when a file in the tree is read-only or
                    // briefly locked by antivirus / the search indexer — git's
                    // --force does NOT clear read-only attributes and does not
                    // retry. Every safety gate (clean tree, pushed commits,
                    // registered non-main worktree) has already passed, so fall
                    // back to a forced filesystem removal and then prune git's
                    // administrative record.
                    let removed = force_remove_dir_all(Path::new(wt)).is_ok();
                    if removed {
                        // Clean up `.git/worktrees/<name>` now that the dir is gone.
                        let _ = Self::git(repo_path, &["worktree", "prune"]);
                        worktree_removed = true;
                    } else {
                        return Err(format!(
                            "Couldn't remove worktree '{}': {}. A program may still have \
                             files open there (a running dev server, terminal, or editor) — \
                             close it and try again.",
                            wt, e
                        ));
                    }
                }
            }
        }

        // Delete the local branch. -D (not -d) because squash/rebase merges leave
        // the branch's commits outside the default branch's history; the
        // unpushed-commits check above is the real safety gate.
        let mut local_branch_deleted = false;
        if branch_exists {
            // If the branch is checked out here (non-worktree session), switch to
            // the default branch first — git refuses to delete the current branch.
            if worktree_path.is_none()
                && Self::get_current_branch(repo_path).as_deref() == Ok(branch)
            {
                let default_remote = Self::get_default_remote_branch(repo_path)?;
                let default_tail = default_remote
                    .split_once('/')
                    .map(|(_, tail)| tail)
                    .unwrap_or(&default_remote);
                Self::git(repo_path, &["checkout", default_tail])?;
            }
            Self::git(repo_path, &["branch", "-D", branch])?;
            local_branch_deleted = true;
        }

        // Best-effort remote branch deletion (GitHub's own post-merge cleanup step).
        let mut remote_branch_deleted = false;
        match Self::git(repo_path, &["push", "origin", "--delete", branch]) {
            Ok(_) => remote_branch_deleted = true,
            Err(e) => {
                let msg = e.to_string();
                // Already gone is a success from the user's point of view.
                if !msg.to_lowercase().contains("remote ref does not exist") {
                    warnings.push(format!("Remote branch not deleted: {}", msg));
                }
            }
        }

        Ok(BranchCleanupResult {
            worktree_removed,
            local_branch_deleted,
            remote_branch_deleted,
            warnings,
        })
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

/// Recursively clear the read-only attribute across a tree so it can be deleted.
/// On Windows a single read-only file (common in `node_modules`, build output,
/// or git's own object files) makes `remove_dir_all` fail with "Permission
/// denied". Uses `symlink_metadata` so symlinks are not followed.
fn clear_readonly_recursive(path: &Path) {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    let mut perms = meta.permissions();
    if perms.readonly() {
        perms.set_readonly(false);
        let _ = std::fs::set_permissions(path, perms);
    }
    if meta.file_type().is_dir() {
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                clear_readonly_recursive(&entry.path());
            }
        }
    }
}

/// Forcefully remove a directory tree, working around the two Windows failure
/// modes `std::fs::remove_dir_all` (and `git worktree remove`) hit: read-only
/// files, and transient locks from antivirus / the search indexer. Clears
/// read-only attributes between attempts and retries a few times with a short
/// backoff. Returns `Ok` if the directory is gone (including if it never
/// existed), else the last error.
fn force_remove_dir_all(path: &Path) -> std::io::Result<()> {
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..5 {
        match std::fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                clear_readonly_recursive(path);
                last_err = Some(e);
                // Ride out brief antivirus / indexer locks; back off a little
                // more each round.
                std::thread::sleep(std::time::Duration::from_millis(150 * (attempt + 1)));
            }
        }
    }
    // One last try after the final backoff — the directory may have just been
    // released.
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(last_err.unwrap_or(e)),
    }
}
