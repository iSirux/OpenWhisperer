//! Agent account (multi-account / multi-boxing) management commands.
//!
//! An agent account is an isolated provider login profile directory under
//! `<app config dir>/agent-accounts/<id>`. Claude accounts inject that path as
//! `CLAUDE_CONFIG_DIR`; OpenAI/Codex accounts inject it as `CODEX_HOME`. The
//! reserved virtual ids `default-claude` / `default-openai` (synthesized by the
//! frontend, never stored) mean "the machine's default login, no env override".

use std::fs;
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::process::Command;

use tauri::State;

use crate::commands::settings_cmds::ConfigState;
use crate::config::{AgentAccount, AppConfig, SdkProvider};

/// Directory holding every account's isolated profile subdirectory.
fn agent_accounts_dir() -> PathBuf {
    AppConfig::config_dir().join("agent-accounts")
}

/// Generate an `acct-<12 lowercase hex>` id.
fn generate_account_id() -> String {
    let hex = uuid::Uuid::new_v4().simple().to_string();
    format!("acct-{}", &hex[..12])
}

/// Register a new agent account: create its isolated profile directory, store
/// the absolute path as `config_dir`, persist, and return the account. The
/// directory starts empty — `login_agent_account` drives the interactive login
/// that populates it.
#[tauri::command]
pub fn create_agent_account(
    config: State<ConfigState>,
    label: String,
    provider: SdkProvider,
    color: String,
) -> Result<AgentAccount, String> {
    let id = generate_account_id();
    let dir = agent_accounts_dir().join(&id);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create account directory {}: {}", dir.display(), e))?;

    let account = AgentAccount {
        id,
        label,
        color,
        provider,
        config_dir: Some(dir.to_string_lossy().to_string()),
        disabled: false,
    };

    let snapshot = {
        let mut cfg = config.lock();
        cfg.accounts.push(account.clone());
        cfg.clone()
    };
    snapshot.save()?;
    Ok(account)
}

/// Patch an account's mutable fields (only the `Some` ones) and persist.
#[tauri::command]
pub fn update_agent_account(
    config: State<ConfigState>,
    id: String,
    label: Option<String>,
    color: Option<String>,
    disabled: Option<bool>,
) -> Result<(), String> {
    let snapshot = {
        let mut cfg = config.lock();
        let account = cfg
            .accounts
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or_else(|| format!("Agent account not found: {}", id))?;
        if let Some(label) = label {
            account.label = label;
        }
        if let Some(color) = color {
            account.color = color;
        }
        if let Some(disabled) = disabled {
            account.disabled = disabled;
        }
        cfg.clone()
    };
    snapshot.save()
}

/// Remove an account from the registry, strip its id from every repo's
/// `account_ids` whitelist, and persist. When `delete_dir` is set and the
/// account's `config_dir` lives under `<app config dir>/agent-accounts/`, the
/// profile directory is deleted recursively (paths outside that root are refused
/// as a safety guard).
#[tauri::command]
pub fn remove_agent_account(
    config: State<ConfigState>,
    id: String,
    delete_dir: bool,
) -> Result<(), String> {
    let (snapshot, removed_dir) = {
        let mut cfg = config.lock();
        let removed_dir = cfg
            .accounts
            .iter()
            .find(|a| a.id == id)
            .and_then(|a| a.config_dir.clone());
        cfg.accounts.retain(|a| a.id != id);
        for repo in &mut cfg.repos {
            repo.account_ids.retain(|aid| aid != &id);
        }
        (cfg.clone(), removed_dir)
    };
    snapshot.save()?;

    if delete_dir {
        if let Some(dir) = removed_dir {
            delete_account_dir(&dir)?;
        }
    }
    Ok(())
}

/// Recursively delete an account profile directory, refusing any path outside
/// `<app config dir>/agent-accounts/` so a stray/edited `config_dir` can never
/// take out unrelated files.
fn delete_account_dir(dir: &str) -> Result<(), String> {
    let base = agent_accounts_dir();
    let path = PathBuf::from(dir);
    if !path.starts_with(&base) {
        return Err(format!(
            "Refusing to delete account directory outside {}: {}",
            base.display(),
            path.display()
        ));
    }
    if path.exists() {
        fs::remove_dir_all(&path)
            .map_err(|e| format!("Failed to delete {}: {}", path.display(), e))?;
    }
    Ok(())
}

/// Open a visible terminal with the account's env var set, running the
/// provider's interactive login (`claude` for Claude — its first-run flow drives
/// `/login`; `codex login` for OpenAI). Follows the `run_docker_setup`
/// terminal-spawn pattern (Windows first-class; macOS/Linux best-effort).
#[tauri::command]
pub fn login_agent_account(config: State<ConfigState>, id: String) -> Result<(), String> {
    let account = {
        let cfg = config.lock();
        cfg.accounts.iter().find(|a| a.id == id).cloned()
    }
    .ok_or_else(|| format!("Agent account not found: {}", id))?;

    let dir = account
        .config_dir
        .clone()
        .filter(|d| !d.trim().is_empty())
        .ok_or_else(|| format!("Agent account '{}' has no config directory", id))?;

    // A fresh login needs the directory to exist.
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create account directory {}: {}", dir, e))?;

    let (var, login_cmd) = match account.provider {
        SdkProvider::Claude => ("CLAUDE_CONFIG_DIR", "claude"),
        SdkProvider::OpenAI => ("CODEX_HOME", "codex login"),
    };

    #[cfg(target_os = "windows")]
    {
        // Set the env var on the parent `cmd /c` process; `start` launches a new
        // window whose cmd inherits it (avoids `set VAR=...&&` trailing-space
        // pitfalls when the path contains spaces).
        Command::new("cmd")
            .args(["/c", "start", "cmd", "/k", login_cmd])
            .env(var, &dir)
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        // The spawned terminal runs a fresh shell that won't inherit our env, so
        // set the var inline on the login command.
        super::settings_cmds::run_in_terminal(format!("{}=\"{}\" {}", var, dir, login_cmd))?;
    }

    Ok(())
}

/// Whether the account has completed login, detected by the presence of the
/// provider's credentials file in its profile dir (Claude: `.credentials.json`,
/// OpenAI: `auth.json`). Unknown id or missing config dir → false. Frontend
/// polls this after `login_agent_account`.
#[tauri::command]
pub fn check_agent_account_auth(config: State<ConfigState>, id: String) -> bool {
    let cfg = config.lock();
    let Some(account) = cfg.accounts.iter().find(|a| a.id == id) else {
        return false;
    };
    let Some(dir) = account.config_dir.as_deref().filter(|d| !d.trim().is_empty()) else {
        return false;
    };
    let credentials_file = match account.provider {
        SdkProvider::Claude => ".credentials.json",
        SdkProvider::OpenAI => "auth.json",
    };
    PathBuf::from(dir).join(credentials_file).exists()
}
