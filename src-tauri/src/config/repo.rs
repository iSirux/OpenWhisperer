//! Repository configuration and launch-command/profile definitions.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::default_true;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoConfig {
    /// Stable unique identifier for this repository (auto-generated UUID).
    #[serde(default)]
    pub id: Option<String>,
    pub path: String,
    pub name: String,
    /// Auto-generated description of the repository for auto-selection
    #[serde(default)]
    pub description: Option<String>,
    /// Domain-specific keywords for matching prompts to this repository (around 20 keywords)
    #[serde(default)]
    pub keywords: Option<Vec<String>>,
    /// Project-specific vocabulary/lingo for transcription cleanup and repo matching (20-50 words)
    /// Unlike keywords which are categorical, vocabulary captures the actual terms/jargon used in the codebase
    #[serde(default)]
    pub vocabulary: Option<Vec<String>>,
    /// Icon key from the curated icon set (e.g., "globe", "terminal", "database")
    #[serde(default)]
    pub icon: Option<String>,
    /// Primary/brand color as hex string (e.g., "#6366f1")
    #[serde(default)]
    pub color: Option<String>,
    /// List of MCP server IDs to use for this repository (overrides global servers)
    #[serde(default)]
    pub mcp_servers: Option<Vec<String>>,
    /// List of MCP server IDs to use for note-taking mode in this repository
    #[serde(default)]
    pub note_mcp_servers: Option<Vec<String>>,
    /// Tags for multi-repo sequence filtering (e.g., "frontend", "backend", "infra")
    #[serde(default)]
    pub tags: Vec<String>,
    /// Whether this repo is active (shown in selectors, eligible for auto-select).
    /// Defaults to true for backward compatibility with existing configs.
    #[serde(default = "default_true")]
    pub active: bool,
    /// Files to copy from main worktree when creating a new worktree (e.g., ".env", "settings.local.json")
    #[serde(default)]
    pub worktree_copy_files: Vec<String>,
    /// Commands to run in a new worktree after creation (e.g., "npm install")
    #[serde(default)]
    pub worktree_post_create_commands: Vec<String>,
    /// Base branch for new worktrees (e.g., "origin/main", "origin/dev").
    /// If empty/None, auto-detects the remote default branch.
    #[serde(default)]
    pub worktree_base_branch: Option<String>,
    /// Last selected worktree mode for this repo: "main", "new", or "existing"
    #[serde(default = "default_worktree_mode")]
    pub worktree_mode: String,
    /// Launch commands available for this repository (dev servers, watchers, etc.)
    #[serde(default)]
    pub launch_commands: Vec<LaunchCommand>,
    /// Launch profiles - named groups of launch commands for one-click startup
    #[serde(default)]
    pub launch_profiles: Vec<LaunchProfile>,
}

/// A single runnable command/service for a repository (e.g., "npm run dev")
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchCommand {
    /// Unique identifier (UUID)
    pub id: String,
    /// Display name (e.g., "Frontend Dev Server")
    pub name: String,
    /// Shell command to execute (e.g., "npm run dev")
    pub command: String,
    /// Working directory relative to repo root (for monorepo sub-projects).
    /// If None, uses the repo root.
    #[serde(default)]
    pub working_dir: Option<String>,
    /// Extra environment variables to set
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    /// Whether this command was auto-detected by scanning the repo
    #[serde(default)]
    pub auto_detected: bool,
}

/// A named group of launch commands that can be started together
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchProfile {
    /// Unique identifier (UUID)
    pub id: String,
    /// Display name (e.g., "Full Stack", "Frontend Only")
    pub name: String,
    /// List of LaunchCommand IDs to include in this profile
    pub command_ids: Vec<String>,
}

fn default_worktree_mode() -> String {
    "main".to_string()
}
