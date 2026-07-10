//! Bounded "rolling" debug log of recent recordings.
//!
//! Mirrors the pile audio/JSON persistence pattern (`pile_cmds`) but is intended
//! purely for debugging: it captures every recording's audio + all transcription
//! stages (Vosk real-time, Whisper raw, LLM cleanup) so a developer can replay and
//! inspect what happened. The frontend keeps the list trimmed to the N newest and
//! deletes evicted audio, so storage stays bounded.
//!
//! Metadata is stored as opaque JSON — the frontend owns the schema.

use std::fs;
use std::path::PathBuf;

use crate::config::AppConfig;
use crate::session_persistence::atomic_write;

/// Path to the debug-recordings metadata file (separate for debug/release builds).
fn debug_recordings_file_path() -> PathBuf {
    #[cfg(debug_assertions)]
    let filename = "debug-recordings.dev.json";
    #[cfg(not(debug_assertions))]
    let filename = "debug-recordings.json";
    AppConfig::config_dir().join(filename)
}

/// Directory where debug-recording audio files are stored.
fn debug_audio_dir() -> PathBuf {
    #[cfg(debug_assertions)]
    let dirname = "debug-recordings-audio-dev";
    #[cfg(not(debug_assertions))]
    let dirname = "debug-recordings-audio";
    AppConfig::config_dir().join(dirname)
}

/// Validate an id for use in file paths (prevents path traversal).
fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("Invalid debug recording id: {}", id));
    }
    Ok(())
}

fn audio_file_path(id: &str) -> PathBuf {
    debug_audio_dir().join(format!("{}.webm", id))
}

/// Load all debug recordings. Stored as opaque JSON — the frontend owns the schema.
#[tauri::command]
pub fn get_debug_recordings() -> Vec<serde_json::Value> {
    let path = debug_recordings_file_path();
    let Ok(content) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&content).unwrap_or_else(|e| {
        eprintln!("[debug-recordings] Failed to parse file, returning empty: {}", e);
        Vec::new()
    })
}

/// Save all debug recordings (full replacement, atomic write).
#[tauri::command]
pub fn save_debug_recordings(items: Vec<serde_json::Value>) -> Result<(), String> {
    let path = debug_recordings_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    let content = serde_json::to_vec_pretty(&items)
        .map_err(|e| format!("Failed to serialize debug recordings: {}", e))?;
    atomic_write(&path, &content)
}

/// Save the audio for a debug recording. Returns the file path.
#[tauri::command]
pub fn save_debug_audio(id: String, audio_data: Vec<u8>) -> Result<String, String> {
    validate_id(&id)?;
    let dir = debug_audio_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create debug audio dir: {}", e))?;
    let path = audio_file_path(&id);
    fs::write(&path, &audio_data).map_err(|e| format!("Failed to write debug audio: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// Read the audio for a debug recording.
#[tauri::command]
pub fn read_debug_audio(id: String) -> Result<Vec<u8>, String> {
    validate_id(&id)?;
    let path = audio_file_path(&id);
    fs::read(&path).map_err(|e| format!("Failed to read debug audio: {}", e))
}

/// Delete the audio for a debug recording (no-op if missing).
#[tauri::command]
pub fn delete_debug_audio(id: String) -> Result<(), String> {
    validate_id(&id)?;
    let path = audio_file_path(&id);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete debug audio: {}", e)),
    }
}
