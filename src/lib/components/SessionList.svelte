<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { sessions, activeSessionId } from '$lib/stores/sessions';
  import { sdkSessions, activeSdkSessionId } from '$lib/stores/sdkSessions';
  import { settings, getEffectiveTerminalMode } from '$lib/stores/settings';
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
    const ptySessions = $sessions;
    const sdkSessionsList = $sdkSessions;
    const sortOrder = $settings.session_sort_order;
    const seqExecutions = $executions;

    const sorted = transformToDisplaySessions(ptySessions, sdkSessionsList, sortOrder, seqExecutions);

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
  let currentActiveSessionId = $state<string | null>(null);
  let currentActiveSdkSessionId = $state<string | null>(null);
  let currentActiveExecutionId = $state<string | null>(null);

  // Keep local state in sync with stores
  $effect(() => {
    currentActiveSessionId = $activeSessionId;
  });

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
    return session.type === 'pty'
      ? currentActiveSessionId === session.id
      : currentActiveSdkSessionId === session.id;
  }

  // Confirmation dialog state
  let confirmDialog = $state<{
    show: boolean;
    sessionId: string;
    sessionType: 'pty' | 'sdk' | 'sequence';
  }>({ show: false, sessionId: '', sessionType: 'pty' });

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
    if (session.type === 'pty') {
      const ptySession = $sessions.find((s) => s.id === session.id);
      if (ptySession && isActivelyWorking(ptySession.status)) {
        confirmDialog = { show: true, sessionId: session.id, sessionType: 'pty' };
        return;
      }
    } else {
      const sdkSession = $sdkSessions.find((s) => s.id === session.id);
      if (sdkSession) {
        const smartStatus = getSdkSmartStatus(sdkSession);
        if (isActivelyWorking(smartStatus.status)) {
          confirmDialog = { show: true, sessionId: session.id, sessionType: 'sdk' };
          return;
        }
      }
    }

    // Close immediately if not working
    performClose(session.id, session.type);
  }

  function performClose(sessionId: string, sessionType: 'pty' | 'sdk' | 'sequence') {
    if (sessionType === 'pty') {
      sessions.closeSession(sessionId);
      if ($activeSessionId === sessionId) {
        activeSessionId.set(null);
      }
    } else if (sessionType === 'sdk') {
      sdkSessions.closeSession(sessionId);
      if ($activeSdkSessionId === sessionId) {
        activeSdkSessionId.set(null);
      }
    } else {
      closeExecution(sessionId);
    }
  }

  function confirmClose() {
    performClose(confirmDialog.sessionId, confirmDialog.sessionType);
    confirmDialog = { show: false, sessionId: '', sessionType: 'pty' };
  }

  function cancelClose() {
    confirmDialog = { show: false, sessionId: '', sessionType: 'pty' };
  }
</script>

<div class="session-list-container h-full flex flex-col">
  <div class="flex-1 overflow-y-auto session-list">
    <!-- New Session Button -->
    <button
      class="w-full p-3 border-b border-border text-left hover:bg-surface-elevated transition-colors flex items-center gap-2 text-accent"
      onclick={createNewSession}
      title={`${
        getEffectiveTerminalMode($settings) === 'Sdk' ? 'New Session' : 'New Terminal'
      } (${formatHotkeyForDisplay($settings.hotkeys.new_session)})`}
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
      </svg>
      <span class="text-sm font-medium">
        {getEffectiveTerminalMode($settings) === 'Sdk' ? 'New Session' : 'New Terminal'}
      </span>
      <span class="ml-auto text-xs text-text-muted font-mono">
        {formatHotkeyForDisplay($settings.hotkeys.new_session)}
      </span>
    </button>

    <!-- Sessions (PTY + SDK + Sequences mixed) -->
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
</style>
