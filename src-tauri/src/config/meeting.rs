//! Meeting mode configuration (`AppConfig.meeting`). See
//! `docs/meeting-mode-spec.md` (Workstream C) and `src/meeting/`.

use serde::{Deserialize, Serialize};

use super::WhisperProvider;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MeetingConfig {
    /// Capture the microphone ("me").
    pub capture_mic: bool,
    /// Capture system audio ("them").
    pub capture_system: bool,
    /// `"process"` = only the configured apps' audio (process loopback, Windows);
    /// `"all"` = everything the default output device plays.
    pub system_target: String,
    /// Executable names whose process trees are captured when
    /// `system_target == "process"` (case-insensitive).
    pub system_process_names: Vec<String>,
    /// cpal input device name; `None` = system default input.
    pub mic_device: Option<String>,
    /// Energy VAD threshold (frame RMS, 0..1 full scale).
    pub vad_threshold: f32,
    /// Silence needed to close a speech segment.
    pub silence_hangover_ms: u32,
    /// Hard cap on one segment's length.
    pub max_segment_secs: u32,
    /// Transcription provider override; `None` = the dictation Whisper settings.
    pub transcription_provider: Option<WhisperProvider>,
    /// Transcription model override (`None`/empty = provider default / dictation model).
    pub transcription_model: Option<String>,
    /// API key for the override provider. `None`/empty = reuse the dictation
    /// key when the override provider equals the dictation provider; for
    /// OpenRouter, fall back to an OpenRouter LLM profile key.
    pub transcription_api_key: Option<String>,
    /// Endpoint for the override provider. `None`/empty = the provider preset
    /// (Local: the default local server; Custom has none and must set this).
    pub transcription_endpoint: Option<String>,
    /// Frontend triage cadence.
    pub triage_interval_minutes: u32,
    /// Auto-send confident actionable items to the pile.
    pub auto_pile: bool,
    pub auto_pile_min_confidence: f32,
    /// Default the start panel to auto-repo instead of the active repo.
    pub default_auto_repo: bool,
    /// Segment audio of finished meetings is deleted after this many days
    /// (0 = keep forever). Transcripts and items are always kept.
    pub retention_days: u32,
}

pub fn default_meeting_process_names() -> Vec<String> {
    ["Discord.exe", "Teams.exe", "ms-teams.exe"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

impl Default for MeetingConfig {
    fn default() -> Self {
        Self {
            capture_mic: true,
            capture_system: true,
            system_target: "process".to_string(),
            system_process_names: default_meeting_process_names(),
            mic_device: None,
            vad_threshold: 0.015,
            silence_hangover_ms: 1200,
            max_segment_secs: 90,
            transcription_provider: None,
            transcription_model: None,
            transcription_api_key: None,
            transcription_endpoint: None,
            triage_interval_minutes: 3,
            auto_pile: false,
            auto_pile_min_confidence: 0.85,
            default_auto_repo: false,
            retention_days: 30,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fields_take_defaults() {
        let cfg: MeetingConfig = serde_json::from_str(r#"{"capture_mic": false}"#).unwrap();
        assert!(!cfg.capture_mic);
        assert!(cfg.capture_system);
        assert_eq!(cfg.system_target, "process");
        assert_eq!(cfg.silence_hangover_ms, 1200);
        assert_eq!(cfg.system_process_names.len(), 3);
    }
}
