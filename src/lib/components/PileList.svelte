<script lang="ts">
  import {
    pile,
    pileItemTitle,
    selectedPileItemId,
    failedRetriableCount,
    pileRetryingAll,
    type PileItem,
  } from '$lib/stores/pile';
  import { sdkSessions, activeSdkSessionId } from '$lib/stores/sdkSessions';
  import { activeSessionId } from '$lib/stores/sessions';
  import { repos, findRepoById } from '$lib/stores/repos';
  import { navigation } from '$lib/stores/navigation';
  import { createSessionQueue } from '$lib/utils/sessionLaunch';
  import {
    launchPileItem,
    launchPileItemsTogether,
    preparePileItem,
    preparePileItemsTogether,
    resolvePileRepo,
    PILE_ACTIONS,
    type PileLaunchAction,
  } from '$lib/utils/pileActions';
  import { getShortModelName, getModelBadgeBgColor, getModelTextColor } from '$lib/utils/modelColors';
  import ConfirmDialog from './ConfirmDialog.svelte';

  let selectedIds = $state<Set<string>>(new Set());
  let pendingAction = $state<string | null>(null);
  let useWorktree = $state(false);
  let groupMode = $state<'separate' | 'together'>('separate');
  let confirmDeleteOpen = $state(false);

  const launchQueue = createSessionQueue();
  const queueProcessing = launchQueue.processing;
  const queueSize = launchQueue.size;

  const items = $derived($pile);
  const selectedItems = $derived(items.filter((i) => selectedIds.has(i.id)));

  // Live indicator: pile item id -> linked session activity. Uses each item's
  // linkedSessionIds so combined (together) sessions light up every item.
  const itemSessionMap = $derived.by(() => {
    const sessionById = new Map($sdkSessions.map((s) => [s.id, s]));
    const map = new Map<string, { count: number; hasActive: boolean }>();
    for (const item of items) {
      let count = 0;
      let hasActive = false;
      for (const sid of item.linkedSessionIds || []) {
        const s = sessionById.get(sid);
        if (!s) continue;
        count++;
        if (s.status === 'querying' || s.status === 'initializing') hasActive = true;
      }
      if (count > 0) map.set(item.id, { count, hasActive });
    }
    return map;
  });

  function toggleSelect(id: string, event: Event) {
    event.stopPropagation();
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds = next;
    pendingAction = null;
  }

  function openItem(item: PileItem) {
    selectedPileItemId.set(item.id);
    activeSdkSessionId.set(null);
    activeSessionId.set(null);
    navigation.setView('sessions');
  }

  function repoName(item: PileItem): string | null {
    if (!item.repoId) return null;
    return findRepoById($repos.list, item.repoId)?.name ?? null;
  }

  function formatAge(createdAt: number): string {
    const seconds = Math.floor((Date.now() - createdAt) / 1000);
    if (seconds < 60) return 'now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  }

  function selectAction(action: string) {
    pendingAction = action;
    useWorktree = false;
    groupMode = 'separate';
  }

  function confirmAction() {
    if (!pendingAction || selectedItems.length === 0) return;
    const action = pendingAction;
    const itemsSnapshot = [...selectedItems].filter(
      (i) => i.status === 'ready' && i.transcript.trim()
    );
    const worktree = useWorktree;
    const together = groupMode === 'together' && itemsSnapshot.length > 1;
    selectedIds = new Set();
    pendingAction = null;

    if (action === 'prepare') {
      // Draft (setup) sessions are cheap to create — no queue/stagger needed
      if (together) {
        void preparePileItemsTogether(itemsSnapshot);
      } else {
        for (const item of itemsSnapshot) {
          void preparePileItem(item, itemsSnapshot.length === 1);
        }
      }
      return;
    }

    if (together) {
      launchQueue.enqueue([
        () =>
          launchPileItemsTogether(itemsSnapshot, action as PileLaunchAction, {
            useWorktree: worktree,
          }).then(() => {}),
      ]);
      return;
    }

    launchQueue.enqueue(
      itemsSnapshot.map((item) => () =>
        launchPileItem(item, action as PileLaunchAction, {
          useWorktree: worktree,
        }).then(() => {})
      ),
      { stagger: true }
    );
  }

  async function deleteSelected() {
    const ids = [...selectedIds];
    selectedIds = new Set();
    pendingAction = null;
    confirmDeleteOpen = false;
    for (const id of ids) {
      if ($selectedPileItemId === id) selectedPileItemId.set(null);
      await pile.removeItem(id);
    }
  }

  async function retryAll() {
    await pile.retryAllFailed();
  }
</script>

<div class="flex flex-col h-full">
  <div class="flex-1 overflow-y-auto">
    {#if items.length === 0}
      <div class="p-4 text-center text-xs text-text-muted">
        <p class="mb-1 font-medium text-text-secondary">Pile is empty</p>
        <p>
          Record something and say "pile it", press the pile hotkey, or set the
          recording stop mode to Pile.
        </p>
      </div>
    {:else}
      <div class="flex flex-col gap-1 p-1.5">
        {#each items as item (item.id)}
          {@const sessions = itemSessionMap.get(item.id)}
          <div
            class="pile-card group rounded border p-2 cursor-pointer transition-colors {$selectedPileItemId ===
            item.id
              ? 'border-accent bg-accent/10'
              : 'border-border bg-surface-elevated/50 hover:bg-surface-elevated'}"
            onclick={() => openItem(item)}
            onkeydown={(e) => e.key === 'Enter' && openItem(item)}
            role="button"
            tabindex="0"
          >
            <div class="flex items-start gap-2">
              <input
                type="checkbox"
                class="mt-0.5 accent-accent shrink-0"
                checked={selectedIds.has(item.id)}
                onclick={(e) => toggleSelect(item.id, e)}
              />
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5">
                  <span class="text-xs font-medium text-text-primary truncate flex-1">
                    {pileItemTitle(item)}
                  </span>
                  {#if item.status === 'processing' || item.status === 'transcribing'}
                    <span
                      class="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0"
                      title={item.status === 'transcribing' ? 'Transcribing…' : 'Processing…'}
                    ></span>
                  {:else if item.status === 'error'}
                    <span class="text-[10px] text-red-400 shrink-0" title={item.transcriptionError}
                      >!</span
                    >
                  {/if}
                  {#if sessions}
                    <span class="relative shrink-0" title="{sessions.count} session(s) launched">
                      <span class="block w-2 h-2 rounded-full bg-emerald-400"></span>
                      {#if sessions.hasActive}
                        <span
                          class="absolute inset-0 w-2 h-2 rounded-full bg-emerald-400 animate-ping opacity-75"
                        ></span>
                      {/if}
                    </span>
                  {/if}
                </div>
                {#if item.title && item.transcript}
                  <p class="text-[11px] text-text-muted truncate mt-0.5">{item.transcript}</p>
                {/if}
                <div class="flex items-center gap-1.5 mt-1 flex-wrap">
                  {#if repoName(item)}
                    <span
                      class="text-[10px] px-1.5 py-px rounded bg-surface text-text-secondary truncate max-w-[100px]"
                    >
                      {repoName(item)}
                    </span>
                  {/if}
                  {#if item.model}
                    <span
                      class="text-[10px] px-1.5 py-px rounded {getModelBadgeBgColor(
                        item.model
                      )} {getModelTextColor(item.model)}"
                    >
                      {getShortModelName(item.model)}
                    </span>
                  {/if}
                  {#if item.repoConfidence && item.repoConfidence !== 'high'}
                    <span
                      class="text-[10px] px-1.5 py-px rounded bg-amber-500/15 text-amber-400"
                      title="Low-confidence repo match: {item.repoReasoning || ''}"
                    >
                      repo?
                    </span>
                  {/if}
                  {#if item.hasScreenshot}
                    <svg
                      class="w-3 h-3 text-text-muted shrink-0"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-label="Has screenshot"
                    >
                      <title>Screenshot attached</title>
                      <path
                        fill-rule="evenodd"
                        d="M1 8a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 018.07 3h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0016.07 6H17a2 2 0 012 2v7a2 2 0 01-2 2H3a2 2 0 01-2-2V8zm13.5 3a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM10 14a3 3 0 100-6 3 3 0 000 6z"
                        clip-rule="evenodd"
                      />
                    </svg>
                  {/if}
                  <span class="text-[10px] text-text-muted ml-auto shrink-0">
                    {formatAge(item.createdAt)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if $queueProcessing}
    <div class="flex items-center gap-2 px-3 py-1.5 border-t border-border bg-surface-elevated/50">
      <div class="relative">
        <div class="w-2 h-2 rounded-full bg-accent"></div>
        <div class="absolute inset-0 w-2 h-2 rounded-full bg-accent animate-ping opacity-75"></div>
      </div>
      <span class="text-[11px] text-text-muted"
        >Launching{$queueSize > 0 ? ` (${$queueSize} queued)` : ''}...</span
      >
    </div>
  {/if}

  {#if $failedRetriableCount > 0}
    <div class="flex items-center gap-2 px-3 py-1.5 border-t border-border bg-surface-elevated/50">
      <span class="text-[11px] text-text-muted flex-1">
        {$failedRetriableCount} failed transcription{$failedRetriableCount === 1 ? '' : 's'}
      </span>
      <button
        class="px-2.5 py-1 rounded text-[11px] font-medium bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        onclick={retryAll}
        disabled={$pileRetryingAll}
        title="Re-transcribe every failed recording that still has audio"
      >
        {$pileRetryingAll ? 'Retrying…' : `Retry all failed (${$failedRetriableCount})`}
      </button>
    </div>
  {/if}

  {#if selectedItems.length > 0}
    <div class="border-t border-border bg-surface-elevated p-2 space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-[11px] text-text-secondary">{selectedItems.length} selected</span>
        <button
          class="text-[11px] text-red-400 hover:text-red-300"
          onclick={() => (confirmDeleteOpen = true)}
        >
          Delete
        </button>
      </div>
      {#if pendingAction}
        {@const actionLabel = PILE_ACTIONS.find((a) => a.id === pendingAction)?.label}
        {#if selectedItems.length > 1}
          {@const togetherRepo = resolvePileRepo(selectedItems[0])?.name}
          <div class="flex items-center gap-1">
            <button
              class="px-2 py-1 rounded text-[11px] transition-colors {groupMode === 'separate'
                ? 'bg-accent/20 text-text-primary font-medium'
                : 'bg-surface text-text-secondary hover:bg-background'}"
              title="One session per item"
              onclick={() => (groupMode = 'separate')}
            >
              Separately ({selectedItems.length} sessions)
            </button>
            <button
              class="px-2 py-1 rounded text-[11px] transition-colors {groupMode === 'together'
                ? 'bg-accent/20 text-text-primary font-medium'
                : 'bg-surface text-text-secondary hover:bg-background'}"
              title="One combined session handling all items{togetherRepo
                ? ` (in ${togetherRepo})`
                : ''}"
              onclick={() => (groupMode = 'together')}
            >
              Together (1 session)
            </button>
          </div>
        {/if}
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-[11px] font-medium text-text-primary">{actionLabel}:</span>
          {#if pendingAction !== 'prepare'}
            <label class="flex items-center gap-1 text-[11px] text-text-secondary cursor-pointer">
              <input type="checkbox" bind:checked={useWorktree} class="accent-accent" />
              Worktree
            </label>
          {/if}
          <button
            class="ml-auto px-3 py-1 rounded text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
            onclick={confirmAction}
          >
            Go
          </button>
          <button
            class="px-2 py-1 rounded text-[11px] bg-surface hover:bg-background text-text-secondary transition-colors"
            onclick={() => (pendingAction = null)}
          >
            Cancel
          </button>
        </div>
      {:else}
        <div class="grid grid-cols-2 gap-1">
          {#each PILE_ACTIONS as action}
            <button
              class="px-2 py-1 rounded text-[11px] font-medium bg-surface hover:bg-accent/20 text-text-secondary hover:text-text-primary transition-colors"
              title={action.description}
              onclick={() => selectAction(action.id)}
            >
              {action.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<ConfirmDialog
  show={confirmDeleteOpen}
  title="Delete pile items"
  message={`Delete ${selectedItems.length} item(s) from the pile? Their saved audio will also be deleted.`}
  confirmLabel="Delete"
  variant="danger"
  onconfirm={deleteSelected}
  oncancel={() => (confirmDeleteOpen = false)}
/>
