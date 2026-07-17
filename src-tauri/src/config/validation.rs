//! Configuration for the native Validation pipeline (review/test/docs/lint/ship/ci).
//!
//! `ValidationConfig` lives on `AppConfig`; per-repo overrides live on
//! `RepoConfig` (`validation_commands`, `review_guidelines`, `validation_steps`).
//! On-disk keys are snake_case (matching the rest of the config module); the
//! runtime event payloads in `crate::validation::types` use camelCase instead.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Global validation settings, seeded per-run and overridable per-repo.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationConfig {
    /// Steps enabled by default for a new run (fixed order applied by the executor).
    #[serde(default = "default_validation_steps")]
    pub default_steps: Vec<String>,
    /// Reviewer model id, or the literal `"session"` to reuse the session's model.
    #[serde(default = "default_reviewer_model")]
    pub reviewer_model: String,
    /// Reviewer effort level ("low"|"medium"|"high"|"xhigh"|"max"). Effort is
    /// always on; `None` (pre-grounding configs) is treated as "medium".
    #[serde(default = "default_reviewer_effort")]
    pub reviewer_effort: Option<String>,
    /// When true, each review `error` finding gets an adversarial verify pass.
    #[serde(default)]
    pub adversarial_verify: bool,
    /// When true, the test step runs the evidence-gathering agent.
    #[serde(default = "crate::config::default_true")]
    pub evidence_enabled: bool,
    /// Per-step auto-fix round limits (keys: review/test/docs/lint/ci).
    #[serde(default = "default_auto_fix_limits")]
    pub auto_fix_limits: HashMap<String, u32>,
    /// Idle timeout for the CI step, in minutes.
    #[serde(default = "default_ci_timeout_minutes")]
    pub ci_timeout_minutes: u32,
    /// Overall time cap for a single validation agent call, in minutes. Agents
    /// also have a fixed 10-minute idle window that resets on every streamed
    /// tool call / text block, so this cap only cuts off runaways.
    #[serde(default = "default_agent_timeout_minutes")]
    pub agent_timeout_minutes: u32,
}

/// Per-repo test/lint commands used by the test and lint steps.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ValidationCommands {
    #[serde(default)]
    pub test: Option<String>,
    #[serde(default)]
    pub lint: Option<String>,
}

pub(crate) fn default_validation_steps() -> Vec<String> {
    vec!["review".to_string(), "test".to_string(), "lint".to_string()]
}

fn default_reviewer_model() -> String {
    "claude-sonnet-5".to_string()
}

fn default_reviewer_effort() -> Option<String> {
    Some("medium".to_string())
}

fn default_ci_timeout_minutes() -> u32 {
    45
}

fn default_agent_timeout_minutes() -> u32 {
    60
}

/// Default per-step auto-fix limits: review 0, test 2, docs 0, lint 2, ci 2.
pub(crate) fn default_auto_fix_limits() -> HashMap<String, u32> {
    let mut m = HashMap::new();
    m.insert("review".to_string(), 0);
    m.insert("test".to_string(), 2);
    m.insert("docs".to_string(), 0);
    m.insert("lint".to_string(), 2);
    m.insert("ci".to_string(), 2);
    m
}

impl Default for ValidationConfig {
    fn default() -> Self {
        Self {
            default_steps: default_validation_steps(),
            reviewer_model: default_reviewer_model(),
            reviewer_effort: default_reviewer_effort(),
            adversarial_verify: false,
            evidence_enabled: true,
            auto_fix_limits: default_auto_fix_limits(),
            ci_timeout_minutes: default_ci_timeout_minutes(),
            agent_timeout_minutes: default_agent_timeout_minutes(),
        }
    }
}

impl ValidationConfig {
    /// Auto-fix round limit for a step, defaulting to the built-in table then 0.
    pub fn auto_fix_limit(&self, step: &str) -> u32 {
        if let Some(v) = self.auto_fix_limits.get(step) {
            return *v;
        }
        *default_auto_fix_limits().get(step).unwrap_or(&0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_spec() {
        let c = ValidationConfig::default();
        assert_eq!(c.default_steps, vec!["review", "test", "lint"]);
        assert_eq!(c.reviewer_model, "claude-sonnet-5");
        assert_eq!(c.reviewer_effort.as_deref(), Some("medium"));
        assert!(!c.adversarial_verify);
        assert!(c.evidence_enabled);
        assert_eq!(c.ci_timeout_minutes, 45);
        assert_eq!(c.agent_timeout_minutes, 60);
        assert_eq!(c.auto_fix_limit("review"), 0);
        assert_eq!(c.auto_fix_limit("test"), 2);
        assert_eq!(c.auto_fix_limit("docs"), 0);
        assert_eq!(c.auto_fix_limit("lint"), 2);
        assert_eq!(c.auto_fix_limit("ci"), 2);
    }

    #[test]
    fn partial_json_fills_defaults() {
        // A config that only sets adversarial_verify should still get every other
        // field from the defaults (serde per-field default).
        let c: ValidationConfig =
            serde_json::from_str(r#"{ "adversarial_verify": true }"#).unwrap();
        assert!(c.adversarial_verify);
        assert_eq!(c.reviewer_model, "claude-sonnet-5");
        assert_eq!(c.auto_fix_limit("lint"), 2);
    }
}
