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
    state: parking_lot::Mutex<SchedulerState>,
}

impl SequenceScheduler {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            handle: parking_lot::Mutex::new(None),
            state: parking_lot::Mutex::new(SchedulerState::load()),
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
        let state = self.state.lock().clone();

        let handle = tauri::async_runtime::spawn(async move {
            let mut state = state;

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
                        if let crate::sequences::types::SequenceTrigger::Schedule { cron, timezone: _, inputs } = trigger {
                            let schedule_key = format!("{}:{}", def.id, cron);

                            // Check enabled state
                            let enabled = state.enabled.get(&schedule_key).copied().unwrap_or(true);
                            if !enabled {
                                continue;
                            }

                            // Parse cron expression
                            let schedule = match cron::Schedule::from_str(cron) {
                                Ok(s) => s,
                                Err(e) => {
                                    eprintln!("[scheduler] Invalid cron '{}' for sequence '{}': {}", cron, def.id, e);
                                    continue;
                                }
                            };

                            // Check if any scheduled time fell between last_run and now
                            let last_run = state.last_runs.get(&schedule_key).copied()
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
                                println!("[scheduler] Firing sequence '{}' (cron: {})", def.name, cron);
                                let exec_inputs = inputs.clone().unwrap_or_default();
                                match manager.start_execution(&def.id, exec_inputs, false) {
                                    Ok(exec_id) => {
                                        println!("[scheduler] Started execution {} for '{}'", exec_id, def.name);
                                    }
                                    Err(e) => {
                                        eprintln!("[scheduler] Failed to start '{}': {}", def.name, e);
                                    }
                                }
                                state.last_runs.insert(schedule_key, now);
                                if let Err(e) = state.save() {
                                    eprintln!("[scheduler] Failed to save state: {}", e);
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

                    // Calculate next fire time
                    let next_fire = cron::Schedule::from_str(cron).ok().and_then(|sched| {
                        sched.upcoming(Utc).next().map(|dt| dt.to_rfc3339())
                    });

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
