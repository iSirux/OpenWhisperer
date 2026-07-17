//! Native Validation pipeline: a per-session run (review → test → docs → lint →
//! ship → ci) orchestrated natively in Rust. The successor to the external
//! No Mistakes integration — same concept layer (Finding model, gate semantics,
//! prompt discipline, intent grounding) with a fully typed, in-process transport
//! (sidecar one-shot agents + native git/gh) and no parsing layer.
//!
//! - [`types`]: the data model, emitted verbatim on `validation-update-{run_id}`.
//! - [`prompts`]: reviewer/verify/evidence/docs/lint prompt construction.
//! - [`ship`]: ship-proposal computation + commit/push/PR execution.
//! - [`executor`]: [`ValidationManager`] + the per-run tokio task.

pub mod executor;
pub mod prompts;
pub mod ship;
pub mod types;

pub use executor::ValidationManager;
