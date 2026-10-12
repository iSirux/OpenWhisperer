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
//! Only a full renderer exit is reloaded. An unresponsive renderer may still
//! recover on its own (a long synchronous task), and reloading it would throw
//! away a working page; a dead browser process can't be reloaded at all (the
//! whole webview is gone). Both are just logged.

use std::time::{Duration, Instant};

use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::ProcessFailedEventHandler;

/// A page that crashes again right after loading would otherwise reload forever.
const MAX_RELOADS: usize = 3;
const RELOAD_WINDOW: Duration = Duration::from_secs(120);

pub fn install(window: &WebviewWindow) {
    let label = window.label().to_string();
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
    });
    if let Err(e) = result {
        log::warn!("[webview] with_webview failed: {}", e);
    }
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
