//! GitHub integration commands: detect a repo's GitHub remote, list the
//! accounts logged into the `gh` CLI, and resolve per-account tokens so
//! sessions can pin `gh` to a specific user via GH_TOKEN.

use serde::{Deserialize, Serialize};

use crate::proc::run_command_async;

/// A GitHub account the `gh` CLI is logged into.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhAccount {
    pub username: String,
    pub host: String,
    pub active: bool,
}

/// Result of probing the `gh` CLI for logged-in accounts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhAccountsResult {
    /// Whether the `gh` CLI is installed and runnable.
    pub installed: bool,
    pub accounts: Vec<GhAccount>,
}

/// Normalize a git remote URL to a browsable https://github.com/owner/repo URL.
/// Returns None for non-GitHub remotes.
fn normalize_github_remote(remote: &str) -> Option<String> {
    let remote = remote.trim();
    if remote.is_empty() {
        return None;
    }

    // Strip protocol/ssh prefixes down to "host/owner/repo"
    let rest = if let Some(r) = remote.strip_prefix("git@") {
        // git@github.com:owner/repo.git
        r.replacen(':', "/", 1)
    } else if let Some(r) = remote.strip_prefix("ssh://git@") {
        // ssh://git@github.com/owner/repo.git
        r.to_string()
    } else if let Some(r) = remote
        .strip_prefix("https://")
        .or_else(|| remote.strip_prefix("http://"))
    {
        // https://github.com/owner/repo.git (possibly with user@ credentials)
        r.split('@').next_back().unwrap_or(r).to_string()
    } else {
        return None;
    };

    let mut parts = rest.split('/');
    let host = parts.next()?.to_lowercase();
    // Allow github.com and GitHub Enterprise-style hosts like github.mycorp.com
    if host != "github.com" && !host.starts_with("github.") {
        return None;
    }
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim().trim_end_matches(".git");
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(format!("https://{}/{}/{}", host, owner, repo))
}

/// Parse `gh auth status` output into accounts.
///
/// Expected shape (gh >= 2.40):
/// ```text
/// github.com
///   ✓ Logged in to github.com account alice (keyring)
///   - Active account: true
///   ...
///   ✓ Logged in to github.com account bob (keyring)
///   - Active account: false
/// ```
fn parse_gh_auth_status(output: &str) -> Vec<GhAccount> {
    let mut accounts: Vec<GhAccount> = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if let Some(idx) = line.find("Logged in to ") {
            let rest = &line[idx + "Logged in to ".len()..];
            // "<host> account <name> (keyring)" or older "<host> as <name> (...)"
            let mut tokens = rest.split_whitespace();
            let host = tokens.next().unwrap_or_default().to_string();
            let mut username = None;
            let tokens: Vec<&str> = tokens.collect();
            for (i, tok) in tokens.iter().enumerate() {
                if (*tok == "account" || *tok == "as") && i + 1 < tokens.len() {
                    username = Some(tokens[i + 1].to_string());
                    break;
                }
            }
            if let Some(username) = username {
                accounts.push(GhAccount {
                    username,
                    host,
                    active: false,
                });
            }
        } else if line.starts_with("- Active account:") || line.starts_with("Active account:") {
            if let Some(last) = accounts.last_mut() {
                last.active = line.ends_with("true");
            }
        }
    }
    accounts
}

/// Detect the GitHub URL of a repository from its git remotes.
/// Prefers `origin`, falls back to the first remote that points at GitHub.
/// Returns None when the repo has no GitHub remote.
#[tauri::command]
pub async fn detect_github_url(repo_path: String) -> Result<Option<String>, String> {
    let path = std::path::PathBuf::from(&repo_path);
    if !path.exists() {
        return Err(format!("Path does not exist: {}", repo_path));
    }

    // Try origin first
    let origin = run_command_async(
        "git",
        &["remote".into(), "get-url".into(), "origin".into()],
        Some(&path),
        &[],
    )
    .await?;
    if origin.success {
        if let Some(url) = normalize_github_remote(origin.stdout.trim()) {
            return Ok(Some(url));
        }
    }

    // Fall back to scanning all remotes
    let remotes = run_command_async("git", &["remote".into(), "-v".into()], Some(&path), &[]).await?;
    if remotes.success {
        for line in remotes.stdout.lines() {
            // "<name>\t<url> (fetch)"
            if let Some(url) = line.split_whitespace().nth(1) {
                if let Some(normalized) = normalize_github_remote(url) {
                    return Ok(Some(normalized));
                }
            }
        }
    }

    Ok(None)
}

/// List the accounts the `gh` CLI is logged into.
#[tauri::command]
pub async fn list_gh_accounts() -> Result<GhAccountsResult, String> {
    // `gh auth status` exits non-zero when not logged in at all; stderr is used
    // for the status output in some versions, so check both streams.
    let out = match run_command_async("gh", &["auth".into(), "status".into()], None, &[]).await {
        Ok(out) => out,
        Err(_) => {
            // gh not installed / not on PATH
            return Ok(GhAccountsResult {
                installed: false,
                accounts: Vec::new(),
            });
        }
    };

    let combined = format!("{}\n{}", out.stdout, out.stderr);
    Ok(GhAccountsResult {
        installed: true,
        accounts: parse_gh_auth_status(&combined),
    })
}

/// Resolve an auth token for a specific gh account. Used to pin sessions to a
/// user via the GH_TOKEN env var. Not exposed as a Tauri command — the token
/// stays inside the backend and the sidecar spawn environment.
pub async fn resolve_gh_token(user: &str) -> Result<String, String> {
    let out = run_command_async(
        "gh",
        &[
            "auth".into(),
            "token".into(),
            "--user".into(),
            user.to_string(),
        ],
        None,
        &[],
    )
    .await?;
    if !out.success {
        let err = out.stderr.trim();
        return Err(if err.is_empty() {
            format!("gh auth token failed for user {}", user)
        } else {
            err.to_string()
        });
    }
    let token = out.stdout.trim().to_string();
    if token.is_empty() {
        return Err(format!("gh returned an empty token for user {}", user));
    }
    Ok(token)
}

/// A GitHub issue label.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubLabel {
    pub name: String,
    pub color: String,
}

/// A GitHub issue as shown in the per-repo issues view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubIssue {
    pub number: u64,
    pub title: String,
    /// Normalized to lowercase: "open" | "closed"
    pub state: String,
    pub state_reason: Option<String>,
    pub labels: Vec<GitHubLabel>,
    pub assignees: Vec<String>,
    pub milestone: Option<String>,
    pub author: String,
    pub url: String,
    pub created_at: String,
    pub updated_at: String,
    /// PRs that will close this issue when merged (empty when the gh version
    /// doesn't support the field).
    pub linked_pr_numbers: Vec<u64>,
}

/// A comment on a GitHub issue (used for prompt composition at launch time).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubIssueComment {
    pub author: String,
    pub body: String,
    pub created_at: String,
}

/// Full issue detail fetched at session-launch time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubIssueDetail {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub url: String,
    pub body: String,
    pub comments: Vec<GitHubIssueComment>,
}

// ---- Raw gh CLI JSON shapes (`gh issue list/view --json ...`) ----

#[derive(Debug, Deserialize)]
struct GhRawUser {
    #[serde(default)]
    login: String,
}

#[derive(Debug, Deserialize)]
struct GhRawLabel {
    #[serde(default)]
    name: String,
    #[serde(default)]
    color: String,
}

#[derive(Debug, Deserialize)]
struct GhRawMilestone {
    #[serde(default)]
    title: String,
}

#[derive(Debug, Deserialize)]
struct GhRawPrRef {
    #[serde(default)]
    number: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhRawComment {
    #[serde(default)]
    author: Option<GhRawUser>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhRawIssue {
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    state_reason: Option<String>,
    #[serde(default)]
    labels: Vec<GhRawLabel>,
    #[serde(default)]
    assignees: Vec<GhRawUser>,
    #[serde(default)]
    milestone: Option<GhRawMilestone>,
    #[serde(default)]
    author: Option<GhRawUser>,
    #[serde(default)]
    url: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    closed_by_pull_requests_references: Option<Vec<GhRawPrRef>>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    comments: Option<Vec<GhRawComment>>,
}

impl GhRawIssue {
    fn into_issue(self) -> GitHubIssue {
        GitHubIssue {
            number: self.number,
            title: self.title,
            state: self.state.to_lowercase(),
            state_reason: self.state_reason.filter(|s| !s.is_empty()),
            labels: self
                .labels
                .into_iter()
                .map(|l| GitHubLabel {
                    name: l.name,
                    color: l.color,
                })
                .collect(),
            assignees: self.assignees.into_iter().map(|a| a.login).collect(),
            milestone: self.milestone.map(|m| m.title).filter(|t| !t.is_empty()),
            author: self.author.map(|a| a.login).unwrap_or_default(),
            url: self.url,
            created_at: self.created_at,
            updated_at: self.updated_at,
            linked_pr_numbers: self
                .closed_by_pull_requests_references
                .unwrap_or_default()
                .into_iter()
                .map(|p| p.number)
                .collect(),
        }
    }
}

/// List fields requested from `gh issue list`. `closedByPullRequestsReferences`
/// is newer than the rest — when an older gh rejects it we retry without it.
const ISSUE_LIST_FIELDS: &str =
    "number,title,state,stateReason,labels,assignees,milestone,author,url,createdAt,updatedAt";
const ISSUE_LIST_PR_REFS_FIELD: &str = "closedByPullRequestsReferences";

/// Run a `gh issue ...` command in the repo directory, pinned to `gh_user`
/// when set (same GH_TOKEN mechanism as sessions). Returns stdout on success.
async fn run_gh_issue(
    repo_path: &str,
    gh_user: Option<&str>,
    args: &[String],
) -> Result<String, String> {
    let path = std::path::PathBuf::from(repo_path);
    if !path.exists() {
        return Err(format!("Path does not exist: {}", repo_path));
    }
    let env = gh_session_env(gh_user).await;
    let out = run_command_async("gh", args, Some(&path), &env)
        .await
        .map_err(|e| format!("Failed to run gh: {}", e))?;
    if !out.success {
        let err = out.stderr.trim();
        return Err(if err.is_empty() {
            "gh command failed".to_string()
        } else {
            err.to_string()
        });
    }
    Ok(out.stdout)
}

/// Fetch a repository's issues via the gh CLI, running in the repo directory
/// so gh resolves the remote itself.
#[tauri::command]
pub async fn fetch_github_issues(
    repo_path: String,
    gh_user: Option<String>,
    state: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<GitHubIssue>, String> {
    let state = match state.as_deref() {
        Some("closed") => "closed",
        Some("all") => "all",
        _ => "open",
    };
    let limit = limit.unwrap_or(100).clamp(1, 500).to_string();

    let build_args = |fields: &str| -> Vec<String> {
        vec![
            "issue".into(),
            "list".into(),
            "--state".into(),
            state.into(),
            "--limit".into(),
            limit.clone(),
            "--json".into(),
            fields.into(),
        ]
    };

    let full_fields = format!("{},{}", ISSUE_LIST_FIELDS, ISSUE_LIST_PR_REFS_FIELD);
    let stdout = match run_gh_issue(&repo_path, gh_user.as_deref(), &build_args(&full_fields)).await
    {
        Ok(out) => out,
        // Older gh versions reject the linked-PR field — retry without it.
        Err(e) if e.contains(ISSUE_LIST_PR_REFS_FIELD) => {
            run_gh_issue(&repo_path, gh_user.as_deref(), &build_args(ISSUE_LIST_FIELDS)).await?
        }
        Err(e) => return Err(e),
    };

    let raw: Vec<GhRawIssue> = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse gh issue list output: {}", e))?;
    Ok(raw.into_iter().map(GhRawIssue::into_issue).collect())
}

/// Fetch one issue's full body and comments (for prompt composition at launch).
#[tauri::command]
pub async fn fetch_github_issue(
    repo_path: String,
    gh_user: Option<String>,
    number: u64,
) -> Result<GitHubIssueDetail, String> {
    let args: Vec<String> = vec![
        "issue".into(),
        "view".into(),
        number.to_string(),
        "--json".into(),
        "number,title,state,url,body,comments".into(),
    ];
    let stdout = run_gh_issue(&repo_path, gh_user.as_deref(), &args).await?;
    let raw: GhRawIssue = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse gh issue view output: {}", e))?;
    Ok(GitHubIssueDetail {
        number: raw.number,
        title: raw.title,
        state: raw.state.to_lowercase(),
        url: raw.url,
        body: raw.body.unwrap_or_default(),
        comments: raw
            .comments
            .unwrap_or_default()
            .into_iter()
            .map(|c| GitHubIssueComment {
                author: c.author.map(|a| a.login).unwrap_or_default(),
                body: c.body,
                created_at: c.created_at,
            })
            .collect(),
    })
}

/// Build the extra env pairs for a session pinned to a gh account.
/// Returns an empty vec (with a logged warning) when the token can't be
/// resolved, so session creation never fails because of gh.
pub async fn gh_session_env(gh_user: Option<&str>) -> Vec<(String, String)> {
    let Some(user) = gh_user.filter(|u| !u.trim().is_empty()) else {
        return Vec::new();
    };
    match resolve_gh_token(user).await {
        Ok(token) => vec![
            ("GH_TOKEN".to_string(), token.clone()),
            ("GITHUB_TOKEN".to_string(), token),
        ],
        Err(e) => {
            log::warn!(
                "[github] Failed to resolve gh token for user '{}': {} — session will use gh's active account",
                user,
                e
            );
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_ssh_remote() {
        assert_eq!(
            normalize_github_remote("git@github.com:iSirux/OpenWhisperer.git"),
            Some("https://github.com/iSirux/OpenWhisperer".to_string())
        );
    }

    #[test]
    fn normalizes_https_remote() {
        assert_eq!(
            normalize_github_remote("https://github.com/owner/repo.git"),
            Some("https://github.com/owner/repo".to_string())
        );
        assert_eq!(
            normalize_github_remote("https://github.com/owner/repo"),
            Some("https://github.com/owner/repo".to_string())
        );
    }

    #[test]
    fn normalizes_ssh_protocol_remote() {
        assert_eq!(
            normalize_github_remote("ssh://git@github.com/owner/repo.git"),
            Some("https://github.com/owner/repo".to_string())
        );
    }

    #[test]
    fn strips_credentials_from_https_remote() {
        assert_eq!(
            normalize_github_remote("https://user:token@github.com/owner/repo.git"),
            Some("https://github.com/owner/repo".to_string())
        );
    }

    #[test]
    fn rejects_non_github_remotes() {
        assert_eq!(normalize_github_remote("git@gitlab.com:owner/repo.git"), None);
        assert_eq!(normalize_github_remote("https://bitbucket.org/owner/repo"), None);
        assert_eq!(normalize_github_remote(""), None);
        assert_eq!(normalize_github_remote("not a url"), None);
    }

    #[test]
    fn parses_multi_account_auth_status() {
        let output = r#"
github.com
  ✓ Logged in to github.com account alice (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************
  ✓ Logged in to github.com account bob (keyring)
  - Active account: false
  - Git operations protocol: https
"#;
        let accounts = parse_gh_auth_status(output);
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].username, "alice");
        assert!(accounts[0].active);
        assert_eq!(accounts[0].host, "github.com");
        assert_eq!(accounts[1].username, "bob");
        assert!(!accounts[1].active);
    }

    #[test]
    fn parses_legacy_as_format() {
        let output = "  ✓ Logged in to github.com as carol (oauth_token)";
        let accounts = parse_gh_auth_status(output);
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].username, "carol");
    }

    #[test]
    fn parses_empty_status() {
        assert!(parse_gh_auth_status("You are not logged into any GitHub hosts.").is_empty());
    }

    #[test]
    fn parses_gh_issue_list_json() {
        let json = r#"[{
            "number": 42,
            "title": "Overlay flickers on resize",
            "state": "OPEN",
            "stateReason": "",
            "labels": [{"id": "x", "name": "bug", "color": "d73a4a", "description": ""}],
            "assignees": [{"id": "y", "login": "alice", "name": "Alice"}],
            "milestone": {"number": 1, "title": "v1.0", "description": "", "dueOn": null},
            "author": {"id": "z", "is_bot": false, "login": "bob", "name": "Bob"},
            "url": "https://github.com/owner/repo/issues/42",
            "createdAt": "2026-07-01T10:00:00Z",
            "updatedAt": "2026-07-10T10:00:00Z",
            "closedByPullRequestsReferences": [{"id": "p", "number": 99, "url": ""}]
        }]"#;
        let raw: Vec<GhRawIssue> = serde_json::from_str(json).unwrap();
        let issues: Vec<GitHubIssue> = raw.into_iter().map(GhRawIssue::into_issue).collect();
        assert_eq!(issues.len(), 1);
        let issue = &issues[0];
        assert_eq!(issue.number, 42);
        assert_eq!(issue.state, "open");
        assert_eq!(issue.state_reason, None);
        assert_eq!(issue.labels[0].name, "bug");
        assert_eq!(issue.assignees, vec!["alice"]);
        assert_eq!(issue.milestone.as_deref(), Some("v1.0"));
        assert_eq!(issue.author, "bob");
        assert_eq!(issue.linked_pr_numbers, vec![99]);
    }

    #[test]
    fn parses_gh_issue_view_json_without_optional_fields() {
        // `gh issue view --json number,title,state,url,body,comments` output has
        // no labels/assignees/milestone keys — defaults must fill in.
        let json = r#"{
            "number": 7,
            "title": "Add issues view",
            "state": "OPEN",
            "url": "https://github.com/owner/repo/issues/7",
            "body": "Some body",
            "comments": [{"author": {"login": "carol"}, "body": "+1", "createdAt": "2026-07-02T00:00:00Z"}]
        }"#;
        let raw: GhRawIssue = serde_json::from_str(json).unwrap();
        assert_eq!(raw.number, 7);
        assert_eq!(raw.body.as_deref(), Some("Some body"));
        assert_eq!(raw.comments.as_ref().unwrap().len(), 1);
        assert!(raw.labels.is_empty());
    }
}
