use std::fs;
use std::path::PathBuf;

use crate::config::AppConfig;
use crate::session_persistence::atomic_write;

/// Path to the spare tokens file (separate for debug/release builds)
fn spare_tokens_file_path() -> PathBuf {
    #[cfg(debug_assertions)]
    let filename = "spare-tokens.dev.json";
    #[cfg(not(debug_assertions))]
    let filename = "spare-tokens.json";
    AppConfig::config_dir().join(filename)
}

/// Load the spare tokens blob. Stored as opaque JSON — the frontend owns the schema.
/// Returns None if the file doesn't exist yet.
#[tauri::command]
pub fn load_spare_tokens() -> Option<String> {
    let path = spare_tokens_file_path();
    match fs::read_to_string(&path) {
        Ok(content) => Some(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            eprintln!("[spare-tokens] Failed to read spare tokens file: {}", e);
            None
        }
    }
}

/// Save the spare tokens blob (full replacement, atomic write).
#[tauri::command]
pub fn save_spare_tokens(data: String) -> Result<(), String> {
    let path = spare_tokens_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    atomic_write(&path, data.as_bytes())
}
