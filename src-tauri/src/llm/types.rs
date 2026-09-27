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
    /// Rolling meeting-transcript triage (new/update item ops).
    MeetingTriage,
    /// Whole-meeting consolidation pass (summary, merges, rewrites).
    MeetingConsolidate,
}

impl LlmFeature {
    /// Stable snake_case identifier: used as the `json_schema.name` sent to
    /// OpenAI-compatible providers and in log lines.
    pub fn name(self) -> &'static str {
        match self {
            LlmFeature::SessionNaming => "session_naming",
            LlmFeature::SessionOutcome => "session_outcome",
            LlmFeature::InteractionAnalysis => "interaction_analysis",
            LlmFeature::TranscriptionCleanup => "transcription_cleanup",
            LlmFeature::ModelRecommendation => "model_recommendation",
            LlmFeature::RepoRecommendation => "repo_recommendation",
            LlmFeature::QuickActions => "quick_actions",
            LlmFeature::ShipDraft => "ship_draft",
            LlmFeature::BranchName => "branch_name",
            LlmFeature::SequenceAi => "sequence_ai",
            LlmFeature::MeetingTriage => "meeting_triage",
            LlmFeature::MeetingConsolidate => "meeting_consolidate",
        }
    }

    /// Per-attempt (= per profile) time budget in `run_chain`. Fast features
    /// must not stall the send path; background features get room for a slow
    /// local model. Cleanup has its own tighter rail (`run_cleanup_chain`).
    pub fn timeout(self) -> std::time::Duration {
        let secs = match self {
            LlmFeature::TranscriptionCleanup => 8,
            LlmFeature::MeetingTriage => 180,
            LlmFeature::MeetingConsolidate => 600,
            // Sequence prompt nodes can carry large inputs/outputs.
            LlmFeature::SequenceAi => 120,
            other => match other.role() {
                LlmRole::Fast => 15,
                LlmRole::Quality => 60,
            },
        };
        std::time::Duration::from_secs(secs)
    }

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
    /// Runtime route metadata. These fields are filled by the backend after the
    /// model response is parsed; cleanup models are not asked to produce them.
    #[serde(default)]
    pub cleanup_profile: Option<String>,
    #[serde(default)]
    pub cleanup_provider: Option<String>,
    #[serde(default)]
    pub cleanup_model: Option<String>,
    #[serde(default)]
    pub cleanup_duration_ms: Option<u64>,
    #[serde(default)]
    pub cleanup_attempts: Option<u32>,
}

/// Auto-model grading: the recommender no longer picks a model, it scores the
/// task and the user's tier ladder (`auto_model_tiers`, resolved on the
/// frontend) maps the score to a model + effort.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRecommendation {
    /// Complexity / scope score, 1 (trivial) to 10 (very hard). Clamped after parse.
    #[serde(deserialize_with = "lenient_score")]
    pub complexity: u8,
    pub reasoning: String,
    /// low | medium | high
    #[serde(default = "default_confidence")]
    pub confidence: String,
}

fn default_confidence() -> String {
    "medium".to_string()
}

/// Accept `7`, `7.0`, `"7"` from sloppy models; clamp to 1..=10 (unparseable → 5).
fn lenient_score<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(score_from_value(&value, 5.0).clamp(1.0, 10.0).round() as u8)
}

/// Best-effort numeric read of a JSON value (number or numeric string).
pub(crate) fn score_from_value(value: &serde_json::Value, fallback: f64) -> f64 {
    match value {
        serde_json::Value::Number(n) => n.as_f64().unwrap_or(fallback),
        serde_json::Value::String(s) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|v| v.is_finite())
            .unwrap_or(fallback),
        _ => fallback,
    }
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

// ============================================================================
// Meeting mode (triage + consolidation). Shapes are the binding contract in
// docs/meeting-mode-spec.md (Workstream A) — snake_case on the wire.
// ============================================================================

/// Triage categories. Actionable: bug, task, investigate, question.
/// Non-actionable (go to the Journal): feedback, idea, decision, note.
pub const MEETING_CATEGORIES: &[&str] = &[
    "bug",
    "task",
    "investigate",
    "question",
    "feedback",
    "idea",
    "decision",
    "note",
];

/// A reference to an existing item (meeting item or journal item) the model
/// may emit `update` ops against.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingItemRef {
    pub id: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingRepoRef {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingTriageRequest {
    /// Lines formatted `[HH:MM:SS me|them] text`.
    pub transcript: String,
    /// This meeting's existing items.
    #[serde(default)]
    pub items: Vec<MeetingItemRef>,
    /// The repo's open journal items (ids prefixed `j:`).
    #[serde(default)]
    pub journal_items: Vec<MeetingItemRef>,
    /// Non-null => auto-repo: pick `repo_id` per new item.
    #[serde(default)]
    pub repos: Option<Vec<MeetingRepoRef>>,
    /// Meeting title / free-text context.
    #[serde(default)]
    pub context: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TriageOp {
    /// `new` | `update`
    pub op: String,
    /// update: existing item id (or `j:<id>` for a journal item). Null for new.
    #[serde(default)]
    pub id: Option<String>,
    /// Required for new (one of [`MEETING_CATEGORIES`]).
    #[serde(default)]
    pub category: Option<String>,
    /// Required for new.
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    /// Verbatim span from the transcript.
    #[serde(default)]
    pub quote: String,
    /// `HH:MM:SS` of the mention.
    #[serde(default, deserialize_with = "lenient_string")]
    pub t0: String,
    /// 1-10, new items.
    #[serde(default, deserialize_with = "lenient_opt_u8")]
    pub complexity: Option<u8>,
    /// 0-1, new items.
    #[serde(default, deserialize_with = "lenient_opt_f64")]
    pub confidence: Option<f64>,
    /// Only when the request carried `repos`.
    #[serde(default)]
    pub repo_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MeetingTriageResult {
    #[serde(default)]
    pub ops: Vec<TriageOp>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingConsolidateItem {
    pub id: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub sightings: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingConsolidateRequest {
    /// Full meeting, same line format as triage.
    pub transcript: String,
    #[serde(default)]
    pub items: Vec<MeetingConsolidateItem>,
    #[serde(default)]
    pub context: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeetingMerge {
    pub keep_id: String,
    #[serde(default)]
    pub merge_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeetingItemUpdate {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MeetingConsolidateResult {
    /// Markdown: overview, decisions, open questions, top items.
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub merges: Vec<MeetingMerge>,
    #[serde(default)]
    pub updates: Vec<MeetingItemUpdate>,
}

/// Intermediate map-step output when a meeting transcript is too large for a
/// single consolidation call.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MeetingChunkDigest {
    #[serde(default)]
    pub digest: String,
}

fn lenient_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match value {
        Some(serde_json::Value::String(s)) => s,
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => String::new(),
    })
}

fn lenient_opt_u8<'de, D>(deserializer: D) -> Result<Option<u8>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|v| {
        let n = score_from_value(&v, f64::NAN);
        n.is_finite().then(|| n.clamp(1.0, 10.0).round() as u8)
    }))
}

fn lenient_opt_f64<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|v| {
        let n = score_from_value(&v, f64::NAN);
        n.is_finite().then_some(n)
    }))
}
