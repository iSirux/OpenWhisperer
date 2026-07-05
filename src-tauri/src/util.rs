//! Small shared utilities used across modules.
#![allow(dead_code)]

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch. Never panics (returns 0 if the clock is before the epoch).
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Seconds since the Unix epoch. Never panics.
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// First `n` characters of an id for log display, safe for ids shorter than `n`
/// and for multibyte content.
pub fn short_id(id: &str) -> &str {
    match id.char_indices().nth(8) {
        Some((idx, _)) => &id[..idx],
        None => id,
    }
}

/// Truncate `text` to at most `max_chars` characters (not bytes), appending an
/// ellipsis when truncated. Safe on multibyte UTF-8 content.
pub fn truncate_chars(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((idx, _)) => format!("{}...", &text[..idx]),
        None => text.to_string(),
    }
}

/// Emit a Tauri event, logging (instead of silently dropping) any failure.
pub fn emit_or_log<S: serde::Serialize + Clone>(app: &tauri::AppHandle, event: &str, payload: S) {
    use tauri::Emitter;
    if let Err(e) = app.emit(event, payload) {
        log::warn!("Failed to emit event '{}': {}", event, e);
    }
}
