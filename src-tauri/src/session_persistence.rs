use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::config::AppConfig;

/// Represents a persisted image content block
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSdkImageContent {
    pub media_type: String,
    pub base64_data: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Represents a persisted SDK message
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSdkMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub content: Option<String>,
    /// Images attached to user prompts
    pub images: Option<Vec<PersistedSdkImageContent>>,
    pub tool: Option<String>,
    pub input: Option<serde_json::Value>,
    pub output: Option<String>,
    /// Subagent ID (for subagent-start/subagent-stop messages)
    pub agent_id: Option<String>,
    /// Subagent type
    pub agent_type: Option<String>,
    /// Subagent transcript path
    pub transcript_path: Option<String>,
    pub timestamp: u64,
}

/// Represents persisted usage statistics for an SDK session
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSdkSessionUsage {
    #[serde(default)]
    pub total_input_tokens: u64,
    #[serde(default)]
    pub total_output_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
    #[serde(default)]
    pub total_cost: f64,
}

/// Represents AI-generated metadata for a session
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSessionAiMetadata {
    pub name: Option<String>,
    pub summary: Option<String>,
    pub category: Option<String>,
    #[serde(default)]
    pub needs_interaction: bool,
}

/// Represents pending transcription info
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedPendingTranscriptionInfo {
    pub status: String,
    pub transcript: Option<String>,
    pub vosk_transcript: Option<String>,
    pub cleaned_transcript: Option<String>,
    #[serde(default)]
    pub was_cleaned_up: bool,
    pub cleanup_corrections: Option<Vec<String>>,
    #[serde(default)]
    pub used_dual_source: bool,
    pub model_recommendation: Option<serde_json::Value>,
    pub repo_recommendation: Option<serde_json::Value>,
    pub recording_started_at: Option<u64>,
    pub recording_duration_ms: Option<u64>,
    pub audio_visualization_history: Option<Vec<Vec<f64>>>,
    pub transcription_error: Option<String>,
}

/// Represents pending repo selection info
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedPendingRepoSelection {
    pub prompt: String,
    pub recommendations: Option<Vec<serde_json::Value>>,
}

/// Represents a persisted SDK session
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSdkSession {
    pub id: String,
    pub cwd: String,
    pub model: String,
    /// Whether 'auto' model was requested (before resolution)
    #[serde(default)]
    pub auto_model_requested: bool,
    /// Thinking level: null = off, "on" = enabled
    #[serde(default)]
    pub thinking_level: Option<String>,
    pub messages: Vec<PersistedSdkMessage>,
    pub status: String,
    pub created_at: u64,
    pub started_at: Option<u64>,
    /// Accumulated work duration in milliseconds
    #[serde(default)]
    pub accumulated_duration_ms: u64,
    /// Session usage statistics
    pub usage: Option<PersistedSdkSessionUsage>,
    /// Whether the session has unread messages
    #[serde(default)]
    pub unread: bool,
    /// AI-generated session metadata
    pub ai_metadata: Option<PersistedSessionAiMetadata>,
    /// Pending transcription info (for sessions in pending_transcription state)
    pub pending_transcription: Option<PersistedPendingTranscriptionInfo>,
    /// Pending repo selection info (for sessions in pending_repo state)
    pub pending_repo_selection: Option<PersistedPendingRepoSelection>,
    /// Pending prompt to send (for sessions in pending_approval state)
    pub pending_prompt: Option<String>,
    /// Pending approval prompt text
    pub pending_approval_prompt: Option<String>,
}

/// Represents a persisted terminal session (PTY)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedTerminalSession {
    pub id: String,
    pub repo_path: String,
    pub prompt: String,
    pub status: String,
    pub created_at: u64,
    /// Terminal output buffer - stored for historical viewing
    pub output_buffer: Option<String>,
}

/// Container for all persisted sessions
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PersistedSessions {
    pub sdk_sessions: Vec<PersistedSdkSession>,
    pub terminal_sessions: Vec<PersistedTerminalSession>,
    pub active_sdk_session_id: Option<String>,
    pub active_terminal_session_id: Option<String>,
    /// Timestamp when sessions were last saved
    pub saved_at: u64,
}

impl PersistedSessions {
    fn sessions_path() -> PathBuf {
        // Use separate sessions file for debug builds to avoid conflicts
        #[cfg(debug_assertions)]
        let filename = "sessions.dev.json";
        #[cfg(not(debug_assertions))]
        let filename = "sessions.json";

        AppConfig::config_dir().join(filename)
    }

    /// Load persisted sessions from disk
    pub fn load() -> Self {
        let path = Self::sessions_path();
        if path.exists() {
            match fs::read_to_string(&path) {
                Ok(content) => match serde_json::from_str(&content) {
                    Ok(sessions) => return sessions,
                    Err(e) => eprintln!("Failed to parse sessions: {}", e),
                },
                Err(e) => eprintln!("Failed to read sessions: {}", e),
            }
        }
        Self::default()
    }

    /// Save sessions to disk
    pub fn save(&self) -> Result<(), String> {
        let dir = AppConfig::config_dir();
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;

        let path = Self::sessions_path();
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize sessions: {}", e))?;

        fs::write(&path, &content).map_err(|e| format!("Failed to write sessions: {}", e))?;
        Ok(())
    }

    /// Trim sessions to max count, keeping the most recent ones
    pub fn trim_to_max(&mut self, max_sessions: usize) {
        // Sort SDK sessions by created_at descending and keep only max_sessions
        self.sdk_sessions
            .sort_by(|a, b| b.created_at.cmp(&a.created_at));
        self.sdk_sessions.truncate(max_sessions);

        // Sort terminal sessions by created_at descending and keep only max_sessions
        self.terminal_sessions
            .sort_by(|a, b| b.created_at.cmp(&a.created_at));
        self.terminal_sessions.truncate(max_sessions);
    }

    /// Clear all persisted sessions
    #[allow(dead_code)]
    pub fn clear(&mut self) {
        self.sdk_sessions.clear();
        self.terminal_sessions.clear();
        self.active_sdk_session_id = None;
        self.active_terminal_session_id = None;
    }
}
