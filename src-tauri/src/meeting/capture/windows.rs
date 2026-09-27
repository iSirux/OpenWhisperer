//! Windows system-audio capture via WASAPI (`wasapi` crate):
//! - default-render **loopback** (everything the speakers play), or
//! - **process loopback** (`PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`,
//!   Win10 2004+) of one target app tree (Discord / Teams …), falling back to
//!   full loopback when none of the configured apps is running.
//!
//! A render endpoint with nothing playing delivers **no packets** (not silent
//! ones); this module simply delivers nothing then, and the stream processor
//! fills the gap from the wall clock so both timelines stay aligned.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use wasapi::{
    AudioCaptureClient, AudioClient, DeviceEnumerator, Direction, Handle, SampleType,
    SessionState, StreamMode, WaveFormat,
};

use super::super::types::AudioProcess;
use super::{Chunk, ChunkSender, ErrorFn, SourceHandle, SystemTarget};

// ---------------------------------------------------------------------------
// Process table (ToolHelp snapshot)
// ---------------------------------------------------------------------------

struct ProcInfo {
    pid: u32,
    ppid: u32,
    name: String,
}

fn process_table() -> Vec<ProcInfo> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    // SAFETY: plain Win32 calls; the entry struct is sized via dwSize and the
    // snapshot handle is closed on every path.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return out;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                out.push(ProcInfo {
                    pid: entry.th32ProcessID,
                    ppid: entry.th32ParentProcessID,
                    name: String::from_utf16_lossy(&entry.szExeFile[..len]),
                });
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    out
}

/// Pids with an audio session on any active render endpoint (`active_only`
/// restricts to sessions currently playing).
fn audio_session_pids(active_only: bool) -> HashSet<u32> {
    let mut pids = HashSet::new();
    let Ok(enumerator) = DeviceEnumerator::new() else {
        return pids;
    };
    let Ok(collection) = enumerator.get_device_collection(&Direction::Render) else {
        return pids;
    };
    for device in &collection {
        let Ok(device) = device else { continue };
        let Ok(manager) = device.get_iaudiosessionmanager() else {
            continue;
        };
        let Ok(sessions) = manager.get_audiosessionenumerator() else {
            continue;
        };
        let count = sessions.get_count().unwrap_or(0);
        for i in 0..count {
            let Ok(control) = sessions.get_session(i) else {
                continue;
            };
            let state = control.get_state().unwrap_or(SessionState::Expired);
            let keep = match state {
                SessionState::Active => true,
                SessionState::Inactive => !active_only,
                SessionState::Expired => false,
            };
            if !keep {
                continue;
            }
            if let Ok(pid) = control.get_process_id() {
                if pid != 0 {
                    pids.insert(pid);
                }
            }
        }
    }
    pids
}

/// Processes with an audio session (for the settings "running audio apps" helper).
pub fn list_audio_processes() -> Vec<AudioProcess> {
    let _ = wasapi::initialize_mta().ok();
    let pids = audio_session_pids(false);
    let table = process_table();
    let names: HashMap<u32, &str> = table.iter().map(|p| (p.pid, p.name.as_str())).collect();
    let mut out: Vec<AudioProcess> = pids
        .into_iter()
        .map(|pid| AudioProcess {
            pid,
            name: names.get(&pid).copied().unwrap_or("").to_string(),
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.pid.cmp(&b.pid)));
    out
}

/// A candidate capture target from `find_target`.
#[derive(Debug, Clone, PartialEq)]
struct Target {
    pid: u32,
    name: String,
    /// Its process tree holds an audio session that is currently playing.
    active: bool,
}

/// Pick the process tree to capture: for each configured name (in order),
/// the top-most process of that name (its parent isn't the same exe). Prefer a
/// tree that currently holds an active audio session.
fn find_target(names: &[String]) -> Option<Target> {
    let table = process_table();
    let by_pid: HashMap<u32, &ProcInfo> = table.iter().map(|p| (p.pid, p)).collect();
    let active = audio_session_pids(true);

    let is_in_tree = |mut pid: u32, root: u32| -> bool {
        for _ in 0..64 {
            if pid == root {
                return true;
            }
            match by_pid.get(&pid) {
                Some(p) if p.ppid != pid && p.ppid != 0 => pid = p.ppid,
                _ => return false,
            }
        }
        false
    };

    let mut fallback: Option<Target> = None;
    for wanted in names {
        let roots: Vec<&ProcInfo> = table
            .iter()
            .filter(|p| p.name.eq_ignore_ascii_case(wanted))
            .filter(|p| {
                by_pid
                    .get(&p.ppid)
                    .map(|parent| !parent.name.eq_ignore_ascii_case(&p.name))
                    .unwrap_or(true)
            })
            .collect();
        for root in roots {
            if active.iter().any(|&pid| is_in_tree(pid, root.pid)) {
                return Some(Target {
                    pid: root.pid,
                    name: root.name.clone(),
                    active: true,
                });
            }
            if fallback.is_none() {
                fallback = Some(Target {
                    pid: root.pid,
                    name: root.name.clone(),
                    active: false,
                });
            }
        }
    }
    fallback
}

/// Whether `pid` is still running as `name` (guards against pid reuse).
fn process_alive(pid: u32, name: &str) -> bool {
    process_table()
        .iter()
        .any(|p| p.pid == pid && p.name.eq_ignore_ascii_case(name))
}

#[derive(Debug, PartialEq)]
enum Retarget {
    Keep,
    Switch { pid: u32, name: String },
    Endpoint,
}

/// Pure re-targeting decision for process loopback.
/// - `current`: the captured pid, or `None` when running the full-loopback
///   fallback because no listed app was capturable.
/// - `current_alive`: the captured process still exists.
/// - `found`: a fresh `find_target` result.
fn decide_retarget(current: Option<u32>, current_alive: bool, found: Option<Target>) -> Retarget {
    match current {
        Some(cur) if !current_alive => match found {
            Some(t) if t.pid != cur => Retarget::Switch {
                pid: t.pid,
                name: t.name,
            },
            _ => Retarget::Endpoint,
        },
        Some(cur) => match found {
            // Only leave a live target for one that is audibly playing.
            Some(t) if t.active && t.pid != cur => Retarget::Switch {
                pid: t.pid,
                name: t.name,
            },
            _ => Retarget::Keep,
        },
        None => match found {
            Some(t) if t.active => Retarget::Switch {
                pid: t.pid,
                name: t.name,
            },
            _ => Retarget::Keep,
        },
    }
}

/// Process loopback: without packets for this long, look for a better target.
const RETARGET_IDLE: Duration = Duration::from_secs(10);
/// Full-loopback fallback: how often to look for a listed app that started playing.
const RETARGET_FALLBACK_INTERVAL: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

#[derive(Clone)]
enum Mode {
    Endpoint,
    Process { pid: u32, name: String },
}

struct Opened {
    client: AudioClient,
    capture: AudioCaptureClient,
    event: Handle,
    rate: u32,
    channels: usize,
    device_id: Option<String>,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn open(mode: &Mode) -> Result<Opened, String> {
    // 16 kHz mono float first (the shared-mode engine converts for us with
    // AUTOCONVERTPCM); 48 kHz stereo as a fallback for picky drivers.
    let formats = [(16000usize, 1usize), (48000, 2)];
    let mut last_err = String::new();
    for (rate, channels) in formats {
        let (mut client, device_id) = match mode {
            Mode::Endpoint => {
                let enumerator = DeviceEnumerator::new().map_err(err)?;
                let device = enumerator
                    .get_default_device(&Direction::Render)
                    .map_err(|e| format!("No default output device: {}", e))?;
                let id = device.get_id().ok();
                (device.get_iaudioclient().map_err(err)?, id)
            }
            Mode::Process { pid, .. } => (
                AudioClient::new_application_loopback_client(*pid, true).map_err(err)?,
                None,
            ),
        };
        let format = WaveFormat::new(32, 32, &SampleType::Float, rate, channels, None);
        let stream_mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: 2_000_000, // 200 ms
        };
        // Loopback = a render device's client initialized in the capture direction.
        match client.initialize_client(&format, &Direction::Capture, &stream_mode) {
            Ok(()) => {
                let event = client.set_get_eventhandle().map_err(err)?;
                let capture = client.get_audiocaptureclient().map_err(err)?;
                client.start_stream().map_err(err)?;
                return Ok(Opened {
                    client,
                    capture,
                    event,
                    rate: rate as u32,
                    channels,
                    device_id,
                });
            }
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(format!("Failed to initialize loopback capture: {}", last_err))
}

/// Drain every available packet into `tx`. Returns whether any audio was
/// delivered; Err on device errors.
fn drain(opened: &Opened, deque: &mut VecDeque<u8>, tx: &ChunkSender) -> Result<bool, String> {
    let block = opened.channels * 4;
    loop {
        let frames = opened.capture.get_next_packet_size().map_err(err)?.unwrap_or(0);
        if frames == 0 {
            break;
        }
        let before = deque.len();
        let info = opened
            .capture
            .read_from_device_to_deque(deque)
            .map_err(err)?;
        if info.flags.silent {
            // AUDCLNT_BUFFERFLAGS_SILENT: the buffer content must be treated as silence.
            for b in deque.iter_mut().skip(before) {
                *b = 0;
            }
        }
    }
    let frames = deque.len() / block;
    if frames == 0 {
        return Ok(false);
    }
    let bytes: Vec<u8> = deque.drain(..frames * block).collect();
    let mut mono = Vec::with_capacity(frames);
    for frame in bytes.chunks_exact(block) {
        let mut acc = 0.0f32;
        for ch in frame.chunks_exact(4) {
            acc += f32::from_le_bytes([ch[0], ch[1], ch[2], ch[3]]);
        }
        mono.push(acc / opened.channels as f32);
    }
    tx.send(Chunk {
        samples: mono,
        rate: opened.rate,
    })
    .map(|()| true)
    .map_err(|_| "processor gone".to_string())
}

fn default_render_id() -> Option<String> {
    DeviceEnumerator::new()
        .ok()?
        .get_default_device(&Direction::Render)
        .ok()?
        .get_id()
        .ok()
}

/// `names`: the configured app list when capturing a process target (`None`
/// for plain full loopback) — lets the loop re-target as apps come and go.
fn capture_thread(
    mode: Mode,
    names: Option<Vec<String>>,
    tx: ChunkSender,
    on_error: ErrorFn,
    stop: Arc<AtomicBool>,
    ready: mpsc::Sender<Result<String, String>>,
) {
    let _ = wasapi::initialize_mta().ok();

    // First open reports to the caller; later failures retry in place.
    let (mut mode, first) = match open(&mode) {
        Ok(o) => (mode, Ok(o)),
        Err(e) => {
            if let Mode::Process { name, .. } = mode {
                log::warn!(
                    "[meeting] process loopback for {} failed ({}); falling back to full loopback",
                    name,
                    e
                );
                (Mode::Endpoint, open(&Mode::Endpoint))
            } else {
                (Mode::Endpoint, Err(e))
            }
        }
    };
    let mut opened = match first {
        Ok(o) => {
            let desc = match &mode {
                Mode::Endpoint => format!("system loopback ({} Hz, {} ch)", o.rate, o.channels),
                Mode::Process { pid, name } => {
                    format!("process loopback: {} (pid {}, {} Hz)", name, pid, o.rate)
                }
            };
            let _ = ready.send(Ok(desc));
            Some(o)
        }
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };

    let mut deque: VecDeque<u8> = VecDeque::new();
    let mut last_device_check = Instant::now();
    let mut last_packet = Instant::now();
    let mut last_full_retarget = Instant::now();
    while !stop.load(Ordering::SeqCst) {
        let Some(o) = opened.as_ref() else {
            // Reopen after an error (device unplugged, default device changed…).
            std::thread::sleep(Duration::from_secs(1));
            match open(&mode) {
                Ok(o) => {
                    match &mode {
                        Mode::Endpoint => log::info!("[meeting] system capture (re)opened: full loopback"),
                        Mode::Process { pid, name } => {
                            log::info!("[meeting] system capture (re)opened: {} (pid {})", name, pid)
                        }
                    }
                    opened = Some(o);
                    last_packet = Instant::now();
                }
                Err(e) => {
                    if let Mode::Process { .. } = mode {
                        // The target app likely exited; follow the speakers instead.
                        log::warn!("[meeting] process loopback reopen failed ({}); using full loopback", e);
                        mode = Mode::Endpoint;
                    }
                }
            }
            continue;
        };

        // Silent endpoints never signal; the timeout just lets us poll `stop`.
        let _ = o.event.wait_for_event(100);
        match drain(o, &mut deque, &tx) {
            Ok(true) => last_packet = Instant::now(),
            Ok(false) => {}
            Err(e) => {
                if e == "processor gone" {
                    break;
                }
                log::warn!("[meeting] system capture error: {}", e);
                on_error(format!("System audio capture error: {} (reconnecting)", e));
                let _ = o.client.stop_stream();
                opened = None;
                deque.clear();
                continue;
            }
        }

        if last_device_check.elapsed() <= Duration::from_secs(3) {
            continue;
        }
        last_device_check = Instant::now();

        // Follow default-output changes (e.g. switching to a headset) in endpoint mode.
        if matches!(mode, Mode::Endpoint) {
            let current = default_render_id();
            if current.is_some() && current != o.device_id {
                log::info!("[meeting] default output device changed; reopening loopback");
                let _ = o.client.stop_stream();
                opened = None;
                deque.clear();
                continue;
            }
        }

        // Process-target re-evaluation: the target exited, went quiet while
        // another listed app is playing, or (full-loopback fallback) a listed
        // app has started playing since.
        let Some(names) = names.as_deref() else {
            continue;
        };
        let decision = match &mode {
            Mode::Process { pid, name } => {
                let alive = process_alive(*pid, name);
                if !alive
                    || (last_packet.elapsed() >= RETARGET_IDLE
                        && last_full_retarget.elapsed() >= RETARGET_IDLE)
                {
                    last_full_retarget = Instant::now();
                    decide_retarget(Some(*pid), alive, find_target(names))
                } else {
                    Retarget::Keep
                }
            }
            Mode::Endpoint => {
                if last_full_retarget.elapsed() >= RETARGET_FALLBACK_INTERVAL {
                    last_full_retarget = Instant::now();
                    decide_retarget(None, false, find_target(names))
                } else {
                    Retarget::Keep
                }
            }
        };
        let next_mode = match decision {
            Retarget::Keep => continue,
            Retarget::Switch { pid, name } => {
                log::info!("[meeting] process loopback: switching to {} (pid {})", name, pid);
                Mode::Process { pid, name }
            }
            Retarget::Endpoint => {
                log::warn!("[meeting] process loopback target exited; using full loopback");
                Mode::Endpoint
            }
        };
        let _ = o.client.stop_stream();
        mode = next_mode;
        opened = None;
        deque.clear();
    }
    if let Some(o) = opened {
        let _ = o.client.stop_stream();
    }
}

pub fn start_system(
    target: &SystemTarget,
    tx: ChunkSender,
    on_error: ErrorFn,
) -> Result<SourceHandle, String> {
    let names = match target {
        SystemTarget::All => None,
        SystemTarget::Processes(names) => Some(names.clone()),
    };
    let mode = match target {
        SystemTarget::All => Mode::Endpoint,
        SystemTarget::Processes(names) => match find_target(names) {
            Some(t) => Mode::Process {
                pid: t.pid,
                name: t.name,
            },
            None => {
                log::info!(
                    "[meeting] none of {:?} is running; capturing all system audio",
                    names
                );
                Mode::Endpoint
            }
        },
    };
    let stop = Arc::new(AtomicBool::new(false));
    let stop_t = stop.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("meeting-system".into())
        .spawn(move || capture_thread(mode, names, tx, on_error, stop_t, ready_tx))
        .map_err(|e| format!("Failed to spawn system capture thread: {}", e))?;
    match ready_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(desc)) => Ok(SourceHandle::new(desc, stop, thread, None)),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            Err("Timed out opening system audio capture".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(pid: u32, active: bool) -> Option<Target> {
        Some(Target {
            pid,
            name: format!("app{}.exe", pid),
            active,
        })
    }

    #[test]
    fn retarget_decisions() {
        // Target died: another listed app (active or not) → switch; none → full loopback.
        assert_eq!(
            decide_retarget(Some(1), false, t(2, false)),
            Retarget::Switch { pid: 2, name: "app2.exe".into() }
        );
        assert_eq!(decide_retarget(Some(1), false, None), Retarget::Endpoint);
        assert_eq!(decide_retarget(Some(1), false, t(1, false)), Retarget::Endpoint);
        // Live but quiet target: only switch to an app that is actually playing.
        assert_eq!(decide_retarget(Some(1), true, t(2, false)), Retarget::Keep);
        assert_eq!(
            decide_retarget(Some(1), true, t(2, true)),
            Retarget::Switch { pid: 2, name: "app2.exe".into() }
        );
        assert_eq!(decide_retarget(Some(1), true, t(1, true)), Retarget::Keep);
        // Full-loopback fallback: switch once a listed app plays.
        assert_eq!(decide_retarget(None, false, t(3, false)), Retarget::Keep);
        assert_eq!(
            decide_retarget(None, false, t(3, true)),
            Retarget::Switch { pid: 3, name: "app3.exe".into() }
        );
        assert_eq!(decide_retarget(None, false, None), Retarget::Keep);
    }
}
