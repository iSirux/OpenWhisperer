<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { settings } from '$lib/stores/settings';
  interface Session {
    id: string;
    status: string;
    unread?: boolean;
  }

  interface Props {
    sdkSessions: Session[];
    currentView: string;
    markSessionsUnread: boolean;
    onShowSessions: () => void;
  }

  let {
    sdkSessions,
    currentView,
    markSessionsUnread,
    onShowSessions,
  }: Props = $props();

  const totalCount = $derived(sdkSessions.length);
  const unreadCount = $derived(sdkSessions.filter(s => s.unread).length);

  const activeCount = $derived(
    sdkSessions.filter(s => ['querying', 'initializing'].includes(s.status)).length
  );

  const currentPath = $derived($page.url.pathname);
  const isOnSequences = $derived(currentPath.startsWith('/sequences'));
  const isOnUsage = $derived(currentPath.startsWith('/usage'));

  function openCommandCenter() {
    goto('/sessions-view');
  }

  function toggleSequences() {
    if (isOnSequences) {
      goto('/');
      return;
    }
    goto('/sequences');
  }

  function openUsage() {
    goto('/usage');
  }
</script>

<div class="px-3 py-2 border-b border-border flex items-center justify-between gap-2 overflow-hidden">
  <button
    class="h-8 shrink-0 px-2 flex items-center"
    onclick={onShowSessions}
    aria-current={currentView === 'sessions' ? 'page' : undefined}
  >
    <div class="flex items-center gap-2">
      {#if totalCount > 0}
        <div class="flex items-center gap-1">
          {#if activeCount > 0}
            <div class="flex items-center gap-1">
              <div class="w-1.5 h-1.5 rounded-full bg-emerald-400"></div>
              <span class="text-[11px] text-emerald-400 font-medium">{activeCount}</span>
            </div>
          {/if}
        </div>
      {/if}
      <div class="flex items-center gap-2">
        {#if markSessionsUnread && unreadCount > 0}
          <span class="px-1.5 py-0.5 text-[10px] font-medium bg-blue-500 text-white rounded-full">
            {unreadCount}
          </span>
        {/if}
      </div>
    </div>
  </button>
  <div class="flex items-center gap-1 overflow-hidden">
    {#if $settings.system.dev_mode}
      <button
        class={`h-8 px-2.5 flex items-center gap-1.5 rounded text-[11px] font-medium border transition-colors ${
          isOnSequences
            ? 'bg-accent/15 border-accent/40 text-accent'
            : 'bg-surface-elevated border-border text-text-secondary hover:bg-border'
        }`}
        onclick={toggleSequences}
        title="Sequences"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <span>Sequences</span>
      </button>
    {/if}
    <button
      class="h-8 w-8 flex items-center justify-center hover:bg-surface-elevated rounded transition-colors text-text-muted hover:text-text-primary"
      class:bg-surface-elevated={isOnUsage}
      class:text-accent={isOnUsage}
      onclick={openUsage}
      title="Usage"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 3h18v12a2 2 0 01-2 2H5a2 2 0 01-2-2V3zm6 18l3-3 3 3" />
      </svg>
    </button>
    <button
      class="h-8 w-8 flex items-center justify-center hover:bg-surface-elevated rounded transition-colors text-text-muted hover:text-accent"
      onclick={openCommandCenter}
      title="Open Sessions Command Center"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
      </svg>
    </button>
  </div>
</div>
