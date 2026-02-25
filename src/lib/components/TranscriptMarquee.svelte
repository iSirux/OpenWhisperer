<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';

  let transcript = $state('');
  let unlistenTranscript: UnlistenFn | null = null;
  let unlistenRecording: UnlistenFn | null = null;

  // Reset function to clear transcript
  function resetTranscript() {
    console.log('[TranscriptMarquee] resetting transcript');
    transcript = '';
  }

  onMount(async () => {
    // Reset transcript on mount (when overlay opens / recording starts)
    resetTranscript();

    // Also reset when recording starts (set up listener FIRST to catch early events)
    unlistenRecording = await listen<{ state: string }>('recording-state', (event) => {
      if (event.payload.state === 'recording') {
        resetTranscript();
      }
    });

    // Listen for real-time transcript updates
    unlistenTranscript = await listen<{ text: string }>('realtime-transcript', (event) => {
      const text = event.payload?.text ?? '';
      console.log('[TranscriptMarquee] received', { text, prevTranscript: transcript });
      // Always update transcript - empty string clears it
      transcript = text;
    });
  });

  onDestroy(() => {
    unlistenTranscript?.();
    unlistenRecording?.();
    // Clear on unmount too
    transcript = '';
  });
</script>

<div class="transcript-marquee">
  <span class="transcript-text">
    {transcript || 'Listening...'}
  </span>
</div>

<style>
  .transcript-marquee {
    width: 100%;
    height: 24px;
    overflow: hidden;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 4px;
    padding: 0 8px;
    display: flex;
    align-items: center;
    justify-content: flex-end; /* Always show rightmost content */
    position: relative;
  }

  .transcript-text {
    white-space: nowrap;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.9);
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
  }

  /* Fade left edge to indicate more content */
  .transcript-marquee::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 30px;
    background: linear-gradient(to right, rgba(0, 0, 0, 0.4), transparent);
    pointer-events: none;
    z-index: 1;
  }
</style>
