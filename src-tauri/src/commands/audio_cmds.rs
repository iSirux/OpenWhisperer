use crate::config::{AppConfig, LlmProvider, WhisperConfig, WhisperProvider};
use crate::docker;
use crate::whisper::{self, ConnectionTestResult};
use parking_lot::Mutex;
use tauri::{AppHandle, State};

pub type ConfigState = Mutex<AppConfig>;

/// A connect-phase failure (refused / DNS / connect timeout) — the server
/// isn't reachable, as opposed to an API error from a live server. A read
/// timeout (server reached, still transcribing) is reported by `whisper.rs`
/// without the `"Request failed"` prefix, so it never triggers the Docker
/// autostart + re-send loop.
fn is_connection_error(err: &str) -> bool {
    err.starts_with("Request failed")
}

/// Whether `key` is recognisably another provider's key and must not be sent
/// to OpenRouter (whose keys are `sk-or-…`): OpenAI `sk-…` / `sk-proj-…`,
/// Groq `gsk_…`. Catches a key left over from switching the dictation provider
/// (or saved before the UI cleared keys on provider change).
fn is_foreign_key_for_openrouter(key: &str) -> bool {
    let k = key.trim();
    k.starts_with("gsk_") || (k.starts_with("sk-") && !k.starts_with("sk-or-"))
}

/// Fill in the transcription API key when the Whisper settings leave it blank.
///
/// OpenRouter: one key covers transcription and the LLM layer, so an empty
/// `whisper.api_key` falls back to the keyring key of the first LLM profile
/// whose provider is OpenRouter. A key that clearly belongs to another
/// provider (see [`is_foreign_key_for_openrouter`]) is dropped first — it's a
/// stale leftover and must not leak to OpenRouter. Other providers keep their
/// configured key. The meeting pipeline calls this on its (possibly
/// overridden) config before `whisper::transcribe_detailed`.
pub fn resolve_whisper_api_key(app: &AppHandle, app_config: &AppConfig, whisper: &mut WhisperConfig) {
    if whisper.provider != WhisperProvider::OpenRouter {
        return;
    }
    if whisper.api_key.as_deref().is_some_and(is_foreign_key_for_openrouter) {
        log::warn!("Ignoring a non-OpenRouter API key saved for OpenRouter transcription");
        whisper.api_key = None;
    }
    let has_key = whisper.api_key.as_deref().is_some_and(|k| !k.trim().is_empty());
    if has_key {
        return;
    }
    for profile in &app_config.llm.profiles {
        if profile.provider == LlmProvider::OpenRouter {
            if let Ok(key) = crate::llm::get_api_key(app, &profile.id) {
                if !key.is_empty() {
                    whisper.api_key = Some(key);
                    return;
                }
            }
        }
    }
}

fn effective_whisper_config(app: &AppHandle, config: &State<'_, ConfigState>) -> WhisperConfig {
    let cfg = config.lock().clone();
    let mut whisper = cfg.whisper.clone();
    resolve_whisper_api_key(app, &cfg, &mut whisper);
    whisper
}

#[tauri::command]
pub async fn transcribe_audio(
    app: AppHandle,
    config: State<'_, ConfigState>,
    audio_data: Vec<u8>,
) -> Result<String, String> {
    let wcfg = effective_whisper_config(&app, &config);

    let first_error = match whisper::transcribe_text(&wcfg, audio_data.clone(), None).await {
        Ok(text) => return Ok(text),
        Err(e) => e,
    };

    // Local server unreachable: try starting its Docker container (start only,
    // no build/config) and retry while it comes up.
    let can_autostart = wcfg.provider == WhisperProvider::Local
        && docker::is_local_endpoint(&wcfg.endpoint)
        && is_connection_error(&first_error);
    if !can_autostart
        || docker::try_start_container(&wcfg.docker.container_name)
            .await
            .is_err()
    {
        return Err(first_error);
    }

    // The container may need a moment (model load) before it accepts requests.
    let mut last_error = first_error;
    for _ in 0..15 {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        match whisper::transcribe_text(&wcfg, audio_data.clone(), None).await {
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
    app: AppHandle,
    config: State<'_, ConfigState>,
) -> Result<ConnectionTestResult, String> {
    let wcfg = effective_whisper_config(&app, &config);
    Ok(whisper::test_connection(&wcfg).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_unreachable_errors_trigger_autostart() {
        assert!(is_connection_error("Request failed: error sending request: connection refused"));
        assert!(!is_connection_error(
            "Transcription timed out after 2460s (the server is reachable but didn't finish in time): …"
        ));
        assert!(!is_connection_error("Whisper API error (500): boom"));
    }

    #[test]
    fn foreign_keys_are_not_sent_to_openrouter() {
        assert!(is_foreign_key_for_openrouter("sk-proj-abc"));
        assert!(is_foreign_key_for_openrouter("sk-abc"));
        assert!(is_foreign_key_for_openrouter(" gsk_abc "));
        assert!(!is_foreign_key_for_openrouter("sk-or-v1-abc"));
        assert!(!is_foreign_key_for_openrouter("custom-token"));
    }
}
