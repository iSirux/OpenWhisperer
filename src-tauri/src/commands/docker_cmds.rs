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

fn docker_contexts_dir() -> PathBuf {
    #[cfg(debug_assertions)]
    let dirname = "docker-contexts-dev";
    #[cfg(not(debug_assertions))]
    let dirname = "docker-contexts";
    AppConfig::config_dir().join(dirname)
}

/// Write the embedded Docker build context for `provider` to disk and return
/// its directory. Overwrites on every call so app updates propagate.
fn write_context(provider: &str) -> Result<PathBuf, String> {
    let context: EmbeddedContext = match provider {
        "sherpa-onnx" => SHERPA_ONNX_CONTEXT,
        "moonshine" => MOONSHINE_CONTEXT,
        other => return Err(format!("Unknown docker context: {}", other)),
    };

    let dir = docker_contexts_dir().join(provider);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;

    for (name, contents) in context {
        let path = dir.join(name);
        fs::write(&path, contents)
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    }

    Ok(dir)
}

#[cfg(target_os = "windows")]
fn write_setup_script(
    dir: &Path,
    image: &str,
    container_name: &str,
    run_command: &str,
) -> Result<PathBuf, String> {
    let rm_line = if container_name.is_empty() {
        String::new()
    } else {
        format!("docker rm -f {} >nul 2>nul\r\n", container_name)
    };
    let script = format!(
        "@echo off\r\n\
         echo === OpenWhisperer: building {image} ===\r\n\
         {rm_line}\
         docker build -t {image} \"{dir}\"\r\n\
         if errorlevel 1 goto :fail\r\n\
         echo.\r\n\
         echo === Starting container ===\r\n\
         {run_command}\r\n\
         if errorlevel 1 goto :fail\r\n\
         echo.\r\n\
         echo === Success! The container is running. You can close this window. ===\r\n\
         goto :eof\r\n\
         :fail\r\n\
         echo.\r\n\
         echo *** FAILED - see the errors above (is Docker Desktop running?) ***\r\n",
        image = image,
        rm_line = rm_line,
        dir = dir.display(),
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
) -> Result<PathBuf, String> {
    let rm_line = if container_name.is_empty() {
        String::new()
    } else {
        format!("docker rm -f {} 2>/dev/null || true\n", container_name)
    };
    let script = format!(
        "#!/bin/sh\n\
         echo \"=== OpenWhisperer: building {image} ===\"\n\
         {rm_line}\
         set -e\n\
         docker build -t {image} \"{dir}\"\n\
         echo\n\
         echo \"=== Starting container ===\"\n\
         {run_command}\n\
         echo\n\
         echo \"=== Success! The container is running. You can close this window. ===\"\n",
        image = image,
        rm_line = rm_line,
        dir = dir.display(),
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
    let dir = write_context(&provider)?;
    let script = write_setup_script(&dir, &image, &container_name, &run_command)?;
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
