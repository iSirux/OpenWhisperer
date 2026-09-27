//! Downscale agent tool-result images to display size.
//!
//! An agent that `Read`s an image file gets it back as a full-resolution base64
//! block in its tool result, and the app used to store every one verbatim in the
//! session's message list. A session whose subagents read a few hundred reference
//! images reached 142 MB, and every save then pushed all of it through IPC,
//! re-serialized it for the content hash and rewrote it to disk. The app only ever
//! *displays* these images (the agent already consumed the original), so they are
//! re-encoded to a display-sized JPEG — PNG when genuinely transparent — as they
//! arrive from the sidecar, and sessions persisted before this are shrunk once on
//! load. Subagent results get a thumbnail: they render inside a collapsed task block.
//!
//! User-attached prompt images are never touched — those are the user's own input.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::DynamicImage;

pub struct ImageBudget {
    /// Longest edge after downscaling.
    max_dim: u32,
    /// Images whose base64 payload is already at most this long are left alone —
    /// re-encoding them would cost CPU and quality for no meaningful saving.
    keep_below_b64_len: usize,
}

impl ImageBudget {
    /// Whether an image is worth re-encoding. Known dimensions within budget mean
    /// it was already display-sized (by us — the sidecar never sends dimensions),
    /// and a JPEG re-encode would only lose quality again, so it's left alone even
    /// if its payload is still over the byte threshold.
    pub fn wants(&self, base64_len: usize, dims: (Option<u32>, Option<u32>)) -> bool {
        if let (Some(w), Some(h)) = dims {
            if w <= self.max_dim && h <= self.max_dim {
                return false;
            }
        }
        base64_len > self.keep_below_b64_len
    }
}

// Tool-result images render at most 400px tall (`.tool-result-image`), so 800px
// stays sharp on 2x displays.
const MAIN_AGENT: ImageBudget = ImageBudget {
    max_dim: 800,
    keep_below_b64_len: 160_000,
};

const SUBAGENT: ImageBudget = ImageBudget {
    max_dim: 384,
    keep_below_b64_len: 48_000,
};

const JPEG_QUALITY: u8 = 75;

/// Budget for a tool result: subagent (child) results get a thumbnail.
pub fn budget_for(is_subagent: bool) -> &'static ImageBudget {
    if is_subagent {
        &SUBAGENT
    } else {
        &MAIN_AGENT
    }
}

pub struct ShrunkImage {
    pub media_type: &'static str,
    pub base64_data: String,
    pub width: u32,
    pub height: u32,
}

/// Re-encode one base64 image within `budget`. Returns `None` when the image is
/// already small enough, can't be decoded (e.g. SVG), or re-encoding wouldn't
/// make it smaller — callers keep the original in all of those cases.
pub fn shrink(
    base64_data: &str,
    dims: (Option<u32>, Option<u32>),
    budget: &ImageBudget,
) -> Option<ShrunkImage> {
    if !budget.wants(base64_data.len(), dims) {
        return None;
    }
    let bytes = STANDARD.decode(base64_data.trim()).ok()?;
    let decoded = image::load_from_memory(&bytes).ok()?;
    let img = if decoded.width() > budget.max_dim || decoded.height() > budget.max_dim {
        decoded.thumbnail(budget.max_dim, budget.max_dim)
    } else {
        decoded
    };

    let mut buf = Vec::new();
    let media_type = if is_transparent(&img) {
        img.write_with_encoder(PngEncoder::new(&mut buf)).ok()?;
        "image/png"
    } else {
        let rgb = DynamicImage::ImageRgb8(img.to_rgb8());
        rgb.write_with_encoder(JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY))
            .ok()?;
        "image/jpeg"
    };

    let encoded = STANDARD.encode(&buf);
    if encoded.len() >= base64_data.len() {
        return None;
    }
    Some(ShrunkImage {
        media_type,
        base64_data: encoded,
        width: img.width(),
        height: img.height(),
    })
}

/// Whether any pixel is actually see-through. Many PNG screenshots carry an alpha
/// channel that is fully opaque; those can safely become JPEG.
fn is_transparent(img: &DynamicImage) -> bool {
    img.color().has_alpha() && img.to_rgba8().pixels().any(|p| p[3] < 255)
}

/// Shrink the images of a sidecar tool-result payload in place
/// (`[{ mediaType, base64Data, width?, height? }]`).
pub fn shrink_json_images(images: &mut [serde_json::Value], is_subagent: bool) -> usize {
    let budget = budget_for(is_subagent);
    let mut shrunk = 0;
    for img in images.iter_mut() {
        let Some(obj) = img.as_object_mut() else {
            continue;
        };
        let dim = |key: &str| obj.get(key).and_then(|v| v.as_u64()).map(|v| v as u32);
        let dims = (dim("width"), dim("height"));
        let Some(result) = obj
            .get("base64Data")
            .and_then(|v| v.as_str())
            .and_then(|data| shrink(data, dims, budget))
        else {
            continue;
        };
        obj.insert("mediaType".into(), result.media_type.into());
        obj.insert("base64Data".into(), result.base64_data.into());
        obj.insert("width".into(), result.width.into());
        obj.insert("height".into(), result.height.into());
        shrunk += 1;
    }
    shrunk
}

/// Shrink the tool-result images of a session held as raw JSON (archive data).
pub fn shrink_session_value(session: &mut serde_json::Value) -> usize {
    let Some(messages) = session.get_mut("messages").and_then(|m| m.as_array_mut()) else {
        return 0;
    };
    par_sum(messages, |msg| {
        if msg.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
            return 0;
        }
        let is_subagent = msg
            .get("parentToolUseId")
            .is_some_and(|p| p.as_str().is_some_and(|s| !s.is_empty()));
        match msg.get_mut("images").and_then(|i| i.as_array_mut()) {
            Some(images) => shrink_json_images(images, is_subagent),
            None => 0,
        }
    })
}

/// Run `f` over `items` on all cores and sum the results. Shrinking an old
/// session means decoding hundreds of images; doing that serially would stall
/// session restore for many seconds.
pub fn par_sum<T: Send>(items: &mut [T], f: impl Fn(&mut T) -> usize + Sync) -> usize {
    if items.is_empty() {
        return 0;
    }
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(items.len());
    let chunk = items.len().div_ceil(threads);
    let f = &f;
    std::thread::scope(|scope| {
        let handles: Vec<_> = items
            .chunks_mut(chunk)
            .map(|part| scope.spawn(move || part.iter_mut().map(f).sum::<usize>()))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or(0)).sum()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage, Rgba, RgbaImage};

    const NO_DIMS: (Option<u32>, Option<u32>) = (None, None);

    fn png_b64(img: DynamicImage) -> String {
        let mut buf = Vec::new();
        img.write_with_encoder(PngEncoder::new(&mut buf)).unwrap();
        STANDARD.encode(&buf)
    }

    /// Noisy content so the PNG is large (flat colors compress to nothing).
    fn noisy_rgb(w: u32, h: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |x, y| {
            let v = (x.wrapping_mul(2654435761) ^ y.wrapping_mul(40503)) as u8;
            Rgb([v, v.wrapping_mul(3), v.wrapping_add(y as u8)])
        }))
    }

    #[test]
    fn small_images_are_left_alone() {
        let b64 = png_b64(noisy_rgb(8, 8));
        assert!(shrink(&b64, NO_DIMS, budget_for(false)).is_none());
    }

    #[test]
    fn large_opaque_image_becomes_display_sized_jpeg() {
        let b64 = png_b64(noisy_rgb(2000, 1000));
        let out = shrink(&b64, NO_DIMS, budget_for(false)).expect("should shrink");
        assert_eq!(out.media_type, "image/jpeg");
        assert_eq!((out.width, out.height), (800, 400));
        assert!(out.base64_data.len() < b64.len());
    }

    #[test]
    fn subagent_images_get_a_thumbnail() {
        let b64 = png_b64(noisy_rgb(2000, 1000));
        let out = shrink(&b64, NO_DIMS, budget_for(true)).expect("should shrink");
        assert_eq!(out.width, 384);
    }

    #[test]
    fn transparency_is_preserved_as_png() {
        let img = DynamicImage::ImageRgba8(RgbaImage::from_fn(1500, 1500, |x, y| {
            let v = (x.wrapping_mul(2654435761) ^ y.wrapping_mul(40503)) as u8;
            Rgba([v, v, v, if x < 10 { 0 } else { 255 }])
        }));
        let b64 = png_b64(img);
        let out = shrink(&b64, NO_DIMS, budget_for(false)).expect("should shrink");
        assert_eq!(out.media_type, "image/png");
    }

    #[test]
    fn undecodable_data_is_kept() {
        let junk = "A".repeat(300_000);
        assert!(shrink(&junk, NO_DIMS, budget_for(false)).is_none());
    }

    #[test]
    fn session_value_shrinks_only_tool_results() {
        let big = png_b64(noisy_rgb(2000, 1000));
        let mut session = serde_json::json!({
            "messages": [
                { "type": "user", "images": [{ "mediaType": "image/png", "base64Data": big }] },
                { "type": "tool_result", "parentToolUseId": "toolu_1",
                  "images": [{ "mediaType": "image/png", "base64Data": big }] },
            ]
        });
        assert_eq!(shrink_session_value(&mut session), 1);
        let msgs = session["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["images"][0]["base64Data"].as_str().unwrap().len(), big.len());
        assert_eq!(msgs[1]["images"][0]["width"], 384);
    }

    #[test]
    fn already_display_sized_images_are_not_reencoded() {
        // Over the byte threshold, but its recorded dimensions say it was already
        // shrunk — re-encoding would only compound JPEG loss on every load.
        let b64 = png_b64(noisy_rgb(800, 400));
        assert!(budget_for(false).wants(b64.len(), NO_DIMS));
        assert!(shrink(&b64, (Some(800), Some(400)), budget_for(false)).is_none());
    }
}
