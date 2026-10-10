<script lang="ts">
  import type { HoveredBlock } from "$lib/actions/blockReply";

  // Gutter button beside the hovered markdown block: one click quotes that block
  // into the prompt draft — the no-selection shortcut for "reply to this point".
  let {
    block,
    bounds,
    onReply,
  }: {
    block: HoveredBlock;
    /** The transcript scroller: the button stays inside its box. */
    bounds: HTMLElement;
    onReply: () => void;
  } = $props();

  /** Fits the transcript's 1rem side padding. */
  const SIZE = 16;

  let position = $derived.by(() => {
    const box = bounds.getBoundingClientRect();
    const { rect } = block;
    if (rect.bottom < box.top || rect.top > box.bottom) return null;
    // Align with the message's text column, not the block's own indent, so
    // list items and paragraphs share one gutter.
    const column =
      block.el.closest<HTMLElement>("[data-block-reply]")?.getBoundingClientRect().left ??
      rect.left;
    return {
      top: Math.min(Math.max(rect.top + 3, box.top), box.bottom - SIZE),
      left: Math.max(column - SIZE, box.left),
    };
  });
</script>

{#if position}
  <!-- mousedown is swallowed so the click never starts a text selection. -->
  <button
    class="block-reply-btn"
    data-block-reply-ui
    style="top: {position.top}px; left: {position.left}px; width: {SIZE}px; height: {SIZE}px;"
    onmousedown={(e) => e.preventDefault()}
    onclick={onReply}
    title="Reply to this (Alt+R)"
    aria-label="Quote this in the prompt"
  >
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fill-rule="evenodd"
        d="M7.707 3.293a1 1 0 010 1.414L5.414 7H11a5 5 0 015 5v3a1 1 0 11-2 0v-3a3 3 0 00-3-3H5.414l2.293 2.293a1 1 0 11-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
        clip-rule="evenodd"
      />
    </svg>
  </button>
{/if}

<style>
  .block-reply-btn {
    position: fixed;
    z-index: 55;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      background 0.12s ease,
      color 0.12s ease;
  }

  .block-reply-btn:hover {
    background: color-mix(in srgb, var(--color-accent) 18%, var(--color-surface-elevated));
    color: var(--color-accent);
  }

  .block-reply-btn svg {
    width: 11px;
    height: 11px;
  }
</style>
