use crate::config::McpServerConfig;
use crate::sidecar::{HistoryMessage, ImageData, OutboundMessage, SidecarManager};
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn start_sidecar(
    app: AppHandle,
    sidecar: State<Arc<SidecarManager>>,
) -> Result<(), String> {
    sidecar.start(app)
}

#[tauri::command]
pub fn create_sdk_session(
    sidecar: State<Arc<SidecarManager>>,
    id: String,
    cwd: String,
    model: String, // Per-session model (required)
    provider: Option<String>, // Optional provider override (e.g., "openai-codex")
    system_prompt: Option<String>, // Optional system prompt (e.g., for voice transcription context)
    messages: Option<Vec<HistoryMessage>>, // Optional conversation history for restored sessions (DEPRECATED - use sdk_session_id)
    sdk_session_id: Option<String>, // SDK session ID for proper resume (preferred over messages)
    plan_mode: Option<bool>, // Whether this is a plan mode session (enables planning tools)
    note_mode: Option<bool>, // Whether this is a note-taking mode session (read-only + note MCP tools)
    mcp_servers: Option<Vec<McpServerConfig>>, // Optional MCP servers to register
) -> Result<(), String> {
    if !sidecar.is_started() {
        return Err("Sidecar not started. Call start_sidecar first.".to_string());
    }
    sidecar.send(OutboundMessage::Create { id, cwd, provider, model: Some(model), system_prompt, messages, sdk_session_id, plan_mode, note_mode, mcp_servers })
}

#[tauri::command]
pub fn send_sdk_prompt(
    sidecar: State<Arc<SidecarManager>>,
    id: String,
    prompt: String,
    images: Option<Vec<ImageData>>,
) -> Result<(), String> {
    if !sidecar.is_started() {
        return Err("Sidecar not started".to_string());
    }
    sidecar.send(OutboundMessage::Query { id, prompt, images })
}

#[tauri::command]
pub fn stop_sdk_query(
    sidecar: State<Arc<SidecarManager>>,
    id: String,
) -> Result<(), String> {
    if !sidecar.is_started() {
        return Err("Sidecar not started".to_string());
    }
    sidecar.send(OutboundMessage::Stop { id })
}

#[tauri::command]
pub fn update_sdk_model(
    sidecar: State<Arc<SidecarManager>>,
    id: String,
    model: String,
) -> Result<(), String> {
    if !sidecar.is_started() {
        return Err("Sidecar not started".to_string());
    }
    sidecar.send(OutboundMessage::UpdateModel { id, model })
}

#[tauri::command]
pub fn update_sdk_effort(
    sidecar: State<Arc<SidecarManager>>,
    id: String,
    effort_level: Option<String>,
) -> Result<(), String> {
    if !sidecar.is_started() {
        return Err("Sidecar not started".to_string());
    }
    sidecar.send(OutboundMessage::UpdateEffort { id, effort_level })
}

#[tauri::command]
pub fn close_sdk_session(
    sidecar: State<Arc<SidecarManager>>,
    id: String,
) -> Result<(), String> {
    if !sidecar.is_started() {
        return Err("Sidecar not started".to_string());
    }
    sidecar.send(OutboundMessage::Close { id })
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
    // Start sidecar if not already running
    if !sidecar.is_started() {
        sidecar.start(app)?;
    }

    sidecar.send(OutboundMessage::GenerateRepoDescription {
        id,
        repo_path,
        repo_name,
    })
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
    // Start sidecar if not already running
    if !sidecar.is_started() {
        sidecar.start(app)?;
    }

    sidecar.send(OutboundMessage::GenerateRepoDescriptionWithCodex {
        id,
        repo_path,
        repo_name,
    })
}

/// Check if OpenAI Codex authentication is available
/// Checks for ~/.codex/auth.json or the codex CLI
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
        "authenticated": has_auth_file || has_cli,
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
        .set_password("claude-whisperer", "openai-api-key", &api_key)
        .map_err(|e| format!("Failed to save API key: {}", e))
}

/// Check if OpenAI API key exists in keyring
#[tauri::command]
pub fn has_openai_api_key(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_keyring::KeyringExt;
    match app.keyring().get_password("claude-whisperer", "openai-api-key") {
        Ok(Some(_)) => Ok(true),
        _ => Ok(false),
    }
}

/// Delete OpenAI API key from keyring
#[tauri::command]
pub fn delete_openai_api_key(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_keyring::KeyringExt;
    app.keyring()
        .delete_password("claude-whisperer", "openai-api-key")
        .map_err(|e| format!("Failed to delete API key: {}", e))
}

/// Check if Claude/Anthropic authentication is available
/// Checks for ANTHROPIC_API_KEY env var, ~/.claude/.credentials.json, or keyring
#[tauri::command]
pub fn check_claude_auth(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let has_env_key = std::env::var("ANTHROPIC_API_KEY").is_ok();

    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    // Claude CLI stores credentials at ~/.claude/.credentials.json
    let credentials_path = home.join(".claude").join(".credentials.json");
    let has_oauth = credentials_path.exists();

    // Check if we have an API key stored in keyring
    let has_keyring_key = {
        use tauri_plugin_keyring::KeyringExt;
        matches!(
            app.keyring().get_password("claude-whisperer", "anthropic-api-key"),
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
        .set_password("claude-whisperer", "anthropic-api-key", &api_key)
        .map_err(|e| format!("Failed to save API key: {}", e))
}

/// Check if Anthropic API key exists in keyring
#[tauri::command]
pub fn has_claude_api_key(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_keyring::KeyringExt;
    match app.keyring().get_password("claude-whisperer", "anthropic-api-key") {
        Ok(Some(_)) => Ok(true),
        _ => Ok(false),
    }
}

/// Delete Anthropic API key from keyring
#[tauri::command]
pub fn delete_claude_api_key(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_keyring::KeyringExt;
    app.keyring()
        .delete_password("claude-whisperer", "anthropic-api-key")
        .map_err(|e| format!("Failed to delete API key: {}", e))
}
