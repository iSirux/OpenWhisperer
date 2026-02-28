use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;

use super::SequenceManager;
use super::persistence;

/// Persisted state tracking when each schedule last ran
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SchedulerState {
    /// Last run time for each schedule key ("{sequence_id}:{cron}")
    #[serde(default)]
    pub last_runs: HashMap<String, DateTime<Utc>>,
    /// Enabled/disabled overrides per schedule key
    #[serde(default)]
    pub enabled: HashMap<String, bool>,
}

impl SchedulerState {
    fn load() -> Self {
        let path = persistence::sequences_dir().join("scheduler_state.json");
        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
                Err(_) => Self::default(),
            }
        } else {
            Self::default()
        }
    }

    fn save(&self) -> Result<(), String> {
        let dir = persistence::sequences_dir();
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create sequences directory: {}", e))?;
        let path = dir.join("scheduler_state.json");
        let data = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize scheduler state: {}", e))?;
        std::fs::write(&path, data)
            .map_err(|e| format!("Failed to write scheduler state: {}", e))?;
        Ok(())
    }
}

/// Info about a single schedule for frontend display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleInfo {
    pub sequence_id: String,
    pub sequence_name: String,
    pub cron: String,
    pub timezone: Option<String>,
    pub enabled: bool,
    pub next_fire: Option<String>,
    pub last_run: Option<String>,
}

/// The cron scheduler that periodically checks for due sequences
pub struct SequenceScheduler {
    running: Arc<AtomicBool>,
    handle: parking_lot::Mutex<Option<JoinHandle<()>>>,
    state: Arc<parking_lot::Mutex<SchedulerState>>,
}

impl SequenceScheduler {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            handle: parking_lot::Mutex::new(None),
            state: Arc::new(parking_lot::Mutex::new(SchedulerState::load())),
        }
    }

    /// Start the scheduler background loop.
    /// Checks every 30 seconds for due schedules.
    pub fn start(&self, manager: Arc<SequenceManager>) {
        if self.running.load(Ordering::Relaxed) {
            return; // Already running
        }
        self.running.store(true, Ordering::Relaxed);
        let running = self.running.clone();
        let state = self.state.clone();

        let handle = tauri::async_runtime::spawn(async move {
            while running.load(Ordering::Relaxed) {
                // Sleep 30 seconds between checks
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;

                if !running.load(Ordering::Relaxed) {
                    break;
                }

                let now = Utc::now();
                let definitions = manager.get_definitions();

                for def in &definitions {
                    for trigger in &def.triggers {
                        if let crate::sequences::types::SequenceTrigger::Schedule { cron, timezone: _, inputs, entry_node_id } = trigger {
                            let schedule_key = format!("{}:{}", def.id, cron);

                            // Check enabled state
                            let enabled = state.lock().enabled.get(&schedule_key).copied().unwrap_or(true);
                            if !enabled {
                                continue;
                            }

                            // Parse cron expression (supports standard 5-field by prefixing seconds)
                            let schedule = match parse_cron_schedule(cron) {
                                Ok(s) => s,
                                Err(e) => {
                                    log::error!("[scheduler] Invalid cron '{}' for sequence '{}': {}", cron, def.id, e);
                                    continue;
                                }
                            };

                            // Check if any scheduled time fell between last_run and now
                            let last_run = state.lock().last_runs.get(&schedule_key).copied()
                                .unwrap_or_else(|| now - chrono::Duration::seconds(31)); // First run: check last 31s

                            let mut should_fire = false;
                            for next_time in schedule.after(&last_run) {
                                if next_time <= now {
                                    should_fire = true;
                                    break;
                                } else {
                                    break; // Past now, no need to check further
                                }
                            }

                            if should_fire {
                                log::info!("[scheduler] Firing sequence '{}' (cron: {})", def.name, cron);
                                let exec_inputs = inputs.clone().unwrap_or_default();
                                match manager.start_execution_at(&def.id, exec_inputs, false, entry_node_id.clone()) {
                                    Ok(exec_id) => {
                                        log::info!("[scheduler] Started execution {} for '{}'", exec_id, def.name);
                                    }
                                    Err(e) => {
                                        log::error!("[scheduler] Failed to start '{}': {}", def.name, e);
                                    }
                                }
                                let mut state_guard = state.lock();
                                state_guard.last_runs.insert(schedule_key, now);
                                if let Err(e) = state_guard.save() {
                                    log::error!("[scheduler] Failed to save state: {}", e);
                                }
                            }
                        }
                    }
                }
            }
        });

        *self.handle.lock() = Some(handle);
    }

    /// Stop the scheduler
    #[allow(dead_code)]
    pub fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(handle) = self.handle.lock().take() {
            handle.abort();
        }
    }

    /// List all schedule triggers with their info
    pub fn list_schedules(&self, manager: &SequenceManager) -> Vec<ScheduleInfo> {
        let definitions = manager.get_definitions();
        let state = self.state.lock();
        let mut schedules = Vec::new();

        for def in &definitions {
            for trigger in &def.triggers {
                if let crate::sequences::types::SequenceTrigger::Schedule { cron, timezone, .. } = trigger {
                    let schedule_key = format!("{}:{}", def.id, cron);
                    let enabled = state.enabled.get(&schedule_key).copied().unwrap_or(true);
                    let last_run = state.last_runs.get(&schedule_key).map(|dt| dt.to_rfc3339());

                    // Calculate next fire time using the same parsing behavior as runtime scheduling
                    let next_fire = match parse_cron_schedule(cron) {
                        Ok(sched) => sched.upcoming(Utc).next().map(|dt| dt.to_rfc3339()),
                        Err(e) => {
                            log::warn!(
                                "[scheduler] Could not compute next_fire for sequence '{}' cron '{}': {}",
                                def.id,
                                cron,
                                e
                            );
                            None
                        }
                    };

                    schedules.push(ScheduleInfo {
                        sequence_id: def.id.clone(),
                        sequence_name: def.name.clone(),
                        cron: cron.clone(),
                        timezone: timezone.clone(),
                        enabled,
                        next_fire,
                        last_run,
                    });
                }
            }
        }

        schedules
    }

    /// Toggle a schedule on/off
    pub fn toggle_schedule(&self, sequence_id: &str, cron: &str, enabled: bool) -> Result<(), String> {
        let schedule_key = format!("{}:{}", sequence_id, cron);
        let mut state = self.state.lock();
        state.enabled.insert(schedule_key, enabled);
        state.save()
    }
}

fn parse_cron_schedule(cron_expr: &str) -> Result<cron::Schedule, String> {
    let normalized = normalize_cron_expr(cron_expr);
    cron::Schedule::from_str(&normalized)
        .map_err(|e| e.to_string())
}

fn normalize_cron_expr(cron_expr: &str) -> String {
    let trimmed = cron_expr.trim();
    let field_count = trimmed.split_whitespace().count();

    // Accept standard 5-field cron by prepending "seconds = 0".
    if field_count == 5 {
        format!("0 {}", trimmed)
    } else {
        trimmed.to_string()
    }
}
