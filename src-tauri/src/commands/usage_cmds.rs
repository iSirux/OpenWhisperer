use crate::config::UsageStats;
use parking_lot::Mutex;
use tauri::State;

pub type UsageStatsState = Mutex<UsageStats>;

/// Mutate the stats under the lock, then — outside the lock — persist a debounced
/// snapshot. This keeps the mutex from ever being held across a disk write (T7)
/// and rate-limits writes to at most one every `SAVE_DEBOUNCE_MS` (a final flush
/// happens on app shutdown). `mutate` runs while the guard is held.
fn track<F: FnOnce(&mut UsageStats)>(stats: &State<UsageStatsState>, mutate: F) -> Result<(), String> {
    let snapshot = {
        let mut s = stats.lock();
        mutate(&mut s);
        s.snapshot_if_due()
    };
    match snapshot {
        Some(snap) => snap.save(),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn get_usage_stats(stats: State<UsageStatsState>) -> UsageStats {
    stats.lock().clone()
}

#[tauri::command]
pub fn track_session(
    stats: State<UsageStatsState>,
    session_type: String,
    model: String,
    repo_path: Option<String>,
) -> Result<(), String> {
    track(&stats, |s| {
        s.track_session(&session_type, &model, repo_path.as_deref())
    })
}

#[tauri::command]
pub fn track_prompt(stats: State<UsageStatsState>, repo_path: Option<String>) -> Result<(), String> {
    track(&stats, |s| s.track_prompt(repo_path.as_deref()))
}

#[tauri::command]
pub fn track_tool_call(stats: State<UsageStatsState>, tool_name: String) -> Result<(), String> {
    track(&stats, |s| s.track_tool_call(&tool_name))
}

#[tauri::command]
pub fn track_recording(stats: State<UsageStatsState>, duration_ms: u64) -> Result<(), String> {
    track(&stats, |s| s.track_recording(duration_ms))
}

#[tauri::command]
pub fn track_transcription(stats: State<UsageStatsState>) -> Result<(), String> {
    track(&stats, |s| s.track_transcription())
}

#[tauri::command]
pub fn track_token_usage(
    stats: State<UsageStatsState>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    cost_usd: f64,
) -> Result<(), String> {
    track(&stats, |s| {
        s.track_token_usage(
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            cost_usd,
        )
    })
}

#[tauri::command]
pub fn track_llm_token_usage(
    stats: State<UsageStatsState>,
    feature: String,
    input_tokens: u64,
    output_tokens: u64,
) -> Result<(), String> {
    track(&stats, |s| {
        s.track_llm_token_usage(&feature, input_tokens, output_tokens)
    })
}

#[tauri::command]
pub fn reset_usage_stats(stats: State<UsageStatsState>) -> Result<(), String> {
    // Reset is an explicit user action — persist immediately (bypass debounce),
    // still saving after the guard is dropped.
    let snapshot = {
        let mut s = stats.lock();
        s.reset();
        s.snapshot_now()
    };
    snapshot.save()
}
