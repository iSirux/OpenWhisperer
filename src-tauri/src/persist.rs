//! Shared JSON persistence helpers: atomic writes with optional rolling backups,
//! and lenient load-or-default reads. All persisted app state should go through
//! these instead of hand-rolling read/write scaffolding.
#![allow(dead_code)]

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::Path;

/// Atomically write `contents` to `path` by writing to a unique sibling temp file,
/// fsyncing it, then renaming over the destination.
pub fn atomic_write(path: &Path, contents: &str) -> std::io::Result<()> {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let tmp_path = path.with_file_name(format!("{}.{}.tmp", file_name, std::process::id()));

    {
        let mut f = fs::File::create(&tmp_path)?;
        f.write_all(contents.as_bytes())?;
        f.sync_all()?;
    }

    match fs::rename(&tmp_path, path) {
        Ok(()) => {}
        Err(e) => {
            // Windows can fail rename-over-existing under contention; retry once after removing.
            let _ = fs::remove_file(path);
            if let Err(e2) = fs::rename(&tmp_path, path) {
                let _ = fs::remove_file(&tmp_path);
                log::error!("Atomic rename failed for {:?}: {} (after {})", path, e2, e);
                return Err(e2);
            }
        }
    }

    // Best-effort directory fsync so the rename itself is durable (no-op on Windows).
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        if let Ok(dir) = fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }

    Ok(())
}

/// Remove leftover `*.tmp` files in `dir` from interrupted atomic writes.
pub fn cleanup_tmp_files(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().is_some_and(|e| e == "tmp") {
            let _ = fs::remove_file(&p);
        }
    }
}

/// Load JSON from `path`, returning `T::default()` (and logging) when the file is
/// missing or unparseable. `label` names the artifact in log messages.
pub fn load_json_or_default<T: DeserializeOwned + Default>(path: &Path, label: &str) -> T {
    if !path.exists() {
        return T::default();
    }
    match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                log::error!("Failed to parse {} at {:?}: {}", label, path, e);
                T::default()
            }
        },
        Err(e) => {
            log::error!("Failed to read {} at {:?}: {}", label, path, e);
            T::default()
        }
    }
}

/// Serialize `value` as pretty JSON and atomically write it to `path`, creating
/// parent directories as needed. When `backups > 0`, rotates `path.bak1..bakN`
/// before overwriting an existing file.
pub fn save_json_atomic<T: Serialize>(
    path: &Path,
    value: &T,
    label: &str,
    backups: usize,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory for {}: {}", label, e))?;
    }

    let json = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize {}: {}", label, e))?;

    if backups > 0 && path.exists() {
        rotate_backups(path, backups);
    }

    atomic_write(path, &json).map_err(|e| format!("Failed to write {}: {}", label, e))
}

fn rotate_backups(path: &Path, count: usize) {
    let bak = |n: usize| {
        let file_name = path
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string());
        path.with_file_name(format!("{}.bak{}", file_name, n))
    };
    // Shift older backups up, dropping the oldest.
    for n in (1..count).rev() {
        let from = bak(n);
        if from.exists() {
            let _ = fs::rename(&from, bak(n + 1));
        }
    }
    let _ = fs::copy(path, bak(1));
}
