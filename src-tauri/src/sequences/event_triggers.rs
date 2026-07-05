//! Event-based trigger system for sequences.
//!
//! Listens for Tauri events (session completion, sequence completion, recording
//! completion, app start) and fires matching sequences when trigger conditions
//! are met.  Includes cooldown and max-per-day guards.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use chrono::{DateTime, NaiveDate, Utc};
use parking_lot::Mutex;
use tauri::{AppHandle, Listener};

use crate::sequences::types::SequenceTrigger;

/// Manages event-based trigger listeners and guard state.
pub struct EventTriggerManager {
    running: Arc<AtomicBool>,
    /// Cooldown / daily-limit state, shared (via `Arc`) with every registered
    /// listener closure so limits actually persist across firings.
    guard_state: Arc<Mutex<TriggerGuardState>>,
    /// Execution IDs that were spawned by triggers (for self-exclusion)
    triggered_execution_ids: Arc<Mutex<Vec<String>>>,
    /// Tauri event listener IDs for cleanup
    listener_ids: Mutex<Vec<tauri::EventId>>,
}

/// Tracks cooldown and daily firing limits for each trigger.
struct TriggerGuardState {
    /// Last fire time per trigger key (sequence_id + event_type)
    last_fire: HashMap<String, DateTime<Utc>>,
    /// Daily count per trigger key: (date, count)
    daily_count: HashMap<String, (NaiveDate, u32)>,
}

impl TriggerGuardState {
    fn new() -> Self {
        Self {
            last_fire: HashMap::new(),
            daily_count: HashMap::new(),
        }
    }
}

/// Build a sequence-input map from a trigger's string input map.
fn build_inputs(inputs: &Option<HashMap<String, String>>) -> HashMap<String, serde_json::Value> {
    inputs
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| (k, serde_json::Value::String(v)))
        .collect()
}

/// Check cooldown + daily-limit guards for `key` and, if the trigger is allowed
/// to fire, record the firing.  Returns whether the trigger may fire now.
///
/// Operates on the single shared guard state — fixing the bug where each
/// registration allocated its own throwaway state so limits never persisted (S8).
fn check_and_record_guards(
    guard_state: &Mutex<TriggerGuardState>,
    key: &str,
    cooldown_ms: u64,
    max_daily: u32,
) -> bool {
    let now = Utc::now();
    let today = now.date_naive();
    let mut gs = guard_state.lock();

    if cooldown_ms > 0 {
        if let Some(last) = gs.last_fire.get(key) {
            if ((now - *last).num_milliseconds() as u64) < cooldown_ms {
                return false; // still in cooldown
            }
        }
    }

    if let Some((date, count)) = gs.daily_count.get(key) {
        if *date == today && *count >= max_daily {
            return false; // daily limit reached
        }
    }

    gs.last_fire.insert(key.to_string(), now);
    let entry = gs.daily_count.entry(key.to_string()).or_insert((today, 0));
    if entry.0 != today {
        *entry = (today, 0);
    }
    entry.1 += 1;
    true
}

/// once-per-day guard for `app_start`. Returns whether firing is allowed today.
fn check_once_per_day(guard_state: &Mutex<TriggerGuardState>, key: &str) -> bool {
    let today = Utc::now().date_naive();
    let mut gs = guard_state.lock();
    if let Some((date, _)) = gs.daily_count.get(key) {
        if *date == today {
            return false;
        }
    }
    gs.daily_count.insert(key.to_string(), (today, 1));
    true
}

/// Spawn a sequence execution for a fired trigger, recording its execution id
/// for self-exclusion.
fn fire_trigger(
    manager: Arc<super::SequenceManager>,
    triggered_ids: Arc<Mutex<Vec<String>>>,
    seq_id: String,
    inputs_map: HashMap<String, serde_json::Value>,
    entry_node_id: Option<String>,
    context: &'static str,
) {
    tauri::async_runtime::spawn(async move {
        match manager.start_execution_at(&seq_id, inputs_map, false, entry_node_id) {
            Ok(exec_id) => {
                triggered_ids.lock().push(exec_id.clone());
                log::info!("[event-trigger] Fired '{}' ({}) -> execution {}", seq_id, context, exec_id);
            }
            Err(e) => {
                log::error!("[event-trigger] Failed to fire '{}': {}", seq_id, e);
            }
        }
    });
}

impl EventTriggerManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            guard_state: Arc::new(Mutex::new(TriggerGuardState::new())),
            triggered_execution_ids: Arc::new(Mutex::new(Vec::new())),
            listener_ids: Mutex::new(Vec::new()),
        }
    }

    /// Start listening for events that should trigger sequences.
    pub fn start(&self, app: &AppHandle, manager: Arc<super::SequenceManager>) {
        if self.running.swap(true, Ordering::SeqCst) {
            return; // Already running
        }

        let definitions = manager.get_definitions();
        let mut listener_ids = self.listener_ids.lock();

        for def in &definitions {
            for trigger in &def.triggers {
                let SequenceTrigger::Event {
                    event_type,
                    filter,
                    cooldown,
                    max_per_day,
                    once_per_day,
                    inputs,
                    entry_node_id,
                } = trigger
                else {
                    continue;
                };

                let trigger_key = format!("{}:{}", def.id, event_type);

                // app_start fires immediately (guarded by once_per_day).
                if event_type == "app_start" {
                    if once_per_day.unwrap_or(false)
                        && !check_once_per_day(&self.guard_state, &trigger_key)
                    {
                        continue; // already fired today
                    }
                    fire_trigger(
                        manager.clone(),
                        self.triggered_execution_ids.clone(),
                        def.id.clone(),
                        build_inputs(inputs),
                        entry_node_id.clone(),
                        "app_start",
                    );
                    continue; // no listener needed
                }

                // Determine the Tauri event pattern to listen for.
                let event_pattern = match event_type.as_str() {
                    "session_end" => "sdk-done-*",
                    "sequence_end" => "sequence-done-*",
                    "recording_end" => "recording-complete",
                    other => other, // custom event type
                };

                if let Some(id) = self.register_listener(
                    app,
                    manager.clone(),
                    def.id.clone(),
                    trigger_key,
                    filter.clone(),
                    inputs.clone(),
                    entry_node_id.clone(),
                    cooldown.unwrap_or(0),
                    max_per_day.unwrap_or(u32::MAX),
                    event_pattern,
                ) {
                    listener_ids.push(id);
                }
            }
        }
    }

    /// Register a single event listener that fires the given sequence, honoring
    /// self-exclusion and the shared cooldown/daily guards.
    #[allow(clippy::too_many_arguments)]
    fn register_listener(
        &self,
        app: &AppHandle,
        manager: Arc<super::SequenceManager>,
        sequence_id: String,
        trigger_key: String,
        filter: Option<HashMap<String, String>>,
        inputs: Option<HashMap<String, String>>,
        entry_node_id: Option<String>,
        cooldown_ms: u64,
        max_daily: u32,
        event_pattern: &str,
    ) -> Option<tauri::EventId> {
        let guard_state = self.guard_state.clone();
        let triggered_ids = self.triggered_execution_ids.clone();

        let id = app.listen(event_pattern, move |event| {
            // Self-exclusion: don't trigger on sessions spawned by sequences.
            let include_seq = filter
                .as_ref()
                .and_then(|f| f.get("_include_sequence_sessions"))
                .map(|v| v == "true")
                .unwrap_or(false);
            if !include_seq {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                    if let Some(sid) = payload.get("session_id").and_then(|v| v.as_str()) {
                        if sid.starts_with("seq-") {
                            return; // skip sequence-spawned sessions
                        }
                    }
                }
            }

            if !check_and_record_guards(&guard_state, &trigger_key, cooldown_ms, max_daily) {
                return;
            }

            fire_trigger(
                manager.clone(),
                triggered_ids.clone(),
                sequence_id.clone(),
                build_inputs(&inputs),
                entry_node_id.clone(),
                "event",
            );
        });

        Some(id)
    }

    /// Stop all event listeners.
    #[allow(dead_code)]
    pub fn stop(&self, app: &AppHandle) {
        self.running.store(false, Ordering::SeqCst);
        let mut listener_ids = self.listener_ids.lock();
        for id in listener_ids.drain(..) {
            app.unlisten(id);
        }
    }

    /// Check if an execution was spawned by an event trigger (for self-exclusion).
    #[allow(dead_code)]
    pub fn is_triggered_execution(&self, execution_id: &str) -> bool {
        self.triggered_execution_ids
            .lock()
            .contains(&execution_id.to_string())
    }

    /// Get info about active event triggers.
    pub fn list_active_triggers(
        &self,
        definitions: &[super::types::SequenceDefinition],
    ) -> Vec<EventTriggerInfo> {
        let mut triggers = Vec::new();
        let gs = self.guard_state.lock();

        for def in definitions {
            for trigger in &def.triggers {
                if let SequenceTrigger::Event {
                    event_type,
                    cooldown,
                    max_per_day,
                    once_per_day,
                    ..
                } = trigger
                {
                    let trigger_key = format!("{}:{}", def.id, event_type);
                    let last_fire = gs.last_fire.get(&trigger_key).cloned();
                    let today_count = gs
                        .daily_count
                        .get(&trigger_key)
                        .filter(|(d, _)| *d == Utc::now().date_naive())
                        .map(|(_, c)| *c)
                        .unwrap_or(0);

                    triggers.push(EventTriggerInfo {
                        sequence_id: def.id.clone(),
                        sequence_name: def.name.clone(),
                        event_type: event_type.clone(),
                        cooldown_ms: cooldown.unwrap_or(0),
                        max_per_day: max_per_day.unwrap_or(u32::MAX),
                        once_per_day: once_per_day.unwrap_or(false),
                        last_fired: last_fire.map(|dt| dt.to_rfc3339()),
                        today_count,
                        active: self.running.load(Ordering::Relaxed),
                    });
                }
            }
        }

        triggers
    }
}

/// Serializable info about an active event trigger.
#[derive(Debug, Clone, serde::Serialize)]
pub struct EventTriggerInfo {
    pub sequence_id: String,
    pub sequence_name: String,
    pub event_type: String,
    pub cooldown_ms: u64,
    pub max_per_day: u32,
    pub once_per_day: bool,
    pub last_fired: Option<String>,
    pub today_count: u32,
    pub active: bool,
}
