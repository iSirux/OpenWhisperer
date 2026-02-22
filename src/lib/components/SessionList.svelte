<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { sessions, activeSessionId } from '$lib/stores/sessions';
  import { sdkSessions, activeSdkSessionId, settingsToStoreEffort } from '$lib/stores/sdkSessions';
  import { settings, activeRepo } from '$lib/stores/settings';
  import type { DisplaySession } from '$lib/types/session';
  import { isActivelyWorking } from '$lib/utils/sessionStatus';
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
  import SessionListItem from './SessionListItem.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';

  interface Props {
    currentView?: string;
  }

  let { currentView = 'sessions' }: Props = $props();

  // Load execution history on mount
  onMount(() => {
    loadExecutionHistory();
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

  // Track session IDs to detect when sessions are added/removed (not just updated)
  let lastSessionIds = '';
  let branchFetchTimeout: ReturnType<typeof setTimeout> | null = null;

  // Reactively update sessions when stores change
  $effect(() => {
    const ptySessions = $sessions;
    const sdkSessionsList = $sdkSessions;
    const sortOrder = $settings.session_sort_order;
    const seqExecutions = $executions;

    const sorted = transformToDisplaySessions(ptySessions, sdkSessionsList, sortOrder, seqExecutions);
    allSessions = sorted;

    // Only fetch branches when session list changes (add/remove), not on every update
    const currentSessionIds = sorted.map(s => s.id).sort().join(',');
    if (currentSessionIds !== lastSessionIds) {
      lastSessionIds = currentSessionIds;

      // Debounce branch fetching to avoid rapid IPC calls
      if (branchFetchTimeout) {
        clearTimeout(branchFetchTimeout);
      }
      branchFetchTimeout = setTimeout(() => {
        fetchBranchesForSessions(sorted, (updated) => {
          // Verify session list hasn't changed since we started
          const stillCurrentIds = updated.map(s => s.id).sort().join(',');
          if (stillCurrentIds === lastSessionIds) {
            allSessions = updated;
          }
        });
      }, 100);
    }
  });

  // Session creation - creates a setup session that appears in the list
  function createNewSession() {
    if ($settings.terminal_mode === 'Sdk') {
      const model = $settings.default_model;
      const effortLevel = settingsToStoreEffort($settings.default_effort_level);
      // Create a setup session - user will configure it before starting
      const sessionId = sdkSessions.createSetupSession(model, effortLevel, false);
      activeSdkSessionId.set(sessionId);
      activeSessionId.set(null);
      window.dispatchEvent(new CustomEvent('switch-to-sessions'));
    } else {
      // For PTY mode, still create interactive session directly
      sessions.createInteractiveSession().then(sessionId => {
        activeSessionId.set(sessionId);
        activeSdkSessionId.set(null);
        window.dispatchEvent(new CustomEvent('switch-to-sessions'));
      }).catch(error => {
        console.error('Failed to create session:', error);
      });
    }
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

  // Session selection
  function selectSession(session: DisplaySession) {
    if (session.type === 'sequence') {
      activeExecutionId.set(session.id);
      activeSessionId.set(null);
      activeSdkSessionId.set(null);
      navigation.showSequences();
    } else {
      activeExecutionId.set(null);
      if (session.type === 'pty') {
        activeSessionId.set(session.id);
        activeSdkSessionId.set(null);
      } else {
        activeSdkSessionId.set(session.id);
        activeSessionId.set(null);
        sdkSessions.markAsRead(session.id);
      }
      window.dispatchEvent(new CustomEvent('switch-to-sessions'));
    }
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

<div class="session-list h-full overflow-y-auto">
  <!-- New Session Button -->
  <button
    class="w-full p-3 border-b border-border text-left hover:bg-surface-elevated transition-colors flex items-center gap-2 text-accent"
    onclick={createNewSession}
  >
    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
    </svg>
    <span class="text-sm font-medium">
      {$settings.terminal_mode === 'Sdk' ? 'New Session' : 'New Terminal'}
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
    {#each allSessions as session (session.id)}
      <SessionListItem
        {session}
        isActive={isSessionActive(session)}
        {now}
        showLatestMessage={$settings.show_latest_message_preview}
        promptRows={$settings.session_prompt_rows}
        responseRows={$settings.session_response_rows}
        onselect={() => selectSession(session)}
        onclose={(e) => closeSession(session, e)}
      />
    {/each}
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
