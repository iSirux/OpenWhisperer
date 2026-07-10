<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { settings } from '$lib/stores/settings';

  let audioDevices: MediaDeviceInfo[] = $state([]);
  let permissionError = $state<string | null>(null);
  let level = $state(0);
  let heard = $state(false);

  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let raf = 0;

  onMount(() => {
    void init();
  });

  onDestroy(() => {
    stopMeter();
  });

  async function init() {
    permissionError = null;
    try {
      await startMeter($settings.audio.device_id);
      const devices = await navigator.mediaDevices.enumerateDevices();
      audioDevices = devices.filter((d) => d.kind === 'audioinput');
    } catch (error) {
      console.error('[onboarding] Microphone access failed:', error);
      permissionError =
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Microphone access was denied. Allow microphone access for this app in your system privacy settings, then try again.'
          : `Could not access the microphone: ${error}`;
    }
  }

  async function startMeter(deviceId: string | null) {
    stopMeter();
    heard = false;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const d = (data[i] - 128) / 128;
        sum += d * d;
      }
      const rms = Math.sqrt(sum / data.length);
      level = Math.min(1, rms * 5);
      if (level > 0.15) heard = true;
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  function stopMeter() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    void audioCtx?.close().catch(() => {});
    audioCtx = null;
    level = 0;
  }

  async function handleDeviceChange() {
    permissionError = null;
    try {
      await startMeter($settings.audio.device_id);
    } catch (error) {
      permissionError = `Could not access this microphone: ${error}`;
    }
  }
</script>

<div class="space-y-5">
  <div class="bg-surface-elevated border border-border rounded-lg p-5">
    <label class="block text-sm font-medium text-text-secondary mb-2">Recording device</label>
    <div class="flex gap-2">
      <select
        class="flex-1 min-w-0 px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
        bind:value={$settings.audio.device_id}
        onchange={handleDeviceChange}
      >
        <option value={null}>System Default</option>
        {#each audioDevices as device}
          <option value={device.deviceId}>
            {device.label || `Microphone ${device.deviceId.slice(0, 8)}`}
          </option>
        {/each}
      </select>
      <button
        class="px-3 py-2 bg-surface hover:bg-border rounded text-sm transition-colors"
        onclick={init}
        title="Refresh devices"
      >
        Refresh
      </button>
    </div>

    <!-- Level meter -->
    <div class="mt-5">
      <div class="flex items-center justify-between mb-2">
        <span class="text-sm text-text-secondary">Say something…</span>
        {#if heard}
          <span class="flex items-center gap-1.5 text-xs text-success">
            <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path
                fill-rule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clip-rule="evenodd"
              />
            </svg>
            Microphone is working
          </span>
        {:else if !permissionError}
          <span class="text-xs text-text-muted">Listening for input…</span>
        {/if}
      </div>
      <div class="h-3 bg-background border border-border rounded-full overflow-hidden">
        <div
          class="h-full rounded-full transition-[width] duration-75 {heard ? 'bg-success' : 'bg-accent'}"
          style="width: {Math.round(level * 100)}%"
        ></div>
      </div>
    </div>

    {#if permissionError}
      <div class="mt-4 p-3 bg-error/10 border border-error/20 rounded text-sm">
        <p class="text-error">{permissionError}</p>
        <button
          class="mt-2 px-3 py-1.5 text-xs bg-surface hover:bg-border rounded transition-colors"
          onclick={init}
        >
          Try again
        </button>
      </div>
    {/if}

    {#if audioDevices.length === 0 && !permissionError}
      <p class="text-xs text-text-muted mt-3">
        No microphones found. Connect one and click Refresh.
      </p>
    {/if}
  </div>
</div>
