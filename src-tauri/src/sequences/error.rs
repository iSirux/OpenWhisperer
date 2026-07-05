//! Typed errors for the sequence executor internals (T1).
//!
//! The executor historically threaded `Result<_, String>` everywhere, which made
//! it impossible for the retry logic to tell a transient command failure (worth
//! retrying) from a permanent template/authoring bug (never worth retrying) or a
//! cooperative cancellation (must not be retried at all).
//!
//! We keep the surface small and pragmatic: node executors return
//! `Result<Option<Value>, SequenceError>`, the engine inspects the kind to decide
//! retryability, and everything collapses back to `String` at the manager / Tauri
//! command boundary via [`From<SequenceError> for String`].

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SequenceError {
    /// The execution was cancelled cooperatively. Never retried.
    #[error("{0}")]
    Cancelled(String),

    /// A node exceeded its timeout. Retryable (a later attempt may succeed).
    #[error("{0}")]
    Timeout(String),

    /// A template render / eval failed — an authoring bug. Never retried.
    #[error("{0}")]
    Template(String),

    /// An external command / process / IO / network failure. Retryable.
    #[error("{0}")]
    Command(String),

    /// Anything else (validation, config lookup, logic errors). Retryable by
    /// default so behaviour matches the previous stringly-typed model.
    #[error("{0}")]
    Other(String),
}

impl SequenceError {
    pub fn template(e: impl std::fmt::Display) -> Self {
        SequenceError::Template(format!("Template error: {}", e))
    }

    pub fn command(e: impl std::fmt::Display) -> Self {
        SequenceError::Command(e.to_string())
    }

    pub fn timeout(e: impl std::fmt::Display) -> Self {
        SequenceError::Timeout(e.to_string())
    }

    pub fn cancelled(e: impl std::fmt::Display) -> Self {
        SequenceError::Cancelled(e.to_string())
    }

    pub fn other(e: impl std::fmt::Display) -> Self {
        SequenceError::Other(e.to_string())
    }

    /// Whether the engine should retry a node that failed with this error.
    /// Template bugs and cancellation are never retried.
    pub fn is_retryable(&self) -> bool {
        !matches!(self, SequenceError::Template(_) | SequenceError::Cancelled(_))
    }
}

/// Bare strings (from the many `format!`-based call sites and from helpers that
/// still return `Result<_, String>`) fold into the generic `Other` kind.
impl From<String> for SequenceError {
    fn from(s: String) -> Self {
        SequenceError::Other(s)
    }
}

impl From<&str> for SequenceError {
    fn from(s: &str) -> Self {
        SequenceError::Other(s.to_string())
    }
}

/// Collapse back to `String` at the command / manager boundary.
impl From<SequenceError> for String {
    fn from(e: SequenceError) -> String {
        e.to_string()
    }
}
