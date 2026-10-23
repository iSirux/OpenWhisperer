<script lang="ts">
  import '../styles/app.css';
  import { onMount } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { invoke } from '@tauri-apps/api/core';
  import { initLogger } from '$lib/utils/logger';

  // Prevent browser back/forward navigation from causing full page reloads
  // This app uses internal state for navigation, not URL-based routing
  onMount(() => {
    // Initialise file logging — must be first so all subsequent logs are captured
    initLogger();

    // Replace current history state to prevent back navigation
    history.replaceState({ ...history.state, preventNav: true }, '');

    // Listen for popstate (back/forward button) and prevent navigation
    const handlePopState = (event: PopStateEvent) => {
      // Push the current state back to prevent navigation
      history.pushState({ ...history.state, preventNav: true }, '', window.location.href);
    };

    window.addEventListener('popstate', handlePopState);

    // Global click handler to open external links in the default browser
    const handleLinkClick = async (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const anchor = target.closest('a');

      if (!anchor) return;

      const href = anchor.getAttribute('href');
      if (!href) return;

      // Check if it's an external URL (http/https)
      if (href.startsWith('http://') || href.startsWith('https://')) {
        event.preventDefault();
        event.stopPropagation();
        try {
          await openUrl(href);
        } catch (err) {
          console.error('Failed to open URL in browser:', err);
        }
        return;
      }

      // Other markdown links: local file paths (relative ones resolve against
      // the session cwd from the enclosing [data-link-base]) or other schemes.
      // Never let them navigate the webview.
      if (!anchor.hasAttribute('data-external') || href.startsWith('#')) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        const isLocal = /^file:/i.test(href) || /^[a-z]:[\\/]/i.test(href) || !/^[a-z][a-z0-9+.-]*:/i.test(href);
        if (isLocal) {
          const base = anchor.closest<HTMLElement>('[data-link-base]')?.dataset.linkBase;
          await invoke('open_local_path', { path: href, base: base ?? null });
        } else {
          await openUrl(href);
        }
      } catch (err) {
        console.error('Failed to open link:', err);
      }
    };

    document.addEventListener('click', handleLinkClick);

    // Global click handler for the copy buttons injected into markdown code
    // blocks by renderMarkdown (they live in {@html} content, so no Svelte handlers)
    const handleCodeCopyClick = async (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const button = target.closest('.code-copy-button') as HTMLButtonElement | null;
      if (!button) return;

      const code = button.closest('.code-block-wrapper')?.querySelector('pre code');
      if (!code) return;

      try {
        await navigator.clipboard.writeText((code.textContent ?? '').replace(/\n$/, ''));
      } catch (err) {
        console.error('Failed to copy code block:', err);
        return;
      }

      button.classList.add('copied');
      window.clearTimeout(Number(button.dataset.copiedTimeout));
      button.dataset.copiedTimeout = String(
        window.setTimeout(() => button.classList.remove('copied'), 2000)
      );
    };

    document.addEventListener('click', handleCodeCopyClick);

    // Liveness ping for the backend's hung-renderer watchdog (webview_recovery.rs):
    // a visible window that stops beating for minutes gets its renderer reloaded.
    const heartbeat = () => invoke('webview_heartbeat').catch(() => {});
    heartbeat();
    const heartbeatTimer = window.setInterval(heartbeat, 10_000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') heartbeat();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      document.removeEventListener('click', handleLinkClick);
      document.removeEventListener('click', handleCodeCopyClick);
      window.clearInterval(heartbeatTimer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  });

  // Also intercept SvelteKit's navigation system
  beforeNavigate(({ cancel, to, from }) => {
    // Allow navigation to different routes (settings modal, overlay, etc.)
    // but prevent back/forward browser navigation that would reload the app
    if (to?.url.pathname === from?.url.pathname) {
      cancel();
    }
  });
</script>

<slot />
