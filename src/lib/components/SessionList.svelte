<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { sdkSessions, activeSdkSessionId, previousActiveSessionId } from '$lib/stores/sdkSessions';
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
  import {
    sessionRepoFilter,
    filterDisplaySessions,
    clearRepoFilter,
  } from '$lib/stores/sessionRepoFilter';
  import {
    sessionListGrouped,
    groupDisplaySessions,
    flattenSessionGroups,
    collapsedSessionGroups,
    toggleGroupCollapsed,
    worktreeCollapseKey,
    worktreeHasHeader,
  } from '$lib/stores/sessionGrouping';
  import { repos } from '$lib/stores/repos';
  import RepoIcon from './RepoIcon.svelte';

  const archiveCount = archive.archiveCount;
  import SessionListItem from './SessionListItem.svelte';
  import SessionRepoFilter from './SessionRepoFilter.svelte';
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

  // Repo filter applied to the rendered list. The Ctrl+1..9 hotkey in the main
  // layout applies the same filter so the number badges stay accurate.
  const filteredSessions = $derived(
    filterDisplaySessions(allSessions, $sessionRepoFilter, $repos.list)
  );

  // Grouped view mode: repo groups with worktree subgroups. The flattened
  // order — collapsed groups excluded — is what the number badges (and the
  // layout's Ctrl+1..9) run through.
  const sessionGroups = $derived(
    $sessionListGrouped ? groupDisplaySessions(filteredSessions, $repos.list) : null
  );
  const collapsedKeys = $derived(new Set($collapsedSessionGroups));
  const visibleSessions = $derived(
    sessionGroups ? flattenSessionGroups(sessionGroups, collapsedKeys) : filteredSessions
  );
  const hotkeyNumberById = $derived(
    new Map(visibleSessions.slice(0, 9).map((s, i) => [s.id, i + 1]))
  );
  const hiddenByFilterCount = $derived(allSessions.length - filteredSessions.length);

  // Git changed-file count per worktree checkout dir, shown as a badge on the
  // worktree subheaders (same badge as the repository rail, but per-worktree
  // instead of summed). Main checkouts resolve to the repo path.
  let changedCounts = $state<Record<string, number>>({});

  const worktreePaths = $derived.by(() => {
    if (!sessionGroups) return [] as string[];
    const paths = new Set<string>();
    for (const group of sessionGroups) {
      for (const worktree of group.worktrees) {
        const path = worktree.path || group.repo?.path;
        if (path) paths.add(path);
      }
    }
    return [...paths];
  });

  async function refreshChangedCounts(paths: string[]) {
    await Promise.all(
      paths.map(async (path) => {
        try {
          changedCounts[path] = await invoke<number>('get_git_changed_count', {
            repoPath: path,
          });
        } catch {
          changedCounts[path] = 0;
        }
      })
    );
  }

  // Refetch when the set of visible worktree paths changes (session streaming
  // rebuilds the groups constantly, so key on the joined paths, not identity),
  // then poll so the badges stay live.
  let lastWorktreePathsKey = '';
  $effect(() => {
    const key = worktreePaths.join('\n');
    if (key === lastWorktreePathsKey) return;
    lastWorktreePathsKey = key;
    void refreshChangedCounts(untrack(() => worktreePaths));
  });

  onMount(() => {
    const timer = setInterval(() => {
      if (worktreePaths.length > 0) void refreshChangedCounts(worktreePaths);
    }, 15000);
    return () => clearInterval(timer);
  });

  // Index of the first unpinned session, used to draw a divider between the
  // pinned group (which floats to the top) and the rest. Only meaningful when
  // there is at least one pinned session above it (flat view only — grouping
  // supersedes the pinned block).
  const firstUnpinnedIndex = $derived.by(() => {
    if (sessionGroups) return -1;
    const hasPinned = visibleSessions.length > 0 && visibleSessions[0].pinned;
    if (!hasPinned) return -1;
    const idx = visibleSessions.findIndex((s) => !s.pinned);
    return idx > 0 ? idx : -1;
  });

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
  // prefer the next one down the (filtered) list, falling back to the previous.
  // Used for sequence executions; SDK sessions use MRU history instead.
  function findNextSession(sessionId: string): DisplaySession | null {
    const idx = visibleSessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) return null;
    for (let i = idx + 1; i < visibleSessions.length; i++) {
      if (visibleSessions[i].id !== sessionId) return visibleSessions[i];
    }
    for (let i = idx - 1; i >= 0; i--) {
      if (visibleSessions[i].id !== sessionId) return visibleSessions[i];
    }
    return null;
  }

  function performClose(sessionId: string, sessionType: 'sdk' | 'sequence') {
    // Was the closing session the one currently open? If so, we fall back to
    // another session rather than dropping the user on an empty view.
    const wasActive =
      sessionType === 'sdk'
        ? $activeSdkSessionId === sessionId
        : $activeExecutionId === sessionId;

    if (sessionType === 'sdk') {
      // Return to the session viewed just before this one (MRU). Compute before
      // closing while the history entry still exists.
      const prev = wasActive ? previousActiveSessionId(sessionId) : null;
      sdkSessions.closeSession(sessionId);
      if (wasActive && $activeSdkSessionId === sessionId) {
        activeSdkSessionId.set(prev);
      }
    } else {
      const nextSession = wasActive ? findNextSession(sessionId) : null;
      closeExecution(sessionId);
      if (wasActive && nextSession) {
        selectDisplaySession(nextSession);
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

    <!-- Repository filter (toggle chips; only repos with open sessions) -->
    <SessionRepoFilter sessions={allSessions} />

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
    {:else if filteredSessions.length === 0}
      <div class="p-4 text-center text-text-muted text-sm">
        All {allSessions.length} session{allSessions.length === 1 ? '' : 's'} hidden by the repository filter
        <button class="block mx-auto mt-2 text-xs text-accent hover:underline" onclick={clearRepoFilter}>
          Show all
        </button>
      </div>
    {:else}
      {#snippet sessionItem(session: DisplaySession)}
        <SessionListItem
          {session}
          hotkeyNumber={hotkeyNumberById.get(session.id)}
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
      {/snippet}

      {#if sessionGroups}
        {#each sessionGroups as group (group.key)}
          {@const groupCollapsed = collapsedKeys.has(group.key)}
          {@const groupSessions = group.worktrees.flatMap((w) => w.sessions)}
          {@const groupActiveCount = groupSessions.filter((s) => isActivelyWorking(s.status)).length}
          {@const groupUnreadCount = groupSessions.filter((s) => s.unread).length}
          <button
            class="group-header"
            title={group.repo?.path}
            aria-expanded={!groupCollapsed}
            onclick={() => toggleGroupCollapsed(group.key)}
          >
            <svg class="w-3 h-3 shrink-0 chevron {groupCollapsed ? 'chevron-collapsed' : ''}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
              <path d="M6 9l6 6 6-6" />
            </svg>
            <RepoIcon repo={group.repo} size="xs" />
            <span class="truncate">{group.name}</span>
            <span class="ml-auto flex items-center gap-1.5 shrink-0">
              {#if groupActiveCount > 0}
                <span class="flex items-center gap-1">
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                  <span class="text-[11px] text-emerald-400 font-medium">{groupActiveCount}</span>
                </span>
              {/if}
              {#if $settings.mark_sessions_unread && groupUnreadCount > 0}
                <span class="px-1.5 py-0.5 text-[10px] font-medium bg-blue-500 text-white rounded-full">
                  {groupUnreadCount}
                </span>
              {/if}
              <span class="group-count">{group.sessionCount}</span>
            </span>
          </button>
          {#if !groupCollapsed}
            {#each group.worktrees as worktree (worktree.key)}
              <!-- Subheader (and collapsibility) only when there's something to
                   distinguish: several checkouts, or a lone non-main one -->
              {@const hasHeader = worktreeHasHeader(group, worktree)}
              {@const wtKey = worktreeCollapseKey(group.key, worktree.key)}
              {@const wtCollapsed = hasHeader && collapsedKeys.has(wtKey)}
              {#if hasHeader}
                {@const wtActiveCount = worktree.sessions.filter((s) => isActivelyWorking(s.status)).length}
                {@const wtUnreadCount = worktree.sessions.filter((s) => s.unread).length}
                {@const wtChangedCount = changedCounts[worktree.path || group.repo?.path || ''] ?? 0}
                <button
                  class="worktree-header"
                  title={worktree.path || group.repo?.path}
                  aria-expanded={!wtCollapsed}
                  onclick={() => toggleGroupCollapsed(wtKey)}
                >
                  <svg class="w-2.5 h-2.5 shrink-0 chevron {wtCollapsed ? 'chevron-collapsed' : ''}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                  <svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                    <path d="M6 3v12" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                  <span class="truncate">{worktree.label}</span>
                  <span class="ml-auto flex items-center gap-1.5 shrink-0">
                    {#if wtChangedCount > 0}
                      <span
                        class="wt-change-badge"
                        title="{wtChangedCount} file{wtChangedCount === 1 ? '' : 's'} changed"
                      >
                        {wtChangedCount > 99 ? '99+' : wtChangedCount}
                      </span>
                    {/if}
                    {#if wtActiveCount > 0}
                      <span class="flex items-center gap-1">
                        <span class="w-1 h-1 rounded-full bg-emerald-400"></span>
                        <span class="text-[10px] text-emerald-400 font-medium">{wtActiveCount}</span>
                      </span>
                    {/if}
                    {#if $settings.mark_sessions_unread && wtUnreadCount > 0}
                      <span class="px-1 py-px text-[9px] font-medium bg-blue-500 text-white rounded-full">
                        {wtUnreadCount}
                      </span>
                    {/if}
                    <span class="group-count">{worktree.sessions.length}</span>
                  </span>
                </button>
              {/if}
              {#if !wtCollapsed}
                {#each worktree.sessions as session (session.id)}
                  {@render sessionItem(session)}
                {/each}
              {/if}
            {/each}
          {/if}
        {/each}
      {:else}
        {#each visibleSessions as session, index (session.id)}
          {#if index === firstUnpinnedIndex}
            <div class="pin-divider" role="separator" aria-label="Pinned sessions above"></div>
          {/if}
          {@render sessionItem(session)}
        {/each}
      {/if}
      {#if hiddenByFilterCount > 0}
        <div class="p-2 text-center text-[11px] text-text-muted">
          {hiddenByFilterCount} session{hiddenByFilterCount === 1 ? '' : 's'} hidden by repository filter
        </div>
      {/if}
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

  /* Grouped view: repository group header (click to collapse/expand) */
  .group-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    width: 100%;
    padding: 0.375rem 0.75rem 0.25rem;
    font-size: 0.7rem;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
    color: var(--color-text-secondary);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface-elevated);
    transition: color 0.1s;
  }

  .group-header:hover {
    color: var(--color-text-primary);
  }

  .group-count {
    font-weight: 500;
    color: var(--color-text-muted);
  }

  /* Grouped view: worktree subheader within a repository group */
  .worktree-header {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    width: 100%;
    padding: 0.3rem 0.75rem 0.15rem 1.25rem;
    font-size: 0.65rem;
    text-align: left;
    cursor: pointer;
    color: var(--color-text-muted);
    transition: color 0.1s;
  }

  .worktree-header:hover {
    color: var(--color-text-secondary);
  }

  /* Same amber changed-files badge as the repository rail, inline-sized */
  .wt-change-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 0.9rem;
    height: 0.9rem;
    padding: 0 0.2rem;
    box-sizing: border-box;
    font-size: 0.58rem;
    font-weight: 700;
    line-height: 1;
    color: #1a1205;
    background: rgb(251, 191, 36);
    border-radius: 999px;
  }

  .chevron {
    transition: transform 0.15s;
  }

  .chevron-collapsed {
    transform: rotate(-90deg);
  }

  /* Separates the pinned group (floated to the top) from the rest of the list */
  .pin-divider {
    height: 0;
    margin: 0.25rem 0.75rem;
    border-top: 1px solid var(--color-border);
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
