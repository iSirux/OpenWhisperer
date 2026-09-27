//! A live capture session: the sources, one processor thread per stream
//! (resample → wall-clock gap fill → VAD → segments to the pipeline), and a
//! level/checkpoint thread.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::config::MeetingConfig;

use super::capture::{self, Chunk, ErrorFn, SourceHandle, SystemTarget};
use super::pipeline::MeetingHandle;
use super::resample::Resampler;
use super::vad::{rms, Segmenter, VadConfig, SAMPLE_RATE};

/// Pad with silence once a stream lags the wall clock by more than this
/// (silent WASAPI endpoints deliver no packets at all).
const GAP_FILL_THRESHOLD_SECS: f64 = 0.4;
/// …leaving this much lag so late-arriving real audio isn't pushed ahead.
const GAP_FILL_KEEP_LAG_SECS: f64 = 0.1;
const LEVEL_INTERVAL: Duration = Duration::from_millis(250);
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(30);

fn store_max(level: &AtomicU32, v: f32) {
    let mut cur = level.load(Ordering::Relaxed);
    while f32::from_bits(cur) < v {
        match level.compare_exchange_weak(cur, v.to_bits(), Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(actual) => cur = actual,
        }
    }
}

/// Samples of silence to insert so a stream at `pos` (samples) catches up with
/// the wall clock at `elapsed_secs`. Zero until the deficit exceeds the
/// threshold; then fills up to `GAP_FILL_KEEP_LAG_SECS` behind. Only meaningful
/// when the stream's channel is known to be empty (see `run_stream`).
pub(crate) fn gap_fill_samples(elapsed_secs: f64, pos: u64) -> u64 {
    let rate = SAMPLE_RATE as f64;
    let deficit = elapsed_secs * rate - pos as f64;
    if deficit > GAP_FILL_THRESHOLD_SECS * rate {
        (deficit - GAP_FILL_KEEP_LAG_SECS * rate) as u64
    } else {
        0
    }
}

/// One stream's processing loop, independent of `MeetingHandle` (testable):
/// resample every chunk, feed the VAD, and pad the wall-clock gap with silence
/// — but **only once the channel is drained** (`recv_timeout` timed out or
/// `try_recv` found it empty). A processing stall leaves real audio queued in
/// the channel; padding then would place that audio after spurious silence and
/// push this stream's timeline permanently ahead of the other one.
///
/// `elapsed` = wall-clock seconds since the shared session start (both streams
/// use the same anchor, which keeps me/them aligned). Returns the final
/// timeline position in samples.
pub(crate) fn run_stream(
    rx: &Receiver<Chunk>,
    paused_flag: &AtomicBool,
    level: &AtomicU32,
    vad: VadConfig,
    elapsed: impl Fn() -> f64,
    mut on_segment: impl FnMut(super::vad::Segment),
) -> u64 {
    let mut seg = Segmenter::new(vad);
    let mut resampler: Option<Resampler> = None;
    let mut was_paused = false;
    let mut buf: Vec<f32> = Vec::new();
    let zeros = vec![0.0f32; SAMPLE_RATE as usize];

    // Re-read the pause flag; on the running → paused edge close the open segment.
    let mut check_pause = |seg: &mut Segmenter, on_segment: &mut dyn FnMut(super::vad::Segment)| -> bool {
        let paused = paused_flag.load(Ordering::SeqCst);
        if paused && !was_paused {
            if let Some(s) = seg.flush() {
                on_segment(s);
            }
        }
        was_paused = paused;
        paused
    };

    let mut disconnected = false;
    while !disconnected {
        let mut next = match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(chunk) => Some(chunk),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => {
                disconnected = true;
                None
            }
        };
        // Drain everything already queued before looking at the wall clock.
        while let Some(chunk) = next.take() {
            let paused = check_pause(&mut seg, &mut on_segment);
            if resampler.as_ref().map(|r| r.in_rate()) != Some(chunk.rate) {
                resampler = Some(Resampler::new(chunk.rate, SAMPLE_RATE));
            }
            buf.clear();
            if let Some(r) = resampler.as_mut() {
                r.process(&chunk.samples, &mut buf);
            }
            store_max(level, rms(&buf));
            if paused {
                seg.skip(buf.len() as u64);
            } else {
                for s in seg.push(&buf) {
                    on_segment(s);
                }
            }
            match rx.try_recv() {
                Ok(c) => next = Some(c),
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => disconnected = true,
            }
        }
        if disconnected {
            break;
        }

        // Channel known empty: whatever the timeline lacks vs the wall clock
        // was never delivered (silent WASAPI endpoint, device gap) → pad it.
        let paused = check_pause(&mut seg, &mut on_segment);
        let mut missing = gap_fill_samples(elapsed(), seg.position());
        if missing > 0 {
            if paused {
                seg.skip(missing);
            } else {
                while missing > 0 {
                    let n = missing.min(zeros.len() as u64) as usize;
                    for s in seg.push(&zeros[..n]) {
                        on_segment(s);
                    }
                    missing -= n as u64;
                }
            }
        }
    }
    if let Some(s) = seg.flush() {
        on_segment(s);
    }
    seg.position()
}

struct StreamCtx {
    speaker: &'static str,
    rx: Receiver<Chunk>,
    level: Arc<AtomicU32>,
    paused: Arc<AtomicBool>,
    handle: Arc<MeetingHandle>,
    vad: VadConfig,
    t_start: Instant,
}

fn run_processor(ctx: StreamCtx) {
    let t_start = ctx.t_start;
    let handle = ctx.handle.clone();
    let speaker = ctx.speaker;
    run_stream(
        &ctx.rx,
        &ctx.paused,
        &ctx.level,
        ctx.vad.clone(),
        move || t_start.elapsed().as_secs_f64(),
        move |s| handle.on_segment(speaker, s),
    );
}

pub struct CaptureSession {
    sources: Vec<SourceHandle>,
    processors: Vec<JoinHandle<()>>,
    paused: Arc<AtomicBool>,
    level_stop: Arc<AtomicBool>,
    level_thread: Option<JoinHandle<()>>,
    pub mic_active: bool,
    pub system_active: bool,
}

impl CaptureSession {
    pub fn start(handle: Arc<MeetingHandle>, cfg: &MeetingConfig) -> Result<Self, String> {
        if !cfg.capture_mic && !cfg.capture_system {
            return Err("Enable microphone or system audio capture in Settings → Meeting".into());
        }
        let t_start = Instant::now();
        let paused = Arc::new(AtomicBool::new(false));
        let mic_level = Arc::new(AtomicU32::new(0));
        let sys_level = Arc::new(AtomicU32::new(0));
        let vad = VadConfig::from_meeting(cfg.vad_threshold, cfg.silence_hangover_ms, cfg.max_segment_secs);
        let h_err = handle.clone();
        let on_error: ErrorFn = Arc::new(move |msg| h_err.emit_error(msg, None));

        let mut sources = Vec::new();
        let mut processors = Vec::new();
        let mut errors = Vec::new();
        let mut mic_active = false;
        let mut system_active = false;

        let spawn_processor = |speaker: &'static str, rx: Receiver<Chunk>, level: Arc<AtomicU32>| {
            let ctx = StreamCtx {
                speaker,
                rx,
                level,
                paused: paused.clone(),
                handle: handle.clone(),
                vad: vad.clone(),
                t_start,
            };
            std::thread::Builder::new()
                .name(format!("meeting-proc-{}", speaker))
                .spawn(move || run_processor(ctx))
        };

        if cfg.capture_mic {
            let (tx, rx) = mpsc::channel();
            match capture::mic::start_mic(cfg.mic_device.clone(), tx, on_error.clone()) {
                Ok(src) => {
                    log::info!("[meeting] mic: {}", src.description);
                    match spawn_processor("me", rx, mic_level.clone()) {
                        Ok(t) => {
                            processors.push(t);
                            sources.push(src);
                            mic_active = true;
                        }
                        Err(e) => {
                            src.stop();
                            errors.push(format!("mic processor: {}", e));
                        }
                    }
                }
                Err(e) => errors.push(format!("Microphone: {}", e)),
            }
        }

        if cfg.capture_system {
            let target = if cfg.system_target == "all" {
                SystemTarget::All
            } else {
                SystemTarget::Processes(cfg.system_process_names.clone())
            };
            let (tx, rx) = mpsc::channel();
            match capture::start_system(&target, tx, on_error.clone()) {
                Ok(src) => {
                    log::info!("[meeting] system: {}", src.description);
                    match spawn_processor("them", rx, sys_level.clone()) {
                        Ok(t) => {
                            processors.push(t);
                            sources.push(src);
                            system_active = true;
                        }
                        Err(e) => {
                            src.stop();
                            errors.push(format!("system processor: {}", e));
                        }
                    }
                }
                Err(e) => errors.push(format!("System audio: {}", e)),
            }
        }

        if !mic_active && !system_active {
            return Err(format!("No audio source could be started. {}", errors.join("; ")));
        }
        for e in errors {
            handle.emit_error(e, None);
        }

        let level_stop = Arc::new(AtomicBool::new(false));
        let ls = level_stop.clone();
        let lh = handle.clone();
        let level_thread = std::thread::Builder::new()
            .name("meeting-level".into())
            .spawn(move || {
                let mut last_checkpoint = Instant::now();
                while !ls.load(Ordering::SeqCst) {
                    std::thread::sleep(LEVEL_INTERVAL);
                    let mic = f32::from_bits(mic_level.swap(0, Ordering::Relaxed));
                    let system = f32::from_bits(sys_level.swap(0, Ordering::Relaxed));
                    lh.emit_level(mic.clamp(0.0, 1.0), system.clamp(0.0, 1.0));
                    if last_checkpoint.elapsed() >= CHECKPOINT_INTERVAL {
                        last_checkpoint = Instant::now();
                        lh.checkpoint();
                    }
                }
            })
            .ok();

        Ok(Self {
            sources,
            processors,
            paused,
            level_stop,
            level_thread,
            mic_active,
            system_active,
        })
    }

    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
    }

    /// Stop sources, let processors drain + flush their open segment, join all.
    pub fn stop(self) {
        for s in self.sources {
            s.stop();
        }
        for p in self.processors {
            let _ = p.join();
        }
        self.level_stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.level_thread {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vad() -> VadConfig {
        VadConfig::from_meeting(0.015, 500, 30)
    }

    const SR: u64 = SAMPLE_RATE as u64;

    #[test]
    fn gap_fill_math() {
        assert_eq!(gap_fill_samples(1.0, SR), 0);
        // 0.3 s behind: under the threshold.
        assert_eq!(gap_fill_samples(1.3, SR), 0);
        // 1 s behind: fill to 0.1 s behind.
        assert_eq!(gap_fill_samples(2.0, SR), (0.9 * SR as f64) as u64);
        // Ahead of the wall clock: never negative.
        assert_eq!(gap_fill_samples(1.0, 5 * SR), 0);
    }

    /// A processing stall leaves 5 s of real audio queued while the wall clock
    /// already reads 5 s. The old loop padded ~4.8 s of silence after the first
    /// chunk and pushed the timeline ~5 s ahead; now the queue drains first
    /// and nothing is inserted.
    #[test]
    fn no_silence_ahead_of_queued_audio() {
        let (tx, rx) = mpsc::channel();
        for _ in 0..50 {
            tx.send(Chunk {
                samples: vec![0.0; (SR / 10) as usize],
                rate: SAMPLE_RATE,
            })
            .unwrap();
        }
        drop(tx);
        let paused = AtomicBool::new(false);
        let level = AtomicU32::new(0);
        let pos = run_stream(&rx, &paused, &level, vad(), || 5.0, |_| {});
        assert_eq!(pos, 5 * SR);
    }

    /// A silent endpoint (no packets) is padded up to the wall clock once the
    /// channel times out empty.
    #[test]
    fn fills_when_idle() {
        let (tx, rx) = mpsc::channel::<Chunk>();
        let closer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(350));
            drop(tx);
        });
        let paused = AtomicBool::new(false);
        let level = AtomicU32::new(0);
        let pos = run_stream(&rx, &paused, &level, vad(), || 2.0, |_| {});
        closer.join().unwrap();
        assert_eq!(pos, gap_fill_samples(2.0, 0));
    }
}
