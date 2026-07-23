//! Unified LLM client supporting multiple providers (Gemini, OpenAI, Groq, Local)

mod api_types;
mod features;
mod providers;
#[cfg(test)]
mod prompt_tests;
mod types;
mod utils;

pub use providers::GenerationResult;
pub use types::*;

use crate::config::{AppConfig, LlmProfile, LlmProvider};
use serde::de::DeserializeOwned;
use tauri::AppHandle;
use tauri_plugin_keyring::KeyringExt;

// ---------------------------------------------------------------------------
// Keyring / API-key management (single source of truth; T5)
// ---------------------------------------------------------------------------

/// Service name for keyring storage. MUST NOT change when the app is renamed,
/// or existing users' stored credentials become unreadable.
pub(crate) const KEYRING_SERVICE: &str = "open-whisperer";
/// Account/user name for the stored LLM API key of the "default" profile.
/// Kept bare (no id suffix) so existing single-provider users need zero
/// migration; every other profile uses `llm-api-key:<id>`.
pub(crate) const KEYRING_LLM_KEY: &str = "llm-api-key";

/// The reserved id of the migrated legacy profile.
pub(crate) const DEFAULT_PROFILE_ID: &str = "default";

/// Keyring account name for a profile's API key. The "default" profile uses the
/// legacy bare account; all others are namespaced by id.
pub(crate) fn keyring_account(profile_id: &str) -> String {
    if profile_id == DEFAULT_PROFILE_ID {
        KEYRING_LLM_KEY.to_string()
    } else {
        format!("{}:{}", KEYRING_LLM_KEY, profile_id)
    }
}

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

/// Read the stored LLM API key for a profile from the keyring. The legacy
/// XOR-file migration only applies to the "default" profile (the only one that
/// could have a pre-keyring key on disk).
pub(crate) fn get_api_key(app: &AppHandle, profile_id: &str) -> Result<String, String> {
    if profile_id == DEFAULT_PROFILE_ID {
        let _ = migrate_legacy_key(app);
    }

    let account = keyring_account(profile_id);
    match app.keyring().get_password(KEYRING_SERVICE, &account) {
        Ok(Some(key)) => Ok(key),
        Ok(None) => Err("API key not set".to_string()),
        Err(e) => Err(format!("Failed to get API key from keyring: {}", e)),
    }
}

/// Build an [`LlmClient`] for a single profile. For the Local provider the API
/// key is optional (empty is allowed); for all other providers a missing key is
/// an error (the caller skips the profile).
pub(crate) fn client_for_profile(
    app: &AppHandle,
    profile: &LlmProfile,
) -> Result<LlmClient, String> {
    let api_key = if matches!(profile.provider, LlmProvider::Local) {
        get_api_key(app, &profile.id).unwrap_or_default()
    } else {
        get_api_key(app, &profile.id)?
    };

    Ok(LlmClient::new(
        api_key,
        profile.model.clone(),
        profile.provider.clone(),
        profile.endpoint.clone(),
        profile.auto_model,
    ))
}

/// Canonical LLM router factory: resolves the routing chain for `feature`'s role
/// into a list of usable [`LlmClient`]s (cross-provider fallback order).
///
/// Chain ids that don't match any profile are skipped; if the resolved chain is
/// empty, ALL profiles are used in config order. Profiles whose API key is
/// missing are skipped with a warning. Errors only if zero clients are usable.
pub(crate) fn router_from_config(
    app: &AppHandle,
    config: &AppConfig,
    feature: LlmFeature,
) -> Result<LlmRouter, String> {
    let llm = &config.llm;
    let chain = match feature.role() {
        LlmRole::Fast => &llm.fast_chain,
        LlmRole::Quality => &llm.quality_chain,
    };

    // Resolve the chain ids to profiles, skipping ids that don't match.
    let mut profiles: Vec<&LlmProfile> = chain
        .iter()
        .filter_map(|id| llm.profiles.iter().find(|p| &p.id == id))
        .collect();

    // Empty resolved chain → fall back to ALL profiles in config order.
    if profiles.is_empty() {
        profiles = llm.profiles.iter().collect();
    }

    let mut clients = Vec::new();
    for profile in profiles {
        match client_for_profile(app, profile) {
            Ok(client) => clients.push((profile.label.clone(), client)),
            Err(e) => log::warn!(
                "[llm] skipping profile '{}' ({}): {}",
                profile.label,
                profile.id,
                e
            ),
        }
    }

    if clients.is_empty() {
        return Err("No usable LLM profiles configured (missing API keys?)".to_string());
    }

    Ok(LlmRouter { clients })
}

/// Model fallback chain for the Gemini provider (single order, priority-agnostic).
/// Newest Flash-Lite models first (fastest/cheapest), then the Flash models,
/// then the 2.5 series kept as fallbacks.
const GEMINI_MODELS: &[&str] = &[
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
];

/// Unified LLM client that supports multiple providers (Gemini, OpenAI, Groq, Local)
pub struct LlmClient {
    client: reqwest::Client,
    api_key: String,
    model: String,
    provider: LlmProvider,
    endpoint: Option<String>,
    /// When true and provider is Gemini, automatically select model with fallbacks
    auto_model: bool,
}

impl LlmClient {
    pub fn new(
        api_key: String,
        model: String,
        provider: LlmProvider,
        endpoint: Option<String>,
        auto_model: bool,
    ) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key,
            model,
            provider,
            endpoint,
            auto_model,
        }
    }

    /// Get the fallback chain of models based on priority
    fn get_model_fallback_chain(&self) -> Vec<&str> {
        if !self.auto_model || !matches!(self.provider, LlmProvider::Gemini) {
            // No fallback - just use the configured model
            return vec![];
        }

        // Single fallback order regardless of the configured priority.
        GEMINI_MODELS.to_vec()
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
            LlmProvider::Xai => "https://api.x.ai/v1/chat/completions".to_string(),
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
}

/// A role-resolved chain of LLM clients (one per usable profile) tried in order
/// for cross-provider fallback. Intra-provider fallbacks (Gemini model chain,
/// Groq sibling models) stay inside each [`LlmClient`].
pub struct LlmRouter {
    /// (profile label for logging, client), in fallback order.
    clients: Vec<(String, LlmClient)>,
}

impl LlmRouter {
    /// Try each client's structured generation in order. On ANY error, log the
    /// profile and move to the next client (a different provider may succeed
    /// where auth/parse/rate-limit failed). Returns the last error if all fail.
    async fn run_chain<T: DeserializeOwned>(
        &self,
        prompt: &str,
        schema: Option<serde_json::Value>,
    ) -> Result<GenerationResult<T>, String> {
        let mut last_error = String::new();
        let mut failures = 0usize;
        for (label, client) in &self.clients {
            match client
                .generate_structured_with_usage(prompt, schema.clone())
                .await
            {
                Ok(result) => return Ok(result),
                Err(e) => {
                    log::warn!("[llm] profile '{}' failed, trying next: {}", label, e);
                    last_error = e;
                    failures += 1;
                }
            }
        }
        Err(format!(
            "All {} LLM profile(s) failed. Last error: {}",
            failures, last_error
        ))
    }

    /// Generate a structured JSON response with usage tracking, routed across the
    /// chain. Used directly by the sequences AI nodes.
    pub async fn generate_with_usage<T: DeserializeOwned>(
        &self,
        prompt: &str,
        schema: Option<serde_json::Value>,
    ) -> Result<GenerationResult<T>, String> {
        self.run_chain(prompt, schema).await
    }
}
