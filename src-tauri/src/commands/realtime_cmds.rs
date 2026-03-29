use crate::config::{AppConfig, RealtimeProvider};
use crate::realtime::{
    test_sherpa_connection, test_speaches_connection, test_vosk_connection, test_vsai_connection,
    RealtimeConnectionTestResult, RealtimeResponse, RealtimeSessionManager,
};
use parking_lot::Mutex as ParkingLotMutex;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

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

    // Close any existing session with this ID first to prevent duplicate polling tasks
    if let Some(old_session) = realtime_manager.remove_session(&session_id).await {
        if let Ok(mut session) = old_session.try_lock() {
            let _ = session.close().await;
        }
    }

    realtime_manager
        .create_session(
            session_id.clone(),
            &cfg.vosk.provider,
            &cfg.vosk.endpoint,
            cfg.vosk.sample_rate,
            &cfg.vosk.voice_stream_ai,
            &cfg.vosk.sherpa_onnx,
            &cfg.vosk.speaches,
        )
        .await?;

    let manager = Arc::clone(&*realtime_manager);
    let session_id_clone = session_id.clone();
    let app_clone = app.clone();

    tokio::spawn(async move {
        // Add a small initial delay to ensure session is fully registered
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;

        let mut consecutive_errors = 0;
        const MAX_CONSECUTIVE_ERRORS: u32 = 5;

        loop {
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
                    let _ = app_clone.emit(
                        &format!("realtime-partial-{}", session_id_clone),
                        serde_json::json!({ "partial": partial }),
                    );
                }
                Ok(Some(RealtimeResponse::Final { text })) => {
                    consecutive_errors = 0;
                    let _ = app_clone.emit(
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
                    let _ = app_clone.emit(
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
    let final_text = realtime_manager.close_session(&session_id).await?;

    let _ = app.emit(
        &format!("realtime-final-{}", session_id),
        serde_json::json!({ "text": final_text }),
    );

    Ok(final_text)
}
