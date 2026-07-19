<script lang="ts">
  import type { SendTiming } from "$lib/utils/sendTiming";

  // Single source of truth for the send-timing hint glyphs shared across the
  // Send button, quick actions, launch profiles, and the parked-turn ghost:
  //   now → lightning bolt, session_idle → hourglass, repo_idle → clock,
  //   reset_5h → the "5h" text glyph.
  let { timing }: { timing: SendTiming } = $props();
</script>

{#if timing === "reset_5h"}
  <span class="send-timing-glyph text-glyph" aria-hidden="true">5h</span>
{:else}
  <span class="send-timing-glyph" aria-hidden="true">
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {#if timing === "now"}
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      {:else if timing === "session_idle"}
        <path d="M6 2h12M6 22h12M8 2v4l4 4 4-4V2M8 22v-4l4-4 4 4v4" />
      {:else}
        <!-- repo_idle -->
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      {/if}
    </svg>
  </span>
{/if}

<style>
  .send-timing-glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .send-timing-glyph svg {
    width: 11px;
    height: 11px;
  }
  .send-timing-glyph.text-glyph {
    font-size: 0.5rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1;
  }
</style>
