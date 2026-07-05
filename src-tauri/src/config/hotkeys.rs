//! Global hotkey bindings and per-hotkey enabled toggles.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeyConfig {
    #[serde(default = "default_toggle_recording")]
    pub toggle_recording: String,
    #[serde(default = "default_transcribe_to_input")]
    pub transcribe_to_input: String,
    #[serde(default = "default_cycle_repo", alias = "switch_repo")]
    pub cycle_repo: String,
    #[serde(default = "default_cycle_model", alias = "toggle_model")]
    pub cycle_model: String,
    /// In-app hotkey to create a new session while the app is focused
    #[serde(default = "default_new_session")]
    pub new_session: String,
    /// Hotkey to start recording in note-taking mode
    #[serde(default = "default_note_mode")]
    pub note_mode: String,
    /// Hotkey to copy selected text and immediately send as a new prompt
    #[serde(default = "default_send_selection")]
    pub send_selection: String,
    /// Hotkey to copy selected text and create a prepared session for review
    #[serde(default = "default_prepare_selection")]
    pub prepare_selection: String,
    /// Hotkey to stop the current recording and save it to the pile (while recording)
    #[serde(default = "default_pile_recording")]
    pub pile_recording: String,
}

fn default_toggle_recording() -> String {
    "CommandOrControl+Shift+Space".to_string()
}

fn default_transcribe_to_input() -> String {
    "CommandOrControl+Shift+T".to_string()
}

fn default_cycle_repo() -> String {
    "CommandOrControl+Shift+R".to_string()
}

fn default_cycle_model() -> String {
    "CommandOrControl+Shift+M".to_string()
}

fn default_new_session() -> String {
    "CommandOrControl+N".to_string()
}

fn default_note_mode() -> String {
    "CommandOrControl+Shift+N".to_string()
}

fn default_send_selection() -> String {
    "CommandOrControl+Shift+E".to_string()
}

fn default_prepare_selection() -> String {
    "CommandOrControl+Shift+J".to_string()
}

fn default_pile_recording() -> String {
    "CommandOrControl+Shift+P".to_string()
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        // Single source of truth: delegate every field to its `default_*` fn so the
        // serde-default and Default::default paths can never drift.
        Self {
            toggle_recording: default_toggle_recording(),
            transcribe_to_input: default_transcribe_to_input(),
            cycle_repo: default_cycle_repo(),
            cycle_model: default_cycle_model(),
            new_session: default_new_session(),
            note_mode: default_note_mode(),
            send_selection: default_send_selection(),
            prepare_selection: default_prepare_selection(),
            pile_recording: default_pile_recording(),
        }
    }
}

fn default_hotkey_enabled() -> bool {
    true
}

/// Per-hotkey enabled/disabled state. Allows users to temporarily deactivate
/// a hotkey without clearing its key binding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeyEnabledConfig {
    #[serde(default = "default_hotkey_enabled")]
    pub toggle_recording: bool,
    #[serde(default = "default_hotkey_enabled")]
    pub transcribe_to_input: bool,
    #[serde(default = "default_hotkey_enabled")]
    pub cycle_repo: bool,
    #[serde(default = "default_hotkey_enabled")]
    pub cycle_model: bool,
    #[serde(default = "default_hotkey_enabled")]
    pub new_session: bool,
    #[serde(default)]
    pub note_mode: bool,
    #[serde(default = "default_hotkey_enabled")]
    pub send_selection: bool,
    #[serde(default = "default_hotkey_enabled")]
    pub prepare_selection: bool,
    #[serde(default = "default_hotkey_enabled")]
    pub pile_recording: bool,
}

impl Default for HotkeyEnabledConfig {
    fn default() -> Self {
        Self {
            toggle_recording: default_hotkey_enabled(),
            transcribe_to_input: default_hotkey_enabled(),
            cycle_repo: default_hotkey_enabled(),
            cycle_model: default_hotkey_enabled(),
            new_session: default_hotkey_enabled(),
            note_mode: false,
            send_selection: default_hotkey_enabled(),
            prepare_selection: default_hotkey_enabled(),
            pile_recording: default_hotkey_enabled(),
        }
    }
}
