use crate::config::{AppConfig, RealtimeProvider};
use crate::docker;
use crate::realtime::{
    test_sherpa_connection, test_speaches_connection, test_vosk_connection, test_vsai_connection,
    RealtimeConnectionTestResult, RealtimeResponse, RealtimeSessionManager,
};
use crate::util::emit_or_log;
use parking_lot::Mutex as ParkingLotMutex;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, State};

pub type ConfigState = ParkingLotMutex<AppConfig>;

#[tauri::command]
pub async fn test_realtime_connection(
    config: State<'_, ConfigState>,
) -> Result<RealtimeConnectionTestResult, String> {
    let cfg = config.lock().clone();

    if !cfg.vosk.enabled {
        return Ok(RealtimeConnectionTestResult {
            connected: false,
            error: Some("Real-time transcription is not enabled".to_string()),
        });
    }

    match cfg.vosk.provider {
        RealtimeProvider::Vosk => {
            Ok(test_vosk_connection(&cfg.vosk.endpoint, cfg.vosk.sample_rate).await)
        }
        RealtimeProvider::VoiceStreamAI => {
            Ok(test_vsai_connection(&cfg.vosk.voice_stream_ai.endpoint).await)
        }
        RealtimeProvider::SherpaOnnx => {
            Ok(test_sherpa_connection(&cfg.vosk.sherpa_onnx.endpoint).await)
        }
        RealtimeProvider::Speaches => Ok(test_speaches_connection(&cfg.vosk.speaches).await),
        // Moonshine's shim server speaks the Vosk protocol
        RealtimeProvider::Moonshine => Ok(test_vosk_connection(
            &cfg.vosk.moonshine.endpoint,
            cfg.vosk.moonshine.sample_rate,
        )
        .await),
    }
}

#[tauri::command]
pub async fn start_realtime_session(
    app: AppHandle,
    config: State<'_, ConfigState>,
    realtime_manager: State<'_, Arc<RealtimeSessionManager>>,
    session_id: String,
) -> Result<(), String> {
    let cfg = config.lock().clone();

    if !cfg.vosk.enabled {
        return Err("Real-time transcription is not enabled".to_string());
    }

    // Stop any existing polling loop and close the old session first, so we
    // never leave a duplicate poller racing against the new session (I6).
    realtime_manager.stop_polling(&session_id).await;
    if let Some(old_session) = realtime_manager.remove_session(&session_id).await {
        match old_session.try_lock() {
            Ok(mut session) => {
                if let Err(e) = session.close().await {
                    log::warn!("Failed to close previous realtime session: {}", e);
                }
            }
            Err(_) => {
                log::warn!(
                    "Could not lock previous realtime session {} to close it",
                    session_id
                );
            }
        }
    }

    let create = || {
        realtime_manager.create_session(
            session_id.clone(),
            &cfg.vosk.provider,
            &cfg.vosk.endpoint,
            cfg.vosk.sample_rate,
            &cfg.vosk.voice_stream_ai,
            &cfg.vosk.sherpa_onnx,
            &cfg.vosk.speaches,
            &cfg.vosk.moonshine,
        )
    };

    if let Err(first_error) = create().await {
        // Local server unreachable: try starting its Docker container (start
        // only, no build/config), then retry while it comes up. The recording
        // flow doesn't await this command, so waiting here is safe.
        let (endpoint, container_name) = match cfg.vosk.provider {
            RealtimeProvider::Vosk => (&cfg.vosk.endpoint, &cfg.vosk.docker.container_name),
            RealtimeProvider::VoiceStreamAI => (
                &cfg.vosk.voice_stream_ai.endpoint,
                &cfg.vosk.voice_stream_ai.docker.container_name,
            ),
            RealtimeProvider::SherpaOnnx => (
                &cfg.vosk.sherpa_onnx.endpoint,
                &cfg.vosk.sherpa_onnx.docker.container_name,
            ),
            RealtimeProvider::Speaches => (
                &cfg.vosk.speaches.endpoint,
                &cfg.vosk.speaches.docker.container_name,
            ),
            RealtimeProvider::Moonshine => (
                &cfg.vosk.moonshine.endpoint,
                &cfg.vosk.moonshine.docker.container_name,
            ),
        };

        if !docker::is_local_endpoint(endpoint)
            || docker::try_start_container(container_name).await.is_err()
        {
            return Err(first_error);
        }

        // The container may need a moment (model load) before it accepts
        // connections.
        let mut last_error = first_error;
        let mut connected = false;
        for _ in 0..20 {
            tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;
            match create().await {
                Ok(()) => {
                    connected = true;
                    break;
                }
                Err(e) => last_error = e,
            }
        }
        if !connected {
            return Err(last_error);
        }
    }

    // Cooperative cancellation for the polling loop; stop_realtime_session flips
    // this and awaits the loop's exit before finalizing (I6).
    let cancel = match realtime_manager.get_cancel(&session_id).await {
        Some(c) => c,
        None => return Err("Realtime session vanished right after creation".to_string()),
    };

    let manager = Arc::clone(&*realtime_manager);
    let session_id_clone = session_id.clone();
    let app_clone = app.clone();

    let handle = tokio::spawn(async move {
        // Add a small initial delay to ensure session is fully registered
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;

        let mut consecutive_errors = 0;
        const MAX_CONSECUTIVE_ERRORS: u32 = 5;

        loop {
            if cancel.load(Ordering::Relaxed) {
                break;
            }

            let session = match manager.get_session(&session_id_clone).await {
                Some(s) => s,
                None => break,
            };

            let result = {
                let mut session_guard = session.lock().await;
                session_guard.try_recv().await
            };

            match result {
                Ok(Some(RealtimeResponse::Partial { partial })) => {
                    consecutive_errors = 0;
                    emit_or_log(
                        &app_clone,
                        &format!("realtime-partial-{}", session_id_clone),
                        serde_json::json!({ "partial": partial }),
                    );
                }
                Ok(Some(RealtimeResponse::Final { text })) => {
                    consecutive_errors = 0;
                    emit_or_log(
                        &app_clone,
                        &format!("realtime-final-{}", session_id_clone),
                        serde_json::json!({ "text": text }),
                    );
                }
                Ok(None) => {
                    consecutive_errors = 0;
                    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
                }
                Err(e) => {
                    consecutive_errors += 1;
                    emit_or_log(
                        &app_clone,
                        &format!("realtime-error-{}", session_id_clone),
                        serde_json::json!({ "error": e }),
                    );

                    if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                        break;
                    }

                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                }
            }
        }
    });

    realtime_manager.set_poll_handle(&session_id, handle).await;

    Ok(())
}

#[tauri::command]
pub async fn send_realtime_audio(
    realtime_manager: State<'_, Arc<RealtimeSessionManager>>,
    session_id: String,
    samples: Vec<i16>,
) -> Result<(), String> {
    let session = realtime_manager
        .get_session(&session_id)
        .await
        .ok_or_else(|| format!("Realtime session {} not found", session_id))?;

    let mut session_guard = session.lock().await;
    session_guard.send_audio(&samples).await
}

#[tauri::command]
pub async fn stop_realtime_session(
    app: AppHandle,
    realtime_manager: State<'_, Arc<RealtimeSessionManager>>,
    session_id: String,
) -> Result<String, String> {
    // Signal the polling loop and wait for it to exit BEFORE finalizing, so the
    // final drain doesn't race an in-flight try_recv (I6).
    realtime_manager.stop_polling(&session_id).await;

    let final_text = realtime_manager.close_session(&session_id).await?;

    emit_or_log(
        &app,
        &format!("realtime-final-{}", session_id),
        serde_json::json!({ "text": final_text }),
    );

    Ok(final_text)
}
