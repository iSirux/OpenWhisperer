//! Git node executors. Shell-out goes through [`crate::sequences::executor::run_prog`]
//! (the shared [`crate::proc`] runner) instead of hand-rolled `Command` blocks (T2).

use crate::git::GitManager;
use crate::sequences::error::SequenceError;
use crate::sequences::executor::{render, resolve_cwd, run_prog, SequenceExecutor};
use crate::sequences::types::*;

/// Map a finished process to `Ok(())` or a `Command` error carrying trimmed stderr.
fn check(out: crate::proc::ProcOutput, what: &str) -> Result<(), SequenceError> {
    if out.success {
        Ok(())
    } else {
        let stderr = out.stderr.trim();
        Err(SequenceError::command(format!("{} failed: {}", what, stderr)))
    }
}

impl SequenceExecutor {
    pub(crate) async fn execute_git_branch(
        &self,
        _node: &NodeDefinition,
        git_branch: &GitBranchNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let rendered_branch = render(&git_branch.branch_name, context)?;
        let cwd = resolve_cwd(context);

        if let Some(ref from_ref) = git_branch.from {
            let rendered_from = render(from_ref, context)?;
            GitManager::checkout_branch(&cwd, &rendered_from).map_err(|e| {
                SequenceError::command(format!(
                    "Failed to checkout base branch '{}': {}",
                    rendered_from, e
                ))
            })?;
        }

        GitManager::create_branch(&cwd, &rendered_branch).map_err(|e| {
            SequenceError::command(format!("Failed to create branch '{}': {}", rendered_branch, e))
        })?;

        Ok(Some(serde_json::json!({ "branch": rendered_branch })))
    }

    pub(crate) async fn execute_git_worktree(
        &self,
        _node: &NodeDefinition,
        git_wt: &GitWorktreeNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let rendered_branch = render(&git_wt.branch_name, context)?;
        let cwd = resolve_cwd(context);

        let worktree_path = match &git_wt.worktree_path {
            Some(p) => render(p, context)?,
            None => GitManager::get_worktree_path(&cwd, &rendered_branch),
        };

        let start_point = git_wt
            .base_branch
            .as_ref()
            .map(|b| render(b, context))
            .transpose()?;

        GitManager::create_worktree(&cwd, &rendered_branch, &worktree_path, start_point.as_deref())
            .map_err(|e| SequenceError::command(format!("Failed to create worktree: {}", e)))?;

        Ok(Some(serde_json::json!({
            "branch": rendered_branch,
            "worktree_path": worktree_path,
        })))
    }

    pub(crate) async fn execute_git_commit(
        &self,
        _node: &NodeDefinition,
        git_commit: &GitCommitNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let rendered_message = render(&git_commit.message, context)?;
        let cwd = resolve_cwd(context);

        // Stage files via `git add` if specified
        if let Some(ref add_patterns) = git_commit.add {
            for pattern in add_patterns {
                let rendered_pattern = render(pattern, context)?;
                let out = run_prog("git", &["add", &rendered_pattern], &cwd).await?;
                check(out, &format!("git add '{}'", rendered_pattern))?;
            }
        }

        // Build commit args: commit -m <msg> [files...]
        let mut args: Vec<String> = vec!["commit".into(), "-m".into(), rendered_message.clone()];
        if let Some(ref files) = git_commit.files {
            for file in files {
                args.push(render(file, context)?);
            }
        }
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let out = run_prog("git", &arg_refs, &cwd).await?;
        check(out, "git commit")?;

        Ok(Some(serde_json::json!({ "message": rendered_message })))
    }

    pub(crate) async fn execute_git_push(
        &self,
        _node: &NodeDefinition,
        git_push: &GitPushNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let cwd = resolve_cwd(context);
        let remote = git_push.remote.as_deref().unwrap_or("origin");

        let mut args: Vec<&str> = vec!["push", remote];
        if git_push.force.unwrap_or(false) {
            args.push("--force");
        }
        let out = run_prog("git", &args, &cwd).await?;
        check(out, "git push")?;

        Ok(Some(serde_json::json!({ "pushed": true, "remote": remote })))
    }

    pub(crate) async fn execute_git_delete_branch(
        &self,
        _node: &NodeDefinition,
        git_del: &GitDeleteBranchNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let rendered_branch = render(&git_del.branch, context)?;
        let cwd = resolve_cwd(context);

        let out = run_prog("git", &["branch", "-D", &rendered_branch], &cwd).await?;
        check(out, &format!("git branch -D '{}'", rendered_branch))?;

        if git_del.remote.unwrap_or(false) {
            let out = run_prog("git", &["push", "origin", "--delete", &rendered_branch], &cwd).await?;
            check(out, &format!("git push origin --delete '{}'", rendered_branch))?;
        }

        Ok(Some(serde_json::json!({ "deleted": rendered_branch })))
    }

    pub(crate) async fn execute_git_delete_worktree(
        &self,
        _node: &NodeDefinition,
        git_del_wt: &GitDeleteWorktreeNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let rendered_path = render(&git_del_wt.path, context)?;
        let cwd = resolve_cwd(context);

        GitManager::remove_worktree(&cwd, &rendered_path).map_err(|e| {
            SequenceError::command(format!("Failed to remove worktree '{}': {}", rendered_path, e))
        })?;

        Ok(Some(serde_json::json!({ "removed": rendered_path })))
    }
}
