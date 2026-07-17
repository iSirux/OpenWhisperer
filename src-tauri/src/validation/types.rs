//! Data model for the Validation pipeline. Every type here serializes to the
//! camelCase JSON the frontend consumes (the full `ValidationRun` is emitted on
//! each `validation-update-{run_id}` event). Config types (snake_case) live in
//! `crate::config::validation` instead.

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};

/// One pipeline step. Fixed order; the *set* is user-chosen per run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepName {
    Review,
    Test,
    Docs,
    Lint,
    Ship,
    Ci,
}

impl StepName {
    /// Fixed pipeline order.
    pub const ORDER: [StepName; 6] = [
        StepName::Review,
        StepName::Test,
        StepName::Docs,
        StepName::Lint,
        StepName::Ship,
        StepName::Ci,
    ];

    /// snake_case key used in config (`auto_fix_limits`) and prompts.
    pub fn key(&self) -> &'static str {
        match self {
            StepName::Review => "review",
            StepName::Test => "test",
            StepName::Docs => "docs",
            StepName::Lint => "lint",
            StepName::Ship => "ship",
            StepName::Ci => "ci",
        }
    }

}

/// Finding severity. Fail-tolerant deserialize: unknown values map to `Warning`
/// (so unclassified findings still gate rather than silently passing).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ValidationSeverity {
    Error,
    Warning,
    Info,
}

impl ValidationSeverity {
    pub fn parse(s: &str) -> ValidationSeverity {
        match s.trim().to_ascii_lowercase().as_str() {
            "error" | "critical" | "blocker" => ValidationSeverity::Error,
            "info" | "informational" | "note" => ValidationSeverity::Info,
            // Fail-closed: anything unrecognized (incl. "warning") gates.
            _ => ValidationSeverity::Warning,
        }
    }
}

impl<'de> Deserialize<'de> for ValidationSeverity {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Ok(ValidationSeverity::parse(&s))
    }
}

/// What to do with a finding. Fail-closed deserialize: missing/unknown => `AskUser`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FindingAction {
    AutoFix,
    AskUser,
    NoOp,
}

impl FindingAction {
    pub fn parse(s: &str) -> FindingAction {
        match s.trim().to_ascii_lowercase().as_str() {
            "auto-fix" | "autofix" | "auto_fix" => FindingAction::AutoFix,
            "no-op" | "noop" | "no_op" => FindingAction::NoOp,
            // FAIL-CLOSED: anything unrecognized is treated as ask-user.
            _ => FindingAction::AskUser,
        }
    }
}

impl<'de> Deserialize<'de> for FindingAction {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        // Accept a string, or a missing/null value, mapping everything unknown to
        // AskUser. (A JSON null still errors as a non-string; the field-level
        // default handles the missing-key case on the parent struct.)
        let opt = Option::<String>::deserialize(d).map_err(de::Error::custom)?;
        Ok(match opt {
            Some(s) => FindingAction::parse(&s),
            None => FindingAction::AskUser,
        })
    }
}

fn default_action() -> FindingAction {
    FindingAction::AskUser
}

fn default_source() -> String {
    "agent".to_string()
}

/// A single review/test/etc. finding.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationFinding {
    /// Deterministic id: "<step>-<n>" (agent) or "user-<n>" (user-added).
    #[serde(default)]
    pub id: String,
    #[serde(default = "default_warning")]
    pub severity: ValidationSeverity,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub description: String,
    /// FAIL-CLOSED: missing/unknown deserializes to `AskUser`.
    #[serde(default = "default_action")]
    pub action: FindingAction,
    /// "agent" | "user"
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default)]
    pub user_instructions: Option<String>,
}

fn default_warning() -> ValidationSeverity {
    ValidationSeverity::Warning
}

impl ValidationFinding {
    /// Whether this finding parks the step at a gate when it is NOT auto-fixed:
    /// any error/warning severity, or any ask-user action. Info severity with a
    /// non-ask-user action never gates.
    pub fn blocks(&self) -> bool {
        if matches!(self.action, FindingAction::AskUser) {
            return true;
        }
        matches!(
            self.severity,
            ValidationSeverity::Error | ValidationSeverity::Warning
        )
    }

    /// Whether this finding is eligible for the automatic fix loop.
    pub fn is_auto_fixable(&self) -> bool {
        matches!(self.action, FindingAction::AutoFix)
            && !matches!(self.severity, ValidationSeverity::Info)
    }
}

/// Raw finding shape returned by the sidecar submit tools (before Rust stamps
/// id/source). Category is accepted (docs/lint roles) but not persisted.
#[derive(Debug, Clone, Deserialize)]
pub struct RawAgentFinding {
    #[serde(default = "default_warning_str")]
    pub severity: String,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub action: Option<String>,
}

fn default_warning_str() -> String {
    "warning".to_string()
}

impl RawAgentFinding {
    /// Convert to a fully-formed finding, applying fail-closed action mapping.
    pub fn into_finding(self) -> ValidationFinding {
        ValidationFinding {
            id: String::new(),
            severity: ValidationSeverity::parse(&self.severity),
            file: self.file.filter(|s| !s.trim().is_empty()),
            line: self.line,
            description: self.description,
            action: match self.action {
                Some(a) => FindingAction::parse(&a),
                None => FindingAction::AskUser,
            },
            source: "agent".to_string(),
            user_instructions: None,
        }
    }
}

/// Assign deterministic ids `<step>-<n>` (1-based) to a freshly-parsed set of
/// agent findings, in order.
pub fn assign_agent_finding_ids(step: StepName, findings: &mut [ValidationFinding]) {
    for (i, f) in findings.iter_mut().enumerate() {
        f.id = format!("{}-{}", step.key(), i + 1);
        if f.source.is_empty() {
            f.source = "agent".to_string();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepStatus {
    Pending,
    Running,
    Fixing,
    Gate,
    FixReview,
    Passed,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Running,
    Gate,
    Passed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepRound {
    pub round: u32,
    /// "initial" | "auto_fix" | "user_fix"
    pub trigger: String,
    pub findings: Vec<ValidationFinding>,
    pub selected_ids: Vec<String>,
    #[serde(default)]
    pub fix_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StepProof {
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub output_tail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceArtifact {
    pub kind: String,
    pub label: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceReport {
    #[serde(default)]
    pub tested: Vec<String>,
    #[serde(default)]
    pub testing_summary: String,
    #[serde(default)]
    pub artifacts: Vec<EvidenceArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationStep {
    pub name: StepName,
    pub status: StepStatus,
    #[serde(default)]
    pub rounds: Vec<StepRound>,
    #[serde(default)]
    pub findings: Vec<ValidationFinding>,
    #[serde(default)]
    pub proof: Option<StepProof>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub transcript: Option<String>,
    #[serde(default)]
    pub risk_level: Option<String>,
    #[serde(default)]
    pub risk_rationale: Option<String>,
    #[serde(default)]
    pub evidence: Option<EvidenceReport>,
    #[serde(default)]
    pub fix_review_diff: Option<String>,
    #[serde(default)]
    pub started_at: Option<u64>,
    #[serde(default)]
    pub finished_at: Option<u64>,
}

impl ValidationStep {
    pub fn new(name: StepName) -> Self {
        Self {
            name,
            status: StepStatus::Pending,
            rounds: Vec::new(),
            findings: Vec::new(),
            proof: None,
            note: None,
            transcript: None,
            risk_level: None,
            risk_rationale: None,
            evidence: None,
            fix_review_diff: None,
            started_at: None,
            finished_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipProposal {
    pub commit_message: String,
    pub pr_title: String,
    pub pr_body: String,
    pub base_branch: String,
    pub branch: String,
    pub has_uncommitted: bool,
    pub already_pushed: bool,
    #[serde(default)]
    pub existing_pr_url: Option<String>,
    pub on_default_branch: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateState {
    pub step: StepName,
    /// "findings" | "fix_review" | "ship" | "ci_failure"
    pub kind: String,
    #[serde(default)]
    pub findings: Vec<ValidationFinding>,
    #[serde(default)]
    pub ship: Option<ShipProposal>,
    #[serde(default)]
    pub diff: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOptions {
    pub steps: Vec<StepName>,
    /// Claude model id, or "session" (= use the session's model).
    pub reviewer_model: String,
    #[serde(default)]
    pub reviewer_effort: Option<String>,
    #[serde(default)]
    pub adversarial_verify: bool,
    #[serde(default)]
    pub base_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationRun {
    pub id: String,
    pub session_id: String,
    pub cwd: String,
    pub status: RunStatus,
    pub steps: Vec<ValidationStep>,
    #[serde(default)]
    pub gate: Option<GateState>,
    pub intent: String,
    pub options: RunOptions,
    #[serde(default)]
    pub pr_url: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub pending_fix: bool,
    pub started_at: u64,
    #[serde(default)]
    pub finished_at: Option<u64>,
}

impl ValidationRun {
    /// Find a step by name (mutable).
    pub fn step_mut(&mut self, name: StepName) -> Option<&mut ValidationStep> {
        self.steps.iter_mut().find(|s| s.name == name)
    }

    /// Terminal statuses that mean a new run may replace this one.
    pub fn is_finished(&self) -> bool {
        matches!(
            self.status,
            RunStatus::Passed | RunStatus::Failed | RunStatus::Cancelled
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_fail_closed_on_unknown() {
        assert_eq!(FindingAction::parse("auto-fix"), FindingAction::AutoFix);
        assert_eq!(FindingAction::parse("no-op"), FindingAction::NoOp);
        assert_eq!(FindingAction::parse("ask-user"), FindingAction::AskUser);
        // Unknown / garbage / empty all fall closed to AskUser.
        assert_eq!(FindingAction::parse("maybe"), FindingAction::AskUser);
        assert_eq!(FindingAction::parse(""), FindingAction::AskUser);
        assert_eq!(FindingAction::parse("APPROVE"), FindingAction::AskUser);
    }

    #[test]
    fn finding_deserialize_missing_action_is_ask_user() {
        // Agent JSON with no action field must not silently pass — fail closed.
        let f: ValidationFinding =
            serde_json::from_str(r#"{ "description": "x", "severity": "warning" }"#).unwrap();
        assert_eq!(f.action, FindingAction::AskUser);
    }

    #[test]
    fn finding_deserialize_unknown_action_is_ask_user() {
        let f: ValidationFinding =
            serde_json::from_str(r#"{ "description": "x", "action": "ship-it" }"#).unwrap();
        assert_eq!(f.action, FindingAction::AskUser);
    }

    #[test]
    fn raw_finding_maps_fields_and_fails_closed() {
        let raw: RawAgentFinding = serde_json::from_str(
            r#"{ "severity": "error", "file": "a.rs", "description": "boom", "action": "weird" }"#,
        )
        .unwrap();
        let f = raw.into_finding();
        assert_eq!(f.severity, ValidationSeverity::Error);
        assert_eq!(f.file.as_deref(), Some("a.rs"));
        assert_eq!(f.action, FindingAction::AskUser);
        assert_eq!(f.source, "agent");
    }

    #[test]
    fn id_normalization_is_deterministic() {
        let mut findings = vec![
            RawAgentFinding {
                severity: "error".into(),
                file: None,
                line: None,
                description: "a".into(),
                action: Some("auto-fix".into()),
            }
            .into_finding(),
            RawAgentFinding {
                severity: "info".into(),
                file: None,
                line: None,
                description: "b".into(),
                action: Some("no-op".into()),
            }
            .into_finding(),
        ];
        assign_agent_finding_ids(StepName::Review, &mut findings);
        assert_eq!(findings[0].id, "review-1");
        assert_eq!(findings[1].id, "review-2");
    }

    #[test]
    fn gate_routing_blocks_error_warning_askuser_not_info() {
        let mk = |sev: ValidationSeverity, act: FindingAction| ValidationFinding {
            id: "x".into(),
            severity: sev,
            file: None,
            line: None,
            description: String::new(),
            action: act,
            source: "agent".into(),
            user_instructions: None,
        };
        // error / warning severity blocks regardless of action.
        assert!(mk(ValidationSeverity::Error, FindingAction::AutoFix).blocks());
        assert!(mk(ValidationSeverity::Warning, FindingAction::NoOp).blocks());
        // ask-user always blocks, even at info severity.
        assert!(mk(ValidationSeverity::Info, FindingAction::AskUser).blocks());
        // info + non-ask-user passes.
        assert!(!mk(ValidationSeverity::Info, FindingAction::NoOp).blocks());
        assert!(!mk(ValidationSeverity::Info, FindingAction::AutoFix).blocks());
    }

    #[test]
    fn auto_fixable_excludes_info() {
        let mk = |sev, act| ValidationFinding {
            id: "x".into(),
            severity: sev,
            file: None,
            line: None,
            description: String::new(),
            action: act,
            source: "agent".into(),
            user_instructions: None,
        };
        assert!(mk(ValidationSeverity::Error, FindingAction::AutoFix).is_auto_fixable());
        assert!(!mk(ValidationSeverity::Info, FindingAction::AutoFix).is_auto_fixable());
        assert!(!mk(ValidationSeverity::Error, FindingAction::AskUser).is_auto_fixable());
    }
}
