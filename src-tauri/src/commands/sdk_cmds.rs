use crate::commands::settings_cmds::ConfigState;
use crate::config::McpServerConfig;
use crate::sidecar::{HistoryMessage, ImageData, OutboundMessage, SidecarManager};
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn start_sidecar(app: AppHandle, sidecar: State<Arc<SidecarManager>>) -> Result<(), String> {
    sidecar.start(app)
}

#[tauri::command]
pub async fn create_sdk_session(
    sidecar: State<'_, Arc<SidecarManager>>,
    config: State<'_, ConfigState>,
    id: String,
    cwd: String,
    model: String,                             // Per-session model (required)
    provider: Option<String>,                  // Optional provider override (e.g., "openai-codex")
    codex_mode: Option<String>,                // Optional OpenAI codex mode ("Sdk" | "AppServer")
    system_prompt: Option<String>, // Optional system prompt (e.g., for voice transcription context)
    messages: Option<Vec<HistoryMessage>>, // Optional conversation history for restored sessions (DEPRECATED - use sdk_session_id)
    sdk_session_id: Option<String>, // SDK session ID for proper resume (preferred over messages)
    mcp_servers: Option<Vec<McpServerConfig>>, // Optional MCP servers to register
    fork_from_sdk_session_id: Option<String>, // SDK session ID to fork from (creates a new branch)
    fork_at_message_uuid: Option<String>, // Message UUID to fork at (resumeSessionAt)
    autocompact_pct: Option<u32>, // Claude-only: 0=DISABLE_AUTO_COMPACT, 1..=99=PCT_OVERRIDE, None/100=default
    gh_user: Option<String>,      // GitHub CLI account to pin this session to (via GH_TOKEN)
    account_id: Option<String>,   // Agent account to pin this session to (CLAUDE_CONFIG_DIR / CODEX_HOME)
) -> Result<(), String> {
    // Pin gh to a specific account for this session by injecting its token.
    // Best-effort: a resolution failure falls back to gh's active account.
    let gh_env = crate::commands::github_cmds::gh_session_env(gh_user.as_deref()).await;
    // Pin the session to an agent account by injecting its login-profile env var
    // (rides the same rail as gh). Reserved/unknown ids inject nothing.
    let account_env = crate::config::account_session_env(&config.lock(), account_id.as_deref());
    // Claude-only interactive permission mode (acceptEdits by default; opt-in "auto").
    // Read from config here so no per-session frontend plumbing is needed. The sidecar
    // applies it only on the Claude path; OpenAI/Codex sessions ignore it.
    // Codex-only permission mode maps to the app-server's approvalPolicy + sandbox.
    let (permission_mode, codex_approval_policy, codex_sandbox_mode) = {
        let cfg = config.lock();
        (
            Some(cfg.claude_permission_mode.as_sdk_str().to_string()),
            Some(cfg.codex_permission_mode.approval_policy().to_string()),
            cfg.codex_permission_mode.sandbox_mode().map(str::to_string),
        )
    };
    let mut env_pairs = gh_env;
    env_pairs.extend(account_env);
    let env = if env_pairs.is_empty() {
        None
    } else {
        Some(env_pairs.into_iter().collect())
    };

    // Started/alive guard is folded into `SidecarManager::send` (I3).
    sidecar.send(OutboundMessage::Create {
        id,
        cwd,
        provider,
        codex_mode,
        model: Some(model),
        system_prompt,
        messages,
        sdk_session_id,
        mcp_servers,
        fork_from_sdk_session_id,
        fork_at_message_uuid,
        autocompact_pct,
        permission_mode,
        codex_approval_policy,
        codex_sandbox_mode,
        env,
    })
}

#[tauri::command]
pub fn send_sdk_prompt(
    sidecar: State<Arc<SidecarManager>>,
    id: String,
    prompt: String,
    images: Option<Vec<ImageData>>,
) -> Result<(), String> {
    sidecar.send(OutboundMessage::Query { id, prompt, images })
}

#[tauri::command]
pub fn stop_sdk_query(sidecar: State<Arc<SidecarManager>>, id: String) -> Result<(), String> {
    sidecar.send(OutboundMessage::Stop { id })
}

/// Trigger conversation-history compaction for a Codex app-server session. (For
/// Claude the frontend sends `/compact` through the normal prompt path instead.)
#[tauri::command]
pub fn compact_sdk_session(sidecar: State<Arc<SidecarManager>>, id: String) -> Result<(), String> {
    sidecar.send(OutboundMessage::Compact { id })
}

#[tauri::command]
pub fn update_sdk_model(
    sidecar: State<Arc<SidecarManager>>,
    id: String,
    model: String,
) -> Result<(), String> {
    sidecar.send(OutboundMessage::UpdateModel { id, model })
}

#[tauri::command]
pub fn update_sdk_effort(
    sidecar: State<Arc<SidecarManager>>,
    id: String,
    effort_level: Option<String>,
) -> Result<(), String> {
    sidecar.send(OutboundMessage::UpdateEffort { id, effort_level })
}

#[tauri::command]
pub fn close_sdk_session(sidecar: State<Arc<SidecarManager>>, id: String) -> Result<(), String> {
    sidecar.send(OutboundMessage::Close { id })
}

/// Send user's answers to an AskUserQuestion tool call back to the sidecar.
/// The sidecar's canUseTool callback is waiting for these answers.
#[tauri::command]
pub fn answer_ask_user_question(
    sidecar: State<Arc<SidecarManager>>,
    id: String,
    answers: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    sidecar.send(OutboundMessage::AnswerAskUserQuestion { id, answers })
}

/// Send user's plan approval decision back to the sidecar.
/// The sidecar's canUseTool callback is waiting for this decision.
#[tauri::command]
pub fn answer_plan_approval(
    sidecar: State<Arc<SidecarManager>>,
    id: String,
    action: String,
    feedback: Option<String>,
) -> Result<(), String> {
    sidecar.send(OutboundMessage::AnswerPlanApproval {
        id,
        action,
        feedback,
    })
}

/// Send user's Codex app-server approval decision back to the sidecar, which
/// responds to the pending JSON-RPC approval request identified by `request_id`.
#[tauri::command]
pub fn answer_codex_approval(
    sidecar: State<Arc<SidecarManager>>,
    id: String,
    request_id: u64,
    decision: String,
) -> Result<(), String> {
    sidecar.send(OutboundMessage::AnswerCodexApproval {
        id,
        request_id,
        decision,
    })
}

/// Generate repository description using Claude SDK (Haiku model)
/// This explores the codebase with tools and generates description, keywords, vocabulary.
/// Results are returned via `repo-description-result-{id}` event.
/// Errors are returned via `repo-description-error-{id}` event.
#[tauri::command]
pub fn generate_repo_description_with_claude(
    app: AppHandle,
    sidecar: State<Arc<SidecarManager>>,
    id: String,
    repo_path: String,
    repo_name: String,
) -> Result<(), String> {
    sidecar.send_or_start(
        app,
        OutboundMessage::GenerateRepoDescription {
            id,
            repo_path,
            repo_name,
        },
    )
}

/// Generate repository description using Codex SDK
/// This explores the codebase with Codex tools and generates description, keywords, vocabulary.
/// Results are returned via `repo-description-result-{id}` event.
/// Errors are returned via `repo-description-error-{id}` event.
#[tauri::command]
pub fn generate_repo_description_with_codex(
    app: AppHandle,
    sidecar: State<Arc<SidecarManager>>,
    id: String,
    repo_path: String,
    repo_name: String,
) -> Result<(), String> {
    sidecar.send_or_start(
        app,
        OutboundMessage::GenerateRepoDescriptionWithCodex {
            id,
            repo_path,
            repo_name,
        },
    )
}

/// Generate launch profile (commands + profiles) using Claude SDK.
/// This explores the codebase and generates runnable commands and logical profiles.
/// Results are returned via `launch-profile-result-{id}` event.
/// Errors are returned via `launch-profile-error-{id}` event.
#[tauri::command]
pub fn generate_launch_profile_with_claude(
    app: AppHandle,
    sidecar: State<Arc<SidecarManager>>,
    id: String,
    repo_path: String,
    repo_name: String,
) -> Result<(), String> {
    sidecar.send_or_start(
        app,
        OutboundMessage::GenerateLaunchProfile {
            id,
            repo_path,
            repo_name,
        },
    )
}

/// Generate launch profile (commands + profiles) using Codex SDK.
/// Results are returned via `launch-profile-result-{id}` event.
/// Errors are returned via `launch-profile-error-{id}` event.
#[tauri::command]
pub fn generate_launch_profile_with_codex(
    app: AppHandle,
    sidecar: State<Arc<SidecarManager>>,
    id: String,
    repo_path: String,
    repo_name: String,
) -> Result<(), String> {
    sidecar.send_or_start(
        app,
        OutboundMessage::GenerateLaunchProfileWithCodex {
            id,
            repo_path,
            repo_name,
        },
    )
}

/// Check if OpenAI Codex authentication is available
/// Checks for ~/.codex/auth.json and codex CLI presence
#[tauri::command]
pub fn check_openai_codex_auth() -> Result<serde_json::Value, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let auth_path = home.join(".codex").join("auth.json");
    let has_auth_file = auth_path.exists();

    // Check if codex CLI is available
    let has_cli = std::process::Command::new("codex")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    Ok(serde_json::json!({
        "hasAuthFile": has_auth_file,
        "hasCli": has_cli,
        // CLI presence means login is possible, not that the user is authenticated.
        "authenticated": has_auth_file,
    }))
}

/// Run `codex login` to authenticate with OpenAI
#[tauri::command]
pub async fn run_codex_login() -> Result<bool, String> {
    let output = tokio::process::Command::new("codex")
        .arg("login")
        .output()
        .await
        .map_err(|e| format!("Failed to run codex login: {}", e))?;

    Ok(output.status.success())
}

/// Save OpenAI API key to secure keyring storage
#[tauri::command]
pub fn save_openai_api_key(app: tauri::AppHandle, api_key: String) -> Result<(), String> {
    use tauri_plugin_keyring::KeyringExt;
    app.keyring()
        .set_password("open-whisperer", "openai-api-key", &api_key)
        .map_err(|e| format!("Failed to save API key: {}", e))
}

/// Check if OpenAI API key exists in keyring
#[tauri::command]
pub fn has_openai_api_key(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_keyring::KeyringExt;
    match app
        .keyring()
        .get_password("open-whisperer", "openai-api-key")
    {
        Ok(Some(_)) => Ok(true),
        _ => Ok(false),
    }
}

/// Delete OpenAI API key from keyring
#[tauri::command]
pub fn delete_openai_api_key(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_keyring::KeyringExt;
    app.keyring()
        .delete_password("open-whisperer", "openai-api-key")
        .map_err(|e| format!("Failed to delete API key: {}", e))
}

/// Check if Claude/Anthropic authentication is available
/// Checks for ANTHROPIC_API_KEY env var, ~/.claude/.credentials.json, or keyring
#[tauri::command]
pub fn check_claude_auth(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let has_env_key = std::env::var("ANTHROPIC_API_KEY").is_ok();

    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    // Claude CLI stores credentials at ~/.claude/.credentials.json — except on
    // macOS, where it uses the login Keychain (service "Claude Code-credentials").
    let credentials_path = home.join(".claude").join(".credentials.json");
    let has_oauth = credentials_path.exists() || claude_keychain_login_exists();

    // Check if we have an API key stored in keyring
    let has_keyring_key = {
        use tauri_plugin_keyring::KeyringExt;
        matches!(
            app.keyring()
                .get_password("open-whisperer", "anthropic-api-key"),
            Ok(Some(_))
        )
    };

    Ok(serde_json::json!({
        "hasEnvKey": has_env_key,
        "hasOAuth": has_oauth,
        "hasKeyringKey": has_keyring_key,
        "authenticated": has_env_key || has_oauth || has_keyring_key,
    }))
}

/// Save Anthropic API key to secure keyring storage
#[tauri::command]
pub fn save_claude_api_key(app: tauri::AppHandle, api_key: String) -> Result<(), String> {
    use tauri_plugin_keyring::KeyringExt;
    app.keyring()
        .set_password("open-whisperer", "anthropic-api-key", &api_key)
        .map_err(|e| format!("Failed to save API key: {}", e))
}

/// Check if Anthropic API key exists in keyring
#[tauri::command]
pub fn has_claude_api_key(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_keyring::KeyringExt;
    match app
        .keyring()
        .get_password("open-whisperer", "anthropic-api-key")
    {
        Ok(Some(_)) => Ok(true),
        _ => Ok(false),
    }
}

/// Delete Anthropic API key from keyring
#[tauri::command]
pub fn delete_claude_api_key(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_keyring::KeyringExt;
    app.keyring()
        .delete_password("open-whisperer", "anthropic-api-key")
        .map_err(|e| format!("Failed to delete API key: {}", e))
}

// --- Claude API Rate Limit Usage ---

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RateLimitWindow {
    pub utilization: f64,
    pub resets_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExtraUsage {
    pub is_enabled: bool,
    pub monthly_limit: Option<u64>,
    pub used_credits: Option<u64>,
    pub utilization: Option<f64>,
}

/// A per-model weekly window scoped to a specific model (e.g. Fable), surfaced
/// by the OAuth usage endpoint's `limits[]` array as `kind: "weekly_scoped"`.
/// The old top-level `seven_day_opus`/`seven_day_sonnet` fields are now null;
/// all per-model limits live here.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ScopedLimit {
    pub model: String,
    pub utilization: f64,
    pub severity: String,
    pub resets_at: String,
    pub is_active: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ClaudeRateLimits {
    pub five_hour: RateLimitWindow,
    pub seven_day: RateLimitWindow,
    pub extra_usage: ExtraUsage,
    /// Per-model weekly windows (e.g. Fable). Empty for Codex.
    #[serde(default)]
    pub scoped_windows: Vec<ScopedLimit>,
}

/// Read an OAuth credentials file and extract a bearer token from it (I7).
/// `missing_msg` is returned when the file doesn't exist; `extract` pulls the
/// token out of the parsed JSON.
fn read_bearer_token(
    path: &std::path::Path,
    missing_msg: &str,
    extract: impl Fn(&serde_json::Value) -> Option<String>,
) -> Result<String, String> {
    if !path.exists() {
        return Err(missing_msg.to_string());
    }
    let content =
        std::fs::read_to_string(path).map_err(|e| format!("Failed to read credentials: {}", e))?;
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse credentials: {}", e))?;
    extract(&value).ok_or_else(|| "OAuth access token not found in credentials".to_string())
}

/// Perform an authenticated GET returning parsed JSON, with network-error
/// classification shared between Claude and Codex (I7).
async fn authed_get_json(
    url: &str,
    token: &str,
    extra_headers: &[(&str, &str)],
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
    let mut request = client
        .get(url)
        .header("Authorization", format!("Bearer {}", token));
    for (k, v) in extra_headers {
        request = request.header(*k, *v);
    }
    let response = request.send().await.map_err(|e| {
        let cause = if e.is_timeout() {
            "request timed out"
        } else if e.is_connect() {
            "connection failed (check internet connectivity)"
        } else if e.is_request() {
            "failed to build request"
        } else {
            "unknown network error"
        };
        format!("Failed to fetch from {}: {} ({})", url, cause, e)
    })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("API error ({}) from {}: {}", status, url, body));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))
}

/// Claude Code's public OAuth client id (the same value the CLI uses).
const CLAUDE_OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/// Anthropic OAuth token endpoint used to refresh access tokens.
const CLAUDE_OAUTH_TOKEN_URL: &str = "https://console.anthropic.com/v1/oauth/token";

/// Current epoch time in milliseconds.
fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Read the Claude credentials JSON, falling back to the macOS Keychain when the
/// plaintext file is absent.
///
/// On macOS the Claude CLI stores its OAuth token in the login Keychain (a
/// generic-password item under the service name `Claude Code-credentials`) and
/// only writes `~/.claude/.credentials.json` on other platforms — so reading the
/// file alone reports "not logged in" on Mac even when the user is authenticated.
/// The Keychain fallback applies only to the machine-default login
/// (`allow_keychain`); configured account profiles always keep a plaintext file
/// inside their `CLAUDE_CONFIG_DIR`.
fn load_claude_credentials(
    path: &std::path::Path,
    allow_keychain: bool,
) -> Result<serde_json::Value, String> {
    if path.exists() {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read credentials: {}", e))?;
        return serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse credentials: {}", e));
    }

    #[cfg(target_os = "macos")]
    if allow_keychain {
        if let Some(value) = read_claude_keychain_credentials() {
            return Ok(value);
        }
    }
    let _ = allow_keychain; // used only on macOS

    Err("Claude OAuth credentials not found. Please log in via Claude CLI.".to_string())
}

/// Read the Claude Code OAuth credentials JSON from the macOS login Keychain.
/// Returns `None` if the item is missing or the user declines the access prompt.
#[cfg(target_os = "macos")]
fn read_claude_keychain_credentials() -> Option<serde_json::Value> {
    let output = std::process::Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(raw.trim()).ok()
}

/// Whether a Claude Code login exists in the macOS Keychain. Uses a metadata-only
/// lookup (no `-w`) so it never triggers the secret-access prompt. Always false
/// off macOS.
fn claude_keychain_login_exists() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("security")
            .args(["find-generic-password", "-s", "Claude Code-credentials"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Read accessToken, refreshToken, and expiresAt (epoch ms) from the Claude
/// credentials (plaintext file, or the macOS Keychain when `allow_keychain`).
fn read_claude_oauth(
    path: &std::path::Path,
    allow_keychain: bool,
) -> Result<(String, Option<String>, Option<u64>), String> {
    let value = load_claude_credentials(path, allow_keychain)?;
    let oauth = value.get("claudeAiOauth");
    let access = oauth
        .and_then(|o| o.get("accessToken"))
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .ok_or("OAuth access token not found in credentials")?;
    let refresh = oauth
        .and_then(|o| o.get("refreshToken"))
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());
    let expires_at = oauth
        .and_then(|o| o.get("expiresAt"))
        .and_then(|t| t.as_u64());
    Ok((access, refresh, expires_at))
}

/// Refresh the Claude OAuth access token using the stored refresh token, writing
/// the rotated tokens back to `.credentials.json` (the same file the CLI reads,
/// so both stay in sync). Returns the new access token.
///
/// The app can sit idle for hours (e.g. overnight) with no CLI activity, so its
/// stored access token expires and the usage API starts returning 401. The CLI
/// only refreshes when *it* runs, so we mirror that refresh here.
async fn refresh_claude_oauth(
    credentials_path: &std::path::Path,
    refresh_token: &str,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CLAUDE_OAUTH_CLIENT_ID,
    });

    let response = client
        .post(CLAUDE_OAUTH_TOKEN_URL)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Token refresh request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Token refresh failed ({}): {}", status, text));
    }

    let token_data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse token refresh response: {}", e))?;

    let new_access = token_data["access_token"]
        .as_str()
        .ok_or("Token refresh response missing access_token")?
        .to_string();
    let new_refresh = token_data["refresh_token"].as_str().map(|s| s.to_string());
    let expires_in = token_data["expires_in"].as_u64();

    // Merge rotated tokens back into the existing credentials, preserving all other
    // fields (scopes, subscriptionType, rateLimitTier, ...).
    let mut creds: serde_json::Value = std::fs::read_to_string(credentials_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_else(|| serde_json::json!({ "claudeAiOauth": {} }));

    if let Some(oauth) = creds
        .get_mut("claudeAiOauth")
        .and_then(|o| o.as_object_mut())
    {
        oauth.insert("accessToken".into(), serde_json::json!(new_access));
        if let Some(rt) = &new_refresh {
            oauth.insert("refreshToken".into(), serde_json::json!(rt));
        }
        if let Some(exp) = expires_in {
            let expires_at = now_ms() as u64 + exp * 1000;
            oauth.insert("expiresAt".into(), serde_json::json!(expires_at));
        }
    }

    // Only mirror back to a file that already exists — on macOS the token lives
    // in the Keychain (no plaintext file), and writing one would leave stale
    // credentials the CLI never rotates. The refreshed token is still returned
    // and used for the current request regardless.
    if credentials_path.exists() {
        if let Ok(serialized) = serde_json::to_string_pretty(&creds) {
            // Best-effort write-back; a write failure doesn't invalidate the fetched token.
            let _ = std::fs::write(credentials_path, serialized);
        }
    }

    Ok(new_access)
}

/// Fetch Claude Code rate limit usage from Anthropic OAuth API
#[tauri::command]
pub async fn fetch_claude_rate_limits(
    account_id: Option<String>,
    config: State<'_, ConfigState>,
) -> Result<ClaudeRateLimits, String> {
    // Resolve the credentials path from the pinned account (default/None keeps the
    // machine-default login). Clone the path out before any await — never hold the
    // parking_lot guard across a suspension point.
    let account_path = crate::config::account_credentials_path(
        &config.lock(),
        account_id.as_deref(),
        crate::config::SdkProvider::Claude,
    )?;
    // The macOS Keychain fallback applies only to the machine-default login;
    // configured account profiles always use a plaintext file in their dir.
    let allow_keychain = account_path.is_none();
    let credentials_path = match account_path {
        Some(p) => p,
        None => {
            let home = dirs::home_dir().ok_or("Could not find home directory")?;
            home.join(".claude").join(".credentials.json")
        }
    };

    let (mut token, refresh_token, expires_at) =
        read_claude_oauth(&credentials_path, allow_keychain)?;

    // Proactively refresh if the stored access token is expired or about to expire
    // (60s buffer) — the common overnight-idle case that otherwise 401s and hides
    // the usage indicator until the CLI is next run.
    if let (Some(exp), Some(rt)) = (expires_at, refresh_token.as_ref()) {
        if now_ms() + 60_000 >= exp as u128 {
            if let Ok(new_token) = refresh_claude_oauth(&credentials_path, rt).await {
                token = new_token;
            }
        }
    }

    const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
    let headers: [(&str, &str); 2] = [
        ("anthropic-beta", "oauth-2025-04-20"),
        ("User-Agent", "claude-code/2.0.32"),
    ];

    let data = match authed_get_json(USAGE_URL, &token, &headers).await {
        Ok(d) => d,
        Err(e) => {
            // Reactive fallback: the token may have been revoked/expired without the
            // expiry check catching it (e.g. clock skew). Refresh once and retry.
            let looks_auth = e.contains("401") || e.to_lowercase().contains("unauthorized");
            match (looks_auth, refresh_token.as_ref()) {
                (true, Some(rt)) => {
                    let new_token = refresh_claude_oauth(&credentials_path, rt).await?;
                    authed_get_json(USAGE_URL, &new_token, &headers).await?
                }
                _ => return Err(e),
            }
        }
    };

    Ok(ClaudeRateLimits {
        five_hour: RateLimitWindow {
            utilization: data["five_hour"]["utilization"].as_f64().unwrap_or(0.0),
            resets_at: data["five_hour"]["resets_at"]
                .as_str()
                .unwrap_or("")
                .to_string(),
        },
        seven_day: RateLimitWindow {
            utilization: data["seven_day"]["utilization"].as_f64().unwrap_or(0.0),
            resets_at: data["seven_day"]["resets_at"]
                .as_str()
                .unwrap_or("")
                .to_string(),
        },
        extra_usage: ExtraUsage {
            is_enabled: data["extra_usage"]["is_enabled"].as_bool().unwrap_or(false),
            monthly_limit: data["extra_usage"]["monthly_limit"].as_u64(),
            used_credits: data["extra_usage"]["used_credits"].as_u64(),
            utilization: data["extra_usage"]["utilization"].as_f64(),
        },
        // Per-model weekly caps arrive in `limits[]` as `weekly_scoped` entries
        // carrying `scope.model.display_name` (e.g. "Fable").
        scoped_windows: data["limits"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter(|l| l["kind"].as_str() == Some("weekly_scoped"))
                    .filter_map(|l| {
                        let model = l["scope"]["model"]["display_name"].as_str()?.to_string();
                        Some(ScopedLimit {
                            model,
                            utilization: l["percent"].as_f64().unwrap_or(0.0),
                            severity: l["severity"].as_str().unwrap_or("").to_string(),
                            resets_at: l["resets_at"].as_str().unwrap_or("").to_string(),
                            is_active: l["is_active"].as_bool().unwrap_or(false),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

// --- Codex (OpenAI) API Rate Limit Usage ---

/// Convert epoch seconds to ISO 8601 string
fn epoch_to_iso(epoch: f64) -> String {
    use chrono::{DateTime, Utc};
    if let Some(dt) = DateTime::<Utc>::from_timestamp(epoch as i64, 0) {
        dt.to_rfc3339()
    } else {
        String::new()
    }
}

/// Fetch OpenAI Codex rate limit usage from ChatGPT API
/// Reuses the same ClaudeRateLimits struct (normalized to the same shape)
#[tauri::command]
pub async fn fetch_codex_rate_limits(
    account_id: Option<String>,
    config: State<'_, ConfigState>,
) -> Result<ClaudeRateLimits, String> {
    // Resolve the auth path from the pinned account (default/None keeps the
    // machine-default login). Clone the path out before any await.
    let account_path = crate::config::account_credentials_path(
        &config.lock(),
        account_id.as_deref(),
        crate::config::SdkProvider::OpenAI,
    )?;
    let auth_path = match account_path {
        Some(p) => p,
        None => {
            let home = dirs::home_dir().ok_or("Could not find home directory")?;
            home.join(".codex").join("auth.json")
        }
    };

    // Try common token locations: tokens.access_token (codex login), or top-level fields
    let token = read_bearer_token(
        &auth_path,
        "Codex OAuth credentials not found. Please run `codex login`.",
        |auth| {
            auth.get("tokens")
                .and_then(|t| t.get("access_token"))
                .or_else(|| auth.get("token"))
                .or_else(|| auth.get("access_token"))
                .or_else(|| auth.get("accessToken"))
                .and_then(|t| t.as_str())
                .map(|s| s.to_string())
        },
    )?;

    // Codex gets the same network-error classification as Claude (I7).
    let data = authed_get_json(
        "https://chatgpt.com/backend-api/wham/usage",
        &token,
        &[],
    )
    .await?;

    // Normalize Codex response to the same shape as Claude
    // Codex: rate_limit.primary_window / secondary_window with used_percent + reset_at (epoch)
    let primary = &data["rate_limit"]["primary_window"];
    let secondary = &data["rate_limit"]["secondary_window"];
    let credits = &data["credits"];

    Ok(ClaudeRateLimits {
        five_hour: RateLimitWindow {
            utilization: primary["used_percent"].as_f64().unwrap_or(0.0),
            resets_at: primary["reset_at"]
                .as_f64()
                .map(epoch_to_iso)
                .unwrap_or_default(),
        },
        seven_day: RateLimitWindow {
            utilization: secondary["used_percent"].as_f64().unwrap_or(0.0),
            resets_at: secondary["reset_at"]
                .as_f64()
                .map(epoch_to_iso)
                .unwrap_or_default(),
        },
        extra_usage: ExtraUsage {
            is_enabled: credits["is_enabled"].as_bool().unwrap_or(false),
            monthly_limit: credits["monthly_limit"].as_u64(),
            used_credits: credits["used_credits"].as_u64(),
            utilization: credits["utilization"].as_f64(),
        },
        // Codex has no per-model scoped windows.
        scoped_windows: Vec::new(),
    })
}
