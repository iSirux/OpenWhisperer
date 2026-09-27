<script lang="ts">
  /**
   * Delayed meeting transcript: one row per segment, arriving as each segment
   * is transcribed. Pending segments show a placeholder; failed ones a retry.
   * Auto-follows the bottom while live unless the user scrolled up.
   */
  import { tick } from 'svelte';
  import {
    meetings,
    formatMeetingTime,
    speakerLabel,
    type TranscriptLine,
  } from '$lib/stores/meetings';
  import ClipButton from './ClipButton.svelte';

  interface Props {
    meetingId: string;
    lines: TranscriptLine[] | null;
    live: boolean;
  }

  let { meetingId, lines, live }: Props = $props();

  let scroller: HTMLDivElement | null = $state(null);
  let pinned = $state(true);
  let filter = $state('');

  const visible = $derived.by(() => {
    const all = lines ?? [];
    const q = filter.trim().toLowerCase();
    return q ? all.filter((l) => l.text.toLowerCase().includes(q)) : all;
  });

  function onScroll() {
    if (!scroller) return;
    pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
  }

  $effect(() => {
    void visible.length;
    if (live && pinned && scroller) {
      tick().then(() => {
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
    }
  });

  function speakerClass(speaker: string): string {
    if (speaker === 'me') return 'text-accent';
    if (speaker.startsWith('them')) return 'text-amber-400';
    return 'text-text-secondary';
  }
</script>

<div class="flex flex-col min-h-0 h-full">
  <div class="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
    <span class="text-xs font-medium text-text-secondary">Transcript</span>
    <span class="text-[10px] text-text-muted">{lines?.length ?? 0} segments</span>
    <input
      type="text"
      class="ml-auto w-32 px-2 py-0.5 text-[11px] bg-surface-elevated border border-border rounded text-text-primary focus:outline-none focus:border-accent"
      placeholder="Filter…"
      bind:value={filter}
    />
  </div>
  <div class="flex-1 overflow-y-auto px-3 py-2 space-y-1.5" bind:this={scroller} onscroll={onScroll}>
    {#if lines === null}
      <p class="text-xs text-text-muted">Loading transcript…</p>
    {:else if visible.length === 0}
      <p class="text-xs text-text-muted">
        {filter ? 'No matching lines.' : live ? 'Listening… segments appear here a little after they are spoken.' : 'No transcript.'}
      </p>
    {:else}
      {#each visible as line (line.seg_id)}
        <div class="group flex items-start gap-2 text-xs">
          <span class="font-mono text-[10px] text-text-muted pt-0.5 shrink-0 tabular-nums">{formatMeetingTime(line.t0)}</span>
          <span class="font-medium shrink-0 w-14 truncate {speakerClass(line.speaker)}" title={speakerLabel(line.speaker)}>
            {speakerLabel(line.speaker)}
          </span>
          <div class="flex-1 min-w-0">
            {#if line.status === 'pending'}
              <span class="text-text-muted italic animate-pulse">transcribing…</span>
            {:else if line.status === 'error'}
              <span class="text-red-400" title={line.error ?? ''}>Transcription failed{line.error ? `: ${line.error}` : ''}</span>
              <button
                class="ml-1 text-[11px] text-text-muted hover:text-text-primary underline"
                onclick={() => meetings.retrySegment(meetingId, line.seg_id)}
              >
                Retry
              </button>
            {:else}
              <span class="text-text-primary whitespace-pre-wrap break-words">{line.text}</span>
            {/if}
          </div>
          <span class="opacity-0 group-hover:opacity-100 transition-opacity">
            <ClipButton {meetingId} segId={line.seg_id} />
          </span>
        </div>
      {/each}
    {/if}
  </div>
  {#if live && !pinned}
    <button
      class="shrink-0 text-[11px] py-1 border-t border-border text-accent hover:bg-surface-elevated"
      onclick={() => {
        pinned = true;
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      }}
    >
      Jump to latest
    </button>
  {/if}
</div>
