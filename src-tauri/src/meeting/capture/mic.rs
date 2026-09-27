//! Microphone capture via `cpal` (all platforms).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample, StreamConfig};

use super::{Chunk, ChunkSender, ErrorFn, SourceHandle};

fn device_name(device: &cpal::Device) -> Option<String> {
    device.description().ok().map(|d| d.name().to_string())
}

/// Names of the input devices on the default host (what `meeting.mic_device` matches).
pub fn list_input_devices() -> Vec<String> {
    let host = cpal::default_host();
    let Ok(devices) = host.input_devices() else {
        return Vec::new();
    };
    let mut names: Vec<String> = devices.filter_map(|d| device_name(&d)).collect();
    names.dedup();
    names
}

fn find_device(name: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if let Some(wanted) = name.filter(|n| !n.trim().is_empty()) {
        let devices = host
            .input_devices()
            .map_err(|e| format!("Failed to list input devices: {}", e))?;
        for d in devices {
            if device_name(&d).as_deref() == Some(wanted) {
                return Ok(d);
            }
        }
        log::warn!(
            "[meeting] mic device {:?} not found; using the default input",
            wanted
        );
    }
    host.default_input_device()
        .ok_or_else(|| "No microphone (default input device) available".to_string())
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    tx: ChunkSender,
    on_error: ErrorFn,
    broken: Arc<AtomicBool>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = (config.channels as usize).max(1);
    let rate = config.sample_rate;
    device
        .build_input_stream::<T, _, _>(
            *config,
            move |data: &[T], _info: &cpal::InputCallbackInfo| {
                let mono: Vec<f32> = data
                    .chunks(channels)
                    .map(|frame| {
                        frame.iter().map(|s| s.to_sample::<f32>()).sum::<f32>() / channels as f32
                    })
                    .collect();
                let _ = tx.send(Chunk {
                    samples: mono,
                    rate,
                });
            },
            move |err: cpal::Error| {
                // Over/underruns (common right at stream start) aren't worth a UI error.
                if err.kind() == cpal::ErrorKind::Xrun {
                    log::debug!("[meeting] mic xrun: {}", err);
                } else if !broken.swap(true, Ordering::SeqCst) {
                    // First failure of this stream: the mic thread reopens it.
                    on_error(format!("Microphone stream error: {} (reconnecting)", err));
                } else {
                    log::debug!("[meeting] mic stream error (already reconnecting): {}", err);
                }
            },
            None,
        )
        .map_err(|e| format!("Failed to open microphone stream: {}", e))
}

fn open(
    name: Option<&str>,
    tx: ChunkSender,
    on_error: ErrorFn,
    broken: Arc<AtomicBool>,
) -> Result<(cpal::Stream, String), String> {
    let device = find_device(name)?;
    let label = device_name(&device).unwrap_or_else(|| "default input".to_string());
    let supported = device
        .default_input_config()
        .map_err(|e| format!("Microphone {:?} has no usable input config: {}", label, e))?;
    let format = supported.sample_format();
    let config = supported.config();
    let stream = match format {
        SampleFormat::F32 => build_stream::<f32>(&device, &config, tx, on_error, broken)?,
        SampleFormat::I16 => build_stream::<i16>(&device, &config, tx, on_error, broken)?,
        SampleFormat::U16 => build_stream::<u16>(&device, &config, tx, on_error, broken)?,
        SampleFormat::I32 => build_stream::<i32>(&device, &config, tx, on_error, broken)?,
        SampleFormat::I8 => build_stream::<i8>(&device, &config, tx, on_error, broken)?,
        SampleFormat::F64 => build_stream::<f64>(&device, &config, tx, on_error, broken)?,
        other => return Err(format!("Unsupported microphone sample format {:?}", other)),
    };
    stream
        .play()
        .map_err(|e| format!("Failed to start microphone: {}", e))?;
    Ok((
        stream,
        format!("{} ({} Hz, {} ch)", label, config.sample_rate, config.channels),
    ))
}

/// Backoff between mic reopen attempts after a stream error (doubles per failure).
const REOPEN_BACKOFF_START: Duration = Duration::from_secs(1);
const REOPEN_BACKOFF_MAX: Duration = Duration::from_secs(15);

/// Open the mic on a dedicated thread (cpal streams aren't `Send` everywhere);
/// returns once the stream is running or failed to open.
///
/// A non-xrun stream error (mic unplugged, device invalidated) drops the dead
/// stream and reopens it with backoff — the configured device if it's back,
/// otherwise the default input. While the mic is gone no chunks arrive and the
/// stream processor pads the gap from the wall clock, so the "me" timeline
/// stays aligned with "them" across the outage.
pub fn start_mic(
    name: Option<String>,
    tx: ChunkSender,
    on_error: ErrorFn,
) -> Result<SourceHandle, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_t = stop.clone();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<String, String>>();
    let thread = std::thread::Builder::new()
        .name("meeting-mic".into())
        .spawn(move || {
            let broken = Arc::new(AtomicBool::new(false));
            let mut stream = match open(name.as_deref(), tx.clone(), on_error.clone(), broken.clone()) {
                Ok((stream, desc)) => {
                    let _ = ready_tx.send(Ok(desc));
                    Some(stream)
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            let mut backoff = REOPEN_BACKOFF_START;
            let mut next_try = Instant::now();
            let mut reported_failure = false;
            while !stop_t.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(100));
                if stream.is_some() && broken.load(Ordering::SeqCst) {
                    log::warn!("[meeting] mic stream failed; reopening");
                    stream = None;
                    next_try = Instant::now() + backoff;
                }
                if stream.is_none() && Instant::now() >= next_try {
                    broken.store(false, Ordering::SeqCst);
                    match open(name.as_deref(), tx.clone(), on_error.clone(), broken.clone()) {
                        Ok((s, desc)) => {
                            log::info!("[meeting] mic reopened: {}", desc);
                            stream = Some(s);
                            backoff = REOPEN_BACKOFF_START;
                            reported_failure = false;
                        }
                        Err(e) => {
                            log::warn!("[meeting] mic reopen failed: {}", e);
                            if !reported_failure {
                                reported_failure = true;
                                on_error(format!("Microphone unavailable: {} (retrying)", e));
                            }
                            backoff = (backoff * 2).min(REOPEN_BACKOFF_MAX);
                            next_try = Instant::now() + backoff;
                        }
                    }
                }
            }
            drop(stream);
        })
        .map_err(|e| format!("Failed to spawn mic thread: {}", e))?;
    let desc = match ready_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(r) => r?,
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            return Err("Timed out opening the microphone".to_string());
        }
    };
    Ok(SourceHandle::new(desc, stop, thread, None))
}
