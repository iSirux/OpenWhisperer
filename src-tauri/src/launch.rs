use crate::config::{LaunchCommand, LaunchTerminal};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Arc;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Tracks a spawned terminal process for a launch command
struct RunningProcess {
    command_id: String,
    _command_name: String,
    child: Child,
}

/// Manages spawned terminal processes for launch profiles.
/// Each repo can have multiple running processes tracked by their command IDs.
pub struct LaunchManager {
    /// Map of repo_id -> list of running processes
    running: Arc<Mutex<HashMap<String, Vec<RunningProcess>>>>,
}

impl Default for LaunchManager {
    fn default() -> Self {
        Self::new()
    }
}

impl LaunchManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Launch multiple commands for a repo, each in a separate OS terminal window.
    pub fn launch_commands(
        &self,
        repo_id: &str,
        repo_path: &str,
        commands: &[LaunchCommand],
        terminal: &LaunchTerminal,
    ) -> Result<(), String> {
        let mut processes = Vec::new();

        for cmd in commands {
            // Resolve working directory: if command has a relative working_dir, join with repo_path
            let cwd = if let Some(ref wd) = cmd.working_dir {
                let wd_path = PathBuf::from(wd);
                if wd_path.is_absolute() {
                    wd_path
                } else {
                    PathBuf::from(repo_path).join(wd)
                }
            } else {
                PathBuf::from(repo_path)
            };

            let child = spawn_terminal_with_command(
                &cwd,
                &cmd.command,
                &cmd.name,
                cmd.env.as_ref(),
                terminal,
            )?;

            processes.push(RunningProcess {
                command_id: cmd.id.clone(),
                _command_name: cmd.name.clone(),
                child,
            });
        }

        let mut running = self.running.lock();
        // Stop any existing processes for this repo first
        if let Some(existing) = running.remove(repo_id) {
            for proc in existing {
                kill_process(proc.child);
            }
        }
        running.insert(repo_id.to_string(), processes);

        Ok(())
    }

    /// Stop all running processes for a given repo.
    pub fn stop_all(&self, repo_id: &str) -> Result<(), String> {
        let mut running = self.running.lock();
        if let Some(processes) = running.remove(repo_id) {
            for proc in processes {
                kill_process(proc.child);
            }
        }
        Ok(())
    }

    /// Stop all processes across all repos (used during app shutdown).
    pub fn stop_all_repos(&self) {
        let mut running = self.running.lock();
        for (_, processes) in running.drain() {
            for proc in processes {
                kill_process(proc.child);
            }
        }
    }

    /// Get the list of currently running command IDs for a repo.
    /// Prunes any processes that have exited (e.g. user closed the terminal window).
    pub fn get_running_command_ids(&self, repo_id: &str) -> Vec<String> {
        let mut running = self.running.lock();
        if let Some(procs) = running.get_mut(repo_id) {
            // Prune processes that have exited
            procs.retain_mut(|p| {
                match p.child.try_wait() {
                    Ok(Some(_)) => false, // Process has exited, remove it
                    Ok(None) => true,     // Still running
                    Err(_) => false,      // Error checking status, assume dead
                }
            });
            let ids: Vec<String> = procs.iter().map(|p| p.command_id.clone()).collect();
            // Clean up the entry if all processes are gone
            if ids.is_empty() {
                running.remove(repo_id);
            }
            ids
        } else {
            Vec::new()
        }
    }

    /// Check if any processes are running for a given repo.
    /// Prunes any processes that have exited.
    pub fn is_running(&self, repo_id: &str) -> bool {
        !self.get_running_command_ids(repo_id).is_empty()
    }
}

/// Spawn a separate OS terminal window running the given command.
/// Returns the child process handle for tracking/killing.
fn spawn_terminal_with_command(
    cwd: &Path,
    command: &str,
    title: &str,
    env: Option<&HashMap<String, String>>,
    _terminal: &LaunchTerminal,
) -> Result<Child, String> {
    let cwd_str = cwd.to_string_lossy();

    #[cfg(target_os = "windows")]
    {
        // All paths go through raw_arg to avoid Rust's C-runtime argument escaping
        // which uses \" — incompatible with cmd.exe's own quote parsing.
        let safe_title = title.replace('"', "'");
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let mut cmd = match _terminal {
            LaunchTerminal::PowerShell => {
                // start /WAIT keeps the outer cmd alive until the terminal closes,
                // so our Child handle can track when the user closes the window.
                let mut c = Command::new("cmd");
                c.raw_arg(format!(
                    "/C start \"{}\" /WAIT /D \"{}\" pwsh -NoExit -Command \"{}\"",
                    safe_title, cwd_str, command
                ));
                c.creation_flags(CREATE_NO_WINDOW);
                c
            }
            LaunchTerminal::WindowsTerminal => {
                // Windows Terminal: wt --title "title" -d "path" cmd /K command
                // Note: wt.exe may exit immediately if attaching to an existing
                // instance, so process tracking may not detect manual close.
                let mut c = Command::new("wt");
                c.raw_arg(format!(
                    "--title \"{}\" -d \"{}\" cmd /K {}",
                    safe_title, cwd_str, command
                ));
                c
            }
            LaunchTerminal::Cmd => {
                // start /WAIT keeps the outer cmd alive until the terminal closes,
                // so our Child handle can track when the user closes the window.
                // /D sets the working directory — avoids nested quoting issues
                // that `cd /d "path" && command` caused.
                let mut c = Command::new("cmd");
                c.raw_arg(format!(
                    "/C start \"{}\" /WAIT /D \"{}\" cmd /K {}",
                    safe_title, cwd_str, command
                ));
                c.creation_flags(CREATE_NO_WINDOW);
                c
            }
        };

        cmd.current_dir(cwd);

        if let Some(env_vars) = env {
            for (key, val) in env_vars {
                cmd.env(key, val);
            }
        }

        cmd.spawn()
            .map_err(|e| format!("Failed to spawn terminal for '{}': {}", title, e))
    }

    #[cfg(target_os = "macos")]
    {
        // On macOS: use osascript to open Terminal.app with the command
        let escaped_cwd = cwd_str.replace("'", "'\\''");
        let escaped_cmd = command.replace("'", "'\\''");
        let script = format!(
            r#"tell application "Terminal"
                activate
                do script "cd '{}' && {}"
            end tell"#,
            escaped_cwd, escaped_cmd
        );

        let mut cmd = Command::new("osascript");
        cmd.args(["-e", &script]);

        if let Some(env_vars) = env {
            for (key, val) in env_vars {
                cmd.env(key, val);
            }
        }

        cmd.spawn()
            .map_err(|e| format!("Failed to spawn terminal for '{}': {}", title, e))
    }

    #[cfg(target_os = "linux")]
    {
        let full_cmd = format!(
            "cd '{}' && {}; exec bash",
            cwd_str.replace("'", "'\\''"),
            command
        );

        // Try common terminal emulators
        let terminals: Vec<(&str, Vec<&str>)> = vec![
            (
                "gnome-terminal",
                vec!["--title", title, "--", "bash", "-c", &full_cmd],
            ),
            (
                "konsole",
                vec!["--title", title, "-e", "bash", "-c", &full_cmd],
            ),
            (
                "xfce4-terminal",
                vec!["--title", title, "-e", &format!("bash -c '{}'", full_cmd)],
            ),
            (
                "xterm",
                vec!["-title", title, "-e", "bash", "-c", &full_cmd],
            ),
        ];

        for (term, args) in &terminals {
            let mut cmd = Command::new(term);
            cmd.args(args);
            if let Some(env_vars) = env {
                for (key, val) in env_vars {
                    cmd.env(key, val);
                }
            }
            match cmd.spawn() {
                Ok(child) => return Ok(child),
                Err(_) => continue,
            }
        }

        Err("No supported terminal emulator found (tried gnome-terminal, konsole, xfce4-terminal, xterm)".to_string())
    }
}

/// Kill a spawned process and its children.
fn kill_process(mut child: Child) {
    #[cfg(target_os = "windows")]
    {
        // On Windows, use taskkill with /T (tree) to kill child processes too
        if let Some(pid) = child.id().into() {
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .spawn();
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On Unix, kill the process group
        let _ = child.kill();
    }

    let _ = child.wait();
}
