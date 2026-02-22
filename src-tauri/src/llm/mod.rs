//! Unified LLM client supporting multiple providers (Gemini, OpenAI, Groq, Local)

mod api_types;
mod features;
mod providers;
mod types;
mod utils;

pub use types::*;
pub use providers::GenerationResult;

use crate::config::{LlmModelPriority, LlmProvider};

/// Model fallback chains for Gemini provider
/// Note: As of Dec 2025, free tier is severely limited to 20 RPD for both 2.5 Flash and 2.5 Flash-Lite
const GEMINI_MODELS_SPEED: &[&str] = &[
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
];

const GEMINI_MODELS_ACCURACY: &[&str] = &[
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
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
            LlmProvider::OpenAI => {
                "https://api.openai.com/v1/chat/completions".to_string()
            }
            LlmProvider::Groq => {
                "https://api.groq.com/openai/v1/chat/completions".to_string()
            }
            LlmProvider::Local | LlmProvider::Custom => {
                self.endpoint
                    .clone()
                    .unwrap_or_else(|| "http://localhost:1234/v1/chat/completions".to_string())
            }
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
