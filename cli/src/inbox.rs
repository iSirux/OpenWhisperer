//! The request/ack file transport (protocol version 1).
//!
//! The CLI drops `<inbox>/<id>.request.json` atomically (write `<id>.tmp`, then
//! rename) and polls for `<inbox>/<id>.ack.json`, which the app writes the same
//! way. No sockets, no server: this also works while the app is closed, in
//! which case `schedule` requests are simply picked up on the next launch.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;

/// How often the ack file is checked.
const POLL_INTERVAL: Duration = Duration::from_millis(150);

/// Resolve the inbox directory.
///
/// Precedence: `OPENWHISPERER_INBOX_DIR` (set by the app for every agent
/// session) → `--dev` → `<config dir>/open-whisperer/cli-inbox`.
pub fn resolve_dir(dev: bool) -> Result<PathBuf, String> {
    if let Some(raw) = std::env::var_os("OPENWHISPERER_INBOX_DIR") {
        if !raw.is_empty() {
            return Ok(PathBuf::from(raw));
        }
    }
    let config = dirs::config_dir()
        .ok_or_else(|| "could not determine the user configuration directory".to_string())?;
    let name = if dev { "cli-inbox-dev" } else { "cli-inbox" };
    Ok(config.join("open-whisperer").join(name))
}

/// Create the inbox directory if it does not exist yet.
pub fn ensure_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|err| {
        format!(
            "could not create the inbox directory {}: {err}",
            dir.display()
        )
    })
}

/// Write `<id>.request.json` atomically.
pub fn write_request(dir: &Path, id: &str, request: &Value) -> Result<PathBuf, String> {
    let body = serde_json::to_vec_pretty(request)
        .map_err(|err| format!("could not serialize the request: {err}"))?;
    let tmp = dir.join(format!("{id}.tmp"));
    let final_path = dir.join(format!("{id}.request.json"));
    fs::write(&tmp, &body).map_err(|err| format!("could not write {}: {err}", tmp.display()))?;
    if let Err(err) = fs::rename(&tmp, &final_path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "could not move the request into {}: {err}",
            final_path.display()
        ));
    }
    Ok(final_path)
}

/// Delete a request the app never picked up (used when a non-`schedule`
/// request times out, so a stale command can never fire later).
pub fn remove_request(dir: &Path, id: &str) -> std::io::Result<()> {
    // The app also removes the request before applying it, and only applies it
    // if that removal succeeds. Winning this race therefore cancels the request;
    // NotFound means the app may already be executing it, not that it is closed.
    let result = fs::remove_file(dir.join(format!("{id}.request.json")));
    let _ = fs::remove_file(dir.join(format!("{id}.tmp")));
    result
}

/// Poll for `<id>.ack.json` until `timeout` elapses. The ack file is deleted
/// once it has been read. A file that is not valid JSON yet (a partial write we
/// raced) is retried rather than treated as an error.
pub fn poll_ack(dir: &Path, id: &str, timeout: Duration) -> Option<Value> {
    let path = dir.join(format!("{id}.ack.json"));
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                let _ = fs::remove_file(&path);
                return Some(value);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}
