<script lang="ts" module>
  // One clip plays at a time app-wide: starting another stops the current one.
  let stopCurrent: (() => void) | null = null;
</script>

<script lang="ts">
  /**
   * ▶ button that plays a meeting segment clip (`meeting_read_segment_audio`).
   * The WAV is fetched lazily on first play and released on stop/unmount.
   */
  import { onDestroy } from 'svelte';
  import { meetings } from '$lib/stores/meetings';

  interface Props {
    meetingId: string;
    segId: string | null | undefined;
    size?: 'xs' | 'sm';
    title?: string;
  }

  let { meetingId, segId, size = 'xs', title = 'Play clip' }: Props = $props();

  let state = $state<'idle' | 'loading' | 'playing' | 'error'>('idle');
  let audio: HTMLAudioElement | null = null;
  let url: string | null = null;

  function release() {
    if (audio) {
      audio.pause();
      audio.src = '';
      audio = null;
    }
    if (url) {
      URL.revokeObjectURL(url);
      url = null;
    }
  }

  function stop() {
    release();
    state = 'idle';
    if (stopCurrent === stop) stopCurrent = null;
  }

  async function toggle(event: MouseEvent) {
    event.stopPropagation();
    if (!segId) return;
    if (state === 'playing' || state === 'loading') {
      stop();
      return;
    }
    stopCurrent?.();
    stopCurrent = stop;
    state = 'loading';
    const fetched = await meetings.readClipUrl(meetingId, segId);
    if (stopCurrent !== stop) {
      // Superseded (another clip started, or stopped) while loading.
      if (fetched) URL.revokeObjectURL(fetched);
      return;
    }
    if (!fetched) {
      stopCurrent = null;
      state = 'error';
      return;
    }
    url = fetched;
    audio = new Audio(url);
    audio.onended = stop;
    audio.onerror = () => {
      release();
      state = 'error';
    };
    try {
      await audio.play();
      state = 'playing';
    } catch {
      release();
      state = 'error';
    }
  }

  onDestroy(() => {
    if (stopCurrent === stop) stopCurrent = null;
    release();
  });

  const dim = $derived(size === 'sm' ? 'w-6 h-6' : 'w-5 h-5');
  const icon = $derived(size === 'sm' ? 'w-3.5 h-3.5' : 'w-3 h-3');
</script>

<button
  class="{dim} shrink-0 inline-flex items-center justify-center rounded-full border transition-colors disabled:opacity-30 disabled:cursor-not-allowed {state ===
  'playing'
    ? 'border-accent bg-accent/20 text-accent'
    : state === 'error'
      ? 'border-error/40 text-error'
      : 'border-border text-text-muted hover:text-text-primary hover:bg-surface-elevated'}"
  disabled={!segId}
  onclick={toggle}
  title={!segId ? 'No clip for this mention' : state === 'error' ? 'Clip unavailable (audio may have expired)' : state === 'playing' ? 'Stop' : title}
  aria-label={state === 'playing' ? 'Stop clip' : 'Play clip'}
>
  {#if state === 'loading'}
    <span class="{icon} border-2 border-current border-t-transparent rounded-full animate-spin"></span>
  {:else if state === 'playing'}
    <svg class={icon} viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="1" /></svg>
  {:else}
    <svg class={icon} viewBox="0 0 20 20" fill="currentColor"><path d="M6 4.5v11l9-5.5-9-5.5z" /></svg>
  {/if}
</button>
