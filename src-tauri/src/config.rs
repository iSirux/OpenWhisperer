use serde::{Deserialize, Deserializer, Serialize};
use std::fs;
use std::path::PathBuf;

/// Provider type for Whisper-compatible APIs
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum WhisperProvider {
    #[default]
    Local,
    OpenAI,
    Groq,
    Custom,
}

/// Docker compute type for local Whisper server
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum DockerComputeType {
    #[default]
    CPU,
    GPU,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerConfig {
    /// Whether to use GPU (CUDA) or CPU
    #[serde(default)]
    pub compute_type: DockerComputeType,
    /// Start container automatically when Docker daemon starts
    #[serde(default)]
    pub auto_restart: bool,
    /// Custom container name
    #[serde(default = "default_container_name")]
    pub container_name: String,
}

fn default_container_name() -> String {
    "whisper".to_string()
}

impl Default for DockerConfig {
    fn default() -> Self {
        Self {
            compute_type: DockerComputeType::default(),
            auto_restart: false,
            container_name: default_container_name(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperConfig {
    #[serde(default)]
    pub provider: WhisperProvider,
    pub endpoint: String,
    pub model: String,
    pub language: String,
    /// Optional API key for authenticated endpoints (OpenAI, Groq, etc.)
    #[serde(default)]
    pub api_key: Option<String>,
    /// Docker configuration for local Whisper server
    #[serde(default)]
    pub docker: DockerConfig,
}

impl Default for WhisperConfig {
    fn default() -> Self {
        Self {
            provider: WhisperProvider::default(),
            endpoint: "http://localhost:8000/v1/audio/transcriptions".to_string(),
            model: "Systran/faster-whisper-large-v3-turbo".to_string(),
            language: "en".to_string(),
            api_key: None,
            docker: DockerConfig::default(),
        }
    }
}

/// Configuration for Vosk real-time transcription
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoskConfig {
    /// Whether Vosk real-time transcription is enabled
    #[serde(default)]
    pub enabled: bool,
    /// WebSocket endpoint for Vosk server
    #[serde(default = "default_vosk_endpoint")]
    pub endpoint: String,
    /// Audio sample rate (default: 16000)
    #[serde(default = "default_vosk_sample_rate")]
    pub sample_rate: u32,
    /// Docker configuration for Vosk server
    #[serde(default = "default_vosk_docker")]
    pub docker: DockerConfig,
    /// Whether to show real-time transcript in overlay
    #[serde(default = "default_show_realtime_transcript")]
    pub show_realtime_transcript: bool,
    /// Whether to accumulate transcript text across pauses (vs reset on each pause)
    #[serde(default)]
    pub accumulate_transcript: bool,
}

fn default_vosk_endpoint() -> String {
    "ws://localhost:2700".to_string()
}

fn default_vosk_sample_rate() -> u32 {
    16000
}

fn default_vosk_container_name() -> String {
    "claude-whisperer-vosk".to_string()
}

fn default_vosk_docker() -> DockerConfig {
    DockerConfig {
        compute_type: DockerComputeType::CPU,
        auto_restart: false,
        container_name: default_vosk_container_name(),
    }
}

fn default_show_realtime_transcript() -> bool {
    true
}

impl Default for VoskConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: default_vosk_endpoint(),
            sample_rate: default_vosk_sample_rate(),
            docker: default_vosk_docker(),
            show_realtime_transcript: true,
            accumulate_transcript: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitConfig {
    pub create_branch: bool,
    pub auto_merge: bool,
    pub create_pr: bool,
    pub use_worktrees: bool,
}

impl Default for GitConfig {
    fn default() -> Self {
        Self {
            create_branch: false,
            auto_merge: false,
            create_pr: false,
            use_worktrees: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeyConfig {
    pub toggle_recording: String,
    #[serde(default = "default_transcribe_to_input")]
    pub transcribe_to_input: String,
    #[serde(default = "default_cycle_repo", alias = "switch_repo")]
    pub cycle_repo: String,
    #[serde(default = "default_cycle_model", alias = "toggle_model")]
    pub cycle_model: String,
    /// Hotkey to start recording in note-taking mode
    #[serde(default = "default_note_mode")]
    pub note_mode: String,
    /// Hotkey to copy selected text and immediately send as a new prompt
    #[serde(default = "default_send_selection")]
    pub send_selection: String,
    /// Hotkey to copy selected text and create a prepared session for review
    #[serde(default = "default_prepare_selection")]
    pub prepare_selection: String,
}

fn default_transcribe_to_input() -> String {
    "CommandOrControl+Shift+T".to_string()
}

fn default_cycle_repo() -> String {
    "CommandOrControl+Shift+R".to_string()
}

fn default_cycle_model() -> String {
    "CommandOrControl+Shift+M".to_string()
}

fn default_note_mode() -> String {
    "CommandOrControl+Shift+N".to_string()
}

fn default_send_selection() -> String {
    "CommandOrControl+Shift+E".to_string()
}

fn default_prepare_selection() -> String {
    "CommandOrControl+Shift+J".to_string()
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            toggle_recording: "CommandOrControl+Shift+Space".to_string(),
            transcribe_to_input: "CommandOrControl+Shift+T".to_string(),
            cycle_repo: "CommandOrControl+Shift+R".to_string(),
            cycle_model: "CommandOrControl+Shift+M".to_string(),
            note_mode: default_note_mode(),
            send_selection: default_send_selection(),
            prepare_selection: default_prepare_selection(),
        }
    }
}

fn default_hotkey_enabled() -> bool {
    true
}

/// Per-hotkey enabled/disabled state. Allows users to temporarily deactivate
/// a hotkey without clearing its key binding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeyEnabledConfig {
    #[serde(default = "default_hotkey_enabled")]
    pub toggle_recording: bool,
    #[serde(default = "default_hotkey_enabled")]
    pub transcribe_to_input: bool,
    #[serde(default = "default_hotkey_enabled")]
    pub cycle_repo: bool,
    #[serde(default = "default_hotkey_enabled")]
    pub cycle_model: bool,
    #[serde(default)]
    pub note_mode: bool,
    #[serde(default = "default_hotkey_enabled")]
    pub send_selection: bool,
    #[serde(default = "default_hotkey_enabled")]
    pub prepare_selection: bool,
}

impl Default for HotkeyEnabledConfig {
    fn default() -> Self {
        Self {
            toggle_recording: true,
            transcribe_to_input: true,
            cycle_repo: true,
            cycle_model: true,
            note_mode: false,
            send_selection: true,
            prepare_selection: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlayConfig {
    #[serde(default = "default_show_when_focused")]
    pub show_when_focused: bool,
    #[serde(default)]
    pub position_x: Option<i32>,
    #[serde(default)]
    pub position_y: Option<i32>,
    #[serde(default = "default_show_active_sessions")]
    pub show_active_sessions: bool,
}

fn default_show_when_focused() -> bool {
    true
}

fn default_show_active_sessions() -> bool {
    true
}

impl Default for OverlayConfig {
    fn default() -> Self {
        Self {
            show_when_focused: true,
            position_x: None,
            position_y: None,
            show_active_sessions: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemConfig {
    pub minimize_to_tray: bool,
    pub start_minimized: bool,
    pub autostart: bool,
}

impl Default for SystemConfig {
    fn default() -> Self {
        Self {
            minimize_to_tray: false,
            start_minimized: false,
            autostart: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionPersistenceConfig {
    pub enabled: bool,
    pub max_sessions: usize,
    #[serde(default = "default_restore_sessions")]
    pub restore_sessions: usize,
    #[serde(default = "default_max_archived_sessions")]
    pub max_archived_sessions: usize,
}

fn default_restore_sessions() -> usize {
    10
}

fn default_max_archived_sessions() -> usize {
    500
}

impl Default for SessionPersistenceConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_sessions: 50,
            restore_sessions: 10,
            max_archived_sessions: 500,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SessionStats {
    pub total_sessions: u64,
    pub total_pty_sessions: u64,
    pub total_sdk_sessions: u64,
    pub total_prompts: u64,
    pub total_tool_calls: u64,
    pub total_recordings: u64,
    pub total_recording_duration_ms: u64,
    pub total_transcriptions: u64,
    pub first_session_at: Option<u64>,
    pub last_session_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TokenStats {
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_cache_creation_tokens: u64,
    pub total_cost_usd: f64,
}

/// Token usage stats for the LLM integration layer (Gemini/OpenAI/Groq/Local)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LlmTokenStats {
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_requests: u64,
    /// Breakdown by feature (requests + input/output tokens)
    pub session_naming_requests: u64,
    pub session_naming_input_tokens: u64,
    pub session_naming_output_tokens: u64,
    pub session_outcome_requests: u64,
    pub session_outcome_input_tokens: u64,
    pub session_outcome_output_tokens: u64,
    pub interaction_analysis_requests: u64,
    pub interaction_analysis_input_tokens: u64,
    pub interaction_analysis_output_tokens: u64,
    pub transcription_cleanup_requests: u64,
    pub transcription_cleanup_input_tokens: u64,
    pub transcription_cleanup_output_tokens: u64,
    pub model_recommendation_requests: u64,
    pub model_recommendation_input_tokens: u64,
    pub model_recommendation_output_tokens: u64,
    pub repo_description_requests: u64,
    pub repo_description_input_tokens: u64,
    pub repo_description_output_tokens: u64,
    pub repo_recommendation_requests: u64,
    pub repo_recommendation_input_tokens: u64,
    pub repo_recommendation_output_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelUsageStats {
    pub opus_sessions: u64,
    pub sonnet_sessions: u64,
    pub haiku_sessions: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RepoUsageStats {
    pub repo_path: String,
    pub session_count: u64,
    pub prompt_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DailyStats {
    pub date: String, // YYYY-MM-DD format
    pub sessions: u64,
    pub prompts: u64,
    pub recordings: u64,
    pub tool_calls: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageStats {
    pub session_stats: SessionStats,
    #[serde(default)]
    pub token_stats: TokenStats,
    /// Token usage stats for the LLM integration layer (Gemini/OpenAI/etc.)
    #[serde(default)]
    pub llm_token_stats: LlmTokenStats,
    pub model_usage: ModelUsageStats,
    pub repo_usage: Vec<RepoUsageStats>,
    pub daily_stats: Vec<DailyStats>,
    pub streak_days: u32,
    pub longest_streak: u32,
    pub average_session_duration_ms: u64,
    pub average_prompts_per_session: f64,
    pub most_used_tools: Vec<(String, u64)>,
}

impl Default for UsageStats {
    fn default() -> Self {
        Self {
            session_stats: SessionStats::default(),
            token_stats: TokenStats::default(),
            llm_token_stats: LlmTokenStats::default(),
            model_usage: ModelUsageStats::default(),
            repo_usage: Vec::new(),
            daily_stats: Vec::new(),
            streak_days: 0,
            longest_streak: 0,
            average_session_duration_ms: 0,
            average_prompts_per_session: 0.0,
            most_used_tools: Vec::new(),
        }
    }
}

impl UsageStats {
    pub fn stats_path() -> PathBuf {
        // Use separate stats file for debug builds to avoid conflicts
        #[cfg(debug_assertions)]
        let filename = "usage_stats.dev.json";
        #[cfg(not(debug_assertions))]
        let filename = "usage_stats.json";

        AppConfig::config_dir().join(filename)
    }

    pub fn load() -> Self {
        let path = Self::stats_path();
        if path.exists() {
            match fs::read_to_string(&path) {
                Ok(content) => match serde_json::from_str(&content) {
                    Ok(stats) => return stats,
                    Err(e) => eprintln!("Failed to parse usage stats: {}", e),
                },
                Err(e) => eprintln!("Failed to read usage stats: {}", e),
            }
        }
        Self::default()
    }

    pub fn save(&self) -> Result<(), String> {
        let dir = AppConfig::config_dir();
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;

        let path = Self::stats_path();
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize usage stats: {}", e))?;

        fs::write(&path, &content).map_err(|e| format!("Failed to write usage stats: {}", e))?;
        Ok(())
    }

    fn get_today() -> String {
        chrono::Local::now().format("%Y-%m-%d").to_string()
    }

    fn ensure_today_stats(&mut self) {
        let today = Self::get_today();
        if self.daily_stats.last().map(|d| &d.date) != Some(&today) {
            self.daily_stats.push(DailyStats {
                date: today,
                sessions: 0,
                prompts: 0,
                recordings: 0,
                tool_calls: 0,
            });
            // Keep only last 90 days
            if self.daily_stats.len() > 90 {
                self.daily_stats.remove(0);
            }
        }
    }

    pub fn track_session(&mut self, session_type: &str, model: &str, repo_path: Option<&str>) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        self.session_stats.total_sessions += 1;

        if session_type == "pty" {
            self.session_stats.total_pty_sessions += 1;
        } else if session_type == "sdk" {
            self.session_stats.total_sdk_sessions += 1;
        }

        if self.session_stats.first_session_at.is_none() {
            self.session_stats.first_session_at = Some(now);
        }
        self.session_stats.last_session_at = Some(now);

        // Track model usage
        let model_lower = model.to_lowercase();
        if model_lower.contains("opus") {
            self.model_usage.opus_sessions += 1;
        } else if model_lower.contains("sonnet") {
            self.model_usage.sonnet_sessions += 1;
        } else if model_lower.contains("haiku") {
            self.model_usage.haiku_sessions += 1;
        }

        // Track repo usage
        if let Some(path) = repo_path {
            if let Some(repo_stats) = self.repo_usage.iter_mut().find(|r| r.repo_path == path) {
                repo_stats.session_count += 1;
            } else {
                self.repo_usage.push(RepoUsageStats {
                    repo_path: path.to_string(),
                    session_count: 1,
                    prompt_count: 0,
                });
            }
        }

        // Update daily stats
        self.ensure_today_stats();
        if let Some(today) = self.daily_stats.last_mut() {
            today.sessions += 1;
        }

        // Update streak
        self.update_streak();
    }

    pub fn track_prompt(&mut self, repo_path: Option<&str>) {
        self.session_stats.total_prompts += 1;

        if let Some(path) = repo_path {
            if let Some(repo_stats) = self.repo_usage.iter_mut().find(|r| r.repo_path == path) {
                repo_stats.prompt_count += 1;
            }
        }

        self.ensure_today_stats();
        if let Some(today) = self.daily_stats.last_mut() {
            today.prompts += 1;
        }
    }

    pub fn track_tool_call(&mut self, tool_name: &str) {
        self.session_stats.total_tool_calls += 1;

        // Update most used tools
        if let Some(tool) = self.most_used_tools.iter_mut().find(|(name, _)| name == tool_name) {
            tool.1 += 1;
        } else {
            self.most_used_tools.push((tool_name.to_string(), 1));
        }

        // Sort by count and keep top 20
        self.most_used_tools.sort_by(|a, b| b.1.cmp(&a.1));
        self.most_used_tools.truncate(20);

        self.ensure_today_stats();
        if let Some(today) = self.daily_stats.last_mut() {
            today.tool_calls += 1;
        }
    }

    pub fn track_recording(&mut self, duration_ms: u64) {
        self.session_stats.total_recordings += 1;
        self.session_stats.total_recording_duration_ms += duration_ms;

        self.ensure_today_stats();
        if let Some(today) = self.daily_stats.last_mut() {
            today.recordings += 1;
        }
    }

    pub fn track_transcription(&mut self) {
        self.session_stats.total_transcriptions += 1;
    }

    pub fn track_token_usage(
        &mut self,
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        cache_creation_tokens: u64,
        cost_usd: f64,
    ) {
        self.token_stats.total_input_tokens += input_tokens;
        self.token_stats.total_output_tokens += output_tokens;
        self.token_stats.total_cache_read_tokens += cache_read_tokens;
        self.token_stats.total_cache_creation_tokens += cache_creation_tokens;
        self.token_stats.total_cost_usd += cost_usd;
    }

    /// Track token usage from the LLM integration layer (Gemini/OpenAI/Groq/Local)
    pub fn track_llm_token_usage(
        &mut self,
        feature: &str,
        input_tokens: u64,
        output_tokens: u64,
    ) {
        // Update totals
        self.llm_token_stats.total_input_tokens += input_tokens;
        self.llm_token_stats.total_output_tokens += output_tokens;
        self.llm_token_stats.total_requests += 1;

        // Update per-feature stats (input/output separately)
        match feature {
            "session_naming" => {
                self.llm_token_stats.session_naming_requests += 1;
                self.llm_token_stats.session_naming_input_tokens += input_tokens;
                self.llm_token_stats.session_naming_output_tokens += output_tokens;
            }
            "session_outcome" => {
                self.llm_token_stats.session_outcome_requests += 1;
                self.llm_token_stats.session_outcome_input_tokens += input_tokens;
                self.llm_token_stats.session_outcome_output_tokens += output_tokens;
            }
            "interaction_analysis" => {
                self.llm_token_stats.interaction_analysis_requests += 1;
                self.llm_token_stats.interaction_analysis_input_tokens += input_tokens;
                self.llm_token_stats.interaction_analysis_output_tokens += output_tokens;
            }
            "transcription_cleanup" => {
                self.llm_token_stats.transcription_cleanup_requests += 1;
                self.llm_token_stats.transcription_cleanup_input_tokens += input_tokens;
                self.llm_token_stats.transcription_cleanup_output_tokens += output_tokens;
            }
            "model_recommendation" => {
                self.llm_token_stats.model_recommendation_requests += 1;
                self.llm_token_stats.model_recommendation_input_tokens += input_tokens;
                self.llm_token_stats.model_recommendation_output_tokens += output_tokens;
            }
            "repo_description" => {
                self.llm_token_stats.repo_description_requests += 1;
                self.llm_token_stats.repo_description_input_tokens += input_tokens;
                self.llm_token_stats.repo_description_output_tokens += output_tokens;
            }
            "repo_recommendation" => {
                self.llm_token_stats.repo_recommendation_requests += 1;
                self.llm_token_stats.repo_recommendation_input_tokens += input_tokens;
                self.llm_token_stats.repo_recommendation_output_tokens += output_tokens;
            }
            _ => {}
        }
    }

    fn update_streak(&mut self) {
        let today = Self::get_today();
        let yesterday = (chrono::Local::now() - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();

        // Check if we already have an entry for today
        let has_today = self.daily_stats.iter().any(|d| d.date == today && d.sessions > 0);
        let had_yesterday = self.daily_stats.iter().any(|d| d.date == yesterday && d.sessions > 0);

        if has_today {
            if had_yesterday {
                // Continue streak - but don't double-count if we already incremented today
                // The streak is counted by looking back at consecutive days
            }

            // Calculate actual streak from daily_stats
            let mut streak = 0u32;
            let mut check_date = chrono::Local::now().date_naive();

            for day_stats in self.daily_stats.iter().rev() {
                let expected_date = check_date.format("%Y-%m-%d").to_string();
                if day_stats.date == expected_date && day_stats.sessions > 0 {
                    streak += 1;
                    check_date -= chrono::Duration::days(1);
                } else if day_stats.date != expected_date {
                    // Skip if dates don't match (gap in data)
                    break;
                }
            }

            self.streak_days = streak;
            if streak > self.longest_streak {
                self.longest_streak = streak;
            }
        }
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// Voice command configuration for triggering prompt send
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceCommandConfig {
    /// Whether voice commands are enabled
    #[serde(default)]
    pub enabled: bool,
    /// List of active voice commands that will trigger send
    #[serde(default = "default_voice_commands")]
    pub active_commands: Vec<String>,
    /// List of active voice commands that will trigger transcribe-to-input
    #[serde(default)]
    pub transcribe_commands: Vec<String>,
    /// List of active voice commands that will cancel/discard the recording
    #[serde(default)]
    pub cancel_commands: Vec<String>,
    /// List of voice commands that will trigger note-taking mode
    #[serde(default = "default_note_commands")]
    pub note_commands: Vec<String>,
    /// List of voice commands that will trigger running a sequence (e.g., "run sequence")
    #[serde(default = "default_sequence_commands")]
    pub sequence_commands: Vec<String>,
    /// List of voice commands that will approve a pending approval node
    #[serde(default = "default_approve_commands")]
    pub approve_commands: Vec<String>,
    /// List of voice commands that will reject a pending approval node
    #[serde(default = "default_reject_commands")]
    pub reject_commands: Vec<String>,
    /// List of voice commands that will prepare a session without starting it
    #[serde(default = "default_prepare_commands")]
    pub prepare_commands: Vec<String>,
}

fn default_voice_commands() -> Vec<String> {
    vec!["go go".to_string()]
}

fn default_note_commands() -> Vec<String> {
    vec!["take a note".to_string(), "new note".to_string()]
}

fn default_sequence_commands() -> Vec<String> {
    vec!["run sequence".to_string()]
}

fn default_approve_commands() -> Vec<String> {
    vec!["approve".to_string()]
}

fn default_reject_commands() -> Vec<String> {
    vec!["reject".to_string()]
}

fn default_prepare_commands() -> Vec<String> {
    vec!["go prepare".to_string(), "prep it".to_string()]
}

impl Default for VoiceCommandConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            active_commands: default_voice_commands(),
            transcribe_commands: Vec::new(),
            cancel_commands: Vec::new(),
            note_commands: default_note_commands(),
            sequence_commands: default_sequence_commands(),
            approve_commands: default_approve_commands(),
            reject_commands: default_reject_commands(),
            prepare_commands: default_prepare_commands(),
        }
    }
}

/// Open mic configuration for passive voice listening
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenMicConfig {
    /// Whether open mic mode is enabled
    #[serde(default)]
    pub enabled: bool,
    /// List of active wake commands that will trigger recording
    #[serde(default = "default_wake_commands")]
    pub wake_commands: Vec<String>,
    /// Minimum volume threshold (0.0-1.0) to send audio to Vosk (saves resources when silent)
    #[serde(default = "default_volume_threshold")]
    pub volume_threshold: f32,
}

fn default_volume_threshold() -> f32 {
    0.01 // 1% - very low default to catch most speech
}

fn default_wake_commands() -> Vec<String> {
    vec!["hey claude".to_string()]
}

impl Default for OpenMicConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            wake_commands: default_wake_commands(),
            volume_threshold: default_volume_threshold(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioConfig {
    pub device_id: Option<String>,
    pub use_hotkey: bool,
    #[serde(default)]
    pub play_sound_on_completion: bool,
    #[serde(default = "default_play_sound_on_repo_select")]
    pub play_sound_on_repo_select: bool,
    /// Play sound when open mic wake command is detected and recording starts
    #[serde(default = "default_play_sound_on_open_mic_trigger")]
    pub play_sound_on_open_mic_trigger: bool,
    /// Play sound when a voice command (like "send it") is detected
    #[serde(default = "default_play_sound_on_voice_command")]
    pub play_sound_on_voice_command: bool,
    #[serde(default = "default_recording_linger_ms")]
    pub recording_linger_ms: u32,
    #[serde(default = "default_include_transcription_notice")]
    pub include_transcription_notice: bool,
    #[serde(default)]
    pub require_transcription_approval: bool,
    /// Voice command configuration for triggering prompt send
    #[serde(default)]
    pub voice_commands: VoiceCommandConfig,
    /// Open mic configuration for passive voice listening
    #[serde(default)]
    pub open_mic: OpenMicConfig,
}

fn default_recording_linger_ms() -> u32 {
    500
}

fn default_play_sound_on_repo_select() -> bool {
    true
}

fn default_play_sound_on_open_mic_trigger() -> bool {
    true
}

fn default_play_sound_on_voice_command() -> bool {
    true
}

fn default_include_transcription_notice() -> bool {
    true
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            device_id: None,
            use_hotkey: true,
            play_sound_on_completion: false,
            play_sound_on_repo_select: true,
            play_sound_on_open_mic_trigger: true,
            play_sound_on_voice_command: true,
            recording_linger_ms: 500,
            include_transcription_notice: true,
            require_transcription_approval: false,
            voice_commands: VoiceCommandConfig::default(),
            open_mic: OpenMicConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoConfig {
    pub path: String,
    pub name: String,
    /// Auto-generated description of the repository for auto-selection
    #[serde(default)]
    pub description: Option<String>,
    /// Domain-specific keywords for matching prompts to this repository (around 20 keywords)
    #[serde(default)]
    pub keywords: Option<Vec<String>>,
    /// Project-specific vocabulary/lingo for transcription cleanup and repo matching (20-50 words)
    /// Unlike keywords which are categorical, vocabulary captures the actual terms/jargon used in the codebase
    #[serde(default)]
    pub vocabulary: Option<Vec<String>>,
    /// Icon key from the curated icon set (e.g., "globe", "terminal", "database")
    #[serde(default)]
    pub icon: Option<String>,
    /// Primary/brand color as hex string (e.g., "#6366f1")
    #[serde(default)]
    pub color: Option<String>,
    /// List of MCP server IDs to use for this repository (overrides global servers)
    #[serde(default)]
    pub mcp_servers: Option<Vec<String>>,
    /// List of MCP server IDs to use for note-taking mode in this repository
    #[serde(default)]
    pub note_mcp_servers: Option<Vec<String>>,
    /// Tags for multi-repo sequence filtering (e.g., "frontend", "backend", "infra")
    #[serde(default)]
    pub tags: Vec<String>,
    /// Whether this repo is active (shown in selectors, eligible for auto-select).
    /// Defaults to true for backward compatibility with existing configs.
    #[serde(default = "default_true")]
    pub active: bool,
}

fn default_true() -> bool {
    true
}

/// SDK provider for the main coding agent (Claude or OpenAI Codex)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum SdkProvider {
    #[default]
    Claude,
    OpenAI,
}

/// OpenAI authentication method
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum OpenAiAuthMethod {
    #[default]
    OAuth,
    ApiKey,
}

/// Claude authentication method
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum ClaudeAuthMethod {
    /// Use existing Claude CLI OAuth session (~/.claude/.credentials.json)
    #[default]
    OAuth,
    /// Use API key stored in keyring (ANTHROPIC_API_KEY)
    ApiKey,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum ClaudeTerminalMode {
    Interactive,
    Prompt,
    #[default]
    Sdk,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum CodexMode {
    #[default]
    AppServer,
    Sdk,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TerminalMode {
    Interactive,
    Prompt,
    Sdk,
    CodexAppServer,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum Theme {
    #[default]
    Midnight,
    Slate,
    Void,
    Ember,
    Pearl,
    Latte,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum SessionSortOrder {
    #[default]
    Chronological,
    StatusThenChronological,
}

/// Sessions view layout type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SessionsViewLayout {
    #[default]
    List,
    Grid,
}

/// Grid card size options
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SessionsGridSize {
    Small,
    #[default]
    Medium,
    Large,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionsViewConfig {
    #[serde(default)]
    pub layout: SessionsViewLayout,
    #[serde(default = "default_grid_columns")]
    pub grid_columns: usize,
    #[serde(default)]
    pub card_size: SessionsGridSize,
}

fn default_grid_columns() -> usize {
    3
}

impl Default for SessionsViewConfig {
    fn default() -> Self {
        Self {
            layout: SessionsViewLayout::default(),
            grid_columns: default_grid_columns(),
            card_size: SessionsGridSize::default(),
        }
    }
}

/// Effort level for reasoning depth control
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum EffortLevel {
    #[default]
    Off,
    Low,
    Medium,
    High,
    Max,
}

/// Resilient deserializer for EffortLevel that maps legacy/unknown values
/// instead of failing the entire config parse.
/// Legacy mappings: "on"/"think" → High, "megathink"/"ultrathink" → Max
impl<'de> Deserialize<'de> for EffortLevel {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(match s.to_lowercase().as_str() {
            "off" => EffortLevel::Off,
            "low" => EffortLevel::Low,
            "medium" => EffortLevel::Medium,
            "high" => EffortLevel::High,
            "max" => EffortLevel::Max,
            // Legacy thinking level values
            "on" | "think" => {
                eprintln!("[config] Migrating legacy effort value '{}' → High", s);
                EffortLevel::High
            }
            "megathink" => {
                eprintln!("[config] Migrating legacy effort value 'megathink' → Max");
                EffortLevel::Max
            }
            "ultrathink" => {
                eprintln!("[config] Migrating legacy effort value 'ultrathink' → Max");
                EffortLevel::Max
            }
            other => {
                eprintln!("[config] Unknown effort level '{}', defaulting to Off", other);
                EffortLevel::Off
            }
        })
    }
}

/// Tool call display mode in SDK view
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ToolDisplayMode {
    #[default]
    List,
    Grid,
}

/// MCP server transport type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum McpServerType {
    #[default]
    Stdio,
    Http,
    Sse,
}

/// MCP server authentication type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum McpAuthType {
    /// No authentication
    #[default]
    None,
    /// Static bearer token (API key style)
    BearerToken,
    /// OAuth 2.1 authorization code flow with PKCE
    OAuth,
}

/// OAuth 2.1 configuration for MCP servers
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct McpOAuthConfig {
    /// OAuth client ID (public, safe to store in config)
    #[serde(default)]
    pub client_id: Option<String>,
    /// Authorization endpoint URL
    #[serde(default)]
    pub authorization_url: Option<String>,
    /// Token endpoint URL
    #[serde(default)]
    pub token_url: Option<String>,
    /// Scopes to request (space-separated)
    #[serde(default)]
    pub scopes: Option<String>,
    /// Redirect URI for OAuth callback (default: http://localhost:19256/callback)
    #[serde(default)]
    pub redirect_uri: Option<String>,
}

/// Configuration for an individual MCP server
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    /// Unique identifier for this server
    pub id: String,
    /// Display name
    pub name: String,
    /// Transport type (stdio, http, sse)
    #[serde(default)]
    pub server_type: McpServerType,
    /// Command to run (for stdio servers)
    #[serde(default)]
    pub command: Option<String>,
    /// Command arguments (for stdio servers)
    #[serde(default)]
    pub args: Option<Vec<String>>,
    /// Environment variables
    #[serde(default)]
    pub env: Option<std::collections::HashMap<String, String>>,
    /// URL endpoint (for HTTP/SSE servers)
    #[serde(default)]
    pub url: Option<String>,
    /// Whether this server is enabled
    #[serde(default = "default_mcp_enabled")]
    pub enabled: bool,
    /// Authentication type for HTTP/SSE servers
    #[serde(default)]
    pub auth_type: McpAuthType,
    /// OAuth configuration (when auth_type is OAuth)
    #[serde(default)]
    pub oauth: Option<McpOAuthConfig>,
    /// Custom headers for HTTP/SSE servers (non-sensitive, stored in config)
    #[serde(default)]
    pub headers: Option<std::collections::HashMap<String, String>>,
}

fn default_mcp_enabled() -> bool {
    true
}

/// Global MCP configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct McpConfig {
    /// List of global MCP servers
    #[serde(default)]
    pub servers: Vec<McpServerConfig>,
}

/// Notification channel type for sequences (external integrations only)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum NotificationChannelType {
    #[default]
    Slack,
    Discord,
    Webhook,
}

/// Configuration for a notification channel used by sequences
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationChannelConfig {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub channel_type: NotificationChannelType,
    #[serde(default)]
    pub webhook_url: Option<String>,
    #[serde(default)]
    pub headers: Option<std::collections::HashMap<String, String>>,
    #[serde(default = "default_notification_enabled")]
    pub enabled: bool,
}

fn default_notification_enabled() -> bool {
    true
}

/// Sequence automation configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceConfig {
    /// Maximum number of concurrent sequence executions
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent_executions: usize,
    /// Default timeout for nodes in seconds
    #[serde(default = "default_sequence_timeout")]
    pub default_timeout: u64,
    /// How many days to keep execution history
    #[serde(default = "default_execution_history_days")]
    pub execution_history_days: u64,
    /// Configured notification channels
    #[serde(default)]
    pub notification_channels: Vec<NotificationChannelConfig>,
    /// Maximum number of concurrent prompt nodes across all sequences
    #[serde(default = "default_max_concurrent_prompts")]
    pub max_concurrent_prompts: usize,
    /// Default requests-per-minute limit per provider
    #[serde(default = "default_provider_rpm")]
    pub default_provider_rpm: u32,
}

fn default_max_concurrent() -> usize {
    3
}

fn default_sequence_timeout() -> u64 {
    300
}

fn default_execution_history_days() -> u64 {
    30
}

fn default_max_concurrent_prompts() -> usize {
    3
}

fn default_provider_rpm() -> u32 {
    50
}

impl Default for SequenceConfig {
    fn default() -> Self {
        Self {
            max_concurrent_executions: default_max_concurrent(),
            default_timeout: default_sequence_timeout(),
            execution_history_days: default_execution_history_days(),
            notification_channels: Vec::new(),
            max_concurrent_prompts: default_max_concurrent_prompts(),
            default_provider_rpm: default_provider_rpm(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub whisper: WhisperConfig,
    #[serde(default)]
    pub vosk: VoskConfig,
    pub git: GitConfig,
    pub hotkeys: HotkeyConfig,
    /// Per-hotkey enabled/disabled toggles
    #[serde(default)]
    pub hotkeys_enabled: HotkeyEnabledConfig,
    pub overlay: OverlayConfig,
    pub audio: AudioConfig,
    pub repos: Vec<RepoConfig>,
    pub active_repo_index: usize,
    /// When true, repo is auto-selected based on prompt content (if Gemini auto_select_repo is enabled)
    #[serde(default)]
    pub auto_repo_mode: bool,
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
    /// Inject a system message notifying agents that other agents may be working in parallel
    #[serde(default = "default_notify_parallel_agents")]
    pub notify_parallel_agents: bool,
    /// User-defined quick action prompts shown in SDK sessions
    #[serde(default = "default_quick_actions")]
    pub quick_actions: Vec<String>,
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

/// Provider type for the lightweight LLM integration (session naming, etc.)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum LlmProvider {
    #[default]
    Groq,
    Gemini,
    OpenAI,
    Local,
    Custom,
}

/// Model selection priority for Gemini provider
/// Note: As of Dec 2025, free tier is 20 RPD for both 2.5 Flash and 2.5 Flash-Lite
/// Speed: prioritizes 2.5 Flash-Lite -> 2.5 Flash
/// Accuracy: prioritizes 2.5 Flash -> 2.5 Flash-Lite
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum LlmModelPriority {
    #[default]
    Speed,
    Accuracy,
}

/// Minimum confidence level required for auto-selecting a repository
/// High: Only auto-select when LLM is highly confident
/// Medium: Auto-select when LLM has medium or high confidence
/// Low: Auto-select for any confidence level (low, medium, high)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum RepoAutoSelectConfidence {
    /// Only auto-select when confidence is high
    #[default]
    High,
    /// Auto-select when confidence is medium or high
    Medium,
    /// Auto-select for any confidence level
    Low,
}

/// Controls how effort level is determined when using smart model selection
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AutoModelEffort {
    /// Always disable effort when using auto model
    Off,
    Low,
    Medium,
    High,
    Max,
    /// Let the LLM decide based on prompt complexity (default)
    #[default]
    Dynamic,
}

/// Resilient deserializer for AutoModelEffort that maps legacy/unknown values.
impl<'de> Deserialize<'de> for AutoModelEffort {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(match s.to_lowercase().as_str() {
            "off" => AutoModelEffort::Off,
            "low" => AutoModelEffort::Low,
            "medium" => AutoModelEffort::Medium,
            "high" => AutoModelEffort::High,
            "max" => AutoModelEffort::Max,
            "dynamic" => AutoModelEffort::Dynamic,
            // Legacy thinking level values
            "on" | "think" => {
                eprintln!("[config] Migrating legacy auto_model_effort '{}' → High", s);
                AutoModelEffort::High
            }
            "megathink" => {
                eprintln!("[config] Migrating legacy auto_model_effort 'megathink' → Max");
                AutoModelEffort::Max
            }
            "ultrathink" => {
                eprintln!("[config] Migrating legacy auto_model_effort 'ultrathink' → Max");
                AutoModelEffort::Max
            }
            other => {
                eprintln!("[config] Unknown auto_model_effort '{}', defaulting to Dynamic", other);
                AutoModelEffort::Dynamic
            }
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmFeaturesConfig {
    pub auto_name_sessions: bool,
    pub detect_interaction_needed: bool,
    /// Generate contextual quick actions based on session completion
    #[serde(default)]
    pub generate_quick_actions: bool,
    #[serde(default)]
    pub clean_transcription: bool,
    /// Use both Vosk and Whisper transcriptions for cleanup (requires both to be enabled)
    #[serde(default)]
    pub use_dual_transcription: bool,
    #[serde(default)]
    pub recommend_model: bool,
    /// Controls effort level behavior when smart model selection is enabled
    #[serde(default, alias = "auto_model_thinking")]
    pub auto_model_effort: AutoModelEffort,
    /// Auto-select repository based on prompt content
    #[serde(default)]
    pub auto_select_repo: bool,
}

impl Default for LlmFeaturesConfig {
    fn default() -> Self {
        Self {
            auto_name_sessions: true,
            detect_interaction_needed: true,
            generate_quick_actions: true,
            clean_transcription: true,
            use_dual_transcription: true,
            recommend_model: true,
            auto_model_effort: AutoModelEffort::default(),
            auto_select_repo: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    pub enabled: bool,
    /// Provider for the LLM integration
    #[serde(default)]
    pub provider: LlmProvider,
    /// Model name (varies by provider) - used when auto_model is false
    #[serde(default = "default_llm_model")]
    pub model: String,
    /// API endpoint (only used for Local/Custom providers)
    #[serde(default)]
    pub endpoint: Option<String>,
    /// When enabled for Gemini provider, automatically select model with fallbacks
    #[serde(default = "default_auto_model")]
    pub auto_model: bool,
    /// Model priority when auto_model is enabled (Speed or Accuracy)
    #[serde(default)]
    pub model_priority: LlmModelPriority,
    pub features: LlmFeaturesConfig,
    /// When enabled, Claude will question the repo selection if it seems wrong
    #[serde(default)]
    pub confirm_repo_selection: bool,
    /// Minimum confidence level required for auto-selecting a repository
    #[serde(default)]
    pub min_auto_select_confidence: RepoAutoSelectConfidence,
    // API key is stored securely, not in config
}

fn default_llm_model() -> String {
    "meta-llama/llama-4-maverick-17b-128e-instruct".to_string()
}

fn default_auto_model() -> bool {
    true
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: LlmProvider::default(),
            model: default_llm_model(),
            endpoint: None,
            auto_model: default_auto_model(),
            model_priority: LlmModelPriority::default(),
            features: LlmFeaturesConfig::default(),
            confirm_repo_selection: false,
            min_auto_select_confidence: RepoAutoSelectConfidence::default(),
        }
    }
}

fn default_effort_level() -> EffortLevel {
    EffortLevel::High
}

fn default_enabled_models() -> Vec<String> {
    vec![
        "claude-opus-4-6".to_string(),
        "claude-sonnet-4-6".to_string(),
        "claude-haiku-4-5-20251001".to_string(),
    ]
}

fn default_openai_model() -> String {
    "gpt-5.3-codex".to_string()
}

fn default_enabled_openai_models() -> Vec<String> {
    vec![
        "gpt-5.3-codex".to_string(),
        "gpt-5.3-codex-spark".to_string(),
        "gpt-5.2-codex".to_string(),
        "gpt-5.1-codex-mini".to_string(),
    ]
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
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
            default_model: "claude-opus-4-6".to_string(),
            default_effort_level: default_effort_level(),
            enabled_models: default_enabled_models(),
            terminal_mode: ClaudeTerminalMode::default(),
            codex_mode: CodexMode::default(),
            sdk_provider: SdkProvider::default(),
            openai_model: default_openai_model(),
            enabled_openai_models: default_enabled_openai_models(),
            openai_auth_method: OpenAiAuthMethod::default(),
            claude_auth_method: ClaudeAuthMethod::default(),
            skip_permissions: false,
            theme: Theme::default(),
            system: SystemConfig::default(),
            show_branch_in_sessions: false,
            session_persistence: SessionPersistenceConfig::default(),
            session_sort_order: SessionSortOrder::default(),
            mark_sessions_unread: true,
            show_latest_message_preview: true,
            show_session_summary: true,
            sidebar_width: 256,
            session_prompt_rows: 2,
            session_response_rows: 2,
            sessions_view: SessionsViewConfig::default(),
            tool_display_mode: ToolDisplayMode::default(),
            llm: LlmConfig::default(),
            mcp: McpConfig::default(),
            sequences: SequenceConfig::default(),
            notify_parallel_agents: true,
            quick_actions: default_quick_actions(),
        }
    }
}

impl AppConfig {
    pub fn config_dir() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("claude-whisperer")
    }

    pub fn config_path() -> PathBuf {
        // Use separate config file for debug builds to avoid conflicts
        #[cfg(debug_assertions)]
        let filename = "config.dev.json";
        #[cfg(not(debug_assertions))]
        let filename = "config.json";

        Self::config_dir().join(filename)
    }

    /// Load config with graceful recovery.
    /// Returns (config, loaded_successfully).
    /// `loaded_successfully` is true if config was parsed from disk (even with field-level fixups),
    /// false if we fell back to defaults entirely.
    pub fn load() -> (Self, bool) {
        let path = Self::config_path();
        let load_path = if path.exists() {
            path.clone()
        } else {
            #[cfg(debug_assertions)]
            {
                let legacy_debug_path = Self::config_dir().join("config.dev");
                if legacy_debug_path.exists() {
                    eprintln!(
                        "[config.load] Found legacy debug config at {:?}; attempting migration to {:?}",
                        legacy_debug_path, path
                    );
                    match fs::rename(&legacy_debug_path, &path) {
                        Ok(()) => path.clone(),
                        Err(e) => {
                            eprintln!(
                                "[config.load] Failed to migrate legacy debug config: {}. Loading legacy file directly.",
                                e
                            );
                            legacy_debug_path
                        }
                    }
                } else {
                    let release_path = Self::config_dir().join("config.json");
                    if release_path.exists() {
                        eprintln!(
                            "[config.load] Debug config {:?} missing; loading {:?} instead.",
                            path, release_path
                        );
                        release_path
                    } else {
                        println!("[config.load] No config file found, using defaults");
                        return (Self::default(), true);
                    }
                }
            }
            #[cfg(not(debug_assertions))]
            {
                println!("[config.load] No config file found, using defaults");
                return (Self::default(), true);
            }
        };

        let content = match fs::read_to_string(&load_path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[config.load] Failed to read config: {}", e);
                return (Self::default(), false);
            }
        };

        // Attempt 1: Normal deserialization (custom deserializers handle most legacy values)
        match serde_json::from_str::<AppConfig>(&content) {
            Ok(config) => {
                println!("[config.load] Config loaded successfully ({} repos)", config.repos.len());
                return (config, true);
            }
            Err(e) => {
                eprintln!("[config.load] Normal parse failed: {}. Attempting field-level recovery...", e);
            }
        }

        // Attempt 2: Parse as Value, fix known problematic fields, then retry
        match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(mut value) => {
                Self::fix_known_fields(&mut value);
                match serde_json::from_value::<AppConfig>(value) {
                    Ok(config) => {
                        eprintln!("[config.load] Recovery succeeded ({} repos)", config.repos.len());
                        return (config, true);
                    }
                    Err(e) => {
                        eprintln!("[config.load] Recovery also failed: {}. Falling back to defaults.", e);
                    }
                }
            }
            Err(e) => {
                eprintln!("[config.load] Config is not valid JSON: {}. Falling back to defaults.", e);
            }
        }

        (Self::default(), false)
    }

    /// Fix known problematic fields in a parsed JSON Value.
    /// This handles fields that can't be fixed by custom deserializers alone
    /// (e.g., completely wrong types, removed enum variants).
    fn fix_known_fields(value: &mut serde_json::Value) {
        if let serde_json::Value::Object(obj) = value {
            // Fix default_effort_level / default_thinking_level
            if let Some(field) = obj.get("default_effort_level").or(obj.get("default_thinking_level")) {
                if let serde_json::Value::Bool(_) | serde_json::Value::Number(_) = field {
                    eprintln!("[config.fix] Fixing non-string default_effort_level");
                    obj.insert("default_effort_level".to_string(), serde_json::Value::String("high".to_string()));
                }
            }

            // Fix llm.features.auto_model_effort / auto_model_thinking
            if let Some(serde_json::Value::Object(llm)) = obj.get_mut("llm") {
                if let Some(serde_json::Value::Object(features)) = llm.get_mut("features") {
                    for key in &["auto_model_effort", "auto_model_thinking"] {
                        if let Some(field) = features.get(*key) {
                            if let serde_json::Value::Bool(_) | serde_json::Value::Number(_) = field {
                                eprintln!("[config.fix] Fixing non-string {}", key);
                                features.insert(key.to_string(), serde_json::Value::String("dynamic".to_string()));
                            }
                        }
                    }
                }
            }

            // Fix theme if it's a removed variant
            if let Some(serde_json::Value::String(theme)) = obj.get("theme") {
                let valid_themes = ["Midnight", "Slate", "Void", "Ember", "Pearl", "Latte", "Snow", "Sand"];
                if !valid_themes.contains(&theme.as_str()) {
                    eprintln!("[config.fix] Fixing unknown theme '{}' → Midnight", theme);
                    obj.insert("theme".to_string(), serde_json::Value::String("Midnight".to_string()));
                }
            }

            // Migrate removed OpenAI alias model id
            if let Some(serde_json::Value::String(openai_model)) = obj.get("openai_model") {
                if openai_model == "codex-mini-latest" {
                    eprintln!("[config.fix] Migrating openai_model 'codex-mini-latest' → 'gpt-5.3-codex'");
                    obj.insert("openai_model".to_string(), serde_json::Value::String("gpt-5.3-codex".to_string()));
                }
            }

            if let Some(serde_json::Value::Array(enabled_models)) = obj.get_mut("enabled_openai_models") {
                let original_len = enabled_models.len();
                enabled_models.retain(|v| match v {
                    serde_json::Value::String(s) => s != "codex-mini-latest",
                    _ => true,
                });
                if enabled_models.len() != original_len {
                    eprintln!("[config.fix] Removed deprecated model 'codex-mini-latest' from enabled_openai_models");
                }
                if enabled_models.is_empty() {
                    enabled_models.push(serde_json::Value::String(default_openai_model()));
                    eprintln!("[config.fix] enabled_openai_models was empty after migration; restored default");
                }
            }

            // Migrate legacy shared terminal mode into Codex-specific mode.
            if !obj.contains_key("codex_mode") && !obj.contains_key("openai_terminal_mode") {
                if let Some(serde_json::Value::String(mode)) = obj.get("terminal_mode") {
                    if mode == "CodexAppServer" {
                        eprintln!("[config.fix] Migrating legacy terminal_mode 'CodexAppServer' to codex_mode");
                        obj.insert(
                            "codex_mode".to_string(),
                            serde_json::Value::String("AppServer".to_string()),
                        );
                        obj.insert(
                            "terminal_mode".to_string(),
                            serde_json::Value::String("Interactive".to_string()),
                        );
                    }
                }
            }

            // Migrate transitional field name openai_terminal_mode -> codex_mode
            if !obj.contains_key("codex_mode") {
                if let Some(serde_json::Value::String(mode)) = obj.get("openai_terminal_mode") {
                    let migrated = if mode == "CodexAppServer" || mode == "AppServer" {
                        "AppServer"
                    } else {
                        "Sdk"
                    };
                    if mode == "CodexAppServer" || mode == "AppServer" {
                        eprintln!("[config.fix] Migrating openai_terminal_mode '{}' to codex_mode=AppServer", mode);
                    }
                    obj.insert(
                        "codex_mode".to_string(),
                        serde_json::Value::String(migrated.to_string()),
                    );
                }
            }
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let dir = Self::config_dir();
        println!("[config.save] Saving to dir: {:?}", dir);
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;

        let path = Self::config_path();

        // Rolling backup: rotate .bak.10 → delete, .bak.9 → .bak.10, ... .bak.1 → .bak.2, current → .bak.1
        if path.exists() {
            let max_backups = 10;
            // Remove the oldest backup
            let oldest = path.with_extension(format!("json.bak.{}", max_backups));
            if oldest.exists() {
                let _ = fs::remove_file(&oldest);
            }
            // Rotate existing backups up by one
            for i in (1..max_backups).rev() {
                let from = path.with_extension(format!("json.bak.{}", i));
                let to = path.with_extension(format!("json.bak.{}", i + 1));
                if from.exists() {
                    let _ = fs::rename(&from, &to);
                }
            }
            // Copy current config to .bak.1
            let newest = path.with_extension("json.bak.1");
            match fs::copy(&path, &newest) {
                Ok(_) => {}
                Err(e) => eprintln!("[config.save] Warning: failed to backup config: {}", e),
            }
        }

        println!("[config.save] Config path: {:?}", path);
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;

        println!("[config.save] Writing {} bytes, repos count: {}", content.len(), self.repos.len());
        fs::write(&path, &content).map_err(|e| format!("Failed to write config: {}", e))?;
        println!("[config.save] Write successful");
        Ok(())
    }

    pub fn get_active_repo(&self) -> Option<&RepoConfig> {
        self.repos.get(self.active_repo_index).filter(|r| r.active)
    }

    pub fn get_effective_terminal_mode(&self) -> TerminalMode {
        match self.sdk_provider {
            SdkProvider::OpenAI => match self.codex_mode {
                CodexMode::Sdk => TerminalMode::Sdk,
                // OpenAI app-server runs inside the SDK-style session view (not PTY terminal mode).
                CodexMode::AppServer => TerminalMode::Sdk,
            },
            SdkProvider::Claude => match self.terminal_mode {
                ClaudeTerminalMode::Interactive => TerminalMode::Interactive,
                ClaudeTerminalMode::Prompt => TerminalMode::Prompt,
                ClaudeTerminalMode::Sdk => TerminalMode::Sdk,
            },
        }
    }
}
