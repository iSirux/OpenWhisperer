use crate::config::{AppConfig, LaunchCommand};
use crate::launch::LaunchManager;
use parking_lot::Mutex;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

type ConfigState = Mutex<AppConfig>;

/// Scan a repository for auto-detectable launch commands.
/// Checks the repo root and one level of subdirectories for package.json,
/// docker-compose.yml, Makefile, Cargo.toml, pyproject.toml, etc.
#[tauri::command]
pub fn scan_repo_launch_commands(repo_path: String) -> Result<Vec<LaunchCommand>, String> {
    let root = PathBuf::from(&repo_path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", repo_path));
    }

    let mut commands = Vec::new();

    // Scan root directory
    scan_directory(&root, None, &mut commands);

    // Scan one level of subdirectories
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let dir_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();

                // Skip hidden dirs and common non-project dirs
                if dir_name.starts_with('.')
                    || dir_name == "node_modules"
                    || dir_name == "target"
                    || dir_name == "dist"
                    || dir_name == "build"
                    || dir_name == "__pycache__"
                    || dir_name == "venv"
                    || dir_name == ".venv"
                {
                    continue;
                }

                scan_directory(&path, Some(&dir_name), &mut commands);
            }
        }
    }

    Ok(commands)
}

/// Scan a single directory for recognizable project files and extract launch commands.
fn scan_directory(dir: &Path, subdir: Option<&str>, commands: &mut Vec<LaunchCommand>) {
    // package.json → npm scripts
    let pkg_json = dir.join("package.json");
    if pkg_json.exists() {
        if let Ok(content) = fs::read_to_string(&pkg_json) {
            scan_package_json(&content, subdir, commands);
        }
    }

    // docker-compose.yml / docker-compose.yaml
    for name in &[
        "docker-compose.yml",
        "docker-compose.yaml",
        "compose.yml",
        "compose.yaml",
    ] {
        let compose_file = dir.join(name);
        if compose_file.exists() {
            if let Ok(content) = fs::read_to_string(&compose_file) {
                scan_docker_compose(&content, subdir, commands);
            }
            break; // Only process the first found compose file
        }
    }

    // Makefile
    let makefile = dir.join("Makefile");
    if makefile.exists() {
        if let Ok(content) = fs::read_to_string(&makefile) {
            scan_makefile(&content, subdir, commands);
        }
    }

    // Cargo.toml
    let cargo_toml = dir.join("Cargo.toml");
    if cargo_toml.exists() {
        if let Ok(content) = fs::read_to_string(&cargo_toml) {
            scan_cargo_toml(&content, subdir, commands);
        }
    }

    // pyproject.toml / manage.py
    let pyproject = dir.join("pyproject.toml");
    let manage_py = dir.join("manage.py");
    if pyproject.exists() || manage_py.exists() {
        scan_python_project(dir, subdir, commands);
    }
}

/// Extract npm scripts from package.json
fn scan_package_json(content: &str, subdir: Option<&str>, commands: &mut Vec<LaunchCommand>) {
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(content);
    let Ok(json) = parsed else { return };

    let scripts = json.get("scripts").and_then(|s| s.as_object());
    let Some(scripts) = scripts else { return };

    // Prioritize common dev/run scripts
    let interesting_scripts = [
        ("dev", "Dev Server"),
        ("start", "Start"),
        ("serve", "Serve"),
        ("watch", "Watch"),
        ("build", "Build"),
        ("test", "Test"),
        ("preview", "Preview"),
        ("storybook", "Storybook"),
    ];

    let prefix = subdir.map(|s| format!("{} ", s)).unwrap_or_default();
    let working_dir = subdir.map(|s| s.to_string());

    // Check if yarn.lock or pnpm-lock.yaml exists to determine package manager
    // Default to npm
    let pkg_mgr = "npm run";

    for (key, label) in &interesting_scripts {
        if scripts.contains_key(*key) {
            commands.push(LaunchCommand {
                id: uuid::Uuid::new_v4().to_string(),
                name: format!("{}{}", prefix, label),
                command: format!("{} {}", pkg_mgr, key),
                working_dir: working_dir.clone(),
                env: None,
                auto_detected: true,
            });
        }
    }
}

/// Extract services from docker-compose files
fn scan_docker_compose(content: &str, subdir: Option<&str>, commands: &mut Vec<LaunchCommand>) {
    // Simple parsing: look for service names under "services:" section
    let mut in_services = false;
    let mut service_names = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "services:" {
            in_services = true;
            continue;
        }
        if in_services {
            // A top-level key under services (not indented further than 2 spaces)
            if !line.starts_with(' ') && !line.is_empty() && !line.starts_with('#') {
                // We've left the services section
                break;
            }
            // Service name: indented exactly 2 spaces (or 1 tab), ends with ':'
            if let Some(stripped) = line.strip_prefix("  ") {
                if !stripped.starts_with(' ')
                    && stripped.ends_with(':')
                    && !stripped.starts_with('#')
                {
                    let name = stripped.trim_end_matches(':').trim();
                    if !name.is_empty() {
                        service_names.push(name.to_string());
                    }
                }
            }
        }
    }

    let prefix = subdir.map(|s| format!("{} ", s)).unwrap_or_default();
    let working_dir = subdir.map(|s| s.to_string());

    // Add "docker compose up" for all services
    if !service_names.is_empty() {
        commands.push(LaunchCommand {
            id: uuid::Uuid::new_v4().to_string(),
            name: format!("{}Docker Compose (all)", prefix),
            command: "docker compose up".to_string(),
            working_dir: working_dir.clone(),
            env: None,
            auto_detected: true,
        });

        // Individual services (only if there are multiple)
        if service_names.len() > 1 {
            for svc in &service_names {
                commands.push(LaunchCommand {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: format!("{}Docker: {}", prefix, svc),
                    command: format!("docker compose up {}", svc),
                    working_dir: working_dir.clone(),
                    env: None,
                    auto_detected: true,
                });
            }
        }
    }
}

/// Extract common targets from Makefile
fn scan_makefile(content: &str, subdir: Option<&str>, commands: &mut Vec<LaunchCommand>) {
    let interesting_targets = ["dev", "run", "serve", "start", "build", "test", "watch"];
    let prefix = subdir.map(|s| format!("{} ", s)).unwrap_or_default();
    let working_dir = subdir.map(|s| s.to_string());

    for line in content.lines() {
        // Makefile targets: "target:" or "target: deps"
        if let Some(target) = line.split(':').next() {
            let target = target.trim();
            if interesting_targets.contains(&target)
                && !target.contains(' ')
                && !target.starts_with('.')
                && !target.starts_with('#')
            {
                let label = match target {
                    "dev" => "Make Dev",
                    "run" => "Make Run",
                    "serve" => "Make Serve",
                    "start" => "Make Start",
                    "build" => "Make Build",
                    "test" => "Make Test",
                    "watch" => "Make Watch",
                    _ => target,
                };
                commands.push(LaunchCommand {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: format!("{}{}", prefix, label),
                    command: format!("make {}", target),
                    working_dir: working_dir.clone(),
                    env: None,
                    auto_detected: true,
                });
            }
        }
    }
}

/// Detect Cargo.toml and add cargo commands
fn scan_cargo_toml(content: &str, subdir: Option<&str>, commands: &mut Vec<LaunchCommand>) {
    let prefix = subdir.map(|s| format!("{} ", s)).unwrap_or_default();
    let working_dir = subdir.map(|s| s.to_string());

    // Check if it has a [[bin]] section or [package] (indicates runnable)
    let has_bin = content.contains("[[bin]]") || content.contains("[package]");
    if has_bin {
        commands.push(LaunchCommand {
            id: uuid::Uuid::new_v4().to_string(),
            name: format!("{}Cargo Run", prefix),
            command: "cargo run".to_string(),
            working_dir: working_dir.clone(),
            env: None,
            auto_detected: true,
        });
    }
}

/// Detect Python project files and add commands
fn scan_python_project(dir: &Path, subdir: Option<&str>, commands: &mut Vec<LaunchCommand>) {
    let prefix = subdir.map(|s| format!("{} ", s)).unwrap_or_default();
    let working_dir = subdir.map(|s| s.to_string());

    // Django manage.py
    if dir.join("manage.py").exists() {
        commands.push(LaunchCommand {
            id: uuid::Uuid::new_v4().to_string(),
            name: format!("{}Django Server", prefix),
            command: "python manage.py runserver".to_string(),
            working_dir: working_dir.clone(),
            env: None,
            auto_detected: true,
        });
    }

    // Check pyproject.toml for common frameworks
    let pyproject = dir.join("pyproject.toml");
    if pyproject.exists() {
        if let Ok(content) = fs::read_to_string(&pyproject) {
            if content.contains("fastapi") || content.contains("uvicorn") {
                commands.push(LaunchCommand {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: format!("{}Uvicorn Server", prefix),
                    command: "uvicorn main:app --reload".to_string(),
                    working_dir: working_dir.clone(),
                    env: None,
                    auto_detected: true,
                });
            }
            if content.contains("flask") {
                commands.push(LaunchCommand {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: format!("{}Flask Server", prefix),
                    command: "flask run --reload".to_string(),
                    working_dir: working_dir.clone(),
                    env: None,
                    auto_detected: true,
                });
            }
        }
    }
}

/// Launch a specific profile by its ID for a given repo.
/// `cwd` overrides the repo's configured path as the working directory (e.g. a worktree).
#[tauri::command]
pub fn launch_profile(
    launch_mgr: State<Arc<LaunchManager>>,
    config: State<ConfigState>,
    repo_id: String,
    profile_id: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let cfg = config.lock();
    let repo = cfg
        .repos
        .iter()
        .find(|r| r.id.as_deref() == Some(&repo_id))
        .ok_or_else(|| format!("Repo not found: {}", repo_id))?;

    let profile = repo
        .launch_profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Profile not found: {}", profile_id))?;

    let commands_to_launch: Vec<LaunchCommand> = profile
        .command_ids
        .iter()
        .filter_map(|cid| repo.launch_commands.iter().find(|c| c.id == *cid))
        .cloned()
        .collect();

    if commands_to_launch.is_empty() {
        return Err("No commands found for this profile".to_string());
    }

    // Use the provided cwd override (worktree path) if given, otherwise fall back to the repo's configured path.
    let repo_path = cwd.unwrap_or_else(|| repo.path.clone());
    let terminal = cfg.system.launch_terminal.clone();
    drop(cfg);

    launch_mgr.launch_commands(&repo_id, &repo_path, &commands_to_launch, &terminal)
}

/// Launch specific commands directly (for ad-hoc subset launches)
#[tauri::command]
pub fn launch_commands(
    launch_mgr: State<Arc<LaunchManager>>,
    config: State<ConfigState>,
    repo_id: String,
    repo_path: String,
    commands: Vec<LaunchCommand>,
) -> Result<(), String> {
    let terminal = config.lock().system.launch_terminal.clone();
    launch_mgr.launch_commands(&repo_id, &repo_path, &commands, &terminal)
}

/// Stop all running processes for a given repo
#[tauri::command]
pub fn stop_launch_profile(
    launch_mgr: State<Arc<LaunchManager>>,
    repo_id: String,
) -> Result<(), String> {
    launch_mgr.stop_all(&repo_id)
}

/// Get the list of currently running command IDs for a repo
#[tauri::command]
pub fn get_launch_status(launch_mgr: State<Arc<LaunchManager>>, repo_id: String) -> Vec<String> {
    launch_mgr.get_running_command_ids(&repo_id)
}
