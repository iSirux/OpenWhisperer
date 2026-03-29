use crate::config::UsageStats;
use parking_lot::Mutex;
use tauri::State;

pub type UsageStatsState = Mutex<UsageStats>;

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
    let mut s = stats.lock();
    s.track_session(&session_type, &model, repo_path.as_deref());
    s.save()
}

#[tauri::command]
pub fn track_prompt(
    stats: State<UsageStatsState>,
    repo_path: Option<String>,
) -> Result<(), String> {
    let mut s = stats.lock();
    s.track_prompt(repo_path.as_deref());
    s.save()
}

#[tauri::command]
pub fn track_tool_call(stats: State<UsageStatsState>, tool_name: String) -> Result<(), String> {
    let mut s = stats.lock();
    s.track_tool_call(&tool_name);
    s.save()
}

#[tauri::command]
pub fn track_recording(stats: State<UsageStatsState>, duration_ms: u64) -> Result<(), String> {
    let mut s = stats.lock();
    s.track_recording(duration_ms);
    s.save()
}

#[tauri::command]
pub fn track_transcription(stats: State<UsageStatsState>) -> Result<(), String> {
    let mut s = stats.lock();
    s.track_transcription();
    s.save()
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
    let mut s = stats.lock();
    s.track_token_usage(
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        cost_usd,
    );
    s.save()
}

#[tauri::command]
pub fn track_llm_token_usage(
    stats: State<UsageStatsState>,
    feature: String,
    input_tokens: u64,
    output_tokens: u64,
) -> Result<(), String> {
    let mut s = stats.lock();
    s.track_llm_token_usage(&feature, input_tokens, output_tokens);
    s.save()
}

#[tauri::command]
pub fn reset_usage_stats(stats: State<UsageStatsState>) -> Result<(), String> {
    let mut s = stats.lock();
    s.reset();
    s.save()
}
