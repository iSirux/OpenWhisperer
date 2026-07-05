//! Shared process-spawning helpers. Centralizes the Windows CREATE_NO_WINDOW
//! flag, output capture, and success/stderr error mapping so call sites don't
//! copy-paste the ceremony.
#![allow(dead_code)]

use std::path::Path;

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Captured output of a finished process.
pub struct ProcOutput {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

fn to_output(output: std::process::Output) -> ProcOutput {
    ProcOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    }
}

/// Run a program synchronously with hidden window, capturing output.
pub fn run_program(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
) -> Result<ProcOutput, String> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.output()
        .map(to_output)
        .map_err(|e| format!("Failed to run {}: {}", program, e))
}

/// Run `git <args>` in `repo_path`; returns trimmed stdout on success, trimmed
/// stderr as the error on failure.
pub fn run_git(repo_path: &str, args: &[&str]) -> Result<String, String> {
    let out = run_program("git", args, Some(Path::new(repo_path)))
        .map_err(|e| format!("Failed to run git: {}", e))?;
    if out.success {
        Ok(out.stdout.trim().to_string())
    } else {
        let err = out.stderr.trim();
        if err.is_empty() {
            Err(format!("git {} failed (exit {:?})", args.join(" "), out.code))
        } else {
            Err(err.to_string())
        }
    }
}

/// Run a program asynchronously (tokio) with hidden window, capturing output.
pub async fn run_command_async(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
    env: &[(String, String)],
) -> Result<ProcOutput, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.output()
        .await
        .map(to_output)
        .map_err(|e| format!("Failed to run {}: {}", program, e))
}

/// Run a shell command string via `cmd /C` (Windows) or `sh -c` (elsewhere),
/// asynchronously, capturing output.
pub async fn run_shell_async(cwd: &Path, command: &str) -> Result<ProcOutput, String> {
    #[cfg(windows)]
    let (program, flag) = ("cmd", "/C");
    #[cfg(not(windows))]
    let (program, flag) = ("sh", "-c");
    run_command_async(
        program,
        &[flag.to_string(), command.to_string()],
        Some(cwd),
        &[],
    )
    .await
}

/// Synchronous variant of [`run_shell_async`].
pub fn run_shell(cwd: &Path, command: &str) -> Result<ProcOutput, String> {
    #[cfg(windows)]
    let (program, flag) = ("cmd", "/C");
    #[cfg(not(windows))]
    let (program, flag) = ("sh", "-c");
    run_program(program, &[flag, command], Some(cwd))
}
