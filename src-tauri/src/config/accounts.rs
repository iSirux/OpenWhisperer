//! Agent accounts (multi-account / multi-boxing).
//!
//! An "agent account" is an isolated provider login profile directory. A Claude
//! account is a directory passed to the agent process as `CLAUDE_CONFIG_DIR`; an
//! OpenAI/Codex account is a directory passed as `CODEX_HOME`. Sessions are
//! pinned to an account by injecting that env var at session creation — riding
//! the exact same rail as the per-repo `gh_user` → GH_TOKEN injection.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::provider::SdkProvider;
use super::AppConfig;

/// A registered provider login profile the user can pin sessions to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentAccount {
    /// Stable unique identifier, e.g. "acct-<12 lowercase hex>".
    pub id: String,
    /// User-chosen display label, e.g. "Personal", "Work".
    pub label: String,
    /// Visual identity color as a hex string (e.g. "#7c9cff").
    #[serde(default)]
    pub color: String,
    /// Which provider this account logs into (Claude or OpenAI/Codex).
    pub provider: SdkProvider,
    /// Absolute path to the isolated profile directory. For Claude this is the
    /// `CLAUDE_CONFIG_DIR`; for OpenAI it is the `CODEX_HOME`.
    #[serde(default)]
    pub config_dir: Option<String>,
    /// When true, the account is hidden from pickers and never injected.
    #[serde(default)]
    pub disabled: bool,
}

/// Reserved virtual account id denoting the machine's default Claude login
/// (no env override). Never stored in `AppConfig.accounts`; synthesized by the
/// frontend and may appear in `RepoConfig.account_ids` / session creation.
pub const DEFAULT_CLAUDE_ACCOUNT_ID: &str = "default-claude";
/// Reserved virtual account id denoting the machine's default OpenAI login.
pub const DEFAULT_OPENAI_ACCOUNT_ID: &str = "default-openai";

/// Whether an id is one of the reserved default (no-override) virtual accounts.
pub fn is_default_account_id(id: &str) -> bool {
    id == DEFAULT_CLAUDE_ACCOUNT_ID || id == DEFAULT_OPENAI_ACCOUNT_ID
}

/// Resolve the extra env pairs to inject for a session pinned to `account_id`.
///
/// Returns `[("CLAUDE_CONFIG_DIR", dir)]` for a Claude account or
/// `[("CODEX_HOME", dir)]` for an OpenAI account. Returns an empty vec (injecting
/// no override, i.e. the machine's default login) when `account_id` is `None`, a
/// reserved `default-*` id, or an account without a `config_dir`. An unknown id
/// is logged as a warning and also yields no override.
pub fn account_session_env(config: &AppConfig, account_id: Option<&str>) -> Vec<(String, String)> {
    let Some(id) = account_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Vec::new();
    };
    if is_default_account_id(id) {
        return Vec::new();
    }
    let Some(account) = config.accounts.iter().find(|a| a.id == id) else {
        log::warn!(
            "[accounts] Unknown account id '{}' on session creation — using the default login",
            id
        );
        return Vec::new();
    };
    let Some(dir) = account
        .config_dir
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    else {
        log::warn!(
            "[accounts] Account '{}' has no config_dir — using the default login",
            id
        );
        return Vec::new();
    };
    let var = match account.provider {
        SdkProvider::Claude => "CLAUDE_CONFIG_DIR",
        SdkProvider::OpenAI => "CODEX_HOME",
    };
    vec![(var.to_string(), dir.to_string())]
}

/// The Codex state root that contains a persisted thread rollout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexThreadOwner {
    /// The machine-default Codex profile (no per-session CODEX_HOME override).
    Default,
    /// One of OpenWhisperer's configured isolated Codex profiles.
    Account(String),
}

fn default_codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
}

fn codex_home_contains_thread(codex_home: &Path, thread_id: &str) -> bool {
    let expected_suffix = format!("-{}.jsonl", thread_id);
    for root in [
        codex_home.join("sessions"),
        codex_home.join("archived_sessions"),
    ] {
        let mut pending = vec![(root, 0usize)];
        while let Some((dir, depth)) = pending.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                if file_type.is_file()
                    && entry
                        .file_name()
                        .to_string_lossy()
                        .ends_with(&expected_suffix)
                {
                    return true;
                }
                // Active rollouts are currently nested by YYYY/MM/DD. Keep a
                // small ceiling so a malformed profile cannot cause an
                // unbounded traversal, and don't follow directory symlinks.
                if file_type.is_dir() && depth < 5 {
                    pending.push((entry.path(), depth + 1));
                }
            }
        }
    }
    false
}

fn configured_codex_home<'a>(config: &'a AppConfig, account_id: &str) -> Option<&'a Path> {
    config
        .accounts
        .iter()
        .find(|account| {
            account.id == account_id && account.provider == SdkProvider::OpenAI && !account.disabled
        })
        .and_then(|account| account.config_dir.as_deref())
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(Path::new)
}

/// Locate the profile that owns `thread_id`'s rollout. The requested profile is
/// checked first, then the other configured OpenAI profiles and the machine
/// default. This repairs legacy OpenWhisperer sessions whose account id was not
/// persisted while avoiding a failed `thread/resume` against the wrong store.
pub fn resolve_codex_thread_owner(
    config: &AppConfig,
    requested_account_id: Option<&str>,
    thread_id: &str,
) -> Option<CodexThreadOwner> {
    let requested = requested_account_id
        .map(str::trim)
        .filter(|id| !id.is_empty());

    if let Some(id) = requested {
        if is_default_account_id(id) {
            if default_codex_home()
                .as_deref()
                .is_some_and(|home| codex_home_contains_thread(home, thread_id))
            {
                return Some(CodexThreadOwner::Default);
            }
        } else if configured_codex_home(config, id)
            .is_some_and(|home| codex_home_contains_thread(home, thread_id))
        {
            return Some(CodexThreadOwner::Account(id.to_string()));
        }
    } else if default_codex_home()
        .as_deref()
        .is_some_and(|home| codex_home_contains_thread(home, thread_id))
    {
        return Some(CodexThreadOwner::Default);
    }

    for account in config.accounts.iter().filter(|account| {
        account.provider == SdkProvider::OpenAI
            && !account.disabled
            && requested != Some(account.id.as_str())
    }) {
        if account
            .config_dir
            .as_deref()
            .map(str::trim)
            .filter(|dir| !dir.is_empty())
            .map(Path::new)
            .is_some_and(|home| codex_home_contains_thread(home, thread_id))
        {
            return Some(CodexThreadOwner::Account(account.id.clone()));
        }
    }

    if requested.is_some_and(|id| !is_default_account_id(id))
        && default_codex_home()
            .as_deref()
            .is_some_and(|home| codex_home_contains_thread(home, thread_id))
    {
        return Some(CodexThreadOwner::Default);
    }

    None
}

/// Resolve the provider-credentials file for an account id.
///
/// Returns `Ok(None)` when `account_id` is `None` or one of the reserved
/// `default-*` virtual ids — the caller then uses the machine-default path
/// (`~/.claude/.credentials.json` for Claude, `~/.codex/auth.json` for OpenAI).
/// For a configured account, joins the provider's credentials filename onto the
/// account's `config_dir` (Claude → `.credentials.json`, OpenAI → `auth.json`).
///
/// Errors when the id is unknown, the account's provider does not match
/// `provider`, or the account has no `config_dir`.
pub fn account_credentials_path(
    config: &AppConfig,
    account_id: Option<&str>,
    provider: SdkProvider,
) -> Result<Option<std::path::PathBuf>, String> {
    let Some(id) = account_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    if is_default_account_id(id) {
        return Ok(None);
    }
    let account = config
        .accounts
        .iter()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("unknown agent account: {}", id))?;
    if account.provider != provider {
        return Err(format!(
            "agent account '{}' is not a {:?} account",
            id, provider
        ));
    }
    let dir = account
        .config_dir
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .ok_or_else(|| format!("agent account '{}' has no config_dir", id))?;
    let filename = match provider {
        SdkProvider::Claude => ".credentials.json",
        SdkProvider::OpenAI => "auth.json",
    };
    Ok(Some(std::path::PathBuf::from(dir).join(filename)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_legacy_codex_thread_in_configured_account() {
        let root = std::env::temp_dir().join(format!(
            "open-whisperer-codex-owner-{}",
            uuid::Uuid::new_v4()
        ));
        let account_home = root.join("account");
        let rollout_dir = account_home.join("sessions/2026/09/16");
        std::fs::create_dir_all(&rollout_dir).unwrap();
        let thread_id = "01a0aa4f-fa12-7b70-83ed-d83976deccc6";
        std::fs::write(
            rollout_dir.join(format!("rollout-2026-09-16T15-02-43-{thread_id}.jsonl")),
            "{}\n",
        )
        .unwrap();

        let mut config = AppConfig::default();
        config.accounts.push(AgentAccount {
            id: "acct-personal".to_string(),
            label: "Personal".to_string(),
            color: "#000000".to_string(),
            provider: SdkProvider::OpenAI,
            config_dir: Some(account_home.to_string_lossy().into_owned()),
            disabled: false,
        });
        config.accounts.push(AgentAccount {
            id: "acct-other".to_string(),
            label: "Other".to_string(),
            color: "#ffffff".to_string(),
            provider: SdkProvider::OpenAI,
            config_dir: Some(root.join("other").to_string_lossy().into_owned()),
            disabled: false,
        });

        assert_eq!(
            resolve_codex_thread_owner(&config, None, thread_id),
            Some(CodexThreadOwner::Account("acct-personal".to_string()))
        );
        assert_eq!(
            resolve_codex_thread_owner(&config, Some("acct-other"), thread_id),
            Some(CodexThreadOwner::Account("acct-personal".to_string()))
        );

        std::fs::remove_dir_all(root).unwrap();
    }
}
