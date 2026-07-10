//! Application configuration: the `AppConfig` aggregate, its schema submodules,
//! load/save with atomic persistence, and versioned migrations.
//!
//! The schema types are split across submodules for maintainability but every
//! public type is re-exported here, so external code can keep using
//! `crate::config::TypeName` unchanged.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub mod audio;
pub mod hotkeys;
pub mod llm;
pub mod mcp;
pub mod migration;
pub mod provider;
pub mod realtime;
pub mod repo;
pub mod sequences;
pub mod ui;
pub mod whisper;

// Re-export all schema types so `crate::config::X` paths keep working.
pub use audio::*;
pub use hotkeys::*;
pub use llm::*;
pub use mcp::*;
pub use provider::*;
pub use realtime::*;
pub use repo::*;
pub use sequences::*;
pub use ui::*;
pub use whisper::*;

// UsageStats and its telemetry types now live in a dedicated top-level module,
// re-exported here for path compatibility (`crate::config::UsageStats`, etc.).
// The sub-stats types are re-exported for external path compat even though the
// crate currently only references them via the `UsageStats` aggregate.
#[allow(unused_imports)]
pub use crate::usage_stats::{
    DailyStats, LlmTokenStats, ModelUsageStats, RepoUsageStats, SessionStats, TokenStats,
    UsageStats,
};

use migration::CURRENT_CONFIG_VERSION;

/// Shared default helper used by many config structs.
pub(crate) fn default_true() -> bool {
    true
}

/// @deprecated Legacy GitConfig kept only for deserialization of old configs.
/// New worktree settings are per-repo on `RepoConfig`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GitConfig {
    #[serde(default)]
    pub create_branch: bool,
    #[serde(default)]
    pub auto_merge: bool,
    #[serde(default)]
    pub create_pr: bool,
    #[serde(default)]
    pub use_worktrees: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    /// Schema version for linear migrations. Missing (legacy files) deserializes
    /// to 0, which triggers the migration ladder at load time.
    #[serde(default)]
    pub config_version: u32,
    #[serde(default)]
    pub whisper: WhisperConfig,
    #[serde(default)]
    pub vosk: VoskConfig,
    /// @deprecated Legacy git settings; superseded by per-repo worktree config.
    /// Kept (as a default field) only so old configs round-trip.
    #[serde(default)]
    pub git: GitConfig,
    #[serde(default)]
    pub hotkeys: HotkeyConfig,
    /// Per-hotkey enabled/disabled toggles
    #[serde(default)]
    pub hotkeys_enabled: HotkeyEnabledConfig,
    #[serde(default)]
    pub overlay: OverlayConfig,
    #[serde(default)]
    pub audio: AudioConfig,
    #[serde(default)]
    pub repos: Vec<RepoConfig>,
    #[serde(default)]
    pub active_repo_index: usize,
    /// When true, repo is auto-selected based on prompt content (if Gemini auto_select_repo is enabled)
    #[serde(default)]
    pub auto_repo_mode: bool,
    #[serde(default = "default_model")]
    pub default_model: String,
    #[serde(default = "default_effort_level", alias = "default_thinking_level")]
    pub default_effort_level: EffortLevel,
    #[serde(default = "default_enabled_models")]
    pub enabled_models: Vec<String>,
    /// Terminal mode used when sdk_provider is Claude
    #[serde(default)]
    pub terminal_mode: ClaudeTerminalMode,
    /// OpenAI Codex mode used when sdk_provider is OpenAI
    #[serde(default, alias = "openai_terminal_mode")]
    pub codex_mode: CodexMode,
    /// SDK provider for the main coding agent (Claude or OpenAI Codex)
    #[serde(default)]
    pub sdk_provider: SdkProvider,
    /// Default OpenAI model for Codex SDK sessions
    #[serde(default = "default_openai_model")]
    pub openai_model: String,
    /// Which OpenAI models are shown in the selector
    #[serde(default = "default_enabled_openai_models")]
    pub enabled_openai_models: Vec<String>,
    /// OpenAI authentication method (OAuth via Codex CLI or API key)
    #[serde(default)]
    pub openai_auth_method: OpenAiAuthMethod,
    /// Claude authentication method (OAuth via Claude CLI or API key)
    #[serde(default)]
    pub claude_auth_method: ClaudeAuthMethod,
    #[serde(default)]
    pub skip_permissions: bool,
    /// Claude-only: default auto-compaction toggle for new sessions.
    /// When false, sidecar sets DISABLE_AUTO_COMPACT=1 (PCT_OVERRIDE cannot disable — it's clamped to ~83%).
    /// When true, no override is set; Claude's built-in default (~83.5%, 33K-token buffer) applies —
    /// that IS the optimum, since PCT_OVERRIDE is silently clamped to this default.
    #[serde(default = "default_autocompact_enabled")]
    pub default_autocompact_enabled: bool,
    #[serde(default)]
    pub theme: Theme,
    #[serde(default)]
    pub system: SystemConfig,
    #[serde(default)]
    pub show_branch_in_sessions: bool,
    #[serde(default)]
    pub session_persistence: SessionPersistenceConfig,
    #[serde(default)]
    pub session_sort_order: SessionSortOrder,
    #[serde(default = "default_mark_sessions_unread")]
    pub mark_sessions_unread: bool,
    #[serde(default = "default_show_latest_message_preview")]
    pub show_latest_message_preview: bool,
    #[serde(default = "default_show_session_summary")]
    pub show_session_summary: bool,
    #[serde(default = "default_sidebar_width")]
    pub sidebar_width: u32,
    #[serde(default = "default_session_prompt_rows")]
    pub session_prompt_rows: usize,
    #[serde(default = "default_session_response_rows")]
    pub session_response_rows: usize,
    #[serde(default)]
    pub sessions_view: SessionsViewConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_layout: Option<PaneLayoutConfig>,
    #[serde(default)]
    pub tool_display_mode: ToolDisplayMode,
    #[serde(default, alias = "gemini")]
    pub llm: LlmConfig,
    /// MCP server configuration
    #[serde(default)]
    pub mcp: McpConfig,
    /// Sequence automation configuration
    #[serde(default)]
    pub sequences: SequenceConfig,
    /// Smart queue configuration (defer launches/prompts when rate-limited)
    #[serde(default)]
    pub queue: QueueConfig,
    /// Inject a system message notifying agents that other agents may be working in parallel
    #[serde(default = "default_notify_parallel_agents")]
    pub notify_parallel_agents: bool,
    /// User-defined quick action prompts shown in SDK sessions
    #[serde(default = "default_quick_actions")]
    pub quick_actions: Vec<String>,
    /// User-defined toggleable prompt chips appended to prompts before sending
    #[serde(default = "default_prompt_chips")]
    pub prompt_chips: Vec<String>,
    /// Background bash commands matching one of these patterns (case-insensitive,
    /// word-boundary substring) are treated as long-running servers: still shown
    /// as running, but never counted as pending work and never delaying completion
    #[serde(default = "default_server_command_patterns")]
    pub server_command_patterns: Vec<String>,
}

fn default_model() -> String {
    "claude-opus-4-8".to_string()
}

fn default_notify_parallel_agents() -> bool {
    true
}

fn default_quick_actions() -> Vec<String> {
    vec![
        "Implement this".to_string(),
        "Fix the issues".to_string(),
        "Keep going".to_string(),
    ]
}

fn default_prompt_chips() -> Vec<String> {
    vec![
        "search web".to_string(),
        "scan codebase".to_string(),
        "brainstorm".to_string(),
    ]
}

fn default_server_command_patterns() -> Vec<String> {
    [
        "npm run dev",
        "npm start",
        "yarn dev",
        "yarn start",
        "pnpm dev",
        "pnpm start",
        "vite",
        "next dev",
        "nuxt dev",
        "astro dev",
        "ng serve",
        "expo start",
        "tauri dev",
        "tauri:dev",
        "cargo watch",
        "docker compose up",
        "docker-compose up",
        "http-server",
        "http.server",
        "flask run",
        "uvicorn",
        "rails server",
        "php -S",
        "nodemon",
        "webpack serve",
        "storybook",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn default_mark_sessions_unread() -> bool {
    true
}

fn default_show_latest_message_preview() -> bool {
    true
}

fn default_show_session_summary() -> bool {
    true
}

fn default_sidebar_width() -> u32 {
    256
}

fn default_session_prompt_rows() -> usize {
    2
}

fn default_session_response_rows() -> usize {
    2
}

fn default_effort_level() -> EffortLevel {
    EffortLevel::High
}

fn default_autocompact_enabled() -> bool {
    true
}

fn default_enabled_models() -> Vec<String> {
    vec![
        "claude-fable-5".to_string(),
        "claude-opus-4-8".to_string(),
        "claude-opus-4-7".to_string(),
        "claude-sonnet-5".to_string(),
        "claude-haiku-4-5-20251001".to_string(),
    ]
}

/// Default Codex/OpenAI model. `pub(crate)` because the migration layer restores
/// it when `enabled_openai_models` is emptied by alias remapping.
pub(crate) fn default_openai_model() -> String {
    "gpt-5.6-terra".to_string()
}

fn default_enabled_openai_models() -> Vec<String> {
    vec![
        "gpt-5.6-sol".to_string(),
        "gpt-5.6-terra".to_string(),
        "gpt-5.6-luna".to_string(),
        "gpt-5.4".to_string(),
        "gpt-5.4-mini".to_string(),
        "gpt-5.3-codex-spark".to_string(),
    ]
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            // A freshly-constructed default is already at the current schema version,
            // so it saves without triggering migrations. (Missing-on-disk deserializes
            // to 0 via #[serde(default)], which is what drives the migration ladder.)
            config_version: CURRENT_CONFIG_VERSION,
            whisper: WhisperConfig::default(),
            vosk: VoskConfig::default(),
            git: GitConfig::default(),
            hotkeys: HotkeyConfig::default(),
            hotkeys_enabled: HotkeyEnabledConfig::default(),
            overlay: OverlayConfig::default(),
            audio: AudioConfig::default(),
            repos: vec![],
            active_repo_index: 0,
            auto_repo_mode: false,
            default_model: default_model(),
            default_effort_level: default_effort_level(),
            enabled_models: default_enabled_models(),
            terminal_mode: ClaudeTerminalMode::Sdk,
            codex_mode: CodexMode::default(),
            sdk_provider: SdkProvider::default(),
            openai_model: default_openai_model(),
            enabled_openai_models: default_enabled_openai_models(),
            openai_auth_method: OpenAiAuthMethod::default(),
            claude_auth_method: ClaudeAuthMethod::default(),
            skip_permissions: false,
            default_autocompact_enabled: default_autocompact_enabled(),
            theme: Theme::default(),
            system: SystemConfig::default(),
            show_branch_in_sessions: false,
            session_persistence: SessionPersistenceConfig::default(),
            session_sort_order: SessionSortOrder::default(),
            mark_sessions_unread: default_mark_sessions_unread(),
            show_latest_message_preview: default_show_latest_message_preview(),
            show_session_summary: default_show_session_summary(),
            sidebar_width: default_sidebar_width(),
            session_prompt_rows: default_session_prompt_rows(),
            session_response_rows: default_session_response_rows(),
            sessions_view: SessionsViewConfig::default(),
            pane_layout: None,
            tool_display_mode: ToolDisplayMode::default(),
            llm: LlmConfig::default(),
            mcp: McpConfig::default(),
            sequences: SequenceConfig::default(),
            queue: QueueConfig::default(),
            notify_parallel_agents: default_notify_parallel_agents(),
            quick_actions: default_quick_actions(),
            prompt_chips: default_prompt_chips(),
            server_command_patterns: default_server_command_patterns(),
        }
    }
}

impl AppConfig {
    pub fn config_dir() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("open-whisperer")
    }

    /// Data directory name used before the app was renamed from "Claude Whisperer".
    const LEGACY_DATA_DIR: &'static str = "claude-whisperer";
    /// Marker written into the current data dir once migration has run, so it runs once.
    const MIGRATION_MARKER: &'static str = ".migrated-from-claude-whisperer";

    /// One-time migration: move the pre-rename data directory contents into the current
    /// one so existing users keep their config, sessions, pile, usage, and legacy key file
    /// after the app was renamed to "OpenWhisperer".
    ///
    /// Idempotent: a marker file in the current dir prevents it from re-running. Only moves
    /// entries whose destination does not already exist, so it never clobbers newer data.
    ///
    /// Must run at the very start of app startup, before anything creates the new dir.
    pub fn migrate_legacy_data_dir() {
        let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        let legacy = base.join(Self::LEGACY_DATA_DIR);
        let current = Self::config_dir();

        if !legacy.exists() {
            return;
        }
        // Already migrated once: don't touch anything again.
        if current.join(Self::MIGRATION_MARKER).exists() {
            return;
        }

        // Case 1: fresh target -> move the whole directory over.
        if !current.exists() {
            match std::fs::rename(&legacy, &current) {
                Ok(_) => {
                    log::info!("[migration] Renamed data dir {:?} -> {:?}", legacy, current);
                    Self::write_migration_marker(&current);
                    return;
                }
                Err(e) => {
                    // Fall through to per-entry merge (e.g. cross-device rename failure).
                    log::error!(
                        "[migration] Whole-dir rename {:?} -> {:?} failed ({}); merging per-entry",
                        legacy,
                        current,
                        e
                    );
                }
            }
        }

        // Case 2: target exists (or the rename above failed) -> move each missing entry.
        if let Err(e) = std::fs::create_dir_all(&current) {
            log::error!("[migration] Could not create {:?}: {}", current, e);
            return;
        }
        let entries = match std::fs::read_dir(&legacy) {
            Ok(e) => e,
            Err(e) => {
                log::error!("[migration] Could not read {:?}: {}", legacy, e);
                return;
            }
        };
        let mut moved = 0usize;
        for entry in entries.flatten() {
            let dest = current.join(entry.file_name());
            if dest.exists() {
                continue; // never clobber newer data already in the current dir
            }
            match std::fs::rename(entry.path(), &dest) {
                Ok(_) => moved += 1,
                Err(e) => log::error!(
                    "[migration] Failed to move {:?} -> {:?}: {}",
                    entry.path(),
                    dest,
                    e
                ),
            }
        }
        log::info!(
            "[migration] Merged {} legacy entrie(s) from {:?} into {:?}",
            moved,
            legacy,
            current
        );
        Self::write_migration_marker(&current);
    }

    fn write_migration_marker(current: &std::path::Path) {
        if let Err(e) = std::fs::write(current.join(Self::MIGRATION_MARKER), b"") {
            log::error!("[migration] Failed to write migration marker: {}", e);
        }
    }

    pub fn config_path() -> PathBuf {
        // Use separate config file for debug builds to avoid conflicts
        #[cfg(debug_assertions)]
        let filename = "config.dev.json";
        #[cfg(not(debug_assertions))]
        let filename = "config.json";

        Self::config_dir().join(filename)
    }

    /// Ensure all repos have unique IDs. Returns true if any were assigned.
    fn ensure_repo_ids(&mut self) -> bool {
        let mut changed = false;
        for repo in &mut self.repos {
            if repo.id.is_none() {
                repo.id = Some(uuid::Uuid::new_v4().to_string());
                changed = true;
            }
        }
        changed
    }

    /// Resolve which file to actually read config from, handling debug/release
    /// fallbacks and the legacy `config.dev` (extensionless) name. Returns `None`
    /// when there is no config file at all (caller should use defaults).
    fn resolve_load_path() -> Option<PathBuf> {
        let path = Self::config_path();
        if path.exists() {
            return Some(path);
        }

        #[cfg(debug_assertions)]
        {
            let legacy_debug_path = Self::config_dir().join("config.dev");
            if legacy_debug_path.exists() {
                log::error!(
                    "[config.load] Found legacy debug config at {:?}; attempting migration to {:?}",
                    legacy_debug_path,
                    path
                );
                return match std::fs::rename(&legacy_debug_path, &path) {
                    Ok(()) => Some(path),
                    Err(e) => {
                        log::error!(
                            "[config.load] Failed to migrate legacy debug config: {}. Loading legacy file directly.",
                            e
                        );
                        Some(legacy_debug_path)
                    }
                };
            }
            let release_path = Self::config_dir().join("config.json");
            if release_path.exists() {
                log::error!(
                    "[config.load] Debug config {:?} missing; loading {:?} instead.",
                    path,
                    release_path
                );
                return Some(release_path);
            }
        }

        None
    }

    /// Finalize a freshly-loaded config: assign missing repo IDs, stamp the current
    /// schema version, and persist if anything changed. Returns (config, true).
    fn finalize(mut self, mut changed: bool) -> (Self, bool) {
        if self.ensure_repo_ids() {
            log::error!("[config.load] Assigned IDs to repos without IDs");
            changed = true;
        }
        if self.config_version != CURRENT_CONFIG_VERSION {
            self.config_version = CURRENT_CONFIG_VERSION;
            changed = true;
        }
        if changed {
            let _ = self.save();
        }
        (self, true)
    }

    /// Load config with graceful recovery.
    /// Returns (config, loaded_successfully).
    /// `loaded_successfully` is true if config was parsed from disk (even with field-level fixups),
    /// false if we fell back to defaults entirely.
    pub fn load() -> (Self, bool) {
        // Clean up any leftover atomic-write temp files in the config dir.
        crate::persist::cleanup_tmp_files(&Self::config_dir());

        let Some(load_path) = Self::resolve_load_path() else {
            log::info!("[config.load] No config file found, using defaults");
            return (Self::default(), true);
        };

        let content = match std::fs::read_to_string(&load_path) {
            Ok(c) => c,
            Err(e) => {
                log::error!("[config.load] Failed to read config: {}", e);
                return (Self::default(), false);
            }
        };

        // Parse to a Value first so migrations can run against the raw JSON.
        let mut value = match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(v) => v,
            Err(e) => {
                log::error!(
                    "[config.load] Config is not valid JSON: {}. Falling back to defaults.",
                    e
                );
                return (Self::default(), false);
            }
        };

        let from_version = value
            .get("config_version")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let migrated = migration::run_migrations(&mut value, from_version);

        match serde_json::from_value::<AppConfig>(value) {
            Ok(config) => {
                log::info!(
                    "[config.load] Config loaded successfully ({} repos)",
                    config.repos.len()
                );
                config.finalize(migrated)
            }
            Err(e) => {
                log::error!(
                    "[config.load] Failed to deserialize config even after migrations: {}. Falling back to defaults.",
                    e
                );
                (Self::default(), false)
            }
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path();
        log::info!(
            "[config.save] Writing config to {:?} (repos count: {})",
            path,
            self.repos.len()
        );
        // Atomic write with a rolling backup set (via the shared persist helper).
        crate::persist::save_json_atomic(&path, self, "config", CONFIG_BACKUPS)
    }

    pub fn get_active_repo(&self) -> Option<&RepoConfig> {
        self.repos.get(self.active_repo_index).filter(|r| r.active)
    }

    /// LEGACY / INERT: session work always uses SDK-style flows, so this always
    /// returns `Sdk`. Retained only because callers/frontend still reference the
    /// terminal-mode config keys; no live behavior depends on the result.
    pub fn get_effective_terminal_mode(&self) -> TerminalMode {
        TerminalMode::Sdk
    }
}

/// Number of rolling `.bakN` backups kept alongside `config.json`.
const CONFIG_BACKUPS: usize = 3;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_valid_names_include_all_variants() {
        let names = Theme::valid_names();
        assert!(names.contains(&"Midnight".to_string()));
        assert!(names.contains(&"Aurora".to_string()));
        assert!(names.contains(&"Latte".to_string()));
        // Old dropped names must NOT be present (they were the source of the C3 bug).
        assert!(!names.contains(&"Snow".to_string()));
        assert!(!names.contains(&"Sand".to_string()));
    }

    #[test]
    fn legacy_config_without_version_migrates() {
        // Build a config value that looks like an old on-disk file: no config_version,
        // an unknown theme, and a deprecated Gemini model.
        let mut value = serde_json::to_value(AppConfig::default()).unwrap();
        let obj = value.as_object_mut().unwrap();
        obj.remove("config_version");
        obj.insert(
            "theme".to_string(),
            serde_json::Value::String("Snow".to_string()),
        );
        // Point the LLM at a deprecated Gemini model to exercise the model remap.
        if let Some(serde_json::Value::Object(llm)) = obj.get_mut("llm") {
            llm.insert(
                "provider".to_string(),
                serde_json::Value::String("Gemini".to_string()),
            );
            llm.insert(
                "model".to_string(),
                serde_json::Value::String("gemini-2.0-flash".to_string()),
            );
        }

        let from_version = value
            .get("config_version")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        assert_eq!(from_version, 0, "legacy file should parse as version 0");

        let ran = migration::run_migrations(&mut value, from_version);
        assert!(ran, "migrations should run for a version-0 config");

        let config: AppConfig = serde_json::from_value(value).unwrap();
        // Unknown theme was reset to the default.
        assert_eq!(config.theme, Theme::Midnight);
        // Deprecated Gemini model was remapped.
        assert_eq!(config.llm.model, "gemini-3.1-flash-lite");
    }

    #[test]
    fn current_config_roundtrips_without_migration() {
        let value = serde_json::to_value(AppConfig::default()).unwrap();
        let from_version = value
            .get("config_version")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        assert_eq!(from_version, CURRENT_CONFIG_VERSION);
        // A current-version config triggers no migrations.
        let mut v2 = value.clone();
        assert!(!migration::run_migrations(&mut v2, from_version));
    }
}
