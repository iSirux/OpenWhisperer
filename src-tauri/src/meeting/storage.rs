//! On-disk layout for meetings:
//!
//! ```text
//! <config dir>/meetings[-dev]/<id>/meeting.json     MeetingMeta (atomic rewrite)
//!                                 /transcript.jsonl  TranscriptLine per line, append-only;
//!                                                    later lines for a seg_id supersede earlier
//!                                 /items.json        opaque frontend JSON
//!                                 /audio/<seg_id>.wav
//! ```

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;

use crate::config::AppConfig;
use crate::persist::atomic_write;

use super::types::{LineStatus, MeetingMeta, MeetingStatus, TranscriptLine};

pub fn meetings_dir() -> PathBuf {
    #[cfg(debug_assertions)]
    let name = "meetings-dev";
    #[cfg(not(debug_assertions))]
    let name = "meetings";
    AppConfig::config_dir().join(name)
}

/// Ids and seg ids are path components: `[A-Za-z0-9_-]{1,64}` only.
pub fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 {
        return Err(format!("invalid id: {:?}", id));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("invalid id: {:?}", id));
    }
    Ok(())
}

pub fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

pub fn meeting_dir_in(root: &Path, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(root.join(id))
}

pub fn meeting_dir(id: &str) -> Result<PathBuf, String> {
    meeting_dir_in(&meetings_dir(), id)
}

pub fn audio_path(id: &str, seg_id: &str) -> Result<PathBuf, String> {
    validate_id(seg_id)?;
    Ok(meeting_dir(id)?.join("audio").join(format!("{}.wav", seg_id)))
}

/// A fresh `mtg-<epoch ms>` id whose directory doesn't exist yet.
pub fn new_meeting_id() -> String {
    let root = meetings_dir();
    let mut ms = now_ms();
    loop {
        let id = format!("mtg-{}", ms);
        if !root.join(&id).exists() {
            return id;
        }
        ms += 1;
    }
}

pub fn create_meeting_dir(id: &str) -> Result<PathBuf, String> {
    let dir = meeting_dir(id)?;
    fs::create_dir_all(dir.join("audio"))
        .map_err(|e| format!("Failed to create meeting dir {:?}: {}", dir, e))?;
    Ok(dir)
}

/// One lock per meeting directory, serialising every rewrite of its
/// `meeting.json` / `items.json` and its deletion. `MeetingHandle` already
/// serialises its own meta writes, but items saves (frontend), startup
/// recovery and a second handle-less writer don't go through it.
fn dir_lock(dir: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS
        .get_or_init(Default::default)
        .lock()
        .entry(dir.to_path_buf())
        .or_default()
        .clone()
}

/// Run `f` holding the meeting's write lock.
pub fn with_meeting_lock_in<T>(root: &Path, id: &str, f: impl FnOnce(&Path) -> T) -> Result<T, String> {
    let dir = meeting_dir_in(root, id)?;
    let lock = dir_lock(&dir);
    let _g = lock.lock();
    Ok(f(&dir))
}

pub fn write_meta_in(root: &Path, meta: &MeetingMeta) -> Result<(), String> {
    with_meeting_lock_in(root, &meta.id, |dir| write_meta_locked(dir, meta))?
}

fn write_meta_locked(dir: &Path, meta: &MeetingMeta) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create meeting dir: {}", e))?;
    let text = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    atomic_write(&dir.join("meeting.json"), &text)
        .map_err(|e| format!("Failed to write meeting meta: {}", e))
}

pub fn write_meta(meta: &MeetingMeta) -> Result<(), String> {
    write_meta_in(&meetings_dir(), meta)
}

pub fn read_meta_in(root: &Path, id: &str) -> Result<MeetingMeta, String> {
    let path = meeting_dir_in(root, id)?.join("meeting.json");
    let text = fs::read_to_string(&path).map_err(|e| format!("Meeting {} not found: {}", id, e))?;
    serde_json::from_str(&text).map_err(|e| format!("Corrupt meeting meta {:?}: {}", path, e))
}

pub fn read_meta(id: &str) -> Result<MeetingMeta, String> {
    read_meta_in(&meetings_dir(), id)
}

/// All readable metas under `root`, newest first.
pub fn list_metas_in(root: &Path) -> Vec<MeetingMeta> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut metas: Vec<MeetingMeta> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let id = e.file_name().to_string_lossy().to_string();
            validate_id(&id).ok()?;
            match read_meta_in(root, &id) {
                Ok(m) => Some(m),
                Err(err) => {
                    log::warn!("[meeting] skipping {}: {}", id, err);
                    None
                }
            }
        })
        .collect();
    metas.sort_by_key(|m| std::cmp::Reverse(m.started_at));
    metas
}

pub fn list_metas() -> Vec<MeetingMeta> {
    list_metas_in(&meetings_dir())
}

/// Append one line to `transcript.jsonl` and sync it (crash-safe append).
pub fn append_line_in(root: &Path, id: &str, line: &TranscriptLine) -> Result<(), String> {
    let path = meeting_dir_in(root, id)?.join("transcript.jsonl");
    let mut text = serde_json::to_string(line).map_err(|e| e.to_string())?;
    text.push('\n');
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open transcript: {}", e))?;
    f.write_all(text.as_bytes())
        .map_err(|e| format!("Failed to append transcript: {}", e))?;
    let _ = f.sync_data();
    Ok(())
}

pub fn append_line(id: &str, line: &TranscriptLine) -> Result<(), String> {
    append_line_in(&meetings_dir(), id, line)
}

/// Raw transcript lines in file order. Unparseable lines (e.g. a torn final
/// line after a crash) are skipped.
pub fn read_lines_in(root: &Path, id: &str) -> Result<Vec<TranscriptLine>, String> {
    let path = meeting_dir_in(root, id)?.join("transcript.jsonl");
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Failed to read transcript: {}", e)),
    };
    Ok(text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<TranscriptLine>(l).ok())
        .collect())
}

pub fn read_lines(id: &str) -> Result<Vec<TranscriptLine>, String> {
    read_lines_in(&meetings_dir(), id)
}

/// Keep the last line per seg_id, sorted by t0 (then seg_id for stability).
pub fn dedup_lines(lines: Vec<TranscriptLine>) -> Vec<TranscriptLine> {
    let mut latest: HashMap<String, TranscriptLine> = HashMap::new();
    for line in lines {
        latest.insert(line.seg_id.clone(), line);
    }
    let mut out: Vec<TranscriptLine> = latest.into_values().collect();
    out.sort_by(|a, b| {
        a.t0.partial_cmp(&b.t0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.seg_id.cmp(&b.seg_id))
    });
    out
}

/// Recompute segment/pending/failed counts from a deduped transcript.
pub fn apply_counts(meta: &mut MeetingMeta, deduped: &[TranscriptLine]) {
    meta.segment_count = deduped.len() as u32;
    meta.pending_segments = deduped
        .iter()
        .filter(|l| l.status == LineStatus::Pending)
        .count() as u32;
    meta.failed_segments = deduped
        .iter()
        .filter(|l| l.status == LineStatus::Error)
        .count() as u32;
}

/// Highest numeric counter among `seg-<n>-…` ids (so new ids never collide).
pub fn max_seg_counter(lines: &[TranscriptLine]) -> Option<u32> {
    lines
        .iter()
        .filter_map(|l| l.seg_id.strip_prefix("seg-")?.split('-').next()?.parse().ok())
        .max()
}

pub fn seg_id(counter: u32, speaker: &str) -> String {
    format!("seg-{:04}-{}", counter, speaker)
}

pub fn write_segment_wav(id: &str, seg_id: &str, wav: &[u8]) -> Result<PathBuf, String> {
    let path = audio_path(id, seg_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create audio dir: {}", e))?;
    }
    let tmp = path.with_extension("wav.tmp");
    fs::write(&tmp, wav).map_err(|e| format!("Failed to write segment audio: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("Failed to finalize segment audio: {}", e))?;
    Ok(path)
}

pub fn read_segment_wav(id: &str, seg_id: &str) -> Result<Vec<u8>, String> {
    let path = audio_path(id, seg_id)?;
    fs::read(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("Audio for {} is not on disk (deleted by retention or never written)", seg_id)
        } else {
            format!("Failed to read segment audio: {}", e)
        }
    })
}

pub fn read_items(id: &str) -> Result<serde_json::Value, String> {
    let path = meeting_dir(id)?.join("items.json");
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| {
            log::error!("[meeting] corrupt items.json for {}: {}", id, e);
            format!("Corrupt items.json: {}", e)
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Value::Array(vec![])),
        Err(e) => Err(format!("Failed to read items: {}", e)),
    }
}

pub fn write_items(id: &str, items: &serde_json::Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
    with_meeting_lock_in(&meetings_dir(), id, |dir| {
        // Checked under the lock so a save can't resurrect a deleted meeting.
        if !dir.join("meeting.json").exists() {
            return Err(format!("Meeting {} not found", id));
        }
        atomic_write(&dir.join("items.json"), &text).map_err(|e| format!("Failed to write items: {}", e))
    })?
}

pub fn delete_meeting_dir(id: &str) -> Result<(), String> {
    with_meeting_lock_in(&meetings_dir(), id, |dir| {
        if !dir.exists() {
            return Ok(());
        }
        fs::remove_dir_all(dir).map_err(|e| format!("Failed to delete meeting: {}", e))
    })?
}

/// A live meeting whose `meeting.json` was rewritten this recently may belong
/// to another running process (a live meeting checkpoints every 30 s), so
/// startup recovery leaves it alone for now.
pub const RECOVERY_FRESH_MS: u64 = 120_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoverOutcome {
    /// Was live, now `interrupted`.
    Marked,
    /// Not live (anymore) — nothing to do.
    NotLive,
    /// Started at/after `not_before`: this process (or a newer one) owns it.
    Newer,
    /// Meta written within `RECOVERY_FRESH_MS`: possibly another live process;
    /// re-check later.
    Fresh,
}

fn file_mtime_ms(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let d = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(d.as_millis() as u64)
}

/// Startup recovery for one meeting: a meeting still marked live belonged to a
/// process that died — mark it `interrupted` (with recomputed counts). Runs
/// under the meeting's write lock and re-reads the meta there, so it can't
/// clobber a concurrent writer's fresh state. Skips meetings started at or
/// after `not_before` (this process's own) and ones whose meta was touched in
/// the last `RECOVERY_FRESH_MS` before `now`.
pub fn mark_interrupted_one_in(root: &Path, id: &str, not_before: u64, now: u64) -> Result<RecoverOutcome, String> {
    with_meeting_lock_in(root, id, |dir| {
        let mut meta = read_meta_in(root, id)?;
        if !meta.status.is_live() {
            return Ok(RecoverOutcome::NotLive);
        }
        if meta.started_at >= not_before {
            return Ok(RecoverOutcome::Newer);
        }
        if let Some(mtime) = file_mtime_ms(&dir.join("meeting.json")) {
            if now.saturating_sub(mtime) < RECOVERY_FRESH_MS {
                return Ok(RecoverOutcome::Fresh);
            }
        }
        meta.status = MeetingStatus::Interrupted;
        if let Ok(lines) = read_lines_in(root, id) {
            let deduped = dedup_lines(lines);
            apply_counts(&mut meta, &deduped);
        }
        write_meta_locked(dir, &meta)?;
        Ok(RecoverOutcome::Marked)
    })?
}

/// Ids of meetings under `root` whose meta currently reads as live.
pub fn live_meeting_ids_in(root: &Path) -> Vec<String> {
    list_metas_in(root)
        .into_iter()
        .filter(|m| m.status.is_live())
        .map(|m| m.id)
        .collect()
}

/// Startup: delete the audio of `done` meetings that ended more than
/// `retention_days` ago (0 = keep forever). Returns the ids cleaned.
pub fn retention_cleanup_in(root: &Path, retention_days: u32, now: u64) -> Vec<String> {
    if retention_days == 0 {
        return Vec::new();
    }
    let cutoff = now.saturating_sub(retention_days as u64 * 24 * 3600 * 1000);
    let mut cleaned = Vec::new();
    for meta in list_metas_in(root) {
        if meta.status != MeetingStatus::Done {
            continue;
        }
        let ended = meta.ended_at.unwrap_or(meta.started_at);
        if ended >= cutoff {
            continue;
        }
        let audio = root.join(&meta.id).join("audio");
        if audio.exists() {
            match fs::remove_dir_all(&audio) {
                Ok(()) => cleaned.push(meta.id.clone()),
                Err(e) => log::warn!("[meeting] retention: failed to delete {:?}: {}", audio, e),
            }
        }
    }
    cleaned
}

#[cfg(test)]
mod tests {
    use super::super::types::MeetingSources;
    use super::*;

    fn line(seg: &str, t0: f64, status: LineStatus, text: &str) -> TranscriptLine {
        TranscriptLine {
            seg_id: seg.into(),
            t0,
            t1: t0 + 1.0,
            speaker: "me".into(),
            text: text.into(),
            status,
            error: None,
        }
    }

    fn meta(id: &str, status: MeetingStatus, started: u64, ended: Option<u64>) -> MeetingMeta {
        MeetingMeta {
            id: id.into(),
            title: "t".into(),
            started_at: started,
            ended_at: ended,
            status,
            repo_id: None,
            auto_repo: false,
            context: None,
            summary: None,
            sources: MeetingSources {
                mic: true,
                system: true,
                system_target: "all".into(),
            },
            segment_count: 0,
            pending_segments: 0,
            failed_segments: 0,
            duration_secs: 0.0,
            vocabulary: vec![],
        }
    }

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ow-meeting-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn id_validation() {
        assert!(validate_id("mtg-1727450000000").is_ok());
        assert!(validate_id("seg-0001-them").is_ok());
        assert!(validate_id("").is_err());
        assert!(validate_id("../etc").is_err());
        assert!(validate_id("a/b").is_err());
        assert!(validate_id("a b").is_err());
        assert!(validate_id(&"x".repeat(65)).is_err());
    }

    #[test]
    fn dedup_keeps_latest_and_sorts() {
        let lines = vec![
            line("seg-0002-them", 5.0, LineStatus::Pending, ""),
            line("seg-0001-me", 1.0, LineStatus::Pending, ""),
            line("seg-0001-me", 1.0, LineStatus::Ok, "hello"),
            line("seg-0002-them", 5.0, LineStatus::Error, ""),
            line("seg-0003-me", 3.0, LineStatus::Pending, ""),
        ];
        let d = dedup_lines(lines);
        assert_eq!(d.len(), 3);
        assert_eq!(d[0].seg_id, "seg-0001-me");
        assert_eq!(d[0].text, "hello");
        assert_eq!(d[1].seg_id, "seg-0003-me");
        assert_eq!(d[2].status, LineStatus::Error);

        let mut m = meta("mtg-1", MeetingStatus::Done, 0, None);
        apply_counts(&mut m, &d);
        assert_eq!((m.segment_count, m.pending_segments, m.failed_segments), (3, 1, 1));
        assert_eq!(max_seg_counter(&d), Some(3));
    }

    #[test]
    fn transcript_roundtrip_skips_torn_line() {
        let root = temp_root("jsonl");
        write_meta_in(&root, &meta("mtg-5", MeetingStatus::Recording, 0, None)).unwrap();
        append_line_in(&root, "mtg-5", &line("seg-0001-me", 0.0, LineStatus::Ok, "a")).unwrap();
        let path = root.join("mtg-5").join("transcript.jsonl");
        let mut f = OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"{\"seg_id\":\"seg-00").unwrap();
        drop(f);
        let lines = read_lines_in(&root, "mtg-5").unwrap();
        assert_eq!(lines.len(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn startup_marks_interrupted_and_retention() {
        let root = temp_root("startup");
        let day = 24 * 3600 * 1000u64;
        let now = 100 * day;
        write_meta_in(&root, &meta("mtg-1", MeetingStatus::Recording, now - day, None)).unwrap();
        write_meta_in(&root, &meta("mtg-2", MeetingStatus::Done, now - 40 * day, Some(now - 40 * day))).unwrap();
        write_meta_in(&root, &meta("mtg-3", MeetingStatus::Done, now - 2 * day, Some(now - 2 * day))).unwrap();
        for id in ["mtg-2", "mtg-3"] {
            fs::create_dir_all(root.join(id).join("audio")).unwrap();
            fs::write(root.join(id).join("audio").join("seg-0001-me.wav"), b"x").unwrap();
        }
        append_line_in(&root, "mtg-1", &line("seg-0001-me", 0.0, LineStatus::Pending, "")).unwrap();

        let live = live_meeting_ids_in(&root);
        assert_eq!(live, vec!["mtg-1".to_string()]);
        let real_now = now_ms();
        // Just written → possibly another live process: left alone.
        assert_eq!(
            mark_interrupted_one_in(&root, "mtg-1", real_now, real_now).unwrap(),
            RecoverOutcome::Fresh
        );
        // Started by this process (started_at >= not_before): never touched.
        assert_eq!(
            mark_interrupted_one_in(&root, "mtg-1", 0, real_now + RECOVERY_FRESH_MS).unwrap(),
            RecoverOutcome::Newer
        );
        assert_eq!(read_meta_in(&root, "mtg-1").unwrap().status, MeetingStatus::Recording);
        // Stale and older than this process → marked.
        assert_eq!(
            mark_interrupted_one_in(&root, "mtg-1", real_now, real_now + RECOVERY_FRESH_MS).unwrap(),
            RecoverOutcome::Marked
        );
        assert_eq!(
            mark_interrupted_one_in(&root, "mtg-1", real_now, real_now + RECOVERY_FRESH_MS).unwrap(),
            RecoverOutcome::NotLive
        );
        let m1 = read_meta_in(&root, "mtg-1").unwrap();
        assert_eq!(m1.status, MeetingStatus::Interrupted);
        assert_eq!(m1.pending_segments, 1);

        let cleaned = retention_cleanup_in(&root, 30, now);
        assert_eq!(cleaned, vec!["mtg-2".to_string()]);
        assert!(!root.join("mtg-2").join("audio").exists());
        assert!(root.join("mtg-3").join("audio").exists());
        assert!(retention_cleanup_in(&root, 0, now).is_empty());

        // newest first
        let ids: Vec<String> = list_metas_in(&root).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["mtg-1", "mtg-3", "mtg-2"]);
        let _ = fs::remove_dir_all(&root);
    }
}
