//! In-app local LLM (llama.cpp `llama-server`) configuration.
//!
//! Everything here is written by the one-click setup in Settings → LLM (see
//! `crate::local_llm`). The server itself is reached through a regular LLM
//! profile (id [`LOCAL_LLM_PROFILE_ID`], provider `Local`) so the existing
//! fast/quality routing chains need no special casing.

use serde::{Deserialize, Serialize};

use super::default_true;

/// Id of the LLM profile the setup creates/updates for the managed server.
pub const LOCAL_LLM_PROFILE_ID: &str = "local-llamacpp";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LocalLlmConfig {
    /// Start the server when the app launches (only acts once a runtime and a
    /// model are installed).
    #[serde(default = "default_true")]
    pub auto_start: bool,
    /// Installed llama.cpp runtime directory (versioned, contains `llama-server`).
    #[serde(default)]
    pub runtime_dir: Option<String>,
    /// llama.cpp release tag of the installed runtime (e.g. `b11222`).
    #[serde(default)]
    pub runtime_version: Option<String>,
    /// Build variant of the installed runtime (`cuda-13.4`, `vulkan`, `cpu`, `metal`, …).
    #[serde(default)]
    pub runtime_variant: Option<String>,
    /// Absolute path of the model the server loads.
    #[serde(default)]
    pub model_path: Option<String>,
    /// Display/model name (sent as the profile's model and shown in the UI).
    #[serde(default)]
    pub model_name: Option<String>,
    /// Curated preset the model came from (`None` = user-supplied file).
    #[serde(default)]
    pub preset_id: Option<String>,
    /// Where preset models are downloaded. `None` = `<config dir>/local-llm/models`.
    /// Models are large, so users may point this at a roomier drive.
    #[serde(default)]
    pub models_dir: Option<String>,
    /// Preferred port. If it is taken the server falls back to the next free
    /// one and the profile endpoint follows.
    #[serde(default = "default_port")]
    pub port: u16,
    /// Context window passed as `-c`.
    #[serde(default = "default_context_size")]
    pub context_size: u32,
    /// Put the local profile first in the quality chain (background features).
    #[serde(default = "default_true")]
    pub use_for_quality: bool,
    /// Also put it first in the fast chain (instant features).
    #[serde(default)]
    pub use_for_fast: bool,
}

fn default_port() -> u16 {
    1234
}

fn default_context_size() -> u32 {
    32768
}

impl Default for LocalLlmConfig {
    fn default() -> Self {
        Self {
            auto_start: true,
            runtime_dir: None,
            runtime_version: None,
            runtime_variant: None,
            model_path: None,
            model_name: None,
            preset_id: None,
            models_dir: None,
            port: default_port(),
            context_size: default_context_size(),
            use_for_quality: true,
            use_for_fast: false,
        }
    }
}

impl LocalLlmConfig {
    /// A runtime and a model are both configured (the setup has completed once).
    pub fn is_set_up(&self) -> bool {
        self.runtime_dir.is_some() && self.model_path.is_some()
    }
}
