//! Ship step: compute the (user-editable) ship proposal and, on approval,
//! commit / push / open a PR. Git ops go through `GitManager::commit_all`/`push`
//! (lifted from the sequences nodes); the PR is created via the pinned `run_gh`
//! rail; the commit/PR text is drafted by the LLM layer with deterministic
//! fallbacks.

use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::commands::github_cmds::{fetch_branch_pr_status, run_gh};
use crate::commands::settings_cmds::ConfigState;
use crate::git::GitManager;
use crate::proc::run_command_async;

use super::types::ShipProposal;

/// Strip a leading `origin/` from a branch ref, yielding a bare branch name.
fn bare_branch(b: &str) -> String {
    b.strip_prefix("origin/").unwrap_or(b).to_string()
}

/// Run a git command in `cwd`, returning trimmed stdout (empty on failure).
async fn git_out(cwd: &str, args: &[&str]) -> String {
    let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    match run_command_async("git", &owned, Some(Path::new(cwd)), &[]).await {
        Ok(out) if out.success => out.stdout.trim().to_string(),
        _ => String::new(),
    }
}

/// Whether the current branch has unpushed commits relative to its upstream.
/// Returns `already_pushed`: true when an upstream exists and nothing is ahead.
async fn compute_already_pushed(cwd: &str) -> bool {
    // Does an upstream exist?
    let upstream = run_command_async(
        "git",
        &[
            "rev-parse".into(),
            "--abbrev-ref".into(),
            "--symbolic-full-name".into(),
            "@{upstream}".into(),
        ],
        Some(Path::new(cwd)),
        &[],
    )
    .await;
    let has_upstream = matches!(upstream, Ok(ref o) if o.success);
    if !has_upstream {
        return false;
    }
    // Ahead count = commits on HEAD not on the upstream.
    let ahead = git_out(cwd, &["rev-list", "--count", "@{upstream}..HEAD"]).await;
    ahead == "0"
}

/// `git diff --stat` against the base branch (falls back to a plain working-tree
/// diffstat when the base ref can't be resolved).
pub async fn diffstat(cwd: &str, base_branch: &str) -> String {
    let against = format!("origin/{}", bare_branch(base_branch));
    let s = git_out(cwd, &["diff", "--stat", &against]).await;
    if !s.is_empty() {
        return s;
    }
    git_out(cwd, &["diff", "--stat", "HEAD"]).await
}

/// Compute the ship proposal (git state + drafted commit/PR text).
pub async fn compute_ship_proposal(
    app: &AppHandle,
    cwd: &str,
    gh_user: Option<&str>,
    intent: &str,
    base_override: Option<&str>,
    validation_summary: &str,
) -> Result<ShipProposal, String> {
    let branch = GitManager::get_current_branch(cwd)?;

    // Base branch: explicit override, else repo default remote branch, else "main".
    let base_branch = match base_override.map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => bare_branch(b),
        None => GitManager::get_default_remote_branch(cwd)
            .map(|b| bare_branch(&b))
            .unwrap_or_else(|_| "main".to_string()),
    };

    let on_default_branch = branch == base_branch;

    let has_uncommitted = !git_out(cwd, &["status", "--porcelain"]).await.is_empty();
    let already_pushed = compute_already_pushed(cwd).await;

    // Existing PR (only meaningful on a non-default branch).
    let existing_pr = if on_default_branch {
        None
    } else {
        fetch_branch_pr_status(cwd, gh_user, &branch)
            .await
            .ok()
            .flatten()
    };
    let existing_pr_url = existing_pr.as_ref().map(|p| p.url.clone());

    let diff_stat = diffstat(cwd, &base_branch).await;

    // Draft commit/PR text via the LLM layer; fall back to deterministic templates.
    let (commit_message, pr_title, pr_body) =
        draft_or_fallback(app, intent, &diff_stat, validation_summary).await;

    Ok(ShipProposal {
        commit_message,
        pr_title,
        pr_body,
        base_branch,
        branch,
        has_uncommitted,
        already_pushed,
        existing_pr_url,
        on_default_branch,
    })
}

/// Try the LLM draft; on any failure use deterministic templates.
async fn draft_or_fallback(
    app: &AppHandle,
    intent: &str,
    diffstat: &str,
    validation_summary: &str,
) -> (String, String, String) {
    // Clone the config out of the guard before any await.
    let config = {
        let state = app.state::<ConfigState>();
        let guard = state.lock();
        guard.clone()
    };

    if let Ok(router) =
        crate::llm::router_from_config(app, &config, crate::llm::LlmFeature::ShipDraft)
    {
        match router
            .draft_ship_with_usage(intent, diffstat, validation_summary)
            .await
        {
            Ok(res) => {
                let d = res.data;
                let commit = if d.commit_message.trim().is_empty() {
                    fallback_commit(intent)
                } else {
                    d.commit_message
                };
                let title = if d.pr_title.trim().is_empty() {
                    fallback_title(intent)
                } else {
                    d.pr_title
                };
                let body = if d.pr_body.trim().is_empty() {
                    fallback_body(intent, diffstat, validation_summary)
                } else {
                    d.pr_body
                };
                return (commit, title, body);
            }
            Err(e) => log::warn!("[validation] ship draft LLM failed, using fallback: {}", e),
        }
    }

    (
        fallback_commit(intent),
        fallback_title(intent),
        fallback_body(intent, diffstat, validation_summary),
    )
}

/// First non-empty line of the intent (trimmed), capped, for fallback subjects.
fn first_line(intent: &str) -> String {
    let line = intent
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("Update");
    crate::util::truncate_chars(line, 72)
}

fn fallback_commit(intent: &str) -> String {
    first_line(intent)
}

fn fallback_title(intent: &str) -> String {
    first_line(intent)
}

fn fallback_body(intent: &str, diffstat: &str, validation_summary: &str) -> String {
    let intent_section = crate::util::truncate_chars(intent.trim(), 2000);
    let changed = if diffstat.trim().is_empty() {
        "(no diffstat available)".to_string()
    } else {
        format!("```\n{}\n```", diffstat.trim())
    };
    let validation = if validation_summary.trim().is_empty() {
        "(no validation summary)".to_string()
    } else {
        validation_summary.trim().to_string()
    };
    format!(
        "## Intent\n\n{}\n\n## What changed\n\n{}\n\n## Validation\n\n{}",
        intent_section, changed, validation
    )
}

/// Execute an approved ship: commit (if needed), push, and open a PR when
/// appropriate. Returns the PR url when one exists/was created, plus notes.
pub struct ShipOutcome {
    pub pr_url: Option<String>,
    pub notes: Vec<String>,
}

pub async fn execute_ship(
    cwd: &str,
    gh_user: Option<&str>,
    proposal: &ShipProposal,
) -> Result<ShipOutcome, String> {
    let mut notes = Vec::new();

    // 1. Commit everything (skip when nothing to commit).
    let committed = GitManager::commit_all(cwd, &proposal.commit_message).await?;
    if !committed {
        notes.push("Nothing to commit".to_string());
    }

    // 2. Push. Set upstream on the first push of the branch.
    let set_upstream = !proposal.already_pushed;
    GitManager::push(cwd, set_upstream).await?;

    // 3. PR: skip on the default branch or when a PR already exists.
    if proposal.on_default_branch {
        notes.push("PR creation skipped: on default branch".to_string());
        return Ok(ShipOutcome { pr_url: None, notes });
    }
    if let Some(url) = &proposal.existing_pr_url {
        notes.push("PR already exists — pushed to it".to_string());
        return Ok(ShipOutcome {
            pr_url: Some(url.clone()),
            notes,
        });
    }

    let args: Vec<String> = vec![
        "pr".into(),
        "create".into(),
        "--title".into(),
        proposal.pr_title.clone(),
        "--body".into(),
        proposal.pr_body.clone(),
        "--base".into(),
        proposal.base_branch.clone(),
    ];
    let out = run_gh(cwd, gh_user, &args).await?;
    // `gh pr create` prints the new PR url on stdout.
    let pr_url = out
        .lines()
        .rev()
        .find(|l| l.contains("http"))
        .map(|l| l.trim().to_string());

    Ok(ShipOutcome { pr_url, notes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_commit_uses_first_intent_line() {
        assert_eq!(fallback_commit("\n  Add dark mode  \nmore detail"), "Add dark mode");
        assert_eq!(fallback_commit(""), "Update");
    }

    #[test]
    fn fallback_body_has_all_sections() {
        let body = fallback_body("Do the thing", " a.rs | 2 +-", "review: passed");
        assert!(body.contains("## Intent"));
        assert!(body.contains("## What changed"));
        assert!(body.contains("## Validation"));
        assert!(body.contains("Do the thing"));
        assert!(body.contains("a.rs"));
        assert!(body.contains("review: passed"));
    }

    #[test]
    fn fallback_body_handles_empty_inputs() {
        let body = fallback_body("Fix bug", "", "");
        assert!(body.contains("no diffstat available"));
        assert!(body.contains("no validation summary"));
    }

    #[test]
    fn bare_branch_strips_origin() {
        assert_eq!(bare_branch("origin/main"), "main");
        assert_eq!(bare_branch("feature-x"), "feature-x");
    }
}
