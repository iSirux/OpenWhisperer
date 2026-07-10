//! Real-time transcription provider configuration (Vosk / VoiceStreamAI / sherpa-onnx / Speaches / Moonshine).

use serde::{Deserialize, Serialize};

use super::whisper::{DockerComputeType, DockerConfig};

/// Provider type for real-time transcription (live during recording)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum RealtimeProvider {
    Vosk,
    VoiceStreamAI,
    SherpaOnnx,
    Speaches,
    /// Moonshine v2 streaming via the bundled Vosk-protocol shim server
    /// (docker/moonshine); wire-compatible with `VoskSession`. The default
    /// and recommended provider: Whisper-level accuracy while streaming.
    #[default]
    Moonshine,
}

/// Configuration for VoiceStreamAI real-time transcription
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceStreamAIConfig {
    /// WebSocket endpoint for VoiceStreamAI server
    #[serde(default = "default_vsai_endpoint")]
    pub endpoint: String,
    /// Audio sample rate (default: 16000)
    #[serde(default = "default_vsai_sample_rate")]
    pub sample_rate: u32,
    /// Chunk length in seconds for processing
    #[serde(default = "default_vsai_chunk_length")]
    pub chunk_length_seconds: f32,
    /// Chunk offset in seconds (silence duration before processing)
    #[serde(default = "default_vsai_chunk_offset")]
    pub chunk_offset_seconds: f32,
    /// Language code for transcription (e.g., "en", "multilanguage")
    #[serde(default = "default_vsai_language")]
    pub language: String,
    /// Docker configuration for VoiceStreamAI server
    #[serde(default = "default_vsai_docker")]
    pub docker: DockerConfig,
}

fn default_vsai_endpoint() -> String {
    "ws://localhost:8765".to_string()
}

fn default_vsai_sample_rate() -> u32 {
    16000
}

fn default_vsai_chunk_length() -> f32 {
    3.0
}

fn default_vsai_chunk_offset() -> f32 {
    0.1
}

fn default_vsai_language() -> String {
    "en".to_string()
}

fn default_vsai_container_name() -> String {
    "open-whisperer-voicestreamai".to_string()
}

fn default_vsai_docker() -> DockerConfig {
    DockerConfig {
        compute_type: DockerComputeType::CPU,
        auto_restart: false,
        container_name: default_vsai_container_name(),
    }
}

impl Default for VoiceStreamAIConfig {
    fn default() -> Self {
        Self {
            endpoint: default_vsai_endpoint(),
            sample_rate: default_vsai_sample_rate(),
            chunk_length_seconds: default_vsai_chunk_length(),
            chunk_offset_seconds: default_vsai_chunk_offset(),
            language: default_vsai_language(),
            docker: default_vsai_docker(),
        }
    }
}

/// Configuration for sherpa-onnx real-time transcription
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SherpaOnnxConfig {
    /// WebSocket endpoint for sherpa-onnx online server
    #[serde(default = "default_sherpa_endpoint")]
    pub endpoint: String,
    /// Audio sample rate (default: 16000)
    #[serde(default = "default_sherpa_sample_rate")]
    pub sample_rate: u32,
    /// Docker configuration for sherpa-onnx server
    #[serde(default = "default_sherpa_docker")]
    pub docker: DockerConfig,
}

fn default_sherpa_endpoint() -> String {
    "ws://localhost:6006".to_string()
}

fn default_sherpa_sample_rate() -> u32 {
    16000
}

fn default_sherpa_container_name() -> String {
    "open-whisperer-sherpa-onnx".to_string()
}

fn default_sherpa_docker() -> DockerConfig {
    DockerConfig {
        compute_type: DockerComputeType::CPU,
        auto_restart: false,
        container_name: default_sherpa_container_name(),
    }
}

impl Default for SherpaOnnxConfig {
    fn default() -> Self {
        Self {
            endpoint: default_sherpa_endpoint(),
            sample_rate: default_sherpa_sample_rate(),
            docker: default_sherpa_docker(),
        }
    }
}

/// Configuration for Moonshine v2 real-time transcription. The server
/// (docker/moonshine) speaks the Vosk WebSocket protocol, so sessions reuse
/// `VoskSession` — only the endpoint differs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoonshineConfig {
    /// WebSocket endpoint for the Moonshine shim server
    #[serde(default = "default_moonshine_endpoint")]
    pub endpoint: String,
    /// Audio sample rate (default: 16000)
    #[serde(default = "default_moonshine_sample_rate")]
    pub sample_rate: u32,
    /// Docker configuration for the Moonshine server
    #[serde(default = "default_moonshine_docker")]
    pub docker: DockerConfig,
}

fn default_moonshine_endpoint() -> String {
    "ws://localhost:2702".to_string()
}

fn default_moonshine_sample_rate() -> u32 {
    16000
}

fn default_moonshine_container_name() -> String {
    "open-whisperer-moonshine".to_string()
}

fn default_moonshine_docker() -> DockerConfig {
    DockerConfig {
        compute_type: DockerComputeType::CPU,
        auto_restart: false,
        container_name: default_moonshine_container_name(),
    }
}

impl Default for MoonshineConfig {
    fn default() -> Self {
        Self {
            endpoint: default_moonshine_endpoint(),
            sample_rate: default_moonshine_sample_rate(),
            docker: default_moonshine_docker(),
        }
    }
}

/// Configuration for Speaches real-time transcription
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeachesConfig {
    /// WebSocket endpoint for Speaches realtime API
    #[serde(default = "default_speaches_endpoint")]
    pub endpoint: String,
    /// Audio sample rate (default: 16000)
    #[serde(default = "default_speaches_sample_rate")]
    pub sample_rate: u32,
    /// Transcription model name
    #[serde(default = "default_speaches_model")]
    pub model: String,
    /// Optional API key for protected Speaches deployments
    #[serde(default)]
    pub api_key: Option<String>,
    /// Docker configuration for Speaches server
    #[serde(default = "default_speaches_docker")]
    pub docker: DockerConfig,
}

fn default_speaches_endpoint() -> String {
    "ws://localhost:2701/v1/realtime".to_string()
}

fn default_speaches_sample_rate() -> u32 {
    16000
}

fn default_speaches_model() -> String {
    "Systran/faster-distil-whisper-small.en".to_string()
}

fn default_speaches_container_name() -> String {
    "open-whisperer-speaches".to_string()
}

fn default_speaches_docker() -> DockerConfig {
    DockerConfig {
        compute_type: DockerComputeType::CPU,
        auto_restart: false,
        container_name: default_speaches_container_name(),
    }
}

impl Default for SpeachesConfig {
    fn default() -> Self {
        Self {
            endpoint: default_speaches_endpoint(),
            sample_rate: default_speaches_sample_rate(),
            model: default_speaches_model(),
            api_key: None,
            docker: default_speaches_docker(),
        }
    }
}

/// Configuration for real-time transcription providers
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoskConfig {
    /// Whether real-time transcription is enabled. Default on to match the
    /// realtime-first default; a failed connect is graceful (recording
    /// proceeds, Whisper transcribes).
    #[serde(default = "default_realtime_enabled")]
    pub enabled: bool,
    /// Which real-time transcription provider to use
    #[serde(default)]
    pub provider: RealtimeProvider,
    /// WebSocket endpoint for Vosk server
    #[serde(default = "default_vosk_endpoint")]
    pub endpoint: String,
    /// Audio sample rate (default: 16000)
    #[serde(default = "default_vosk_sample_rate")]
    pub sample_rate: u32,
    /// Docker configuration for Vosk server
    #[serde(default = "default_vosk_docker")]
    pub docker: DockerConfig,
    /// Whether to show real-time transcript in overlay
    #[serde(default = "default_show_realtime_transcript")]
    pub show_realtime_transcript: bool,
    /// Whether to accumulate transcript text across pauses (vs reset on each pause)
    #[serde(default)]
    pub accumulate_transcript: bool,
    /// Which engine(s) produce the final transcript (see [`TranscriptionMode`])
    #[serde(default)]
    pub transcription_mode: TranscriptionMode,
    /// VoiceStreamAI-specific configuration
    #[serde(default)]
    pub voice_stream_ai: VoiceStreamAIConfig,
    /// sherpa-onnx-specific configuration
    #[serde(default)]
    pub sherpa_onnx: SherpaOnnxConfig,
    /// Speaches-specific configuration
    #[serde(default)]
    pub speaches: SpeachesConfig,
    /// Moonshine-specific configuration
    #[serde(default)]
    pub moonshine: MoonshineConfig,
}

fn default_vosk_endpoint() -> String {
    "ws://localhost:2700".to_string()
}

fn default_vosk_sample_rate() -> u32 {
    16000
}

fn default_vosk_container_name() -> String {
    "open-whisperer-vosk".to_string()
}

fn default_vosk_docker() -> DockerConfig {
    DockerConfig {
        compute_type: DockerComputeType::CPU,
        auto_restart: false,
        container_name: default_vosk_container_name(),
    }
}

fn default_show_realtime_transcript() -> bool {
    true
}

fn default_realtime_enabled() -> bool {
    true
}

/// Which engine(s) produce the final transcript.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum TranscriptionMode {
    /// Batch Whisper transcribes the full recording after stop; the realtime
    /// engine (if enabled) only powers the live preview and voice commands
    Whisper,
    /// The realtime engine's harvested transcript IS the transcript; Whisper
    /// is never called. An empty harvest fails the recording (pile salvage)
    Realtime,
    /// Run both engines: the realtime engine powers the live preview and feeds
    /// the dual-source LLM cleanup, while batch Whisper produces the primary
    /// transcript. Falls back to the realtime harvest if Whisper is unreachable.
    #[default]
    Both,
}

impl Default for VoskConfig {
    fn default() -> Self {
        Self {
            enabled: default_realtime_enabled(),
            provider: RealtimeProvider::default(),
            endpoint: default_vosk_endpoint(),
            sample_rate: default_vosk_sample_rate(),
            docker: default_vosk_docker(),
            show_realtime_transcript: default_show_realtime_transcript(),
            accumulate_transcript: false,
            transcription_mode: TranscriptionMode::default(),
            voice_stream_ai: VoiceStreamAIConfig::default(),
            sherpa_onnx: SherpaOnnxConfig::default(),
            speaches: SpeachesConfig::default(),
            moonshine: MoonshineConfig::default(),
        }
    }
}
