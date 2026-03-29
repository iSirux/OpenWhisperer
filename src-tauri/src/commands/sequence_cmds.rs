use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::config::{AppConfig, LlmProvider};
use crate::llm::LlmClient;
use crate::sequences::scheduler::{ScheduleInfo, SequenceScheduler};
use crate::sequences::state::{ExecutionSummary, SequenceExecution};
use crate::sequences::types::SequenceDefinition;
use crate::sequences::SequenceManager;

// ─── Definition CRUD ────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_sequences(
    manager: State<Arc<SequenceManager>>,
) -> Result<Vec<SequenceDefinition>, String> {
    Ok(manager.get_definitions())
}

#[tauri::command]
pub fn get_sequence(
    manager: State<Arc<SequenceManager>>,
    id: String,
) -> Result<SequenceDefinition, String> {
    manager
        .get_definition(&id)
        .ok_or_else(|| format!("Sequence '{}' not found", id))
}

#[tauri::command]
pub fn save_sequence(
    manager: State<Arc<SequenceManager>>,
    definition: SequenceDefinition,
) -> Result<(), String> {
    manager.save_definition(definition)
}

#[tauri::command]
pub fn delete_sequence(manager: State<Arc<SequenceManager>>, id: String) -> Result<(), String> {
    manager.delete_definition(&id)
}

#[tauri::command]
pub fn import_sequence(
    manager: State<Arc<SequenceManager>>,
    yaml: String,
) -> Result<SequenceDefinition, String> {
    manager.import_sequence(&yaml)
}

#[tauri::command]
pub fn export_sequence(manager: State<Arc<SequenceManager>>, id: String) -> Result<String, String> {
    manager.export_sequence(&id)
}

#[tauri::command]
pub fn validate_sequence(
    manager: State<Arc<SequenceManager>>,
    yaml: String,
) -> Result<SequenceDefinition, String> {
    manager.validate_sequence(&yaml)
}

// ─── Execution Control ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_execution(
    manager: State<'_, Arc<SequenceManager>>,
    execution_id: Option<String>,
    sequence_id: String,
    inputs: HashMap<String, serde_json::Value>,
    dry_run: bool,
    entry_node_id: Option<String>,
) -> Result<String, String> {
    manager.start_execution_with_id(execution_id, &sequence_id, inputs, dry_run, entry_node_id)
}

#[tauri::command]
pub fn get_execution(
    manager: State<Arc<SequenceManager>>,
    execution_id: String,
) -> Result<SequenceExecution, String> {
    manager.get_execution(&execution_id)
}

#[tauri::command]
pub fn list_executions(
    manager: State<Arc<SequenceManager>>,
) -> Result<Vec<ExecutionSummary>, String> {
    manager.list_executions()
}

#[tauri::command]
pub fn dismiss_execution(
    manager: State<Arc<SequenceManager>>,
    execution_id: String,
) -> Result<(), String> {
    manager.dismiss_execution(&execution_id)
}

#[tauri::command]
pub fn pause_execution(
    manager: State<Arc<SequenceManager>>,
    execution_id: String,
) -> Result<(), String> {
    manager.pause_execution(&execution_id)
}

#[tauri::command]
pub fn resume_execution(
    manager: State<Arc<SequenceManager>>,
    execution_id: String,
) -> Result<(), String> {
    manager.resume_execution(&execution_id)
}

#[tauri::command]
pub fn cancel_execution(
    manager: State<Arc<SequenceManager>>,
    execution_id: String,
) -> Result<(), String> {
    manager.cancel_execution(&execution_id)
}

#[tauri::command]
pub fn approve_node(
    manager: State<Arc<SequenceManager>>,
    execution_id: String,
    node_id: String,
) -> Result<(), String> {
    manager.approve_node(&execution_id, &node_id)
}

#[tauri::command]
pub fn reject_node(
    manager: State<Arc<SequenceManager>>,
    execution_id: String,
    node_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    manager.reject_node(&execution_id, &node_id, reason)
}

#[tauri::command]
pub fn retry_node(
    manager: State<Arc<SequenceManager>>,
    execution_id: String,
    node_id: String,
) -> Result<(), String> {
    manager.retry_node(&execution_id, &node_id)
}

// ─── Notification Testing ──────────────────────────────────────────────────

#[tauri::command]
pub async fn test_notification_channel(
    _app: AppHandle,
    config: State<'_, Mutex<AppConfig>>,
    channel_id: String,
) -> Result<String, String> {
    let channel = {
        let cfg = config.lock();
        cfg.sequences
            .notification_channels
            .iter()
            .find(|c| c.id == channel_id)
            .cloned()
            .ok_or_else(|| format!("Channel '{}' not found", channel_id))?
    };

    let sender = crate::sequences::notifications::NotificationSender::new();
    sender
        .send(
            &channel,
            "Test Notification",
            "This is a test message from Claude Whisperer.",
            None,
        )
        .await?;
    Ok("Test notification sent successfully".to_string())
}

// ─── Scheduler Commands ─────────────────────────────────────────────────────

#[tauri::command]
pub fn list_schedules(
    manager: State<Arc<SequenceManager>>,
    scheduler: State<Arc<SequenceScheduler>>,
) -> Result<Vec<ScheduleInfo>, String> {
    Ok(scheduler.list_schedules(&manager))
}

#[tauri::command]
pub fn toggle_schedule(
    scheduler: State<Arc<SequenceScheduler>>,
    sequence_id: String,
    cron: String,
    enabled: bool,
) -> Result<(), String> {
    scheduler.toggle_schedule(&sequence_id, &cron, enabled)
}

// ─── Event Triggers ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_event_triggers(
    manager: State<Arc<SequenceManager>>,
) -> Result<Vec<crate::sequences::event_triggers::EventTriggerInfo>, String> {
    let defs = manager.get_definitions();
    Ok(manager.event_trigger_manager.list_active_triggers(&defs))
}

// ─── AI Generation ─────────────────────────────────────────────────────────

fn get_llm_api_key(app: &tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_keyring::KeyringExt;
    const KEYRING_SERVICE: &str = "claude-whisperer";
    const KEYRING_LLM_KEY: &str = "llm-api-key";
    match app.keyring().get_password(KEYRING_SERVICE, KEYRING_LLM_KEY) {
        Ok(Some(key)) => Ok(key),
        Ok(None) => Err("LLM API key not set".to_string()),
        Err(e) => Err(format!("Failed to get API key: {}", e)),
    }
}

fn create_llm_client(app: &tauri::AppHandle, config: &AppConfig) -> Result<LlmClient, String> {
    let llm_config = &config.llm;
    let api_key = if matches!(llm_config.provider, LlmProvider::Local) {
        get_llm_api_key(app).unwrap_or_default()
    } else {
        get_llm_api_key(app)?
    };
    Ok(LlmClient::new(
        api_key,
        llm_config.model.clone(),
        llm_config.provider.clone(),
        llm_config.endpoint.clone(),
        llm_config.auto_model,
        llm_config.model_priority.clone(),
    ))
}

#[tauri::command]
pub async fn generate_sequence_yaml(
    app: AppHandle,
    config: State<'_, Mutex<AppConfig>>,
    description: String,
) -> Result<String, String> {
    let (client, repos) = {
        let cfg = config.lock();
        let client = create_llm_client(&app, &cfg)?;
        let repos: Vec<String> = cfg.repos.iter().map(|r| r.path.clone()).collect();
        (client, repos)
    };

    let result =
        crate::sequences::ai_generation::generate_sequence(&client, &description, &repos).await?;
    Ok(result.data.yaml)
}

#[tauri::command]
pub async fn generate_node_config(
    app: AppHandle,
    config: State<'_, Mutex<AppConfig>>,
    node_type: String,
    description: String,
    context: String,
) -> Result<serde_json::Value, String> {
    let client = {
        let cfg = config.lock();
        create_llm_client(&app, &cfg)?
    };

    crate::sequences::ai_generation::generate_node(&client, &node_type, &description, &context)
        .await
}
