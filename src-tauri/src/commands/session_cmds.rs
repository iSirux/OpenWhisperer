use crate::session_persistence::{
    PersistedSdkSession, PersistedSessions, PersistedTerminalSession, SessionIndex,
};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSessionsResult {
    pub overflow_sdk_sessions: Vec<PersistedSdkSession>,
    pub overflow_terminal_sessions: Vec<PersistedTerminalSession>,
}

#[tauri::command]
pub fn get_persisted_sessions() -> PersistedSessions {
    let mut index = SessionIndex::load();
    index.load_all_sessions()
}

#[tauri::command]
pub fn save_persisted_sessions(
    sessions: PersistedSessions,
    max_sessions: usize,
) -> Result<SaveSessionsResult, String> {
    let mut sessions = sessions;
    sessions.saved_at = crate::util::now_secs();

    let mut index = SessionIndex::load();

    // Write all sessions to individual files and rebuild index
    index.save_from_bulk(&sessions)?;

    // Handle overflow: extract sessions beyond max, load their data, delete their files
    let (overflow_sdk, overflow_terminal) = index.separate_overflow(max_sessions);

    // Save index again after overflow removal
    if !overflow_sdk.is_empty() || !overflow_terminal.is_empty() {
        index.save()?;
    }

    Ok(SaveSessionsResult {
        overflow_sdk_sessions: overflow_sdk,
        overflow_terminal_sessions: overflow_terminal,
    })
}

/// Partial autosave: upsert only the given SDK sessions (the hot path during a
/// live query). Rewrites only the data files whose content changed and the
/// index; does not delete stale files or enforce overflow — that stays with the
/// full `save_persisted_sessions` path.
#[tauri::command]
pub fn upsert_persisted_sdk_sessions(
    sessions: Vec<PersistedSdkSession>,
    active_sdk_session_id: Option<String>,
) -> Result<(), String> {
    let mut index = SessionIndex::load();
    index.upsert_sdk_sessions(&sessions, active_sdk_session_id)
}

#[tauri::command]
pub fn clear_persisted_sessions() -> Result<(), String> {
    let mut index = SessionIndex::load();
    index.clear()
}
