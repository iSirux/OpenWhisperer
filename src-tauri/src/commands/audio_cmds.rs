use crate::config::{AppConfig, WhisperProvider};
use crate::docker;
use crate::whisper::{ConnectionTestResult, WhisperClient};
use parking_lot::Mutex;
use tauri::State;

pub type ConfigState = Mutex<AppConfig>;

/// A reqwest-level failure (refused/timeout/dns) — the server isn't reachable,
/// as opposed to an API error from a live server.
fn is_connection_error(err: &str) -> bool {
    err.starts_with("Request failed")
}

#[tauri::command]
pub async fn transcribe_audio(
    config: State<'_, ConfigState>,
    audio_data: Vec<u8>,
) -> Result<String, String> {
    let cfg = config.lock().clone();

    let client = WhisperClient::new(
        cfg.whisper.endpoint.clone(),
        cfg.whisper.model,
        cfg.whisper.language,
        cfg.whisper.api_key,
    );

    let first_error = match client.transcribe(audio_data.clone()).await {
        Ok(text) => return Ok(text),
        Err(e) => e,
    };

    // Local server unreachable: try starting its Docker container (start only,
    // no build/config) and retry while it comes up.
    let can_autostart = cfg.whisper.provider == WhisperProvider::Local
        && docker::is_local_endpoint(&cfg.whisper.endpoint)
        && is_connection_error(&first_error);
    if !can_autostart
        || docker::try_start_container(&cfg.whisper.docker.container_name)
            .await
            .is_err()
    {
        return Err(first_error);
    }

    // The container may need a moment (model load) before it accepts requests.
    let mut last_error = first_error;
    for _ in 0..15 {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        match client.transcribe(audio_data.clone()).await {
            Ok(text) => return Ok(text),
            Err(e) => {
                let unreachable = is_connection_error(&e);
                last_error = e;
                if !unreachable {
                    break; // Server is up but rejected the request — stop retrying.
                }
            }
        }
    }
    Err(last_error)
}

#[tauri::command]
pub async fn test_whisper_connection(
    config: State<'_, ConfigState>,
) -> Result<ConnectionTestResult, String> {
    let cfg = config.lock().clone();
    let client = WhisperClient::new(
        cfg.whisper.endpoint,
        cfg.whisper.model,
        cfg.whisper.language,
        cfg.whisper.api_key,
    );
    client.test_connection().await
}
