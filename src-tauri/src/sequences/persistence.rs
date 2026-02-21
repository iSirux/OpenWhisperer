use std::fs;
use std::path::PathBuf;

use crate::config::AppConfig;
use crate::sequences::types::SequenceDefinition;
use crate::sequences::state::{ExecutionSummary, SequenceExecution};

/// Directory for sequence YAML definitions and execution data
pub fn sequences_dir() -> PathBuf {
    AppConfig::config_dir().join("sequences")
}

/// Directory for execution JSON snapshots
pub fn executions_dir() -> PathBuf {
    sequences_dir().join("executions")
}

/// Load all sequence definitions from `sequences/*.yaml` files.
///
/// Each file is parsed as a `SequenceDefinition`, with the `id` field
/// set to the filename stem (e.g., `deploy-pipeline.yaml` -> id `deploy-pipeline`).
pub fn load_definitions() -> Result<Vec<SequenceDefinition>, String> {
    let dir = sequences_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut definitions = Vec::new();

    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read sequences directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        // Only process .yaml and .yml files (skip directories and other files)
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !matches!(ext, "yaml" | "yml") {
            continue;
        }

        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

        match serde_yaml::from_str::<SequenceDefinition>(&content) {
            Ok(mut def) => {
                // Set id from filename stem
                if def.id.is_empty() {
                    def.id = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("unknown")
                        .to_string();
                }
                definitions.push(def);
            }
            Err(e) => {
                eprintln!(
                    "[sequences] Failed to parse {}: {}",
                    path.display(),
                    e
                );
                // Skip invalid files rather than failing the entire load
                continue;
            }
        }
    }

    // Sort by name for consistent ordering
    definitions.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(definitions)
}

/// Save a sequence definition as YAML to `sequences/{slug}.yaml`.
///
/// The filename is derived from the definition's `id` field (or slugified `name`
/// if `id` is empty).
pub fn save_definition(def: &SequenceDefinition) -> Result<(), String> {
    let dir = sequences_dir();
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create sequences directory: {}", e))?;

    let slug = if def.id.is_empty() {
        slugify(&def.name)
    } else {
        def.id.clone()
    };

    let path = dir.join(format!("{}.yaml", slug));

    let content = serde_yaml::to_string(def)
        .map_err(|e| format!("Failed to serialize sequence definition: {}", e))?;

    fs::write(&path, content)
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;

    Ok(())
}

/// Delete a sequence definition file by id.
pub fn delete_definition(id: &str) -> Result<(), String> {
    let dir = sequences_dir();

    // Try both .yaml and .yml extensions
    let yaml_path = dir.join(format!("{}.yaml", id));
    let yml_path = dir.join(format!("{}.yml", id));

    if yaml_path.exists() {
        fs::remove_file(&yaml_path)
            .map_err(|e| format!("Failed to delete {}: {}", yaml_path.display(), e))?;
    } else if yml_path.exists() {
        fs::remove_file(&yml_path)
            .map_err(|e| format!("Failed to delete {}: {}", yml_path.display(), e))?;
    } else {
        return Err(format!("Sequence definition '{}' not found", id));
    }

    Ok(())
}

/// Load a single execution snapshot from `executions/{exec_id}.json`.
pub fn load_execution(exec_id: &str) -> Result<SequenceExecution, String> {
    let path = executions_dir().join(format!("{}.json", exec_id));

    if !path.exists() {
        return Err(format!("Execution '{}' not found", exec_id));
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read execution {}: {}", exec_id, e))?;

    serde_json::from_str::<SequenceExecution>(&content)
        .map_err(|e| format!("Failed to parse execution {}: {}", exec_id, e))
}

/// Save an execution snapshot as JSON to `executions/{id}.json`.
pub fn save_execution(exec: &SequenceExecution) -> Result<(), String> {
    let dir = executions_dir();
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create executions directory: {}", e))?;

    let path = dir.join(format!("{}.json", exec.id));

    let content = serde_json::to_string_pretty(exec)
        .map_err(|e| format!("Failed to serialize execution: {}", e))?;

    fs::write(&path, content)
        .map_err(|e| format!("Failed to write execution {}: {}", exec.id, e))?;

    Ok(())
}

/// List all execution summaries from `executions/*.json`, sorted by started_at descending.
///
/// This reads each JSON file and extracts only the summary fields for efficient listing.
pub fn list_executions() -> Result<Vec<ExecutionSummary>, String> {
    let dir = executions_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read executions directory: {}", e))?;

    let mut summaries = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext != "json" {
            continue;
        }

        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!(
                    "[sequences] Failed to read {}: {}",
                    path.display(),
                    e
                );
                continue;
            }
        };

        match serde_json::from_str::<SequenceExecution>(&content) {
            Ok(exec) => {
                summaries.push(exec.to_summary());
            }
            Err(e) => {
                eprintln!(
                    "[sequences] Failed to parse {}: {}",
                    path.display(),
                    e
                );
                continue;
            }
        }
    }

    // Sort by started_at descending (most recent first)
    summaries.sort_by(|a, b| b.started_at.cmp(&a.started_at));

    Ok(summaries)
}

/// Delete completed execution snapshots older than `max_age_days` days.
///
/// Returns the number of executions deleted.
pub fn cleanup_old_executions(max_age_days: u64) -> Result<usize, String> {
    let dir = executions_dir();
    if !dir.exists() {
        return Ok(0);
    }

    let cutoff = chrono::Utc::now() - chrono::Duration::days(max_age_days as i64);
    let mut deleted = 0;

    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read executions directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext != "json" {
            continue;
        }

        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let exec = match serde_json::from_str::<SequenceExecution>(&content) {
            Ok(e) => e,
            Err(_) => continue,
        };

        // Only delete completed, failed, or cancelled executions
        let is_terminal = matches!(
            exec.status,
            crate::sequences::state::ExecutionStatus::Completed
                | crate::sequences::state::ExecutionStatus::Failed
                | crate::sequences::state::ExecutionStatus::Cancelled
        );

        if !is_terminal {
            continue;
        }

        // Check age based on completed_at (or started_at as fallback)
        let timestamp = exec.completed_at.unwrap_or(exec.started_at);
        if timestamp < cutoff {
            if let Err(e) = fs::remove_file(&path) {
                eprintln!(
                    "[sequences] Failed to delete old execution {}: {}",
                    path.display(),
                    e
                );
            } else {
                deleted += 1;
            }
        }
    }

    Ok(deleted)
}

/// Convert a name to a filename-safe slug.
///
/// - Lowercase
/// - Replace spaces and underscores with hyphens
/// - Remove characters that are not alphanumeric or hyphens
/// - Collapse multiple hyphens
/// - Trim leading/trailing hyphens
pub fn slugify(name: &str) -> String {
    let mut slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c
            } else if c == ' ' || c == '_' || c == '.' {
                '-'
            } else {
                // Drop special characters
                '\0'
            }
        })
        .filter(|c| *c != '\0')
        .collect();

    // Collapse multiple hyphens
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }

    // Trim leading/trailing hyphens
    slug.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slugify_basic() {
        assert_eq!(slugify("Deploy Pipeline"), "deploy-pipeline");
        assert_eq!(slugify("My Cool Sequence"), "my-cool-sequence");
    }

    #[test]
    fn test_slugify_special_chars() {
        assert_eq!(slugify("test@#$%name"), "testname");
        assert_eq!(slugify("hello_world"), "hello-world");
        assert_eq!(slugify("file.name.here"), "file-name-here");
    }

    #[test]
    fn test_slugify_multiple_spaces() {
        assert_eq!(slugify("lots   of   spaces"), "lots-of-spaces");
    }

    #[test]
    fn test_slugify_leading_trailing() {
        assert_eq!(slugify("  trimmed  "), "trimmed");
        assert_eq!(slugify("--dashes--"), "dashes");
    }

    #[test]
    fn test_slugify_already_clean() {
        assert_eq!(slugify("already-clean"), "already-clean");
    }
}
