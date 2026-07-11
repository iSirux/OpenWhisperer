//! Sequence-automation, notification-channel, and smart-queue configuration.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::default_true;

/// Smart Queue configuration for deferring launches/prompts when a provider is rate-limited
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueConfig {
    /// Master toggle for the smart queue feature
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Apply a fuzzy delay after the usage window resets before the first dispatch
    #[serde(default = "default_true")]
    pub fuzzy_delay_after_reset: bool,
    /// Minimum seconds to wait after reset before the first dispatch
    #[serde(default = "default_fuzzy_delay_after_reset_min_secs")]
    pub fuzzy_delay_after_reset_min_secs: u32,
    /// Maximum seconds to wait after reset before the first dispatch
    #[serde(default = "default_fuzzy_delay_after_reset_max_secs")]
    pub fuzzy_delay_after_reset_max_secs: u32,
    /// Apply a fuzzy delay between successive dispatches
    #[serde(default = "default_true")]
    pub fuzzy_delay_between_runs: bool,
    /// Minimum seconds to wait between successive dispatches
    #[serde(default = "default_fuzzy_delay_between_runs_min_secs")]
    pub fuzzy_delay_between_runs_min_secs: u32,
    /// Maximum seconds to wait between successive dispatches
    #[serde(default = "default_fuzzy_delay_between_runs_max_secs")]
    pub fuzzy_delay_between_runs_max_secs: u32,
}

fn default_fuzzy_delay_after_reset_min_secs() -> u32 {
    5
}

fn default_fuzzy_delay_after_reset_max_secs() -> u32 {
    60
}

fn default_fuzzy_delay_between_runs_min_secs() -> u32 {
    0
}

fn default_fuzzy_delay_between_runs_max_secs() -> u32 {
    3
}

impl Default for QueueConfig {
    fn default() -> Self {
        Self {
            enabled: default_true(),
            fuzzy_delay_after_reset: default_true(),
            fuzzy_delay_after_reset_min_secs: default_fuzzy_delay_after_reset_min_secs(),
            fuzzy_delay_after_reset_max_secs: default_fuzzy_delay_after_reset_max_secs(),
            fuzzy_delay_between_runs: default_true(),
            fuzzy_delay_between_runs_min_secs: default_fuzzy_delay_between_runs_min_secs(),
            fuzzy_delay_between_runs_max_secs: default_fuzzy_delay_between_runs_max_secs(),
        }
    }
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
    pub headers: Option<HashMap<String, String>>,
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
