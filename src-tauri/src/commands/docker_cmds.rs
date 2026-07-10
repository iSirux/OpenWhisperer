//! One-click Docker setup for the bundled transcription server images.
//!
//! The build contexts live in the repo's `docker/` directory and are embedded
//! into the binary at compile time, so a running app never needs the source
//! checkout. `run_docker_setup` writes a provider's files plus a setup script
//! into the config directory, then opens a terminal window running that
//! script. A script (rather than a chained one-liner) is required on Windows:
//! `cmd /c start cmd /k <command>` re-parses `&&`/quotes in the outer shell
//! and mangles the command.

use std::fs;
use std::path::{Path, PathBuf};
#[cfg(target_os = "windows")]
use std::process::Command;

use crate::config::AppConfig;

/// An embedded Docker build context: (relative file name, contents).
type EmbeddedContext = &'static [(&'static str, &'static str)];

const SHERPA_ONNX_CONTEXT: EmbeddedContext = &[(
    "Dockerfile",
    include_str!("../../../docker/sherpa-onnx/Dockerfile"),
)];

const MOONSHINE_CONTEXT: EmbeddedContext = &[
    (
        "Dockerfile",
        include_str!("../../../docker/moonshine/Dockerfile"),
    ),
    ("server.py", include_str!("../../../docker/moonshine/server.py")),
];

/// Whisper uses a public image (`fedirz/faster-whisper-server`) — no build
/// context, the setup script just pulls and runs it.
const WHISPER_CONTEXT: EmbeddedContext = &[];

fn docker_contexts_dir() -> PathBuf {
    #[cfg(debug_assertions)]
    let dirname = "docker-contexts-dev";
    #[cfg(not(debug_assertions))]
    let dirname = "docker-contexts";
    AppConfig::config_dir().join(dirname)
}

/// Write the embedded Docker build context for `provider` to disk and return
/// its directory plus whether there is anything to build (an empty context
/// means the provider runs a public image and the script skips `docker build`).
/// Overwrites on every call so app updates propagate.
fn write_context(provider: &str) -> Result<(PathBuf, bool), String> {
    let context: EmbeddedContext = match provider {
        "sherpa-onnx" => SHERPA_ONNX_CONTEXT,
        "moonshine" => MOONSHINE_CONTEXT,
        "whisper" => WHISPER_CONTEXT,
        other => return Err(format!("Unknown docker context: {}", other)),
    };

    let dir = docker_contexts_dir().join(provider);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;

    for (name, contents) in context {
        let path = dir.join(name);
        fs::write(&path, contents)
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    }

    Ok((dir, !context.is_empty()))
}

#[cfg(target_os = "windows")]
fn write_setup_script(
    dir: &Path,
    image: &str,
    container_name: &str,
    run_command: &str,
    build: bool,
) -> Result<PathBuf, String> {
    let rm_line = if container_name.is_empty() {
        String::new()
    } else {
        format!("docker rm -f {} >nul 2>nul\r\n", container_name)
    };
    let build_lines = if build {
        format!(
            "echo === OpenWhisperer: building {image} ===\r\n\
             docker build -t {image} \"{dir}\"\r\n\
             if errorlevel 1 goto :fail\r\n\
             echo.\r\n",
            image = image,
            dir = dir.display(),
        )
    } else {
        format!(
            "echo === OpenWhisperer: pulling {image} (first run may take a while) ===\r\n",
            image = image,
        )
    };
    let script = format!(
        "@echo off\r\n\
         {build_lines}\
         {rm_line}\
         echo === Starting container ===\r\n\
         {run_command}\r\n\
         if errorlevel 1 goto :fail\r\n\
         echo.\r\n\
         echo === Success! The container is running. You can close this window. ===\r\n\
         goto :eof\r\n\
         :fail\r\n\
         echo.\r\n\
         echo *** FAILED - see the errors above (is Docker Desktop running?) ***\r\n",
        build_lines = build_lines,
        rm_line = rm_line,
        run_command = run_command,
    );
    let path = dir.join("setup.cmd");
    fs::write(&path, script).map_err(|e| format!("Failed to write setup script: {}", e))?;
    Ok(path)
}

#[cfg(not(target_os = "windows"))]
fn write_setup_script(
    dir: &Path,
    image: &str,
    container_name: &str,
    run_command: &str,
    build: bool,
) -> Result<PathBuf, String> {
    let rm_line = if container_name.is_empty() {
        String::new()
    } else {
        format!("docker rm -f {} 2>/dev/null || true\n", container_name)
    };
    let build_lines = if build {
        format!(
            "echo \"=== OpenWhisperer: building {image} ===\"\n\
             set -e\n\
             docker build -t {image} \"{dir}\"\n\
             echo\n",
            image = image,
            dir = dir.display(),
        )
    } else {
        format!(
            "echo \"=== OpenWhisperer: pulling {image} (first run may take a while) ===\"\n\
             set -e\n",
            image = image,
        )
    };
    let script = format!(
        "#!/bin/sh\n\
         {rm_line}\
         {build_lines}\
         echo \"=== Starting container ===\"\n\
         {run_command}\n\
         echo\n\
         echo \"=== Success! The container is running. You can close this window. ===\"\n",
        rm_line = rm_line,
        build_lines = build_lines,
        run_command = run_command,
    );
    let path = dir.join("setup.sh");
    fs::write(&path, script).map_err(|e| format!("Failed to write setup script: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to chmod setup script: {}", e))?;
    }
    Ok(path)
}

/// Write the embedded build context + a setup script for `provider`, then run
/// the script in a visible terminal window (build + start the container).
#[tauri::command]
pub fn run_docker_setup(
    provider: String,
    image: String,
    container_name: String,
    run_command: String,
) -> Result<(), String> {
    let (dir, build) = write_context(&provider)?;
    let script = write_setup_script(&dir, &image, &container_name, &run_command, build)?;
    let script_str = script.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        // The script path is the single argument, so no operator/quote
        // mangling; `start` opens a new window that stays open (/k).
        Command::new("cmd")
            .args(["/c", "start", "cmd", "/k", &script_str])
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        super::settings_cmds::run_in_terminal(format!("sh \"{}\"", script_str))?;
    }

    Ok(())
}

/// Docker availability probe result.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerStatus {
    /// `docker` CLI is on PATH and responds
    pub installed: bool,
    /// Docker daemon is reachable (`docker info` succeeded)
    pub running: bool,
    pub error: Option<String>,
}

/// Probe whether Docker is installed and whether its daemon is running,
/// without spawning any visible window.
#[tauri::command]
pub async fn check_docker() -> DockerStatus {
    use crate::proc::run_command_async;

    let client = run_command_async("docker", &["--version".to_string()], None, &[]).await;
    let installed = matches!(&client, Ok(out) if out.success);
    if !installed {
        let error = match client {
            Err(e) => Some(e),
            Ok(out) => Some(out.stderr.trim().to_string()).filter(|s| !s.is_empty()),
        };
        return DockerStatus {
            installed: false,
            running: false,
            error,
        };
    }

    let info = run_command_async(
        "docker",
        &[
            "info".to_string(),
            "--format".to_string(),
            "{{.ServerVersion}}".to_string(),
        ],
        None,
        &[],
    )
    .await;
    match info {
        Ok(out) if out.success => DockerStatus {
            installed: true,
            running: true,
            error: None,
        },
        Ok(out) => DockerStatus {
            installed: true,
            running: false,
            error: Some(out.stderr.trim().to_string()).filter(|s| !s.is_empty()),
        },
        Err(e) => DockerStatus {
            installed: true,
            running: false,
            error: Some(e),
        },
    }
}
