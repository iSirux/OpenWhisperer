//! Audio sources for meeting capture. Each source runs on its own thread and
//! pushes mono f32 chunks at its native rate into a channel; the per-stream
//! processor (`meeting::session`) resamples, aligns and segments them.
//!
//! - mic: `cpal` on every platform (`mic.rs`)
//! - system: WASAPI loopback / process loopback on Windows (`windows.rs`),
//!   ScreenCaptureKit on macOS (`macos.rs`, UNVERIFIED), PulseAudio/PipeWire
//!   monitor via `parec` on Linux (`linux.rs`, UNVERIFIED).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread::JoinHandle;

use super::types::AudioProcess;

pub mod mic;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
pub mod windows;

/// Mono samples at `rate` Hz.
pub struct Chunk {
    pub samples: Vec<f32>,
    pub rate: u32,
}

pub type ChunkSender = Sender<Chunk>;

/// Runtime (post-start) error reporter, e.g. device unplugged.
pub type ErrorFn = Arc<dyn Fn(String) + Send + Sync>;

/// What system audio to capture.
#[derive(Debug, Clone)]
pub enum SystemTarget {
    /// Everything the default output device plays.
    All,
    /// Only these apps' process trees (Windows); falls back to `All` when none runs.
    Processes(Vec<String>),
}

/// A running source. Dropping without `stop()` leaks the thread until process exit.
pub struct SourceHandle {
    pub description: String,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    /// Extra teardown (e.g. kill a subprocess so a blocking read returns).
    on_stop: Option<Box<dyn FnOnce() + Send>>,
}

impl SourceHandle {
    pub(crate) fn new(
        description: String,
        stop: Arc<AtomicBool>,
        thread: JoinHandle<()>,
        on_stop: Option<Box<dyn FnOnce() + Send>>,
    ) -> Self {
        Self {
            description,
            stop,
            thread: Some(thread),
            on_stop,
        }
    }

    /// Signal the thread and wait for it (its channel sender is dropped on exit).
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(f) = self.on_stop.take() {
            f();
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Start system-audio capture for the current platform.
pub fn start_system(
    target: &SystemTarget,
    tx: ChunkSender,
    on_error: ErrorFn,
) -> Result<SourceHandle, String> {
    #[cfg(windows)]
    {
        windows::start_system(target, tx, on_error)
    }
    #[cfg(target_os = "macos")]
    {
        macos::start_system(target, tx, on_error)
    }
    #[cfg(target_os = "linux")]
    {
        linux::start_system(target, tx, on_error)
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = (target, tx, on_error);
        Err("System audio capture is not supported on this platform yet".to_string())
    }
}

/// Processes currently holding an audio session (Windows only; empty elsewhere).
pub fn list_audio_processes() -> Vec<AudioProcess> {
    #[cfg(windows)]
    {
        windows::list_audio_processes()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

pub use mic::list_input_devices;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::resample::Resampler;
    use crate::meeting::vad::SAMPLE_RATE;
    use crate::meeting::wav::encode_wav_i16;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn collect(rx: mpsc::Receiver<Chunk>, secs: u64) -> (Vec<f32>, usize) {
        let mut out = Vec::new();
        let mut chunks = 0;
        let mut r: Option<Resampler> = None;
        let end = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < end {
            if let Ok(c) = rx.recv_timeout(Duration::from_millis(100)) {
                chunks += 1;
                if r.as_ref().map(|r| r.in_rate()) != Some(c.rate) {
                    r = Some(Resampler::new(c.rate, SAMPLE_RATE));
                }
                r.as_mut().unwrap().process(&c.samples, &mut out);
            }
        }
        (out, chunks)
    }

    /// Manual hardware check: records 5 s of mic + system loopback into
    /// `%TEMP%/ow-meeting-capture-{mic,system}.wav`.
    /// Run: `cargo test --lib meeting::capture::tests -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn capture_five_seconds_to_wav() {
        println!("input devices: {:?}", list_input_devices());
        println!("audio processes: {:?}", list_audio_processes().iter().map(|p| format!("{}:{}", p.name, p.pid)).collect::<Vec<_>>());
        let on_error: ErrorFn = Arc::new(|m| println!("runtime error: {m}"));

        let (mtx, mrx) = mpsc::channel();
        let mic = mic::start_mic(None, mtx, on_error.clone());
        let (stx, srx) = mpsc::channel();
        // OW_MEETING_TEST_TARGET=all → full loopback instead of the default app list.
        let target = if std::env::var("OW_MEETING_TEST_TARGET").as_deref() == Ok("all") {
            SystemTarget::All
        } else {
            SystemTarget::Processes(crate::config::default_meeting_process_names())
        };
        let sys = start_system(&target, stx, on_error.clone());
        println!("mic: {:?}", mic.as_ref().map(|s| s.description.clone()));
        println!("system: {:?}", sys.as_ref().map(|s| s.description.clone()));

        let mic_thread = std::thread::spawn(move || collect(mrx, 5));
        let (sys_audio, sys_chunks) = collect(srx, 5);
        let (mic_audio, mic_chunks) = mic_thread.join().unwrap();
        if let Ok(s) = mic {
            s.stop();
        }
        if let Ok(s) = sys {
            s.stop();
        }

        let dir = std::env::temp_dir();
        for (name, audio, chunks) in [("mic", &mic_audio, mic_chunks), ("system", &sys_audio, sys_chunks)] {
            let path = dir.join(format!("ow-meeting-capture-{name}.wav"));
            std::fs::write(&path, encode_wav_i16(audio, SAMPLE_RATE)).unwrap();
            println!(
                "{name}: {chunks} chunks, {:.2} s @16k, rms {:.4} -> {}",
                audio.len() as f64 / SAMPLE_RATE as f64,
                crate::meeting::vad::rms(audio),
                path.display()
            );
        }
    }
}
