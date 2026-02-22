use serde::{Deserialize, Serialize};

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
    pub urgency: String, // low, medium, high
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
pub struct RepoDescriptionResult {
    pub description: String,
    pub keywords: Vec<String>,
    /// Project-specific vocabulary/lingo (20-50 words) - actual terms used in the codebase
    pub vocabulary: Vec<String>,
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
    #[allow(dead_code)]
    pub fn get_index(&self) -> Option<usize> {
        if self.recommended_index >= 0 {
            Some(self.recommended_index as usize)
        } else {
            None
        }
    }

    /// Returns the recommended name as Option<&str>, converting empty string to None
    #[allow(dead_code)]
    pub fn get_name(&self) -> Option<&str> {
        if self.recommended_name.is_empty() {
            None
        } else {
            Some(&self.recommended_name)
        }
    }
}

/// A single quick action suggestion
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickAction {
    pub label: String,  // Short button label (2-4 words)
    pub prompt: String, // The actual prompt to send
}

/// Result for generating contextual quick actions based on session state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickActionsResult {
    pub actions: Vec<QuickAction>,
}
