<script lang="ts">
  import type { SdkSession } from '$lib/stores/sdkSessions';
  import type { CockpitSessionRef } from '$lib/cockpit';
  import {
    getStatusColor,
    getStatusBgColor,
    getStatusLabel,
    isStatusAnimating,
  } from '$lib/utils/sessionStatus';
  import {
    getShortModelName,
    getModelBadgeBgColor,
    getModelTextColor,
  } from '$lib/utils/modelColors';

  interface Props {
    /** Canonical board ref (number, nickname, blocked flags) from buildFleetRefs(). */
    ref: CockpitSessionRef;
    /** The live session, looked up by the parent (may be undefined mid-teardown). */
    session: SdkSession | undefined;
    /** True when this card holds the focus ring. */
    focused: boolean;
    onFocus: () => void;
    onOpen: () => void;
  }

  let { ref, session, focused, onFocus, onOpen }: Props = $props();

  // The current activity / outcome one-liner: prefer the AI outcome, else the
  // most recent assistant text.
  const activityLine = $derived.by(() => {
    if (!session) return '';
    if (session.aiMetadata?.outcome) return session.aiMetadata.outcome;
    const msgs = session.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.type !== 'user' && typeof m.content === 'string' && m.content.trim()) {
        return m.content.trim();
      }
    }
    return '';
  });

  // A blocked card either awaits plan approval or has an open question.
  const planApproval = $derived(session?.pendingPlanApproval ?? null);
  const question = $derived(session?.askUserQuestion ?? null);
  const currentQuestion = $derived(
    question ? question.questions[question.currentQuestionIndex] : null
  );
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="cockpit-card group relative flex flex-col gap-2 rounded-lg border bg-surface-elevated p-3 transition-all cursor-pointer select-none"
  class:border-border={!ref.isBlocked && !focused}
  class:border-red-500={ref.isBlocked}
  class:blocked={ref.isBlocked}
  class:focused
  onclick={onFocus}
  ondblclick={onOpen}
  title="Click to focus · double-click to open"
>
  <!-- Number + nickname + status -->
  <div class="flex items-start gap-3">
    <span
      class="board-number shrink-0 font-mono font-bold leading-none tabular-nums text-text-primary"
      title="Say this number to address the session"
    >
      {ref.index}
    </span>
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-1.5">
        {#if ref.nickname}
          <span
            class="px-1 py-0.5 text-[9px] font-mono uppercase tracking-wide text-text-muted bg-border/60 rounded flex-shrink-0"
            title="Voice callsign">{ref.nickname}</span
          >
        {/if}
        {#if session?.model}
          <span
            class="px-1 py-0.5 text-[9px] font-medium rounded flex-shrink-0 {getModelBadgeBgColor(
              session.model
            )} {getModelTextColor(session.model)}"
          >
            {getShortModelName(session.model)}
          </span>
        {/if}
      </div>
      <div class="mt-1 text-sm font-medium text-text-primary truncate" title={ref.name}>
        {ref.name}
      </div>
    </div>
    <!-- Status dot + label -->
    <div class="flex items-center gap-1.5 shrink-0">
      <div class="relative">
        <div class="w-2 h-2 rounded-full {getStatusBgColor(ref.status)}"></div>
        {#if isStatusAnimating(ref.status)}
          <div
            class="absolute inset-0 w-2 h-2 rounded-full {getStatusBgColor(
              ref.status
            )} animate-ping opacity-75"
          ></div>
        {/if}
      </div>
      <span class="text-[11px] font-medium {getStatusColor(ref.status)}">
        {getStatusLabel(ref.status)}
      </span>
    </div>
  </div>

  <!-- Activity / outcome one-liner -->
  {#if activityLine && !ref.isBlocked}
    <p class="text-xs text-text-muted leading-snug line-clamp-2" title={activityLine}>
      {activityLine}
    </p>
  {/if}

  <!-- Blocked: plan approval -->
  {#if planApproval}
    <div class="rounded border border-red-500/40 bg-red-500/10 p-2">
      <div class="flex items-center gap-1.5 text-[11px] font-semibold text-red-400">
        <span class="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse"></span>
        Plan awaiting approval
      </div>
      {#if planApproval.plan}
        <p class="mt-1 text-[11px] text-text-secondary leading-snug line-clamp-3">
          {planApproval.plan}
        </p>
      {/if}
      <p class="mt-1 text-[10px] text-text-muted">say "approve" or "reject"</p>
    </div>
  {/if}

  <!-- Blocked: open question with numbered options -->
  {#if currentQuestion}
    <div class="rounded border border-red-500/40 bg-red-500/10 p-2">
      <div class="flex items-center gap-1.5 text-[11px] font-semibold text-red-400">
        <span class="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse"></span>
        Needs your answer
      </div>
      <p class="mt-1 text-xs text-text-primary leading-snug">{currentQuestion.question}</p>
      <ul class="mt-1.5 space-y-1">
        {#each currentQuestion.options as option, i}
          <li class="flex items-start gap-2 text-[11px] text-text-secondary">
            <span
              class="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded bg-red-500/30 text-red-300 font-mono font-semibold text-[10px]"
              title="Say this number to answer"
            >
              {i + 1}
            </span>
            <span class="min-w-0">{option.label}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .board-number {
    font-size: 1.5rem;
    width: 1.75rem;
    text-align: center;
  }

  .cockpit-card:hover {
    background-color: color-mix(in srgb, var(--color-surface-elevated) 80%, var(--color-accent));
  }

  /* Strong, unmistakable focus ring. */
  .cockpit-card.focused {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 2px var(--color-accent);
  }

  /* Blocked cards get a persistent red left accent. */
  .cockpit-card.blocked {
    border-left-width: 3px;
  }

</style>
