<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    cockpitController,
    cockpitActive,
    focusedSessionId,
    fleetBriefing,
    draft,
  } from '$lib/cockpit';
  import { dismissedSessionIds } from '$lib/cockpit';
  import { sdkSessions, activeSdkSessionId } from '$lib/stores/sdkSessions';
  import { navigation } from '$lib/stores/navigation';
  import CockpitSessionCard from './CockpitSessionCard.svelte';
  import CockpitCommandLine from './CockpitCommandLine.svelte';
  import CockpitDispatchDrawer from './CockpitDispatchDrawer.svelte';
  import CockpitLedger from './CockpitLedger.svelte';

  // ---- Window-focus-gated mic lifecycle ------------------------------------
  // The cockpit mic is hot only while this view is mounted AND the window has
  // focus (the trust anchor from §4.8: no always-on, no wake words).
  let windowFocused = $state(true);
  if (typeof document !== 'undefined') windowFocused = document.hasFocus();

  $effect(() => {
    if (windowFocused) void cockpitController.activate();
    else void cockpitController.deactivate();
  });
  onDestroy(() => void cockpitController.deactivate());

  // ---- open_session → navigate to the sessions view ------------------------
  // The open_session intent (voice or double-click) calls selectSession(), which
  // sets activeSdkSessionId. While the cockpit is active, react by navigating.
  let prevActive: string | null | undefined = undefined;
  $effect(() => {
    const id = $activeSdkSessionId;
    if (prevActive === undefined) {
      prevActive = id;
      return;
    }
    if (id && id !== prevActive && $cockpitActive) {
      navigation.setView('sessions');
    }
    prevActive = id;
  });

  // ---- Fleet board ---------------------------------------------------------
  // buildFleetRefs() is the single source of truth for board numbering. Touch
  // the underlying stores so this recomputes when the fleet or dismissals change.
  const fleetRefs = $derived.by(() => {
    void $sdkSessions;
    void $dismissedSessionIds;
    return cockpitController.buildFleetRefs();
  });

  const sessionsById = $derived(new Map($sdkSessions.map((s) => [s.id, s])));

  // Numbers stay per buildFleetRefs (createdAt order); blocked cards are pinned
  // first visually via a stable sort.
  const displayCards = $derived(
    [...fleetRefs].sort((a, b) => Number(b.isBlocked) - Number(a.isBlocked))
  );

  function focusCard(id: string) {
    focusedSessionId.set(id);
  }
  function openCard(id: string) {
    sdkSessions.selectSession(id);
    focusedSessionId.set(id);
  }

  function dismissBriefing() {
    fleetBriefing.set(null);
  }
</script>

<svelte:window
  onfocus={() => (windowFocused = true)}
  onblur={() => (windowFocused = false)}
/>

<div class="cockpit flex flex-col h-full bg-background overflow-hidden">
  <!-- Fleet briefing (status / what-needs-me) -->
  {#if $fleetBriefing}
    {@const b = $fleetBriefing}
    <div class="border-b border-border bg-surface px-4 py-3">
      <div class="flex items-center gap-3">
        <span class="text-xs font-semibold uppercase tracking-wide text-accent">
          {b.kind === 'what_needs_me' ? 'What needs me' : 'Fleet status'}
        </span>
        <div class="flex items-center gap-3 text-xs text-text-secondary">
          <span><span class="text-emerald-400 font-semibold">{b.counts.running}</span> running</span>
          <span><span class="text-red-400 font-semibold">{b.counts.blocked}</span> blocked</span>
          <span><span class="text-blue-400 font-semibold">{b.counts.done}</span> done</span>
          {#if b.counts.error > 0}
            <span><span class="text-red-400 font-semibold">{b.counts.error}</span> error</span>
          {/if}
        </div>
        <button
          class="ml-auto p-1 rounded hover:bg-surface-elevated text-text-muted hover:text-text-secondary transition-colors"
          onclick={dismissBriefing}
          title="Dismiss briefing"
          aria-label="Dismiss briefing"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {#if b.blocked.length > 0}
        <div class="mt-2 space-y-1">
          {#each b.blocked as item (item.sessionId)}
            <button
              class="w-full flex items-start gap-2 text-left rounded px-2 py-1 hover:bg-surface-elevated transition-colors"
              onclick={() => focusCard(item.sessionId)}
            >
              <span class="shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full bg-red-400"></span>
              <span class="text-xs text-text-primary font-medium shrink-0">{item.label}</span>
              <span class="text-[11px] text-text-muted truncate">
                {item.reason === 'plan_approval'
                  ? 'plan approval'
                  : item.reason === 'question'
                    ? 'question'
                    : 'needs input'}{item.detail ? ` · ${item.detail}` : ''}
              </span>
            </button>
          {/each}
        </div>
      {:else}
        <p class="mt-2 text-xs text-text-muted">Nothing is blocked right now.</p>
      {/if}

      {#if b.done.length > 0}
        <div class="mt-2 flex flex-wrap gap-2">
          {#each b.done as item (item.sessionId)}
            <span
              class="text-[11px] text-text-muted rounded bg-surface-elevated px-2 py-0.5"
              title={item.outcome ?? ''}
            >
              {item.label}{item.outcome ? `: ${item.outcome}` : ''}
            </span>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Board + ledger rail -->
  <div class="flex-1 flex min-h-0">
    <div class="flex-1 overflow-y-auto p-4">
      {#if displayCards.length === 0}
        <div class="h-full flex flex-col items-center justify-center text-center gap-2">
          <p class="text-sm text-text-secondary">No active sessions on the board.</p>
          <p class="text-xs text-text-muted max-w-md">
            Say “new task …” or “dispatch …” to delegate work, or type a command below.
          </p>
        </div>
      {:else}
        <div class="cockpit-board grid gap-3">
          {#each displayCards as ref (ref.id)}
            <CockpitSessionCard
              {ref}
              session={sessionsById.get(ref.id)}
              focused={$focusedSessionId === ref.id}
              onFocus={() => focusCard(ref.id)}
              onOpen={() => openCard(ref.id)}
            />
          {/each}
        </div>
      {/if}
    </div>

    <CockpitLedger />
  </div>

  <!-- Dispatch drawer (slides above the command line while a draft is open) -->
  {#if $draft}
    <CockpitDispatchDrawer />
  {/if}

  <!-- Command line strip -->
  <CockpitCommandLine />
</div>

<style>
  .cockpit-board {
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    align-content: start;
  }
</style>
