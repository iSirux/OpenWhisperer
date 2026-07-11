<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { isRecording } from '$lib/stores/recording';
  import SessionPanes from '$lib/components/SessionPanes.svelte';
  import SessionList from '$lib/components/SessionList.svelte';
  import Start from '$lib/components/Start.svelte';
  import SessionPendingView from '$lib/components/SessionPendingView.svelte';
  import ArchiveView from '$lib/components/ArchiveView.svelte';
  import NotionKanban from '$lib/components/NotionKanban.svelte';
  import PileList from '$lib/components/PileList.svelte';
  import PileDetailView from '$lib/components/PileDetailView.svelte';
  import CockpitView from '$lib/components/cockpit/CockpitView.svelte';

  // Refactored components
  import SdkSessionHeader from '$lib/components/SdkSessionHeader.svelte';
  import SessionSidebarHeader from '$lib/components/SessionSidebarHeader.svelte';
  import SessionSetupView from '$lib/components/SessionSetupView.svelte';
  import RepositoryRail from '$lib/components/RepositoryRail.svelte';
  import RepositoryView from '$lib/components/RepositoryView.svelte';
  import RepoIssuesView from '$lib/components/RepoIssuesView.svelte';

  // Composables (page-specific only)
  import { useSidebarResize } from '$lib/composables/useSidebarResize.svelte';

  // Stores
  import {
    sdkSessions,
    activeSdkSessionId,
    activeSdkSession,
    type EffortLevel,
    type SdkImageContent,
  } from '$lib/stores/sdkSessions';
  import { settings } from '$lib/stores/settings';
  import { repos, activeRepo, findRepoById } from '$lib/stores/repos';
  import { navigation } from '$lib/stores/navigation';
  import { paneLayout, visibleSessionIds } from '$lib/stores/panes';
  import { pile, sidebarTab, pileCount, selectedPileItem, selectedPileItemId } from '$lib/stores/pile';
  import {
    activeExecution,
    activeExecutionId,
  } from '$lib/stores/sequenceExecutions';
  import { sequences } from '$lib/stores/sequences';
  import SequenceSessionView from '$lib/components/sequences/SequenceSessionView.svelte';

  // Global stores/services
  import { recordingFlow, isRecordingForSetup } from '$lib/stores/recordingFlow';
  import {
    handleRepoSelectionForSession,
    handleSetupSessionStart,
  } from '$lib/stores/transcriptProcessor';
  import { isEditableElement } from '$lib/utils/hotkeys';

  // Initialize composables (page-specific)
  const sidebar = useSidebarResize();

  // Current view from navigation store
  let currentView = $derived($navigation.mainView);

  // No Voice Mode: the pile is a voice-recording inbox, so hide it entirely.
  const noVoice = $derived($settings.system.voice_mode_disabled);

  // Selecting a session clears the pile selection (they share the main pane)
  $effect(() => {
    if ($activeSdkSessionId) {
      selectedPileItemId.set(null);
    }
  });

  // When No Voice Mode is on, force the sidebar back to Sessions and drop any
  // stale pile selection so it can't occupy the main pane.
  $effect(() => {
    if (noVoice) {
      sidebarTab.set('sessions');
      selectedPileItemId.set(null);
    }
  });
  let currentRepoId = $derived($navigation.selectedRepoId);
  let repositoryAddMode = $derived($navigation.repositoryAddMode);

  // Reference to the multi-pane container; the focused pane's SdkView is resolved
  // on demand via getFocusedSdkViewRef() for focus + hold-to-record routing.
  let sessionPanesRef:
    | {
        getFocusedSdkViewRef: () => {
          focusPromptInput: () => void;
          startInlineRecording: () => Promise<void>;
          stopInlineRecording: () => Promise<void>;
          startSendRecording: () => Promise<void>;
          stopSendRecording: () => Promise<void>;
        } | null;
      }
    | undefined;
  let isHoldingSpaceForInlineRecording = $state(false);
  /** Whether the current page-level hold is the Shift+Space record-and-send variant. */
  let holdSpaceIsSendVariant = false;

  // Show the multi-pane conversation area when any pane holds a session, or when
  // the user has split into multiple panes (even if the focused one is empty).
  let showSessionPanes = $derived($visibleSessionIds.size > 0 || $paneLayout.panes.length > 1);
  // Focused-session setup / pending states still take over the whole main pane.
  let activeSetupState = $derived($activeSdkSession?.status === 'setup');
  let activePendingState = $derived(
    $activeSdkSession?.status === 'pending_repo' || $activeSdkSession?.status === 'initializing'
  );

  // Computed values for the active SDK session header
  let activeSdkRepoName = $derived.by(() => {
    const session = $activeSdkSession;
    if (!session) return '';
    // Resolve from stable repoId first (handles worktrees correctly)
    if (session.repoId) {
      const repo = findRepoById($repos.list, session.repoId);
      if (repo) return repo.name;
    }
    // Fallback: derive from cwd path
    if (!session.cwd || session.cwd === '.') return '';
    return session.cwd.split(/[/\\]/).pop() || session.cwd;
  });

  let activeSdkFirstPrompt = $derived(() => {
    const firstUserMessage = $activeSdkSession?.messages.find((m) => m.type === 'user');
    if (!firstUserMessage?.content) return null;
    return firstUserMessage.content.trim() || null;
  });

  // Refresh current branch metadata when active SDK session changes.
  let lastRefreshedBranchSessionKey = '';
  $effect(() => {
    const session = $activeSdkSession;
    if (!session) {
      lastRefreshedBranchSessionKey = '';
      return;
    }

    const key = `${session.id}:${session.cwd}`;
    if (key !== lastRefreshedBranchSessionKey) {
      lastRefreshedBranchSessionKey = key;
      void sdkSessions.refreshSessionBranch(session.id);
    }
  });

  // Listen for focus-sdk-prompt events from the layout
  function onFocusSdkPrompt() {
    tick().then(() => sessionPanesRef?.getFocusedSdkViewRef()?.focusPromptInput());
  }

  function isInteractiveTarget(target: EventTarget | null): boolean {
    if (isEditableElement(target)) return true;
    const element = target as HTMLElement | null;
    if (!element) return false;
    return Boolean(
      element.closest(
        'button, a, summary, [role="button"], [role="link"], [data-disable-space-inline-recording]'
      )
    );
  }

  function canUseHoldSpaceInlineRecording(event: KeyboardEvent): boolean {
    if (!$settings.audio.hold_space_to_record_inline) return false;
    if (event.code !== 'Space') return false;
    // Shift selects the record-and-send variant; other modifiers are ignored.
    if (event.altKey || event.ctrlKey || event.metaKey) return false;
    if (isInteractiveTarget(event.target)) return false;
    if (!$activeSdkSession) return false;
    if (currentView !== 'sessions') return false;
    if ($activeSdkSession.status === 'pending_repo' || $activeSdkSession.status === 'initializing' || $activeSdkSession.status === 'setup') {
      return false;
    }
    return !!sessionPanesRef?.getFocusedSdkViewRef();
  }

  async function handleInlineRecordingSpaceDown(event: KeyboardEvent) {
    // Swallow key-repeats while a hold is live so Space doesn't also scroll.
    if (isHoldingSpaceForInlineRecording && event.code === 'Space') {
      event.preventDefault();
      return;
    }
    if (event.repeat) return;
    if (!canUseHoldSpaceInlineRecording(event)) return;
    if ($isRecording) return;

    event.preventDefault();
    isHoldingSpaceForInlineRecording = true;
    holdSpaceIsSendVariant = event.shiftKey;

    try {
      const view = sessionPanesRef?.getFocusedSdkViewRef();
      if (holdSpaceIsSendVariant) await view?.startSendRecording();
      else await view?.startInlineRecording();
      if (!isHoldingSpaceForInlineRecording && $isRecording) {
        // Released before start settled — stop through the same variant.
        if (holdSpaceIsSendVariant) await view?.stopSendRecording();
        else await view?.stopInlineRecording();
      }
    } catch (error) {
      isHoldingSpaceForInlineRecording = false;
      console.error('[sessions-page] Failed to start inline hold-to-record:', error);
    }
  }

  async function stopInlineRecordingFromSpaceHold() {
    if (!isHoldingSpaceForInlineRecording) return;
    isHoldingSpaceForInlineRecording = false;

    try {
      const view = sessionPanesRef?.getFocusedSdkViewRef();
      if (holdSpaceIsSendVariant) await view?.stopSendRecording();
      else await view?.stopInlineRecording();
    } catch (error) {
      console.error('[sessions-page] Failed to stop inline hold-to-record:', error);
    }
  }

  async function handleInlineRecordingSpaceUp(event: KeyboardEvent) {
    if (!isHoldingSpaceForInlineRecording) return;
    if (event.code !== 'Space') return;

    event.preventDefault();
    await stopInlineRecordingFromSpaceHold();
  }

  onMount(() => {
    // Listen for focus prompt events dispatched by the layout
    window.addEventListener('app:focus-sdk-prompt', onFocusSdkPrompt);
  });

  onDestroy(() => {
    sidebar.cleanup();
    window.removeEventListener('app:focus-sdk-prompt', onFocusSdkPrompt);
  });

  // ==================== Page-specific event handlers ====================

  function handlePendingRepoSelection(index: number, editedPrompt?: string) {
    const session = $activeSdkSession;
    if (!session || session.status !== 'pending_repo') return;
    handleRepoSelectionForSession(session.id, index, editedPrompt);
  }

  async function handlePendingSessionCancel() {
    if (!$activeSdkSessionId) return;
    console.log('[session] User cancelled pending session');
    await sdkSessions.closeSession($activeSdkSessionId);
    activeSdkSessionId.set(null);
  }

  function handleSessionClose() {
    if ($activeSdkSessionId) {
      sdkSessions.closeSession($activeSdkSessionId);
      activeSdkSessionId.set(null);
    }
  }

  function showSessionsView() {
    navigation.setView('sessions');
  }

  function handleSetupSessionCancel(sessionId: string) {
    sdkSessions.cancelSetupSession(sessionId);
    activeSdkSessionId.set(null);
  }

  /**
   * Demote a New Session draft into the pile: save the assembled prompt (plus any
   * captured screenshot, model/effort/repo) as an unprocessed pile item, then tear
   * down the setup session and switch to the pile tab.
   */
  function handleSetupToPile(
    sessionId: string,
    config: {
      prompt: string;
      images?: SdkImageContent[];
      model: string;
      effortLevel: EffortLevel;
      cwd: string;
    }
  ) {
    const prompt = config.prompt?.trim();
    if (!prompt) return;

    const repo = config.cwd && config.cwd !== '.'
      ? $repos.list.find((r) => r.path === config.cwd)
      : undefined;

    pile.addRecording({
      transcript: prompt,
      process: false,
      // Pile items carry a single screenshot; only forward a genuine screenshot capture.
      screenshot: config.images?.find((img) => img.source === 'screenshot'),
      repoId: repo?.id,
      model: config.model,
      effortLevel: config.effortLevel ?? undefined,
    });

    sdkSessions.cancelSetupSession(sessionId);
    activeSdkSessionId.set(null);
    sidebarTab.set('pile');
  }
</script>

<svelte:window
  onkeydown={handleInlineRecordingSpaceDown}
  onkeyup={handleInlineRecordingSpaceUp}
  onblur={stopInlineRecordingFromSpaceHold}
/>

<div class="main-content flex-1 flex overflow-hidden">
  {#if currentView === 'cockpit'}
    <div class="border-r border-border bg-surface flex shrink-0 overflow-hidden">
      <RepositoryRail
        currentRepoId={null}
        {currentView}
      />
    </div>
    <main class="flex-1 flex flex-col overflow-hidden">
      <CockpitView />
    </main>
  {:else if currentView === 'notion'}
    <div class="border-r border-border bg-surface flex shrink-0 overflow-hidden">
      <RepositoryRail
        currentRepoId={null}
        {currentView}
      />
    </div>
    <main class="flex-1 flex flex-col overflow-hidden">
      <NotionKanban />
    </main>
  {:else}
    <aside
      class="sidebar border-r border-border bg-surface flex relative overflow-hidden"
      style="width: {sidebar.width}px; min-width: {sidebar.minWidth}px; max-width: {sidebar.maxWidth}px;"
    >
      <RepositoryRail
        currentRepoId={currentView === 'repository' || currentView === 'issues' ? currentRepoId : null}
        showAddMode={currentView === 'repository' && repositoryAddMode}
        {currentView}
      />
      <div class="sidebar-main flex-1 min-w-0 flex flex-col overflow-hidden">
        <SessionSidebarHeader
          sdkSessions={$sdkSessions}
          {currentView}
          markSessionsUnread={$settings.mark_sessions_unread}
          onShowSessions={showSessionsView}
        />
        {#if !noVoice}
          <div class="flex border-b border-border px-1.5 pt-1 gap-1 shrink-0">
            <button
              class="flex-1 px-2 py-1 text-xs font-medium rounded-t transition-colors {$sidebarTab === 'sessions'
                ? 'bg-surface-elevated text-text-primary border border-b-0 border-border'
                : 'text-text-muted hover:text-text-secondary'}"
              onclick={() => sidebarTab.set('sessions')}
            >
              Sessions
            </button>
            <button
              class="flex-1 px-2 py-1 text-xs font-medium rounded-t transition-colors {$sidebarTab === 'pile'
                ? 'bg-surface-elevated text-text-primary border border-b-0 border-border'
                : 'text-text-muted hover:text-text-secondary'}"
              onclick={() => sidebarTab.set('pile')}
            >
              Pile{$pileCount > 0 ? ` (${$pileCount})` : ''}
            </button>
          </div>
        {/if}
        <div class="flex-1 overflow-hidden">
          {#if $sidebarTab === 'pile' && !noVoice}
            <PileList />
          {:else}
            <SessionList {currentView} />
          {/if}
        </div>
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="resize-handle absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-accent/50 transition-colors"
        class:bg-accent={sidebar.isResizing}
        onmousedown={sidebar.startResize}
      ></div>
    </aside>

    <main class="flex-1 flex flex-col overflow-hidden">
      {#if currentView === 'archive'}
        <ArchiveView onBack={() => navigation.showSessions()} />
      {:else if currentView === 'start'}
        <Start />
      {:else if currentView === 'sequences' && $activeExecution}
        <SequenceSessionView
          execution={$activeExecution}
          nodes={$sequences.find(s => s.id === $activeExecution.sequence_id)?.nodes ?? []}
        />
      {:else if currentView === 'repository'}
        <RepositoryView repoId={currentRepoId} showAddForm={repositoryAddMode} />
      {:else if currentView === 'issues'}
        <RepoIssuesView repoId={currentRepoId} />
      {:else if $selectedPileItem}
        <PileDetailView item={$selectedPileItem} />
      {:else if $activeSdkSession && activeSetupState}
      {@const activeSession = $activeSdkSession}
      {@const sessionId = activeSession.id}
        <SessionSetupView
          sessionId={sessionId}
          initialModel={activeSession.model}
          initialProvider={activeSession.provider}
          initialEffortLevel={activeSession.effortLevel}
          initialCwd={activeSession.setupRepoPath || activeSession.cwd || $activeRepo?.path || ''}
          initialWorktreeMode={activeSession.setupWorktreeMode || 'main'}
          initialWorktreePath={activeSession.setupWorktreePath || ''}
          initialDraftPrompt={activeSession.draftPrompt || ''}
          initialDraftImages={activeSession.draftImages || []}
          providerLocked={!!activeSession.forkedFromSessionId}
          forkedFromLabel={activeSession.forkedFromSessionLabel || ''}
          isRecordingForSetup={$isRecordingForSetup}
          onStart={(config) => handleSetupSessionStart(sessionId, config)}
          onSchedule={(config, window) =>
            handleSetupSessionStart(sessionId, { ...config, schedule: window })}
          onToPile={(config) => handleSetupToPile(sessionId, config)}
          onDraftChange={(targetSessionId, prompt, images) =>
            sdkSessions.updateDraft(
              targetSessionId,
              prompt,
              images.length > 0 ? images : undefined
            )}
          onStartRecording={recordingFlow.startRecordingForSetup}
          onStopRecording={recordingFlow.stopRecordingForSetup}
          onCancel={() => handleSetupSessionCancel(sessionId)}
        />
      {:else if $activeSdkSession && activePendingState}
      {@const activeSession = $activeSdkSession}
        <SdkSessionHeader
          sessionId={activeSession.id}
          sdkSessionId={activeSession.sdkSessionId}
          isQuerying={activeSession.status === 'querying' || activeSession.status === 'initializing'}
          createdAt={activeSession.createdAt}
          messages={activeSession.messages}
          isPending={true}
          repoName={activeSdkRepoName}
          repoId={activeSession.repoId}
          repoPath={activeSession.cwd}
          model={activeSession.model}
          effortLevel={activeSession.effortLevel}
          provider={activeSession.provider}
          autocompactEnabled={activeSession.autocompactEnabled ?? true}
          disableHooks={activeSession.disableHooks ?? false}
          createdBranch={activeSession.createdBranch}
          currentBranch={activeSession.currentBranch}
          changedFileCount={activeSession.changedFileCount}
          firstPrompt={activeSdkFirstPrompt()}
          nickname={activeSession.aiMetadata?.nickname}
          onClose={handleSessionClose}
          onCancel={handlePendingSessionCancel}
        />
        <div class="terminal-wrapper flex-1 overflow-hidden">
          <SessionPendingView
            status={activeSession.status as 'pending_repo' | 'initializing'}
            repos={$repos.list}
            pendingSelection={activeSession.pendingRepoSelection}
            pendingPrompt={activeSession.pendingPrompt}
            onSelectRepo={handlePendingRepoSelection}
            onCancel={handlePendingSessionCancel}
          />
        </div>
      {:else if showSessionPanes}
        {#if $activeSdkSession}
        {@const activeSession = $activeSdkSession}
          <SdkSessionHeader
            sessionId={activeSession.id}
            sdkSessionId={activeSession.sdkSessionId}
            isQuerying={activeSession.status === 'querying' || activeSession.status === 'initializing'}
            createdAt={activeSession.createdAt}
            messages={activeSession.messages}
            isPending={false}
            repoName={activeSdkRepoName}
            repoId={activeSession.repoId}
            repoPath={activeSession.cwd}
            model={activeSession.model}
            effortLevel={activeSession.effortLevel}
            provider={activeSession.provider}
            autocompactEnabled={activeSession.autocompactEnabled ?? true}
            disableHooks={activeSession.disableHooks ?? false}
            createdBranch={activeSession.createdBranch}
            currentBranch={activeSession.currentBranch}
            changedFileCount={activeSession.changedFileCount}
            firstPrompt={activeSdkFirstPrompt()}
            nickname={activeSession.aiMetadata?.nickname}
            onClose={handleSessionClose}
            onCancel={handlePendingSessionCancel}
          />
        {/if}
        <SessionPanes bind:this={sessionPanesRef} />
      {/if}
    </main>
  {/if}
</div>

<style>
  .terminal-wrapper {
    min-height: 0;
  }

  .resize-handle {
    padding-left: 3px;
    padding-right: 3px;
    margin-right: -3px;
    background-clip: content-box;
  }

  .resize-handle:hover,
  .resize-handle.bg-accent {
    background-color: var(--color-accent);
    opacity: 0.5;
  }

  .resize-handle.bg-accent {
    opacity: 1;
  }

  .sidebar {
    flex-shrink: 0;
  }
</style>
