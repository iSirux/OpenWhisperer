//! SDK provider selection, authentication methods, and (legacy) terminal-mode enums.

use serde::{Deserialize, Serialize};

/// SDK provider for the main coding agent (Claude or OpenAI Codex)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum SdkProvider {
    #[default]
    Claude,
    OpenAI,
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
