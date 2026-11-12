//! Removes installer leftovers from earlier in-app updates.
//!
//! On Windows `tauri-plugin-updater` writes each downloaded installer to
//! `%TEMP%\<productName>-<version>-updater-XXXXXX\` and keeps that folder
//! (`TempDir::keep()`); the app then exits for the installer, so nothing ever
//! deletes it — one ~10 MB folder per update piles up. Once we're running, any
//! such folder is from a finished (or abandoned) install and safe to remove.

use std::path::Path;

/// Spawn the sweep on a background thread (it touches the filesystem only).
pub fn spawn(app_name: String) {
    std::thread::spawn(move || {
        let removed = sweep(&std::env::temp_dir(), &app_name);
        if removed > 0 {
            log::info!("[updater] Removed {removed} leftover update installer folder(s)");
        }
    });
}

/// Delete every `<app_name>-<version>-updater-*` directory directly under `dir`.
/// Returns how many were removed.
fn sweep(dir: &Path, app_name: &str) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_updater_dir(name, app_name) {
            continue;
        }
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        match std::fs::remove_dir_all(entry.path()) {
            Ok(()) => removed += 1,
            Err(e) => log::warn!("[updater] Could not remove {}: {e}", entry.path().display()),
        }
    }
    removed
}

fn is_updater_dir(name: &str, app_name: &str) -> bool {
    let Some(rest) = name.strip_prefix(app_name).and_then(|r| r.strip_prefix('-')) else {
        return false;
    };
    // rest = "<version>-updater-<random>"
    match rest.split_once("-updater-") {
        Some((version, suffix)) => {
            !version.is_empty()
                && version.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '+')
                && !suffix.is_empty()
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_only_our_updater_dirs() {
        assert!(is_updater_dir("OpenWhisperer-1.90.0-updater-CaGv61", "OpenWhisperer"));
        assert!(!is_updater_dir("OpenWhisperer-1.90.0-updater-", "OpenWhisperer"));
        assert!(!is_updater_dir("OtherApp-1.0.0-updater-abc", "OpenWhisperer"));
        assert!(!is_updater_dir("OpenWhisperer-cache", "OpenWhisperer"));
        assert!(!is_updater_dir("OpenWhispererX-1.0.0-updater-abc", "OpenWhisperer"));
    }

    #[test]
    fn sweep_removes_matching_dirs_only() {
        let root = tempfile_dir();
        std::fs::create_dir_all(root.join("OpenWhisperer-1.0.0-updater-aaa")).unwrap();
        std::fs::write(root.join("OpenWhisperer-1.0.0-updater-aaa").join("x.msi"), b"x").unwrap();
        std::fs::create_dir_all(root.join("Unrelated-dir")).unwrap();
        std::fs::write(root.join("OpenWhisperer-2.0.0-updater-file"), b"not a dir").unwrap();
        assert_eq!(sweep(&root, "OpenWhisperer"), 1);
        assert!(!root.join("OpenWhisperer-1.0.0-updater-aaa").exists());
        assert!(root.join("Unrelated-dir").exists());
        assert!(root.join("OpenWhisperer-2.0.0-updater-file").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    fn tempfile_dir() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "ow-updater-cleanup-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}
