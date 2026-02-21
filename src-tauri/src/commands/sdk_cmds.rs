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
    sidecar.send(OutboundMessage::Create { id, cwd, model: Some(model), system_prompt, messages, sdk_session_id, plan_mode, note_mode, mcp_servers })
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
pub fn update_sdk_thinking(
    sidecar: State<Arc<SidecarManager>>,
    id: String,
    max_thinking_tokens: Option<u32>,
) -> Result<(), String> {
    if !sidecar.is_started() {
        return Err("Sidecar not started".to_string());
    }
    sidecar.send(OutboundMessage::UpdateThinking { id, max_thinking_tokens })
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
