<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { sessions, activeSessionId } from '$lib/stores/sessions';
  import { sdkSessions, activeSdkSessionId } from '$lib/stores/sdkSessions';
  import { settings, type SessionsViewLayout, type SessionsGridSize } from '$lib/stores/settings';
  import { navigation } from '$lib/stores/navigation';
  import type { DisplaySession } from '$lib/types/session';
  import { getStatusCategory } from '$lib/utils/sessionStatus';
  import {
    transformToDisplaySessions,
    fetchBranchesForSessions
  } from '$lib/composables/useDisplaySessions.svelte';
  import SessionCard from '$lib/components/SessionCard.svelte';

  let now = $state(Math.floor(Date.now() / 1000));
  let interval: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    interval = setInterval(() => {
      now = Math.floor(Date.now() / 1000);
    }, 1000);
  });

  onDestroy(() => {
    if (interval) clearInterval(interval);
  });

  // Layout and size settings
  let layout = $derived($settings.sessions_view?.layout || 'list');
  let gridColumns = $derived($settings.sessions_view?.grid_columns || 3);
  let cardSize = $derived($settings.sessions_view?.card_size || 'medium');

  // Combine sessions using shared utility
  let allSessions = $state<DisplaySession[]>([]);

  $effect(() => {
    const ptySessions = $sessions;
    const sdkSessionsList = $sdkSessions;
    const sortOrder = $settings.session_sort_order;

    const sorted = transformToDisplaySessions(ptySessions, sdkSessionsList, sortOrder);
    allSessions = sorted;

    // Fetch branches
    fetchBranchesForSessions(sorted, (updated) => {
      allSessions = updated;
    });
  });

  // Navigation and selection
  function goBack() {
    navigation.setView('sessions');
    goto('/');
  }

  function selectSession(session: DisplaySession) {
    if (session.type === 'pty') {
      activeSessionId.set(session.id);
      activeSdkSessionId.set(null);
    } else {
      activeSdkSessionId.set(session.id);
      activeSessionId.set(null);
      sdkSessions.markAsRead(session.id);
    }
    navigation.setView('sessions');
    goto('/');
  }

  function closeSession(session: DisplaySession, event: MouseEvent) {
    event.stopPropagation();
    if (session.type === 'pty') {
      sessions.closeSession(session.id);
      if ($activeSessionId === session.id) activeSessionId.set(null);
    } else {
      sdkSessions.closeSession(session.id);
      if ($activeSdkSessionId === session.id) activeSdkSessionId.set(null);
    }
  }

  function isSessionActive(session: DisplaySession): boolean {
    if (session.type === 'pty') return $activeSessionId === session.id;
    return $activeSdkSessionId === session.id;
  }

  // Layout controls
  async function setLayout(newLayout: SessionsViewLayout) {
    const newSettings = {
      ...$settings,
      sessions_view: {
        ...$settings.sessions_view,
        layout: newLayout
      }
    };
    await settings.save(newSettings);
  }

  async function setCardSize(newSize: SessionsGridSize) {
    const newSettings = {
      ...$settings,
      sessions_view: {
        ...$settings.sessions_view,
        card_size: newSize
      }
    };
    await settings.save(newSettings);
  }

  async function setGridColumns(cols: number) {
    const newSettings = {
      ...$settings,
      sessions_view: {
        ...$settings.sessions_view,
        grid_columns: cols
      }
    };
    await settings.save(newSettings);
  }

  // Statistics using shared status categories
  let activeCount = $derived(
    allSessions.filter((s) => getStatusCategory(s.status) === 'active').length
  );
  let pendingCount = $derived(
    allSessions.filter((s) => getStatusCategory(s.status) === 'pending').length
  );
  let doneCount = $derived(
    allSessions.filter((s) => getStatusCategory(s.status) === 'ready').length
  );
  let errorCount = $derived(
    allSessions.filter((s) => getStatusCategory(s.status) === 'error').length
  );
  let unreadCount = $derived(allSessions.filter((s) => s.unread).length);

  // Grid style
  let gridStyle = $derived.by(() => {
    if (layout === 'grid') {
      return `grid-template-columns: repeat(${gridColumns}, minmax(0, 1fr))`;
    }
    return '';
  });
</script>

<div class="sessions-view flex-1 flex flex-col overflow-hidden bg-background">
  <!-- Action bar with stats and layout controls -->
  <div class="flex items-center justify-between px-4 py-2 border-b border-border bg-surface">
    <div class="flex items-center gap-3">
      <button
        class="p-1 hover:bg-surface-elevated rounded transition-colors"
        onclick={goBack}
        title="Back to main view"
      >
        <svg
          class="w-4 h-4 text-text-secondary"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M15 19l-7-7 7-7"
          />
        </svg>
      </button>

      <!-- Stats badges -->
      <div class="flex items-center gap-2">
        <span class="px-2 py-0.5 text-xs font-medium bg-surface-elevated rounded text-text-muted">
          {allSessions.length} total
        </span>
        {#if pendingCount > 0}
          <span
            class="px-2 py-0.5 text-xs font-medium bg-amber-500/20 text-amber-400 rounded flex items-center gap-1"
          >
            <div class="w-1.5 h-1.5 bg-amber-400 rounded-full"></div>
            {pendingCount} pending
          </span>
        {/if}
        {#if activeCount > 0}
          <span
            class="px-2 py-0.5 text-xs font-medium bg-emerald-500/20 text-emerald-400 rounded flex items-center gap-1"
          >
            <div class="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"></div>
            {activeCount} active
          </span>
        {/if}
        {#if unreadCount > 0}
          <span class="px-2 py-0.5 text-xs font-medium bg-blue-500/20 text-blue-400 rounded">
            {unreadCount} unread
          </span>
        {/if}
        {#if errorCount > 0}
          <span class="px-2 py-0.5 text-xs font-medium bg-red-500/20 text-red-400 rounded">
            {errorCount} errors
          </span>
        {/if}
      </div>
    </div>

    <!-- Layout controls -->
    <div class="flex items-center gap-3">
      <!-- Card size selector (only for grid) -->
      {#if layout === 'grid'}
        <div class="flex items-center gap-1 bg-surface-elevated rounded p-0.5">
          <button
            class="px-2 py-1 text-xs rounded transition-colors"
            class:bg-accent={cardSize === 'small'}
            class:text-white={cardSize === 'small'}
            class:text-text-muted={cardSize !== 'small'}
            onclick={() => setCardSize('small')}
            title="Small cards"
          >
            S
          </button>
          <button
            class="px-2 py-1 text-xs rounded transition-colors"
            class:bg-accent={cardSize === 'medium'}
            class:text-white={cardSize === 'medium'}
            class:text-text-muted={cardSize !== 'medium'}
            onclick={() => setCardSize('medium')}
            title="Medium cards"
          >
            M
          </button>
          <button
            class="px-2 py-1 text-xs rounded transition-colors"
            class:bg-accent={cardSize === 'large'}
            class:text-white={cardSize === 'large'}
            class:text-text-muted={cardSize !== 'large'}
            onclick={() => setCardSize('large')}
            title="Large cards"
          >
            L
          </button>
        </div>

        <!-- Column count selector -->
        <div class="flex items-center gap-1 bg-surface-elevated rounded p-0.5">
          {#each [2, 3, 4, 5] as cols}
            <button
              class="px-2 py-1 text-xs rounded transition-colors"
              class:bg-accent={gridColumns === cols}
              class:text-white={gridColumns === cols}
              class:text-text-muted={gridColumns !== cols}
              onclick={() => setGridColumns(cols)}
              title="{cols} columns"
            >
              {cols}
            </button>
          {/each}
        </div>
      {/if}

      <!-- Layout toggle -->
      <div class="flex items-center gap-1 bg-surface-elevated rounded p-0.5">
        <button
          class="p-1.5 rounded transition-colors"
          class:bg-accent={layout === 'list'}
          class:text-white={layout === 'list'}
          class:text-text-muted={layout !== 'list'}
          onclick={() => setLayout('list')}
          title="List view"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M4 6h16M4 10h16M4 14h16M4 18h16"
            />
          </svg>
        </button>
        <button
          class="p-1.5 rounded transition-colors"
          class:bg-accent={layout === 'grid'}
          class:text-white={layout === 'grid'}
          class:text-text-muted={layout !== 'grid'}
          onclick={() => setLayout('grid')}
          title="Grid view"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"
            />
          </svg>
        </button>
      </div>
    </div>
  </div>

  <div class="flex-1 overflow-y-auto p-4">
    {#if allSessions.length === 0}
      <div class="flex flex-col items-center justify-center h-full text-text-muted">
        <svg
          class="w-16 h-16 mb-4 opacity-50"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1"
            d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        <p class="text-lg mb-2">No sessions yet</p>
        <p class="text-sm">Record a voice prompt to start a new session</p>
      </div>
    {:else if layout === 'list'}
      <!-- List layout -->
      <div class="max-w-4xl mx-auto space-y-2">
        {#each allSessions as session (session.id)}
          <SessionCard
            {session}
            size={cardSize}
            isActive={isSessionActive(session)}
            {now}
            showLatestMessage={$settings.show_latest_message_preview}
            showSessionSummary={$settings.show_session_summary}
            promptRows={$settings.session_prompt_rows}
            responseRows={$settings.session_response_rows}
            onselect={() => selectSession(session)}
            onclose={(e) => closeSession(session, e)}
          />
        {/each}
      </div>
    {:else}
      <!-- Grid layout -->
      <div class="grid gap-3" style={gridStyle}>
        {#each allSessions as session (session.id)}
          <SessionCard
            {session}
            size={cardSize}
            isActive={isSessionActive(session)}
            {now}
            showLatestMessage={$settings.show_latest_message_preview}
            showSessionSummary={$settings.show_session_summary}
            promptRows={$settings.session_prompt_rows}
            responseRows={$settings.session_response_rows}
            onselect={() => selectSession(session)}
            onclose={(e) => closeSession(session, e)}
          />
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .sessions-view {
    user-select: none;
  }
</style>
