<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { sdkSessions, activeSdkSessionId } from '$lib/stores/sdkSessions';
  import { settings } from '$lib/stores/settings';
  import type { DisplaySession } from '$lib/types/session';
  import { isActivelyWorking } from '$lib/utils/sessionStatus';
  import { formatHotkeyForDisplay } from '$lib/utils/hotkeys';
  import { createAndActivateNewSession } from '$lib/utils/sessionCreation';
  import { selectDisplaySession } from '$lib/utils/sessionSelection';
  import {
    transformToDisplaySessions,
    fetchBranchesForSessions,
    getSdkSmartStatus
  } from '$lib/composables/useDisplaySessions.svelte';
  import {
    executions,
    activeExecutionId,
    closeExecution,
    loadExecutionHistory,
  } from '$lib/stores/sequenceExecutions';
  import { navigation } from '$lib/stores/navigation';
  import { archive } from '$lib/stores/archive';

  const archiveCount = archive.archiveCount;
  import SessionListItem from './SessionListItem.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';

  interface Props {
    currentView?: string;
  }

  let { currentView = 'sessions' }: Props = $props();

  // Load execution history and archive count on mount
  onMount(() => {
    loadExecutionHistory();
    archive.refreshCount();
  });

  // Timer for live duration updates
  let now = $state(Math.floor(Date.now() / 1000));
  let interval: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    interval = setInterval(() => {
      now = Math.floor(Date.now() / 1000);
    }, 1000);
  });

  onDestroy(() => {
    if (interval) clearInterval(interval);
    if (branchFetchTimeout) clearTimeout(branchFetchTimeout);
  });

  // Unified session list
  let allSessions = $state<DisplaySession[]>([]);

  // Track session IDs and repo paths to detect when sessions are added/removed or cwd changes
  let lastSessionKey = '';
  let branchFetchTimeout: ReturnType<typeof setTimeout> | null = null;

  // Reactively update sessions when stores change
  $effect(() => {
    const sdkSessionsList = $sdkSessions;
    const sortOrder = $settings.session_sort_order;
    const seqExecutions = $executions;

    const sorted = transformToDisplaySessions(sdkSessionsList, sortOrder, seqExecutions);

    // Preserve branch data from previous render (branches are fetched async and only on session list changes)
    // Use untrack to read allSessions without creating a reactive dependency on it,
    // otherwise writing allSessions below would re-trigger this effect infinitely.
    const previousSessions = untrack(() => allSessions);
    if (previousSessions.length > 0) {
      const branchMap = new Map(previousSessions.filter(s => s.branch).map(s => [s.id, s.branch]));
      if (branchMap.size > 0) {
        for (const s of sorted) {
          if (!s.branch && branchMap.has(s.id)) {
            s.branch = branchMap.get(s.id);
          }
        }
      }
    }
    allSessions = sorted;

    // Fetch branches when session list changes (add/remove) or when a session's cwd changes
    const currentSessionKey = sorted.map(s => `${s.id}:${s.repoPath || ''}`).sort().join(',');
    if (currentSessionKey !== lastSessionKey) {
      lastSessionKey = currentSessionKey;

      // Debounce branch fetching to avoid rapid IPC calls
      if (branchFetchTimeout) {
        clearTimeout(branchFetchTimeout);
      }
      branchFetchTimeout = setTimeout(() => {
        fetchBranchesForSessions(sorted, (updated) => {
          // Verify session list hasn't changed since we started
          const stillCurrentKey = updated.map(s => `${s.id}:${s.repoPath || ''}`).sort().join(',');
          if (stillCurrentKey === lastSessionKey) {
            allSessions = updated;
          }
        });
      }, 100);
    }
  });

  // Session creation - creates a setup session that appears in the list
  function createNewSession() {
    createAndActivateNewSession();
  }

  // Track active session IDs reactively for proper UI updates
  let currentActiveSdkSessionId = $state<string | null>(null);
  let currentActiveExecutionId = $state<string | null>(null);

  // Keep local state in sync with stores
  $effect(() => {
    currentActiveSdkSessionId = $activeSdkSessionId;
  });

  $effect(() => {
    currentActiveExecutionId = $activeExecutionId;
  });

  // Session selection (shared with the Ctrl+number hotkey in the layout)
  function selectSession(session: DisplaySession) {
    selectDisplaySession(session);
  }

  function isSessionActive(session: DisplaySession): boolean {
    if (session.type === 'sequence') {
      return currentView === 'sequences' && currentActiveExecutionId === session.id;
    }
    if (currentView !== 'sessions') return false;
    return currentActiveSdkSessionId === session.id;
  }

  // Confirmation dialog state
  let confirmDialog = $state<{
    show: boolean;
    sessionId: string;
    sessionType: 'sdk' | 'sequence';
  }>({ show: false, sessionId: '', sessionType: 'sdk' });

  function closeSession(session: DisplaySession, event: MouseEvent) {
    event.stopPropagation();

    if (session.type === 'sequence') {
      // For sequences, check if actively running
      if (isActivelyWorking(session.status)) {
        confirmDialog = { show: true, sessionId: session.id, sessionType: 'sequence' };
        return;
      }
      performClose(session.id, 'sequence');
      return;
    }

    // Check if session is actively working
    const sdkSession = $sdkSessions.find((s) => s.id === session.id);
    if (sdkSession) {
      const smartStatus = getSdkSmartStatus(sdkSession);
      if (isActivelyWorking(smartStatus.status)) {
        confirmDialog = { show: true, sessionId: session.id, sessionType: 'sdk' };
        return;
      }
    }

    // Close immediately if not working
    performClose(session.id, session.type);
  }

  // Pick the session to activate after closing the one at `sessionId`:
  // prefer the next one down the list, falling back to the previous.
  function findNextSession(sessionId: string): DisplaySession | null {
    const idx = allSessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) return null;
    for (let i = idx + 1; i < allSessions.length; i++) {
      if (allSessions[i].id !== sessionId) return allSessions[i];
    }
    for (let i = idx - 1; i >= 0; i--) {
      if (allSessions[i].id !== sessionId) return allSessions[i];
    }
    return null;
  }

  function performClose(sessionId: string, sessionType: 'sdk' | 'sequence') {
    // Was the closing session the one currently open? If so, we advance to the
    // next session in line rather than dropping the user on an empty view.
    const wasActive =
      sessionType === 'sdk'
        ? $activeSdkSessionId === sessionId
        : $activeExecutionId === sessionId;
    const nextSession = wasActive ? findNextSession(sessionId) : null;

    if (sessionType === 'sdk') {
      sdkSessions.closeSession(sessionId);
    } else {
      closeExecution(sessionId);
    }

    if (wasActive) {
      if (nextSession) {
        selectDisplaySession(nextSession);
      } else if (sessionType === 'sdk' && $activeSdkSessionId === sessionId) {
        activeSdkSessionId.set(null);
      }
    }
  }

  function confirmClose() {
    performClose(confirmDialog.sessionId, confirmDialog.sessionType);
    confirmDialog = { show: false, sessionId: '', sessionType: 'sdk' };
  }

  function cancelClose() {
    confirmDialog = { show: false, sessionId: '', sessionType: 'sdk' };
  }

  // Right-click context menu (pin/unpin; SDK sessions only)
  let contextMenu = $state<{ x: number; y: number; session: DisplaySession } | null>(null);

  function openContextMenu(session: DisplaySession, event: MouseEvent) {
    if (session.type !== 'sdk') return;
    event.preventDefault();
    event.stopPropagation();
    contextMenu = { x: event.clientX, y: event.clientY, session };
  }

  function togglePin(sessionId: string) {
    sdkSessions.togglePin(sessionId);
    contextMenu = null;
  }

  function handleContextMenuKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && contextMenu) {
      contextMenu = null;
    }
  }
</script>

<div class="session-list-container h-full flex flex-col">
  <div class="flex-1 overflow-y-auto session-list">
    <!-- New Session Button -->
    <button
      class="w-full p-3 border-b border-border text-left hover:bg-surface-elevated transition-colors flex items-center gap-2 text-accent"
      onclick={createNewSession}
      title={`New Session (${formatHotkeyForDisplay($settings.hotkeys.new_session)})`}
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
      </svg>
      <span class="text-sm font-medium">New Session</span>
      <span class="ml-auto text-xs text-text-muted font-mono">
        {formatHotkeyForDisplay($settings.hotkeys.new_session)}
      </span>
    </button>

    <!-- Sessions (SDK + Sequences mixed) -->
    {#if allSessions.length === 0}
      <div class="p-4 text-center text-text-muted text-sm">
        <svg
          class="w-8 h-8 mx-auto mb-2 opacity-50"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.5"
            d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        No sessions yet
      </div>
    {:else}
      {#each allSessions as session, index (session.id)}
        <SessionListItem
          {session}
          hotkeyNumber={index < 9 ? index + 1 : undefined}
          isActive={isSessionActive(session)}
          {now}
          showLatestMessage={$settings.show_latest_message_preview}
          showSessionSummary={$settings.show_session_summary}
          promptRows={2}
          responseRows={2}
          onselect={() => selectSession(session)}
          onclose={(e) => closeSession(session, e)}
          ontogglepin={session.type === 'sdk' ? () => togglePin(session.id) : undefined}
          oncontextmenu={(e) => openContextMenu(session, e)}
        />
      {/each}
    {/if}
  </div>

  <!-- Archive link at bottom of sidebar -->
  {#if $archiveCount > 0}
    <button
      class="w-full p-2.5 border-t border-border text-left hover:bg-surface-elevated transition-colors flex items-center gap-2 shrink-0 {currentView === 'archive' ? 'text-accent bg-accent/5' : 'text-text-muted hover:text-text-secondary'}"
      onclick={() => navigation.showArchive()}
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
      </svg>
      <span class="text-sm">Archive ({$archiveCount})</span>
    </button>
  {/if}
</div>

<svelte:window onkeydown={handleContextMenuKeydown} />

{#if contextMenu}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="context-overlay"
    onclick={() => (contextMenu = null)}
    oncontextmenu={(e) => {
      e.preventDefault();
      contextMenu = null;
    }}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="context-menu"
      style="left: {contextMenu.x}px; top: {contextMenu.y}px;"
      onclick={(e) => e.stopPropagation()}
    >
      <button class="context-item" onclick={() => togglePin(contextMenu!.session.id)}>
        <svg
          class="w-3.5 h-3.5"
          fill={contextMenu.session.pinned ? "currentColor" : "none"}
          stroke="currentColor"
          stroke-width="2"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"
          />
        </svg>
        {contextMenu.session.pinned ? 'Unpin session' : 'Pin session'}
      </button>
    </div>
  </div>
{/if}

<ConfirmDialog
  show={confirmDialog.show}
  title={confirmDialog.sessionType === 'sequence' ? 'Close running sequence?' : 'Close active session?'}
  message={confirmDialog.sessionType === 'sequence'
    ? 'This sequence is still running. Are you sure you want to close it?'
    : 'This session is still working. Are you sure you want to close it?'}
  confirmLabel={confirmDialog.sessionType === 'sequence' ? 'Close sequence' : 'Close session'}
  onconfirm={confirmClose}
  oncancel={cancelClose}
/>

<style>
  .session-list {
    scrollbar-width: thin;
    scrollbar-color: var(--color-border) transparent;
  }

  .context-overlay {
    position: fixed;
    inset: 0;
    z-index: 50;
  }

  .context-menu {
    position: fixed;
    min-width: 10rem;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    padding: 0.25rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }

  .context-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border-radius: 0.375rem;
    font-size: 0.8rem;
    color: var(--color-text-primary);
    text-align: left;
    transition: background-color 0.1s;
  }

  .context-item:hover {
    background: var(--color-border);
  }
</style>
