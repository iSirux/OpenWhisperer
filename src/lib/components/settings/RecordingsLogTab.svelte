<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    debugRecordings,
    MAX_RECORDINGS,
    type DebugRecording,
  } from "$lib/stores/debugRecordings";
  import { settings } from "$lib/stores/settings";

  // Lazily-loaded blob URLs per recording id (revoked on destroy).
  let audioUrls = $state<Record<string, string>>({});
  let loadingAudio = $state<Record<string, boolean>>({});

  onMount(() => {
    debugRecordings.load();
  });

  onDestroy(() => {
    for (const url of Object.values(audioUrls)) {
      URL.revokeObjectURL(url);
    }
  });

  async function loadAudio(id: string) {
    if (audioUrls[id] || loadingAudio[id]) return;
    loadingAudio = { ...loadingAudio, [id]: true };
    const url = await debugRecordings.getAudioUrl(id);
    if (url) audioUrls = { ...audioUrls, [id]: url };
    loadingAudio = { ...loadingAudio, [id]: false };
  }

  function formatTime(ms: number): string {
    const d = new Date(ms);
    return d.toLocaleString();
  }

  function formatDuration(ms?: number): string {
    if (!ms) return "";
    const s = ms / 1000;
    return `${s.toFixed(1)}s`;
  }

  async function clearAll() {
    if (confirm("Clear the entire recordings log? This deletes the saved audio too.")) {
      // Revoke any open blob URLs first
      for (const url of Object.values(audioUrls)) URL.revokeObjectURL(url);
      audioUrls = {};
      await debugRecordings.clear();
    }
  }

  // Display name for the configured real-time provider (the "Vosk" field in the
  // log is provider-agnostic — Moonshine is the default now, not Vosk).
  const REALTIME_PROVIDER_LABELS: Record<string, string> = {
    Vosk: "Vosk",
    VoiceStreamAI: "VoiceStreamAI",
    SherpaOnnx: "Sherpa-ONNX",
    Speaches: "Speaches",
    Moonshine: "Moonshine",
  };
  const realtimeLabel = $derived(
    REALTIME_PROVIDER_LABELS[$settings.vosk?.provider ?? "Moonshine"] ?? "Real-time"
  );
</script>

<div class="space-y-4">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h3 class="text-sm font-medium text-text-primary">Recordings Log</h3>
      <p class="text-xs text-text-muted mt-1 max-w-lg">
        A rolling log of the {MAX_RECORDINGS} most recent recordings — audio plus
        every transcription stage (real-time, Whisper, and LLM cleanup).
      </p>
    </div>
    {#if $debugRecordings.length > 0}
      <button
        class="shrink-0 px-3 py-1.5 text-sm text-error border border-error/30 hover:bg-error/10 rounded transition-colors"
        onclick={clearAll}
      >
        Clear Log
      </button>
    {/if}
  </div>

  {#if $debugRecordings.length === 0}
    <div class="text-sm text-text-muted border border-border rounded p-6 text-center">
      No recordings logged yet.
    </div>
  {:else}
    <div class="space-y-3">
      {#each $debugRecordings as rec (rec.id)}
        <div class="border border-border rounded-lg p-3 bg-surface-elevated space-y-2">
          <!-- Header -->
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <span class="text-xs text-text-secondary font-mono">
              {formatTime(rec.createdAt)}
            </span>
            <div class="flex items-center gap-1.5">
              {#if rec.durationMs}
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-border text-text-muted">
                  {formatDuration(rec.durationMs)}
                </span>
              {/if}
              {#if rec.transcriptionMode}
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-border text-text-muted">
                  {rec.transcriptionMode}
                </span>
              {/if}
              {#if rec.destination}
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent">
                  {rec.destination}
                </span>
              {/if}
              {#if rec.error}
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-error/20 text-error">
                  error
                </span>
              {/if}
            </div>
          </div>

          <!-- Audio -->
          {#if rec.hasAudio}
            {#if audioUrls[rec.id]}
              <!-- svelte-ignore a11y_media_has_caption -->
              <audio controls src={audioUrls[rec.id]} class="w-full h-8"></audio>
            {:else}
              <button
                class="text-xs px-2 py-1 rounded border border-border hover:bg-border transition-colors text-text-secondary"
                disabled={loadingAudio[rec.id]}
                onclick={() => loadAudio(rec.id)}
              >
                {loadingAudio[rec.id] ? "Loading…" : "▶ Load audio"}
              </button>
            {/if}
          {:else}
            <span class="text-[10px] text-text-muted">no audio</span>
          {/if}

          <!-- Error -->
          {#if rec.error}
            <p class="text-xs text-error">{rec.error}</p>
          {/if}

          <!-- Transcript stages -->
          <div class="space-y-1.5 text-xs">
            {#if rec.voskTranscript}
              <div>
                <span class="text-text-muted uppercase tracking-wide text-[10px]">Real-time ({realtimeLabel})</span>
                <p class="text-text-secondary whitespace-pre-wrap">{rec.voskTranscript}</p>
              </div>
            {/if}
            {#if rec.whisperTranscript}
              <div>
                <span class="text-text-muted uppercase tracking-wide text-[10px]">Whisper (raw)</span>
                <p class="text-text-secondary whitespace-pre-wrap">{rec.whisperTranscript}</p>
              </div>
            {/if}
            {#if rec.cleanedTranscript}
              <div>
                <span class="text-text-muted uppercase tracking-wide text-[10px]">
                  Cleaned{rec.usedDualSource ? " (dual-source)" : ""}{rec.wasCleanedUp === false ? " (unchanged)" : ""}
                </span>
                <p class="text-text-primary whitespace-pre-wrap">{rec.cleanedTranscript}</p>
              </div>
            {/if}
            {#if rec.cleanupCorrections && rec.cleanupCorrections.length > 0}
              <div>
                <span class="text-text-muted uppercase tracking-wide text-[10px]">Corrections</span>
                <ul class="list-disc list-inside text-text-secondary">
                  {#each rec.cleanupCorrections as c}
                    <li>{c}</li>
                  {/each}
                </ul>
              </div>
            {/if}
          </div>

          <!-- Recommendations -->
          {#if rec.model || rec.repoName}
            <div class="flex items-center gap-1.5 flex-wrap pt-1 border-t border-border/50">
              {#if rec.model}
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-border text-text-muted">
                  {rec.model}{rec.effortLevel ? ` · ${rec.effortLevel}` : ""}
                </span>
              {/if}
              {#if rec.repoName}
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-border text-text-muted">
                  repo: {rec.repoName}{rec.repoConfidence ? ` (${rec.repoConfidence})` : ""}
                </span>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
