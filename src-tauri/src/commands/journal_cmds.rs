//! Journal persistence (Meeting Mode's non-actionable items).
//!
//! Journal items are stored as opaque JSON — the frontend (`stores/journal.ts`)
//! owns the schema, so there is no AppConfig entry and no migration ladder here.
//! Mirrors the schedules/pile pattern: dev/prod file split, full-replacement
//! saves, atomic writes.

use std::fs;
use std::path::{Path, PathBuf};

use crate::config::AppConfig;
use crate::persist::{backup_corrupt, save_json_atomic};

/// Path to the journal file (separate for debug/release builds)
fn journal_file_path() -> PathBuf {
    #[cfg(debug_assertions)]
    let filename = "journal.dev.json";
    #[cfg(not(debug_assertions))]
    let filename = "journal.json";
    AppConfig::config_dir().join(filename)
}

/// Parse journal file contents. Errors (never `[]`) on anything but a JSON array,
/// so a corrupt file can't masquerade as an empty journal.
fn parse_journal(content: &str) -> Result<Vec<serde_json::Value>, String> {
    serde_json::from_str(content).map_err(|e| e.to_string())
}

fn load_journal_from(path: &Path) -> Result<Vec<serde_json::Value>, String> {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Failed to read journal: {}", e)),
    };
    parse_journal(&content).map_err(|e| {
        // Keep a copy aside and fail the load: the frontend then never marks the
        // store loaded, so it can't save an empty list over the user's journal.
        let backup = backup_corrupt(path);
        log::error!(
            "Failed to parse journal at {:?}: {} (backup: {:?})",
            path,
            e,
            backup
        );
        match backup {
            Some(b) => format!("Journal file is corrupt ({}); a copy was saved to {}", e, b.display()),
            None => format!("Journal file is corrupt ({})", e),
        }
    })
}

/// Load all journal items. Items are stored as opaque JSON — the frontend owns the schema.
#[tauri::command]
pub fn get_journal() -> Result<Vec<serde_json::Value>, String> {
    load_journal_from(&journal_file_path())
}

/// Save all journal items (full replacement, atomic write, one rolling backup).
#[tauri::command]
pub fn save_journal(items: Vec<serde_json::Value>) -> Result<(), String> {
    save_json_atomic(&journal_file_path(), &items, "journal", 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrupt_journal_errors_and_is_backed_up() {
        let dir = std::env::temp_dir().join(format!("ow-journal-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("journal.json");

        assert_eq!(load_journal_from(&path).unwrap().len(), 0, "missing file = empty");
        fs::write(&path, "[{\"id\":\"a\"}]").unwrap();
        assert_eq!(load_journal_from(&path).unwrap().len(), 1);

        fs::write(&path, "[{\"id\":").unwrap();
        assert!(load_journal_from(&path).is_err());
        let backups: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("journal.json.corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read_to_string(&path).unwrap(), "[{\"id\":", "original untouched");
        let _ = fs::remove_dir_all(&dir);
    }
}
