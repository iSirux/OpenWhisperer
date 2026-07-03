use base64::Engine;
use enigo::{Enigo, Mouse, Settings};
use xcap::Monitor;

/// Capture a screenshot of the monitor under the cursor (fallback: primary
/// monitor). Returns base64-encoded PNG; the frontend compresses/resizes it
/// for the Claude API via the shared image pipeline.
#[tauri::command]
pub async fn capture_screenshot() -> Result<String, String> {
    tokio::task::spawn_blocking(capture_impl)
        .await
        .map_err(|e| format!("Screenshot task panicked: {}", e))?
}

fn capture_impl() -> Result<String, String> {
    let monitor = pick_monitor()?;
    let image = monitor
        .capture_image()
        .map_err(|e| format!("Failed to capture screen: {}", e))?;

    let mut buf = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut buf, xcap::image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode screenshot: {}", e))?;

    Ok(base64::engine::general_purpose::STANDARD.encode(buf.into_inner()))
}

fn pick_monitor() -> Result<Monitor, String> {
    // Prefer the monitor the cursor is on — that's what the user is looking at
    if let Ok(enigo) = Enigo::new(&Settings::default()) {
        if let Ok((x, y)) = enigo.location() {
            if let Ok(monitor) = Monitor::from_point(x, y) {
                return Ok(monitor);
            }
        }
    }

    let monitors = Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {}", e))?;
    let primary = monitors
        .iter()
        .position(|m| m.is_primary().unwrap_or(false))
        .unwrap_or(0);
    monitors
        .into_iter()
        .nth(primary)
        .ok_or_else(|| "No monitor found".to_string())
}
