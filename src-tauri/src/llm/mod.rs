//! Unified LLM client supporting multiple providers (Gemini, OpenAI, Groq, Local)

mod api_types;
mod features;
mod providers;
mod types;
mod utils;

pub use providers::GenerationResult;
pub use types::*;

use crate::config::{AppConfig, LlmModelPriority, LlmProvider};
use tauri::AppHandle;
use tauri_plugin_keyring::KeyringExt;

// ---------------------------------------------------------------------------
// Keyring / API-key management (single source of truth; T5)
// ---------------------------------------------------------------------------

/// Service name for keyring storage. MUST NOT change when the app is renamed,
/// or existing users' stored credentials become unreadable.
pub(crate) const KEYRING_SERVICE: &str = "open-whisperer";
/// Account/user name for the stored LLM API key.
pub(crate) const KEYRING_LLM_KEY: &str = "llm-api-key";

// --- Legacy XOR obfuscation (migration path only) ---

fn legacy_deobfuscate(data: &[u8], key: &[u8]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(i, b)| b ^ key[i % key.len()])
        .collect()
}

// NOTE: This XOR key is a fixed historical constant used to decrypt pre-keyring
// `gemini_key.dat` files. It must NOT be renamed when the app is renamed, or
// existing users' legacy keys become undecryptable.
const LEGACY_OBFUSCATION_KEY: &[u8] = b"claude-whisperer-gemini-key-protection";

pub(crate) fn legacy_secrets_path() -> std::path::PathBuf {
    AppConfig::config_dir().join("gemini_key.dat")
}

/// Migrate a legacy XOR-obfuscated key to secure keyring storage.
/// Returns Ok(true) if migration happened, Ok(false) if no migration was needed.
pub(crate) fn migrate_legacy_key(app: &AppHandle) -> Result<bool, String> {
    let legacy_path = legacy_secrets_path();
    if !legacy_path.exists() {
        return Ok(false);
    }

    let encrypted = std::fs::read(&legacy_path)
        .map_err(|e| format!("Failed to read legacy API key file: {}", e))?;
    let decrypted = legacy_deobfuscate(&encrypted, LEGACY_OBFUSCATION_KEY);
    let api_key = String::from_utf8(decrypted)
        .map_err(|e| format!("Failed to decode legacy API key: {}", e))?;

    app.keyring()
        .set_password(KEYRING_SERVICE, KEYRING_LLM_KEY, &api_key)
        .map_err(|e| format!("Failed to migrate API key to keyring: {}", e))?;

    if let Err(e) = std::fs::remove_file(&legacy_path) {
        log::warn!("[keyring] Failed to delete legacy key file: {}", e);
    } else {
        log::info!("[keyring] Migrated API key from legacy storage to system keyring");
    }

    Ok(true)
}

/// Read the stored LLM API key from the keyring, migrating any legacy key first.
pub(crate) fn get_api_key(app: &AppHandle) -> Result<String, String> {
    let _ = migrate_legacy_key(app);

    match app.keyring().get_password(KEYRING_SERVICE, KEYRING_LLM_KEY) {
        Ok(Some(key)) => Ok(key),
        Ok(None) => Err("API key not set".to_string()),
        Err(e) => Err(format!("Failed to get API key from keyring: {}", e)),
    }
}

/// Canonical LLM client factory: builds an [`LlmClient`] from the app config.
/// For the Local provider the API key is optional (empty is allowed); for all
/// other providers a missing key is an error.
pub(crate) fn client_from_config(
    app: &AppHandle,
    config: &AppConfig,
) -> Result<LlmClient, String> {
    let llm = &config.llm;

    let api_key = if matches!(llm.provider, LlmProvider::Local) {
        get_api_key(app).unwrap_or_default()
    } else {
        get_api_key(app)?
    };

    Ok(LlmClient::new(
        api_key,
        llm.model.clone(),
        llm.provider.clone(),
        llm.endpoint.clone(),
        llm.auto_model,
        llm.model_priority.clone(),
    ))
}

/// Model fallback chains for Gemini provider
/// As of mid-2026 the free tier centers on the Gemini 3 series (3.5 Flash /
/// 3.1 Flash-Lite, both free) with the 2.5 Flash models kept as fallbacks.
const GEMINI_MODELS_SPEED: &[&str] =
    &["gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-2.5-flash-lite"];

const GEMINI_MODELS_ACCURACY: &[&str] =
    &["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash"];

/// Unified LLM client that supports multiple providers (Gemini, OpenAI, Groq, Local)
pub struct LlmClient {
    client: reqwest::Client,
    api_key: String,
    model: String,
    provider: LlmProvider,
    endpoint: Option<String>,
    /// When true and provider is Gemini, automatically select model with fallbacks
    auto_model: bool,
    /// Model priority when auto_model is enabled
    model_priority: LlmModelPriority,
}

impl LlmClient {
    pub fn new(
        api_key: String,
        model: String,
        provider: LlmProvider,
        endpoint: Option<String>,
        auto_model: bool,
        model_priority: LlmModelPriority,
    ) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key,
            model,
            provider,
            endpoint,
            auto_model,
            model_priority,
        }
    }

    /// Get the fallback chain of models based on priority
    fn get_model_fallback_chain(&self) -> Vec<&str> {
        if !self.auto_model || !matches!(self.provider, LlmProvider::Gemini) {
            // No fallback - just use the configured model
            return vec![];
        }

        match self.model_priority {
            LlmModelPriority::Speed => GEMINI_MODELS_SPEED.to_vec(),
            LlmModelPriority::Accuracy => GEMINI_MODELS_ACCURACY.to_vec(),
        }
    }

    fn api_url_for_model(&self, model: &str) -> String {
        match &self.provider {
            LlmProvider::Gemini => {
                format!(
                    "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
                    model, self.api_key
                )
            }
            LlmProvider::OpenAI => "https://api.openai.com/v1/chat/completions".to_string(),
            LlmProvider::Groq => "https://api.groq.com/openai/v1/chat/completions".to_string(),
            LlmProvider::Local | LlmProvider::Custom => self
                .endpoint
                .clone()
                .unwrap_or_else(|| "http://localhost:1234/v1/chat/completions".to_string()),
        }
    }

    fn api_url(&self) -> String {
        self.api_url_for_model(&self.model)
    }

    fn is_openai_compatible(&self) -> bool {
        !matches!(self.provider, LlmProvider::Gemini)
    }

    /// Generate structured JSON response with usage tracking
    pub async fn generate_with_usage<T: serde::de::DeserializeOwned>(
        &self,
        prompt: &str,
        schema: Option<serde_json::Value>,
    ) -> Result<GenerationResult<T>, String> {
        self.generate_structured_with_usage(prompt, schema).await
    }
}
