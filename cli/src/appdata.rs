//! Read-only access to the app's own data files (`ow sessions`, `ow transcript`,
//! `ow quick-action list`, `ow chip list`).
//!
//! These commands need no running app: they read the same files the app
//! persists. Which instance is addressed follows the inbox rule — inside an
//! agent session `OPENWHISPERER_INBOX_DIR` names the inbox of the app that
//! spawned it, so its parent is that app's config dir and a `cli-inbox-dev`
//! name means a dev build; otherwise `--dev` picks the dev files under the
//! platform config dir (`<config dir>/open-whisperer`).

use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;

/// The data directory of one app instance (release or dev build).
pub struct AppData {
    pub root: PathBuf,
    pub dev: bool,
}

impl AppData {
    pub fn resolve(dev_flag: bool) -> Result<Self, String> {
        if let Some(raw) = std::env::var_os("OPENWHISPERER_INBOX_DIR").filter(|v| !v.is_empty()) {
            let inbox = PathBuf::from(raw);
            if let Some(root) = inbox.parent().filter(|p| !p.as_os_str().is_empty()) {
                let dev = inbox
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.ends_with("-dev"));
                return Ok(Self {
                    root: root.to_path_buf(),
                    dev,
                });
            }
        }
        let config = dirs::config_dir()
            .ok_or_else(|| "could not determine the user configuration directory".to_string())?;
        Ok(Self {
            root: config.join("open-whisperer"),
            dev: dev_flag,
        })
    }

    fn suffixed(&self, base: &str) -> PathBuf {
        self.root
            .join(if self.dev { format!("{base}-dev") } else { base.to_string() })
    }

    /// `config.json` / `config.dev.json`
    pub fn config_file(&self) -> PathBuf {
        self.root.join(if self.dev {
            "config.dev.json"
        } else {
            "config.json"
        })
    }

    pub fn live_index(&self) -> PathBuf {
        self.suffixed("sessions").join("index.json")
    }

    pub fn live_session(&self, id: &str) -> PathBuf {
        self.suffixed("sessions").join("data").join(format!("{id}.json"))
    }

    pub fn archive_index(&self) -> PathBuf {
        self.suffixed("archive").join("index.json")
    }

    pub fn archived_session(&self, id: &str) -> PathBuf {
        self.suffixed("archive").join("sessions").join(format!("{id}.json"))
    }
}

/// Parse a JSON file. `Ok(None)` when it does not exist.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("could not read {}: {err}", path.display())),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|err| format!("could not parse {}: {err}", path.display()))
}
