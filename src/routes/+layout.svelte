<script lang="ts">
  import '../styles/app.css';
  import { onMount } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import { openUrl } from '@tauri-apps/plugin-opener';
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
      }
    };

    document.addEventListener('click', handleLinkClick);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      document.removeEventListener('click', handleLinkClick);
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
