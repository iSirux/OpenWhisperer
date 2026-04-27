use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::config::AppConfig;

/// Write data to a file atomically: write to a `.tmp` sibling, fsync, then rename.
/// Prevents data loss from crashes mid-write (the old file remains intact if the
/// rename never completes).
pub fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let tmp_path = path.with_extension("json.tmp");

    let result = (|| -> Result<(), String> {
        let mut file = fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create temp file: {}", e))?;
        file.write_all(content)
            .map_err(|e| format!("Failed to write temp file: {}", e))?;
        file.sync_all()
            .map_err(|e| format!("Failed to sync temp file: {}", e))?;
        drop(file);
        fs::rename(&tmp_path, path)
            .map_err(|e| format!("Failed to rename temp file: {}", e))?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }

    result
}

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
    /// Unique tool use ID for matching tool_start/tool_result pairs and task grouping
    #[serde(default)]
    pub tool_use_id: Option<String>,
    /// Parent tool use ID for grouping child messages under task containers
    #[serde(default)]
    pub parent_tool_use_id: Option<String>,
    pub input: Option<serde_json::Value>,
    pub output: Option<String>,
    /// Subagent ID (for subagent-start/subagent-stop messages)
    pub agent_id: Option<String>,
    /// Subagent type
    pub agent_type: Option<String>,
    /// Subagent transcript path
    pub transcript_path: Option<String>,
    /// Duration of thinking in milliseconds (for thinking messages)
    #[serde(default)]
    pub thinking_duration_ms: Option<u64>,
    // -- Task lifecycle fields --
    /// Task ID (for task_started/task_completed messages)
    #[serde(default)]
    pub task_id: Option<String>,
    /// Task description
    #[serde(default)]
    pub description: Option<String>,
    /// Task/subagent type (e.g., "Bash", "Explore")
    #[serde(default)]
    pub task_type: Option<String>,
    /// Task completion status
    #[serde(default)]
    pub task_status: Option<String>,
    /// Task completion summary
    #[serde(default)]
    pub summary: Option<String>,
    /// Task usage statistics (opaque JSON: { total_tokens, tool_uses, duration_ms })
    #[serde(default)]
    pub task_usage: Option<serde_json::Value>,
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
    #[serde(default, alias = "cacheCreationInputTokens")]
    pub total_cache_creation_tokens: u64,
    #[serde(default, alias = "cacheReadInputTokens")]
    pub total_cache_read_tokens: u64,
    #[serde(default, alias = "totalCost")]
    pub total_cost_usd: f64,
    #[serde(default)]
    pub total_duration_ms: u64,
    #[serde(default)]
    pub total_duration_api_ms: u64,
    #[serde(default)]
    pub total_turns: u64,
    #[serde(default)]
    pub context_window: u64,
    #[serde(default)]
    pub context_usage_percent: f64,
    /// Per-query usage breakdown (opaque JSON array of SdkUsage objects)
    #[serde(default)]
    pub query_usage: Vec<serde_json::Value>,
    #[serde(default)]
    pub progressive_input_tokens: u64,
    #[serde(default)]
    pub progressive_output_tokens: u64,
    #[serde(default)]
    pub progressive_cache_read_tokens: u64,
    #[serde(default)]
    pub progressive_cache_creation_tokens: u64,
}

/// Represents AI-generated metadata for a session
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSessionAiMetadata {
    pub name: Option<String>,
    /// @deprecated - kept for backward compat with older session files
    pub summary: Option<String>,
    pub category: Option<String>,
    /// Session outcome description
    pub outcome: Option<String>,
    #[serde(default)]
    pub needs_interaction: bool,
    /// Why interaction is needed
    pub interaction_reason: Option<String>,
    /// Urgency level of the interaction
    pub interaction_urgency: Option<String>,
    /// What the session is waiting for
    pub waiting_for: Option<String>,
    /// Quick action suggestions (opaque JSON array of { prompt: string } objects)
    #[serde(default)]
    pub quick_actions: Option<Vec<serde_json::Value>>,
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
    /// Stable repo entity ID (frontend repo config ID)
    #[serde(default)]
    pub repo_id: Option<String>,
    /// Setup-only selected repository path (main repo, not worktree path)
    #[serde(default)]
    pub setup_repo_path: Option<String>,
    /// Setup-only selected worktree mode: "main" | "new" | "existing"
    #[serde(default)]
    pub setup_worktree_mode: Option<String>,
    /// Setup-only selected existing worktree path
    #[serde(default)]
    pub setup_worktree_path: Option<String>,
    /// Branch captured when the session was first associated with this repo
    #[serde(default)]
    pub created_branch: Option<String>,
    /// Most recently fetched branch for this session
    #[serde(default)]
    pub current_branch: Option<String>,
    pub model: String,
    /// SDK provider ("anthropic", "openai", etc.)
    #[serde(default)]
    pub provider: Option<String>,
    /// Whether the session uses read-only mode (read tools + web search)
    #[serde(default)]
    pub read_only_mode: bool,
    /// Whether 'auto' model was requested (before resolution)
    #[serde(default)]
    pub auto_model_requested: bool,
    /// Effort level: null = off, "low"/"medium"/"high"/"max"
    #[serde(default)]
    pub effort_level: Option<String>,
    /// @deprecated Thinking level - kept for backward compat loading
    #[serde(default)]
    pub thinking_level: Option<String>,
    pub messages: Vec<PersistedSdkMessage>,
    pub status: String,
    pub created_at: u64,
    /// When the session last had activity (e.g., prompt sent). Falls back to created_at.
    #[serde(default)]
    pub last_activity_at: Option<u64>,
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
    /// Setup draft prompt text
    #[serde(default)]
    pub draft_prompt: Option<String>,
    /// Setup draft images
    #[serde(default)]
    pub draft_images: Option<Vec<PersistedSdkImageContent>>,
    /// Plan mode state (opaque JSON - complex nested type)
    #[serde(default)]
    pub plan_mode: Option<serde_json::Value>,
    /// Note mode state (opaque JSON)
    #[serde(default)]
    pub note_mode: Option<serde_json::Value>,
    /// SDK session ID for proper resume after app restart
    #[serde(default)]
    pub sdk_session_id: Option<String>,
    /// Prompt stored for a prepared session (ready to launch)
    #[serde(default)]
    pub prepared_prompt: Option<String>,
    /// System prompt stored for a prepared session
    #[serde(default)]
    pub prepared_system_prompt: Option<String>,
    /// Repo recommendation stored for a prepared session (opaque JSON)
    #[serde(default)]
    pub prepared_repo_recommendation: Option<serde_json::Value>,
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

/// Transport container for all persisted sessions (used for frontend ↔ backend IPC).
/// No longer handles its own file I/O - that's done by SessionIndex.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PersistedSessions {
    pub sdk_sessions: Vec<PersistedSdkSession>,
    pub terminal_sessions: Vec<PersistedTerminalSession>,
    pub active_sdk_session_id: Option<String>,
    pub active_terminal_session_id: Option<String>,
    /// Timestamp when sessions were last saved
    pub saved_at: u64,
}

// ============================================================================
// SESSION INDEX - One-file-per-session storage (mirrors archive pattern)
// ============================================================================

/// Lightweight metadata for a session stored in the index.
/// Contains just enough info to enumerate and sort sessions without loading full data.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    pub id: String,
    /// "sdk" | "pty"
    pub session_type: String,
    /// AI-generated name (if available)
    pub name: Option<String>,
    /// Claude model used (SDK only)
    pub model: Option<String>,
    /// Working directory / repo path
    pub cwd: Option<String>,
    /// Session status string
    pub status: String,
    /// When the session was created (epoch ms)
    pub created_at: u64,
    /// When the session last had activity (epoch ms). Falls back to created_at.
    #[serde(default)]
    pub last_activity_at: Option<u64>,
    /// Total cost in dollars (SDK only)
    pub total_cost: Option<f64>,
}

/// The session index file containing entry metadata and active session tracking.
/// Stored at sessions/index.json (or sessions-dev/index.json in debug).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndex {
    pub entries: Vec<SessionEntry>,
    pub active_sdk_session_id: Option<String>,
    pub active_terminal_session_id: Option<String>,
    pub saved_at: u64,
    /// Version for future migrations
    #[serde(default)]
    pub version: u32,
}

impl SessionIndex {
    /// Get the sessions directory path (separate for debug/release)
    pub fn sessions_dir() -> PathBuf {
        #[cfg(debug_assertions)]
        let dirname = "sessions-dev";
        #[cfg(not(debug_assertions))]
        let dirname = "sessions";
        AppConfig::config_dir().join(dirname)
    }

    /// Get the session data files directory path
    fn data_dir() -> PathBuf {
        Self::sessions_dir().join("data")
    }

    /// Get the index file path
    fn index_path() -> PathBuf {
        Self::sessions_dir().join("index.json")
    }

    /// Get the legacy single-file sessions path (for migration)
    fn legacy_path() -> PathBuf {
        #[cfg(debug_assertions)]
        let filename = "sessions.dev.json";
        #[cfg(not(debug_assertions))]
        let filename = "sessions.json";
        AppConfig::config_dir().join(filename)
    }

    /// Load the session index from disk.
    /// If no index exists, attempts migration from legacy sessions.json.
    /// Also cleans up leftover .tmp files from interrupted atomic writes.
    pub fn load() -> Self {
        Self::cleanup_tmp_files();

        let path = Self::index_path();
        if path.exists() {
            match fs::read_to_string(&path) {
                Ok(content) => match serde_json::from_str(&content) {
                    Ok(index) => return index,
                    Err(e) => log::error!("[session_persistence] Failed to parse index: {}", e),
                },
                Err(e) => log::error!("[session_persistence] Failed to read index: {}", e),
            }
        }

        // Migration path: try legacy single-file format
        if let Some(index) = Self::migrate_from_legacy() {
            return index;
        }

        Self::default()
    }

    /// Remove leftover .tmp files from interrupted atomic writes
    fn cleanup_tmp_files() {
        for dir in [Self::sessions_dir(), Self::data_dir()] {
            if let Ok(entries) = fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) == Some("tmp") {
                        log::info!("[session_persistence] Removing stale tmp file: {:?}", path);
                        let _ = fs::remove_file(&path);
                    }
                }
            }
        }
    }

    /// Save the session index to disk (atomic write)
    pub fn save(&self) -> Result<(), String> {
        let dir = Self::sessions_dir();
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;

        let path = Self::index_path();
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize session index: {}", e))?;

        atomic_write(&path, content.as_bytes())
            .map_err(|e| format!("Failed to write session index: {}", e))?;
        Ok(())
    }

    /// Save full session data to an individual file (atomic write)
    fn save_session_data(&self, id: &str, data: &impl Serialize) -> Result<(), String> {
        let dir = Self::data_dir();
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create session data dir: {}", e))?;

        let path = dir.join(format!("{}.json", id));
        let content = serde_json::to_string_pretty(data)
            .map_err(|e| format!("Failed to serialize session data: {}", e))?;

        atomic_write(&path, content.as_bytes())
            .map_err(|e| format!("Failed to write session data for {}: {}", id, e))?;
        Ok(())
    }

    /// Load full session data from an individual file
    fn load_session_data<T: DeserializeOwned>(&self, id: &str) -> Result<T, String> {
        let path = Self::data_dir().join(format!("{}.json", id));
        if !path.exists() {
            return Err(format!("Session data file not found: {}", id));
        }

        let content =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read session data: {}", e))?;

        serde_json::from_str(&content).map_err(|e| format!("Failed to parse session data: {}", e))
    }

    /// Delete a session data file
    fn delete_session_data(id: &str) -> Result<(), String> {
        let path = Self::data_dir().join(format!("{}.json", id));
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete session data file: {}", e))?;
        }
        Ok(())
    }

    /// Load all session data files and reconstruct a PersistedSessions transport object.
    /// Gracefully skips entries whose data files are missing or corrupted, and
    /// removes corrupted data files + prunes them from the index.
    pub fn load_all_sessions(&mut self) -> PersistedSessions {
        let mut sdk_sessions = Vec::new();
        let mut terminal_sessions = Vec::new();
        let mut corrupted_ids: Vec<String> = Vec::new();

        for entry in &self.entries {
            match entry.session_type.as_str() {
                "sdk" => match self.load_session_data::<PersistedSdkSession>(&entry.id) {
                    Ok(session) => sdk_sessions.push(session),
                    Err(e) => {
                        log::error!(
                            "[session_persistence] Skipping corrupted SDK session {}: {}",
                            entry.id,
                            e
                        );
                        corrupted_ids.push(entry.id.clone());
                    }
                },
                "pty" => match self.load_session_data::<PersistedTerminalSession>(&entry.id) {
                    Ok(session) => terminal_sessions.push(session),
                    Err(e) => {
                        log::error!(
                            "[session_persistence] Skipping corrupted PTY session {}: {}",
                            entry.id,
                            e
                        );
                        corrupted_ids.push(entry.id.clone());
                    }
                },
                _ => {}
            }
        }

        if !corrupted_ids.is_empty() {
            log::error!(
                "[session_persistence] Pruning {} corrupted session(s) from index",
                corrupted_ids.len()
            );
            let corrupted_set: HashSet<&str> =
                corrupted_ids.iter().map(|s| s.as_str()).collect();
            self.entries.retain(|e| !corrupted_set.contains(e.id.as_str()));

            for id in &corrupted_ids {
                if let Err(e) = Self::delete_session_data(id) {
                    log::error!(
                        "[session_persistence] Failed to delete corrupted data file {}: {}",
                        id, e
                    );
                }
            }

            if let Err(e) = self.save() {
                log::error!("[session_persistence] Failed to save pruned index: {}", e);
            }
        }

        // Sort by last_activity_at descending (most recently active first), falling back to created_at
        sdk_sessions.sort_by(|a, b| {
            let a_activity = a.last_activity_at.unwrap_or(a.created_at);
            let b_activity = b.last_activity_at.unwrap_or(b.created_at);
            b_activity.cmp(&a_activity)
        });
        terminal_sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));

        PersistedSessions {
            sdk_sessions,
            terminal_sessions,
            active_sdk_session_id: self.active_sdk_session_id.clone(),
            active_terminal_session_id: self.active_terminal_session_id.clone(),
            saved_at: self.saved_at,
        }
    }

    /// Accept a bulk PersistedSessions from the frontend, write each session
    /// to its own file, rebuild the index, and delete stale data files.
    pub fn save_from_bulk(&mut self, sessions: &PersistedSessions) -> Result<(), String> {
        // Build the set of incoming session IDs
        let incoming_ids: HashSet<String> = sessions
            .sdk_sessions
            .iter()
            .map(|s| s.id.clone())
            .chain(sessions.terminal_sessions.iter().map(|s| s.id.clone()))
            .collect();

        // Delete data files for sessions no longer present (closed/removed by frontend)
        let stale_ids: Vec<String> = self
            .entries
            .iter()
            .filter(|e| !incoming_ids.contains(&e.id))
            .map(|e| e.id.clone())
            .collect();
        for id in &stale_ids {
            if let Err(e) = Self::delete_session_data(id) {
                log::error!(
                    "[session_persistence] Failed to delete stale session {}: {}",
                    id,
                    e
                );
            }
        }

        // Write each session to its own file
        for sdk in &sessions.sdk_sessions {
            self.save_session_data(&sdk.id, sdk)?;
        }
        for pty in &sessions.terminal_sessions {
            self.save_session_data(&pty.id, pty)?;
        }

        // Rebuild index entries from the session data
        self.entries = sessions
            .sdk_sessions
            .iter()
            .map(sdk_to_session_entry)
            .chain(sessions.terminal_sessions.iter().map(pty_to_session_entry))
            .collect();

        // Copy active IDs and timestamp
        self.active_sdk_session_id = sessions.active_sdk_session_id.clone();
        self.active_terminal_session_id = sessions.active_terminal_session_id.clone();
        self.saved_at = sessions.saved_at;

        // Save index
        self.save()
    }

    /// Separate sessions that exceed max count, returning overflow sessions.
    /// Active/running sessions are protected and never overflowed.
    /// Overflow sessions are loaded from their data files, then the files are deleted.
    /// Returns (overflow_sdk_sessions, overflow_terminal_sessions)
    pub fn separate_overflow(
        &mut self,
        max_sessions: usize,
    ) -> (Vec<PersistedSdkSession>, Vec<PersistedTerminalSession>) {
        // Sort entries by last_activity_at descending (most recently active first), falling back to created_at
        self.entries.sort_by(|a, b| {
            let a_activity = a.last_activity_at.unwrap_or(a.created_at);
            let b_activity = b.last_activity_at.unwrap_or(b.created_at);
            b_activity.cmp(&a_activity)
        });

        let mut keep = Vec::new();
        let mut overflow_entries = Vec::new();

        for entry in self.entries.drain(..) {
            if keep.len() < max_sessions || is_active_status(&entry.status) {
                keep.push(entry);
            } else {
                overflow_entries.push(entry);
            }
        }
        self.entries = keep;

        // Load full data for overflow sessions and delete their files
        let mut overflow_sdk = Vec::new();
        let mut overflow_terminal = Vec::new();

        for entry in &overflow_entries {
            match entry.session_type.as_str() {
                "sdk" => match self.load_session_data::<PersistedSdkSession>(&entry.id) {
                    Ok(session) => overflow_sdk.push(session),
                    Err(e) => log::error!(
                        "[session_persistence] Failed to load overflow SDK session {}: {}",
                        entry.id,
                        e
                    ),
                },
                "pty" => match self.load_session_data::<PersistedTerminalSession>(&entry.id) {
                    Ok(session) => overflow_terminal.push(session),
                    Err(e) => log::error!(
                        "[session_persistence] Failed to load overflow PTY session {}: {}",
                        entry.id,
                        e
                    ),
                },
                _ => {}
            }
            // Delete the data file for the overflow session
            if let Err(e) = Self::delete_session_data(&entry.id) {
                log::error!(
                    "[session_persistence] Failed to delete overflow session file {}: {}",
                    entry.id,
                    e
                );
            }
        }

        (overflow_sdk, overflow_terminal)
    }

    /// Clear all persisted sessions (delete all data files and reset index)
    pub fn clear(&mut self) -> Result<(), String> {
        self.entries.clear();
        self.active_sdk_session_id = None;
        self.active_terminal_session_id = None;
        self.saved_at = 0;

        // Remove the data directory and all files within
        let data_dir = Self::data_dir();
        if data_dir.exists() {
            fs::remove_dir_all(&data_dir)
                .map_err(|e| format!("Failed to clear session data dir: {}", e))?;
        }

        // Save empty index
        self.save()
    }

    /// Attempt migration from legacy single-file sessions.json format.
    /// Reads the old file, writes each session to an individual file,
    /// builds the index, saves it, and deletes the old file.
    fn migrate_from_legacy() -> Option<Self> {
        let legacy_path = Self::legacy_path();
        if !legacy_path.exists() {
            return None;
        }

        log::error!("[session_persistence] Migrating from legacy sessions file...");

        let content = match fs::read_to_string(&legacy_path) {
            Ok(c) => c,
            Err(e) => {
                log::error!(
                    "[session_persistence] Failed to read legacy sessions file: {}",
                    e
                );
                return None;
            }
        };

        let old_data: PersistedSessions = match serde_json::from_str(&content) {
            Ok(d) => d,
            Err(e) => {
                log::error!(
                    "[session_persistence] Failed to parse legacy sessions file: {}",
                    e
                );
                // Leave the old file intact if we can't parse it
                return None;
            }
        };

        let mut index = SessionIndex {
            active_sdk_session_id: old_data.active_sdk_session_id,
            active_terminal_session_id: old_data.active_terminal_session_id,
            saved_at: old_data.saved_at,
            version: 1,
            entries: Vec::new(),
        };

        // Ensure directories exist
        if let Err(e) = fs::create_dir_all(Self::data_dir()) {
            log::error!(
                "[session_persistence] Failed to create data dir during migration: {}",
                e
            );
            return None;
        }

        // Write each SDK session to its own file
        for sdk in &old_data.sdk_sessions {
            if let Err(e) = index.save_session_data(&sdk.id, sdk) {
                log::error!(
                    "[session_persistence] Failed to migrate SDK session {}: {}",
                    sdk.id,
                    e
                );
                continue;
            }
            index.entries.push(sdk_to_session_entry(sdk));
        }

        // Write each terminal session to its own file
        for pty in &old_data.terminal_sessions {
            if let Err(e) = index.save_session_data(&pty.id, pty) {
                log::error!(
                    "[session_persistence] Failed to migrate PTY session {}: {}",
                    pty.id,
                    e
                );
                continue;
            }
            index.entries.push(pty_to_session_entry(pty));
        }

        // Save the new index
        if let Err(e) = index.save() {
            log::error!(
                "[session_persistence] Failed to save index during migration: {}",
                e
            );
            return None;
        }

        // Delete the old file after successful migration
        if let Err(e) = fs::remove_file(&legacy_path) {
            log::error!(
                "[session_persistence] Failed to delete legacy sessions file: {}",
                e
            );
            // Non-fatal: migration was successful, just couldn't clean up
        }

        log::error!(
            "[session_persistence] Migration complete: {} sessions migrated",
            index.entries.len()
        );

        Some(index)
    }
}

/// Extract lightweight index metadata from an SDK session
fn sdk_to_session_entry(session: &PersistedSdkSession) -> SessionEntry {
    SessionEntry {
        id: session.id.clone(),
        session_type: "sdk".to_string(),
        name: session.ai_metadata.as_ref().and_then(|m| m.name.clone()),
        model: Some(session.model.clone()),
        cwd: Some(session.cwd.clone()),
        status: session.status.clone(),
        created_at: session.created_at,
        last_activity_at: session.last_activity_at,
        total_cost: session.usage.as_ref().map(|u| u.total_cost_usd),
    }
}

/// Extract lightweight index metadata from a terminal session
fn pty_to_session_entry(session: &PersistedTerminalSession) -> SessionEntry {
    SessionEntry {
        id: session.id.clone(),
        session_type: "pty".to_string(),
        name: None,
        model: None,
        cwd: Some(session.repo_path.clone()),
        status: session.status.clone(),
        created_at: session.created_at,
        last_activity_at: None,
        total_cost: None,
    }
}

/// Check if a session status represents an actively running session
/// that should be protected from overflow archiving
fn is_active_status(status: &str) -> bool {
    matches!(
        status,
        "querying"
            | "initializing"
            | "pending_transcription"
            | "pending_repo"
            | "pending_approval"
            | "setup"
            | "prepared"
    )
}
