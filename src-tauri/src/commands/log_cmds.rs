use parking_lot::Mutex;
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};

const LOG_RETENTION_DAYS: i64 = 7;

/// Returns the shared logs directory: `{config_dir}/open-whisperer/logs/`
pub fn logs_dir() -> std::path::PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("open-whisperer")
        .join("logs")
}

/// Delete any `.log` files in `dir` whose name encodes a date older than `LOG_RETENTION_DAYS`.
///
/// Expected filename patterns:
///   `backend-YYYY-MM-DD.log`, `backend-dev-YYYY-MM-DD.log`
///   `frontend-YYYY-MM-DD.log`, `frontend-dev-YYYY-MM-DD.log`
pub fn cleanup_old_logs(dir: &std::path::Path) {
    let cutoff =
        chrono::Local::now().naive_local().date() - chrono::Duration::days(LOG_RETENTION_DAYS);

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("log") {
            continue;
        }
        // The stem looks like "backend-2026-02-19" or "frontend-dev-2026-02-19"
        // The date is always the last 10 characters of the stem.
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            if stem.len() >= 10 {
                let date_str = &stem[stem.len() - 10..];
                if let Ok(file_date) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
                    if file_date < cutoff {
                        let _ = fs::remove_file(&path);
                    }
                }
            }
        }
    }
}

/// Managed state that holds a buffered writer to the frontend log file.
pub struct FrontendLogger(pub Mutex<Option<BufWriter<std::fs::File>>>);

/// Initialise the frontend log file writer.
///
/// * Creates `logs/` directory if needed
/// * Purges log files older than 7 days
/// * Opens/creates today's `frontend[-dev]-YYYY-MM-DD.log` in append mode
///
/// Call once during app setup and pass the result to `.manage()`.
pub fn init_frontend_logger() -> FrontendLogger {
    let log_dir = logs_dir();

    if let Err(e) = fs::create_dir_all(&log_dir) {
        eprintln!("[log_cmds] Failed to create logs directory: {}", e);
        return FrontendLogger(Mutex::new(None));
    }

    // Remove logs older than 7 days (backend files included for free)
    cleanup_old_logs(&log_dir);

    let today = chrono::Local::now().format("%Y-%m-%d");
    let file_name = if cfg!(debug_assertions) {
        format!("frontend-dev-{}.log", today)
    } else {
        format!("frontend-{}.log", today)
    };

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join(&file_name))
        .ok()
        .map(BufWriter::new);

    FrontendLogger(Mutex::new(file))
}

/// Tauri command called by the frontend to write a log entry to the frontend log file.
///
/// `level` should be one of "debug", "info", "warn", or "error".
/// `message` is the already-formatted log string.
#[tauri::command]
pub fn write_frontend_log(level: String, message: String, state: tauri::State<FrontendLogger>) {
    let timestamp = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f");
    let line = format!("{} [{}] {}\n", timestamp, level.to_uppercase(), message);

    if let Some(writer) = state.0.lock().as_mut() {
        let _ = writer.write_all(line.as_bytes());
        let _ = writer.flush();
    }
}
