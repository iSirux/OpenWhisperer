//! Agent accounts (multi-account / multi-boxing).
//!
//! An "agent account" is an isolated provider login profile directory. A Claude
//! account is a directory passed to the agent process as `CLAUDE_CONFIG_DIR`; an
//! OpenAI/Codex account is a directory passed as `CODEX_HOME`. Sessions are
//! pinned to an account by injecting that env var at session creation — riding
//! the exact same rail as the per-repo `gh_user` → GH_TOKEN injection.

use serde::{Deserialize, Serialize};

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
