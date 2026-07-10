//! SDK provider selection, authentication methods, and (legacy) terminal-mode enums.

use serde::{Deserialize, Serialize};

/// SDK provider for the main coding agent (Claude or OpenAI Codex)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum SdkProvider {
    #[default]
    Claude,
    OpenAI,
}

/// Which SDK providers are surfaced in the UI (chosen during onboarding).
/// When only one is enabled, provider pickers are hidden entirely and the
/// disabled provider's settings tab disappears.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EnabledProviders {
    pub claude: bool,
    pub openai: bool,
}

impl Default for EnabledProviders {
    fn default() -> Self {
        Self {
            claude: true,
            openai: true,
        }
    }
}

/// OpenAI authentication method
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum OpenAiAuthMethod {
    #[default]
    OAuth,
    ApiKey,
}

/// Claude authentication method
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum ClaudeAuthMethod {
    /// Use existing Claude CLI OAuth session (~/.claude/.credentials.json)
    #[default]
    OAuth,
    /// Use API key stored in keyring (ANTHROPIC_API_KEY)
    ApiKey,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum ClaudeTerminalMode {
    Interactive,
    Prompt,
    #[default]
    Sdk,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum CodexMode {
    #[default]
    AppServer,
    Sdk,
}

/// LEGACY / INERT: retained only so old persisted configs round-trip. Session work
/// always uses SDK-style flows (`AppConfig::get_effective_terminal_mode` returns `Sdk`),
/// so no live behavior depends on this discriminant.
#[derive(Debug, Clone, PartialEq)]
pub enum TerminalMode {
    Interactive,
    Prompt,
    Sdk,
    CodexAppServer,
}
