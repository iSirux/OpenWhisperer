use crate::config::{AppConfig, McpAuthType};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_keyring::KeyringExt;

/// Service name for keyring storage
const KEYRING_SERVICE: &str = "open-whisperer";

#[derive(Debug, Serialize)]
pub struct McpTestResult {
    pub success: bool,
    pub error: Option<String>,
}

/// OAuth token data stored in keyring
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpOAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<u64>, // Unix timestamp in seconds
    pub token_type: String,
}

/// Result of starting OAuth flow
#[derive(Debug, Serialize)]
pub struct OAuthFlowResult {
    pub authorization_url: String,
    pub state: String,
    pub code_verifier: String,
}

/// OAuth token response from the token endpoint
#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
}

/// Generate a cryptographically random string for PKCE and state
fn generate_random_string(length: usize) -> String {
    let mut rng = rand::rng();
    let bytes: Vec<u8> = (0..length).map(|_| rng.random()).collect();
    URL_SAFE_NO_PAD.encode(&bytes)
}

/// Generate PKCE code verifier and challenge
fn generate_pkce() -> (String, String) {
    let code_verifier = generate_random_string(32);
    let mut hasher = Sha256::new();
    hasher.update(code_verifier.as_bytes());
    let hash = hasher.finalize();
    let code_challenge = URL_SAFE_NO_PAD.encode(&hash);
    (code_verifier, code_challenge)
}

/// Get the keyring key for an MCP server's tokens
fn get_token_key(server_id: &str) -> String {
    format!("mcp-oauth-{}", server_id)
}

/// Get the keyring key for an MCP server's bearer token
fn get_bearer_token_key(server_id: &str) -> String {
    format!("mcp-bearer-{}", server_id)
}

/// Look up an MCP server by id, or return a stable "not found" error.
fn find_server<'a>(
    config: &'a AppConfig,
    server_id: &str,
) -> Result<&'a crate::config::McpServerConfig, String> {
    config
        .mcp
        .servers
        .iter()
        .find(|s| s.id == server_id)
        .ok_or_else(|| format!("Server not found: {}", server_id))
}

/// Persist an OAuth token response to the keyring. `fallback_refresh` is used
/// when the response omits a refresh token (e.g. a refresh grant that only
/// returns a new access token) so the existing refresh token is retained.
fn store_tokens(
    app: &AppHandle,
    server_id: &str,
    resp: TokenResponse,
    fallback_refresh: Option<String>,
) -> Result<(), String> {
    let expires_at = resp
        .expires_in
        .map(|expires_in| crate::util::now_secs() + expires_in);

    let tokens = McpOAuthTokens {
        access_token: resp.access_token,
        refresh_token: resp.refresh_token.or(fallback_refresh),
        expires_at,
        token_type: resp.token_type,
    };

    let tokens_json =
        serde_json::to_string(&tokens).map_err(|e| format!("Failed to serialize tokens: {}", e))?;

    app.keyring()
        .set_password(KEYRING_SERVICE, &get_token_key(server_id), &tokens_json)
        .map_err(|e| format!("Failed to save OAuth tokens: {}", e))?;

    Ok(())
}

/// Load stored OAuth tokens, returning `None` when absent OR expired (with a
/// 60s buffer). Centralizing the expiry check keeps `get_mcp_oauth_tokens` and
/// `get_mcp_auth_header` consistent.
fn load_tokens(app: &AppHandle, server_id: &str) -> Result<Option<McpOAuthTokens>, String> {
    let tokens_json = match app
        .keyring()
        .get_password(KEYRING_SERVICE, &get_token_key(server_id))
    {
        Ok(Some(json)) => json,
        Ok(None) => return Ok(None),
        Err(e) => return Err(format!("Failed to get OAuth tokens: {}", e)),
    };

    let tokens: McpOAuthTokens = serde_json::from_str(&tokens_json)
        .map_err(|e| format!("Failed to parse tokens: {}", e))?;

    if let Some(expires_at) = tokens.expires_at {
        if crate::util::now_secs() + 60 >= expires_at {
            return Ok(None);
        }
    }

    Ok(Some(tokens))
}

/// Test an MCP server connection (for HTTP/SSE servers)
#[tauri::command]
pub async fn test_mcp_server(server_id: String) -> Result<McpTestResult, String> {
    let (config, _) = AppConfig::load();
    let server = find_server(&config, &server_id)?;

    // Only HTTP/SSE servers can be tested
    match server.server_type {
        crate::config::McpServerType::Stdio => {
            // Stdio servers can't be tested without running them
            Ok(McpTestResult {
                success: true,
                error: None,
            })
        }
        crate::config::McpServerType::Http | crate::config::McpServerType::Sse => {
            let url = server
                .url
                .clone()
                .ok_or_else(|| "Server URL not configured".to_string())?;

            // Try to connect to the server
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

            match client.get(&url).send().await {
                Ok(response) => {
                    if response.status().is_success() || response.status().is_informational() {
                        Ok(McpTestResult {
                            success: true,
                            error: None,
                        })
                    } else {
                        Ok(McpTestResult {
                            success: false,
                            error: Some(format!("Server returned status: {}", response.status())),
                        })
                    }
                }
                Err(e) => Ok(McpTestResult {
                    success: false,
                    error: Some(format!("Connection failed: {}", e)),
                }),
            }
        }
    }
}

/// Save a bearer token for an MCP server (for simple API key auth)
#[tauri::command]
pub async fn save_mcp_bearer_token(
    app: AppHandle,
    server_id: String,
    token: String,
) -> Result<(), String> {
    app.keyring()
        .set_password(KEYRING_SERVICE, &get_bearer_token_key(&server_id), &token)
        .map_err(|e| format!("Failed to save bearer token: {}", e))?;
    Ok(())
}

/// Get a bearer token for an MCP server
#[tauri::command]
pub async fn get_mcp_bearer_token(
    app: AppHandle,
    server_id: String,
) -> Result<Option<String>, String> {
    match app
        .keyring()
        .get_password(KEYRING_SERVICE, &get_bearer_token_key(&server_id))
    {
        Ok(token) => Ok(token),
        Err(e) => Err(format!("Failed to get bearer token: {}", e)),
    }
}

/// Delete a bearer token for an MCP server
#[tauri::command]
pub async fn delete_mcp_bearer_token(app: AppHandle, server_id: String) -> Result<(), String> {
    match app
        .keyring()
        .delete_password(KEYRING_SERVICE, &get_bearer_token_key(&server_id))
    {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Failed to delete bearer token: {}", e)),
    }
}

/// Check if an MCP server has a stored token (bearer or OAuth)
#[tauri::command]
pub async fn has_mcp_token(app: AppHandle, server_id: String) -> Result<bool, String> {
    let (config, _) = AppConfig::load();
    let server = find_server(&config, &server_id)?;

    match server.auth_type {
        McpAuthType::None => Ok(false),
        McpAuthType::BearerToken => {
            match app
                .keyring()
                .get_password(KEYRING_SERVICE, &get_bearer_token_key(&server_id))
            {
                Ok(Some(_)) => Ok(true),
                Ok(None) => Ok(false),
                Err(_) => Ok(false),
            }
        }
        McpAuthType::OAuth => {
            match app
                .keyring()
                .get_password(KEYRING_SERVICE, &get_token_key(&server_id))
            {
                Ok(Some(_)) => Ok(true),
                Ok(None) => Ok(false),
                Err(_) => Ok(false),
            }
        }
    }
}

/// Start the OAuth flow for an MCP server (returns authorization URL to open in browser)
#[tauri::command]
pub async fn start_mcp_oauth_flow(server_id: String) -> Result<OAuthFlowResult, String> {
    let (config, _) = AppConfig::load();
    let server = find_server(&config, &server_id)?;

    let oauth = server
        .oauth
        .as_ref()
        .ok_or_else(|| "OAuth not configured for this server".to_string())?;

    let client_id = oauth
        .client_id
        .as_ref()
        .ok_or_else(|| "OAuth client_id not configured".to_string())?;

    let authorization_url = oauth
        .authorization_url
        .as_ref()
        .ok_or_else(|| "OAuth authorization_url not configured".to_string())?;

    let redirect_uri = oauth
        .redirect_uri
        .as_ref()
        .map(|s| s.as_str())
        .unwrap_or("http://localhost:19256/callback");

    // Generate PKCE code verifier and challenge
    let (code_verifier, code_challenge) = generate_pkce();

    // Generate state for CSRF protection
    let state = generate_random_string(16);

    // Build authorization URL with required OAuth 2.1 parameters
    let mut url = url::Url::parse(authorization_url)
        .map_err(|e| format!("Invalid authorization URL: {}", e))?;

    {
        let mut params = url.query_pairs_mut();
        params.append_pair("response_type", "code");
        params.append_pair("client_id", client_id);
        params.append_pair("redirect_uri", redirect_uri);
        params.append_pair("state", &state);
        params.append_pair("code_challenge", &code_challenge);
        params.append_pair("code_challenge_method", "S256");

        if let Some(scopes) = &oauth.scopes {
            params.append_pair("scope", scopes);
        }
    }

    Ok(OAuthFlowResult {
        authorization_url: url.to_string(),
        state,
        code_verifier,
    })
}

/// Exchange an authorization code for tokens (called after OAuth callback)
#[tauri::command]
pub async fn exchange_mcp_oauth_code(
    app: AppHandle,
    server_id: String,
    code: String,
    code_verifier: String,
) -> Result<(), String> {
    let (config, _) = AppConfig::load();
    let server = find_server(&config, &server_id)?;

    let oauth = server
        .oauth
        .as_ref()
        .ok_or_else(|| "OAuth not configured for this server".to_string())?;

    let client_id = oauth
        .client_id
        .as_ref()
        .ok_or_else(|| "OAuth client_id not configured".to_string())?;

    let token_url = oauth
        .token_url
        .as_ref()
        .ok_or_else(|| "OAuth token_url not configured".to_string())?;

    let redirect_uri = oauth
        .redirect_uri
        .as_ref()
        .map(|s| s.as_str())
        .unwrap_or("http://localhost:19256/callback");

    // Exchange code for tokens
    let client = reqwest::Client::new();
    let response = client
        .post(token_url)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", redirect_uri),
            ("client_id", client_id),
            ("code_verifier", &code_verifier),
        ])
        .send()
        .await
        .map_err(|e| format!("Failed to exchange code for tokens: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("Token exchange failed ({}): {}", status, body));
    }

    let token_response: TokenResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    store_tokens(&app, &server_id, token_response, None)
}

/// Refresh OAuth tokens for an MCP server
#[tauri::command]
pub async fn refresh_mcp_oauth_tokens(app: AppHandle, server_id: String) -> Result<(), String> {
    let (config, _) = AppConfig::load();
    let server = find_server(&config, &server_id)?;

    let oauth = server
        .oauth
        .as_ref()
        .ok_or_else(|| "OAuth not configured for this server".to_string())?;

    let client_id = oauth
        .client_id
        .as_ref()
        .ok_or_else(|| "OAuth client_id not configured".to_string())?;

    let token_url = oauth
        .token_url
        .as_ref()
        .ok_or_else(|| "OAuth token_url not configured".to_string())?;

    // Get current tokens (raw read: we need the refresh token even if the
    // access token is expired, so this bypasses `load_tokens`' expiry check).
    let tokens_json = app
        .keyring()
        .get_password(KEYRING_SERVICE, &get_token_key(&server_id))
        .map_err(|e| format!("Failed to get stored tokens: {}", e))?
        .ok_or_else(|| "No OAuth tokens stored for this server".to_string())?;

    let current_tokens: McpOAuthTokens = serde_json::from_str(&tokens_json)
        .map_err(|e| format!("Failed to parse stored tokens: {}", e))?;

    let refresh_token = current_tokens
        .refresh_token
        .ok_or_else(|| "No refresh token available".to_string())?;

    // Refresh tokens
    let client = reqwest::Client::new();
    let response = client
        .post(token_url)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh_token),
            ("client_id", client_id),
        ])
        .send()
        .await
        .map_err(|e| format!("Failed to refresh tokens: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("Token refresh failed ({}): {}", status, body));
    }

    let token_response: TokenResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    // Retain the existing refresh token if the response omits a new one.
    store_tokens(&app, &server_id, token_response, Some(refresh_token))
}

/// Get OAuth tokens for an MCP server (returns None if not authenticated or expired)
#[tauri::command]
pub async fn get_mcp_oauth_tokens(
    app: AppHandle,
    server_id: String,
) -> Result<Option<McpOAuthTokens>, String> {
    // Applies the shared expiry check (matches this command's documented
    // "returns None if ... expired" contract).
    load_tokens(&app, &server_id)
}

/// Delete OAuth tokens for an MCP server (logout)
#[tauri::command]
pub async fn delete_mcp_oauth_tokens(app: AppHandle, server_id: String) -> Result<(), String> {
    match app
        .keyring()
        .delete_password(KEYRING_SERVICE, &get_token_key(&server_id))
    {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Failed to delete OAuth tokens: {}", e)),
    }
}

/// Get the authorization header value for an MCP server (handles both bearer tokens and OAuth)
/// Returns None if no auth is configured or tokens are missing
#[tauri::command]
pub async fn get_mcp_auth_header(
    app: AppHandle,
    server_id: String,
) -> Result<Option<String>, String> {
    let (config, _) = AppConfig::load();
    let server = find_server(&config, &server_id)?;

    match server.auth_type {
        McpAuthType::None => Ok(None),
        McpAuthType::BearerToken => {
            match app
                .keyring()
                .get_password(KEYRING_SERVICE, &get_bearer_token_key(&server_id))
            {
                Ok(Some(token)) => Ok(Some(format!("Bearer {}", token))),
                Ok(None) => Ok(None),
                Err(e) => Err(format!("Failed to get bearer token: {}", e)),
            }
        }
        McpAuthType::OAuth => match load_tokens(&app, &server_id)? {
            Some(tokens) => Ok(Some(format!(
                "{} {}",
                tokens.token_type, tokens.access_token
            ))),
            None => Ok(None),
        },
    }
}
