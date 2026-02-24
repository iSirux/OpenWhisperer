use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::config::AppConfig;
use crate::session_persistence::{PersistedSdkSession, PersistedTerminalSession};

/// Lightweight metadata for an archived session, stored in the index
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub id: String,
    /// "sdk" | "pty" | "sequence"
    pub session_type: String,
    /// AI-generated name or sequence name
    pub name: Option<String>,
    /// AI-generated summary
    pub summary: Option<String>,
    /// AI-generated category
    pub category: Option<String>,
    /// First user prompt (truncated to ~200 chars for index)
    pub prompt: Option<String>,
    /// Claude model used
    pub model: Option<String>,
    /// Repository path
    pub repo_path: Option<String>,
    /// Final session status
    pub status: String,
    /// When the session was originally created (ms epoch)
    pub created_at: u64,
    /// When the session was archived (ms epoch)
    pub archived_at: u64,
    /// Total work duration in milliseconds
    pub duration_ms: u64,
    /// Total cost in dollars
    pub total_cost: Option<f64>,
    /// Number of messages in the session
    pub message_count: u32,
}

/// The archive index file containing all entry metadata
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveIndex {
    pub entries: Vec<ArchiveEntry>,
    /// Version for future migrations
    #[serde(default)]
    pub version: u32,
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

impl ArchiveIndex {
    /// Get the archive directory path (separate for debug/release)
    pub fn archive_dir() -> PathBuf {
        #[cfg(debug_assertions)]
        let dirname = "archive-dev";
        #[cfg(not(debug_assertions))]
        let dirname = "archive";
        AppConfig::config_dir().join(dirname)
    }

    /// Get the sessions data directory path
    fn sessions_dir() -> PathBuf {
        Self::archive_dir().join("sessions")
    }

    /// Get the index file path
    fn index_path() -> PathBuf {
        Self::archive_dir().join("index.json")
    }

    /// Load the archive index from disk (returns empty index if not found)
    pub fn load() -> Self {
        let path = Self::index_path();
        if path.exists() {
            match fs::read_to_string(&path) {
                Ok(content) => match serde_json::from_str(&content) {
                    Ok(index) => return index,
                    Err(e) => eprintln!("[archive] Failed to parse index: {}", e),
                },
                Err(e) => eprintln!("[archive] Failed to read index: {}", e),
            }
        }
        Self::default()
    }

    /// Save the archive index to disk
    pub fn save(&self) -> Result<(), String> {
        let dir = Self::archive_dir();
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create archive dir: {}", e))?;

        let path = Self::index_path();
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize archive index: {}", e))?;

        fs::write(&path, &content).map_err(|e| format!("Failed to write archive index: {}", e))?;
        Ok(())
    }

    /// Save full session data to an individual file
    fn save_session_data(&self, id: &str, data: &impl Serialize) -> Result<(), String> {
        let dir = Self::sessions_dir();
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create sessions dir: {}", e))?;

        let path = dir.join(format!("{}.json", id));
        let content = serde_json::to_string_pretty(data)
            .map_err(|e| format!("Failed to serialize session data: {}", e))?;

        fs::write(&path, &content)
            .map_err(|e| format!("Failed to write session data: {}", e))?;
        Ok(())
    }

    /// Archive an SDK session: extract metadata and save full data
    pub fn archive_sdk_session(&mut self, session: &PersistedSdkSession) -> Result<(), String> {
        // Don't archive duplicates
        if self.entries.iter().any(|e| e.id == session.id) {
            return Ok(());
        }

        let entry = sdk_session_to_archive_entry(session);
        self.save_session_data(&session.id, session)?;
        self.entries.push(entry);
        Ok(())
    }

    /// Archive a terminal session: extract metadata and save full data
    pub fn archive_terminal_session(
        &mut self,
        session: &PersistedTerminalSession,
    ) -> Result<(), String> {
        // Don't archive duplicates
        if self.entries.iter().any(|e| e.id == session.id) {
            return Ok(());
        }

        let entry = terminal_session_to_archive_entry(session);
        self.save_session_data(&session.id, session)?;
        self.entries.push(entry);
        Ok(())
    }

    /// Archive a sequence execution with pre-built metadata entry
    pub fn archive_sequence_execution(
        &mut self,
        data: &serde_json::Value,
        entry: ArchiveEntry,
    ) -> Result<(), String> {
        // Don't archive duplicates
        if self.entries.iter().any(|e| e.id == entry.id) {
            return Ok(());
        }

        self.save_session_data(&entry.id, data)?;
        self.entries.push(entry);
        Ok(())
    }

    /// Load full session data from disk
    pub fn load_session_data(&self, id: &str) -> Result<serde_json::Value, String> {
        let path = Self::sessions_dir().join(format!("{}.json", id));
        if !path.exists() {
            return Err(format!("Archive session data not found: {}", id));
        }

        let content =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read session data: {}", e))?;

        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse session data: {}", e))
    }

    /// Search archive entries by query string and optional type filter
    /// Returns matching entries (paginated) and total count
    pub fn search(
        &self,
        query: &str,
        session_type: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> (Vec<ArchiveEntry>, usize) {
        let query_lower = query.to_lowercase();

        let filtered: Vec<&ArchiveEntry> = self
            .entries
            .iter()
            .filter(|e| {
                // Filter by session type if specified
                if let Some(st) = session_type {
                    if e.session_type != st {
                        return false;
                    }
                }

                // If query is empty, match all
                if query_lower.is_empty() {
                    return true;
                }

                // Case-insensitive search across multiple fields
                let matches_name = e
                    .name
                    .as_ref()
                    .map_or(false, |n| n.to_lowercase().contains(&query_lower));
                let matches_prompt = e
                    .prompt
                    .as_ref()
                    .map_or(false, |p| p.to_lowercase().contains(&query_lower));
                let matches_category = e
                    .category
                    .as_ref()
                    .map_or(false, |c| c.to_lowercase().contains(&query_lower));
                let matches_repo = e
                    .repo_path
                    .as_ref()
                    .map_or(false, |r| r.to_lowercase().contains(&query_lower));
                let matches_summary = e
                    .summary
                    .as_ref()
                    .map_or(false, |s| s.to_lowercase().contains(&query_lower));
                let matches_model = e
                    .model
                    .as_ref()
                    .map_or(false, |m| m.to_lowercase().contains(&query_lower));

                matches_name
                    || matches_prompt
                    || matches_category
                    || matches_repo
                    || matches_summary
                    || matches_model
            })
            .collect();

        let total_count = filtered.len();

        // Sort by archived_at descending (newest first)
        let mut sorted = filtered;
        sorted.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));

        // Apply pagination
        let paginated: Vec<ArchiveEntry> = sorted
            .into_iter()
            .skip(offset)
            .take(limit)
            .cloned()
            .collect();

        (paginated, total_count)
    }

    /// Trim archive to max size, removing oldest entries and their data files
    pub fn trim_to_max(&mut self, max_entries: usize) -> Result<(), String> {
        if self.entries.len() <= max_entries {
            return Ok(());
        }

        // Sort by archived_at descending (keep newest)
        self.entries.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));

        // Remove oldest entries beyond the limit
        let to_remove: Vec<String> = self
            .entries
            .split_off(max_entries)
            .into_iter()
            .map(|e| e.id)
            .collect();

        // Delete their data files
        let sessions_dir = Self::sessions_dir();
        for id in &to_remove {
            let path = sessions_dir.join(format!("{}.json", id));
            if path.exists() {
                if let Err(e) = fs::remove_file(&path) {
                    eprintln!("[archive] Failed to delete session file {}: {}", id, e);
                }
            }
        }

        Ok(())
    }

    /// Delete a single archived entry and its data file
    pub fn delete_entry(&mut self, id: &str) -> Result<(), String> {
        self.entries.retain(|e| e.id != id);

        let path = Self::sessions_dir().join(format!("{}.json", id));
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete session file: {}", e))?;
        }

        Ok(())
    }

    /// Clear the entire archive (all entries and data files)
    pub fn clear(&mut self) -> Result<(), String> {
        self.entries.clear();

        // Remove the sessions directory and all files within
        let sessions_dir = Self::sessions_dir();
        if sessions_dir.exists() {
            fs::remove_dir_all(&sessions_dir)
                .map_err(|e| format!("Failed to clear archive sessions: {}", e))?;
        }

        Ok(())
    }
}

/// Extract metadata from an SDK session for the archive index
fn sdk_session_to_archive_entry(session: &PersistedSdkSession) -> ArchiveEntry {
    let first_prompt = session
        .messages
        .iter()
        .find(|m| m.msg_type == "user")
        .and_then(|m| m.content.as_ref())
        .map(|c| {
            if c.len() > 200 {
                format!("{}...", &c[..200])
            } else {
                c.clone()
            }
        });

    let message_count = session.messages.len() as u32;

    ArchiveEntry {
        id: session.id.clone(),
        session_type: "sdk".to_string(),
        name: session
            .ai_metadata
            .as_ref()
            .and_then(|m| m.name.clone()),
        summary: session
            .ai_metadata
            .as_ref()
            .and_then(|m| m.summary.clone()),
        category: session
            .ai_metadata
            .as_ref()
            .and_then(|m| m.category.clone()),
        prompt: first_prompt,
        model: Some(session.model.clone()),
        repo_path: Some(session.cwd.clone()),
        status: session.status.clone(),
        created_at: session.created_at,
        archived_at: now_millis(),
        duration_ms: session.accumulated_duration_ms,
        total_cost: session.usage.as_ref().map(|u| u.total_cost_usd),
        message_count,
    }
}

/// Extract metadata from a terminal session for the archive index
fn terminal_session_to_archive_entry(session: &PersistedTerminalSession) -> ArchiveEntry {
    let prompt = if session.prompt.len() > 200 {
        Some(format!("{}...", &session.prompt[..200]))
    } else if session.prompt.is_empty() {
        None
    } else {
        Some(session.prompt.clone())
    };

    ArchiveEntry {
        id: session.id.clone(),
        session_type: "pty".to_string(),
        name: None,
        summary: None,
        category: None,
        prompt,
        model: None,
        repo_path: Some(session.repo_path.clone()),
        status: session.status.clone(),
        created_at: session.created_at,
        archived_at: now_millis(),
        duration_ms: 0,
        total_cost: None,
        message_count: 0,
    }
}
