//! Resumable HTTP downloads with progress, cancel, and size/SHA-256 checks.
//!
//! A download streams into `<dest>.part`; an interrupted or cancelled download
//! resumes from the part file with an HTTP `Range` request next time. The part
//! file is only renamed to `dest` after the size (and hash, when known) match.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

pub const CANCELLED: &str = "Cancelled";

/// Progress callback: (downloaded bytes, total bytes if known).
pub type ProgressFn<'a> = &'a (dyn Fn(u64, Option<u64>) + Send + Sync);

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("OpenWhisperer/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    dest.with_file_name(name)
}

/// Download `url` to `dest`. Returns immediately when `dest` already exists
/// with the expected size. `expected_sha256` is lowercase hex.
pub async fn download(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    expected_size: Option<u64>,
    expected_sha256: Option<&str>,
    cancel: &AtomicBool,
    on_progress: ProgressFn<'_>,
    on_verify: &(dyn Fn() + Send + Sync),
) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }
    if let (Ok(meta), Some(size)) = (std::fs::metadata(dest), expected_size) {
        if meta.len() == size {
            on_progress(size, Some(size));
            return Ok(());
        }
    }

    let part = part_path(dest);
    let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if let Some(size) = expected_size {
        if have > size {
            let _ = std::fs::remove_file(&part);
            have = 0;
        }
    }

    // A fully-downloaded part file (e.g. the app died while verifying) needs no request.
    let complete = expected_size.is_some_and(|s| have == s);
    if !complete {
        let mut resp = None;
        // Second pass only after a 416 (stale part file) → restart from zero.
        for _ in 0..2 {
            let mut req = client.get(url);
            if have > 0 {
                req = req.header(reqwest::header::RANGE, format!("bytes={}-", have));
            }
            let r = req
                .send()
                .await
                .map_err(|e| format!("Download failed ({}): {}", url, e))?;
            if r.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && have > 0 {
                let _ = std::fs::remove_file(&part);
                have = 0;
                continue;
            }
            resp = Some(r);
            break;
        }
        let mut resp = resp.ok_or_else(|| format!("Download failed ({}): HTTP 416", url))?;
        let status = resp.status();
        let append = if status == reqwest::StatusCode::PARTIAL_CONTENT {
            true
        } else if status.is_success() {
            // Server ignored the Range header: start over.
            have = 0;
            false
        } else {
            return Err(format!("Download failed ({}): HTTP {}", url, status));
        };

        let total = expected_size.or_else(|| resp.content_length().map(|l| l + have));
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(&part)
            .await
            .map_err(|e| format!("Failed to open {}: {}", part.display(), e))?;
        let mut writer = tokio::io::BufWriter::with_capacity(1 << 20, &mut file);
        let mut downloaded = have;
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        on_progress(downloaded, total);
        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = writer.flush().await;
                return Err(CANCELLED.to_string());
            }
            let chunk = match tokio::time::timeout(Duration::from_secs(60), resp.chunk()).await {
                Ok(Ok(Some(c))) => c,
                Ok(Ok(None)) => break,
                Ok(Err(e)) => {
                    let _ = writer.flush().await;
                    return Err(format!("Download interrupted: {} (it will resume on retry)", e));
                }
                Err(_) => {
                    let _ = writer.flush().await;
                    return Err("Download stalled for 60 s (it will resume on retry)".to_string());
                }
            };
            writer
                .write_all(&chunk)
                .await
                .map_err(|e| format!("Failed to write {}: {}", part.display(), e))?;
            downloaded += chunk.len() as u64;
            if last_emit.elapsed() >= Duration::from_millis(250) {
                on_progress(downloaded, total);
                last_emit = Instant::now();
            }
        }
        writer
            .flush()
            .await
            .map_err(|e| format!("Failed to write {}: {}", part.display(), e))?;
        drop(writer);
        file.sync_all().await.ok();
        on_progress(downloaded, total);
    }

    let actual = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if let Some(size) = expected_size {
        if actual != size {
            if actual > size {
                let _ = std::fs::remove_file(&part);
            }
            return Err(format!(
                "Download incomplete: got {} of {} bytes (retry to resume)",
                actual, size
            ));
        }
    }
    if let Some(expected) = expected_sha256 {
        on_verify();
        let got = sha256_file(part.clone(), cancel).await?;
        if !got.eq_ignore_ascii_case(expected) {
            let _ = std::fs::remove_file(&part);
            return Err(format!(
                "Checksum mismatch for {} (expected {}, got {}); the file was deleted, retry to download again",
                dest.display(),
                expected,
                got
            ));
        }
    }
    let _ = std::fs::remove_file(dest);
    std::fs::rename(&part, dest)
        .map_err(|e| format!("Failed to move {} into place: {}", dest.display(), e))?;
    Ok(())
}

/// SHA-256 of a file (lowercase hex), computed off the async runtime.
pub async fn sha256_file(path: PathBuf, cancel: &AtomicBool) -> Result<String, String> {
    // The cancel flag can't cross into spawn_blocking by reference; poll it
    // through a shared copy instead.
    let flag = std::sync::Arc::new(AtomicBool::new(cancel.load(Ordering::SeqCst)));
    let worker_flag = flag.clone();
    let handle = tokio::task::spawn_blocking(move || -> Result<String, String> {
        use std::io::Read;
        let mut f = std::fs::File::open(&path)
            .map_err(|e| format!("Failed to open {}: {}", path.display(), e))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 4 << 20];
        loop {
            if worker_flag.load(Ordering::SeqCst) {
                return Err(CANCELLED.to_string());
            }
            let n = f
                .read(&mut buf)
                .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(format!("{:x}", hasher.finalize()))
    });
    tokio::pin!(handle);
    loop {
        tokio::select! {
            res = &mut handle => {
                return res.map_err(|e| format!("Hash task failed: {}", e))?;
            }
            _ = tokio::time::sleep(Duration::from_millis(200)) => {
                if cancel.load(Ordering::SeqCst) {
                    flag.store(true, Ordering::SeqCst);
                }
            }
        }
    }
}
