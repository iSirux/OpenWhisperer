//! Tauri commands for the in-app local LLM setup (see `crate::local_llm`).

use parking_lot::Mutex;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::config::{AppConfig, WhisperProvider};
use crate::local_llm::{
    self, hardware::HardwareProbe, presets, server::BenchmarkResult, InstallOutcome,
    LocalLlmManager, LocalLlmStatus, ModelSource,
};

type ConfigState = Mutex<AppConfig>;
type Manager = Arc<LocalLlmManager>;

#[derive(Serialize)]
pub struct ProbeResult {
    pub hardware: HardwareProbe,
    pub recommendation: presets::Recommendation,
    /// The Whisper provider is the local container (its VRAM was reserved).
    pub whisper_local: bool,
    pub default_models_dir: String,
}

#[tauri::command]
pub async fn local_llm_probe(config: State<'_, ConfigState>) -> Result<ProbeResult, String> {
    let (cfg, whisper_local) = {
        let c = config.lock();
        (c.local_llm.clone(), c.whisper.provider == WhisperProvider::Local)
    };
    let dir = local_llm::models_dir(&cfg);
    let hardware = tauri::async_runtime::spawn_blocking(move || local_llm::hardware::probe(&dir))
        .await
        .map_err(|e| e.to_string())?;
    let recommendation = presets::recommend(&hardware, whisper_local);
    Ok(ProbeResult {
        hardware,
        recommendation,
        whisper_local,
        default_models_dir: local_llm::default_models_dir().to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn local_llm_presets() -> Vec<presets::ModelPreset> {
    presets::PRESETS.to_vec()
}

#[tauri::command]
pub fn local_llm_status(manager: State<'_, Manager>) -> LocalLlmStatus {
    manager.status()
}

/// Run the one-click setup. Exactly one of `preset_id` / `existing_path`.
#[tauri::command]
pub async fn local_llm_install(
    app: AppHandle,
    manager: State<'_, Manager>,
    preset_id: Option<String>,
    existing_path: Option<String>,
    use_for_quality: bool,
    use_for_fast: bool,
) -> Result<InstallOutcome, String> {
    let source = match (preset_id, existing_path) {
        (_, Some(p)) if !p.trim().is_empty() => ModelSource::Existing(PathBuf::from(p.trim())),
        (Some(id), _) => ModelSource::Preset(id),
        _ => return Err("Choose a model preset or an existing .gguf file".into()),
    };
    let mgr = manager.inner().clone();
    mgr.install(&app, source, use_for_quality, use_for_fast).await
}

#[tauri::command]
pub fn local_llm_cancel(manager: State<'_, Manager>) {
    manager.request_cancel();
}

#[tauri::command]
pub async fn local_llm_start(
    app: AppHandle,
    manager: State<'_, Manager>,
    config: State<'_, ConfigState>,
) -> Result<LocalLlmStatus, String> {
    let cfg = config.lock().local_llm.clone();
    if !cfg.is_set_up() {
        return Err("Set up a local model first".into());
    }
    let mgr = manager.inner().clone();
    mgr.clear_cancel();
    let status = mgr.start(&cfg).await?;
    local_llm::sync_profile_port(&app, status.port);
    Ok(status)
}

#[tauri::command]
pub async fn local_llm_stop(manager: State<'_, Manager>) -> Result<LocalLlmStatus, String> {
    manager.stop().await;
    Ok(manager.status())
}

#[tauri::command]
pub async fn local_llm_uninstall(
    app: AppHandle,
    manager: State<'_, Manager>,
    remove_models: bool,
) -> Result<(), String> {
    let mgr = manager.inner().clone();
    mgr.uninstall(&app, remove_models).await
}

#[tauri::command]
pub async fn local_llm_benchmark(
    manager: State<'_, Manager>,
    config: State<'_, ConfigState>,
) -> Result<BenchmarkResult, String> {
    let port = manager.port().ok_or("The local model is not running")?;
    let name = config
        .lock()
        .local_llm
        .model_name
        .clone()
        .unwrap_or_else(|| "local-model".into());
    local_llm::server::benchmark(port, &name).await
}

/// Change where the local profile sits in the routing chains (creates the
/// profile when it was deleted). Returns nothing; the new config arrives via
/// the `local-llm-config` event.
#[tauri::command]
pub fn local_llm_set_routing(
    app: AppHandle,
    manager: State<'_, Manager>,
    use_for_quality: bool,
    use_for_fast: bool,
) -> Result<(), String> {
    let running_port = manager.port();
    local_llm::update_config(&app, |c| {
        c.local_llm.use_for_quality = use_for_quality;
        c.local_llm.use_for_fast = use_for_fast;
        if c.local_llm.is_set_up() {
            let port = running_port.unwrap_or(c.local_llm.port);
            local_llm::apply_profile(c, port, true);
        }
    })
}
