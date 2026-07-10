/**
 * Image utilities for handling clipboard images with automatic compression
 * Claude API limits: 5MB per image, supports JPEG, PNG, GIF, WebP
 */

import { invoke } from '@tauri-apps/api/core';

export interface ImageData {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  base64Data: string;
  originalSize: number;
  compressedSize: number;
  width: number;
  height: number;
}

// Claude's image size limit (5MB)
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
// Target size for compression (leave some headroom)
const TARGET_SIZE = 4 * 1024 * 1024;
// Claude Agent SDK enforces a 2000x2000px limit and uses sharp for resizing,
// which isn't available in bundled builds — resize on the frontend instead.
const MAX_DIMENSION = 2000;

/**
 * Extract images from clipboard event
 */
export async function getImagesFromClipboard(event: ClipboardEvent): Promise<File[]> {
  const items = event.clipboardData?.items;
  if (!items) return [];

  const imageFiles: File[] = [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        imageFiles.push(file);
      }
    }
  }
  return imageFiles;
}

/**
 * Extract images embedded in rich-text HTML from the clipboard.
 *
 * Some sources (most notably Google Docs) don't put raw image bytes on the OS
 * clipboard — they put `text/html` in which images are `<img>` tags. This
 * pulls those out: `data:` URLs are decoded locally, and remote URLs (e.g.
 * `googleusercontent.com`) are fetched through the Rust backend to sidestep
 * the webview's CORS/CSP restrictions. Failures per-image are logged and
 * skipped so one broken URL doesn't drop the rest.
 */
export async function getImagesFromClipboardHtml(html: string): Promise<File[]> {
  if (!html || !/<img\b/i.test(html)) return [];

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return [];
  }

  const srcs = Array.from(doc.querySelectorAll('img'))
    .map((img) => img.getAttribute('src')?.trim())
    .filter((s): s is string => !!s);

  const files: File[] = [];
  for (const src of srcs) {
    try {
      if (src.startsWith('data:')) {
        const file = dataUrlToImageFile(src);
        if (file) files.push(file);
      } else if (/^https?:\/\//i.test(src)) {
        const fetched = await invoke<{ base64: string; mediaType: string }>(
          'fetch_remote_image',
          { url: src }
        );
        files.push(base64ToImageFile(fetched.base64, fetched.mediaType));
      }
      // Other schemes (blob:, cid:, file:) aren't reachable from here — skip.
    } catch (err) {
      console.warn('[image] Failed to load clipboard HTML image', src, err);
    }
  }
  return files;
}

/** Decode a base64 image (no data-URL prefix) into a File. */
function base64ToImageFile(base64: string, mediaType: string): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], 'clipboard-image', { type: mediaType });
}

/** Decode a `data:` URL into an image File, or null if it isn't an image. */
function dataUrlToImageFile(dataUrl: string): File | null {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match) return null;

  const mediaType = match[1] || 'image/png';
  if (!mediaType.startsWith('image/')) return null;

  if (match[2]) {
    return base64ToImageFile(match[3], mediaType);
  }
  // Non-base64 (percent-encoded) data URL, e.g. inline SVG.
  const bytes = new TextEncoder().encode(decodeURIComponent(match[3]));
  return new File([bytes], 'clipboard-image', { type: mediaType });
}

/**
 * Extract images from drag/drop event
 */
export function getImagesFromDrop(event: DragEvent): File[] {
  const files = event.dataTransfer?.files;
  if (!files) return [];

  const imageFiles: File[] = [];
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      imageFiles.push(file);
    }
  }
  return imageFiles;
}

/**
 * Load an image file into an HTMLImageElement
 */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/**
 * Calculate new dimensions while maintaining aspect ratio
 */
function calculateDimensions(
  width: number,
  height: number,
  maxDim: number
): { width: number; height: number } {
  if (width <= maxDim && height <= maxDim) {
    return { width, height };
  }

  const ratio = Math.min(maxDim / width, maxDim / height);
  return {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
  };
}

/**
 * Compress image using canvas with quality reduction
 */
async function compressImage(
  img: HTMLImageElement,
  targetSize: number,
  originalFile: File
): Promise<{ blob: Blob; width: number; height: number }> {
  // First, resize if dimensions are too large
  const dims = calculateDimensions(img.width, img.height, MAX_DIMENSION);

  const canvas = document.createElement('canvas');
  canvas.width = dims.width;
  canvas.height = dims.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');

  // Use high-quality image scaling
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, dims.width, dims.height);

  // For PNGs with transparency, try PNG first, then fall back to JPEG
  const isTransparent = originalFile.type === 'image/png' || originalFile.type === 'image/webp';

  // Try different quality levels to get under target size
  const qualities = [0.92, 0.85, 0.75, 0.65, 0.5, 0.35, 0.2];
  const outputType = isTransparent ? 'image/png' : 'image/jpeg';

  // For PNG, we can't adjust quality the same way, so we'll resize more aggressively
  if (outputType === 'image/png') {
    let blob = await canvasToBlob(canvas, 'image/png', 1);
    if (blob.size <= targetSize) {
      return { blob, width: dims.width, height: dims.height };
    }

    // PNG too large, convert to JPEG (losing transparency)
    console.log('[image] PNG too large, converting to JPEG');
  }

  // Try JPEG with decreasing quality
  for (const quality of qualities) {
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    if (blob.size <= targetSize) {
      console.log(`[image] Compressed to ${(blob.size / 1024).toFixed(1)}KB at quality ${quality}`);
      return { blob, width: dims.width, height: dims.height };
    }
  }

  // If still too large, resize further
  let scale = 0.75;
  while (scale > 0.1) {
    const newWidth = Math.round(dims.width * scale);
    const newHeight = Math.round(dims.height * scale);

    canvas.width = newWidth;
    canvas.height = newHeight;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, newWidth, newHeight);

    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.75);
    if (blob.size <= targetSize) {
      console.log(
        `[image] Compressed to ${(blob.size / 1024).toFixed(1)}KB at ${newWidth}x${newHeight}`
      );
      return { blob, width: newWidth, height: newHeight };
    }

    scale *= 0.75;
  }

  // Last resort: very aggressive compression
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.5);
  return { blob, width: canvas.width, height: canvas.height };
}

/**
 * Convert canvas to blob with specified type and quality
 */
function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to create blob'));
      },
      type,
      quality
    );
  });
}

/**
 * Convert blob to base64 string (without data URL prefix)
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // Remove the data URL prefix (e.g., "data:image/jpeg;base64,")
      const base64 = dataUrl.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Process an image file: compress if needed and convert to base64
 */
export async function processImage(file: File): Promise<ImageData> {
  const originalSize = file.size;
  console.log(
    `[image] Processing ${file.name}: ${(originalSize / 1024).toFixed(1)}KB, type: ${file.type}`
  );

  const img = await loadImage(file);
  console.log(`[image] Original dimensions: ${img.width}x${img.height}`);

  let blob: Blob;
  let width: number;
  let height: number;

  // Check if compression is needed
  const needsCompression =
    originalSize > MAX_IMAGE_SIZE || img.width > MAX_DIMENSION || img.height > MAX_DIMENSION;

  if (needsCompression) {
    console.log('[image] Compression needed');
    const result = await compressImage(img, TARGET_SIZE, file);
    blob = result.blob;
    width = result.width;
    height = result.height;
  } else {
    // No compression needed, but we might still want to convert format
    // GIFs should stay as GIFs, others can stay as-is
    blob = file;
    width = img.width;
    height = img.height;
  }

  // Clean up object URL
  URL.revokeObjectURL(img.src);

  const base64Data = await blobToBase64(blob);
  const compressedSize = blob.size;

  // Determine the actual media type from the blob
  let mediaType: ImageData['mediaType'];
  switch (blob.type) {
    case 'image/jpeg':
      mediaType = 'image/jpeg';
      break;
    case 'image/png':
      mediaType = 'image/png';
      break;
    case 'image/gif':
      mediaType = 'image/gif';
      break;
    case 'image/webp':
      mediaType = 'image/webp';
      break;
    default:
      // Default to JPEG if unknown
      mediaType = 'image/jpeg';
  }

  console.log(
    `[image] Final: ${(compressedSize / 1024).toFixed(1)}KB, ${width}x${height}, ${mediaType}`
  );

  return {
    mediaType,
    base64Data,
    originalSize,
    compressedSize,
    width,
    height,
  };
}

/**
 * Process multiple images
 */
export async function processImages(files: File[]): Promise<ImageData[]> {
  return Promise.all(files.map(processImage));
}

/**
 * Create a data URL for displaying an image preview
 */
export function createPreviewUrl(imageData: ImageData): string {
  return `data:${imageData.mediaType};base64,${imageData.base64Data}`;
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
