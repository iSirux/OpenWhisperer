<script lang="ts">
  /**
   * TranscriptDiff - Git diff-like visualization for transcript cleanup changes
   * Shows original vs cleaned text with highlighted additions/removals
   * When dual-source is used, shows two diffs side-by-side (Whisper→Cleaned and Real-time→Cleaned)
   */

  const STORAGE_KEY = 'transcript-diff-expanded';

  interface Props {
    /** Original transcript text (Whisper - before cleanup) */
    original: string;
    /** Cleaned transcript text (after cleanup) */
    cleaned: string;
    /** Real-time transcript (optional, for dual-source display) */
    realtimeTranscript?: string;
    /** Whether dual-source cleanup was used */
    usedDualSource?: boolean;
    /** List of corrections made (optional, for tooltip) */
    corrections?: string[];
    /** Whether to show collapsed by default (only used if no saved preference) */
    collapsed?: boolean;
  }

  let { original, cleaned, realtimeTranscript, usedDualSource = false, corrections = [], collapsed = false }: Props = $props();

  // Load saved preference from localStorage, fallback to collapsed prop
  function loadExpandedState(): boolean {
    if (typeof localStorage === 'undefined') return !collapsed;
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) {
      return saved === 'true';
    }
    return !collapsed;
  }

  let isExpanded = $state(loadExpandedState());

  // Persist expanded state to localStorage when it changes
  $effect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, String(isExpanded));
    }
  });

  // Compute word-level diff between original and cleaned text
  type DiffSegment = {
    type: 'unchanged' | 'removed' | 'added';
    text: string;
  };

  function computeWordDiff(orig: string, clean: string): DiffSegment[] {
    // Split on whitespace AND punctuation, keeping delimiters as separate tokens
    // This ensures punctuation-only changes don't highlight the whole word
    const tokenize = (text: string) => text.split(/(\s+|[.,!?;:'"()\[\]{}])/).filter(t => t !== '');
    const origWords = tokenize(orig);
    const cleanWords = tokenize(clean);

    // Simple LCS-based diff for words
    const segments: DiffSegment[] = [];

    let i = 0;
    let j = 0;

    while (i < origWords.length || j < cleanWords.length) {
      if (i >= origWords.length) {
        // Remaining words in cleaned are additions
        segments.push({ type: 'added', text: cleanWords[j] });
        j++;
      } else if (j >= cleanWords.length) {
        // Remaining words in original are removals
        segments.push({ type: 'removed', text: origWords[i] });
        i++;
      } else if (origWords[i] === cleanWords[j]) {
        // Same word
        segments.push({ type: 'unchanged', text: origWords[i] });
        i++;
        j++;
      } else {
        // Different - try to find a match ahead
        const lookAheadOrig = origWords.slice(i + 1, i + 5).indexOf(cleanWords[j]);
        const lookAheadClean = cleanWords.slice(j + 1, j + 5).indexOf(origWords[i]);

        if (lookAheadOrig !== -1 && (lookAheadClean === -1 || lookAheadOrig <= lookAheadClean)) {
          // Found match in original - current original words are removed
          for (let k = 0; k <= lookAheadOrig; k++) {
            segments.push({ type: 'removed', text: origWords[i + k] });
          }
          i += lookAheadOrig + 1;
        } else if (lookAheadClean !== -1) {
          // Found match in clean - current clean words are added
          for (let k = 0; k <= lookAheadClean; k++) {
            segments.push({ type: 'added', text: cleanWords[j + k] });
          }
          j += lookAheadClean + 1;
        } else {
          // No match found - treat as replacement (removed + added)
          segments.push({ type: 'removed', text: origWords[i] });
          segments.push({ type: 'added', text: cleanWords[j] });
          i++;
          j++;
        }
      }
    }

    return segments;
  }

  // Merge consecutive segments of the same type for cleaner display
  function mergeSegments(segments: DiffSegment[]): DiffSegment[] {
    const merged: DiffSegment[] = [];

    for (const segment of segments) {
      const last = merged[merged.length - 1];
      if (last && last.type === segment.type) {
        last.text += segment.text;
      } else {
        merged.push({ ...segment });
      }
    }

    return merged;
  }

  // Count changes in a diff
  function countChanges(segments: DiffSegment[]): number {
    return segments.filter(s => s.type !== 'unchanged').length;
  }

  let whisperDiffSegments = $derived(mergeSegments(computeWordDiff(original, cleaned)));
  let realtimeDiffSegments = $derived(realtimeTranscript ? mergeSegments(computeWordDiff(realtimeTranscript, cleaned)) : []);
  // Show if whisper differs from cleaned OR realtime differs from cleaned (or whisper)
  let hasChanges = $derived(original !== cleaned || (realtimeTranscript && realtimeTranscript !== cleaned));
  let whisperChangeCount = $derived(countChanges(whisperDiffSegments));
  let realtimeChangeCount = $derived(realtimeTranscript ? countChanges(realtimeDiffSegments) : 0);
  let totalChangeCount = $derived(corrections.length || Math.max(whisperChangeCount, realtimeChangeCount));
  let showDualDiffs = $derived(usedDualSource && realtimeTranscript);
</script>

{#if hasChanges}
  <div class="transcript-diff border border-border rounded overflow-hidden">
    <!-- Header -->
    <button
      class="w-full flex items-center justify-between px-3 py-2 bg-surface-elevated hover:bg-surface-elevated/80 transition-colors"
      onclick={() => isExpanded = !isExpanded}
    >
      <div class="flex items-center gap-2">
        <svg class="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span class="text-xs font-medium text-text-primary">
          Transcript cleaned
        </span>
        <span class="text-xs text-text-muted">
          ({totalChangeCount} {totalChangeCount === 1 ? 'change' : 'changes'})
        </span>
        {#if usedDualSource}
          <span class="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-purple-500/15 text-purple-400 border border-purple-500/30 rounded">
            Dual-source
          </span>
        {/if}
      </div>
      <svg
        class="w-4 h-4 text-text-muted transition-transform"
        class:rotate-180={isExpanded}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
      </svg>
    </button>

    {#if isExpanded}
      <div class="p-3 bg-background border-t border-border space-y-3">
        {#if showDualDiffs}
          <!-- Dual-source: Two diffs side by side -->
          <div class="grid grid-cols-2 gap-3">
            <!-- Whisper diff -->
            <div class="diff-panel">
              <div class="diff-panel-header">
                <span class="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-accent/15 text-accent border border-accent/30 rounded">Whisper</span>
                {#if whisperChangeCount > 0}
                  <span class="text-[10px] text-text-muted">→ Cleaned</span>
                  <span class="text-[10px] text-text-muted ml-auto">({whisperChangeCount} {whisperChangeCount === 1 ? 'change' : 'changes'})</span>
                {:else}
                  <span class="text-[10px] text-green-400 ml-auto">No changes</span>
                {/if}
              </div>
              <div class="diff-content">
                {#each whisperDiffSegments as segment}
                  {#if segment.type === 'unchanged'}
                    <span class="text-text-primary">{segment.text}</span>
                  {:else if segment.type === 'removed'}
                    <span class="bg-red-500/20 text-red-400 line-through decoration-red-400/50">{segment.text}</span>
                  {:else if segment.type === 'added'}
                    <span class="bg-green-500/20 text-green-400">{segment.text}</span>
                  {/if}
                {/each}
              </div>
            </div>

            <!-- Real-time diff -->
            <div class="diff-panel realtime">
              <div class="diff-panel-header">
                <span class="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-purple-500/15 text-purple-400 border border-purple-500/30 rounded">Real-time</span>
                {#if realtimeChangeCount > 0}
                  <span class="text-[10px] text-text-muted">→ Cleaned</span>
                  <span class="text-[10px] text-text-muted ml-auto">({realtimeChangeCount} {realtimeChangeCount === 1 ? 'change' : 'changes'})</span>
                {:else}
                  <span class="text-[10px] text-green-400 ml-auto">No changes</span>
                {/if}
              </div>
              <div class="diff-content">
                {#each realtimeDiffSegments as segment}
                  {#if segment.type === 'unchanged'}
                    <span class="text-text-primary">{segment.text}</span>
                  {:else if segment.type === 'removed'}
                    <span class="bg-red-500/20 text-red-400 line-through decoration-red-400/50">{segment.text}</span>
                  {:else if segment.type === 'added'}
                    <span class="bg-green-500/20 text-green-400">{segment.text}</span>
                  {/if}
                {/each}
              </div>
            </div>
          </div>
        {:else}
          <!-- Single-source: One diff -->
          <div class="diff-panel single">
            <div class="diff-panel-header">
              <span class="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-accent/15 text-accent border border-accent/30 rounded">Whisper</span>
              {#if whisperChangeCount > 0}
                <span class="text-[10px] text-text-muted">→ Cleaned</span>
                <span class="text-[10px] text-text-muted ml-auto">({whisperChangeCount} {whisperChangeCount === 1 ? 'change' : 'changes'})</span>
              {:else}
                <span class="text-[10px] text-green-400 ml-auto">No changes</span>
              {/if}
            </div>
            <div class="diff-content">
              {#each whisperDiffSegments as segment}
                {#if segment.type === 'unchanged'}
                  <span class="text-text-primary">{segment.text}</span>
                {:else if segment.type === 'removed'}
                  <span class="bg-red-500/20 text-red-400 line-through decoration-red-400/50">{segment.text}</span>
                {:else if segment.type === 'added'}
                  <span class="bg-green-500/20 text-green-400">{segment.text}</span>
                {/if}
              {/each}
            </div>
          </div>
        {/if}

        <!-- Corrections list -->
        {#if corrections.length > 0}
          <div class="pt-3 border-t border-border">
            <div class="text-xs font-medium text-text-muted mb-1.5">Corrections made:</div>
            <ul class="text-xs text-text-secondary space-y-0.5">
              {#each corrections as correction}
                <li class="flex items-start gap-1.5">
                  <span class="text-green-400 mt-0.5">+</span>
                  <span>{correction}</span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .diff-panel {
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
    border-left: 2px solid var(--color-accent);
  }

  .diff-panel.realtime {
    border-left-color: #a78bfa;
  }

  .diff-panel.single {
    border-left-width: 2px;
  }

  .diff-panel-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.625rem;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
  }

  .diff-content {
    padding: 0.5rem 0.625rem;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 0.75rem;
    line-height: 1.5;
    white-space: pre-wrap;
    max-height: 8rem;
    overflow-y: auto;
  }
</style>
