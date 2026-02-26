use crate::config::{SdkProvider, TerminalMode};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

// Minimum and maximum PTY dimensions for validation
const MIN_PTY_ROWS: u16 = 1;
const MIN_PTY_COLS: u16 = 1;
const MAX_PTY_ROWS: u16 = 500;
const MAX_PTY_COLS: u16 = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSession {
    pub id: String,
    pub repo_path: String,
    pub prompt: String,
    pub status: SessionStatus,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SessionStatus {
    Starting,
    Running,
    Completed,
    Failed,
}

struct PtySession {
    pair: PtyPair,
    writer: Box<dyn Write + Send>,
    shutdown_flag: Arc<AtomicBool>,
}

pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
    pty_sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            pty_sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create_session(
        &self,
        app: AppHandle,
        repo_path: String,
        prompt: String,
        model: Option<String>,
        terminal_mode: TerminalMode,
        _sdk_provider: SdkProvider,
        skip_permissions: bool,
    ) -> Result<String, String> {
        let id = Uuid::new_v4().to_string();
        let session = TerminalSession {
            id: id.clone(),
            repo_path: repo_path.clone(),
            prompt: prompt.clone(),
            status: SessionStatus::Starting,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        };

        self.sessions.lock().insert(id.clone(), session.clone());

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let is_app_server_mode = terminal_mode == TerminalMode::CodexAppServer;
        let is_prompt_mode = terminal_mode == TerminalMode::Prompt;

        let mut cmd = if is_app_server_mode {
            #[cfg(target_os = "windows")]
            let c = {
                // On Windows, codex may resolve to a cmd/npm shim. Launch through cmd.exe
                // so CreateProcess doesn't try to execute "codex app-server" as one path.
                let mut c = CommandBuilder::new("cmd");
                c.arg("/C");
                c.arg("codex");
                c.arg("app-server");
                c
            };

            #[cfg(not(target_os = "windows"))]
            let c = {
                let mut c = CommandBuilder::new("codex");
                c.arg("app-server");
                c
            };

            c
        } else {
            let mut c = CommandBuilder::new("claude");

            // Add skip permissions flag if enabled
            if skip_permissions {
                c.arg("--dangerously-skip-permissions");
            }

            if let Some(m) = model {
                c.arg("--model");
                c.arg(&m);
            }

            // In Prompt mode, pass the prompt directly via -p flag
            if is_prompt_mode {
                c.arg("-p");
                c.arg(&prompt);
            }
            c
        };

        cmd.cwd(&repo_path);

        // Set environment for proper PTY behavior
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let _child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn terminal command: {}", e))?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {}", e))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take writer: {}", e))?;

        // Create shutdown flag for graceful thread termination
        let shutdown_flag = Arc::new(AtomicBool::new(false));
        let shutdown_flag_clone = Arc::clone(&shutdown_flag);

        self.pty_sessions.lock().insert(
            id.clone(),
            PtySession {
                pair,
                writer,
                shutdown_flag,
            },
        );

        {
            let mut sessions = self.sessions.lock();
            if let Some(s) = sessions.get_mut(&id) {
                s.status = SessionStatus::Running;
            }
        }

        let sessions_ref = Arc::clone(&self.sessions);
        let session_id = id.clone();
        let app_clone = app.clone();

        // In Interactive mode, spawn a thread to send the prompt after CLI initializes
        // (only if there's actually a prompt to send)
        if !is_prompt_mode && !is_app_server_mode && !prompt.is_empty() {
            let pty_sessions_ref = Arc::clone(&self.pty_sessions);
            let session_id_for_prompt = id.clone();
            let initial_prompt = prompt.clone();

            thread::spawn(move || {
                // Wait for Claude to initialize and show its prompt
                thread::sleep(std::time::Duration::from_millis(1000));
                let mut pty_sessions = pty_sessions_ref.lock();
                if let Some(session) = pty_sessions.get_mut(&session_id_for_prompt) {
                    // Send the prompt followed by Enter
                    let prompt_with_newline = format!("{}\n", initial_prompt);
                    let _ = session.writer.write_all(prompt_with_newline.as_bytes());
                    let _ = session.writer.flush();
                }
            });
        }

        // Spawn a thread to read output immediately
        thread::spawn(move || {
            let mut buffer = [0u8; 4096];

            loop {
                // Check if we've been signaled to shut down
                if shutdown_flag_clone.load(Ordering::Relaxed) {
                    break;
                }

                match reader.read(&mut buffer) {
                    Ok(0) => break, // EOF - process exited normally
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                        let _ = app_clone.emit(&format!("terminal-output-{}", session_id), &data);
                    }
                    Err(e) => {
                        // Log error for debugging (only if not due to shutdown)
                        if !shutdown_flag_clone.load(Ordering::Relaxed) {
                            log::error!("Terminal reader error for session {}: {}", session_id, e);
                        }
                        break;
                    }
                }
            }

            let mut sessions = sessions_ref.lock();
            if let Some(s) = sessions.get_mut(&session_id) {
                s.status = SessionStatus::Completed;
            }
            let _ = app_clone.emit(&format!("terminal-closed-{}", session_id), ());
        });

        let _ = app.emit("session-created", &session);

        Ok(id)
    }

    pub fn write_to_session(&self, id: &str, data: &str) -> Result<(), String> {
        let mut pty_sessions = self.pty_sessions.lock();
        if let Some(session) = pty_sessions.get_mut(id) {
            session
                .writer
                .write_all(data.as_bytes())
                .map_err(|e| format!("Failed to write: {}", e))?;
            session
                .writer
                .flush()
                .map_err(|e| format!("Failed to flush: {}", e))?;
            Ok(())
        } else {
            Err("Session not found".to_string())
        }
    }

    pub fn resize_session(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        // Validate dimensions to prevent invalid PTY states
        if rows < MIN_PTY_ROWS || cols < MIN_PTY_COLS {
            return Err(format!(
                "Invalid dimensions: rows={}, cols={} (minimum: {}x{})",
                rows, cols, MIN_PTY_ROWS, MIN_PTY_COLS
            ));
        }

        if rows > MAX_PTY_ROWS || cols > MAX_PTY_COLS {
            return Err(format!(
                "Dimensions too large: rows={}, cols={} (maximum: {}x{})",
                rows, cols, MAX_PTY_ROWS, MAX_PTY_COLS
            ));
        }

        let pty_sessions = self.pty_sessions.lock();
        if let Some(session) = pty_sessions.get(id) {
            session
                .pair
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("Failed to resize: {}", e))?;
            Ok(())
        } else {
            Err("Session not found".to_string())
        }
    }

    pub fn close_session(&self, id: &str) -> Result<(), String> {
        // Signal the reader thread to shut down gracefully
        if let Some(session) = self.pty_sessions.lock().get(id) {
            session.shutdown_flag.store(true, Ordering::Relaxed);
        }

        // Remove the PTY session (this will drop the PTY and close the master side)
        self.pty_sessions.lock().remove(id);
        self.sessions.lock().remove(id);
        Ok(())
    }

    pub fn get_sessions(&self) -> Vec<TerminalSession> {
        self.sessions.lock().values().cloned().collect()
    }

    pub fn get_session(&self, id: &str) -> Option<TerminalSession> {
        self.sessions.lock().get(id).cloned()
    }
}
