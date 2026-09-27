<script lang="ts">
  import type { QuoteSelection } from "$lib/actions/selectionQuote";
  import { modifierCombo } from "$lib/stores/ctrlHint";
  import { sendTimingFromEvent, type SendTiming } from "$lib/utils/sendTiming";
  import SendTimingIcon from "./SendTimingIcon.svelte";

  // One-row floating bar anchored to the current transcript selection: quote it
  // into the prompt draft, optionally starting a voice follow-up in the same
  // click. Mirrors the app-wide send-timing modifiers on the mic button
  // (Ctrl = now, Shift = session idle, Ctrl+Shift = worktree idle, +Alt = 5h reset).
  let {
    selection,
    showVoice = true,
    voiceBusy = false,
    copied = false,
    onReply,
    onReplyVoice,
    onCopy,
  }: {
    selection: QuoteSelection;
    /** Hidden when voice mode is disabled app-wide. */
    showVoice?: boolean;
    /** A recording/transcription is already running — voice can't start now. */
    voiceBusy?: boolean;
    copied?: boolean;
    onReply: () => void;
    /** `null` timing = quote then dictate into the draft (no send). */
    onReplyVoice: (timing: SendTiming | null) => void;
    onCopy: () => void;
  } = $props();

  const GAP = 8;
  /** Approximate bar width, used to keep it inside the viewport before measuring. */
  const HALF_WIDTH = 105;

  let viewportWidth = $state(0);

  // Sit above the selection, flipping below when it's too close to the top edge.
  let below = $derived(selection.rect.top < 56);
  let top = $derived(
    below ? selection.rect.bottom + GAP : selection.rect.top - GAP
  );
  let left = $derived.by(() => {
    const centre = selection.rect.left + selection.rect.width / 2;
    const min = HALF_WIDTH + GAP;
    const max = Math.max(viewportWidth - HALF_WIDTH - GAP, min);
    return Math.min(Math.max(centre, min), max);
  });

  function handleVoiceClick(e: MouseEvent) {
    const ctrl = e.ctrlKey || e.metaKey;
    onReplyVoice(!ctrl && !e.shiftKey ? null : sendTimingFromEvent(e));
  }

  const voiceTitle =
    "Click: quote and dictate a follow-up\n" +
    "Ctrl: quote, record and send now\n" +
    "Shift: … send when this session is idle\n" +
    "Ctrl+Shift: … send when the worktree is idle\n" +
    "Ctrl+Shift+Alt: … send at the next 5h reset";
</script>

<svelte:window bind:innerWidth={viewportWidth} />

<!-- mousedown is swallowed so clicking a button never collapses the selection
     before the click handler reads it. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="selection-reply"
  class:below
  style="top: {top}px; left: {left}px;"
  onmousedown={(e) => e.preventDefault()}
>
  <button class="reply-btn primary" onclick={onReply} title="Quote this in the prompt (Alt+R)">
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fill-rule="evenodd"
        d="M7.707 3.293a1 1 0 010 1.414L5.414 7H11a5 5 0 015 5v3a1 1 0 11-2 0v-3a3 3 0 00-3-3H5.414l2.293 2.293a1 1 0 11-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
        clip-rule="evenodd"
      />
    </svg>
    Reply
  </button>

  {#if showVoice}
    <button
      class="reply-btn"
      onclick={handleVoiceClick}
      disabled={voiceBusy}
      title={voiceTitle}
      aria-label="Quote and reply with voice"
    >
      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path
          fill-rule="evenodd"
          d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z"
          clip-rule="evenodd"
        />
      </svg>
      {#if $modifierCombo === "ctrl"}
        <span class="timing-badge" aria-hidden="true"><SendTimingIcon timing="now" /></span>
      {:else if $modifierCombo === "shift"}
        <span class="timing-badge" aria-hidden="true"><SendTimingIcon timing="session_idle" /></span>
      {:else if $modifierCombo === "ctrl+shift"}
        <span class="timing-badge" aria-hidden="true"><SendTimingIcon timing="repo_idle" /></span>
      {:else if $modifierCombo === "ctrl+shift+alt"}
        <span class="timing-badge" aria-hidden="true"><SendTimingIcon timing="reset_5h" /></span>
      {/if}
    </button>
  {/if}

  <button
    class="reply-btn"
    onclick={onCopy}
    title="Copy the selected text"
    aria-label="Copy selection"
  >
    {#if copied}
      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path
          fill-rule="evenodd"
          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
          clip-rule="evenodd"
        />
      </svg>
    {:else}
      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path d="M8 3a1 1 0 011-1h6a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V3z" />
        <path d="M6 5a1 1 0 00-1 1v9a1 1 0 001 1h5a1 1 0 001-1v-1H9a2 2 0 01-2-2V5H6z" />
      </svg>
    {/if}
  </button>
</div>

<style>
  .selection-reply {
    position: fixed;
    z-index: 60;
    transform: translate(-50%, -100%);
    display: flex;
    align-items: center;
    gap: 0.125rem;
    padding: 0.1875rem;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
    white-space: nowrap;
  }

  .selection-reply.below {
    transform: translate(-50%, 0);
  }

  .reply-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.4375rem;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--color-text-secondary);
    font-size: 0.6875rem;
    font-family: inherit;
    cursor: pointer;
    transition:
      background 0.12s ease,
      color 0.12s ease;
  }

  .reply-btn:hover:not(:disabled) {
    background: var(--color-surface);
    color: var(--color-text-primary);
  }

  .reply-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .reply-btn.primary {
    color: var(--color-text-primary);
    font-weight: 500;
  }

  .reply-btn.primary:hover {
    background: color-mix(in srgb, var(--color-accent) 18%, transparent);
    color: var(--color-accent);
  }

  .reply-btn svg {
    width: 13px;
    height: 13px;
    flex-shrink: 0;
  }

  .timing-badge {
    display: inline-flex;
    align-items: center;
    color: var(--color-accent);
  }
</style>
