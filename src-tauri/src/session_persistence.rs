use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::config::AppConfig;

/// Write data to a file atomically: write to a `.tmp` sibling, fsync, then rename.
/// Prevents data loss from crashes mid-write (the old file remains intact if the
/// rename never completes).
///
/// TODO(refactor): This byte-oriented writer is retained only for the binary
/// callers in `archive.rs` and `pile_cmds.rs` (audio/screenshot blobs). JSON
/// callers now use `crate::persist::save_json_atomic`. Once those non-owned
/// modules migrate to `crate::persist::atomic_write` (text) or a bytes variant,
/// this function can be removed.
///
/// Delegates to `crate::persist::atomic_write_bytes` (unique temp name per call,
/// so concurrent writers of the same file can't collide on one `.tmp`).
pub fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    crate::persist::atomic_write_bytes(path, content)
        .map_err(|e| format!("Failed to write {:?}: {}", path, e))
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
    /// Deferred-send marker on a parked ghost turn that hasn't been sent yet
    /// ("session_idle" | "repo_idle" | "reset_5h" | "at_time")
    #[serde(default)]
    pub queued: Option<String>,
    /// Id of the parked turn this ghost bubble belongs to
    #[serde(default)]
    pub queued_turn_id: Option<String>,
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
    /// DEPRECATED: kept only for backward-compat with older session files; the
    /// serialized name is preserved. Superseded by `outcome`.
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
    #[serde(alias = "voskTranscript")]
    pub realtime_transcript: Option<String>,
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
    /// Agent account this session is pinned to. For Codex this selects the
    /// CODEX_HOME that owns the persisted rollout used by thread/resume.
    #[serde(default)]
    pub account_id: Option<String>,
    /// Whether 'auto' model was requested (before resolution)
    #[serde(default)]
    pub auto_model_requested: bool,
    /// Effort level: null = off, "low"/"medium"/"high"/"max"
    #[serde(default)]
    pub effort_level: Option<String>,
    /// DEPRECATED: legacy thinking level, superseded by `effort_level`. Kept only so
    /// old session files still deserialize; the serialized name is preserved.
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
    /// Pending prompt to send (for sessions awaiting initialization)
    pub pending_prompt: Option<String>,
    /// Setup draft prompt text
    #[serde(default)]
    pub draft_prompt: Option<String>,
    /// Setup draft images
    #[serde(default)]
    pub draft_images: Option<Vec<PersistedSdkImageContent>>,
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
    /// Smart queue info for a queued session (opaque JSON: reason/provider/window/queuedAt/targetStartAt)
    #[serde(default)]
    pub queue_info: Option<serde_json::Value>,
    /// Legacy single rate-limited / scheduled pending turn (opaque JSON). Read-only:
    /// the frontend migrates it into `parked_turns` on load and stops writing it.
    #[serde(default)]
    pub rate_limited: Option<serde_json::Value>,
    /// Pending turns parked on a live session — rate-limited, deferred or scheduled —
    /// oldest first (opaque JSON array, frontend-owned schema)
    #[serde(default)]
    pub parked_turns: Option<serde_json::Value>,
    /// Source-schedule tag for sessions launched by a native schedule — drives the
    /// restart-surviving schedule badge (opaque JSON, frontend-owned schema)
    #[serde(default)]
    pub schedule_tag: Option<serde_json::Value>,
    /// PR summary detected for the session's branch — drives the restart-surviving
    /// PR badge (opaque JSON, frontend-owned schema)
    #[serde(default)]
    pub pr: Option<serde_json::Value>,
    /// Whether the PR dock panel was left open, so the dock reopens after restart
    #[serde(default)]
    pub pr_panel_open: bool,
    /// Compact latest validation-run summary — drives the restart-surviving
    /// validation badge (opaque JSON, frontend-owned schema)
    #[serde(default)]
    pub validation: Option<serde_json::Value>,
    /// Full latest validation-run snapshot (steps/gate/outcome/panel-open) so the
    /// whole validation panel — not just the badge — survives restart (opaque JSON)
    #[serde(default)]
    pub validation_run: Option<serde_json::Value>,
    /// Pending AskUserQuestion raised by the agent (opaque JSON, frontend-owned schema).
    /// Persisted so the question — and any answers picked so far — survives a restart
    /// instead of vanishing with the sidecar process that was waiting on it.
    #[serde(default)]
    pub ask_user_question: Option<serde_json::Value>,
    /// Whether the session is pinned in the sidebar
    #[serde(default)]
    pub pinned: bool,
    /// When the session was pinned (epoch ms); pins sort by this
    #[serde(default)]
    pub pinned_at: Option<u64>,
}

/// Transport container for all persisted sessions (used for frontend ↔ backend IPC).
/// No longer handles its own file I/O - that's done by SessionIndex.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PersistedSessions {
    pub sdk_sessions: Vec<PersistedSdkSession>,
    pub active_sdk_session_id: Option<String>,
    /// Timestamp when sessions were last saved
    pub saved_at: u64,
}

// ============================================================================
// MESSAGE DELTAS - cheap autosave of long, streaming sessions
// ============================================================================

/// A session sent as a delta against the message list it was last persisted with,
/// so a streaming session doesn't ship (and re-parse) its whole history — often
/// tens of MB — on every autosave. The delta is only valid against a base holding
/// exactly `base_length` messages; anything else is refused and the frontend
/// resends that session in full.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkSessionDelta {
    /// Every non-message field, current. Its `messages` is sent empty and ignored.
    pub session: PersistedSdkSession,
    /// Message count of the persisted snapshot the delta was computed against.
    pub base_length: usize,
    /// Leading messages of that snapshot that are unchanged and kept as-is.
    pub keep_prefix: usize,
    /// Messages following the kept prefix (replaced ones and new ones).
    pub append_messages: Vec<PersistedSdkMessage>,
}

/// Rebuild the full session from `base` (its last-persisted snapshot) and a delta.
/// `None` when the delta wasn't computed against this base.
fn apply_message_delta(
    base: PersistedSdkSession,
    delta: SdkSessionDelta,
) -> Option<PersistedSdkSession> {
    if base.id != delta.session.id
        || base.messages.len() != delta.base_length
        || delta.keep_prefix > delta.base_length
    {
        return None;
    }
    let mut messages = base.messages;
    messages.truncate(delta.keep_prefix);
    messages.extend(delta.append_messages);
    let mut session = delta.session;
    session.messages = messages;
    Some(session)
}

/// Sessions `SessionCache` keeps parsed. Only sessions saved through the autosave
/// upsert (i.e. ones actively streaming) enter it, several at once is rare, and
/// each can be tens of MB — so keep it small.
const SESSION_CACHE_CAPACITY: usize = 4;

/// Parsed copies of the sessions most recently written by the autosave path, so a
/// message delta applies in memory instead of re-reading and re-parsing the data
/// file on every save. Mirrors the data files: an entry is only stored after its
/// file was written and is dropped whenever the file is deleted. A miss just
/// falls back to reading the file.
#[derive(Debug, Default)]
pub struct SessionCache {
    /// Most recently used first.
    entries: Vec<PersistedSdkSession>,
}

impl SessionCache {
    pub const fn new() -> Self {
        Self { entries: Vec::new() }
    }

    fn take(&mut self, id: &str) -> Option<PersistedSdkSession> {
        let pos = self.entries.iter().position(|s| s.id == id)?;
        Some(self.entries.remove(pos))
    }

    fn put(&mut self, session: PersistedSdkSession) {
        self.entries.retain(|s| s.id != session.id);
        self.entries.insert(0, session);
        self.entries.truncate(SESSION_CACHE_CAPACITY);
    }

    fn contains(&self, id: &str) -> bool {
        self.entries.iter().any(|s| s.id == id)
    }

    pub fn remove(&mut self, id: &str) {
        self.entries.retain(|s| s.id != id);
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

/// Resolve a delta against its base — the cached snapshot, else the data file.
/// `None` when there is no base or the delta doesn't match it.
fn rebase_delta(
    cache: &mut SessionCache,
    data_dir: &Path,
    delta: SdkSessionDelta,
) -> Option<PersistedSdkSession> {
    let id = delta.session.id.clone();
    let base = match cache.take(&id) {
        Some(cached) => cached,
        None => match read_session_file(&session_data_path(data_dir, &id)) {
            Ok(on_disk) => on_disk,
            Err(e) => {
                log::warn!("[session_persistence] No base for delta of {}: {}", id, e);
                return None;
            }
        },
    };
    let base_len = base.messages.len();
    let (expected, keep) = (delta.base_length, delta.keep_prefix);
    let rebuilt = apply_message_delta(base, delta);
    if rebuilt.is_none() {
        log::warn!(
            "[session_persistence] Refusing delta for {}: base has {} messages, delta expects {} (keep {})",
            id,
            base_len,
            expected,
            keep
        );
    }
    rebuilt
}

fn session_data_path(data_dir: &Path, id: &str) -> PathBuf {
    data_dir.join(format!("{}.json", id))
}

/// Read and parse one session data file.
fn read_session_file<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    if !path.exists() {
        return Err(format!("Session data file not found: {:?}", path));
    }
    let content =
        fs::read_to_string(path).map_err(|e| format!("Failed to read session data: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse session data: {}", e))
}

/// Serialize a session exactly as its data file stores it (pretty JSON, the format
/// the files have always had), plus the content hash of those bytes. One
/// serialization serves both the change check and the write.
fn encode_session_data(session: &PersistedSdkSession) -> Result<(Vec<u8>, u64), String> {
    let bytes = serde_json::to_vec_pretty(session)
        .map_err(|e| format!("Failed to serialize session data: {}", e))?;
    let hash = content_hash_of(&bytes);
    Ok((bytes, hash))
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
    /// "sdk" (legacy indexes may still contain "pty" entries, which are ignored)
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
    /// Hash of the session's serialized content, used to skip rewriting the
    /// data file when nothing changed. `None` for legacy index files (forces a
    /// write on the next save, then self-heals). See `content_hash_of`.
    #[serde(default)]
    pub content_hash: Option<u64>,
}

/// The session index file containing entry metadata and active session tracking.
/// Stored at sessions/index.json (or sessions-dev/index.json in debug).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndex {
    pub entries: Vec<SessionEntry>,
    pub active_sdk_session_id: Option<String>,
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
        crate::persist::save_json_atomic(&Self::index_path(), self, "session index", 0)
    }

    /// Write a session's data file (atomic) unless its content hash equals
    /// `old_hash` — i.e. the file already holds exactly these bytes — and return
    /// its fresh index entry.
    fn write_session(
        &self,
        sdk: &PersistedSdkSession,
        old_hash: Option<u64>,
    ) -> Result<SessionEntry, String> {
        let (bytes, hash) = encode_session_data(sdk)?;
        if old_hash != Some(hash) {
            let dir = Self::data_dir();
            fs::create_dir_all(&dir)
                .map_err(|e| format!("Failed to create directory for session data: {}", e))?;
            crate::persist::atomic_write_bytes(&session_data_path(&dir, &sdk.id), &bytes)
                .map_err(|e| format!("Failed to write session data: {}", e))?;
        }
        Ok(sdk_to_session_entry(sdk, Some(hash)))
    }

    /// Load full session data from an individual file
    fn load_session_data<T: DeserializeOwned>(&self, id: &str) -> Result<T, String> {
        read_session_file(&session_data_path(&Self::data_dir(), id))
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
        let mut corrupted_ids: Vec<String> = Vec::new();
        // Sessions rewritten with display-sized images, with their new content hash.
        let mut rewritten: Vec<(String, Option<u64>)> = Vec::new();

        for entry in &self.entries {
            match entry.session_type.as_str() {
                "sdk" => match self.load_session_data::<PersistedSdkSession>(&entry.id) {
                    Ok(mut session) => {
                        // One-time shrink for sessions persisted before tool-result
                        // images were display-sized on arrival (see image_shrink).
                        let shrunk = shrink_tool_result_images(&mut session);
                        if shrunk > 0 {
                            log::info!(
                                "[session_persistence] Shrank {} tool-result image(s) in session {}",
                                shrunk,
                                entry.id
                            );
                            match self.write_session(&session, None) {
                                Ok(fresh) => rewritten.push((entry.id.clone(), fresh.content_hash)),
                                Err(e) => log::error!(
                                    "[session_persistence] Failed to rewrite shrunk session {}: {}",
                                    entry.id,
                                    e
                                ),
                            }
                        }
                        sdk_sessions.push(session);
                    }
                    Err(e) => {
                        log::error!(
                            "[session_persistence] Skipping corrupted SDK session {}: {}",
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
        }

        for (id, hash) in &rewritten {
            if let Some(entry) = self.entries.iter_mut().find(|e| &e.id == id) {
                entry.content_hash = *hash;
            }
        }

        if !corrupted_ids.is_empty() || !rewritten.is_empty() {
            if let Err(e) = self.save() {
                log::error!("[session_persistence] Failed to save updated index: {}", e);
            }
        }

        // Sort by last_activity_at descending (most recently active first), falling back to created_at
        sdk_sessions.sort_by(|a, b| {
            let a_activity = a.last_activity_at.unwrap_or(a.created_at);
            let b_activity = b.last_activity_at.unwrap_or(b.created_at);
            b_activity.cmp(&a_activity)
        });

        PersistedSessions {
            sdk_sessions,
            active_sdk_session_id: self.active_sdk_session_id.clone(),
            saved_at: self.saved_at,
        }
    }

    /// Accept a bulk PersistedSessions from the frontend, write each session
    /// to its own file, rebuild the index, and delete stale data files.
    ///
    /// `unchanged_ids` are live sessions the frontend didn't resend because they
    /// haven't changed since it last persisted them — they keep their existing
    /// index entry and data file. Any of those the index doesn't actually hold
    /// (entry or file gone) are returned, so the frontend can send them in full.
    ///
    /// Sessions already in `cache` are refreshed with what was written (so a
    /// streaming session's next delta still applies in memory); stale ones are
    /// dropped from it along with their files.
    pub fn save_from_bulk(
        &mut self,
        sessions: PersistedSessions,
        unchanged_ids: &[String],
        cache: &mut SessionCache,
    ) -> Result<Vec<String>, String> {
        // Build the set of incoming session IDs
        let incoming_ids: HashSet<String> = sessions
            .sdk_sessions
            .iter()
            .map(|s| s.id.clone())
            .chain(unchanged_ids.iter().cloned())
            .collect();

        // Snapshot the previously-stored content hashes so we can skip rewriting
        // (and fsyncing) session files whose content hasn't changed.
        let old_hashes: HashMap<String, Option<u64>> = self
            .entries
            .iter()
            .map(|e| (e.id.clone(), e.content_hash))
            .collect();

        // Delete data files for sessions no longer present (closed/removed by frontend)
        let stale_ids: Vec<String> = self
            .entries
            .iter()
            .filter(|e| !incoming_ids.contains(&e.id))
            .map(|e| e.id.clone())
            .collect();
        for id in &stale_ids {
            cache.remove(id);
            if let Err(e) = Self::delete_session_data(id) {
                log::error!(
                    "[session_persistence] Failed to delete stale session {}: {}",
                    id,
                    e
                );
            }
        }

        // Rebuild index entries and write each session file, skipping files whose
        // content is byte-identical to what's already on disk (unchanged hash).
        let PersistedSessions {
            sdk_sessions,
            active_sdk_session_id,
            saved_at,
        } = sessions;
        let mut new_entries: Vec<SessionEntry> = Vec::with_capacity(sdk_sessions.len());
        for sdk in sdk_sessions {
            let old_hash = old_hashes.get(&sdk.id).copied().flatten();
            new_entries.push(self.write_session(&sdk, old_hash)?);
            if cache.contains(&sdk.id) {
                cache.put(sdk);
            }
        }

        let mut missing_ids = Vec::new();
        for id in unchanged_ids {
            let on_disk = session_data_path(&Self::data_dir(), id).exists();
            match self.entries.iter().find(|e| &e.id == id) {
                Some(existing) if on_disk => new_entries.push(existing.clone()),
                _ => missing_ids.push(id.clone()),
            }
        }
        self.entries = new_entries;

        // Copy active ID and timestamp
        self.active_sdk_session_id = active_sdk_session_id;
        self.saved_at = saved_at;

        // Save index
        self.save()?;
        Ok(missing_ids)
    }

    /// Partial save: upsert just the given SDK sessions (used by the frequent
    /// debounced autosave during a live query). Only rewrites the data files of
    /// sessions whose content changed, then rewrites the (small) index once.
    ///
    /// `sessions` arrive in full; `deltas` carry only the messages changed since
    /// the session was last persisted and are rebuilt against the cached (or
    /// on-disk) base. Deltas that don't match their base are skipped and their ids
    /// returned — the frontend resends those in full.
    ///
    /// Unlike `save_from_bulk`, this does NOT delete stale files or enforce
    /// overflow — those are handled by full saves, which
    /// still run on structural changes, on the periodic timer, and on
    /// visibility/unload. This keeps the hot path down to ~1 session-file write
    /// plus the index write.
    pub fn upsert_sdk_sessions(
        &mut self,
        sessions: Vec<PersistedSdkSession>,
        deltas: Vec<SdkSessionDelta>,
        active_sdk_session_id: Option<String>,
        cache: &mut SessionCache,
    ) -> Result<Vec<String>, String> {
        let data_dir = Self::data_dir();
        let mut needs_full = Vec::new();
        let mut resolved = sessions;
        for delta in deltas {
            let id = delta.session.id.clone();
            match rebase_delta(cache, &data_dir, delta) {
                Some(session) => resolved.push(session),
                None => needs_full.push(id),
            }
        }

        for sdk in resolved {
            let old_hash = self
                .entries
                .iter()
                .find(|e| e.id == sdk.id)
                .and_then(|e| e.content_hash);
            let entry = self.write_session(&sdk, old_hash)?;
            match self.entries.iter_mut().find(|e| e.id == sdk.id) {
                Some(existing) => *existing = entry,
                None => self.entries.push(entry),
            }
            cache.put(sdk);
        }

        if let Some(active) = active_sdk_session_id {
            self.active_sdk_session_id = Some(active);
        }
        self.saved_at = crate::util::now_secs();
        self.save()?;
        Ok(needs_full)
    }

    /// Separate sessions that exceed max count, returning overflow sessions.
    /// Active/running sessions are protected and never overflowed.
    /// Overflow sessions are loaded from their data files, then the files are deleted.
    pub fn separate_overflow(
        &mut self,
        max_sessions: usize,
        cache: &mut SessionCache,
    ) -> Vec<PersistedSdkSession> {
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
                _ => {}
            }
            // Delete the data file for the overflow session
            cache.remove(&entry.id);
            if let Err(e) = Self::delete_session_data(&entry.id) {
                log::error!(
                    "[session_persistence] Failed to delete overflow session file {}: {}",
                    entry.id,
                    e
                );
            }
        }

        overflow_sdk
    }

    /// Clear all persisted sessions (delete all data files and reset index)
    pub fn clear(&mut self) -> Result<(), String> {
        self.entries.clear();
        self.active_sdk_session_id = None;
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
            match index.write_session(sdk, None) {
                Ok(entry) => index.entries.push(entry),
                Err(e) => log::error!(
                    "[session_persistence] Failed to migrate SDK session {}: {}",
                    sdk.id,
                    e
                ),
            }
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

/// Stable content hash of a session's serialized data-file bytes, used to detect
/// whether the file needs rewriting (see `encode_session_data`).
///
/// Uses `DefaultHasher` over the bytes. The hash is persisted in the index; if
/// the hash function or the hashed bytes change (a toolchain update, or the
/// switch from hashing compact JSON to hashing the written pretty JSON), every
/// session simply gets rewritten once and the new hashes are stored — self-healing.
fn content_hash_of(bytes: &[u8]) -> u64 {
    use std::hash::Hasher;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hasher.write(bytes);
    hasher.finish()
}

/// Re-encode a session's oversized tool-result images to display size (see
/// `image_shrink`). Returns how many were re-encoded; 0 leaves the session untouched.
fn shrink_tool_result_images(session: &mut PersistedSdkSession) -> usize {
    use crate::image_shrink::{budget_for, par_sum, shrink};

    let is_subagent = |m: &PersistedSdkMessage| m.parent_tool_use_id.as_deref().is_some_and(|p| !p.is_empty());
    // Cheap scan first: nearly every session has nothing to do, and the parallel
    // pass would otherwise spin up threads for each of them.
    let has_work = session.messages.iter().any(|m| {
        m.msg_type == "tool_result"
            && m.images.as_ref().is_some_and(|imgs| {
                imgs.iter()
                    .any(|i| budget_for(is_subagent(m)).wants(i.base64_data.len(), (i.width, i.height)))
            })
    });
    if !has_work {
        return 0;
    }

    par_sum(&mut session.messages, |msg| {
        if msg.msg_type != "tool_result" {
            return 0;
        }
        let budget = budget_for(is_subagent(msg));
        let Some(images) = msg.images.as_mut() else {
            return 0;
        };
        let mut shrunk = 0;
        for img in images.iter_mut() {
            if let Some(out) = shrink(&img.base64_data, (img.width, img.height), budget) {
                img.media_type = out.media_type.to_string();
                img.base64_data = out.base64_data;
                img.width = Some(out.width);
                img.height = Some(out.height);
                shrunk += 1;
            }
        }
        shrunk
    })
}

/// Extract lightweight index metadata from an SDK session. `content_hash` is the
/// hash of its encoded data file (`encode_session_data`).
fn sdk_to_session_entry(session: &PersistedSdkSession, content_hash: Option<u64>) -> SessionEntry {
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
        content_hash,
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
            | "setup"
            | "prepared"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ow-session-persist-test-{}-{}",
            name,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn msg(content: &str, timestamp: u64) -> serde_json::Value {
        json!({ "type": "text", "content": content, "timestamp": timestamp })
    }

    fn session(id: &str, status: &str, contents: &[&str]) -> PersistedSdkSession {
        let messages: Vec<_> = contents
            .iter()
            .enumerate()
            .map(|(i, c)| msg(c, i as u64))
            .collect();
        serde_json::from_value(json!({
            "id": id,
            "cwd": "F:/Repos/x",
            "model": "claude-opus-5-5",
            "messages": messages,
            "status": status,
            "createdAt": 1,
        }))
        .unwrap()
    }

    fn delta(
        id: &str,
        status: &str,
        base_length: usize,
        keep_prefix: usize,
        append: &[&str],
    ) -> SdkSessionDelta {
        let append: Vec<_> = append.iter().map(|c| msg(c, 99)).collect();
        serde_json::from_value(json!({
            "session": serde_json::to_value(session(id, status, &[])).unwrap(),
            "baseLength": base_length,
            "keepPrefix": keep_prefix,
            "appendMessages": append,
        }))
        .unwrap()
    }

    fn contents(s: &PersistedSdkSession) -> Vec<&str> {
        s.messages.iter().map(|m| m.content.as_deref().unwrap()).collect()
    }

    #[test]
    fn delta_appends_and_takes_new_fields() {
        let base = session("a", "querying", &["m0", "m1", "m2"]);
        let out = apply_message_delta(base, delta("a", "idle", 3, 3, &["m3", "m4"])).unwrap();
        assert_eq!(contents(&out), ["m0", "m1", "m2", "m3", "m4"]);
        assert_eq!(out.status, "idle");
    }

    #[test]
    fn delta_replaces_and_truncates_suffix() {
        // A message replaced in place (thinking-end) plus a trailing one sliced off.
        let base = session("a", "querying", &["m0", "thinking", "done"]);
        let out = apply_message_delta(base, delta("a", "idle", 3, 1, &["thought"])).unwrap();
        assert_eq!(contents(&out), ["m0", "thought"]);

        // Pure truncation: nothing appended.
        let base = session("a", "idle", &["m0", "m1", "m2"]);
        let out = apply_message_delta(base, delta("a", "idle", 3, 0, &[])).unwrap();
        assert!(out.messages.is_empty());
    }

    #[test]
    fn delta_against_wrong_base_is_refused() {
        let base = || session("a", "querying", &["m0", "m1"]);
        // Base length disagrees.
        assert!(apply_message_delta(base(), delta("a", "idle", 3, 3, &["x"])).is_none());
        // Keeping more than the base had.
        assert!(apply_message_delta(base(), delta("a", "idle", 2, 3, &["x"])).is_none());
        // Different session.
        assert!(apply_message_delta(base(), delta("b", "idle", 2, 2, &["x"])).is_none());
    }

    #[test]
    fn rebase_uses_cache_then_disk_and_reports_missing() {
        let dir = temp_dir("rebase");
        let mut cache = SessionCache::new();

        // No cache entry, no file → needs full.
        assert!(rebase_delta(&mut cache, &dir, delta("a", "idle", 0, 0, &["x"])).is_none());

        // Cache miss falls back to the data file.
        let (bytes, _) = encode_session_data(&session("a", "idle", &["m0"])).unwrap();
        fs::write(session_data_path(&dir, "a"), bytes).unwrap();
        let out = rebase_delta(&mut cache, &dir, delta("a", "idle", 1, 1, &["m1"])).unwrap();
        assert_eq!(contents(&out), ["m0", "m1"]);

        // The cached base wins over the (now older) file.
        cache.put(out);
        let out = rebase_delta(&mut cache, &dir, delta("a", "idle", 2, 2, &["m2"])).unwrap();
        assert_eq!(contents(&out), ["m0", "m1", "m2"]);
        assert!(!cache.contains("a"), "the base is moved out, not cloned");

        // A mismatched delta against the file → needs full.
        assert!(rebase_delta(&mut cache, &dir, delta("a", "idle", 5, 5, &["x"])).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_is_bounded_most_recent_first() {
        let mut cache = SessionCache::new();
        for i in 0..SESSION_CACHE_CAPACITY + 2 {
            cache.put(session(&format!("s{}", i), "idle", &[]));
        }
        assert!(!cache.contains("s0") && !cache.contains("s1"));
        assert!(cache.contains(&format!("s{}", SESSION_CACHE_CAPACITY + 1)));
        // Re-putting refreshes rather than duplicating.
        cache.put(session("s2", "querying", &[]));
        assert_eq!(cache.entries.len(), SESSION_CACHE_CAPACITY);
        assert_eq!(cache.take("s2").unwrap().status, "querying");
        cache.remove("s3");
        assert!(!cache.contains("s3"));
    }

    #[test]
    fn old_format_file_loads_and_takes_deltas() {
        // A pre-delta data file: pretty JSON, legacy thinkingLevel, none of the newer
        // optional fields.
        let dir = temp_dir("old-format");
        let old = json!({
            "id": "old",
            "cwd": "F:/Repos/x",
            "model": "claude-sonnet-4-5",
            "thinkingLevel": "on",
            "messages": [
                { "type": "user", "content": "hi", "timestamp": 1 },
                { "type": "tool_start", "tool": "Read", "toolUseId": "t1",
                  "input": { "file_path": "a.rs" }, "timestamp": 2 },
                { "type": "tool_result", "toolUseId": "t1", "output": "fn main() {}", "timestamp": 3 }
            ],
            "status": "idle",
            "createdAt": 1,
            "startedAt": null,
            "usage": null,
            "aiMetadata": null,
            "pendingTranscription": null,
            "pendingRepoSelection": null,
            "pendingPrompt": null
        });
        let path = session_data_path(&dir, "old");
        fs::write(&path, serde_json::to_string_pretty(&old).unwrap()).unwrap();

        let loaded: PersistedSdkSession = read_session_file(&path).unwrap();
        assert_eq!(loaded.messages.len(), 3);
        assert_eq!(loaded.thinking_level.as_deref(), Some("on"));

        let mut cache = SessionCache::new();
        let out = rebase_delta(&mut cache, &dir, delta("old", "idle", 3, 3, &["more"])).unwrap();
        assert_eq!(out.messages.len(), 4);
        assert_eq!(out.messages[1].tool.as_deref(), Some("Read"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn encoded_bytes_are_the_file_format_and_hash_is_stable() {
        let s = session("a", "idle", &["m0", "m1"]);
        let (bytes, hash) = encode_session_data(&s).unwrap();
        assert_eq!(bytes, serde_json::to_string_pretty(&s).unwrap().into_bytes());
        assert_eq!(encode_session_data(&s).unwrap().1, hash);
        let changed = session("a", "idle", &["m0", "m1", "m2"]);
        assert_ne!(encode_session_data(&changed).unwrap().1, hash);
        let round: PersistedSdkSession = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(round.messages.len(), 2);
    }
}
