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

fn default_whisper_endpoint() -> String {
    "http://localhost:8000/v1/audio/transcriptions".to_string()
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
