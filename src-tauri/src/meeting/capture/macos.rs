//! macOS system-audio capture via ScreenCaptureKit (`screencapturekit` crate,
//! macOS 13+, needs the Screen Recording permission) — UNVERIFIED: written on
//! Windows against the crate's documented API (examples/03_audio_capture.rs,
//! v11), never compiled or run on macOS.
//!
//! Captures all system audio of the main display's content (the app's own audio
//! excluded). Per-app filtering is not implemented: `SystemTarget::Processes`
//! captures everything.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use screencapturekit::prelude::*;

use super::{Chunk, ChunkSender, ErrorFn, SourceHandle, SystemTarget};

const RATE: u32 = 48000;

struct AudioHandler {
    tx: Mutex<ChunkSender>,
}

impl SCStreamOutputTrait for AudioHandler {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, output_type: SCStreamOutputType) {
        if !matches!(output_type, SCStreamOutputType::Audio) {
            return;
        }
        let Ok(list) = sample.audio_buffer_list() else {
            return;
        };
        // Float32 PCM; one buffer per channel when non-interleaved — average them.
        let mut mono: Vec<f32> = Vec::new();
        let mut buffers = 0usize;
        for i in 0..list.num_buffers() {
            let Some(buf) = list.get(i) else { continue };
            let data = buf.data();
            let samples: Vec<f32> = data
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect();
            if mono.is_empty() {
                mono = samples;
            } else {
                for (m, s) in mono.iter_mut().zip(samples.iter()) {
                    *m += s;
                }
            }
            buffers += 1;
        }
        if buffers > 1 {
            for m in &mut mono {
                *m /= buffers as f32;
            }
        }
        if !mono.is_empty() {
            let _ = self.tx.lock().send(Chunk {
                samples: mono,
                rate: RATE,
            });
        }
    }
}

fn open(tx: ChunkSender) -> Result<SCStream, String> {
    let content = SCShareableContent::get()
        .map_err(|e| format!("ScreenCaptureKit unavailable (Screen Recording permission?): {:?}", e))?;
    let display = content
        .displays()
        .into_iter()
        .next()
        .ok_or_else(|| "No display found for ScreenCaptureKit".to_string())?;
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build()
        .map_err(|e| format!("ScreenCaptureKit filter failed: {:?}", e))?;
    let config = SCStreamConfiguration::new()
        // Video is unavoidable; keep it tiny.
        .with_width(2)
        .with_height(2)
        .with_captures_audio(true)
        .with_excludes_current_process_audio(true)
        .with_sample_rate(RATE as i32)
        .with_channel_count(1);
    let mut stream =
        SCStream::new(&filter, &config).map_err(|e| format!("SCStream failed: {:?}", e))?;
    stream
        .add_output_handler(AudioHandler { tx: Mutex::new(tx) }, SCStreamOutputType::Audio)
        .map_err(|e| format!("SCStream handler failed: {:?}", e))?;
    stream
        .start_capture()
        .map_err(|e| format!("ScreenCaptureKit start failed: {:?}", e))?;
    Ok(stream)
}

pub fn start_system(
    target: &SystemTarget,
    tx: ChunkSender,
    _on_error: ErrorFn,
) -> Result<SourceHandle, String> {
    if let SystemTarget::Processes(names) = target {
        log::info!(
            "[meeting] per-app capture ({:?}) isn't implemented on macOS; capturing all system audio",
            names
        );
    }
    let stop = Arc::new(AtomicBool::new(false));
    let stop_t = stop.clone();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let thread = std::thread::Builder::new()
        .name("meeting-system".into())
        .spawn(move || match open(tx) {
            Ok(stream) => {
                let _ = ready_tx.send(Ok(()));
                while !stop_t.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(100));
                }
                let _ = stream.stop_capture();
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
            }
        })
        .map_err(|e| format!("Failed to spawn system capture thread: {}", e))?;
    match ready_rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(())) => Ok(SourceHandle::new(
            "ScreenCaptureKit system audio (48 kHz)".to_string(),
            stop,
            thread,
            None,
        )),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            Err("Timed out starting ScreenCaptureKit".to_string())
        }
    }
}
