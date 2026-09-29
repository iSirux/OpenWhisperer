use parking_lot::Mutex;
use serde::Deserialize;
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::Duration;

const LOG_RETENTION_DAYS: i64 = 7;

/// Buffered frontend lines are written out at least this often.
const FRONTEND_FLUSH_INTERVAL: Duration = Duration::from_secs(1);

/// Returns the shared logs directory: `{config_dir}/open-whisperer/logs/`
pub fn logs_dir() -> std::path::PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("open-whisperer")
        .join("logs")
}

/// The first `YYYY-MM-DD` in a log file stem. Usually the tail
/// (`backend-2026-02-19`), but a size-rotated backend file carries its rotation
/// time after the date (`backend-2026-02-19_2026-02-19_14-03-11`).
fn log_file_date(stem: &str) -> Option<chrono::NaiveDate> {
    // Match the shape strictly — chrono alone would accept "-2026-02-1" as a
    // negative year.
    let is_date = |w: &[u8]| {
        w.iter()
            .enumerate()
            .all(|(i, b)| if i == 4 || i == 7 { *b == b'-' } else { b.is_ascii_digit() })
    };
    stem.as_bytes()
        .windows(10)
        .position(is_date)
        .and_then(|i| chrono::NaiveDate::parse_from_str(&stem[i..i + 10], "%Y-%m-%d").ok())
}

/// Delete any `.log` files in `dir` whose name encodes a date older than `LOG_RETENTION_DAYS`.
///
/// Expected filename patterns:
///   `backend-YYYY-MM-DD.log`, `backend-dev-YYYY-MM-DD.log` (+ `_<rotated-at>` suffix)
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
        if let Some(file_date) = path.file_stem().and_then(|s| s.to_str()).and_then(log_file_date) {
            if file_date < cutoff {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

enum FrontendLogMsg {
    /// A formatted line; `urgent` (warn/error) lines are flushed right away so
    /// they survive a crash.
    Line { text: String, urgent: bool },
    /// Flush and acknowledge.
    Flush(Sender<()>),
}

/// Managed state for the frontend log file. The command only formats the line
/// and hands it to a writer thread, which batches writes and flushes on a timer
/// (and immediately for warn/error). Every `console.*` call in both webviews
/// lands here, so a per-line mutex + `flush()` used to cost a syscall each.
pub struct FrontendLogger(Mutex<Option<Sender<FrontendLogMsg>>>);

impl FrontendLogger {
    fn send(&self, msg: FrontendLogMsg) {
        if let Some(tx) = self.0.lock().as_ref() {
            let _ = tx.send(msg);
        }
    }

    /// Write out everything buffered so far (blocks until done, max ~2 s).
    pub fn flush(&self) {
        let (ack_tx, ack_rx) = mpsc::channel();
        self.send(FrontendLogMsg::Flush(ack_tx));
        let _ = ack_rx.recv_timeout(Duration::from_secs(2));
    }
}

fn frontend_log_name(date: &str) -> String {
    if cfg!(debug_assertions) {
        format!("frontend-dev-{}.log", date)
    } else {
        format!("frontend-{}.log", date)
    }
}

fn open_frontend_log(dir: &std::path::Path, date: &str) -> Option<BufWriter<fs::File>> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(frontend_log_name(date)))
        .map(|f| BufWriter::with_capacity(64 * 1024, f))
        .map_err(|e| eprintln!("[log_cmds] Failed to open frontend log: {}", e))
        .ok()
}

/// Writer loop: owns the file, rolls it over to a new dated file at local
/// midnight (a long-running app otherwise keeps appending to its start day's
/// file), and exits — flushing — once every sender is gone.
fn run_frontend_writer(dir: std::path::PathBuf, rx: mpsc::Receiver<FrontendLogMsg>) {
    let mut date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut writer = open_frontend_log(&dir, &date);
    let mut dirty = false;
    loop {
        match rx.recv_timeout(FRONTEND_FLUSH_INTERVAL) {
            Ok(FrontendLogMsg::Line { text, urgent }) => {
                let today = chrono::Local::now().format("%Y-%m-%d").to_string();
                if today != date {
                    if let Some(w) = writer.as_mut() {
                        let _ = w.flush();
                    }
                    date = today;
                    writer = open_frontend_log(&dir, &date);
                }
                if let Some(w) = writer.as_mut() {
                    let _ = w.write_all(text.as_bytes());
                    dirty = true;
                    if urgent {
                        let _ = w.flush();
                        dirty = false;
                    }
                }
            }
            Ok(FrontendLogMsg::Flush(ack)) => {
                if let Some(w) = writer.as_mut() {
                    let _ = w.flush();
                }
                dirty = false;
                let _ = ack.send(());
            }
            Err(RecvTimeoutError::Timeout) => {
                if dirty {
                    if let Some(w) = writer.as_mut() {
                        let _ = w.flush();
                    }
                    dirty = false;
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                if let Some(w) = writer.as_mut() {
                    let _ = w.flush();
                }
                return;
            }
        }
    }
}

/// Initialise the frontend log file writer.
///
/// * Creates `logs/` directory if needed
/// * Purges log files older than 7 days
/// * Starts the writer thread appending to `frontend[-dev]-YYYY-MM-DD.log`
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

    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("frontend-log-writer".into())
        .spawn(move || run_frontend_writer(log_dir, rx));
    match spawned {
        Ok(_) => FrontendLogger(Mutex::new(Some(tx))),
        Err(e) => {
            eprintln!("[log_cmds] Failed to start frontend log writer: {}", e);
            FrontendLogger(Mutex::new(None))
        }
    }
}

/// One batched frontend log entry (see `logger.ts`).
#[derive(Deserialize)]
pub struct FrontendLogEntry {
    level: String,
    message: String,
    /// Local time the entry was logged, `YYYY-MM-DDTHH:MM:SS.mmm`; the receive
    /// time is used when absent.
    #[serde(default)]
    ts: Option<String>,
}

fn format_line(level: &str, message: &str, ts: Option<&str>) -> (String, bool) {
    let now;
    let ts = match ts {
        Some(ts) => ts,
        None => {
            now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f").to_string();
            &now
        }
    };
    let urgent = matches!(level, "warn" | "error");
    (format!("{} [{}] {}\n", ts, level.to_uppercase(), message), urgent)
}

/// Tauri command called by the frontend to write log entries to the frontend log file.
///
/// Takes either a batch (`entries`) or a single `level` + `message`. `level`
/// should be one of "debug", "info", "warn", or "error"; `message` is the
/// already-formatted log string. Runs off the main thread and never blocks on
/// disk.
#[tauri::command(async)]
pub fn write_frontend_log(
    level: Option<String>,
    message: Option<String>,
    entries: Option<Vec<FrontendLogEntry>>,
    state: tauri::State<FrontendLogger>,
) {
    let single = match (level, message) {
        (Some(level), Some(message)) => Some(FrontendLogEntry {
            level,
            message,
            ts: None,
        }),
        _ => None,
    };
    let entries = entries.into_iter().flatten().chain(single);
    let mut text = String::new();
    let mut urgent = false;
    for entry in entries {
        let (line, u) = format_line(&entry.level, &entry.message, entry.ts.as_deref());
        text.push_str(&line);
        urgent |= u;
    }
    if !text.is_empty() {
        state.send(FrontendLogMsg::Line { text, urgent });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_file_date_handles_plain_and_rotated_names() {
        let d = |s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        assert_eq!(log_file_date("backend-2026-02-19"), Some(d("2026-02-19")));
        assert_eq!(log_file_date("frontend-dev-2026-02-19"), Some(d("2026-02-19")));
        assert_eq!(
            log_file_date("backend-2026-02-19_2026-02-20_01-02-03"),
            Some(d("2026-02-19"))
        );
        assert_eq!(log_file_date("llama-server"), None);
    }

    #[test]
    fn writer_batches_and_flushes_on_request() {
        let dir = std::env::temp_dir().join(format!("ow-log-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let (tx, rx) = mpsc::channel();
        let writer_dir = dir.clone();
        let handle = std::thread::spawn(move || run_frontend_writer(writer_dir, rx));
        let logger = FrontendLogger(Mutex::new(Some(tx)));

        let (line, urgent) = format_line("info", "hello", Some("2026-01-01T00:00:00.000"));
        assert!(!urgent);
        logger.send(FrontendLogMsg::Line { text: line, urgent });
        logger.flush();
        let date = chrono::Local::now().format("%Y-%m-%d").to_string();
        let written = fs::read_to_string(dir.join(frontend_log_name(&date))).unwrap();
        assert_eq!(written, "2026-01-01T00:00:00.000 [INFO] hello\n");

        drop(logger);
        handle.join().unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
