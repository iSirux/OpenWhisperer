<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Overlay from '$lib/components/Overlay.svelte';
  import { settings } from '$lib/stores/settings';
  import { repos } from '$lib/stores/repos';
  import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
  import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
  import { primaryMonitor } from '@tauri-apps/api/window';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';

  let overlayElement: HTMLDivElement;
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  let unlistenMove: UnlistenFn | null = null;
  let unlistenSettings: UnlistenFn | null = null;
  let savePositionTimeout: ReturnType<typeof setTimeout> | null = null;

  let lastWidth = 0;
  let lastHeight = 0;

  async function resizeWindow(width: number, height: number) {
    // Skip if size hasn't changed
    if (width === lastWidth && height === lastHeight) {
      return;
    }
    lastWidth = width;
    lastHeight = height;

    console.log('[overlay] resizeWindow called:', { width, height });
    try {
      const overlayWindow = await WebviewWindow.getByLabel('overlay');
      console.log('[overlay] got window:', !!overlayWindow);
      if (overlayWindow) {
        const newSize = new LogicalSize(Math.ceil(width), Math.ceil(height));
        console.log('[overlay] setting size to:', newSize);
        await overlayWindow.setSize(newSize);
        console.log('[overlay] setSize completed');
      }
    } catch (error) {
      console.error('[overlay] Failed to resize overlay window:', error);
    }
  }

  function measureAndResize() {
    // Measure the actual overlay-window element, not the wrapper
    const overlayWindowEl = document.querySelector('.overlay-window');
    console.log('[overlay] measureAndResize - found element:', !!overlayWindowEl);
    if (overlayWindowEl) {
      const rect = overlayWindowEl.getBoundingClientRect();
      console.log('[overlay] measured rect:', { width: rect.width, height: rect.height, top: rect.top, left: rect.left });

      // Also log the element's scroll dimensions
      const el = overlayWindowEl as HTMLElement;
      console.log('[overlay] scroll dimensions:', { scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight, offsetHeight: el.offsetHeight });

      if (rect.width > 0 && rect.height > 0) {
        resizeWindow(rect.width, rect.height);
      }
    }
  }

  async function loadOrCenterPosition() {
    try {
      const overlayWindow = await WebviewWindow.getByLabel('overlay');
      if (!overlayWindow) return;

      // Check if we have a saved position
      const savedX = $settings.overlay.position_x;
      const savedY = $settings.overlay.position_y;

      if (savedX !== null && savedY !== null) {
        console.log('[overlay] Loading saved position:', savedX, savedY);
        await overlayWindow.setPosition(new PhysicalPosition(savedX, savedY));
      } else {
        // Center at top if no saved position
        const monitor = await primaryMonitor();
        if (monitor) {
          const x = Math.round((monitor.size.width - 380) / 2);
          const y = 20;
          console.log('[overlay] Centering at top:', x, y);
          await overlayWindow.setPosition(new PhysicalPosition(x, y));
        }
      }
    } catch (error) {
      console.error('Failed to set overlay position:', error);
    }
  }

  async function savePosition(x: number, y: number) {
    // Debounce saves to avoid too many writes
    if (savePositionTimeout) {
      clearTimeout(savePositionTimeout);
    }
    savePositionTimeout = setTimeout(async () => {
      try {
        const newSettings = { ...$settings };
        newSettings.overlay = {
          ...newSettings.overlay,
          position_x: x,
          position_y: y,
        };
        await settings.save(newSettings);
        console.log('[overlay] Position saved:', x, y);
      } catch (error) {
        console.error('Failed to save overlay position:', error);
      }
    }, 500);
  }

  async function startDrag(event: MouseEvent) {
    // Don't start drag if clicking on the discard or go buttons
    const target = event.target as HTMLElement;
    if (target.closest('.discard-btn') || target.closest('.go-btn')) {
      return;
    }

    try {
      const overlayWindow = await WebviewWindow.getByLabel('overlay');
      if (overlayWindow) {
        await overlayWindow.startDragging();
      }
    } catch (error) {
      console.error('Failed to start dragging:', error);
    }
  }

  onMount(async () => {
    await settings.load();
    await repos.load();

    // Apply saved theme
    document.documentElement.setAttribute('data-theme', $settings.theme);

    await loadOrCenterPosition();

    // Listen for window move events to save position
    const overlayWindow = await WebviewWindow.getByLabel('overlay');
    if (overlayWindow) {
      unlistenMove = await overlayWindow.onMoved(({ payload: position }) => {
        savePosition(position.x, position.y);
      });
    }

    // Listen for settings changes from main window
    unlistenSettings = await listen('settings-changed', async () => {
      console.log('[overlay] settings-changed event received, reloading settings');
      await settings.load();
      await repos.load();
      document.documentElement.setAttribute('data-theme', $settings.theme);
      setTimeout(measureAndResize, 50);
    });

    // Use ResizeObserver to detect size changes
    resizeObserver = new ResizeObserver((entries) => {
      console.log('[overlay] ResizeObserver triggered, entries:', entries.length);
      measureAndResize();
    });

    // Use MutationObserver to detect DOM changes (elements added/removed)
    mutationObserver = new MutationObserver((mutations) => {
      console.log('[overlay] MutationObserver triggered, mutations:', mutations.length);
      // Multiple resize attempts to catch layout settling
      requestAnimationFrame(measureAndResize);
      setTimeout(measureAndResize, 50);
      setTimeout(measureAndResize, 150);
    });

    // Observe both the wrapper and the actual overlay-window element
    console.log('[overlay] setting up observers, overlayElement:', !!overlayElement);
    if (overlayElement) {
      resizeObserver.observe(overlayElement);
      console.log('[overlay] observing overlayElement');
    }

    const overlayWindowEl = document.querySelector('.overlay-window');
    console.log('[overlay] found .overlay-window:', !!overlayWindowEl);
    if (overlayWindowEl) {
      resizeObserver.observe(overlayWindowEl);
      mutationObserver.observe(overlayWindowEl, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
      console.log('[overlay] observing .overlay-window for resize and mutations');
    }

    // Listen for custom resize events from Overlay component
    window.addEventListener('overlay-content-changed', () => {
      console.log('[overlay] overlay-content-changed event received');
      measureAndResize();
    });

    // Initial resize after a short delay
    setTimeout(measureAndResize, 100);
  });

  onDestroy(() => {
    if (resizeObserver) {
      resizeObserver.disconnect();
    }
    if (mutationObserver) {
      mutationObserver.disconnect();
    }
    if (unlistenMove) {
      unlistenMove();
    }
    if (unlistenSettings) {
      unlistenSettings();
    }
    if (savePositionTimeout) {
      clearTimeout(savePositionTimeout);
    }
    window.removeEventListener('overlay-content-changed', measureAndResize);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay-page" bind:this={overlayElement} onmousedown={startDrag}>
  <Overlay />
</div>

<style>
  :global(html),
  :global(body) {
    background: var(--color-surface) !important;
    margin: 0;
    padding: 0;
    overflow: hidden;
    height: auto;
    min-height: 0;
  }

  .overlay-page {
    display: inline-block;
    cursor: grab;
  }

  .overlay-page:active {
    cursor: grabbing;
  }
</style>
