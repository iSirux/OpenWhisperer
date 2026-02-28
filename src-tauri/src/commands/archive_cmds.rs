use crate::archive::{ArchiveEntry, ArchiveIndex};
use crate::session_persistence::{PersistedSdkSession, PersistedTerminalSession};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveSearchResult {
    pub entries: Vec<ArchiveEntry>,
    pub total_count: usize,
}

#[tauri::command]
pub fn get_archive_entries(
    query: Option<String>,
    session_type: Option<String>,
    repo_path: Option<String>,
    offset: usize,
    limit: usize,
) -> Result<ArchiveSearchResult, String> {
    let index = ArchiveIndex::load();
    let (entries, total_count) = index.search(
        query.as_deref().unwrap_or(""),
        session_type.as_deref(),
        repo_path.as_deref(),
        offset,
        limit,
    );
    Ok(ArchiveSearchResult {
        entries,
        total_count,
    })
}

#[tauri::command]
pub fn get_archive_entry_data(id: String) -> Result<serde_json::Value, String> {
    let index = ArchiveIndex::load();
    index.load_session_data(&id)
}

#[tauri::command]
pub fn archive_sdk_session(session: PersistedSdkSession) -> Result<(), String> {
    let mut index = ArchiveIndex::load();
    index.archive_sdk_session(&session)?;
    index.save()
}

#[tauri::command]
pub fn archive_terminal_session(session: PersistedTerminalSession) -> Result<(), String> {
    let mut index = ArchiveIndex::load();
    index.archive_terminal_session(&session)?;
    index.save()
}

#[tauri::command]
pub fn archive_sequence_execution(
    execution_data: serde_json::Value,
    entry: ArchiveEntry,
) -> Result<(), String> {
    let mut index = ArchiveIndex::load();
    index.archive_sequence_execution(&execution_data, entry)?;
    index.save()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnarchiveResult {
    pub session_data: serde_json::Value,
    pub session_type: String,
}

#[tauri::command]
pub fn unarchive_entry(id: String) -> Result<UnarchiveResult, String> {
    let mut index = ArchiveIndex::load();
    let (session_data, session_type) = index.unarchive_entry(&id)?;
    index.save()?;
    Ok(UnarchiveResult {
        session_data,
        session_type,
    })
}

#[tauri::command]
pub fn delete_archive_entry(id: String) -> Result<(), String> {
    let mut index = ArchiveIndex::load();
    index.delete_entry(&id)?;
    index.save()
}

#[tauri::command]
pub fn clear_archive() -> Result<(), String> {
    let mut index = ArchiveIndex::load();
    index.clear()?;
    index.save()
}

#[tauri::command]
pub fn trim_archive(max_entries: usize) -> Result<(), String> {
    let mut index = ArchiveIndex::load();
    index.trim_to_max(max_entries)?;
    index.save()
}

#[tauri::command]
pub fn get_archive_count() -> usize {
    let index = ArchiveIndex::load();
    index.entries.len()
}
