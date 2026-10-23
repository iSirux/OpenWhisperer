//! Reload a window whose WebView2 renderer process died.
//!
//! When the renderer crashes, WebView2 leaves the window blank white and does
//! nothing else — while the Rust process and the sidecar keep running, so the
//! agents carry on working behind an unusable window. Crashpad dumps show these
//! as access violations inside `msedge.dll` (a WebView2 runtime fault, not ours),
//! so the job here is recovery: reload the page, and the frontend's startup path
//! restores sessions from disk and reattaches to queries still running in the
//! sidecar (`sdkSessions.reattachRunningSessions`).
//!
//! Only a full renderer exit is reloaded by the crash handler. WebView2's own
//! "unresponsive" signal is just logged: it only fires on user input, and a long
//! synchronous task may still finish. A dead browser process can't be reloaded
//! at all (the whole webview is gone).
//!
//! A renderer can also hang without ever exiting — seen when the machine ran out
//! of commit memory (an agent's runaway `esbuild` took 59 GB): the page stopped
//! mid-allocation, no ProcessFailed event fired, and the window stayed frozen
//! while agents kept running. So each page also sends a heartbeat
//! (`webview_heartbeat`, every 10 s) and a watchdog thread kills the renderer
//! when a *visible* window has gone silent for [`STALE_AFTER`]; the crash
//! handler above then sees a renderer exit and reloads the page. Hidden or
//! minimized windows (throttled timers) and system sleep don't count as silence.
//! Relaunching the app while it's frozen runs the same recovery right away
//! ([`probe_after_relaunch`]) — single-instance would otherwise just re-focus
//! the dead window.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{ProcessFailedEventHandler, ProcessInfosChangedEventHandler};

/// A page that crashes again right after loading would otherwise reload forever.
const MAX_RELOADS: usize = 3;
const RELOAD_WINDOW: Duration = Duration::from_secs(120);

/// Pages beat every 10 s; an occluded window's timers can be throttled to one
/// wake-up a minute, so this leaves a wide margin before calling a page hung.
const STALE_AFTER: Duration = Duration::from_secs(180);
const WATCHDOG_TICK: Duration = Duration::from_secs(10);
/// A tick arriving this late means the machine was asleep, not the page hung.
const SLEEP_GAP: Duration = Duration::from_secs(40);
/// Kill attempts without a heartbeat in between before the watchdog gives up.
const MAX_KILLS: u32 = 3;
/// After a relaunch shows the window, a live page beats within ~10 s.
#[cfg_attr(debug_assertions, allow(dead_code))] // single-instance is release-only
const RELAUNCH_GRACE: Duration = Duration::from_secs(20);

pub fn install(window: &WebviewWindow) {
    let label = window.label().to_string();
    match window.hwnd() {
        Ok(hwnd) => watchdog().lock().register(&label, hwnd.0 as isize, Instant::now()),
        Err(e) => log::warn!("[webview] No HWND for '{}', hang watchdog disabled for it: {}", label, e),
    }
    let result = window.with_webview(move |webview| {
        // SAFETY: plain WebView2 COM calls on the webview's own (UI) thread,
        // which is where `with_webview` runs this closure.
        let registered = unsafe {
            webview.controller().CoreWebView2().and_then(|core| {
                let mut token = 0i64;
                core.add_ProcessFailed(&failed_handler(label.clone()), &mut token)
            })
        };
        match registered {
            Ok(()) => log::info!("[webview] Crash recovery installed for '{}'", label),
            Err(e) => log::warn!("[webview] Could not install crash recovery for '{}': {}", label, e),
        }
        // All windows share one environment; track its renderer pids once.
        if label == "main" {
            // SAFETY: as above.
            if let Err(e) = unsafe { track_renderers(&webview.environment()) } {
                log::warn!("[webview] Could not track renderer processes: {}", e);
            }
        }
    });
    if let Err(e) = result {
        log::warn!("[webview] with_webview failed: {}", e);
    }
    start_watchdog();
}

/// A page is alive. Called from the `webview_heartbeat` command.
pub fn heartbeat(label: &str) {
    watchdog().lock().beat(label, Instant::now());
}

/// Another instance was launched — the user may be relaunching because the
/// window is frozen. The window was just shown (so its timers are running); if
/// it doesn't beat within [`RELAUNCH_GRACE`], recover now instead of waiting
/// out [`STALE_AFTER`].
#[cfg_attr(debug_assertions, allow(dead_code))] // single-instance is release-only
pub fn probe_after_relaunch() {
    let asked_at = Instant::now();
    std::thread::spawn(move || {
        std::thread::sleep(RELAUNCH_GRACE);
        let silent = watchdog()
            .lock()
            .windows
            .get("main")
            .is_some_and(|w| !w.tracker.beat_since(asked_at));
        if silent {
            log::error!(
                "[webview] App relaunched while 'main' sent no heartbeat for {}s after being shown — recovering",
                RELAUNCH_GRACE.as_secs()
            );
            kill_renderers();
        }
    });
}

#[derive(Default)]
struct Watchdog {
    windows: HashMap<String, WatchedWindow>,
    renderer_pids: Vec<u32>,
}

struct WatchedWindow {
    hwnd: isize,
    tracker: BeatTracker,
}

impl Watchdog {
    fn register(&mut self, label: &str, hwnd: isize, now: Instant) {
        self.windows
            .insert(label.to_string(), WatchedWindow { hwnd, tracker: BeatTracker::new(now) });
    }

    fn beat(&mut self, label: &str, now: Instant) {
        if let Some(w) = self.windows.get_mut(label) {
            if w.tracker.kills > 0 {
                log::info!("[webview] '{}' is beating again after recovery", label);
            }
            w.tracker.beat(now);
        }
    }
}

fn watchdog() -> &'static Mutex<Watchdog> {
    static WATCHDOG: OnceLock<Mutex<Watchdog>> = OnceLock::new();
    WATCHDOG.get_or_init(Default::default)
}

/// Heartbeat bookkeeping for one window — pure, so the timing rules are testable.
struct BeatTracker {
    /// `None` until the page's first beat: a page that never beat is still
    /// loading (or predates the heartbeat), and isn't judged.
    last_beat: Option<Instant>,
    /// Silence is measured from here: the last beat, or the last moment the
    /// silence was excused (hidden window, sleep) or acted on.
    since: Instant,
    /// Kills since the last beat.
    kills: u32,
}

impl BeatTracker {
    fn new(now: Instant) -> Self {
        Self { last_beat: None, since: now, kills: 0 }
    }

    fn beat(&mut self, now: Instant) {
        self.last_beat = Some(now);
        self.since = now;
        self.kills = 0;
    }

    fn beat_since(&self, t: Instant) -> bool {
        self.last_beat.is_some_and(|b| b >= t)
    }

    /// Restart the silence clock: the page's timers may legitimately have stalled.
    fn excuse(&mut self, now: Instant) {
        self.since = now;
    }

    /// Whether the page has been silent long enough to kill its renderer. Each
    /// positive answer restarts the clock, so a page that doesn't come back is
    /// retried every [`STALE_AFTER`], at most [`MAX_KILLS`] times.
    fn should_kill(&mut self, now: Instant) -> bool {
        if self.last_beat.is_none()
            || self.kills >= MAX_KILLS
            || now.duration_since(self.since) < STALE_AFTER
        {
            return false;
        }
        self.kills += 1;
        self.since = now;
        true
    }
}

fn start_watchdog() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    std::thread::Builder::new()
        .name("webview-watchdog".into())
        .spawn(|| {
            let mut last_tick = Instant::now();
            loop {
                std::thread::sleep(WATCHDOG_TICK);
                let now = Instant::now();
                let slept = now.duration_since(last_tick) > SLEEP_GAP;
                last_tick = now;

                let mut hung = Vec::new();
                for (label, w) in watchdog().lock().windows.iter_mut() {
                    if slept || !is_shown(w.hwnd) {
                        w.tracker.excuse(now);
                    } else if w.tracker.should_kill(now) {
                        hung.push((label.clone(), w.tracker.kills));
                    }
                }
                for (label, attempt) in hung {
                    log::error!(
                        "[webview] '{}' sent no heartbeat for {}s while visible — page is hung (recovery {}/{})",
                        label, STALE_AFTER.as_secs(), attempt, MAX_KILLS
                    );
                    if cfg!(debug_assertions) {
                        // A paused debugger looks exactly like a hang.
                        log::warn!("[webview] Debug build — not killing the renderer");
                    } else {
                        kill_renderers();
                    }
                }
            }
        })
        .map(|_| ())
        .unwrap_or_else(|e| log::warn!("[webview] Could not start hang watchdog: {}", e));
}

fn is_shown(hwnd: isize) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindowVisible};
    let hwnd = hwnd as windows_sys::Win32::Foundation::HWND;
    // SAFETY: read-only window-state queries; a stale HWND just returns false.
    unsafe { IsWindowVisible(hwnd) != 0 && IsIconic(hwnd) == 0 }
}

/// Keep [`Watchdog::renderer_pids`] current, so a hang can be recovered from
/// the watchdog thread without touching the (possibly stuck) UI thread.
unsafe fn track_renderers(env: &ICoreWebView2Environment) -> windows_core::Result<()> {
    let env8: ICoreWebView2Environment8 = windows_core::Interface::cast(env)?;
    store_renderer_pids(&env8);
    let mut token = 0i64;
    env8.add_ProcessInfosChanged(
        &ProcessInfosChangedEventHandler::create(Box::new(|sender, _| {
            if let Some(env) = sender {
                store_renderer_pids(&windows_core::Interface::cast(&env)?);
            }
            Ok(())
        })),
        &mut token,
    )
}

fn store_renderer_pids(env8: &ICoreWebView2Environment8) {
    // SAFETY: COM reads on the environment, from its UI thread.
    let pids = unsafe {
        env8.GetProcessInfos().map(|infos| {
            let mut count = 0u32;
            let _ = infos.Count(&mut count);
            (0..count)
                .filter_map(|i| infos.GetValueAtIndex(i).ok())
                .filter_map(|info| {
                    let mut kind = COREWEBVIEW2_PROCESS_KIND::default();
                    let mut pid = 0i32;
                    info.Kind(&mut kind).ok()?;
                    info.ProcessId(&mut pid).ok()?;
                    (kind == COREWEBVIEW2_PROCESS_KIND_RENDERER).then_some(pid as u32)
                })
                .collect::<Vec<_>>()
        })
    };
    match pids {
        Ok(pids) => watchdog().lock().renderer_pids = pids,
        Err(e) => log::warn!("[webview] GetProcessInfos failed: {}", e),
    }
}

/// Terminate every renderer of the app's WebView2 environment. Each affected
/// window's crash handler then sees `RENDER_PROCESS_EXITED` and reloads it —
/// which needs the UI thread; if *that* is what's stuck, nothing in-process
/// can help and the log says so.
fn kill_renderers() {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    let pids = watchdog().lock().renderer_pids.clone();
    if pids.is_empty() {
        log::error!("[webview] No known renderer process to kill — cannot recover");
        return;
    }
    // Guard against pid reuse: only ever kill a WebView2 process.
    let webview_pids = webview_process_pids();
    for pid in pids {
        if !webview_pids.contains(&pid) {
            log::warn!("[webview] Renderer pid {} is gone or no longer WebView2 — skipping", pid);
            continue;
        }
        // SAFETY: plain Win32 calls; the handle is closed on every path.
        let killed = unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if handle.is_null() {
                false
            } else {
                let ok = TerminateProcess(handle, 1) != 0;
                CloseHandle(handle);
                ok
            }
        };
        if killed {
            log::warn!("[webview] Killed hung renderer pid {} — expecting a crash-handler reload", pid);
        } else {
            log::error!("[webview] Could not kill renderer pid {}", pid);
        }
    }
}

fn webview_process_pids() -> Vec<u32> {
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
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                if String::from_utf16_lossy(&entry.szExeFile[..len]).eq_ignore_ascii_case("msedgewebview2.exe") {
                    out.push(entry.th32ProcessID);
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    out
}

fn failed_handler(label: String) -> ICoreWebView2ProcessFailedEventHandler {
    let mut reloads = Vec::<Instant>::new();
    ProcessFailedEventHandler::create(Box::new(move |sender, args| {
        let (Some(core), Some(args)) = (sender, args) else {
            return Ok(());
        };
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
        // SAFETY: reading an out-param from the event args WebView2 handed us.
        unsafe { args.ProcessFailedKind(&mut kind)? };
        let (reason, exit_code) = failure_details(&args);

        if kind != COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
            log::warn!(
                "[webview] '{}' process failure kind={} reason={} exit_code={} — not reloading",
                label, kind.0, reason, exit_code
            );
            return Ok(());
        }

        let now = Instant::now();
        reloads.retain(|t| now.duration_since(*t) < RELOAD_WINDOW);
        if reloads.len() >= MAX_RELOADS {
            log::error!(
                "[webview] '{}' renderer crashed again (reason={} exit_code={}) — {} reloads in the last {}s, giving up",
                label, reason, exit_code, reloads.len(), RELOAD_WINDOW.as_secs()
            );
            return Ok(());
        }
        reloads.push(now);
        log::error!(
            "[webview] '{}' renderer process exited (reason={} exit_code={}) — reloading",
            label, reason, exit_code
        );
        // SAFETY: Reload on the CoreWebView2 that raised the event, on its thread.
        if let Err(e) = unsafe { core.Reload() } {
            log::error!("[webview] Reload of '{}' failed: {}", label, e);
        }
        Ok(())
    }))
}

/// Reason + exit code, available from the v2 event args (runtime 1.0.1072+).
fn failure_details(args: &ICoreWebView2ProcessFailedEventArgs) -> (i32, i32) {
    let Ok(args2) = windows_core::Interface::cast::<ICoreWebView2ProcessFailedEventArgs2>(args) else {
        return (-1, -1);
    };
    let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
    let mut exit_code = 0i32;
    // SAFETY: out-param reads on live event args.
    unsafe {
        let _ = args2.Reason(&mut reason);
        let _ = args2.ExitCode(&mut exit_code);
    }
    (reason.0, exit_code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_judges_a_page_that_never_beat() {
        let t0 = Instant::now();
        let mut t = BeatTracker::new(t0);
        assert!(!t.should_kill(t0 + STALE_AFTER * 10));
    }

    #[test]
    fn kills_after_stale_and_retries_with_a_cap() {
        let t0 = Instant::now();
        let mut t = BeatTracker::new(t0);
        t.beat(t0);
        assert!(!t.should_kill(t0 + STALE_AFTER - Duration::from_secs(1)));
        let mut now = t0 + STALE_AFTER;
        for _ in 0..MAX_KILLS {
            assert!(t.should_kill(now));
            // The clock restarted: no immediate second kill.
            assert!(!t.should_kill(now + Duration::from_secs(1)));
            now += STALE_AFTER;
        }
        assert!(!t.should_kill(now + STALE_AFTER * 5));
        // A beat resets the cap.
        t.beat(now);
        assert!(t.should_kill(now + STALE_AFTER));
    }

    #[test]
    fn excused_silence_does_not_count() {
        let t0 = Instant::now();
        let mut t = BeatTracker::new(t0);
        t.beat(t0);
        t.excuse(t0 + STALE_AFTER * 2);
        assert!(!t.should_kill(t0 + STALE_AFTER * 2 + Duration::from_secs(5)));
        assert!(t.should_kill(t0 + STALE_AFTER * 3));
    }

    #[test]
    fn beat_since_tracks_relaunch_probe() {
        let t0 = Instant::now();
        let mut t = BeatTracker::new(t0);
        assert!(!t.beat_since(t0));
        t.beat(t0 + Duration::from_secs(5));
        assert!(t.beat_since(t0));
        assert!(!t.beat_since(t0 + Duration::from_secs(6)));
    }
}
