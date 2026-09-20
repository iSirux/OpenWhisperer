//! Task terminals publish the command's exit code independently of the terminal launcher.
use crate::config::LaunchTerminal;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::{Child, Command},
    time::Instant,
};

pub struct TaskTerminal {
    dir: PathBuf,
    started: Instant,
    #[cfg(windows)]
    process: parking_lot::Mutex<Option<std::fs::File>>,
}

impl TaskTerminal {
    pub fn is_open(&self) -> bool {
        std::fs::read_to_string(self.dir.join("pid"))
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .is_some_and(|pid| self.process_alive(pid))
    }

    pub fn status(&self) -> Option<bool> {
        let alive = std::fs::read_to_string(self.dir.join("pid"))
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .map(|pid| self.process_alive(pid));
        if let Ok(result) = std::fs::read_to_string(self.dir.join("result")) {
            if let Ok(code) = result.trim().parse::<i32>() {
                return Some(code == 0);
            }
        }
        if let Ok(pid) = std::fs::read_to_string(self.dir.join("pid")) {
            if let Ok(pid) = pid.trim().parse::<u32>() {
                if !self.process_alive(pid) {
                    // Re-read after observing exit: the result may have just been written.
                    return Some(
                        std::fs::read_to_string(self.dir.join("result"))
                            .is_ok_and(|s| s.trim() == "0"),
                    );
                }
            }
        } else if alive.is_none() && self.started.elapsed().as_secs() > 30 {
            return Some(false);
        }
        None
    }

    pub fn stop(&self) {
        if let Ok(pid) = std::fs::read_to_string(self.dir.join("pid")) {
            if let Ok(pid) = pid.trim().parse::<u32>() {
                if !self.process_alive(pid) {
                    return;
                }
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    let _ = Command::new("taskkill")
                        .args(["/F", "/T", "/PID", &pid.to_string()])
                        .creation_flags(0x08000000)
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();
                }
                #[cfg(not(windows))]
                {
                    stop_tree(pid);
                }
            }
        }
    }

    #[cfg(windows)]
    fn process_alive(&self, pid: u32) -> bool {
        use std::os::windows::io::{AsRawHandle, FromRawHandle};
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn GetExitCodeProcess(handle: *mut std::ffi::c_void, code: *mut u32) -> i32;
        }
        let mut process = self.process.lock();
        unsafe {
            if process.is_none() {
                let handle = OpenProcess(0x1000, 0, pid);
                if handle.is_null() {
                    return false;
                }
                *process = Some(std::fs::File::from_raw_handle(handle));
            }
            let mut code = 0;
            GetExitCodeProcess(process.as_ref().unwrap().as_raw_handle(), &mut code) != 0
                && code == 259
        }
    }

    #[cfg(not(windows))]
    fn process_alive(&self, pid: u32) -> bool {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .is_ok_and(|s| s.success())
    }
}

#[cfg(not(windows))]
fn stop_tree(pid: u32) {
    if let Ok(children) = Command::new("pgrep")
        .args(["-P", &pid.to_string()])
        .output()
    {
        for child in String::from_utf8_lossy(&children.stdout)
            .lines()
            .filter_map(|p| p.trim().parse::<u32>().ok())
        {
            stop_tree(child);
        }
    }
    let _ = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
}

impl Drop for TaskTerminal {
    fn drop(&mut self) {
        // This directory is created by us with a fresh UUID and contains only task scripts/results.
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn spawn(
    cwd: &Path,
    command: &str,
    title: &str,
    env: Option<&HashMap<String, String>>,
    terminal: &LaunchTerminal,
    close_on_success: bool,
) -> Result<(Child, TaskTerminal), String> {
    let dir = std::env::temp_dir().join(format!("open-whisperer-task-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
    let task = TaskTerminal {
        dir,
        started: Instant::now(),
        #[cfg(windows)]
        process: parking_lot::Mutex::new(None),
    };
    let child = spawn_inner(
        &task.dir,
        cwd,
        command,
        title,
        env,
        terminal,
        close_on_success,
    )
    .map_err(|e| format!("Failed to launch task '{}': {}", title, e))?;
    Ok((child, task))
}

#[cfg(windows)]
fn spawn_inner(
    dir: &Path,
    cwd: &Path,
    command: &str,
    title: &str,
    env: Option<&HashMap<String, String>>,
    terminal: &LaunchTerminal,
    close: bool,
) -> std::io::Result<Child> {
    use std::os::windows::process::CommandExt;
    let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "''"));
    let powershell = matches!(terminal, LaunchTerminal::PowerShell);
    let script = dir.join(if powershell {
        "command.ps1"
    } else {
        "command.cmd"
    });
    std::fs::write(
        &script,
        if powershell {
            format!("{}\r\nif ($?) {{ exit 0 }} elseif ($LASTEXITCODE) {{ exit $LASTEXITCODE }} else {{ exit 1 }}\r\n", command)
        } else {
            format!("@echo off\r\n{}\r\nexit /b %errorlevel%\r\n", command)
        },
    )?;
    let invocation = if powershell {
        format!(
            "& pwsh -NoProfile -ExecutionPolicy Bypass -File {}",
            quote(&script)
        )
    } else {
        format!("& $env:ComSpec /d /c ('\"' + {} + '\"')", quote(&script))
    };
    let wrapper = dir.join("run.ps1");
    std::fs::write(&wrapper, format!(
        "$PID | Set-Content -LiteralPath {}\n$code = 1\ntry {{\n{}\n$code = $LASTEXITCODE\nif ($null -eq $code) {{ $code = 1 }}\n}} catch {{ Write-Host $_ }}\n[System.IO.File]::WriteAllText({}, [string]$code)\nif ($code -ne 0 -or ${}) {{ Read-Host -Prompt ('Task finished (exit code ' + $code + '). Press Enter to close') | Out-Null }}\nexit $code\n",
        quote(&dir.join("pid")), invocation, quote(&dir.join("result")), if close { "false" } else { "true" }
    ))?;
    let mut cmd = if matches!(terminal, LaunchTerminal::WindowsTerminal) {
        let mut c = Command::new("wt");
        c.args(["-w", "new", "--title", title, "-d"]);
        c.arg(cwd)
            .args([
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&wrapper);
        c
    } else {
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&wrapper);
        c.creation_flags(if cfg!(test) { 0x08000000 } else { 0x00000010 }); // Only tests run hidden.
        c
    };
    cmd.current_dir(cwd);
    #[cfg(test)]
    {
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
    }
    if let Some(env) = env {
        cmd.envs(env);
    }
    cmd.spawn()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn run(command: &str, close: bool, expected: bool, stays_open: bool) {
        run_shell(command, close, expected, stays_open, LaunchTerminal::Cmd);
    }

    fn run_shell(
        command: &str,
        close: bool,
        expected: bool,
        stays_open: bool,
        terminal: LaunchTerminal,
    ) {
        let (mut child, task) = spawn(
            &std::env::temp_dir(),
            command,
            "Launch task test",
            None,
            &terminal,
            close,
        )
        .unwrap();
        let deadline = Instant::now() + std::time::Duration::from_secs(15);
        let result = loop {
            if let Some(result) = task.status() {
                break result;
            }
            if Instant::now() > deadline {
                task.stop();
                let _ = child.kill();
                panic!("Task did not publish its result");
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        assert_eq!(result, expected);
        if stays_open {
            std::thread::sleep(std::time::Duration::from_millis(200));
            let open = child.try_wait().unwrap().is_none();
            task.stop();
            let _ = child.wait();
            assert!(
                open,
                "Terminal must remain open after failure or when auto-close is disabled"
            );
        } else {
            while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            let exited = child.try_wait().unwrap().is_some();
            if !exited {
                task.stop();
                let _ = child.kill();
            }
            assert!(exited, "Successful task should close its terminal");
        }
    }

    #[test]
    fn launch_task_success_closes_terminal() {
        run(
            "echo \"quoted argument with spaces\" && exit /b 0",
            true,
            true,
            false,
        );
    }

    #[test]
    fn launch_task_powershell_failure_keeps_terminal() {
        if Command::new("pwsh")
            .arg("-Version")
            .stdout(std::process::Stdio::null())
            .status()
            .is_err()
        {
            return;
        }
        run_shell(
            "Write-Error 'Task failed'",
            true,
            false,
            true,
            LaunchTerminal::PowerShell,
        );
    }

    #[test]
    fn launch_task_powershell_success_closes_terminal() {
        if Command::new("pwsh")
            .arg("-Version")
            .stdout(std::process::Stdio::null())
            .status()
            .is_err()
        {
            return;
        }
        run_shell(
            "Write-Output 'Task succeeded'",
            true,
            true,
            false,
            LaunchTerminal::PowerShell,
        );
    }

    #[test]
    fn launch_task_failure_keeps_terminal() {
        run("exit /b 7", true, false, true);
    }

    #[test]
    fn launch_task_can_keep_successful_terminal() {
        run("exit /b 0", false, true, true);
    }

    #[test]
    fn launch_profile_defaults_are_backward_compatible() {
        let profile: crate::config::LaunchProfile =
            serde_json::from_str(r#"{"id":"build","name":"Build","command_ids":["cmd"]}"#).unwrap();
        assert_eq!(
            profile.execution_type,
            crate::config::LaunchExecutionType::Service
        );
        assert!(profile.close_on_success);
    }
}

#[cfg(not(windows))]
fn spawn_inner(
    dir: &Path,
    cwd: &Path,
    command: &str,
    title: &str,
    env: Option<&HashMap<String, String>>,
    _terminal: &LaunchTerminal,
    close: bool,
) -> std::io::Result<Child> {
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    let script = dir.join("run.sh");
    let mut body = format!(
        "echo $$ > {}\ncd {} || exit 1\n",
        quote(&dir.join("pid").to_string_lossy()),
        quote(&cwd.to_string_lossy())
    );
    if let Some(env) = env {
        for (key, value) in env {
            if !key.is_empty()
                && key.chars().enumerate().all(|(i, c)| {
                    c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit())
                })
            {
                body.push_str(&format!("export {}={}\n", key, quote(value)));
            }
        }
    }
    body.push_str(&format!("bash -c {}\ncode=$?\nprintf '%s' \"$code\" > {}\nif [ \"$code\" -ne 0 ] || [ {} = false ]; then read -r -p \"Task finished (exit code $code). Press Enter to close\"; fi\nexit \"$code\"\n", quote(command), quote(&dir.join("result").to_string_lossy()), close));
    std::fs::write(&script, body)?;
    #[cfg(target_os = "macos")]
    {
        let shell = format!("bash {}; exit", quote(&script.to_string_lossy()));
        let apple_quote = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
        let read_result = format!("cat {}", quote(&dir.join("result").to_string_lossy()));
        let apple = format!(
            "tell application \"Terminal\"\nactivate\nset taskTab to do script \"{}\"\nrepeat\nif not (exists taskTab) then return\ntry\nset taskResult to do shell script \"{}\"\nexit repeat\nend try\ndelay 0.2\nend repeat\nif {} and taskResult is \"0\" then\nrepeat while busy of taskTab\ndelay 0.2\nend repeat\nclose taskTab\nend if\nend tell",
            apple_quote(&shell), apple_quote(&read_result), close
        );
        return Command::new("osascript").args(["-e", &apple]).spawn();
    }
    #[cfg(not(target_os = "macos"))]
    {
        for (term, args) in [
            ("gnome-terminal", vec!["--", "bash"]),
            ("konsole", vec!["-e", "bash"]),
            ("xterm", vec!["-T", title, "-e", "bash"]),
        ] {
            if let Ok(child) = Command::new(term)
                .args(args)
                .arg(&script)
                .current_dir(cwd)
                .spawn()
            {
                return Ok(child);
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "No supported terminal emulator found",
        ))
    }
}
