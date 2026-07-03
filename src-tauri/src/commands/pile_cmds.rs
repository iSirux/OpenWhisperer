use std::fs;
use std::path::PathBuf;

use crate::config::AppConfig;
use crate::session_persistence::atomic_write;

/// Path to the pile items file (separate for debug/release builds)
fn pile_file_path() -> PathBuf {
    #[cfg(debug_assertions)]
    let filename = "pile.dev.json";
    #[cfg(not(debug_assertions))]
    let filename = "pile.json";
    AppConfig::config_dir().join(filename)
}

/// Directory where pile recording audio files are stored
fn pile_audio_dir() -> PathBuf {
    #[cfg(debug_assertions)]
    let dirname = "pile-audio-dev";
    #[cfg(not(debug_assertions))]
    let dirname = "pile-audio";
    AppConfig::config_dir().join(dirname)
}

/// Validate a pile item ID for use in file paths (prevents path traversal)
fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("Invalid pile item id: {}", id));
    }
    Ok(())
}

fn audio_file_path(id: &str) -> PathBuf {
    pile_audio_dir().join(format!("{}.webm", id))
}

/// Directory where pile screenshots are stored
fn pile_screenshot_dir() -> PathBuf {
    #[cfg(debug_assertions)]
    let dirname = "pile-screenshots-dev";
    #[cfg(not(debug_assertions))]
    let dirname = "pile-screenshots";
    AppConfig::config_dir().join(dirname)
}

/// Screenshots are stored as opaque bytes; the media type lives in the item JSON
fn screenshot_file_path(id: &str) -> PathBuf {
    pile_screenshot_dir().join(format!("{}.img", id))
}

/// Load all pile items. Items are stored as opaque JSON — the frontend owns the schema.
#[tauri::command]
pub fn get_pile_items() -> Vec<serde_json::Value> {
    let path = pile_file_path();
    let Ok(content) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&content).unwrap_or_else(|e| {
        eprintln!("[pile] Failed to parse pile file, returning empty: {}", e);
        Vec::new()
    })
}

/// Save all pile items (full replacement, atomic write).
#[tauri::command]
pub fn save_pile_items(items: Vec<serde_json::Value>) -> Result<(), String> {
    let path = pile_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    let content = serde_json::to_vec_pretty(&items)
        .map_err(|e| format!("Failed to serialize pile items: {}", e))?;
    atomic_write(&path, &content)
}

/// Save the audio recording for a pile item. Returns the file path.
#[tauri::command]
pub fn save_pile_audio(id: String, audio_data: Vec<u8>) -> Result<String, String> {
    validate_id(&id)?;
    let dir = pile_audio_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create pile audio dir: {}", e))?;
    let path = audio_file_path(&id);
    fs::write(&path, &audio_data).map_err(|e| format!("Failed to write pile audio: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// Read the audio recording for a pile item.
#[tauri::command]
pub fn read_pile_audio(id: String) -> Result<Vec<u8>, String> {
    validate_id(&id)?;
    let path = audio_file_path(&id);
    fs::read(&path).map_err(|e| format!("Failed to read pile audio: {}", e))
}

/// Delete the audio recording for a pile item (no-op if missing).
#[tauri::command]
pub fn delete_pile_audio(id: String) -> Result<(), String> {
    validate_id(&id)?;
    let path = audio_file_path(&id);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete pile audio: {}", e)),
    }
}

/// Save the screenshot for a pile item (base64-encoded image bytes).
#[tauri::command]
pub fn save_pile_screenshot(id: String, base64_data: String) -> Result<(), String> {
    validate_id(&id)?;
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Invalid screenshot data: {}", e))?;
    let dir = pile_screenshot_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create pile screenshot dir: {}", e))?;
    fs::write(screenshot_file_path(&id), &bytes)
        .map_err(|e| format!("Failed to write pile screenshot: {}", e))
}

/// Read the screenshot for a pile item as base64.
#[tauri::command]
pub fn read_pile_screenshot(id: String) -> Result<String, String> {
    validate_id(&id)?;
    use base64::Engine;
    let bytes = fs::read(screenshot_file_path(&id))
        .map_err(|e| format!("Failed to read pile screenshot: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Delete the screenshot for a pile item (no-op if missing).
#[tauri::command]
pub fn delete_pile_screenshot(id: String) -> Result<(), String> {
    validate_id(&id)?;
    match fs::remove_file(screenshot_file_path(&id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete pile screenshot: {}", e)),
    }
}
