//! Meeting mode backend: capture mic ("me") + system audio ("them") as separate
//! 16 kHz mono streams, VAD-cut them into WAV segments on disk, transcribe each
//! segment through the Whisper layer, and journal everything to an append-only
//! transcript. Contract: `docs/meeting-mode-spec.md` (Workstream C).
//!
//! Layout:
//! - `capture/`  audio sources (cpal mic; WASAPI / ScreenCaptureKit / parec system)
//! - `session`   live capture session: per-stream processors + level thread
//! - `resample`, `vad`, `wav`  pure DSP helpers (unit-tested)
//! - `pipeline`  `MeetingHandle`: meta state, transcript appends, transcription
//! - `storage`   paths, meta/transcript/items IO, startup recovery, retention
//! - `types`     wire/disk types

pub mod capture;
pub mod pipeline;
pub mod resample;
pub mod session;
pub mod storage;
pub mod types;
pub mod vad;
pub mod wav;

#[cfg(test)]
mod e2e_tests;

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::AppHandle;

use crate::config::AppConfig;

use pipeline::MeetingHandle;
use session::CaptureSession;
use types::{
    LineStatus, MeetingDetail, MeetingMeta, MeetingPatch, MeetingSources, MeetingStartOpts,
    MeetingStatus,
};

struct Active {
    id: String,
    capture: CaptureSession,
}

#[derive(Default)]
struct Inner {
    active: Option<Active>,
    /// Loaded meetings (live one, or past ones being finalized / retried).
    handles: HashMap<String, Arc<MeetingHandle>>,
    /// Set while `start` is opening devices (guards against a double start
    /// without holding the lock across device init).
    starting: bool,
}

#[derive(Default)]
pub struct MeetingManager {
    inner: Mutex<Inner>,
}

fn not_active(id: &str) -> String {
    format!("Meeting {} is not the active meeting", id)
}

impl MeetingManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn handle_for(&self, app: &AppHandle, id: &str) -> Result<Arc<MeetingHandle>, String> {
        storage::validate_id(id)?;
        let mut inner = self.inner.lock();
        if let Some(h) = inner.handles.get(id) {
            return Ok(h.clone());
        }
        let meta = storage::read_meta(id)?;
        let lines = storage::dedup_lines(storage::read_lines(id)?);
        let handle = MeetingHandle::new(app.clone(), meta, &lines);
        inner.handles.insert(id.to_string(), handle.clone());
        Ok(handle)
    }

    fn active_handle(&self, id: &str) -> Result<Arc<MeetingHandle>, String> {
        let inner = self.inner.lock();
        match &inner.active {
            Some(a) if a.id == id => inner.handles.get(id).cloned().ok_or_else(|| not_active(id)),
            _ => Err(not_active(id)),
        }
    }

    /// Blocking (opens audio devices) — call from a blocking context.
    pub fn start(&self, app: &AppHandle, config: &AppConfig, opts: MeetingStartOpts) -> Result<MeetingMeta, String> {
        {
            let mut inner = self.inner.lock();
            if inner.active.is_some() || inner.starting {
                return Err("A meeting is already running".into());
            }
            inner.starting = true;
        }
        let result = self.start_inner(app, config, opts);
        self.inner.lock().starting = false;
        result
    }

    fn start_inner(&self, app: &AppHandle, config: &AppConfig, opts: MeetingStartOpts) -> Result<MeetingMeta, String> {
        let mcfg = &config.meeting;
        let id = storage::new_meeting_id();
        storage::create_meeting_dir(&id)?;
        let title = opts
            .title
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| format!("Meeting {}", chrono::Local::now().format("%Y-%m-%d %H:%M")));
        let meta = MeetingMeta {
            id: id.clone(),
            title,
            started_at: storage::now_ms(),
            ended_at: None,
            status: MeetingStatus::Recording,
            repo_id: opts.repo_id.filter(|r| !r.is_empty()),
            auto_repo: opts.auto_repo,
            context: opts.context.filter(|c| !c.trim().is_empty()),
            summary: None,
            sources: MeetingSources {
                mic: mcfg.capture_mic,
                system: mcfg.capture_system,
                system_target: if mcfg.system_target == "all" { "all" } else { "process" }.to_string(),
            },
            segment_count: 0,
            pending_segments: 0,
            failed_segments: 0,
            duration_secs: 0.0,
            vocabulary: opts.vocabulary.unwrap_or_default(),
        };
        storage::write_meta(&meta)?;
        let handle = MeetingHandle::new(app.clone(), meta, &[]);
        handle.timing_start();

        let capture = match CaptureSession::start(handle.clone(), mcfg) {
            Ok(c) => c,
            Err(e) => {
                let _ = storage::delete_meeting_dir(&id);
                return Err(e);
            }
        };
        let (mic, system) = (capture.mic_active, capture.system_active);
        {
            let mut inner = self.inner.lock();
            inner.handles.insert(id.clone(), handle.clone());
            inner.active = Some(Active {
                id: id.clone(),
                capture,
            });
        }
        // Sources reflect what actually started.
        let meta = handle.update_meta(|m| {
            m.sources.mic = mic;
            m.sources.system = system;
        });
        log::info!("[meeting] started {} (mic: {}, system: {})", id, mic, system);
        Ok(meta)
    }

    /// Blocking (joins capture threads).
    pub fn stop(&self, id: &str) -> Result<MeetingMeta, String> {
        let (active, handle) = {
            let mut inner = self.inner.lock();
            match &inner.active {
                Some(a) if a.id == id => {}
                _ => return Err(not_active(id)),
            }
            let active = inner.active.take().expect("checked above");
            let handle = inner.handles.get(id).cloned().ok_or_else(|| not_active(id))?;
            (active, handle)
        };
        // Flushes the open segments into the pipeline before returning.
        active.capture.stop();
        handle.timing_stop();
        let meta = handle.update_meta(|m| {
            m.status = MeetingStatus::Finalizing;
            m.ended_at = Some(storage::now_ms());
        });
        log::info!("[meeting] stopped {}; draining {} pending", id, meta.pending_segments);
        spawn_drain(handle);
        Ok(meta)
    }

    /// App exit: stop capture so open segments reach disk. The pipeline can't
    /// drain anymore; startup marks the meeting `interrupted` for finalize.
    pub fn shutdown(&self) {
        let (active, handle) = {
            let mut inner = self.inner.lock();
            let Some(active) = inner.active.take() else {
                return;
            };
            let handle = inner.handles.get(&active.id).cloned();
            (active, handle)
        };
        active.capture.stop();
        if let Some(h) = handle {
            h.timing_stop();
            h.update_meta(|m| {
                m.status = MeetingStatus::Interrupted;
                m.ended_at = Some(storage::now_ms());
            });
        }
    }

    pub fn pause(&self, id: &str) -> Result<MeetingMeta, String> {
        let handle = self.active_handle(id)?;
        {
            let inner = self.inner.lock();
            if let Some(a) = &inner.active {
                a.capture.set_paused(true);
            }
        }
        handle.timing_stop();
        Ok(handle.set_status(MeetingStatus::Paused))
    }

    pub fn resume(&self, id: &str) -> Result<MeetingMeta, String> {
        let handle = self.active_handle(id)?;
        {
            let inner = self.inner.lock();
            if let Some(a) = &inner.active {
                a.capture.set_paused(false);
            }
        }
        handle.timing_start();
        Ok(handle.set_status(MeetingStatus::Recording))
    }

    pub fn active(&self) -> Option<MeetingMeta> {
        let inner = self.inner.lock();
        let a = inner.active.as_ref()?;
        inner.handles.get(&a.id).map(|h| h.meta_snapshot())
    }

    fn is_active(&self, id: &str) -> bool {
        self.inner.lock().active.as_ref().is_some_and(|a| a.id == id)
    }

    fn loaded_meta(&self, id: &str) -> Option<MeetingMeta> {
        self.inner.lock().handles.get(id).map(|h| h.meta_snapshot())
    }

    pub fn list(&self) -> Vec<MeetingMeta> {
        storage::list_metas()
            .into_iter()
            .map(|m| self.loaded_meta(&m.id).unwrap_or(m))
            .collect()
    }

    pub fn get(&self, id: &str) -> Result<MeetingDetail, String> {
        storage::validate_id(id)?;
        let meta = match self.loaded_meta(id) {
            Some(m) => m,
            None => storage::read_meta(id)?,
        };
        let transcript = storage::dedup_lines(storage::read_lines(id)?);
        Ok(MeetingDetail { meta, transcript })
    }

    pub fn update(&self, app: &AppHandle, id: &str, patch: MeetingPatch) -> Result<MeetingMeta, String> {
        let handle = self.handle_for(app, id)?;
        Ok(handle.update_meta(|m| {
            if let Some(t) = patch.title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
                m.title = t;
            }
            if let Some(s) = patch.summary {
                m.summary = s;
            }
            if let Some(r) = patch.repo_id {
                m.repo_id = r.filter(|r| !r.is_empty());
            }
            if let Some(c) = patch.context {
                m.context = c;
            }
        }))
    }

    pub fn retry_segment(&self, app: &AppHandle, id: &str, seg_id: &str) -> Result<(), String> {
        storage::validate_id(seg_id)?;
        let handle = self.handle_for(app, id)?;
        let line = storage::dedup_lines(storage::read_lines(id)?)
            .into_iter()
            .find(|l| l.seg_id == seg_id)
            .ok_or_else(|| format!("Segment {} not found", seg_id))?;
        handle.requeue(line);
        Ok(())
    }

    /// Transcribe every pending/failed segment of a stopped or interrupted
    /// meeting, then mark it `done`.
    pub fn finalize(&self, app: &AppHandle, id: &str) -> Result<MeetingMeta, String> {
        if self.is_active(id) {
            return Err("The meeting is still recording — stop it first".into());
        }
        let handle = self.handle_for(app, id)?;
        let current = handle.meta_snapshot();
        if current.status == MeetingStatus::Finalizing && !handle.is_idle() {
            return Ok(current); // already draining
        }
        let lines = storage::dedup_lines(storage::read_lines(id)?);
        let max_t1 = lines.iter().map(|l| l.t1).fold(0.0f64, f64::max);
        let meta = handle.update_meta(|m| {
            storage::apply_counts(m, &lines);
            m.status = MeetingStatus::Finalizing;
            if m.ended_at.is_none() {
                let secs = max_t1.max(m.duration_secs);
                m.ended_at = Some(m.started_at + (secs * 1000.0) as u64);
            }
        });
        for line in lines.into_iter().filter(|l| l.status != LineStatus::Ok) {
            handle.requeue(line);
        }
        spawn_drain(handle);
        Ok(meta)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        storage::validate_id(id)?;
        let mut inner = self.inner.lock();
        if inner.active.as_ref().is_some_and(|a| a.id == id) {
            return Err("Can't delete the active meeting — stop it first".into());
        }
        if let Some(h) = inner.handles.get(id) {
            if !h.is_idle() {
                return Err("The meeting is still transcribing — try again when it's done".into());
            }
        }
        inner.handles.remove(id);
        drop(inner);
        storage::delete_meeting_dir(id)
    }
}

/// Wait for the pipeline to drain, then mark the meeting `done`.
fn spawn_drain(handle: Arc<MeetingHandle>) {
    tauri::async_runtime::spawn(async move {
        handle.wait_idle().await;
        let meta = handle.set_status(MeetingStatus::Done);
        log::info!(
            "[meeting] {} done ({} segments, {} failed)",
            meta.id,
            meta.segment_count,
            meta.failed_segments
        );
    });
}

impl MeetingManager {
    /// Startup recovery for one meeting, holding the manager lock so a meeting
    /// this process has active/loaded is never marked (lock order: manager →
    /// meeting dir, same as every other path; the dir lock is a leaf).
    fn recover_one(&self, root: &std::path::Path, id: &str, not_before: u64) -> storage::RecoverOutcome {
        let inner = self.inner.lock();
        if inner.handles.contains_key(id) || inner.active.as_ref().is_some_and(|a| a.id == id) {
            return storage::RecoverOutcome::Newer;
        }
        match storage::mark_interrupted_one_in(root, id, not_before, storage::now_ms()) {
            Ok(o) => o,
            Err(e) => {
                log::error!("[meeting] failed to recover {}: {}", id, e);
                storage::RecoverOutcome::NotLive
            }
        }
    }

    fn recover_pass(&self, root: &std::path::Path, ids: Vec<String>, not_before: u64) -> Vec<String> {
        let mut marked = Vec::new();
        let mut fresh = Vec::new();
        for id in ids {
            match self.recover_one(root, &id, not_before) {
                storage::RecoverOutcome::Marked => marked.push(id),
                storage::RecoverOutcome::Fresh => fresh.push(id),
                storage::RecoverOutcome::NotLive | storage::RecoverOutcome::Newer => {}
            }
        }
        if !marked.is_empty() {
            log::warn!("[meeting] marked interrupted: {:?}", marked);
        }
        fresh
    }
}

/// Startup hook (runs on a detached thread): mark meetings left live by a dead
/// process as `interrupted`, then apply audio retention.
///
/// Races handled: meetings this process has loaded/active are skipped under
/// the manager lock; meetings started after this process came up are its own;
/// a live meeting whose meta was rewritten in the last couple of minutes may
/// belong to another running instance, so it is re-checked once after
/// `RECOVERY_FRESH_MS` and only marked if its meta has gone stale by then.
pub fn on_startup(manager: Arc<MeetingManager>, retention_days: u32) {
    let not_before = storage::now_ms();
    let root = storage::meetings_dir();
    if !root.exists() {
        return;
    }
    let fresh = manager.recover_pass(&root, storage::live_meeting_ids_in(&root), not_before);
    let cleaned = storage::retention_cleanup_in(&root, retention_days, storage::now_ms());
    if !cleaned.is_empty() {
        log::info!(
            "[meeting] retention ({} days): deleted audio of {:?}",
            retention_days,
            cleaned
        );
    }
    if !fresh.is_empty() {
        log::info!("[meeting] recently-touched live meetings {:?}; re-checking later", fresh);
        std::thread::sleep(std::time::Duration::from_millis(storage::RECOVERY_FRESH_MS + 5_000));
        let still_fresh = manager.recover_pass(&root, fresh, not_before);
        if !still_fresh.is_empty() {
            log::info!("[meeting] {:?} still being updated — owned by another process", still_fresh);
        }
    }
}
