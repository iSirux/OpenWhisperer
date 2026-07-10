use crate::commands::usage_cmds::UsageStatsState;
use crate::config::AppConfig;
use crate::llm::{
    client_from_config, get_api_key, legacy_secrets_path, GenerationResult, KEYRING_LLM_KEY,
    KEYRING_SERVICE,
};
use crate::llm::{
    ConnectionTestResult, InteractionAnalysis, LlmClient, ModelRecommendation, QuickActionsResult,
    RepoRecommendation, SessionNameResult, SessionOutcomeResult, TranscriptionCleanupResult,
};
use parking_lot::Mutex;
use std::fs;
use tauri::{AppHandle, State};
use tauri_plugin_keyring::KeyringExt;

type ConfigState = Mutex<AppConfig>;

/// Track LLM usage in the stats and persist.
fn track_usage(
    stats: &State<UsageStatsState>,
    feature: &str,
    input_tokens: u64,
    output_tokens: u64,
) {
    let mut s = stats.lock();
    s.track_llm_token_usage(feature, input_tokens, output_tokens);
    let _ = s.save();
}

/// Lock the config, verify LLM is enabled and (optionally) that a feature flag
/// is set, then build a client. The `feature_check` closure returns the exact
/// error string the frontend expects when the feature is disabled.
fn prepare_client<F>(
    app: &AppHandle,
    config: &State<'_, ConfigState>,
    feature_check: F,
) -> Result<(AppConfig, LlmClient), String>
where
    F: FnOnce(&AppConfig) -> Result<(), String>,
{
    let cfg = config.lock().clone();
    if !cfg.llm.enabled {
        return Err("LLM integration is not enabled".to_string());
    }
    feature_check(&cfg)?;
    let client = client_from_config(app, &cfg)?;
    Ok((cfg, client))
}

/// Track usage from a generation result and unwrap its data payload.
fn finish<T>(stats: &State<UsageStatsState>, feature: &str, result: GenerationResult<T>) -> T {
    track_usage(
        stats,
        feature,
        result.usage.input_tokens,
        result.usage.output_tokens,
    );
    result.data
}

/// Save the API key to the system keyring
#[tauri::command]
pub async fn save_gemini_api_key(app: AppHandle, api_key: String) -> Result<(), String> {
    app.keyring()
        .set_password(KEYRING_SERVICE, KEYRING_LLM_KEY, &api_key)
        .map_err(|e| format!("Failed to save API key to keyring: {}", e))?;

    // Clean up any legacy file if it exists
    let legacy_path = legacy_secrets_path();
    if legacy_path.exists() {
        let _ = fs::remove_file(&legacy_path);
    }

    Ok(())
}

/// Check if API key is configured
#[tauri::command]
pub async fn has_llm_api_key(
    app: AppHandle,
    config: State<'_, Mutex<AppConfig>>,
) -> Result<bool, String> {
    let llm_config = config.lock().llm.clone();

    // Local provider doesn't require an API key
    if matches!(llm_config.provider, crate::config::LlmProvider::Local) {
        return Ok(true);
    }

    // Check if key exists in keyring (this will also trigger migration if needed)
    Ok(get_api_key(&app).is_ok())
}

// Alias for backwards compatibility
#[tauri::command]
pub async fn has_gemini_api_key(
    app: AppHandle,
    config: State<'_, Mutex<AppConfig>>,
) -> Result<bool, String> {
    has_llm_api_key(app, config).await
}

/// Delete the API key from the system keyring
#[tauri::command]
pub async fn delete_gemini_api_key(app: AppHandle) -> Result<(), String> {
    // Delete from keyring
    match app
        .keyring()
        .delete_password(KEYRING_SERVICE, KEYRING_LLM_KEY)
    {
        Ok(_) => {}
        Err(e) => {
            // Only error if it's not a "not found" type error
            let err_str = format!("{}", e);
            if !err_str.contains("not found") && !err_str.contains("No such") {
                return Err(format!("Failed to delete API key from keyring: {}", e));
            }
        }
    }

    // Also clean up any legacy file
    let legacy_path = legacy_secrets_path();
    if legacy_path.exists() {
        let _ = fs::remove_file(&legacy_path);
    }

    Ok(())
}

/// Test connection to the LLM API
#[tauri::command]
pub async fn test_gemini_connection(
    app: AppHandle,
    config: State<'_, Mutex<AppConfig>>,
) -> Result<ConnectionTestResult, String> {
    let cfg = config.lock().clone();
    let client = client_from_config(&app, &cfg)?;
    client.test_connection().await
}

/// Generate a session name from the user prompt (called immediately when prompt is sent)
#[tauri::command]
pub async fn generate_session_name(
    app: AppHandle,
    config: State<'_, Mutex<AppConfig>>,
    stats: State<'_, UsageStatsState>,
    user_prompt: String,
) -> Result<SessionNameResult, String> {
    let (_cfg, client) = prepare_client(&app, &config, |_| Ok(()))?;
    let result = client
        .generate_session_name_with_usage(&user_prompt)
        .await?;
    Ok(finish(&stats, "session_naming", result))
}

/// Generate a session outcome after the session completes
#[tauri::command]
pub async fn generate_session_outcome(
    app: AppHandle,
    config: State<'_, Mutex<AppConfig>>,
    stats: State<'_, UsageStatsState>,
    user_prompt: String,
    assistant_messages: String,
) -> Result<SessionOutcomeResult, String> {
    let (_cfg, client) = prepare_client(&app, &config, |_| Ok(()))?;
    let result = client
        .generate_session_outcome_with_usage(&user_prompt, &assistant_messages)
        .await?;
    Ok(finish(&stats, "session_outcome", result))
}

/// Analyze if the last message needs human interaction
#[tauri::command]
pub async fn analyze_interaction_needed(
    app: AppHandle,
    config: State<'_, Mutex<AppConfig>>,
    stats: State<'_, UsageStatsState>,
    last_message: String,
) -> Result<InteractionAnalysis, String> {
    let (_cfg, client) = prepare_client(&app, &config, |_| Ok(()))?;
    let result = client
        .analyze_interaction_needed_with_usage(&last_message)
        .await?;
    Ok(finish(&stats, "interaction_analysis", result))
}

/// Clean up a voice transcription
/// When vosk_transcription is provided along with use_dual_transcription enabled,
/// both transcriptions are used to improve accuracy
#[tauri::command]
pub async fn clean_transcription(
    app: AppHandle,
    config: State<'_, Mutex<AppConfig>>,
    stats: State<'_, UsageStatsState>,
    raw_transcription: String,
    vosk_transcription: Option<String>,
    repo_context: Option<String>,
) -> Result<TranscriptionCleanupResult, String> {
    let (cfg, client) = prepare_client(&app, &config, |c| {
        if c.llm.features.clean_transcription {
            Ok(())
        } else {
            Err("Transcription cleanup feature is not enabled".to_string())
        }
    })?;

    // Only use dual transcription if the feature is enabled and Vosk transcription is provided
    let vosk = if cfg.llm.features.use_dual_transcription && cfg.vosk.enabled {
        vosk_transcription.as_deref()
    } else {
        None
    };

    let result = client
        .clean_transcription_with_usage(&raw_transcription, vosk, repo_context.as_deref())
        .await?;
    Ok(finish(&stats, "transcription_cleanup", result))
}

/// Recommend the best model for a prompt
#[tauri::command]
pub async fn recommend_model(
    app: AppHandle,
    config: State<'_, Mutex<AppConfig>>,
    stats: State<'_, UsageStatsState>,
    prompt: String,
    enabled_models: Option<Vec<String>>,
) -> Result<ModelRecommendation, String> {
    let (cfg, client) = prepare_client(&app, &config, |c| {
        if c.llm.features.recommend_model {
            Ok(())
        } else {
            Err("Model recommendation feature is not enabled".to_string())
        }
    })?;

    // Use provided enabled_models or fall back to config
    let models_to_consider = enabled_models.as_ref().unwrap_or(&cfg.enabled_models);
    let result = client
        .recommend_model_with_usage(&prompt, models_to_consider)
        .await?;
    Ok(finish(&stats, "model_recommendation", result))
}

/// Recommend the best repository for a given prompt
#[tauri::command]
pub async fn recommend_repo(
    app: AppHandle,
    config: State<'_, Mutex<AppConfig>>,
    stats: State<'_, UsageStatsState>,
    prompt: String,
    is_transcribed: Option<bool>,
) -> Result<RepoRecommendation, String> {
    let (cfg, client) = prepare_client(&app, &config, |c| {
        if c.llm.features.auto_select_repo {
            Ok(())
        } else {
            Err("Auto-select repository feature is not enabled".to_string())
        }
    })?;

    // Build repos list with descriptions, keywords, and vocabulary (only active repos)
    let active_repos_with_indices: Vec<(usize, &crate::config::RepoConfig)> = cfg
        .repos
        .iter()
        .enumerate()
        .filter(|(_, r)| r.active)
        .collect();

    let repos: Vec<(
        String,
        String,
        Option<String>,
        Option<Vec<String>>,
        Option<Vec<String>>,
    )> = active_repos_with_indices
        .iter()
        .map(|(_, r)| {
            (
                r.name.clone(),
                r.path.clone(),
                r.description.clone(),
                r.keywords.clone(),
                r.vocabulary.clone(),
            )
        })
        .collect();

    let result = client
        .recommend_repo_with_usage(&prompt, &repos, is_transcribed.unwrap_or(false))
        .await?;

    // Track usage (only if we actually made an LLM call - not for empty repos)
    let mut data = if repos.is_empty() {
        result.data
    } else {
        finish(&stats, "repo_recommendation", result)
    };

    // Remap the returned (active-list) index back to the original repos array index.
    if let Some(active_idx) = data.get_index() {
        if let Some((orig_idx, _)) = active_repos_with_indices.get(active_idx) {
            data.recommended_index = *orig_idx as i64;
        }
    }

    Ok(data)
}

/// Generate contextual quick actions based on the session's final message
#[tauri::command]
pub async fn generate_quick_actions(
    app: AppHandle,
    config: State<'_, Mutex<AppConfig>>,
    stats: State<'_, UsageStatsState>,
    user_prompt: String,
    latest_prompt: Option<String>,
    session_activity: Option<String>,
    last_message: String,
) -> Result<QuickActionsResult, String> {
    let (_cfg, client) = prepare_client(&app, &config, |c| {
        if c.llm.features.generate_quick_actions {
            Ok(())
        } else {
            Err("Quick actions generation feature is not enabled".to_string())
        }
    })?;
    let result = client
        .generate_quick_actions_with_usage(
            &user_prompt,
            latest_prompt.as_deref(),
            session_activity.as_deref(),
            &last_message,
        )
        .await?;
    Ok(finish(&stats, "quick_actions", result))
}
