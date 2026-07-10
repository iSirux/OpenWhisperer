<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { PaneGroup, Pane, PaneResizer } from "paneforge";
  import SdkView from "./SdkView.svelte";
  import {
    paneLayout,
    visibleSessionIds,
    panes,
    setSessionPanesOnScreen,
    MAX_PANES,
  } from "$lib/stores/panes";
  import { sdkSessions } from "$lib/stores/sdkSessions";
  import {
    getShortModelName,
    getModelBadgeBgColor,
    getModelTextColor,
  } from "$lib/utils/modelColors";
  import {
    getStatusBgColor,
    isStatusAnimating,
  } from "$lib/utils/sessionStatus";

  /** Minimal shape of the SdkView instance the page needs for focus + hold-to-record. */
  type SdkViewInstance = {
    focusPromptInput: () => void;
    startInlineRecording: () => Promise<void>;
    stopInlineRecording: () => Promise<void>;
    startSendRecording: () => Promise<void>;
    stopSendRecording: () => Promise<void>;
  };

  /** DnD payload type shared with SessionListItem (keep in sync). */
  const SESSION_DND_TYPE = "application/x-openwhisperer-session-id";

  // Per-pane SdkView instance refs, keyed by pane id. bind:this clears entries to
  // undefined on unmount, so stale keys are harmless.
  let sdkViewRefs: Record<string, SdkViewInstance | undefined> = {};

  // Tell the panes store when paned sessions are actually visible, so completion
  // side-effects (unread markers) fire while the user is on settings/other routes.
  onMount(() => {
    setSessionPanesOnScreen(true);
    return () => setSessionPanesOnScreen(false);
  });

  const multi = $derived($paneLayout.panes.length > 1);

  // Drag/drop UI state
  let isSessionDragging = $state(false);
  let dragOverPaneId = $state<string | null>(null);
  let dragOverEdge = $state(false);

  function sessionById(id: string) {
    return $sdkSessions.find((s) => s.id === id) ?? null;
  }

  function firstPromptOf(session: { messages: { type: string; content?: string }[] }) {
    const m = session.messages.find((msg) => msg.type === "user");
    return m?.content?.trim() || null;
  }

  function paneTitle(session: ReturnType<typeof sessionById>): string {
    if (!session) return "Empty";
    return session.aiMetadata?.name || firstPromptOf(session) || "Session";
  }

  /** Returns the focused pane's SdkView instance so the page can drive focus / hold-to-record. */
  export function getFocusedSdkViewRef(): SdkViewInstance | null {
    const focusedId = get(paneLayout).focusedPaneId;
    return sdkViewRefs[focusedId] ?? null;
  }

  function dragHasSession(e: DragEvent): boolean {
    return !!e.dataTransfer?.types.includes(SESSION_DND_TYPE);
  }

  function handleWindowDragStart(e: DragEvent) {
    if (dragHasSession(e)) isSessionDragging = true;
  }

  function handleWindowDragEnd() {
    isSessionDragging = false;
    dragOverPaneId = null;
    dragOverEdge = false;
  }

  function handlePaneDragOver(e: DragEvent, paneId: string) {
    if (!dragHasSession(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    dragOverPaneId = paneId;
  }

  function handlePaneDragLeave(e: DragEvent, paneId: string) {
    const related = e.relatedTarget as Node | null;
    const current = e.currentTarget as HTMLElement;
    if (related && current.contains(related)) return;
    if (dragOverPaneId === paneId) dragOverPaneId = null;
  }

  function handlePaneDrop(e: DragEvent, paneId: string) {
    const sessionId = e.dataTransfer?.getData(SESSION_DND_TYPE);
    dragOverPaneId = null;
    isSessionDragging = false;
    if (!sessionId) return;
    e.preventDefault();
    panes.assignToPane(paneId, sessionId);
  }

  function handleEdgeDragOver(e: DragEvent) {
    if (!dragHasSession(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    dragOverEdge = true;
  }

  function handleEdgeDragLeave(e: DragEvent) {
    const related = e.relatedTarget as Node | null;
    const current = e.currentTarget as HTMLElement;
    if (related && current.contains(related)) return;
    dragOverEdge = false;
  }

  function handleEdgeDrop(e: DragEvent) {
    const sessionId = e.dataTransfer?.getData(SESSION_DND_TYPE);
    dragOverEdge = false;
    isSessionDragging = false;
    if (!sessionId) return;
    e.preventDefault();
    const currentPanes = get(paneLayout).panes;
    const lastPaneId = currentPanes[currentPanes.length - 1]?.id;
    const newId = panes.splitPane(lastPaneId);
    if (newId) panes.assignToPane(newId, sessionId);
  }
</script>

<svelte:window ondragstart={handleWindowDragStart} ondragend={handleWindowDragEnd} />

<div class="panes-root">
  <PaneGroup direction="horizontal" autoSaveId="sdk-session-panes" class="pane-group">
    {#each $paneLayout.panes as pane, i (pane.id)}
      {#if i > 0}
        <PaneResizer class="pane-resizer" />
      {/if}
      <Pane minSize={15} order={i} class="pane">
        {@const isFocused = pane.id === $paneLayout.focusedPaneId}
        {@const session = pane.sessionId ? sessionById(pane.sessionId) : null}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="pane-inner"
          class:focused={isFocused && multi}
          class:drop-target={dragOverPaneId === pane.id}
          onmousedowncapture={() => panes.focusPane(pane.id)}
          onfocusincapture={() => panes.focusPane(pane.id)}
          ondragover={(e) => handlePaneDragOver(e, pane.id)}
          ondragleave={(e) => handlePaneDragLeave(e, pane.id)}
          ondrop={(e) => handlePaneDrop(e, pane.id)}
        >
          {#if multi}
            <div class="pane-chrome">
              <div class="pane-chrome-left">
                {#if !session?.aiMetadata?.needsInteraction}
                  <div class="relative flex-shrink-0">
                    <div class="w-2 h-2 rounded-full {getStatusBgColor(session?.status ?? 'new')}"></div>
                    {#if session && isStatusAnimating(session.status)}
                      <div
                        class="absolute inset-0 w-2 h-2 rounded-full {getStatusBgColor(session.status)} animate-ping opacity-75"
                      ></div>
                    {/if}
                  </div>
                {/if}
                <span class="pane-title" title={paneTitle(session)}>{paneTitle(session)}</span>
                {#if session?.model}
                  <span
                    class="px-1.5 py-0.5 text-[10px] font-medium {getModelBadgeBgColor(session.model)} {getModelTextColor(session.model)} rounded flex-shrink-0"
                  >
                    {getShortModelName(session.model)}
                  </span>
                {/if}
              </div>
              <button
                class="pane-close p-0.5 rounded transition-colors text-text-muted hover:text-error hover:bg-border"
                onclick={() => panes.closePane(pane.id)}
                title="Close pane"
                aria-label="Close pane"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          {/if}
          <div class="pane-body">
            {#if pane.sessionId}
              {#key pane.sessionId}
                <SdkView sessionId={pane.sessionId} bind:this={sdkViewRefs[pane.id]} />
              {/key}
            {:else}
              <div class="pane-empty">
                <div class="text-center">
                  <svg class="w-14 h-14 mx-auto mb-4 text-text-muted opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM10 4v16" />
                  </svg>
                  <p class="text-sm">Select a session from the sidebar,</p>
                  <p class="text-sm">or drag one here</p>
                </div>
              </div>
            {/if}
          </div>
        </div>
      </Pane>
    {/each}
  </PaneGroup>

  {#if isSessionDragging && $paneLayout.panes.length < MAX_PANES}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="split-dropzone"
      class:active={dragOverEdge}
      ondragover={handleEdgeDragOver}
      ondragleave={handleEdgeDragLeave}
      ondrop={handleEdgeDrop}
    >
      <div class="split-hint">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM12 4v16" />
        </svg>
      </div>
    </div>
  {/if}
</div>

<style>
  .panes-root {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  :global(.panes-root .pane-group) {
    height: 100%;
    width: 100%;
  }

  :global(.panes-root .pane) {
    overflow: hidden;
  }

  .pane-inner {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    position: relative;
  }

  /* Focused pane accent (only shown when >1 pane) */
  .pane-inner.focused {
    box-shadow: inset 0 0 0 2px var(--color-accent);
  }

  .pane-inner.drop-target {
    box-shadow: inset 0 0 0 2px var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 8%, transparent);
  }

  .pane-chrome {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface-elevated);
    flex-shrink: 0;
  }

  .pane-chrome-left {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
    overflow: hidden;
  }

  .pane-title {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .pane-close {
    flex-shrink: 0;
  }

  .pane-body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .pane-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-muted);
  }

  /* PaneForge resizer styled to match the app's sidebar drag handle. */
  :global(.panes-root .pane-resizer) {
    position: relative;
    width: 1px;
    background: var(--color-border);
    outline: none;
    cursor: col-resize;
    flex-shrink: 0;
  }

  :global(.panes-root .pane-resizer::after) {
    content: "";
    position: absolute;
    top: 0;
    left: -3px;
    right: -3px;
    height: 100%;
    z-index: 1;
  }

  :global(.panes-root .pane-resizer:hover),
  :global(.panes-root .pane-resizer[data-active="pointer"]),
  :global(.panes-root .pane-resizer[data-active="keyboard"]) {
    background: var(--color-accent);
  }

  .split-dropzone {
    position: absolute;
    top: 0;
    right: 0;
    height: 100%;
    width: 84px;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    border-left: 2px dashed color-mix(in srgb, var(--color-accent) 50%, transparent);
    background: color-mix(in srgb, var(--color-accent) 6%, transparent);
    transition: background 0.12s, border-color 0.12s;
  }

  .split-dropzone.active {
    background: color-mix(in srgb, var(--color-accent) 18%, transparent);
    border-left-color: var(--color-accent);
  }

  .split-hint {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 0.375rem;
    background: var(--color-surface-elevated);
    color: var(--color-accent);
  }
</style>
