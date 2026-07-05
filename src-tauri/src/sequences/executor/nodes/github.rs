//! GitHub PR node executors (create / wait / merge). Shell-out via `gh` goes
//! through the shared [`crate::proc`] runner (T2).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::sequences::error::SequenceError;
use crate::sequences::executor::{render, resolve_cwd, run_prog, SequenceExecutor};
use crate::sequences::types::*;

impl SequenceExecutor {
    pub(crate) async fn execute_github_pr(
        &self,
        _node: &NodeDefinition,
        gh_pr: &GitHubPrNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let rendered_title = render(&gh_pr.title, context)?;
        let cwd = resolve_cwd(context);

        let mut args: Vec<String> = vec!["pr".into(), "create".into(), "--title".into(), rendered_title];

        if let Some(ref body) = gh_pr.body {
            args.push("--body".into());
            args.push(render(body, context)?);
        }
        if gh_pr.draft.unwrap_or(false) {
            args.push("--draft".into());
        }
        if let Some(ref target) = gh_pr.target_branch {
            args.push("--base".into());
            args.push(render(target, context)?);
        }
        if let Some(ref labels) = gh_pr.labels {
            for label in labels {
                args.push("--label".into());
                args.push(render(label, context)?);
            }
        }
        if let Some(ref reviewers) = gh_pr.reviewers {
            for reviewer in reviewers {
                args.push("--reviewer".into());
                args.push(render(reviewer, context)?);
            }
        }

        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let out = run_prog("gh", &arg_refs, &cwd).await?;
        if !out.success {
            return Err(SequenceError::command(format!(
                "gh pr create failed: {}",
                out.stderr.trim()
            )));
        }

        let pr_url = out.stdout.trim().to_string();
        let pr_number = pr_url
            .rsplit('/')
            .next()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);

        Ok(Some(serde_json::json!({ "pr_url": pr_url, "pr_number": pr_number })))
    }

    pub(crate) async fn execute_github_pr_wait(
        &self,
        node: &NodeDefinition,
        gh_wait: &GitHubPrWaitNode,
        context: &serde_json::Value,
        cancel_flag: Arc<AtomicBool>,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let rendered_pr = render(&gh_wait.pr, context)?;
        let cwd = resolve_cwd(context);
        let poll_interval = gh_wait.poll_interval.unwrap_or(30);
        let timeout_secs = node.timeout.unwrap_or(3600);
        let start = std::time::Instant::now();

        loop {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err(SequenceError::cancelled("Wait cancelled"));
            }
            if start.elapsed().as_secs() > timeout_secs {
                return Err(SequenceError::timeout(format!(
                    "PR wait timed out after {}s waiting for {:?}",
                    timeout_secs, gh_wait.wait_for
                )));
            }

            let ready = match gh_wait.wait_for {
                WaitTarget::Checks => {
                    // gh pr checks exits 0 when all checks pass
                    run_prog("gh", &["pr", "checks", &rendered_pr], &cwd).await?.success
                }
                WaitTarget::Reviews => {
                    let out = run_prog(
                        "gh",
                        &["pr", "view", &rendered_pr, "--json", "reviewDecision", "-q", ".reviewDecision"],
                        &cwd,
                    )
                    .await?;
                    out.stdout.trim() == "APPROVED"
                }
                WaitTarget::Merge => {
                    let out = run_prog(
                        "gh",
                        &["pr", "view", &rendered_pr, "--json", "state", "-q", ".state"],
                        &cwd,
                    )
                    .await?;
                    out.stdout.trim() == "MERGED"
                }
            };

            if ready {
                return Ok(Some(serde_json::json!({
                    "condition_met": true,
                    "wait_for": gh_wait.wait_for,
                    "pr": rendered_pr,
                })));
            }

            tokio::time::sleep(std::time::Duration::from_secs(poll_interval)).await;
        }
    }

    pub(crate) async fn execute_github_pr_merge(
        &self,
        _node: &NodeDefinition,
        gh_merge: &GitHubPrMergeNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let rendered_pr = render(&gh_merge.pr, context)?;
        let cwd = resolve_cwd(context);

        let method_flag = match gh_merge.method.unwrap_or(MergeMethod::Merge) {
            MergeMethod::Squash => "--squash",
            MergeMethod::Rebase => "--rebase",
            MergeMethod::Merge => "--merge",
        };

        let mut args: Vec<&str> = vec!["pr", "merge", &rendered_pr, method_flag];
        if gh_merge.delete_branch.unwrap_or(false) {
            args.push("--delete-branch");
        }

        let out = run_prog("gh", &args, &cwd).await?;
        if !out.success {
            return Err(SequenceError::command(format!(
                "gh pr merge failed: {}",
                out.stderr.trim()
            )));
        }

        Ok(Some(serde_json::json!({ "merged": true, "pr": rendered_pr })))
    }
}
