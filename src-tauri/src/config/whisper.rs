//! Whisper transcription provider configuration and Docker container settings.

use serde::{Deserialize, Serialize};

/// Provider type for Whisper-compatible APIs
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum WhisperProvider {
    #[default]
    Local,
    OpenAI,
    Groq,
    Custom,
    /// OpenRouter's `/api/v1/audio/transcriptions` (JSON + base64 audio), which
    /// routes to Whisper, gpt-4o-transcribe, Groq, Microsoft MAI-Transcribe, …
    OpenRouter,
}

impl WhisperProvider {
    /// Canonical transcription endpoint for the hosted API providers
    /// (`None` for Local/Custom, whose endpoint is user-defined).
    pub fn preset_endpoint(&self) -> Option<&'static str> {
        match self {
            WhisperProvider::OpenAI => Some("https://api.openai.com/v1/audio/transcriptions"),
            WhisperProvider::Groq => Some("https://api.groq.com/openai/v1/audio/transcriptions"),
            WhisperProvider::OpenRouter => Some("https://openrouter.ai/api/v1/audio/transcriptions"),
            WhisperProvider::Local | WhisperProvider::Custom => None,
        }
    }

    /// Default model for the provider preset (mirrors `WhisperTab.svelte`).
    pub fn default_model(&self) -> Option<&'static str> {
        match self {
            WhisperProvider::Local => Some("dropbox-dash/faster-whisper-large-v3-turbo"),
            WhisperProvider::OpenAI => Some("gpt-4o-mini-transcribe"),
            WhisperProvider::Groq => Some("whisper-large-v3-turbo"),
            WhisperProvider::OpenRouter => Some("microsoft/mai-transcribe-2"),
            WhisperProvider::Custom => None,
        }
    }

    /// Hosted API providers get retry-with-backoff on 429/5xx/network errors.
    /// Local is excluded (the command layer has its own Docker autostart +
    /// retry path); Custom counts as an API unless it points at localhost.
    pub fn is_remote_api(&self, endpoint: &str) -> bool {
        match self {
            WhisperProvider::Local => false,
            WhisperProvider::Custom => !crate::docker::is_local_endpoint(endpoint),
            _ => true,
        }
    }
}

/// Docker compute type for local Whisper server
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum DockerComputeType {
    #[default]
    CPU,
    GPU,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerConfig {
    /// Whether to use GPU (CUDA) or CPU
    #[serde(default)]
    pub compute_type: DockerComputeType,
    /// Start container automatically when Docker daemon starts
    #[serde(default)]
    pub auto_restart: bool,
    /// Custom container name
    #[serde(default = "default_container_name")]
    pub container_name: String,
}

pub(crate) fn default_container_name() -> String {
    "whisper".to_string()
}

impl Default for DockerConfig {
    fn default() -> Self {
        Self {
            compute_type: DockerComputeType::default(),
            auto_restart: false,
            container_name: default_container_name(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperConfig {
    #[serde(default)]
    pub provider: WhisperProvider,
    #[serde(default = "default_whisper_endpoint")]
    pub endpoint: String,
    #[serde(default = "default_whisper_model")]
    pub model: String,
    #[serde(default = "default_whisper_language")]
    pub language: String,
    /// Optional API key for authenticated endpoints (OpenAI, Groq, etc.)
    #[serde(default)]
    pub api_key: Option<String>,
    /// Docker configuration for local Whisper server
    #[serde(default)]
    pub docker: DockerConfig,
}

/// The local faster-whisper-server endpoint (the app default and the Local
/// preset in `WhisperTab.svelte`).
pub const DEFAULT_LOCAL_WHISPER_ENDPOINT: &str = "http://localhost:8000/v1/audio/transcriptions";

fn default_whisper_endpoint() -> String {
    DEFAULT_LOCAL_WHISPER_ENDPOINT.to_string()
}

fn default_whisper_model() -> String {
    "dropbox-dash/faster-whisper-large-v3-turbo".to_string()
}

fn default_whisper_language() -> String {
    "en".to_string()
}

impl Default for WhisperConfig {
    fn default() -> Self {
        Self {
            provider: WhisperProvider::default(),
            endpoint: default_whisper_endpoint(),
            model: default_whisper_model(),
            language: default_whisper_language(),
            api_key: None,
            docker: DockerConfig::default(),
        }
    }
}
