use base64::Engine;
use serde::Serialize;

/// Safety cap on downloaded image size (before the frontend compresses it).
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedImage {
    pub base64: String,
    pub media_type: String,
}

/// Download a remote image and return it as base64.
///
/// Used when the user pastes rich HTML that embeds images by URL — most
/// notably a page copied from Google Docs, whose `text/html` clipboard payload
/// references images as `<img src="https://…googleusercontent.com/…">` rather
/// than putting raw image bytes on the clipboard. Fetching happens in the
/// backend so it bypasses the webview's CORS/CSP restrictions. Only http(s)
/// URLs are allowed, and only Claude-supported image types are returned.
#[tauri::command]
pub async fn fetch_remote_image(url: String) -> Result<FetchedImage, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("Unsupported URL scheme: {}", url));
    }

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (OpenWhisperer clipboard image fetch)")
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch image: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Image request failed: HTTP {}", resp.status()));
    }

    // Prefer the server-reported content type; fall back to sniffing the bytes.
    let header_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or(s).trim().to_lowercase());

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read image bytes: {}", e))?;

    if bytes.is_empty() {
        return Err("Image response was empty".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!("Image too large: {} bytes", bytes.len()));
    }

    let media_type = header_type
        .filter(|t| is_supported_image(t))
        .or_else(|| sniff_image_type(&bytes).map(|s| s.to_string()))
        .ok_or_else(|| "URL did not return a supported image".to_string())?;

    let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(FetchedImage { base64, media_type })
}

fn is_supported_image(media_type: &str) -> bool {
    matches!(
        media_type,
        "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    )
}

/// Detect the image type from magic bytes; only returns Claude-supported types.
fn sniff_image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 8 && bytes[0..8] == *b"\x89PNG\r\n\x1a\n" {
        Some("image/png")
    } else if bytes.len() >= 3 && bytes[0..3] == *b"\xFF\xD8\xFF" {
        Some("image/jpeg")
    } else if bytes.len() >= 6 && (bytes[0..6] == *b"GIF87a" || bytes[0..6] == *b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes[0..4] == *b"RIFF" && bytes[8..12] == *b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}
