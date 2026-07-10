<script lang="ts">
  import { ledger, type LedgerStatus } from '$lib/cockpit';

  let collapsed = $state(false);

  function statusClasses(status: LedgerStatus): string {
    switch (status) {
      case 'ok':
        return 'border-emerald-500/40 text-emerald-400';
      case 'rejected':
        return 'border-amber-500/40 text-amber-400';
      case 'error':
        return 'border-red-500/40 text-red-400';
      case 'pending-confirm':
        return 'border-cyan-500/40 text-cyan-400';
      case 'cancelled':
        return 'border-border text-text-muted';
      default:
        return 'border-border text-text-muted';
    }
  }

  function statusGlyph(status: LedgerStatus): string {
    switch (status) {
      case 'ok':
        return '✓';
      case 'rejected':
        return '✗';
      case 'error':
        return '!';
      case 'pending-confirm':
        return '?';
      case 'cancelled':
        return '–';
      default:
        return '·';
    }
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
</script>

<aside
  class="cockpit-ledger flex flex-col border-l border-border bg-surface transition-all shrink-0"
  class:w-72={!collapsed}
  class:w-10={collapsed}
>
  <div class="flex items-center gap-2 px-2 py-2 border-b border-border shrink-0">
    <button
      class="p-1 rounded hover:bg-surface-elevated text-text-muted hover:text-text-secondary transition-colors"
      onclick={() => (collapsed = !collapsed)}
      title={collapsed ? 'Expand ledger' : 'Collapse ledger'}
      aria-label={collapsed ? 'Expand ledger' : 'Collapse ledger'}
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d={collapsed ? 'M15 19l-7-7 7-7' : 'M9 5l7 7-7 7'}
        />
      </svg>
    </button>
    {#if !collapsed}
      <span class="text-xs font-semibold text-text-secondary">Ledger</span>
      <span class="text-[11px] text-text-muted ml-auto">{$ledger.length}</span>
    {/if}
  </div>

  {#if !collapsed}
    <div class="flex-1 overflow-y-auto">
      {#if $ledger.length === 0}
        <p class="px-3 py-4 text-xs text-text-muted italic">No commands yet.</p>
      {:else}
        <ul class="divide-y divide-border/50">
          {#each $ledger as entry (entry.id)}
            <li class="px-3 py-2">
              <div class="flex items-center gap-2">
                <span
                  class="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full border text-[10px] font-bold {statusClasses(
                    entry.status
                  )}"
                >
                  {statusGlyph(entry.status)}
                </span>
                <span class="text-[11px] text-text-primary truncate flex-1 min-w-0" title={entry.intentLabel}>
                  {entry.intentLabel}
                </span>
                <span class="text-[10px] text-text-muted font-mono shrink-0">{formatTime(entry.ts)}</span>
              </div>
              <p class="mt-0.5 pl-6 text-[11px] text-text-muted leading-snug truncate" title={'“' + entry.heard + '” — ' + entry.resultLabel}>
                <span class="italic">“{entry.heard}”</span>
                <span class="text-text-muted/70"> — {entry.resultLabel}</span>
              </p>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</aside>
