//! Meeting mode commands (see `crate::meeting` and docs/meeting-mode-spec.md).
//!
//! Device-touching commands run on a blocking thread so the main thread / async
//! workers never wait on WASAPI or cpal initialisation.

use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{AppHandle, Manager, State};

use crate::config::AppConfig;
use crate::meeting::types::{AudioProcess, MeetingDetail, MeetingMeta, MeetingPatch, MeetingStartOpts};
use crate::meeting::{capture, storage, MeetingManager};

pub type MeetingState = Arc<MeetingManager>;

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Meeting task failed: {}", e))?
}

#[tauri::command]
pub async fn meeting_start(
    app: AppHandle,
    meetings: State<'_, MeetingState>,
    opts: MeetingStartOpts,
) -> Result<MeetingMeta, String> {
    let manager = meetings.inner().clone();
    let config = app.state::<Mutex<AppConfig>>().lock().clone();
    blocking(move || manager.start(&app, &config, opts)).await
}

#[tauri::command]
pub async fn meeting_stop(meetings: State<'_, MeetingState>, id: String) -> Result<MeetingMeta, String> {
    let manager = meetings.inner().clone();
    blocking(move || manager.stop(&id)).await
}

#[tauri::command]
pub async fn meeting_pause(meetings: State<'_, MeetingState>, id: String) -> Result<MeetingMeta, String> {
    meetings.pause(&id)
}

#[tauri::command]
pub async fn meeting_resume(meetings: State<'_, MeetingState>, id: String) -> Result<MeetingMeta, String> {
    meetings.resume(&id)
}

#[tauri::command]
pub async fn meeting_active(meetings: State<'_, MeetingState>) -> Result<Option<MeetingMeta>, String> {
    Ok(meetings.active())
}

#[tauri::command]
pub async fn meeting_list(meetings: State<'_, MeetingState>) -> Result<Vec<MeetingMeta>, String> {
    let manager = meetings.inner().clone();
    blocking(move || Ok(manager.list())).await
}

#[tauri::command]
pub async fn meeting_get(meetings: State<'_, MeetingState>, id: String) -> Result<MeetingDetail, String> {
    let manager = meetings.inner().clone();
    blocking(move || manager.get(&id)).await
}

#[tauri::command]
pub async fn meeting_update(
    app: AppHandle,
    meetings: State<'_, MeetingState>,
    id: String,
    patch: MeetingPatch,
) -> Result<MeetingMeta, String> {
    meetings.update(&app, &id, patch)
}

#[tauri::command]
pub async fn meeting_get_items(id: String) -> Result<serde_json::Value, String> {
    storage::read_items(&id)
}

#[tauri::command]
pub async fn meeting_save_items(id: String, items: serde_json::Value) -> Result<(), String> {
    storage::write_items(&id, &items)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn meeting_read_segment_audio(id: String, seg_id: String) -> Result<Vec<u8>, String> {
    storage::read_segment_wav(&id, &seg_id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn meeting_retry_segment(
    app: AppHandle,
    meetings: State<'_, MeetingState>,
    id: String,
    seg_id: String,
) -> Result<(), String> {
    meetings.retry_segment(&app, &id, &seg_id)
}

#[tauri::command]
pub async fn meeting_finalize(
    app: AppHandle,
    meetings: State<'_, MeetingState>,
    id: String,
) -> Result<MeetingMeta, String> {
    meetings.finalize(&app, &id)
}

#[tauri::command]
pub async fn meeting_delete(meetings: State<'_, MeetingState>, id: String) -> Result<(), String> {
    let manager = meetings.inner().clone();
    blocking(move || manager.delete(&id)).await
}

#[tauri::command]
pub async fn meeting_list_input_devices() -> Result<Vec<String>, String> {
    blocking(|| Ok(capture::list_input_devices())).await
}

#[tauri::command]
pub async fn meeting_list_audio_processes() -> Result<Vec<AudioProcess>, String> {
    blocking(|| Ok(capture::list_audio_processes())).await
}
