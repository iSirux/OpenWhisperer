<script lang="ts">
  import { onDestroy } from "svelte";
  import { sdkSessions, type SdkSession, type SdkImageContent, type SdkMessage } from "$lib/stores/sdkSessions";
  import { sendTimingLabel, type SendTiming } from "$lib/utils/sendTiming";
  import SendTimingIcon from "./SendTimingIcon.svelte";

  // The parked (not-yet-sent) turn. `message` is the flagged ghost bubble pulled
  // out of the scrolling transcript; actions operate on the session's rateLimited
  // state (the single source of truth for the deferred turn).
  let { session, message }: { session: SdkSession; message: SdkMessage } = $props();

  // Prefer the flag the turn was parked with; fall back to the rateLimited reason for
  // turns parked before the `queued` flag existed.
  let timing = $derived.by<SendTiming>(() => {
    if (message.queued) return message.queued;
    const rl = session.rateLimited;
    if (rl?.reason === "scheduled") return "reset_5h";
    if (rl?.reason === "after_sessions") return rl.scope === "session" ? "session_idle" : "repo_idle";
    return "session_idle";
  });
  let label = $derived(sendTimingLabel(timing));

  // Live countdown for a reset-scheduled turn.
  let now = $state(Date.now());
  const timer = setInterval(() => (now = Date.now()), 1000);
  onDestroy(() => clearInterval(timer));

  let targetMs = $derived(session.rateLimited?.targetStartAt);
  let countdown = $derived.by(() => {
    if (timing !== "reset_5h" || targetMs == null) return "";
    const diff = targetMs - now;
    if (diff <= 0) return "now";
    const hours = Math.floor(diff / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    const seconds = Math.floor((diff % 60_000) / 1000);
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  });

  let busy = $state(false);

  function createImagePreviewUrl(img: SdkImageContent): string {
    return `data:${img.mediaType};base64,${img.base64Data}`;
  }

  async function handleSendNow() {
    if (busy) return;
    busy = true;
    try {
      await sdkSessions.continueRateLimited(session.id);
    } catch (err) {
      console.error("[QueuedTurnGhost] Send now failed:", err);
    } finally {
      busy = false;
    }
  }

  function handleCancel() {
    sdkSessions.clearRateLimited(session.id);
  }
</script>

<div class="ghost-turn">
  <div class="ghost-chip" title={label}>
    <SendTimingIcon {timing} />
    <span class="ghost-chip-label">{label}{countdown ? ` · ${countdown}` : ""}</span>
  </div>

  <div class="ghost-body">
    {#if message.images && message.images.length > 0}
      <div class="ghost-images">
        {#each message.images as img}
          <img src={createImagePreviewUrl(img)} alt="Attached" class="ghost-image" />
        {/each}
      </div>
    {/if}
    {#if message.content}
      <pre class="ghost-content">{message.content}</pre>
    {/if}
  </div>

  <div class="ghost-actions">
    <button class="ghost-btn primary" onclick={handleSendNow} disabled={busy} title="Send this turn now">
      Send now
    </button>
    <button class="ghost-btn" onclick={handleCancel} disabled={busy} title="Cancel this deferred send">
      Cancel
    </button>
  </div>
</div>

<style>
  .ghost-turn {
    position: relative;
    padding: 0.75rem 1rem;
    border: 1px dashed color-mix(in srgb, var(--color-accent) 45%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--color-accent) 6%, transparent);
    opacity: 0.85;
    animation: ghostIn 0.2s ease-out;
  }

  @keyframes ghostIn {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 0.85;
      transform: translateY(0);
    }
  }

  .ghost-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-bottom: 0.5rem;
    padding: 0.125rem 0.5rem 0.125rem 0.375rem;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--color-accent) 15%, transparent);
    color: var(--color-accent);
    font-size: 0.7rem;
    font-weight: 600;
    line-height: 1.4;
  }

  .ghost-chip-label {
    white-space: nowrap;
  }

  .ghost-body {
    max-height: 16rem;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .ghost-content {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.9rem;
    line-height: 1.5;
    color: var(--color-text-secondary);
  }

  .ghost-images {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .ghost-image {
    max-width: 220px;
    max-height: 160px;
    border-radius: 4px;
  }

  .ghost-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.625rem;
  }

  .ghost-btn {
    display: inline-flex;
    align-items: center;
    padding: 0.3rem 0.7rem;
    font-size: 0.8125rem;
    font-weight: 500;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text-primary);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }

  .ghost-btn:hover:not(:disabled) {
    background: var(--color-border);
  }

  .ghost-btn.primary {
    border-color: color-mix(in srgb, var(--color-accent) 50%, transparent);
    background: color-mix(in srgb, var(--color-accent) 18%, transparent);
  }

  .ghost-btn.primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-accent) 28%, transparent);
  }

  .ghost-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
