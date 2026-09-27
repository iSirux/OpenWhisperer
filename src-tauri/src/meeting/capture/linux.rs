//! Linux system-audio capture — UNVERIFIED (written on Windows, never compiled
//! or run on Linux).
//!
//! Records the monitor of the default sink with `parec` (pulseaudio-utils; also
//! served by `pipewire-pulse` on PipeWire systems), asking for raw 16 kHz mono
//! float32 on stdout. Per-app capture is not implemented: `SystemTarget::Processes`
//! captures everything the default output plays.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;

use super::{Chunk, ChunkSender, ErrorFn, SourceHandle, SystemTarget};

const RATE: u32 = 16000;

pub fn start_system(
    target: &SystemTarget,
    tx: ChunkSender,
    on_error: ErrorFn,
) -> Result<SourceHandle, String> {
    if let SystemTarget::Processes(names) = target {
        log::info!(
            "[meeting] per-app capture ({:?}) isn't implemented on Linux; capturing the default sink monitor",
            names
        );
    }
    let mut child = Command::new("parec")
        .args([
            "--device=@DEFAULT_MONITOR@",
            "--format=float32le",
            "--rate=16000",
            "--channels=1",
            "--raw",
            "--latency-msec=100",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            format!(
                "System audio capture needs `parec` (pulseaudio-utils or pipewire-pulse): {}",
                e
            )
        })?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "parec produced no stdout".to_string())?;
    let child = Arc::new(Mutex::new(Some(child)));

    let stop = Arc::new(AtomicBool::new(false));
    let stop_t = stop.clone();
    let thread = std::thread::Builder::new()
        .name("meeting-system".into())
        .spawn(move || {
            let mut buf = vec![0u8; 3200 * 4];
            let mut carry: Vec<u8> = Vec::new();
            while !stop_t.load(Ordering::SeqCst) {
                match stdout.read(&mut buf) {
                    Ok(0) => {
                        if !stop_t.load(Ordering::SeqCst) {
                            on_error("System audio capture (parec) exited".to_string());
                        }
                        break;
                    }
                    Ok(n) => {
                        carry.extend_from_slice(&buf[..n]);
                        let usable = carry.len() / 4 * 4;
                        let samples: Vec<f32> = carry[..usable]
                            .chunks_exact(4)
                            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                            .collect();
                        carry.drain(..usable);
                        if tx.send(Chunk { samples, rate: RATE }).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        on_error(format!("System audio capture read failed: {}", e));
                        break;
                    }
                }
            }
        })
        .map_err(|e| format!("Failed to spawn system capture thread: {}", e))?;

    let child_for_stop = child.clone();
    let on_stop: Box<dyn FnOnce() + Send> = Box::new(move || {
        if let Some(mut c) = child_for_stop.lock().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    });
    Ok(SourceHandle::new(
        "default sink monitor via parec (16 kHz)".to_string(),
        stop,
        thread,
        Some(on_stop),
    ))
}
