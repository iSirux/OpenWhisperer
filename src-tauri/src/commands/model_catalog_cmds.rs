//! Live model catalog: asks the sidecar which models each provider's SDK/CLI
//! currently offers, and persists the frontend's cached copy.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::{AppHandle, Listener, State};
use tokio::sync::oneshot;

use crate::config::AppConfig;
use crate::session_persistence::atomic_write;
use crate::sidecar::{OutboundMessage, SidecarManager};

/// Covers a cold sidecar start plus the sidecar's own 30 s listing timeout.
const LIST_TIMEOUT: Duration = Duration::from_secs(60);

fn model_catalog_file_path() -> PathBuf {
    #[cfg(debug_assertions)]
    let filename = "model-catalog.dev.json";
    #[cfg(not(debug_assertions))]
    let filename = "model-catalog.json";
    AppConfig::config_dir().join(filename)
}

/// Load the cached catalog blob. Opaque JSON — the frontend owns the schema.
#[tauri::command]
pub fn load_model_catalog() -> Option<String> {
    match fs::read_to_string(model_catalog_file_path()) {
        Ok(content) => Some(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            log::warn!("[model-catalog] Failed to read cache: {}", e);
            None
        }
    }
}

/// Save the cached catalog blob (full replacement, atomic write).
#[tauri::command]
pub fn save_model_catalog(data: String) -> Result<(), String> {
    let path = model_catalog_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    atomic_write(&path, data.as_bytes())
}

/// Fetch the models `provider` ("claude" | "openai") offers right now, via the
/// sidecar (Claude `supportedModels()` / Codex app-server `model/list`).
#[tauri::command]
pub async fn list_agent_models(
    app: AppHandle,
    sidecar: State<'_, Arc<SidecarManager>>,
    provider: String,
) -> Result<serde_json::Value, String> {
    if provider != "claude" && provider != "openai" {
        return Err(format!("Unknown provider: {}", provider));
    }
    let id = format!("models-{}-{}", provider, uuid::Uuid::new_v4());

    let (tx, rx) = oneshot::channel::<Result<serde_json::Value, String>>();
    let tx = Arc::new(Mutex::new(Some(tx)));

    let tx_ok = Arc::clone(&tx);
    let ok_id = app.listen(format!("models-listed-{}", id), move |event| {
        let parsed = serde_json::from_str::<serde_json::Value>(event.payload())
            .map_err(|e| format!("Failed to parse model list: {}", e));
        if let Some(tx) = tx_ok.lock().take() {
            let _ = tx.send(parsed);
        }
    });
    let tx_err = Arc::clone(&tx);
    let err_id = app.listen(format!("models-list-error-{}", id), move |event| {
        let msg = serde_json::from_str::<String>(event.payload())
            .unwrap_or_else(|_| event.payload().to_string());
        if let Some(tx) = tx_err.lock().take() {
            let _ = tx.send(Err(msg));
        }
    });

    let result = match sidecar.send_or_start(app.clone(), OutboundMessage::ListModels { id, provider }) {
        Ok(()) => match tokio::time::timeout(LIST_TIMEOUT, rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("Model listing was dropped".to_string()),
            Err(_) => Err("Timed out listing models".to_string()),
        },
        Err(e) => Err(format!("Failed to reach sidecar: {}", e)),
    };
    app.unlisten(ok_id);
    app.unlisten(err_id);
    result
}
