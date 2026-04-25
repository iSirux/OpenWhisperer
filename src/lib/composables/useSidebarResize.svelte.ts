/**
 * Composable for managing sidebar resize functionality
 * Handles drag-to-resize, width constraints, and persistence to settings
 */

import { settings, settingsLoaded } from '$lib/stores/settings';
import { get } from 'svelte/store';

export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 600;
export const DEFAULT_SIDEBAR_WIDTH = 282;

export function useSidebarResize() {
  let width = $state(DEFAULT_SIDEBAR_WIDTH);
  let isResizing = $state(false);
  let initialized = false;
  let unsubscribe: (() => void) | null = null;

  unsubscribe = settingsLoaded.subscribe((loaded) => {
    if (!loaded || initialized) return;
    const savedWidth = get(settings).sidebar_width;
    if (savedWidth && savedWidth >= MIN_SIDEBAR_WIDTH && savedWidth <= MAX_SIDEBAR_WIDTH) {
      width = savedWidth;
    }
    initialized = true;
    unsubscribe?.();
    unsubscribe = null;
  });

  /**
   * Start resize operation
   */
  function startResize(e: MouseEvent) {
    e.preventDefault();
    isResizing = true;
    document.addEventListener('mousemove', handleResize);
    document.addEventListener('mouseup', stopResize);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  /**
   * Handle mouse move during resize
   */
  function handleResize(e: MouseEvent) {
    if (!isResizing) return;
    const newWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, e.clientX));
    width = newWidth;
  }

  /**
   * Stop resize operation and persist width
   */
  function stopResize() {
    isResizing = false;
    document.removeEventListener('mousemove', handleResize);
    document.removeEventListener('mouseup', stopResize);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    // Save the sidebar width to settings
    if (initialized) {
      const currentSettings = get(settings);
      settings.update(s => ({ ...s, sidebar_width: width }));
      settings.save({ ...currentSettings, sidebar_width: width });
    }
  }

  /**
   * Cleanup event listeners (call on destroy)
   */
  function cleanup() {
    document.removeEventListener('mousemove', handleResize);
    document.removeEventListener('mouseup', stopResize);
    unsubscribe?.();
    unsubscribe = null;
  }

  return {
    get width() { return width; },
    get isResizing() { return isResizing; },
    get minWidth() { return MIN_SIDEBAR_WIDTH; },
    get maxWidth() { return MAX_SIDEBAR_WIDTH; },
    startResize,
    cleanup,
  };
}
