//! Per-meeting state + transcription pipeline.
//!
//! A `MeetingHandle` owns the in-memory `MeetingMeta` (persisted on every
//! change), appends transcript lines, and runs segment transcription on the
//! async runtime with bounded concurrency (2) and retries. It is used both for
//! the live meeting (segments arrive from the capture processors) and for
//! finalize / retry of past meetings.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use crate::config::{AppConfig, WhisperConfig, WhisperProvider};

use super::storage;
use super::types::{
    ErrorEvent, LineStatus, MeetingMeta, MeetingStatus, TranscriptEvent, TranscriptLine,
};
use super::vad::{Segment, SAMPLE_RATE};
use super::wav::encode_wav_i16;

pub const EVENT_STATUS: &str = "meeting-status";
pub const EVENT_TRANSCRIPT: &str = "meeting-transcript";
pub const EVENT_LEVEL: &str = "meeting-level";
pub const EVENT_ERROR: &str = "meeting-error";

/// Concurrent transcription requests per meeting.
const CONCURRENCY: usize = 2;
/// Backoff before retry 1 and 2 (the whisper layer already retries 429/5xx
/// itself for API providers; these cover longer outages).
const RETRY_BACKOFF: [Duration; 2] = [Duration::from_secs(5), Duration::from_secs(20)];
/// Characters of the same speaker's previous line passed as prompt context.
const PROMPT_TAIL_CHARS: usize = 300;

struct Timing {
    active_since: Option<Instant>,
    accumulated: f64,
}

/// Seg ids currently queued or transcribing, plus the in-flight count that
/// `wait_idle` polls. Both are only changed through `claim` / `WorkGuard`, so
/// a segment can't be queued twice and a panicking task can't leave the
/// count stuck (which would make `wait_idle` spin forever).
#[derive(Default)]
pub(crate) struct WorkSet {
    queued: Mutex<HashSet<String>>,
    inflight: AtomicUsize,
}

impl WorkSet {
    /// Claim `seg_id` for transcription. `None` when it's already queued or
    /// running. The claim (queued entry + in-flight count) is released when
    /// the returned guard drops.
    pub(crate) fn claim(self: &Arc<Self>, seg_id: &str) -> Option<WorkGuard> {
        let mut q = self.queued.lock();
        if !q.insert(seg_id.to_string()) {
            return None;
        }
        self.inflight.fetch_add(1, Ordering::SeqCst);
        Some(WorkGuard {
            set: self.clone(),
            seg_id: seg_id.to_string(),
        })
    }

    pub(crate) fn inflight(&self) -> usize {
        self.inflight.load(Ordering::SeqCst)
    }
}

pub(crate) struct WorkGuard {
    set: Arc<WorkSet>,
    seg_id: String,
}

impl Drop for WorkGuard {
    fn drop(&mut self) {
        let mut q = self.set.queued.lock();
        q.remove(&self.seg_id);
        self.set.inflight.fetch_sub(1, Ordering::SeqCst);
    }
}

pub struct MeetingHandle {
    pub id: String,
    app: AppHandle,
    meta: Mutex<MeetingMeta>,
    timing: Mutex<Timing>,
    seg_counter: AtomicU32,
    /// Last transcribed text per base speaker ("me" / "them") for prompt context.
    last_text: Mutex<HashMap<String, String>>,
    /// Seg ids currently queued or transcribing + in-flight count.
    work: Arc<WorkSet>,
    semaphore: Arc<tokio::sync::Semaphore>,
    /// Serialises transcript appends (lines must never interleave).
    transcript_lock: Mutex<()>,
}

fn tail_chars(s: &str, n: usize) -> &str {
    let count = s.chars().count();
    if count <= n {
        return s;
    }
    let skip = count - n;
    let idx = s.char_indices().nth(skip).map(|(i, _)| i).unwrap_or(0);
    &s[idx..]
}

/// Build the transcription prompt: vocabulary + tail of the same speaker's
/// previous line.
pub fn build_prompt(vocabulary: &[String], previous: Option<&str>) -> Option<String> {
    let mut parts = Vec::new();
    let vocab: Vec<&str> = vocabulary
        .iter()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .collect();
    if !vocab.is_empty() {
        parts.push(format!("Vocabulary: {}.", vocab.join(", ")));
    }
    if let Some(prev) = previous.map(str::trim).filter(|p| !p.is_empty()) {
        parts.push(tail_chars(prev, PROMPT_TAIL_CHARS).to_string());
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

/// `them` segments with provider speaker labels become `them:<label>` (the
/// label covering most of the segment's duration).
pub fn resolve_speaker(base: &str, segments: &[crate::whisper::TranscribeSegment]) -> String {
    if base != "them" {
        return base.to_string();
    }
    let mut totals: HashMap<&str, f64> = HashMap::new();
    for s in segments {
        if let Some(label) = s.speaker.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
            *totals.entry(label).or_default() += (s.end - s.start).max(0.0);
        }
    }
    totals
        .into_iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal).then(b.0.cmp(a.0)))
        .map(|(label, _)| format!("them:{}", label))
        .unwrap_or_else(|| base.to_string())
}

fn base_speaker(speaker: &str) -> &str {
    speaker.split(':').next().unwrap_or(speaker)
}

/// Effective Whisper config for meeting transcription: dictation settings with
/// the meeting provider/model override, API key resolved.
fn meeting_whisper_config(app: &AppHandle) -> WhisperConfig {
    let cfg = app.state::<Mutex<AppConfig>>().lock().clone();
    let mut w = crate::whisper::config_with_override(
        &cfg.whisper,
        cfg.meeting.transcription_provider.clone(),
        cfg.meeting.transcription_model.clone(),
        cfg.meeting.transcription_api_key.clone(),
        cfg.meeting.transcription_endpoint.clone(),
    );
    crate::commands::audio_cmds::resolve_whisper_api_key(app, &cfg, &mut w);
    w
}

fn missing_key_error(w: &WhisperConfig) -> Option<String> {
    let has_key = w.api_key.as_deref().is_some_and(|k| !k.trim().is_empty());
    let needs_key = matches!(
        w.provider,
        WhisperProvider::OpenAI | WhisperProvider::Groq | WhisperProvider::OpenRouter
    );
    if needs_key && !has_key {
        Some(format!(
            "No API key for {:?} meeting transcription. The meeting provider override differs from the \
             dictation provider, so the dictation key can't be reused — set the {:?} key in Settings → \
             Meeting (or add an OpenRouter LLM profile key for OpenRouter).",
            w.provider, w.provider
        ))
    } else {
        None
    }
}

impl MeetingHandle {
    /// `lines` = the meeting's existing (raw or deduped) transcript, used to seed
    /// the segment counter and prompt context.
    pub fn new(app: AppHandle, meta: MeetingMeta, lines: &[TranscriptLine]) -> Arc<Self> {
        let counter = storage::max_seg_counter(lines).unwrap_or(0).max(meta.segment_count);
        let mut last_text = HashMap::new();
        for l in lines.iter().filter(|l| l.status == LineStatus::Ok) {
            last_text.insert(base_speaker(&l.speaker).to_string(), l.text.clone());
        }
        let accumulated = meta.duration_secs;
        Arc::new(Self {
            id: meta.id.clone(),
            app,
            meta: Mutex::new(meta),
            timing: Mutex::new(Timing {
                active_since: None,
                accumulated,
            }),
            seg_counter: AtomicU32::new(counter),
            last_text: Mutex::new(last_text),
            work: Arc::new(WorkSet::default()),
            semaphore: Arc::new(tokio::sync::Semaphore::new(CONCURRENCY)),
            transcript_lock: Mutex::new(()),
        })
    }

    fn live_duration(&self) -> f64 {
        let t = self.timing.lock();
        t.accumulated + t.active_since.map(|s| s.elapsed().as_secs_f64()).unwrap_or(0.0)
    }

    pub fn timing_start(&self) {
        let mut t = self.timing.lock();
        if t.active_since.is_none() {
            t.active_since = Some(Instant::now());
        }
    }

    pub fn timing_stop(&self) {
        let mut t = self.timing.lock();
        if let Some(s) = t.active_since.take() {
            t.accumulated += s.elapsed().as_secs_f64();
        }
    }

    pub fn meta_snapshot(&self) -> MeetingMeta {
        let mut m = self.meta.lock().clone();
        m.duration_secs = self.live_duration();
        m
    }

    /// Mutate + persist (+ emit `meeting-status`). Persisting happens under the
    /// meta lock so concurrent writers can't race on the temp file.
    pub fn update_meta(&self, f: impl FnOnce(&mut MeetingMeta)) -> MeetingMeta {
        let duration = self.live_duration();
        let snapshot = {
            let mut m = self.meta.lock();
            f(&mut m);
            m.duration_secs = duration;
            if let Err(e) = storage::write_meta(&m) {
                log::error!("[meeting] {}: {}", m.id, e);
            }
            m.clone()
        };
        let _ = self.app.emit(EVENT_STATUS, &snapshot);
        snapshot
    }

    /// Persist without emitting (periodic duration checkpoint).
    pub fn checkpoint(&self) {
        let duration = self.live_duration();
        let mut m = self.meta.lock();
        m.duration_secs = duration;
        if let Err(e) = storage::write_meta(&m) {
            log::error!("[meeting] {}: {}", m.id, e);
        }
    }

    pub fn emit_error(&self, message: String, seg_id: Option<&str>) {
        log::warn!("[meeting] {} error{}: {}", self.id, seg_id.map(|s| format!(" ({})", s)).unwrap_or_default(), message);
        let _ = self.app.emit(
            EVENT_ERROR,
            ErrorEvent {
                meeting_id: &self.id,
                message,
                seg_id,
            },
        );
    }

    pub fn emit_level(&self, mic: f32, system: f32) {
        let _ = self.app.emit(
            EVENT_LEVEL,
            super::types::LevelEvent {
                meeting_id: &self.id,
                mic,
                system,
            },
        );
    }

    fn write_line(&self, line: &TranscriptLine) {
        {
            let _g = self.transcript_lock.lock();
            if let Err(e) = storage::append_line(&self.id, line) {
                log::error!("[meeting] {}: {}", self.id, e);
            }
        }
        let _ = self.app.emit(
            EVENT_TRANSCRIPT,
            TranscriptEvent {
                meeting_id: &self.id,
                line,
            },
        );
    }

    pub fn is_idle(&self) -> bool {
        self.work.inflight() == 0
    }

    pub async fn wait_idle(&self) {
        while !self.is_idle() {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    /// Called from a capture processor thread when the VAD closes a segment.
    pub fn on_segment(self: &Arc<Self>, speaker: &str, seg: Segment) {
        let n = self.seg_counter.fetch_add(1, Ordering::SeqCst) + 1;
        let seg_id = storage::seg_id(n, speaker);
        let mut line = TranscriptLine {
            seg_id: seg_id.clone(),
            t0: seg.t0(),
            t1: seg.t1(),
            speaker: speaker.to_string(),
            text: String::new(),
            status: LineStatus::Pending,
            error: None,
        };
        // Pending line first: a crash after it leaves a retriable (if audio-less)
        // record rather than an orphan WAV with unknown timing.
        self.write_line(&line);
        self.update_meta(|m| {
            m.segment_count += 1;
            m.pending_segments += 1;
        });
        let wav = encode_wav_i16(&seg.samples, SAMPLE_RATE);
        if let Err(e) = storage::write_segment_wav(&self.id, &seg_id, &wav) {
            line.status = LineStatus::Error;
            line.error = Some(e.clone());
            self.write_line(&line);
            self.update_meta(|m| {
                m.pending_segments = m.pending_segments.saturating_sub(1);
                m.failed_segments += 1;
            });
            self.emit_error(e, Some(&seg_id));
            return;
        }
        // Fresh seg id — the claim can only fail if the counter was reused.
        if let Some(guard) = self.work.claim(&seg_id) {
            self.spawn_transcription(line, guard);
        }
    }

    /// Re-transcribe an existing line (retry / finalize). Adjusts counts from
    /// its previous status and writes a fresh `pending` line. Idempotent: the
    /// seg id is claimed first (under the work lock), so a concurrent or
    /// repeated retry of a queued segment returns before touching the
    /// transcript or the counts. Works for `done` meetings too — the result
    /// is emitted as a normal `meeting-transcript` event and the counts in
    /// `meeting.json` are updated.
    pub fn requeue(self: &Arc<Self>, mut line: TranscriptLine) {
        let Some(guard) = self.work.claim(&line.seg_id) else {
            return;
        };
        let prev = line.status;
        if prev != LineStatus::Pending {
            line.status = LineStatus::Pending;
            line.error = None;
            self.write_line(&line);
            self.update_meta(|m| {
                if prev == LineStatus::Error {
                    m.failed_segments = m.failed_segments.saturating_sub(1);
                }
                m.pending_segments += 1;
            });
        }
        self.spawn_transcription(line, guard);
    }

    /// Transcribe a claimed segment on the async runtime. The guard moves
    /// into the task and releases the claim when it ends — including on panic
    /// or if the runtime drops the task.
    fn spawn_transcription(self: &Arc<Self>, line: TranscriptLine, guard: WorkGuard) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let _guard = guard;
            let result = this.transcribe(&line).await;
            let mut final_line = line.clone();
            match result {
                Ok((text, speaker)) => {
                    final_line.status = LineStatus::Ok;
                    final_line.text = text.clone();
                    final_line.speaker = speaker;
                    final_line.error = None;
                    if !text.trim().is_empty() {
                        this.last_text
                            .lock()
                            .insert(base_speaker(&line.speaker).to_string(), text);
                    }
                    this.write_line(&final_line);
                    this.update_meta(|m| {
                        m.pending_segments = m.pending_segments.saturating_sub(1);
                    });
                }
                Err(e) => {
                    final_line.status = LineStatus::Error;
                    final_line.error = Some(e.clone());
                    this.write_line(&final_line);
                    this.update_meta(|m| {
                        m.pending_segments = m.pending_segments.saturating_sub(1);
                        m.failed_segments += 1;
                    });
                    this.emit_error(format!("Transcription failed: {}", e), Some(&line.seg_id));
                }
            }
        });
    }

    /// Transcribe one segment with retries. Returns (text, speaker).
    async fn transcribe(&self, line: &TranscriptLine) -> Result<(String, String), String> {
        let audio = storage::read_segment_wav(&self.id, &line.seg_id)?;
        let base = base_speaker(&line.speaker).to_string();
        let vocabulary = self.meta.lock().vocabulary.clone();
        let file_name = format!("{}.wav", line.seg_id);
        let mut last_err = String::new();
        let mut tried_docker = false;
        for attempt in 0..=RETRY_BACKOFF.len() {
            let wcfg = meeting_whisper_config(&self.app);
            if let Some(e) = missing_key_error(&wcfg) {
                // Not transient — don't burn retries on it.
                return Err(e);
            }
            let previous = self.last_text.lock().get(&base).cloned();
            let prompt = build_prompt(&vocabulary, previous.as_deref());
            // One concurrency permit per attempt, released before any backoff
            // sleep so a segment waiting out an outage doesn't block others.
            let permit = self.semaphore.clone().acquire_owned().await;
            let outcome = crate::whisper::transcribe_detailed(
                &wcfg,
                audio.clone(),
                &file_name,
                "audio/wav",
                prompt.as_deref(),
            )
            .await;
            drop(permit);
            match outcome {
                Ok(out) => {
                    let speaker = resolve_speaker(&base, &out.segments);
                    return Ok((out.text.trim().to_string(), speaker));
                }
                Err(e) => {
                    log::warn!(
                        "[meeting] {} {} attempt {} failed: {}",
                        self.id,
                        line.seg_id,
                        attempt + 1,
                        e
                    );
                    // Local Docker server down: start it once, like dictation does.
                    if !tried_docker
                        && wcfg.provider == WhisperProvider::Local
                        && crate::docker::is_local_endpoint(&wcfg.endpoint)
                        && e.starts_with("Request failed")
                    {
                        tried_docker = true;
                        let _ = crate::docker::try_start_container(&wcfg.docker.container_name).await;
                    }
                    last_err = e;
                }
            }
            if let Some(wait) = RETRY_BACKOFF.get(attempt) {
                tokio::time::sleep(*wait).await;
            }
        }
        Err(last_err)
    }

    pub fn set_status(&self, status: MeetingStatus) -> MeetingMeta {
        self.update_meta(|m| m.status = status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::whisper::TranscribeSegment;

    fn ts(start: f64, end: f64, speaker: Option<&str>) -> TranscribeSegment {
        TranscribeSegment {
            start,
            end,
            text: String::new(),
            speaker: speaker.map(String::from),
        }
    }

    #[test]
    fn speaker_resolution() {
        assert_eq!(resolve_speaker("me", &[ts(0.0, 5.0, Some("1"))]), "me");
        assert_eq!(resolve_speaker("them", &[]), "them");
        assert_eq!(resolve_speaker("them", &[ts(0.0, 1.0, None)]), "them");
        assert_eq!(
            resolve_speaker("them", &[ts(0.0, 1.0, Some("A")), ts(1.0, 5.0, Some("B"))]),
            "them:B"
        );
    }

    #[test]
    fn claim_is_idempotent_and_released_on_drop() {
        let w = Arc::new(WorkSet::default());
        let g = w.claim("seg-0001-me").expect("first claim");
        assert!(w.claim("seg-0001-me").is_none(), "second claim must be refused");
        assert_eq!(w.inflight(), 1);
        let g2 = w.claim("seg-0002-them").expect("other seg");
        assert_eq!(w.inflight(), 2);
        drop(g);
        assert_eq!(w.inflight(), 1);
        assert!(w.claim("seg-0001-me").is_some(), "re-claimable after release");
        drop(g2);
        assert_eq!(w.inflight(), 0);
    }

    #[test]
    fn claim_released_on_panic() {
        let w = Arc::new(WorkSet::default());
        let w2 = w.clone();
        let r = std::thread::spawn(move || {
            let _g = w2.claim("seg-0001-me").unwrap();
            panic!("transcription task panicked");
        })
        .join();
        assert!(r.is_err());
        assert_eq!(w.inflight(), 0);
        assert!(w.claim("seg-0001-me").is_some());
    }

    #[test]
    fn concurrent_claims_admit_one() {
        let w = Arc::new(WorkSet::default());
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let w = w.clone();
                let b = barrier.clone();
                std::thread::spawn(move || {
                    b.wait();
                    w.claim("seg-0007-me").map(std::mem::forget).is_some()
                })
            })
            .collect();
        let won = handles.into_iter().map(|h| h.join().unwrap()).filter(|&x| x).count();
        assert_eq!(won, 1);
        assert_eq!(w.inflight(), 1);
    }

    #[test]
    fn prompt_building() {
        assert_eq!(build_prompt(&[], None), None);
        assert_eq!(
            build_prompt(&["Tauri".into(), " ".into(), "Svelte".into()], Some("  last words ")),
            Some("Vocabulary: Tauri, Svelte.\nlast words".to_string())
        );
        let long = "å".repeat(1000);
        let p = build_prompt(&[], Some(&long)).unwrap();
        assert_eq!(p.chars().count(), PROMPT_TAIL_CHARS);
    }
}
