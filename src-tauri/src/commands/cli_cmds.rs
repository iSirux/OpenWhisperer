//! `ow` CLI integration (see `docs/cli-scheduling-spec.md`).
//!
//! The standalone `ow` binary (crate in `cli/`) talks to the running app through
//! request/ack files in an inbox directory. The frontend (`stores/cliInbox.ts`)
//! polls `take_cli_requests`, applies each request (schedules are frontend-owned),
//! and answers via `write_cli_ack`. This module also provides the env pairs that
//! let an agent session find this app instance (`cli_session_env`).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tauri::State;

use crate::commands::settings_cmds::ConfigState;
use crate::config::AppConfig;
use crate::persist::atomic_write;
use crate::proc::run_program;

/// The skill text the bundled CLI installs — compared against the installed
/// copies so Settings can offer an update after the skill changes.
const SKILL_MD: &str = include_str!("../../../cli/skill/SKILL.md");

const REQUEST_SUFFIX: &str = ".request.json";
const ACK_SUFFIX: &str = ".ack.json";
/// Acks the CLI never collected (it timed out or was killed) are swept after this.
const ACK_MAX_AGE: Duration = Duration::from_secs(60 * 60);
/// A request file that still doesn't parse after this long is garbage (the CLI
/// writes atomically via rename, so a partial file should never be observed).
const UNPARSEABLE_GRACE: Duration = Duration::from_secs(10);

/// Inbox directory (separate for debug/release builds, like the other data files).
pub fn inbox_dir() -> PathBuf {
    #[cfg(debug_assertions)]
    let name = "cli-inbox-dev";
    #[cfg(not(debug_assertions))]
    let name = "cli-inbox";
    AppConfig::config_dir().join(name)
}

/// Where `ow self-install` puts the binary. Mirrors `cli/src/install.rs`.
pub fn cli_bin_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        dirs::data_local_dir().map(|d| d.join("OpenWhisperer").join("bin"))
    }
    #[cfg(not(windows))]
    {
        dirs::home_dir().map(|h| h.join(".local").join("bin"))
    }
}

fn path_list_contains(path_value: &str, dir: &Path) -> bool {
    let sep = if cfg!(windows) { ';' } else { ':' };
    let wanted = normalize_for_compare(&dir.to_string_lossy());
    path_value
        .split(sep)
        .any(|entry| normalize_for_compare(entry) == wanted)
}

fn normalize_for_compare(p: &str) -> String {
    let s = p.trim().replace('\\', "/");
    let s = s.trim_end_matches('/').to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/// Env pairs injected into every agent session (rides the same rail as `GH_TOKEN`
/// and `CLAUDE_CONFIG_DIR`): the session id and inbox dir let `ow` address this
/// exact app instance, and the CLI bin dir is prepended to PATH so `ow` resolves
/// inside sessions without a terminal restart. PATH is only touched when the bin
/// dir exists and isn't already listed; the existing key's casing is reused so
/// the sidecar's `{...process.env, ...env}` merge can't end up with `Path` + `PATH`.
pub fn cli_session_env(session_id: &str) -> Vec<(String, String)> {
    let mut pairs = vec![
        (
            "OPENWHISPERER_SESSION_ID".to_string(),
            session_id.to_string(),
        ),
        (
            "OPENWHISPERER_INBOX_DIR".to_string(),
            inbox_dir().to_string_lossy().to_string(),
        ),
    ];

    if let Some(bin) = cli_bin_dir().filter(|d| d.is_dir()) {
        let existing = std::env::vars().find(|(k, _)| k.eq_ignore_ascii_case("PATH"));
        let (key, value) = existing.unwrap_or_else(|| ("PATH".to_string(), String::new()));
        if !path_list_contains(&value, &bin) {
            let sep = if cfg!(windows) { ";" } else { ":" };
            let joined = if value.is_empty() {
                bin.to_string_lossy().to_string()
            } else {
                format!("{}{}{}", bin.to_string_lossy(), sep, value)
            };
            pairs.push((key, joined));
        }
    }

    pairs
}

fn is_older_than(path: &Path, age: Duration) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .map(|elapsed| elapsed > age)
        .unwrap_or(false)
}

/// Request ids come from the CLI; keep them to a safe charset before they become file names.
fn safe_id(id: &str) -> Option<&str> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then_some(id)
}

/// Drain the inbox: returns every parseable request (deleting the files) and
/// sweeps stale acks. Missing inbox dir = nothing to do.
#[tauri::command]
pub fn take_cli_requests() -> Vec<serde_json::Value> {
    let dir = inbox_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut requests = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };

        if name.ends_with(ACK_SUFFIX) {
            if is_older_than(&path, ACK_MAX_AGE) {
                let _ = fs::remove_file(&path);
            }
            continue;
        }
        if !name.ends_with(REQUEST_SUFFIX) {
            continue;
        }

        match fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        {
            Some(value) => {
                if let Err(e) = fs::remove_file(&path) {
                    // Leave it for the next poll rather than applying it twice.
                    log::warn!("cli inbox: could not remove {:?}: {}", path, e);
                    continue;
                }
                requests.push(value);
            }
            None => {
                if is_older_than(&path, UNPARSEABLE_GRACE) {
                    log::warn!("cli inbox: dropping unparseable request {:?}", path);
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }

    // Oldest first so a batch left behind while the app was closed applies in order.
    requests.sort_by_key(|r| r.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0));
    requests
}

/// Answer a request. The CLI polls for `<id>.ack.json`.
#[tauri::command]
pub fn write_cli_ack(id: String, ack: serde_json::Value) -> Result<(), String> {
    let id = safe_id(&id).ok_or_else(|| format!("Invalid request id: {:?}", id))?;
    let dir = inbox_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create inbox dir: {}", e))?;
    let content = serde_json::to_string_pretty(&ack)
        .map_err(|e| format!("Failed to serialize ack: {}", e))?;
    atomic_write(&dir.join(format!("{}{}", id, ACK_SUFFIX)), &content)
        .map_err(|e| format!("Failed to write ack: {}", e))
}

/// Does this path exist and is it a directory? Used by the schedule driver to
/// detect a worktree that vanished before its schedule fired.
#[tauri::command]
pub fn path_is_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}

// ---------------------------------------------------------------------------
// Install from Settings
// ---------------------------------------------------------------------------

fn cli_exe_name() -> &'static str {
    if cfg!(windows) {
        "ow.exe"
    } else {
        "ow"
    }
}

/// The `ow` binary shipped with this build (`bundle.externalBin`): Tauri places
/// it next to the app executable, in release bundles and dev builds alike.
fn bundled_cli_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let candidate = exe.parent()?.join(cli_exe_name());
    candidate.is_file().then_some(candidate)
}

fn cli_version(path: &Path) -> Option<String> {
    let out = run_program(&path.to_string_lossy(), &["--version"], None).ok()?;
    if !out.success {
        return None;
    }
    let line = out.stdout.trim();
    Some(line.strip_prefix("ow ").unwrap_or(line).to_string())
}

/// Mirrors `cli/src/install.rs::default_skill_dirs`: the home profiles plus the
/// profile folder of every agent account, since a session pinned to an account
/// reads skills only from `<profile>/skills`. (The app runs on no profile of its
/// own, so there is no `CLAUDE_CONFIG_DIR` / `CODEX_HOME` to add.)
fn skill_files(account_dirs: &[PathBuf]) -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let mut roots: Vec<PathBuf> = [".claude", ".codex", ".agents"]
        .iter()
        .map(|agent| home.join(agent))
        .collect();
    roots.extend(account_dirs.iter().filter(|dir| dir.is_dir()).cloned());
    let mut seen = std::collections::HashSet::new();
    roots
        .into_iter()
        .filter(|root| seen.insert(normalize_for_compare(&root.to_string_lossy())))
        .map(|root| root.join("skills").join("openwhisperer").join("SKILL.md"))
        .collect()
}

/// Profile folders of the configured agent accounts (the machine-login accounts have none).
fn account_profile_dirs(config: &AppConfig) -> Vec<PathBuf> {
    config
        .accounts
        .iter()
        .filter_map(|account| account.config_dir.as_deref())
        .filter(|dir| !dir.trim().is_empty())
        .map(|dir| PathBuf::from(dir.trim()))
        .collect()
}

/// Give a new or re-pointed account profile the `ow` skill, so its sessions can
/// schedule follow-ups like sessions on the machine login do. Only when the CLI
/// is installed: without `ow` the skill would describe a command that isn't
/// there. Best-effort; "Update CLI & skills" (`ow self-install`) repairs it.
pub fn install_account_skill(profile_dir: &Path) {
    let cli_installed = cli_bin_dir()
        .map(|dir| dir.join(cli_exe_name()).is_file())
        .unwrap_or(false);
    if !cli_installed {
        return;
    }
    let dir = profile_dir.join("skills").join("openwhisperer");
    if let Err(e) = fs::create_dir_all(&dir).and_then(|_| fs::write(dir.join("SKILL.md"), SKILL_MD)) {
        log::warn!("cli: could not install the ow skill into {:?}: {}", dir, e);
    }
}

#[derive(serde::Serialize)]
pub struct CliSkillStatus {
    pub path: String,
    pub installed: bool,
    /// Installed text matches the skill this build ships.
    pub up_to_date: bool,
}

#[derive(serde::Serialize)]
pub struct CliStatus {
    /// The binary shipped with this build; `None` when the build has no CLI staged.
    pub bundled_path: Option<String>,
    pub bundled_version: Option<String>,
    pub bin_dir: Option<String>,
    pub installed_path: Option<String>,
    pub installed: bool,
    pub installed_version: Option<String>,
    pub skills: Vec<CliSkillStatus>,
}

/// What Settings → System shows: is the CLI installed, which version, are the skills current.
#[tauri::command]
pub async fn get_cli_status(config: State<'_, ConfigState>) -> Result<CliStatus, String> {
    let account_dirs = account_profile_dirs(&config.lock());
    Ok(tokio::task::spawn_blocking(move || {
        let bundled = bundled_cli_path();
        let bin_dir = cli_bin_dir();
        let installed_path = bin_dir.as_ref().map(|d| d.join(cli_exe_name()));
        let installed = installed_path.as_ref().map(|p| p.is_file()).unwrap_or(false);
        CliStatus {
            bundled_version: bundled.as_deref().and_then(cli_version),
            bundled_path: bundled.map(|p| p.to_string_lossy().to_string()),
            bin_dir: bin_dir.map(|p| p.to_string_lossy().to_string()),
            installed_version: if installed {
                installed_path.as_deref().and_then(cli_version)
            } else {
                None
            },
            installed_path: installed_path.map(|p| p.to_string_lossy().to_string()),
            installed,
            skills: skill_files(&account_dirs)
                .into_iter()
                .map(|path| {
                    let current = fs::read_to_string(&path).ok();
                    CliSkillStatus {
                        path: path.to_string_lossy().to_string(),
                        installed: current.is_some(),
                        up_to_date: current.as_deref().map(|c| c == SKILL_MD).unwrap_or(false),
                    }
                })
                .collect(),
        }
    })
    .await
    .unwrap_or(CliStatus {
        bundled_path: None,
        bundled_version: None,
        bin_dir: None,
        installed_path: None,
        installed: false,
        installed_version: None,
        skills: Vec::new(),
    }))
}

/// Run the bundled binary's `self-install` (copy to the bin dir, user PATH,
/// skills) windowlessly. Returns its output for display.
#[tauri::command]
pub async fn install_cli() -> Result<String, String> {
    let bundled = bundled_cli_path()
        .ok_or_else(|| "This build does not include the ow CLI binary".to_string())?;
    tokio::task::spawn_blocking(move || {
        let out = run_program(&bundled.to_string_lossy(), &["self-install"], None)?;
        if out.success {
            Ok(out.stdout.trim().to_string())
        } else {
            let err = out.stderr.trim();
            Err(if err.is_empty() {
                format!("ow self-install failed (exit {:?})", out.code)
            } else {
                err.to_string()
            })
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_list_contains_matches_normalized_entries() {
        let dir = PathBuf::from(if cfg!(windows) {
            "C:\\Users\\me\\AppData\\Local\\OpenWhisperer\\bin"
        } else {
            "/home/me/.local/bin"
        });
        let listed = if cfg!(windows) {
            "C:\\Windows;c:/users/me/appdata/local/openwhisperer/bin/"
        } else {
            "/usr/bin:/home/me/.local/bin/"
        };
        assert!(path_list_contains(listed, &dir));
        assert!(!path_list_contains("/usr/bin", &dir));
    }

    #[test]
    fn skill_files_add_each_existing_account_profile_once() {
        let profile = std::env::temp_dir().join(format!("ow-skill-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&profile).unwrap();
        let removed = profile.join("removed-account");

        let files = skill_files(&[profile.clone(), profile.clone(), removed]);

        let expected = profile.join("skills").join("openwhisperer").join("SKILL.md");
        assert_eq!(files.iter().filter(|file| **file == expected).count(), 1);
        assert_eq!(files.len(), 4, "three home profiles plus the one account");
        fs::remove_dir_all(&profile).unwrap();
    }

    #[test]
    fn safe_id_rejects_path_characters() {
        assert!(safe_id("3f2a-77b1_x").is_some());
        assert!(safe_id("../evil").is_none());
        assert!(safe_id("").is_none());
    }
}
