//! Audio capture, voice-command, and open-mic configuration.

use serde::{Deserialize, Serialize};

/// Voice command configuration for triggering prompt send
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceCommandConfig {
    /// Whether voice commands are enabled
    #[serde(default)]
    pub enabled: bool,
    /// List of active voice commands that will trigger send
    #[serde(default = "default_voice_commands")]
    pub active_commands: Vec<String>,
    /// List of active voice commands that will trigger transcribe-to-input
    #[serde(default)]
    pub transcribe_commands: Vec<String>,
    /// List of active voice commands that will cancel/discard the recording
    #[serde(default)]
    pub cancel_commands: Vec<String>,
    /// List of voice commands that will trigger note-taking mode
    #[serde(default = "default_note_commands")]
    pub note_commands: Vec<String>,
    /// List of voice commands that will trigger running a sequence (e.g., "run sequence")
    #[serde(default = "default_sequence_commands")]
    pub sequence_commands: Vec<String>,
    /// List of voice commands that will approve a pending approval node
    #[serde(default = "default_approve_commands")]
    pub approve_commands: Vec<String>,
    /// List of voice commands that will reject a pending approval node
    #[serde(default = "default_reject_commands")]
    pub reject_commands: Vec<String>,
    /// List of voice commands that will prepare a session without starting it
    #[serde(default = "default_prepare_commands")]
    pub prepare_commands: Vec<String>,
    /// List of voice commands that will save the recording to the pile
    #[serde(default = "default_pile_commands")]
    pub pile_commands: Vec<String>,
}

fn default_voice_commands() -> Vec<String> {
    vec!["go go".to_string()]
}

fn default_note_commands() -> Vec<String> {
    vec!["take a note".to_string(), "new note".to_string()]
}

fn default_sequence_commands() -> Vec<String> {
    vec!["run sequence".to_string()]
}

fn default_approve_commands() -> Vec<String> {
    vec!["approve".to_string()]
}

fn default_reject_commands() -> Vec<String> {
    vec!["reject".to_string()]
}

fn default_prepare_commands() -> Vec<String> {
    vec!["go prepare".to_string(), "prep it".to_string()]
}

fn default_pile_commands() -> Vec<String> {
    vec!["pile it".to_string(), "to the pile".to_string()]
}

impl Default for VoiceCommandConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            active_commands: default_voice_commands(),
            transcribe_commands: Vec::new(),
            cancel_commands: Vec::new(),
            note_commands: default_note_commands(),
            sequence_commands: default_sequence_commands(),
            approve_commands: default_approve_commands(),
            reject_commands: default_reject_commands(),
            prepare_commands: default_prepare_commands(),
            pile_commands: default_pile_commands(),
        }
    }
}

/// Open mic configuration for passive voice listening
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenMicConfig {
    /// Whether open mic mode is enabled
    #[serde(default)]
    pub enabled: bool,
    /// List of active wake commands that will trigger recording
    #[serde(default = "default_wake_commands")]
    pub wake_commands: Vec<String>,
    /// Minimum volume threshold (0.0-1.0) to send audio to Vosk (saves resources when silent)
    #[serde(default = "default_volume_threshold")]
    pub volume_threshold: f32,
}

fn default_volume_threshold() -> f32 {
    0.01 // 1% - very low default to catch most speech
}

fn default_wake_commands() -> Vec<String> {
    vec!["hey claude".to_string()]
}

impl Default for OpenMicConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            wake_commands: default_wake_commands(),
            volume_threshold: default_volume_threshold(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum RecordAndSendAction {
    #[default]
    Send,
    Prepare,
    Pile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioConfig {
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default = "default_use_hotkey")]
    pub use_hotkey: bool,
    #[serde(default = "default_hold_space_to_record_inline")]
    pub hold_space_to_record_inline: bool,
    #[serde(default)]
    pub play_sound_on_completion: bool,
    #[serde(default = "default_play_sound_on_repo_select")]
    pub play_sound_on_repo_select: bool,
    /// Play sound when open mic wake command is detected and recording starts
    #[serde(default = "default_play_sound_on_open_mic_trigger")]
    pub play_sound_on_open_mic_trigger: bool,
    /// Play sound when a voice command (like "send it") is detected
    #[serde(default = "default_play_sound_on_voice_command")]
    pub play_sound_on_voice_command: bool,
    #[serde(default = "default_recording_linger_ms")]
    pub recording_linger_ms: u32,
    #[serde(default = "default_include_transcription_notice")]
    pub include_transcription_notice: bool,
    #[serde(default)]
    pub require_transcription_approval: bool,
    #[serde(default)]
    pub record_and_send_action: RecordAndSendAction,
    /// Capture a screenshot when a recording starts and attach it to the prompt
    #[serde(default)]
    pub capture_screenshot_on_record: bool,
    /// Voice command configuration for triggering prompt send
    #[serde(default)]
    pub voice_commands: VoiceCommandConfig,
    /// Open mic configuration for passive voice listening
    #[serde(default)]
    pub open_mic: OpenMicConfig,
}

fn default_use_hotkey() -> bool {
    true
}

fn default_recording_linger_ms() -> u32 {
    500
}

fn default_hold_space_to_record_inline() -> bool {
    true
}

fn default_play_sound_on_repo_select() -> bool {
    true
}

fn default_play_sound_on_open_mic_trigger() -> bool {
    true
}

fn default_play_sound_on_voice_command() -> bool {
    true
}

fn default_include_transcription_notice() -> bool {
    true
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            device_id: None,
            use_hotkey: default_use_hotkey(),
            hold_space_to_record_inline: default_hold_space_to_record_inline(),
            play_sound_on_completion: false,
            play_sound_on_repo_select: default_play_sound_on_repo_select(),
            play_sound_on_open_mic_trigger: default_play_sound_on_open_mic_trigger(),
            play_sound_on_voice_command: default_play_sound_on_voice_command(),
            recording_linger_ms: default_recording_linger_ms(),
            include_transcription_notice: default_include_transcription_notice(),
            require_transcription_approval: false,
            record_and_send_action: RecordAndSendAction::default(),
            capture_screenshot_on_record: false,
            voice_commands: VoiceCommandConfig::default(),
            open_mic: OpenMicConfig::default(),
        }
    }
}
