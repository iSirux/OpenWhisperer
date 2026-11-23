//! The board view's commands: Brainant's Kanban boards over its REST API. The address and the
//! personal access token are kept together in the OS keyring (service "open-whisperer").
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_keyring::KeyringExt;

use crate::brainant::{BoardSnapshot, BrainantBoard, BrainantClient, DEFAULT_BASE_URL};

const KEYRING_SERVICE: &str = "open-whisperer";
const KEYRING_KEY: &str = "brainant-api";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredConnection {
    base_url: String,
    token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainantConnection {
    pub connected: bool,
    pub base_url: String,
}

fn load(app: &AppHandle) -> Result<Option<StoredConnection>, String> {
    match app.keyring().get_password(KEYRING_SERVICE, KEYRING_KEY) {
        Ok(Some(json)) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| format!("Could not read the Brainant connection: {}", e)),
        Ok(None) => Ok(None),
        Err(e) => Err(format!("Could not read the keyring: {}", e)),
    }
}

fn client(app: &AppHandle) -> Result<BrainantClient, String> {
    let stored = load(app)?.ok_or_else(|| {
        "Brainant is not connected: paste an access token from Brainant's Settings → Access tokens."
            .to_string()
    })?;
    Ok(BrainantClient::new(&stored.base_url, &stored.token))
}

#[tauri::command]
pub async fn brainant_connection(app: AppHandle) -> Result<BrainantConnection, String> {
    let stored = load(&app)?;
    Ok(BrainantConnection {
        connected: stored.is_some(),
        base_url: stored
            .map(|s| s.base_url)
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
    })
}

/// Checks the token against Brainant and keeps it when it works; answers the boards it reaches.
#[tauri::command]
pub async fn brainant_connect(
    app: AppHandle,
    base_url: Option<String>,
    token: String,
) -> Result<Vec<BrainantBoard>, String> {
    let base_url = base_url
        .map(|u| u.trim().trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    let token = token.trim().to_string();
    if !token.starts_with("bra_") {
        return Err("That is not a Brainant access token (they start with bra_).".to_string());
    }
    let boards = BrainantClient::new(&base_url, &token).boards().await?;
    let json = serde_json::to_string(&StoredConnection { base_url, token })
        .map_err(|e| format!("Could not keep the connection: {}", e))?;
    app.keyring()
        .set_password(KEYRING_SERVICE, KEYRING_KEY, &json)
        .map_err(|e| format!("Could not save the token in the keyring: {}", e))?;
    Ok(boards)
}

#[tauri::command]
pub async fn brainant_disconnect(app: AppHandle) -> Result<(), String> {
    match app.keyring().delete_password(KEYRING_SERVICE, KEYRING_KEY) {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Could not remove the token from the keyring: {}", e)),
    }
}

#[tauri::command]
pub async fn brainant_boards(app: AppHandle) -> Result<Vec<BrainantBoard>, String> {
    client(&app)?.boards().await
}

#[tauri::command]
pub async fn brainant_board_cards(
    app: AppHandle,
    board: String,
    include_done: bool,
) -> Result<BoardSnapshot, String> {
    client(&app)?.snapshot(&board, include_done).await
}

#[tauri::command]
pub async fn brainant_move_card(
    app: AppHandle,
    board: String,
    card: i64,
    column: String,
) -> Result<(), String> {
    client(&app)?.move_card(&board, card, &column).await
}
