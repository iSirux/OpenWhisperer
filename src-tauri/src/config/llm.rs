//! Lightweight LLM-integration configuration (session naming, transcription cleanup, etc.).

use serde::{Deserialize, Deserializer, Serialize};

use super::default_true;

/// Provider type for the lightweight LLM integration (session naming, etc.)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum LlmProvider {
    #[default]
    Groq,
    Gemini,
    OpenAI,
    /// xAI (Grok) — OpenAI-compatible chat-completions API.
    Xai,
    Local,
    Custom,
}

/// Model selection priority for Gemini provider
/// As of mid-2026 the free tier centers on the Gemini 3 series (3.5 Flash /
/// 3.1 Flash-Lite), with the 2.5 Flash models kept as fallbacks.
/// Speed: prioritizes 3.1 Flash-Lite -> 3.5 Flash -> 2.5 Flash-Lite
/// Accuracy: prioritizes 3.5 Flash -> 3.1 Flash-Lite -> 2.5 Flash
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
    Xhigh,
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
            "xhigh" => AutoModelEffort::Xhigh,
            "max" => AutoModelEffort::Max,
            "dynamic" => AutoModelEffort::Dynamic,
            // Legacy thinking level values
            "on" | "think" => {
                log::error!("[config] Migrating legacy auto_model_effort '{}' → High", s);
                AutoModelEffort::High
            }
            "megathink" => {
                log::error!("[config] Migrating legacy auto_model_effort 'megathink' → Xhigh");
                AutoModelEffort::Xhigh
            }
            "ultrathink" => {
                log::error!("[config] Migrating legacy auto_model_effort 'ultrathink' → Max");
                AutoModelEffort::Max
            }
            other => {
                log::error!(
                    "[config] Unknown auto_model_effort '{}', defaulting to Dynamic",
                    other
                );
                AutoModelEffort::Dynamic
            }
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmFeaturesConfig {
    #[serde(default = "default_true")]
    pub auto_name_sessions: bool,
    #[serde(default = "default_true")]
    pub detect_interaction_needed: bool,
    /// Generate contextual quick actions based on session completion
    #[serde(default = "default_true")]
    pub generate_quick_actions: bool,
    #[serde(default = "default_true")]
    pub clean_transcription: bool,
    /// Use both realtime and Whisper transcriptions for cleanup (requires both to be enabled)
    #[serde(default = "default_true")]
    pub use_dual_transcription: bool,
    #[serde(default = "default_true")]
    pub recommend_model: bool,
    /// Controls effort level behavior when smart model selection is enabled
    #[serde(default, alias = "auto_model_thinking")]
    pub auto_model_effort: AutoModelEffort,
    /// Auto-select repository based on prompt content
    #[serde(default = "default_true")]
    pub auto_select_repo: bool,
    /// Use LLM to generate descriptive branch names for new worktrees
    #[serde(default = "default_true")]
    pub generate_branch_names: bool,
}

impl Default for LlmFeaturesConfig {
    fn default() -> Self {
        Self {
            auto_name_sessions: default_true(),
            detect_interaction_needed: default_true(),
            generate_quick_actions: default_true(),
            clean_transcription: default_true(),
            use_dual_transcription: default_true(),
            recommend_model: default_true(),
            auto_model_effort: AutoModelEffort::default(),
            auto_select_repo: default_true(),
            generate_branch_names: default_true(),
        }
    }
}

/// A named LLM provider profile. Multiple profiles can be configured and wired
/// into role-based routing chains (fast / quality) for cross-provider fallback.
/// The migrated legacy single-provider config becomes a profile with id
/// `"default"` (which reuses the legacy bare keyring account).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LlmProfile {
    /// Stable unique id; the migrated legacy profile uses "default".
    pub id: String,
    /// Human-readable label shown in the UI.
    pub label: String,
    #[serde(default)]
    pub provider: LlmProvider,
    /// Model name (varies by provider) — used when auto_model is false.
    pub model: String,
    /// API endpoint (only used for Local/Custom providers).
    #[serde(default)]
    pub endpoint: Option<String>,
    /// Keeps intra-provider fallback chains (Gemini/Groq) when enabled.
    #[serde(default = "default_auto_model")]
    pub auto_model: bool,
    #[serde(default)]
    pub model_priority: LlmModelPriority,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Named provider profiles. Defaults to a single "default" profile mirroring
    /// the historical single-provider defaults.
    #[serde(default = "default_profiles")]
    pub profiles: Vec<LlmProfile>,
    /// Ordered profile ids routed for latency-sensitive (Fast) features.
    #[serde(default = "default_chain")]
    pub fast_chain: Vec<String>,
    /// Ordered profile ids routed for correctness-critical (Quality) features.
    #[serde(default = "default_chain")]
    pub quality_chain: Vec<String>,
    #[serde(default)]
    pub features: LlmFeaturesConfig,
    /// When enabled, Claude will question the repo selection if it seems wrong
    #[serde(default)]
    pub confirm_repo_selection: bool,
    /// Minimum confidence level required for auto-selecting a repository
    #[serde(default)]
    pub min_auto_select_confidence: RepoAutoSelectConfidence,
    // API keys are stored securely (one per profile), not in config
}

pub(crate) fn default_llm_model() -> String {
    "openai/gpt-oss-120b".to_string()
}

fn default_auto_model() -> bool {
    true
}

/// The default profile set: one "default" profile mirroring the historical
/// single-provider defaults (Groq / gpt-oss-120b, auto-model, speed priority).
fn default_profiles() -> Vec<LlmProfile> {
    vec![LlmProfile {
        id: "default".to_string(),
        label: "Default".to_string(),
        provider: LlmProvider::Groq,
        model: default_llm_model(),
        endpoint: None,
        auto_model: default_auto_model(),
        model_priority: LlmModelPriority::Speed,
    }]
}

/// The default routing chain: just the "default" profile.
fn default_chain() -> Vec<String> {
    vec!["default".to_string()]
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            profiles: default_profiles(),
            fast_chain: default_chain(),
            quality_chain: default_chain(),
            features: LlmFeaturesConfig::default(),
            confirm_repo_selection: false,
            min_auto_select_confidence: RepoAutoSelectConfidence::default(),
        }
    }
}
