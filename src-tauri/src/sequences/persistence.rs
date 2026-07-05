use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

use crate::config::AppConfig;
use crate::sequences::state::{ExecutionSummary, SequenceExecution};
use crate::sequences::types::SequenceDefinition;

const SEQUENCES_DIR_ENV: &str = "OPEN_WHISPERER_SEQUENCES_DIR";
const SEQUENCES_DIR_ENV_DEV: &str = "OPEN_WHISPERER_SEQUENCES_DIR_DEV";
const SEQUENCES_DIR_ENV_PROD: &str = "OPEN_WHISPERER_SEQUENCES_DIR_PROD";

static SEQUENCES_DIR_OVERRIDE: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Directory for sequence YAML definitions and execution data
pub fn sequences_dir() -> PathBuf {
    if let Some(path) = SEQUENCES_DIR_OVERRIDE
        .get_or_init(resolve_sequences_dir_override)
        .as_ref()
    {
        return path.clone();
    }

    // Keep dev/prod sequence definitions separated by default.
    if cfg!(debug_assertions) {
        AppConfig::config_dir().join("sequences.dev")
    } else {
        AppConfig::config_dir().join("sequences")
    }
}

/// Directory for execution JSON snapshots
pub fn executions_dir() -> PathBuf {
    sequences_dir().join("executions")
}

fn resolve_sequences_dir_override() -> Option<PathBuf> {
    let env_specific = if cfg!(debug_assertions) {
        SEQUENCES_DIR_ENV_DEV
    } else {
        SEQUENCES_DIR_ENV_PROD
    };

    for key in [env_specific, SEQUENCES_DIR_ENV] {
        if let Some(value) = read_env_key(key) {
            let resolved = PathBuf::from(value);
            log::info!("[sequences] Using {} override: {}", key, resolved.display());
            return Some(resolved);
        }
    }

    None
}

fn read_env_key(key: &str) -> Option<String> {
    if let Ok(value) = std::env::var(key) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    for path in env_file_candidates() {
        if let Some(value) = parse_env_file_for_key(&path, key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    None
}

fn env_file_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let suffix = if cfg!(debug_assertions) {
        "development"
    } else {
        "production"
    };

    let mut names = Vec::new();
    names.push(format!(".env.{}.local", suffix));
    names.push(format!(".env.{}", suffix));
    names.push(".env.local".to_string());
    names.push(".env".to_string());

    if let Ok(cwd) = std::env::current_dir() {
        for name in &names {
            paths.push(cwd.join(name));
        }
        for name in &names {
            paths.push(cwd.join("src-tauri").join(name));
        }
    }

    paths
}

fn parse_env_file_for_key(path: &std::path::Path, key: &str) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let line = line.strip_prefix("export ").unwrap_or(line).trim();
        let (k, v) = line.split_once('=')?;
        if k.trim() != key {
            continue;
        }

        let mut value = v.trim().to_string();
        if value.len() >= 2 {
            let bytes = value.as_bytes();
            let first = bytes[0] as char;
            let last = bytes[value.len() - 1] as char;
            if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
                value = value[1..value.len() - 1].to_string();
            }
        }
        return Some(value);
    }

    None
}

/// Load all sequence definitions from `sequences/*.yaml` files.
///
/// Each file is parsed as a `SequenceDefinition`, with the `id` field
/// set to the filename stem (e.g., `deploy-pipeline.yaml` -> id `deploy-pipeline`).
///
/// If strict parsing fails (e.g. due to duplicate keys from a previous serialization
/// bug), the loader attempts to repair the YAML by deduplicating keys and retrying.
/// Repaired files are automatically re-saved with a backup of the corrupt version.
pub fn load_definitions() -> Result<Vec<SequenceDefinition>, String> {
    let dir = sequences_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut definitions = Vec::new();

    let entries =
        fs::read_dir(&dir).map_err(|e| format!("Failed to read sequences directory: {}", e))?;

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

        let mut def = match serde_yaml::from_str::<SequenceDefinition>(&content) {
            Ok(def) => def,
            Err(e) => {
                let err_msg = e.to_string();
                // If the error is about duplicate fields, attempt repair
                if err_msg.contains("duplicate field") {
                    log::error!(
                        "[sequences] Duplicate keys detected in {}, attempting repair...",
                        path.display()
                    );
                    match repair_and_reload(&path, &content) {
                        Ok(def) => {
                            log::error!("[sequences] Successfully repaired {}", path.display());
                            def
                        }
                        Err(repair_err) => {
                            log::error!(
                                "[sequences] Failed to repair {}: {}",
                                path.display(),
                                repair_err
                            );
                            continue;
                        }
                    }
                } else {
                    log::error!("[sequences] Failed to parse {}: {}", path.display(), e);
                    continue;
                }
            }
        };

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

    // Sort by name for consistent ordering
    definitions.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(definitions)
}

/// Attempt to repair a YAML file with duplicate keys by deduplicating them,
/// then re-parsing and re-saving the fixed version.
///
/// Keeps a `.corrupt` backup of the original broken file.
fn repair_and_reload(path: &std::path::Path, content: &str) -> Result<SequenceDefinition, String> {
    let repaired = dedup_yaml_keys(content);

    let def = serde_yaml::from_str::<SequenceDefinition>(&repaired)
        .map_err(|e| format!("Repair failed, still cannot parse: {}", e))?;

    // Save the corrupt original as .corrupt for debugging
    let corrupt_path = path.with_extension("yaml.corrupt");
    if let Err(e) = fs::copy(path, &corrupt_path) {
        log::error!(
            "[sequences] Warning: failed to save corrupt backup {}: {}",
            corrupt_path.display(),
            e
        );
    }

    // Re-serialize the successfully parsed definition to produce clean YAML
    let clean_content = serde_yaml::to_string(&def)
        .map_err(|e| format!("Failed to re-serialize repaired definition: {}", e))?;

    // Atomic write of the repaired file
    let tmp_path = path.with_extension("yaml.tmp");
    fs::write(&tmp_path, &clean_content)
        .map_err(|e| format!("Failed to write repaired file: {}", e))?;
    fs::rename(&tmp_path, path).map_err(|e| format!("Failed to rename repaired file: {}", e))?;

    Ok(def)
}

/// Remove duplicate keys within YAML mappings by tracking keys at each
/// indentation level and keeping only the last occurrence of each key.
///
/// This handles the specific corruption pattern from `#[serde(flatten)]` where
/// fields like `outputs` or `timeout` appear twice in the same mapping:
/// ```yaml
/// - id: some_node
///   outputs: []      # first (from flattened node type) — removed
///   condition: null
///   outputs: []      # duplicate (from NodeDefinition) — kept
/// ```
fn dedup_yaml_keys(content: &str) -> String {
    use std::collections::HashMap;

    let lines: Vec<&str> = content.lines().collect();
    // Track (effective_indent, key) -> line index in `lines`
    let mut key_positions: HashMap<(usize, String), usize> = HashMap::new();
    // Set of line indices to remove (earlier duplicates)
    let mut remove_indices: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut prev_indent: usize = 0;

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();

        // When indentation decreases, we've left nested mapping contexts.
        // Clear tracked keys at indent levels deeper than current.
        if indent < prev_indent {
            key_positions.retain(|(ki, _), _| *ki <= indent);
        }

        // A list item (`- key: val`) starts a new mapping context.
        // Clear tracked keys that belong to mappings inside the previous list item
        // (i.e., keys at indent levels deeper than this list item's indent).
        if trimmed.starts_with("- ") {
            key_positions.retain(|(ki, _), _| *ki <= indent);
        }

        if let Some((key, is_list_item)) = extract_yaml_key(trimmed) {
            // For `- key: val`, the key logically belongs to indent+2 (same as
            // subsequent mapping keys that are indented under the list item).
            let effective_indent = if is_list_item { indent + 2 } else { indent };
            let map_key = (effective_indent, key);

            if let Some(&prev_idx) = key_positions.get(&map_key) {
                // Duplicate key in the same mapping — mark the earlier one for removal
                remove_indices.insert(prev_idx);
                key_positions.insert(map_key, i);
            } else {
                key_positions.insert(map_key, i);
            }
        }

        prev_indent = indent;
    }

    lines
        .into_iter()
        .enumerate()
        .filter(|(i, _)| !remove_indices.contains(i))
        .map(|(_, line)| line)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Extract the key name from a YAML line like `  key: value` or `  key:`.
/// Returns `Some((key, is_list_item))` or `None` for comments, blank lines, etc.
fn extract_yaml_key(trimmed: &str) -> Option<(String, bool)> {
    // Skip empty lines, comments, and document markers
    if trimmed.is_empty()
        || trimmed.starts_with('#')
        || trimmed.starts_with("---")
        || trimmed.starts_with("...")
    {
        return None;
    }

    // Check if this is a list item with an inline key: `- key: val`
    let (key_part, is_list_item) = if trimmed.starts_with("- ") {
        (&trimmed[2..], true)
    } else {
        (trimmed, false)
    };

    // Find the colon that separates key from value
    // Handle quoted keys: 'key': value or "key": value
    if let Some(colon_pos) = key_part.find(':') {
        let key = key_part[..colon_pos]
            .trim()
            .trim_matches(|c| c == '\'' || c == '"');
        if !key.is_empty() && !key.contains(' ') {
            return Some((key.to_string(), is_list_item));
        }
    }

    None
}

/// Save a sequence definition as YAML to `sequences/{slug}.yaml`.
///
/// The filename is derived from the definition's `id` field (or slugified `name`
/// if `id` is empty).
///
/// Safety measures:
/// 1. **Round-trip validation** — Serialized YAML is deserialized back to verify
///    it can be loaded. Catches issues like duplicate keys from `#[serde(flatten)]`.
/// 2. **Backup** — If the target file already exists, a `.bak` copy is kept.
/// 3. **Atomic write** — Writes to a `.tmp` file first, then renames to prevent
///    partial writes on crash.
pub fn save_definition(def: &SequenceDefinition) -> Result<(), String> {
    let dir = sequences_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sequences directory: {}", e))?;

    let slug = if def.id.is_empty() {
        slugify(&def.name)
    } else {
        def.id.clone()
    };

    let path = dir.join(format!("{}.yaml", slug));

    let content = serde_yaml::to_string(def)
        .map_err(|e| format!("Failed to serialize sequence definition: {}", e))?;

    // Round-trip validation: verify the YAML we just produced can be parsed back.
    // This catches serialization bugs (e.g. duplicate keys from serde flatten conflicts).
    if let Err(e) = serde_yaml::from_str::<SequenceDefinition>(&content) {
        return Err(format!(
            "Serialization round-trip failed (refusing to write corrupt data): {}",
            e
        ));
    }

    // Backup: if the file already exists, keep a .bak copy for recovery
    if path.exists() {
        let backup_path = dir.join(format!("{}.yaml.bak", slug));
        if let Err(e) = fs::copy(&path, &backup_path) {
            log::error!(
                "[sequences] Warning: failed to create backup {}: {}",
                backup_path.display(),
                e
            );
            // Continue anyway — backup failure shouldn't block save
        }
    }

    // Atomic write: write to .tmp, then rename to final path
    let tmp_path = dir.join(format!("{}.yaml.tmp", slug));
    fs::write(&tmp_path, &content)
        .map_err(|e| format!("Failed to write temp file {}: {}", tmp_path.display(), e))?;

    fs::rename(&tmp_path, &path)
        .map_err(|e| format!("Failed to rename temp file to {}: {}", path.display(), e))?;

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
///
/// Uses atomic write (temp file + rename) to prevent partial writes on crash.
pub fn save_execution(exec: &SequenceExecution) -> Result<(), String> {
    let dir = executions_dir();
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create executions directory: {}", e))?;

    let path = dir.join(format!("{}.json", exec.id));

    let content = serde_json::to_string_pretty(exec)
        .map_err(|e| format!("Failed to serialize execution: {}", e))?;

    // Atomic write: write to .tmp, then rename to final path
    let tmp_path = dir.join(format!("{}.json.tmp", exec.id));
    fs::write(&tmp_path, &content)
        .map_err(|e| format!("Failed to write temp file {}: {}", tmp_path.display(), e))?;

    fs::rename(&tmp_path, &path)
        .map_err(|e| format!("Failed to rename temp file to {}: {}", path.display(), e))?;

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

    let entries =
        fs::read_dir(&dir).map_err(|e| format!("Failed to read executions directory: {}", e))?;

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
                log::error!("[sequences] Failed to read {}: {}", path.display(), e);
                continue;
            }
        };

        match serde_json::from_str::<SequenceExecution>(&content) {
            Ok(exec) => {
                summaries.push(exec.to_summary());
            }
            Err(e) => {
                log::error!("[sequences] Failed to parse {}: {}", path.display(), e);
                continue;
            }
        }
    }

    // Sort by started_at descending (most recent first)
    summaries.sort_by(|a, b| b.started_at.cmp(&a.started_at));

    Ok(summaries)
}

/// Delete a single execution snapshot from disk.
pub fn delete_execution(exec_id: &str) -> Result<(), String> {
    let path = executions_dir().join(format!("{}.json", exec_id));
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete execution {}: {}", exec_id, e))?;
    }
    Ok(())
}

/// Delete completed execution snapshots older than `max_age_days` days.
///
/// Returns the number of executions deleted.
#[allow(dead_code)]
pub fn cleanup_old_executions(max_age_days: u64) -> Result<usize, String> {
    let dir = executions_dir();
    if !dir.exists() {
        return Ok(0);
    }

    let cutoff = chrono::Utc::now() - chrono::Duration::days(max_age_days as i64);
    let mut deleted = 0;

    let entries =
        fs::read_dir(&dir).map_err(|e| format!("Failed to read executions directory: {}", e))?;

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
                log::error!(
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
        assert_eq!(slugify("already clean"), "already-clean");
    }

    #[test]
    fn test_dedup_yaml_keys_removes_duplicate_outputs() {
        let corrupt = "\
- id: github_pr_8
  type: github_pr
  title: ''
  outputs: []
  condition: null
  timeout: null
  next: null
  outputs: []";

        let repaired = dedup_yaml_keys(corrupt);
        // Should only have one `outputs` line
        let outputs_count = repaired
            .lines()
            .filter(|l| l.trim_start().starts_with("outputs:"))
            .count();
        assert_eq!(
            outputs_count, 1,
            "Should have exactly one outputs key, got:\n{}",
            repaired
        );
    }

    #[test]
    fn test_dedup_yaml_keys_removes_duplicate_timeout() {
        let corrupt = "\
- id: github_pr_wait_9
  type: github_pr_wait
  pr: ''
  wait_for: checks
  poll_interval: null
  timeout: null
  outputs: []
  condition: null
  timeout: null
  next: null
  outputs: []";

        let repaired = dedup_yaml_keys(corrupt);
        let timeout_count = repaired
            .lines()
            .filter(|l| l.trim_start().starts_with("timeout:"))
            .count();
        let outputs_count = repaired
            .lines()
            .filter(|l| l.trim_start().starts_with("outputs:"))
            .count();
        assert_eq!(
            timeout_count, 1,
            "Should have exactly one timeout key, got:\n{}",
            repaired
        );
        assert_eq!(
            outputs_count, 1,
            "Should have exactly one outputs key, got:\n{}",
            repaired
        );
    }

    #[test]
    fn test_dedup_yaml_keys_preserves_valid_yaml() {
        let valid = "\
name: Test
nodes:
- id: step1
  type: prompt
  prompt: hello
  outputs: []
- id: step2
  type: script
  command: echo hi
  outputs: []";

        let result = dedup_yaml_keys(valid);
        // outputs appears in different list items (different mappings) — both should be kept
        let outputs_count = result
            .lines()
            .filter(|l| l.trim_start().starts_with("outputs:"))
            .count();
        assert_eq!(
            outputs_count, 2,
            "Each list item should keep its outputs, got:\n{}",
            result
        );
    }

    #[test]
    fn test_dedup_yaml_keys_real_corrupt_file() {
        // Exact pattern from the user's corrupt file
        let corrupt = "\
id: new-sequence
name: New Sequence
nodes:
- id: prompt_1
  type: prompt
  prompt: ''
  model: sonnet
  condition: null
  timeout: null
  next: null
  outputs: []
- id: github_pr_8
  type: github_pr
  title: ''
  body: null
  target_branch: null
  draft: null
  labels: null
  reviewers: null
  outputs: []
  condition: null
  timeout: null
  next: null
  outputs: []
triggers:
- type: manual";

        let repaired = dedup_yaml_keys(corrupt);
        // The repaired YAML should be parseable by serde_yaml
        let result = serde_yaml::from_str::<SequenceDefinition>(&repaired);
        assert!(
            result.is_ok(),
            "Repaired YAML should parse, error: {:?}\nRepaired:\n{}",
            result.err(),
            repaired
        );

        let def = result.unwrap();
        assert_eq!(def.nodes.len(), 2);
        assert_eq!(def.nodes[1].id, "github_pr_8");
    }
}
