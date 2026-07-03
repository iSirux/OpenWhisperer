/**
 * Recording screenshot utilities.
 *
 * When `audio.capture_screenshot_on_record` is enabled, a screenshot of the
 * monitor under the cursor is captured the moment a recording starts. It rides
 * along on the pending session (or pile item) and is attached to the first
 * prompt as an image — labeled as *potentially* relevant, since the user may
 * have been doing something unrelated while talking.
 */

import { invoke } from '@tauri-apps/api/core';
import { processImage } from '$lib/utils/image';
import type { SdkImageContent } from '$lib/stores/sdkSessions';

/**
 * Appended to prompts that carry a recording screenshot so Claude knows the
 * image is ambient context, not necessarily the subject of the request.
 * (Appended at send time — not shown in the message UI.)
 */
export const SCREENSHOT_PROMPT_NOTICE =
  "[Note: the attached screenshot was captured automatically from the user's screen when they started the voice recording. It may contain relevant context (an error, a design, the thing being discussed), but the user may also have been doing something unrelated while talking — ignore the screenshot if it doesn't relate to the request.]";

/** True if any of the images is an auto-captured recording screenshot. */
export function hasScreenshotImage(images?: SdkImageContent[]): boolean {
  return !!images?.some((img) => img.source === 'screenshot');
}

/**
 * Capture the screen and compress it for the Claude API (≤2000px, ≤5MB) via
 * the shared image pipeline. Returns null on failure — screenshot capture is
 * always best-effort and must never break the recording flow.
 */
export async function captureRecordingScreenshot(): Promise<SdkImageContent | null> {
  try {
    const base64 = await invoke<string>('capture_screenshot');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const file = new File([bytes], 'screenshot.png', { type: 'image/png' });
    const processed = await processImage(file);
    return {
      mediaType: processed.mediaType,
      base64Data: processed.base64Data,
      width: processed.width,
      height: processed.height,
      source: 'screenshot',
    };
  } catch (error) {
    console.error('[screenshot] Capture failed:', error);
    return null;
  }
}
