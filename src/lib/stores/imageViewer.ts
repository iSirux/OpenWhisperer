import { writable } from 'svelte/store';

export interface ViewedImage {
  src: string;
  alt?: string;
}

/** The image currently shown full-size by `ImageLightbox` (mounted once in the main layout). */
export const viewedImage = writable<ViewedImage | null>(null);

export function openImage(src: string, alt?: string): void {
  viewedImage.set({ src, alt });
}

export function closeImage(): void {
  viewedImage.set(null);
}
