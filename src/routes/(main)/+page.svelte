<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
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
  import { repos, activeRepo } from '$lib/stores/repos';
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

  // Constants
  const PROMPT_PREVIEW_LENGTH = 80;

  // Initialize composables (page-specific)
  const sidebar = useSidebarResize();

  // Current view from navigation store
  let currentView = $derived($navigation.mainView);

  // Reference to SdkView for focusing prompt input
  let sdkViewRef: { focusPromptInput: () => void } | undefined;

  // Computed values for the active SDK session header
  let activeSdkRepoName = $derived(
    !$activeSdkSession?.cwd || $activeSdkSession?.cwd === '.'
      ? ''
      : $activeSdkSession?.cwd?.split(/[/\\]/).pop() || $activeSdkSession?.cwd || ''
  );

  let activeSdkFirstPrompt = $derived(() => {
    const firstUserMessage = $activeSdkSession?.messages.find((m) => m.type === 'user');
    if (!firstUserMessage?.content) return null;
    const content = firstUserMessage.content.trim();
    if (content.length <= PROMPT_PREVIEW_LENGTH) return content;
    return content.slice(0, PROMPT_PREVIEW_LENGTH) + '...';
  });

  // Refresh current branch metadata when active SDK session changes.
  let lastRefreshedBranchSessionKey = '';
  $effect(() => {
    const session = $activeSdkSession;
    const key = session ? `${session.id}:${session.cwd}` : '';
    if (key && key !== lastRefreshedBranchSessionKey) {
      lastRefreshedBranchSessionKey = key;
      void sdkSessions.refreshSessionBranch(session.id);
    }
    if (!key) {
      lastRefreshedBranchSessionKey = '';
    }
  });

  // Listen for focus-sdk-prompt events from the layout
  function onFocusSdkPrompt() {
    tick().then(() => sdkViewRef?.focusPromptInput());
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

<div class="main-content flex-1 flex overflow-hidden">
  <aside
    class="sidebar border-r border-border bg-surface flex flex-col relative"
    style="width: {sidebar.width}px; min-width: {sidebar.minWidth}px; max-width: {sidebar.maxWidth}px;"
  >
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
          initialCwd={activeSession.cwd || $activeRepo?.path || ''}
          initialPlanMode={activeSession.planMode?.isActive || false}
          initialReadOnlyMode={activeSession.readOnlyMode || false}
          initialDraftPrompt={activeSession.draftPrompt || ''}
          initialDraftImages={activeSession.draftImages || []}
          isRecordingForSetup={$isRecordingForSetup}
          onStart={(config) => handleSetupSessionStart(sessionId, config)}
          onDraftChange={(prompt, images) =>
            sdkSessions.updateDraft(
              sessionId,
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
