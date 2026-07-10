<script lang="ts">
  import {
    cockpitController,
    cockpitMicState,
    cockpitMicError,
    cockpitPartialTranscript,
    lastInterpretation,
    pendingConfirm,
    CONFIRM_TIMEOUT_MS,
  } from '$lib/cockpit';

  let typed = $state('');

  // Ticking clock so the pending-confirm countdown stays live.
  let now = $state(Date.now());
  $effect(() => {
    if (!$pendingConfirm) return;
    const timer = setInterval(() => (now = Date.now()), 200);
    return () => clearInterval(timer);
  });

  const secondsLeft = $derived.by(() => {
    if (!$pendingConfirm) return 0;
    return Math.max(0, Math.ceil(($pendingConfirm.expiresAt - now) / 1000));
  });
  const confirmProgress = $derived.by(() => {
    if (!$pendingConfirm) return 0;
    const remaining = Math.max(0, $pendingConfirm.expiresAt - now);
    return Math.min(100, (remaining / CONFIRM_TIMEOUT_MS) * 100);
  });

  // Mic status → label + dot colour class.
  const micLabel = $derived.by(() => {
    switch ($cockpitMicState) {
      case 'listening':
        return 'Listening';
      case 'starting':
        return 'Starting…';
      case 'suspended':
        return 'Yielded (recording)';
      case 'error':
        return 'Mic error';
      default:
        return 'Mic off';
    }
  });
  const micDotClass = $derived.by(() => {
    switch ($cockpitMicState) {
      case 'listening':
        return 'bg-emerald-400';
      case 'starting':
        return 'bg-yellow-400';
      case 'suspended':
        return 'bg-amber-400';
      case 'error':
        return 'bg-red-400';
      default:
        return 'bg-text-muted';
    }
  });

  function submitTyped(event: SubmitEvent) {
    event.preventDefault();
    const text = typed.trim();
    if (!text) return;
    typed = '';
    void cockpitController.handleUtterance(text);
  }

  function confirmYes() {
    void cockpitController.handleUtterance('yes');
  }
  function confirmNo() {
    void cockpitController.handleUtterance('no');
  }
</script>

<div class="cockpit-command-line border-t border-border bg-surface">
  <!-- Pending destructive-action confirmation (prominent) -->
  {#if $pendingConfirm}
    <div class="border-b border-red-500/40 bg-red-500/15 px-4 py-2">
      <div class="flex items-center gap-3">
        <span class="text-xs font-semibold text-red-300">Confirm:</span>
        <span class="text-sm text-text-primary flex-1 min-w-0 truncate">
          {$pendingConfirm.label}
        </span>
        <span class="text-xs font-mono tabular-nums text-red-300">{secondsLeft}s</span>
        <button
          class="px-3 py-1 text-xs font-semibold rounded bg-red-600 hover:bg-red-500 text-white transition-colors"
          onclick={confirmYes}
        >
          Yes
        </button>
        <button
          class="px-3 py-1 text-xs font-medium rounded bg-surface-elevated hover:bg-border text-text-secondary transition-colors"
          onclick={confirmNo}
        >
          No
        </button>
      </div>
      <div class="mt-1.5 h-0.5 w-full rounded bg-red-500/20 overflow-hidden">
        <div class="h-full bg-red-400 transition-[width] duration-200" style="width: {confirmProgress}%"></div>
      </div>
    </div>
  {/if}

  <div class="flex items-center gap-3 px-4 py-2.5">
    <!-- Mic state -->
    <div class="flex items-center gap-1.5 shrink-0" title={$cockpitMicError ?? micLabel}>
      <div class="relative">
        <div class="w-2.5 h-2.5 rounded-full {micDotClass}"></div>
        {#if $cockpitMicState === 'listening'}
          <div class="absolute inset-0 w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping opacity-75"></div>
        {/if}
      </div>
      <span class="text-xs font-medium text-text-secondary">{micLabel}</span>
    </div>

    <div class="h-4 w-px bg-border shrink-0"></div>

    <!-- Live partial + interpretation -->
    <div class="flex-1 min-w-0 flex items-center gap-2">
      {#if $cockpitPartialTranscript}
        <span class="text-sm text-text-primary italic truncate">{$cockpitPartialTranscript}</span>
      {:else if $lastInterpretation}
        {@const interp = $lastInterpretation}
        <span
          class="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full text-[11px] font-bold {interp.ok
            ? 'bg-emerald-500/20 text-emerald-400'
            : 'bg-red-500/20 text-red-400'}"
        >
          {interp.ok ? '✓' : '✗'}
        </span>
        <span class="text-xs text-text-muted truncate min-w-0">
          {#if interp.ok}
            <span class="text-text-secondary">“{interp.heard}”</span>
            <span class="text-text-muted"> → </span>
            <span class="text-text-primary">{interp.intentLabel}</span>
          {:else}
            <span class="text-red-400">didn't catch that:</span>
            <span class="text-text-secondary">“{interp.heard}”</span>
          {/if}
        </span>
      {:else}
        <span class="text-xs text-text-muted italic">Speak a command, or type below…</span>
      {/if}
    </div>

    <!-- Typed fallback -->
    <form class="shrink-0" onsubmit={submitTyped}>
      <input
        type="text"
        bind:value={typed}
        placeholder="Type a command (Enter)"
        class="w-64 px-2.5 py-1.5 text-sm bg-surface-elevated border border-border rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
        aria-label="Cockpit command input"
      />
    </form>
  </div>
</div>
