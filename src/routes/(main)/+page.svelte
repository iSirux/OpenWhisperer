<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { isRecording } from '$lib/stores/recording';
  import Terminal from '$lib/components/Terminal.svelte';
  import SdkView from '$lib/components/SdkView.svelte';
  import SessionList from '$lib/components/SessionList.svelte';
  import SessionHeader from '$lib/components/SessionHeader.svelte';
  import Start from '$lib/components/Start.svelte';
  import SessionPendingView from '$lib/components/SessionPendingView.svelte';
  import ArchiveView from '$lib/components/ArchiveView.svelte';

  // Refactored components
  import SdkSessionHeader from '$lib/components/SdkSessionHeader.svelte';
  import SessionSidebarHeader from '$lib/components/SessionSidebarHeader.svelte';
  import SessionSetupView from '$lib/components/SessionSetupView.svelte';
  import RepositoryRail from '$lib/components/RepositoryRail.svelte';
  import RepositoryView from '$lib/components/RepositoryView.svelte';

  // Composables (page-specific only)
  import { useSidebarResize } from '$lib/composables/useSidebarResize.svelte';

  // Stores
  import { sessions, activeSessionId, activeSession } from '$lib/stores/sessions';
  import {
    sdkSessions,
    activeSdkSessionId,
    activeSdkSession,
  } from '$lib/stores/sdkSessions';
  import { settings } from '$lib/stores/settings';
  import { repos, activeRepo, findRepoById } from '$lib/stores/repos';
  import { navigation } from '$lib/stores/navigation';
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
  let currentRepoId = $derived($navigation.selectedRepoId);
  let repositoryAddMode = $derived($navigation.repositoryAddMode);

  // Reference to SdkView for focusing prompt input
  let sdkViewRef:
    | {
        focusPromptInput: () => void;
        startInlineRecording: () => Promise<void>;
        stopInlineRecording: () => Promise<void>;
      }
    | undefined;
  let isHoldingSpaceForInlineRecording = $state(false);

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
    tick().then(() => sdkViewRef?.focusPromptInput());
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
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    if (isInteractiveTarget(event.target)) return false;
    if (!$activeSdkSession) return false;
    if (currentView !== 'sessions') return false;
    if ($activeSdkSession.status === 'pending_repo' || $activeSdkSession.status === 'initializing' || $activeSdkSession.status === 'setup') {
      return false;
    }
    return !!sdkViewRef;
  }

  async function handleInlineRecordingSpaceDown(event: KeyboardEvent) {
    if (event.repeat || isHoldingSpaceForInlineRecording) return;
    if (!canUseHoldSpaceInlineRecording(event)) return;
    if ($isRecording) return;

    event.preventDefault();
    isHoldingSpaceForInlineRecording = true;

    try {
      await sdkViewRef?.startInlineRecording();
      if (!isHoldingSpaceForInlineRecording && $isRecording) {
        await sdkViewRef?.stopInlineRecording();
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
      await sdkViewRef?.stopInlineRecording();
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
    sidebar.initFromSettings();

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
</script>

<svelte:window
  onkeydown={handleInlineRecordingSpaceDown}
  onkeyup={handleInlineRecordingSpaceUp}
  onblur={stopInlineRecordingFromSpaceHold}
/>

<div class="main-content flex-1 flex overflow-hidden">
  <aside
    class="sidebar border-r border-border bg-surface flex relative overflow-hidden"
    style="width: {sidebar.width}px; min-width: {sidebar.minWidth}px; max-width: {sidebar.maxWidth}px;"
  >
    <RepositoryRail
      currentRepoId={currentView === 'repository' ? currentRepoId : null}
      showAddMode={currentView === 'repository' && repositoryAddMode}
    />
    <div class="sidebar-main flex-1 min-w-0 flex flex-col overflow-hidden">
      <SessionSidebarHeader
        sessions={$sessions}
        sdkSessions={$sdkSessions}
        {currentView}
        markSessionsUnread={$settings.mark_sessions_unread}
        onShowSessions={showSessionsView}
      />
      <div class="flex-1 overflow-hidden">
        <SessionList {currentView} />
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
    {:else if $activeSdkSession}
      {@const activeSession = $activeSdkSession}
      {@const sessionId = activeSession.id}
      {@const isPendingState =
        activeSession.status === 'pending_repo' ||
        activeSession.status === 'initializing'}
      {@const isSetupState = activeSession.status === 'setup'}

      {#if isSetupState}
        <SessionSetupView
          sessionId={sessionId}
          initialModel={activeSession.model}
          initialProvider={activeSession.provider}
          initialEffortLevel={activeSession.effortLevel}
          initialCwd={activeSession.setupRepoPath || activeSession.cwd || $activeRepo?.path || ''}
          initialWorktreeMode={activeSession.setupWorktreeMode || 'main'}
          initialWorktreePath={activeSession.setupWorktreePath || ''}
          initialPlanMode={activeSession.planMode?.isActive || false}
          initialReadOnlyMode={activeSession.readOnlyMode || false}
          initialDraftPrompt={activeSession.draftPrompt || ''}
          initialDraftImages={activeSession.draftImages || []}
          providerLocked={!!activeSession.forkedFromSessionId}
          forkedFromLabel={activeSession.forkedFromSessionLabel || ''}
          isRecordingForSetup={$isRecordingForSetup}
          onStart={(config) => handleSetupSessionStart(sessionId, config)}
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
      {:else}
        <SdkSessionHeader
          createdAt={activeSession.createdAt}
          messages={activeSession.messages}
          isPending={isPendingState}
          repoName={activeSdkRepoName}
          repoId={activeSession.repoId}
          repoPath={activeSession.cwd}
          model={activeSession.model}
          effortLevel={activeSession.effortLevel}
          createdBranch={activeSession.createdBranch}
          currentBranch={activeSession.currentBranch}
          firstPrompt={activeSdkFirstPrompt()}
          onClose={handleSessionClose}
          onCancel={handlePendingSessionCancel}
        />

        {#if isPendingState}
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
        {:else}
          <div class="terminal-wrapper flex-1 overflow-hidden">
            {#key sessionId}
              <SdkView bind:this={sdkViewRef} sessionId={sessionId} />
            {/key}
          </div>
        {/if}
      {/if}
    {:else if $activeSession}
      <SessionHeader session={$activeSession} />
      <div class="terminal-wrapper flex-1 overflow-hidden">
        {#key $activeSession.id}
          <Terminal sessionId={$activeSession.id} />
        {/key}
      </div>
    {/if}
  </main>
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
