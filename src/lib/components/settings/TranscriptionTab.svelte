<script lang="ts">
  import { settings, type TranscriptionMode } from "$lib/stores/settings";
  import RealtimeTab from "./RealtimeTab.svelte";
  import WhisperTab from "./WhisperTab.svelte";

  const modes: { value: TranscriptionMode; label: string }[] = [
    { value: "Whisper", label: "Whisper (batch)" },
    { value: "Realtime", label: "Real-time" },
    { value: "Both", label: "Both" },
  ];

  function setMode(mode: TranscriptionMode) {
    settings.update((s) => ({
      ...s,
      realtime: { ...s.realtime, transcription_mode: mode },
    }));
  }
</script>

<div class="space-y-4">
  <!-- Final transcript source -->
  <div>
    <label class="block text-sm font-medium text-text-secondary mb-1"
      >Final transcript source</label
    >
    <div class="flex gap-2">
      {#each modes as mode}
        <button
          class="flex-1 px-3 py-2 text-sm rounded border-2 transition-all {$settings
            .realtime.transcription_mode === mode.value
            ? 'border-accent bg-accent/10'
            : 'border-border'}"
          onclick={() => setMode(mode.value)}
        >
          <span class="font-medium">{mode.label}</span>
        </button>
      {/each}
    </div>
    <p class="text-xs text-text-muted mt-1.5">
      {#if $settings.realtime.transcription_mode === "Whisper"}
        The full recording is transcribed by Whisper after you stop. The live
        engine is optional — when enabled below, it only powers the overlay
        preview, voice commands, and open mic.
      {:else if $settings.realtime.transcription_mode === "Realtime"}
        The live engine's transcript is the final transcript — instant
        stop-to-prompt, and Whisper is never called. If the engine is down or
        hears nothing, the recording is treated as a failed transcription and
        salvaged to the pile (audio preserved, retriable there via Whisper).
      {:else}
        Real-time first with Whisper as the safety net: the live engine's
        transcript is used the moment you stop, and Whisper only transcribes
        when the engine is off, unreachable, or heard nothing. Recommended.
      {/if}
    </p>
    {#if $settings.realtime.transcription_mode !== "Whisper"}
      <p class="text-xs text-text-muted mt-1">
        In this mode the live engine runs during every recording (it produces
        the transcript), regardless of its enable toggle below. Works best
        with Moonshine (Whisper-level accuracy); Vosk is faster but has no
        punctuation.
      </p>
    {/if}
  </div>

  <!-- Live engine -->
  <div class="border-t border-border pt-4">
    <h3 class="text-sm font-semibold text-text-primary mb-3">
      Live engine (real-time)
      {#if $settings.realtime.transcription_mode !== "Whisper"}
        <span class="font-normal text-text-muted">— produces the transcript</span>
      {:else}
        <span class="font-normal text-text-muted">— preview only</span>
      {/if}
    </h3>
    <RealtimeTab />
  </div>

  <!-- Whisper -->
  <div class="border-t border-border pt-4">
    <h3 class="text-sm font-semibold text-text-primary mb-3">
      Whisper
      {#if $settings.realtime.transcription_mode === "Whisper"}
        <span class="font-normal text-text-muted">— produces the transcript</span>
      {:else if $settings.realtime.transcription_mode === "Both"}
        <span class="font-normal text-text-muted">— fallback</span>
      {:else}
        <span class="font-normal text-text-muted">— not used for recordings (still used for pile retries)</span>
      {/if}
    </h3>
    <WhisperTab />
  </div>
</div>
