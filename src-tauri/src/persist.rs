//! Shared JSON persistence helpers: atomic writes with optional rolling backups,
//! and lenient load-or-default reads. All persisted app state should go through
//! these instead of hand-rolling read/write scaffolding.
#![allow(dead_code)]

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Per-process counter making every temp file name unique, so concurrent
/// writers of the same destination (threads or processes) never share one.
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// `<file>.<pid>.<n>.tmp` next to `path` — unique per call within this process,
/// and the pid keeps other processes (e.g. a second app instance) apart.
fn unique_tmp_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!("{}.{}.{}.tmp", file_name, std::process::id(), n))
}

/// Rename attempts before giving up (Windows can refuse rename-over-existing
/// transiently while another process — AV, indexer, a reader — holds the target).
const RENAME_ATTEMPTS: u32 = 5;

/// Atomically write `contents` to `path` by writing to a unique sibling temp file,
/// fsyncing it, then renaming over the destination.
pub fn atomic_write(path: &Path, contents: &str) -> std::io::Result<()> {
    atomic_write_bytes(path, contents.as_bytes())
}

/// Byte variant of [`atomic_write`]. The destination is never deleted: if the
/// rename keeps failing, the previous contents stay in place and the error is
/// returned (a write is lost, never the file).
pub fn atomic_write_bytes(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let tmp_path = unique_tmp_path(path);

    let written = (|| {
        let mut f = fs::File::create(&tmp_path)?;
        f.write_all(contents)?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }

    let mut attempt = 0;
    loop {
        match fs::rename(&tmp_path, path) {
            Ok(()) => break,
            // Our unique temp vanished (e.g. a tmp sweep): nothing to install,
            // and the destination must not be touched.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !tmp_path.exists() => {
                log::error!("Atomic write temp {:?} disappeared before rename: {}", tmp_path, e);
                return Err(e);
            }
            Err(e) => {
                attempt += 1;
                if attempt >= RENAME_ATTEMPTS {
                    let _ = fs::remove_file(&tmp_path);
                    log::error!("Atomic rename failed for {:?} after {} attempts: {}", path, attempt, e);
                    return Err(e);
                }
                std::thread::sleep(std::time::Duration::from_millis(10 << attempt));
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

/// Copy an unparseable file aside as `<file>.corrupt-<unix ms>` before anything
/// can overwrite it. Returns the backup path on success.
pub fn backup_corrupt(path: &Path) -> Option<PathBuf> {
    let file_name = path.file_name()?.to_string_lossy().to_string();
    let ts = chrono::Utc::now().timestamp_millis();
    let backup = path.with_file_name(format!("{}.corrupt-{}", file_name, ts));
    match fs::copy(path, &backup) {
        Ok(_) => Some(backup),
        Err(e) => {
            log::error!("Failed to back up corrupt {:?}: {}", path, e);
            None
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Arc;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ow-persist-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn tmp_names_unique_under_concurrency() {
        let path = Arc::new(PathBuf::from("x/items.json"));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let p = path.clone();
                std::thread::spawn(move || (0..200).map(|_| unique_tmp_path(&p)).collect::<Vec<_>>())
            })
            .collect();
        let mut all = HashSet::new();
        for h in handles {
            for p in h.join().unwrap() {
                assert!(all.insert(p), "duplicate temp name");
            }
        }
        assert_eq!(all.len(), 1600);
    }

    #[test]
    fn concurrent_writes_never_lose_the_file() {
        let dir = temp_dir("concurrent");
        let path = Arc::new(dir.join("meeting.json"));
        atomic_write(&path, "{\"v\":-1}").unwrap();
        let handles: Vec<_> = (0..8)
            .map(|t| {
                let p = path.clone();
                std::thread::spawn(move || {
                    for i in 0..50 {
                        // Rename may still lose a transient Windows sharing race
                        // after the retries; the file itself must never vanish.
                        let _ = atomic_write(&p, &format!("{{\"v\":{}}}", t * 1000 + i));
                        let text = fs::read_to_string(&*p).expect("target must always exist");
                        serde_json::from_str::<serde_json::Value>(&text).expect("never torn");
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert!(path.exists());
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {:?}", leftovers);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_backup_copies_aside() {
        let dir = temp_dir("corrupt");
        let path = dir.join("journal.json");
        fs::write(&path, "{not json").unwrap();
        let b = backup_corrupt(&path).unwrap();
        assert_eq!(fs::read_to_string(&b).unwrap(), "{not json");
        assert!(path.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
