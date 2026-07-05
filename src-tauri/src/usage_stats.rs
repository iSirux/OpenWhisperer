//! Usage telemetry: session/token/tool/streak tracking and daily rollups.
//!
//! Moved out of `config.rs` (it is telemetry state, not configuration). Persisted
//! to `usage_stats[.dev].json` in the config dir via the shared `persist` helpers.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::config::AppConfig;
use crate::util::now_ms;

/// Minimum interval between debounced disk writes (ms). Callers mutate in memory
/// on every event but only flush at most this often (plus a forced flush on shutdown).
pub const SAVE_DEBOUNCE_MS: u64 = 5_000;

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

/// Token usage stats for the LLM integration layer (Gemini/OpenAI/Groq/Local).
///
/// The JSON shape is a flat set of scalar counters (unchanged for compatibility);
/// mutations route through `record` so the per-feature bookkeeping lives in one place.
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

impl LlmTokenStats {
    /// Record one LLM request for `feature`, updating totals and the per-feature
    /// counters. Unknown feature keys update only the totals.
    fn record(&mut self, feature: &str, input_tokens: u64, output_tokens: u64) {
        self.total_input_tokens += input_tokens;
        self.total_output_tokens += output_tokens;
        self.total_requests += 1;

        // (requests, input, output) triple to bump for the matched feature.
        let target: Option<(&mut u64, &mut u64, &mut u64)> = match feature {
            "session_naming" => Some((
                &mut self.session_naming_requests,
                &mut self.session_naming_input_tokens,
                &mut self.session_naming_output_tokens,
            )),
            "session_outcome" => Some((
                &mut self.session_outcome_requests,
                &mut self.session_outcome_input_tokens,
                &mut self.session_outcome_output_tokens,
            )),
            "interaction_analysis" => Some((
                &mut self.interaction_analysis_requests,
                &mut self.interaction_analysis_input_tokens,
                &mut self.interaction_analysis_output_tokens,
            )),
            "transcription_cleanup" => Some((
                &mut self.transcription_cleanup_requests,
                &mut self.transcription_cleanup_input_tokens,
                &mut self.transcription_cleanup_output_tokens,
            )),
            "model_recommendation" => Some((
                &mut self.model_recommendation_requests,
                &mut self.model_recommendation_input_tokens,
                &mut self.model_recommendation_output_tokens,
            )),
            "repo_description" => Some((
                &mut self.repo_description_requests,
                &mut self.repo_description_input_tokens,
                &mut self.repo_description_output_tokens,
            )),
            "repo_recommendation" => Some((
                &mut self.repo_recommendation_requests,
                &mut self.repo_recommendation_input_tokens,
                &mut self.repo_recommendation_output_tokens,
            )),
            _ => None,
        };

        if let Some((requests, input, output)) = target {
            *requests += 1;
            *input += input_tokens;
            *output += output_tokens;
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ModelUsageStats {
    pub opus_sessions: u64,
    pub sonnet_sessions: u64,
    pub haiku_sessions: u64,
    pub codex_54_sessions: u64,
    pub codex_53_sessions: u64,
    pub codex_53_spark_sessions: u64,
    pub codex_52_sessions: u64,
    pub codex_51_mini_sessions: u64,
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

/// The model families we bucket sessions into. `classify_model` is the single
/// source of truth for mapping a model ID string to a family.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelFamily {
    Opus,
    Sonnet,
    Haiku,
    Codex54,
    Codex53,
    Codex53Spark,
    Codex52,
    Codex51Mini,
    Other,
}

/// Classify a model ID into a [`ModelFamily`]. Single source of truth for the
/// model taxonomy used by usage tracking.
pub fn classify_model(model: &str) -> ModelFamily {
    let m = model.to_lowercase();
    if m.contains("opus") {
        ModelFamily::Opus
    } else if m.contains("sonnet") {
        ModelFamily::Sonnet
    } else if m.contains("haiku") {
        ModelFamily::Haiku
    } else if m == "gpt-5.4" || m == "gpt-5.4-codex" {
        ModelFamily::Codex54
    } else if m == "gpt-5.3-codex-spark" {
        ModelFamily::Codex53Spark
    } else if m == "gpt-5.3-codex" {
        ModelFamily::Codex53
    } else if m == "gpt-5.2-codex" {
        ModelFamily::Codex52
    } else if m == "gpt-5.4-mini" || m == "gpt-5-mini" || m == "gpt-5.1-codex-mini" {
        ModelFamily::Codex51Mini
    } else {
        ModelFamily::Other
    }
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
    /// Epoch-ms of the last debounced disk write. Not persisted (in-memory only).
    #[serde(skip)]
    last_saved_ms: u64,
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
            last_saved_ms: 0,
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
        crate::persist::load_json_or_default(&Self::stats_path(), "usage stats")
    }

    pub fn save(&self) -> Result<(), String> {
        crate::persist::save_json_atomic(&Self::stats_path(), self, "usage stats", 0)
    }

    /// If at least `SAVE_DEBOUNCE_MS` has elapsed since the last persist, mark now
    /// as the last-save time and return a clone the caller can persist *after*
    /// releasing the lock (so we never hold the mutex across a disk write).
    /// Returns `None` when a save is not yet due.
    pub fn snapshot_if_due(&mut self) -> Option<UsageStats> {
        let now = now_ms();
        if now.saturating_sub(self.last_saved_ms) >= SAVE_DEBOUNCE_MS {
            self.last_saved_ms = now;
            Some(self.clone())
        } else {
            None
        }
    }

    /// Force a snapshot for an immediate flush (e.g. app shutdown or reset),
    /// resetting the debounce clock. Returns a clone to persist after unlock.
    pub fn snapshot_now(&mut self) -> UsageStats {
        self.last_saved_ms = now_ms();
        self.clone()
    }

    fn get_today() -> String {
        chrono::Local::now().format("%Y-%m-%d").to_string()
    }

    /// Ensure a daily-stats entry exists for today and return a mutable reference to it.
    ///
    /// Invariant: entries are appended in chronological order, so today's entry is
    /// normally last. The lookup searches the whole vec (rather than assuming
    /// `last()`), so it stays correct even if the vec is ever reordered — avoiding
    /// the duplicate-today risk noted in the audit (C4).
    fn today_entry(&mut self) -> &mut DailyStats {
        let today = Self::get_today();
        if !self.daily_stats.iter().any(|d| d.date == today) {
            self.daily_stats.push(DailyStats {
                date: today.clone(),
                ..Default::default()
            });
            // Keep only last 90 days
            if self.daily_stats.len() > 90 {
                self.daily_stats.remove(0);
            }
        }
        self.daily_stats
            .iter_mut()
            .find(|d| d.date == today)
            .expect("today entry was just ensured to exist")
    }

    pub fn track_session(&mut self, session_type: &str, model: &str, repo_path: Option<&str>) {
        let now = now_ms();

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

        // Track model usage via the single classification helper.
        match classify_model(model) {
            ModelFamily::Opus => self.model_usage.opus_sessions += 1,
            ModelFamily::Sonnet => self.model_usage.sonnet_sessions += 1,
            ModelFamily::Haiku => self.model_usage.haiku_sessions += 1,
            ModelFamily::Codex54 => self.model_usage.codex_54_sessions += 1,
            ModelFamily::Codex53 => self.model_usage.codex_53_sessions += 1,
            ModelFamily::Codex53Spark => self.model_usage.codex_53_spark_sessions += 1,
            ModelFamily::Codex52 => self.model_usage.codex_52_sessions += 1,
            ModelFamily::Codex51Mini => self.model_usage.codex_51_mini_sessions += 1,
            ModelFamily::Other => {}
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
        self.today_entry().sessions += 1;

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

        self.today_entry().prompts += 1;
    }

    pub fn track_tool_call(&mut self, tool_name: &str) {
        self.session_stats.total_tool_calls += 1;

        // Update most used tools
        if let Some(tool) = self
            .most_used_tools
            .iter_mut()
            .find(|(name, _)| name == tool_name)
        {
            tool.1 += 1;
        } else {
            self.most_used_tools.push((tool_name.to_string(), 1));
        }

        // Sort by count and keep top 20
        self.most_used_tools.sort_by(|a, b| b.1.cmp(&a.1));
        self.most_used_tools.truncate(20);

        self.today_entry().tool_calls += 1;
    }

    pub fn track_recording(&mut self, duration_ms: u64) {
        self.session_stats.total_recordings += 1;
        self.session_stats.total_recording_duration_ms += duration_ms;

        self.today_entry().recordings += 1;
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
    pub fn track_llm_token_usage(&mut self, feature: &str, input_tokens: u64, output_tokens: u64) {
        self.llm_token_stats
            .record(feature, input_tokens, output_tokens);
    }

    fn update_streak(&mut self) {
        let today = Self::get_today();

        // Only recompute the streak once today's activity is recorded.
        let has_today = self
            .daily_stats
            .iter()
            .any(|d| d.date == today && d.sessions > 0);
        if !has_today {
            return;
        }

        // Calculate the actual streak from daily_stats by walking back over
        // consecutive days with activity.
        let mut streak = 0u32;
        let mut check_date = chrono::Local::now().date_naive();

        for day_stats in self.daily_stats.iter().rev() {
            let expected_date = check_date.format("%Y-%m-%d").to_string();
            if day_stats.date == expected_date && day_stats.sessions > 0 {
                streak += 1;
                check_date -= chrono::Duration::days(1);
            } else if day_stats.date != expected_date {
                // Gap in data — stop counting.
                break;
            }
        }

        self.streak_days = streak;
        if streak > self.longest_streak {
            self.longest_streak = streak;
        }
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}
