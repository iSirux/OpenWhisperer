use serde::{Deserialize, Serialize};

/// Routing role for an LLM feature. Determines which configured chain
/// (fast_chain or quality_chain) drives the feature.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LlmRole {
    /// Latency-sensitive, pre-send path.
    Fast,
    /// Correctness-critical path.
    Quality,
}

/// Every LLM-backed feature, used to pick the routing chain.
#[derive(Debug, Clone, Copy)]
pub enum LlmFeature {
    SessionNaming,
    SessionOutcome,
    InteractionAnalysis,
    TranscriptionCleanup,
    ModelRecommendation,
    RepoRecommendation,
    QuickActions,
    ShipDraft,
    BranchName,
    SequenceAi,
}

impl LlmFeature {
    /// Map a feature to its routing role. Pre-send recommendations plus the
    /// low-stakes metadata generators (naming, outcome, branch names) are Fast;
    /// everything else — including the correctness-critical transcription
    /// cleanup — routes to Quality.
    pub fn role(self) -> LlmRole {
        match self {
            LlmFeature::ModelRecommendation
            | LlmFeature::RepoRecommendation
            | LlmFeature::SessionNaming
            | LlmFeature::SessionOutcome
            | LlmFeature::BranchName => LlmRole::Fast,
            _ => LlmRole::Quality,
        }
    }
}

/// Result for generating a session name from the initial prompt
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionNameResult {
    pub name: String,
    pub category: String, // feature, bugfix, refactor, research, question, other
}

/// Result for generating a session outcome after completion
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionOutcomeResult {
    pub outcome: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InteractionAnalysis {
    pub needs_interaction: bool,
    pub reason: Option<String>,
    pub urgency: String,             // low, medium, high
    pub waiting_for: Option<String>, // approval, clarification, input, review, decision
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionCleanupResult {
    pub cleaned_text: String,
    pub corrections_made: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRecommendation {
    pub recommended_model: String, // haiku, sonnet, opus
    pub reasoning: String,
    pub confidence: String, // low, medium, high
    /// Suggested effort level: null, low, medium, high, max
    pub suggested_effort: Option<String>,
    /// @deprecated Use suggested_effort - kept for backward compat with old LLM responses
    pub suggested_thinking: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionTestResult {
    pub success: bool,
    pub error: Option<String>,
    pub model_info: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoRecommendation {
    /// The index of the recommended repository (0-based), or -1 if no clear match
    pub recommended_index: i64,
    /// The name of the recommended repository, or empty string if no clear match
    pub recommended_name: String,
    pub confidence: String, // low, medium, high
    pub reasoning: String,
}

impl RepoRecommendation {
    /// Returns the recommended index as Option<usize>, converting -1 to None
    pub fn get_index(&self) -> Option<usize> {
        if self.recommended_index >= 0 {
            Some(self.recommended_index as usize)
        } else {
            None
        }
    }
}

/// Result for generating a git branch name from a prompt
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchNameResult {
    pub branch_name: String,
}

/// A single quick action suggestion
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickAction {
    pub prompt: String, // Full instruction sent verbatim to the coding agent
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>, // Short button text (2-4 words); falls back to `prompt` when absent
}

/// Result for generating contextual quick actions based on session state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickActionsResult {
    pub actions: Vec<QuickAction>,
}

/// Result for drafting a ship commit message + PR title/body (validation ship step)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShipDraftResult {
    pub commit_message: String,
    pub pr_title: String,
    pub pr_body: String,
}
