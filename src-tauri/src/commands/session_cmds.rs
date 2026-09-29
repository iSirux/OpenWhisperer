use crate::session_persistence::{
    PersistedSdkSession, PersistedSessions, SdkSessionDelta, SessionCache, SessionIndex,
};
use serde::Serialize;
use std::sync::Mutex;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSessionsResult {
    pub overflow_sdk_sessions: Vec<PersistedSdkSession>,
    /// Ids sent as unchanged that the index doesn't hold — the frontend must
    /// resend them in full.
    pub missing_sdk_session_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertSessionsResult {
    /// Ids of deltas that couldn't be applied (no persisted base, or it doesn't
    /// hold the message count the delta was computed against) — the frontend
    /// must resend them in full.
    pub needs_full_sdk_session_ids: Vec<String>,
}

/// Serializes every session-index read-modify-write. These commands are async so a
/// save (session payloads can run to megabytes) never blocks the main thread, which
/// means two could otherwise run at once and interleave their index load/save.
/// The lock also owns the parsed-session cache the delta autosave applies against.
static SESSION_IO: Mutex<SessionCache> = Mutex::new(SessionCache::new());

/// Run session persistence work on the blocking pool, one operation at a time.
async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce(&mut SessionCache) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cache = SESSION_IO.lock().unwrap_or_else(|e| e.into_inner());
        work(&mut cache)
    })
    .await
    .map_err(|e| format!("Session persistence task failed: {}", e))?
}

#[tauri::command]
pub async fn get_persisted_sessions() -> Result<PersistedSessions, String> {
    run_blocking(|cache| {
        // A (re)load starts the frontend's persisted-state tracking from scratch,
        // and may rewrite files (image shrink) — start the cache over with it.
        cache.clear();
        let mut index = SessionIndex::load();
        Ok(index.load_all_sessions())
    })
    .await
}

#[tauri::command]
pub async fn save_persisted_sessions(
    sessions: PersistedSessions,
    max_sessions: usize,
    unchanged_sdk_session_ids: Option<Vec<String>>,
) -> Result<SaveSessionsResult, String> {
    run_blocking(move |cache| {
        let mut sessions = sessions;
        sessions.saved_at = crate::util::now_secs();

        let mut index = SessionIndex::load();

        // Write changed sessions to their files and rebuild the index
        let missing_sdk_session_ids = index.save_from_bulk(
            sessions,
            unchanged_sdk_session_ids.as_deref().unwrap_or(&[]),
            cache,
        )?;

        // Handle overflow: extract sessions beyond max, load their data, delete their files
        let overflow_sdk = index.separate_overflow(max_sessions, cache);

        // Save index again after overflow removal
        if !overflow_sdk.is_empty() {
            index.save()?;
        }

        Ok(SaveSessionsResult {
            overflow_sdk_sessions: overflow_sdk,
            missing_sdk_session_ids,
        })
    })
    .await
}

/// Partial autosave: upsert only the given SDK sessions (the hot path during a
/// live query). `sessions` are sent in full; `deltas` carry just the messages
/// changed since each session was last persisted (see `SdkSessionDelta`).
/// Rewrites only the data files whose content changed and the index; does not
/// delete stale files or enforce overflow — that stays with the full
/// `save_persisted_sessions` path.
#[tauri::command]
pub async fn upsert_persisted_sdk_sessions(
    sessions: Vec<PersistedSdkSession>,
    deltas: Option<Vec<SdkSessionDelta>>,
    active_sdk_session_id: Option<String>,
) -> Result<UpsertSessionsResult, String> {
    run_blocking(move |cache| {
        let mut index = SessionIndex::load();
        let needs_full_sdk_session_ids = index.upsert_sdk_sessions(
            sessions,
            deltas.unwrap_or_default(),
            active_sdk_session_id,
            cache,
        )?;
        Ok(UpsertSessionsResult {
            needs_full_sdk_session_ids,
        })
    })
    .await
}

#[tauri::command]
pub async fn clear_persisted_sessions() -> Result<(), String> {
    run_blocking(|cache| {
        cache.clear();
        let mut index = SessionIndex::load();
        index.clear()
    })
    .await
}
