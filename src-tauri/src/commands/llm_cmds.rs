use crate::commands::usage_cmds::UsageStatsState;
use crate::config::{AppConfig, LlmProvider};
use crate::llm::{
    ConnectionTestResult, InteractionAnalysis, LlmClient, ModelRecommendation,
    QuickActionsResult, RepoRecommendation, SessionNameResult,
    SessionOutcomeResult, TranscriptionCleanupResult,
};
use parking_lot::Mutex;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, State};
use tauri_plugin_keyring::KeyringExt;

/// Helper to track LLM usage in the stats
fn track_usage(stats: &State<UsageStatsState>, feature: &str, input_tokens: u64, output_tokens: u64) {
    let mut s = stats.lock();
    s.track_llm_token_usage(feature, input_tokens, output_tokens);
    let _ = s.save();
}

/// Service name for keyring storage
const KEYRING_SERVICE: &str = "claude-whisperer";
/// User/account name for the LLM API key
const KEYRING_LLM_KEY: &str = "llm-api-key";

// --- Legacy obfuscation for migration purposes only ---

fn legacy_deobfuscate(data: &[u8], key: &[u8]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(i, b)| b ^ key[i % key.len()])
        .collect()
}

const LEGACY_OBFUSCATION_KEY: &[u8] = b"claude-whisperer-gemini-key-protection";

fn get_legacy_secrets_path() -> PathBuf {
    AppConfig::config_dir().join("gemini_key.dat")
}

/// Migrate legacy XOR-obfuscated key to secure keyring storage
/// Returns Ok(true) if migration happened, Ok(false) if no migration needed
fn migrate_legacy_key(app: &AppHandle) -> Result<bool, String> {
    let legacy_path = get_legacy_secrets_path();

    if !legacy_path.exists() {
        return Ok(false);
    }

    // Read and decode the legacy key
    let encrypted = fs::read(&legacy_path)
        .map_err(|e| format!("Failed to read legacy API key file: {}", e))?;

    let decrypted = legacy_deobfuscate(&encrypted, LEGACY_OBFUSCATION_KEY);

    let api_key = String::from_utf8(decrypted)
        .map_err(|e| format!("Failed to decode legacy API key: {}", e))?;

    // Store in keyring
    app.keyring()
        .set_password(KEYRING_SERVICE, KEYRING_LLM_KEY, &api_key)
        .map_err(|e| format!("Failed to migrate API key to keyring: {}", e))?;

    // Delete the legacy file
    if let Err(e) = fs::remove_file(&legacy_path) {
        log::error!("[keyring] Warning: Failed to delete legacy key file: {}", e);
        // Don't fail migration just because we couldn't delete the old file
    } else {
        log::error!("[keyring] Successfully migrated API key from legacy storage to system keyring");
    }

    Ok(true)
}

/// Helper to get the API key from keyring
fn get_api_key_internal(app: &AppHandle) -> Result<String, String> {
    // First, try to migrate legacy key if it exists
    let _ = migrate_legacy_key(app);

    // Get from keyring
    match app.keyring().get_password(KEYRING_SERVICE, KEYRING_LLM_KEY) {
        Ok(Some(key)) => Ok(key),
        Ok(None) => Err("API key not set".to_string()),
        Err(e) => Err(format!("Failed to get API key from keyring: {}", e)),
    }
}

/// Helper to create an LlmClient with proper configuration
fn create_client(app: &AppHandle, config: &AppConfig) -> Result<LlmClient, String> {
    let llm_config = &config.llm;

    // For local provider, API key is optional
    let api_key = if matches!(llm_config.provider, LlmProvider::Local) {
        get_api_key_internal(app).unwrap_or_default()
    } else {
        get_api_key_internal(app)?
    };

    Ok(LlmClient::new(
        api_key,
        llm_config.model.clone(),
        llm_config.provider.clone(),
        llm_config.endpoint.clone(),
        llm_config.auto_model,
        llm_config.model_priority.clone(),
    ))
}

/// Save the API key to the system keyring
#[tauri::command]
pub async fn save_gemini_api_key(app: AppHandle, api_key: String) -> Result<(), String> {
    app.keyring()
        .set_password(KEYRING_SERVICE, KEYRING_LLM_KEY, &api_key)
        .map_err(|e| format!("Failed to save API key to keyring: {}", e))?;

    // Clean up any legacy file if it exists
    let legacy_path = get_legacy_secrets_path();
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
    if matches!(llm_config.provider, LlmProvider::Local) {
        return Ok(true);
    }

    // Check if key exists in keyring (this will also trigger migration if needed)
    Ok(get_api_key_internal(&app).is_ok())
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
    match app.keyring().delete_password(KEYRING_SERVICE, KEYRING_LLM_KEY) {
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
    let legacy_path = get_legacy_secrets_path();
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
    let client = create_client(&app, &cfg)?;
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
    let cfg = config.lock().clone();

    if !cfg.llm.enabled {
        return Err("LLM integration is not enabled".to_string());
    }

    let client = create_client(&app, &cfg)?;
    let result = client.generate_session_name_with_usage(&user_prompt).await?;

    // Track usage
    track_usage(&stats, "session_naming", result.usage.input_tokens, result.usage.output_tokens);

    Ok(result.data)
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
    let cfg = config.lock().clone();

    if !cfg.llm.enabled {
        return Err("LLM integration is not enabled".to_string());
    }

    let client = create_client(&app, &cfg)?;
    let result = client
        .generate_session_outcome_with_usage(&user_prompt, &assistant_messages)
        .await?;

    // Track usage
    track_usage(&stats, "session_outcome", result.usage.input_tokens, result.usage.output_tokens);

    Ok(result.data)
}

/// Analyze if the last message needs human interaction
#[tauri::command]
pub async fn analyze_interaction_needed(
    app: AppHandle,
    config: State<'_, Mutex<AppConfig>>,
    stats: State<'_, UsageStatsState>,
    last_message: String,
) -> Result<InteractionAnalysis, String> {
    let cfg = config.lock().clone();

    if !cfg.llm.enabled {
        return Err("LLM integration is not enabled".to_string());
    }

    let client = create_client(&app, &cfg)?;
    let result = client.analyze_interaction_needed_with_usage(&last_message).await?;

    // Track usage
    track_usage(&stats, "interaction_analysis", result.usage.input_tokens, result.usage.output_tokens);

    Ok(result.data)
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
    let cfg = config.lock().clone();

    if !cfg.llm.enabled {
        return Err("LLM integration is not enabled".to_string());
    }

    if !cfg.llm.features.clean_transcription {
        return Err("Transcription cleanup feature is not enabled".to_string());
    }

    let client = create_client(&app, &cfg)?;

    // Only use dual transcription if the feature is enabled and Vosk transcription is provided
    let vosk = if cfg.llm.features.use_dual_transcription && cfg.vosk.enabled {
        vosk_transcription.as_deref()
    } else {
        None
    };

    let result = client
        .clean_transcription_with_usage(&raw_transcription, vosk, repo_context.as_deref())
        .await?;

    // Track usage
    track_usage(&stats, "transcription_cleanup", result.usage.input_tokens, result.usage.output_tokens);

    Ok(result.data)
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
    let cfg = config.lock().clone();

    if !cfg.llm.enabled {
        return Err("LLM integration is not enabled".to_string());
    }

    if !cfg.llm.features.recommend_model {
        return Err("Model recommendation feature is not enabled".to_string());
    }

    let client = create_client(&app, &cfg)?;

    // Use provided enabled_models or fall back to config
    let models_to_consider = enabled_models.as_ref().unwrap_or(&cfg.enabled_models);
    let result = client.recommend_model_with_usage(&prompt, models_to_consider).await?;

    // Track usage
    track_usage(&stats, "model_recommendation", result.usage.input_tokens, result.usage.output_tokens);

    Ok(result.data)
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
    let cfg = config.lock().clone();

    if !cfg.llm.enabled {
        return Err("LLM integration is not enabled".to_string());
    }

    if !cfg.llm.features.auto_select_repo {
        return Err("Auto-select repository feature is not enabled".to_string());
    }

    let client = create_client(&app, &cfg)?;

    // Build repos list with descriptions, keywords, and vocabulary (only active repos)
    let active_repos_with_indices: Vec<(usize, &crate::config::RepoConfig)> = cfg
        .repos
        .iter()
        .enumerate()
        .filter(|(_, r)| r.active)
        .collect();

    let repos: Vec<(String, String, Option<String>, Option<Vec<String>>, Option<Vec<String>>)> = active_repos_with_indices
        .iter()
        .map(|(_, r)| (
            r.name.clone(),
            r.path.clone(),
            r.description.clone(),
            r.keywords.clone(),
            r.vocabulary.clone(),
        ))
        .collect();

    let result = client.recommend_repo_with_usage(&prompt, &repos, is_transcribed.unwrap_or(false)).await?;

    // Track usage (only if we actually made an LLM call - not for empty repos)
    if !repos.is_empty() {
        track_usage(&stats, "repo_recommendation", result.usage.input_tokens, result.usage.output_tokens);
    }

    // Remap the returned index back to the original repos array index
    let mut data = result.data;
    if data.recommended_index >= 0 {
        let active_idx = data.recommended_index as usize;
        if active_idx < active_repos_with_indices.len() {
            data.recommended_index = active_repos_with_indices[active_idx].0 as i64;
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
    last_message: String,
) -> Result<QuickActionsResult, String> {
    let cfg = config.lock().clone();

    if !cfg.llm.enabled {
        return Err("LLM integration is not enabled".to_string());
    }

    if !cfg.llm.features.generate_quick_actions {
        return Err("Quick actions generation feature is not enabled".to_string());
    }

    let client = create_client(&app, &cfg)?;
    let result = client
        .generate_quick_actions_with_usage(&user_prompt, &last_message)
        .await?;

    // Track usage
    track_usage(&stats, "quick_actions", result.usage.input_tokens, result.usage.output_tokens);

    Ok(result.data)
}
