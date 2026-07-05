//! MCP (Model Context Protocol) server configuration.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// MCP server transport type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum McpServerType {
    #[default]
    Stdio,
    Http,
    Sse,
}

/// MCP server authentication type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum McpAuthType {
    /// No authentication
    #[default]
    None,
    /// Static bearer token (API key style)
    BearerToken,
    /// OAuth 2.1 authorization code flow with PKCE
    OAuth,
}

/// OAuth 2.1 configuration for MCP servers
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct McpOAuthConfig {
    /// OAuth client ID (public, safe to store in config)
    #[serde(default)]
    pub client_id: Option<String>,
    /// Authorization endpoint URL
    #[serde(default)]
    pub authorization_url: Option<String>,
    /// Token endpoint URL
    #[serde(default)]
    pub token_url: Option<String>,
    /// Scopes to request (space-separated)
    #[serde(default)]
    pub scopes: Option<String>,
    /// Redirect URI for OAuth callback (default: http://localhost:19256/callback)
    #[serde(default)]
    pub redirect_uri: Option<String>,
}

/// Configuration for an individual MCP server
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    /// Unique identifier for this server
    pub id: String,
    /// Display name
    pub name: String,
    /// Transport type (stdio, http, sse)
    #[serde(default)]
    pub server_type: McpServerType,
    /// Command to run (for stdio servers)
    #[serde(default)]
    pub command: Option<String>,
    /// Command arguments (for stdio servers)
    #[serde(default)]
    pub args: Option<Vec<String>>,
    /// Environment variables
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    /// URL endpoint (for HTTP/SSE servers)
    #[serde(default)]
    pub url: Option<String>,
    /// Whether this server is enabled
    #[serde(default = "default_mcp_enabled")]
    pub enabled: bool,
    /// Authentication type for HTTP/SSE servers
    #[serde(default)]
    pub auth_type: McpAuthType,
    /// OAuth configuration (when auth_type is OAuth)
    #[serde(default)]
    pub oauth: Option<McpOAuthConfig>,
    /// Custom headers for HTTP/SSE servers (non-sensitive, stored in config)
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
}

fn default_mcp_enabled() -> bool {
    true
}

/// Global MCP configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct McpConfig {
    /// List of global MCP servers
    #[serde(default)]
    pub servers: Vec<McpServerConfig>,
}
