use crate::session_persistence::{PersistedSdkSession, PersistedSessions, PersistedTerminalSession};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSessionsResult {
    pub overflow_sdk_sessions: Vec<PersistedSdkSession>,
    pub overflow_terminal_sessions: Vec<PersistedTerminalSession>,
}

#[tauri::command]
pub fn get_persisted_sessions() -> PersistedSessions {
    PersistedSessions::load()
}

#[tauri::command]
pub fn save_persisted_sessions(
    sessions: PersistedSessions,
    max_sessions: usize,
) -> Result<SaveSessionsResult, String> {
    let mut sessions = sessions;
    let (overflow_sdk, overflow_terminal) = sessions.separate_overflow(max_sessions);
    sessions.saved_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    sessions.save()?;
    Ok(SaveSessionsResult {
        overflow_sdk_sessions: overflow_sdk,
        overflow_terminal_sessions: overflow_terminal,
    })
}

#[tauri::command]
pub fn clear_persisted_sessions() -> Result<(), String> {
    let sessions = PersistedSessions::default();
    sessions.save()
}
