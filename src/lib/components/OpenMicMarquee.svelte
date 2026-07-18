<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { openMic, isOpenMicListening, isOpenMicPaused, isOpenMicActive } from "$lib/stores/openMic";
  import { isRecording, realtimeTranscript } from "$lib/stores/recording";

  let transcript = $state("");
  let isListening = $derived($isOpenMicListening);
  let isPaused = $derived($isOpenMicPaused);
  let isOpenMicVisible = $derived($isOpenMicActive);
  // While recording, open mic is stopped — but we keep the marquee (the header's
  // waveform) visible and drive it from the recording's own audio visualization
  // and live transcript, so recordings always get a header waveform (even the
  // in-session ones that no longer show the overlay).
  let recording = $derived($isRecording);
  // Show the marquee whenever open mic is active OR a recording is in progress.
  let isActive = $derived(isOpenMicVisible || recording);
  // Animate the waveform when listening to open mic OR while recording.
  let showWaveform = $derived(isListening || recording);
  // Text shown in the marquee: the live recording transcript while recording,
  // otherwise the open-mic transcript.
  let displayText = $derived(recording ? $realtimeTranscript : transcript);

  function handleClick() {
    // Click only toggles open-mic pause; it's a no-op while recording.
    if (recording) return;
    openMic.togglePause();
  }
  let unlistenTranscript: UnlistenFn | null = null;
  let unlistenVisualization: UnlistenFn | null = null;
  let unlistenRecordingViz: UnlistenFn | null = null;

  // Timer to reset transcript after inactivity
  let resetTimer: ReturnType<typeof setTimeout> | null = null;
  const RESET_DELAY_MS = 3000;

  // Canvas for waveform
  let canvas: HTMLCanvasElement;
  let container: HTMLDivElement;
  let animationId: number;
  let resizeObserver: ResizeObserver | null = null;

  // Audio visualization data from open mic store
  let audioData: number[] | null = null;
  let isAboveThreshold = $state(false);
  let unlistenAudioLevel: UnlistenFn | null = null;

  const barWidth = 2;
  const barGap = 2;
  const waveColorActive = "#ef4444"; // Recording red - above threshold
  const waveColorInactive = "#6b7280"; // Grey - below threshold

  // Draw waveform from audio data
  function drawWaveform() {
    if (!canvas || !container) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    animationId = requestAnimationFrame(drawWaveform);

    const displayWidth = container.getBoundingClientRect().width;
    const displayHeight = container.getBoundingClientRect().height;

    // Clear canvas
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    const barTotalWidth = barWidth + barGap;
    const barCount = Math.floor(displayWidth / barTotalWidth);
    const halfBarCount = Math.floor(barCount / 2);

    // Use audio data if available, otherwise show minimal bars
    const data = audioData || [];

    // Only use first 50% of frequency data (voice range) for left half
    const voiceDataLength = Math.max(1, Math.floor(data.length * 0.5));
    const step =
      data.length > 0
        ? Math.max(1, Math.floor(voiceDataLength / halfBarCount))
        : 1;

    // Noise floor detection: low variance AND low max value (must have BOTH)
    const voiceData = data.slice(0, voiceDataLength);
    const min = voiceData.length > 0 ? Math.min(...voiceData) : 0;
    const max = voiceData.length > 0 ? Math.max(...voiceData) : 0;
    const variance = max - min;
    // Noise floor = low variance (<15) AND max is low (<50) - both required
    const isNoiseFloor = variance < 15 && max < 50;

    for (let i = 0; i < barCount; i++) {
      let normalized: number;

      if (data.length > 0) {
        // Mirror: left half uses normal index, right half mirrors from center
        const mirrorIndex = i < halfBarCount ? i : barCount - 1 - i;
        const dataIndex = Math.min(mirrorIndex * step, voiceDataLength - 1);
        const value = data[dataIndex] || 0;

        // Normalize value to 0-1 range, but zero out if it's just noise floor
        normalized = isNoiseFloor ? 0 : value / 255;
      } else {
        // Minimal baseline when no audio data
        normalized = 0.05;
      }

      // Calculate bar height (minimum 2px)
      const barHeight = Math.max(2, normalized * displayHeight);

      const x = i * barTotalWidth;
      const y = (displayHeight - barHeight) / 2;

      // While recording, the mic is inherently "hot" — use the active (red) color.
      ctx.fillStyle = isAboveThreshold || recording ? waveColorActive : waveColorInactive;
      ctx.globalAlpha = 0.5; // Semi-transparent to be behind text
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, barWidth / 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function updateCanvasSize() {
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.scale(dpr, dpr);
    }
  }

  async function startWaveform() {
    // Guard against re-entry: the effect can re-run while already animating
    // (e.g. open-mic listening → recording transition) without stopping first.
    if (unlistenVisualization || unlistenRecordingViz) return;

    if (container) {
      resizeObserver = new ResizeObserver(() => {
        updateCanvasSize();
      });
      resizeObserver.observe(container);
      updateCanvasSize();
    }

    // Listen for visualization data from open mic store
    unlistenVisualization = await listen<{ data: number[] }>(
      "open-mic-visualization",
      (event) => {
        audioData = event.payload?.data ?? null;
      }
    );

    // Listen for the recording store's visualization data (fed while recording,
    // when open mic is stopped) so the header waveform tracks the recording.
    unlistenRecordingViz = await listen<{ data: number[] | null }>(
      "audio-visualization",
      (event) => {
        audioData = event.payload?.data ?? null;
      }
    );

    // Listen for audio level to show threshold state
    unlistenAudioLevel = await listen<{ rms: number; threshold: number; isAboveThreshold: boolean }>(
      "open-mic-audio-level",
      (event) => {
        isAboveThreshold = event.payload?.isAboveThreshold ?? false;
      }
    );

    drawWaveform();
  }

  function stopWaveform() {
    if (animationId) {
      cancelAnimationFrame(animationId);
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (unlistenVisualization) {
      unlistenVisualization();
      unlistenVisualization = null;
    }
    if (unlistenRecordingViz) {
      unlistenRecordingViz();
      unlistenRecordingViz = null;
    }
    if (unlistenAudioLevel) {
      unlistenAudioLevel();
      unlistenAudioLevel = null;
    }
    audioData = null;
    isAboveThreshold = false;
  }

  function resetTranscriptTimer() {
    // Clear any existing timer
    if (resetTimer) {
      clearTimeout(resetTimer);
    }
    // Set a new timer to reset transcript after 3 seconds of no updates
    resetTimer = setTimeout(() => {
      transcript = "";
    }, RESET_DELAY_MS);
  }

  onMount(async () => {
    // Listen to dedicated open-mic event (separate from recording to avoid interference)
    unlistenTranscript = await listen<{ text: string }>(
      "open-mic-realtime-transcript",
      (event) => {
        const text = event.payload?.text ?? "";
        // Always update transcript - empty string clears it
        transcript = text;
        // Reset the inactivity timer on each update (only for non-empty text)
        if (text) {
          resetTranscriptTimer();
        }
      }
    );
  });

  onDestroy(() => {
    unlistenTranscript?.();
    stopWaveform();
    if (resetTimer) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
  });

  // Start/stop waveform based on listening/recording state
  $effect(() => {
    if (showWaveform && canvas && container) {
      startWaveform();
    } else {
      stopWaveform();
    }
  });
</script>

{#if isActive}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="open-mic-marquee"
    class:paused={isPaused}
    class:recording={recording}
    bind:this={container}
    onclick={handleClick}
    title={recording
      ? "Recording…"
      : isPaused
        ? "Click to resume listening"
        : "Click to pause listening"}
  >
    <!-- Waveform canvas behind text (when listening to open mic or recording) -->
    {#if showWaveform}
      <canvas bind:this={canvas} class="waveform-canvas"></canvas>
    {/if}
    <!-- Text overlay -->
    <div class="transcript-container">
      {#if isPaused}
        <span class="paused-indicator">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="pause-icon">
            <path fill-rule="evenodd" d="M6.75 5.25a.75.75 0 0 1 .75-.75H9a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H7.5a.75.75 0 0 1-.75-.75V5.25Zm7.5 0A.75.75 0 0 1 15 4.5h1.5a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H15a.75.75 0 0 1-.75-.75V5.25Z" clip-rule="evenodd" />
          </svg>
          Paused
        </span>
      {:else}
        <span class="transcript-text">
          {displayText || ""}
        </span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .open-mic-marquee {
    position: relative;
    width: 200px;
    min-width: 50px;
    flex-shrink: 1;
    height: 28px;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
    cursor: pointer;
    transition: opacity 0.15s ease, border-color 0.15s ease, width 0.2s ease;
  }

  .open-mic-marquee:hover {
    border-color: var(--color-border-hover, var(--color-border));
    opacity: 0.9;
  }

  .open-mic-marquee.recording {
    border-color: var(--color-recording, #ef4444);
    cursor: default;
  }

  .open-mic-marquee.paused {
    opacity: 0.7;
    border-style: dashed;
  }

  .open-mic-marquee.paused:hover {
    opacity: 0.85;
  }

  .waveform-canvas {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 0;
    padding: 0 8px;
  }

  .transcript-container {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 0 8px;
    z-index: 1;
  }

  .transcript-text {
    position: relative;
    z-index: 1;
    white-space: nowrap;
    font-size: 11px;
    color: var(--color-text-primary);
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
      "Liberation Mono", monospace;
    text-shadow:
      0 0 4px var(--color-surface-elevated),
      0 0 8px var(--color-surface-elevated);
  }

  .paused-indicator {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--color-text-secondary);
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
      "Liberation Mono", monospace;
  }

  .pause-icon {
    width: 12px;
    height: 12px;
    color: var(--color-text-secondary);
  }
</style>
