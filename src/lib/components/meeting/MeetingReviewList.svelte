<script lang="ts">
  /**
   * Meeting review list: triaged items with quote, speaker, time, confidence,
   * complexity → model tier, repo and a ▶ clip button. Actions: Send to pile,
   * To journal, Dismiss, Edit; multi-select for bulk actions.
   */
  import {
    meetings,
    formatMeetingTime,
    speakerLabel,
    isActionableCategory,
    MEETING_CATEGORIES,
    MEETING_CATEGORY_STYLE,
    type MeetingItem,
    type MeetingItemCategory,
    type MeetingMeta,
  } from '$lib/stores/meetings';
  import { pile, selectedPileItemId, sidebarTab } from '$lib/stores/pile';
  import { journal, selectedJournalItemId } from '$lib/stores/journal';
  import { selectedScheduleId } from '$lib/stores/schedules';
  import { activeSdkSessionId } from '$lib/stores/sdkSessions';
  import { navigation } from '$lib/stores/navigation';
  import { repos, findRepoById, isRepoActive } from '$lib/stores/repos';
  import { getShortModelName } from '$lib/utils/modelColors';
  import ClipButton from './ClipButton.svelte';

  interface Props {
    meta: MeetingMeta;
    items: MeetingItem[];
  }

  let { meta, items }: Props = $props();

  type Filter = 'review' | 'piled' | 'journaled' | 'dismissed' | 'all';
  let filter = $state<Filter>('review');
  let selected = $state<Set<string>>(new Set());
  let editingId = $state<string | null>(null);
  let expandedId = $state<string | null>(null);
  let draft = $state<{ title: string; detail: string; category: MeetingItemCategory; repo_id: string }>({
    title: '',
    detail: '',
    category: 'task',
    repo_id: '',
  });

  const counts = $derived({
    review: items.filter((i) => i.status === 'new').length,
    piled: items.filter((i) => i.status === 'piled').length,
    journaled: items.filter((i) => i.status === 'journaled').length,
    dismissed: items.filter((i) => i.status === 'dismissed').length,
    all: items.length,
  });

  const visible = $derived.by(() => {
    const list =
      filter === 'all'
        ? items
        : items.filter((i) => (filter === 'review' ? i.status === 'new' : i.status === filter));
    // Most-mentioned first, then newest
    return [...list].sort(
      (a, b) => b.occurrences.length - a.occurrences.length || b.created_at - a.created_at
    );
  });

  const selectedVisible = $derived(visible.filter((i) => selected.has(i.id)).map((i) => i.id));
  const activeRepos = $derived($repos.list.filter(isRepoActive));

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  function toggleAll() {
    selected = selectedVisible.length === visible.length ? new Set() : new Set(visible.map((i) => i.id));
  }

  function clearSelection() {
    selected = new Set();
  }

  function bulk(action: 'pile' | 'journal' | 'dismiss' | 'restore') {
    const ids = selectedVisible;
    if (ids.length === 0) return;
    if (action === 'pile') meetings.sendToPile(meta.id, ids);
    else if (action === 'journal') meetings.sendToJournal(meta.id, ids);
    else if (action === 'dismiss') meetings.dismiss(meta.id, ids);
    else meetings.restore(meta.id, ids);
    clearSelection();
  }

  function startEdit(item: MeetingItem) {
    editingId = item.id;
    draft = {
      title: item.title,
      detail: item.detail,
      category: item.category,
      repo_id: item.repo_id ?? '',
    };
  }

  function saveEdit(item: MeetingItem) {
    meetings.editItem(meta.id, item.id, {
      title: draft.title.trim() || item.title,
      detail: draft.detail,
      category: draft.category,
      repo_id: draft.repo_id || null,
    });
    editingId = null;
  }

  function repoName(repoId: string | null): string | null {
    if (!repoId) return null;
    return findRepoById($repos.list, repoId)?.name ?? null;
  }

  function tierLabel(item: MeetingItem): string | null {
    if (item.complexity == null) return null;
    const tier = meetings.tierFor(item.complexity);
    if (!tier.model) return `${item.complexity}`;
    return `${item.complexity} → ${getShortModelName(tier.model)}${tier.effortLevel ? ` ${tier.effortLevel}` : ''}`;
  }

  function openPileItem(id: string) {
    if (!pile.getItem(id)) return;
    selectedPileItemId.set(id);
    selectedScheduleId.set(null);
    selectedJournalItemId.set(null);
    activeSdkSessionId.set(null);
    sidebarTab.set('pile');
    navigation.setView('sessions');
  }

  function openJournalItem(id: string) {
    if (!journal.getItem(id)) return;
    selectedJournalItemId.set(id);
    selectedPileItemId.set(null);
    selectedScheduleId.set(null);
    activeSdkSessionId.set(null);
    sidebarTab.set('journal');
    navigation.setView('sessions');
  }

  const FILTERS: { id: Filter; label: string }[] = [
    { id: 'review', label: 'To review' },
    { id: 'piled', label: 'Piled' },
    { id: 'journaled', label: 'Journal' },
    { id: 'dismissed', label: 'Dismissed' },
    { id: 'all', label: 'All' },
  ];
</script>

<div class="flex flex-col min-h-0 h-full">
  <div class="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0 flex-wrap">
    <span class="text-xs font-medium text-text-secondary mr-1">Items</span>
    {#each FILTERS as f}
      <button
        class="px-2 py-0.5 rounded text-[11px] transition-colors {filter === f.id
          ? 'bg-accent/20 text-text-primary font-medium'
          : 'text-text-muted hover:text-text-secondary'}"
        onclick={() => {
          filter = f.id;
          clearSelection();
        }}
      >
        {f.label}{counts[f.id] > 0 ? ` (${counts[f.id]})` : ''}
      </button>
    {/each}
  </div>

  {#if selectedVisible.length > 0}
    <div class="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-surface-elevated shrink-0 flex-wrap">
      <span class="text-[11px] text-text-secondary">{selectedVisible.length} selected</span>
      <button class="ml-auto px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white" onclick={() => bulk('pile')}>
        Send to pile
      </button>
      <button class="px-2 py-0.5 rounded text-[11px] font-medium bg-surface hover:bg-background text-text-secondary" onclick={() => bulk('journal')}>
        To journal
      </button>
      {#if filter === 'dismissed'}
        <button class="px-2 py-0.5 rounded text-[11px] font-medium bg-surface hover:bg-background text-text-secondary" onclick={() => bulk('restore')}>
          Restore
        </button>
      {:else}
        <button class="px-2 py-0.5 rounded text-[11px] font-medium bg-surface hover:bg-background text-text-secondary" onclick={() => bulk('dismiss')}>
          Dismiss
        </button>
      {/if}
      <button class="px-1.5 py-0.5 text-[11px] text-text-muted hover:text-text-secondary" onclick={clearSelection}>✕</button>
    </div>
  {/if}

  <div class="flex-1 overflow-y-auto p-2 space-y-1.5">
    {#if visible.length === 0}
      <div class="p-4 text-center text-xs text-text-muted">
        {#if filter === 'review'}
          <p class="mb-1 font-medium text-text-secondary">Nothing to review yet</p>
          <p>Bugs, tasks, investigations and questions appear here after each triage pass.</p>
        {:else}
          <p>No items.</p>
        {/if}
      </div>
    {:else}
      {#if visible.length > 1}
        <label class="flex items-center gap-1.5 px-1 text-[11px] text-text-muted cursor-pointer">
          <input type="checkbox" class="accent-accent" checked={selectedVisible.length === visible.length} onchange={toggleAll} />
          Select all
        </label>
      {/if}
      {#each visible as item (item.id)}
        {@const style = MEETING_CATEGORY_STYLE[item.category] ?? MEETING_CATEGORY_STYLE.note}
        {@const first = item.occurrences[0]}
        {@const tier = tierLabel(item)}
        <div
          class="rounded border p-2 transition-colors {selected.has(item.id)
            ? 'border-accent bg-accent/10'
            : 'border-border bg-surface-elevated/50'}"
          class:opacity-60={item.status === 'dismissed'}
        >
          {#if editingId === item.id}
            <div class="space-y-2">
              <input
                type="text"
                class="w-full px-2 py-1 text-xs bg-surface-elevated border border-border rounded text-text-primary focus:outline-none focus:border-accent"
                bind:value={draft.title}
              />
              <textarea
                class="w-full min-h-16 px-2 py-1 text-xs bg-surface-elevated border border-border rounded text-text-primary resize-y focus:outline-none focus:border-accent"
                bind:value={draft.detail}
                placeholder="Detail"
              ></textarea>
              <div class="flex items-center gap-2 flex-wrap">
                <select class="px-2 py-1 text-[11px] bg-surface-elevated border border-border rounded text-text-primary" bind:value={draft.category}>
                  {#each MEETING_CATEGORIES as c}
                    <option value={c}>{MEETING_CATEGORY_STYLE[c].label}</option>
                  {/each}
                </select>
                <select class="px-2 py-1 text-[11px] bg-surface-elevated border border-border rounded text-text-primary max-w-40" bind:value={draft.repo_id}>
                  <option value="">No repository</option>
                  {#each activeRepos as repo (repo.id)}
                    <option value={repo.id}>{repo.name}</option>
                  {/each}
                </select>
                <button class="ml-auto px-2 py-0.5 rounded text-[11px] font-medium bg-accent text-white hover:opacity-90" onclick={() => saveEdit(item)}>
                  Save
                </button>
                <button class="px-2 py-0.5 rounded text-[11px] text-text-muted hover:text-text-secondary" onclick={() => (editingId = null)}>
                  Cancel
                </button>
              </div>
            </div>
          {:else}
            <div class="flex items-start gap-2">
              <input
                type="checkbox"
                class="mt-0.5 accent-accent shrink-0"
                checked={selected.has(item.id)}
                onchange={() => toggle(item.id)}
              />
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5">
                  <span class="text-[10px] px-1.5 py-px rounded shrink-0 {style.cls}">{style.label}</span>
                  <button
                    class="text-xs font-medium text-text-primary text-left truncate flex-1 hover:underline"
                    onclick={() => (expandedId = expandedId === item.id ? null : item.id)}
                    title={item.title}
                  >
                    {item.title}
                  </button>
                  {#if item.occurrences.length > 1}
                    <span class="text-[10px] text-text-muted shrink-0" title="Mentioned {item.occurrences.length} times">
                      ×{item.occurrences.length}
                    </span>
                  {/if}
                </div>
                {#if item.detail}
                  <p class="text-[11px] text-text-secondary mt-0.5 {expandedId === item.id ? 'whitespace-pre-wrap' : 'truncate'}">
                    {item.detail}
                  </p>
                {/if}

                {#each expandedId === item.id ? item.occurrences : first ? [first] : [] as occ, idx (idx)}
                  <div class="flex items-start gap-1.5 mt-1">
                    <ClipButton meetingId={meta.id} segId={occ.seg_id} />
                    <p class="text-[11px] text-text-muted italic flex-1 min-w-0 {expandedId === item.id ? '' : 'line-clamp-2'}">
                      “{occ.quote}”
                      <span class="not-italic text-[10px]">— {speakerLabel(occ.speaker)} @ {formatMeetingTime(occ.t0)}</span>
                    </p>
                  </div>
                {/each}

                <div class="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  {#if repoName(item.repo_id)}
                    <span class="text-[10px] px-1.5 py-px rounded bg-surface text-text-secondary truncate max-w-28">{repoName(item.repo_id)}</span>
                  {:else if meta.auto_repo}
                    <span class="text-[10px] px-1.5 py-px rounded bg-amber-500/15 text-amber-400" title="No repository matched — pick one via Edit">repo?</span>
                  {/if}
                  {#if item.confidence != null}
                    <span class="text-[10px] text-text-muted" title="Triage confidence">{Math.round(item.confidence * 100)}%</span>
                  {/if}
                  {#if tier}
                    <span class="text-[10px] px-1.5 py-px rounded bg-surface text-text-secondary" title="Complexity score → auto model tier">Auto · {tier}</span>
                  {/if}
                  {#if item.status === 'piled' && item.pile_item_id}
                    <button class="text-[10px] text-emerald-400 hover:underline" onclick={() => openPileItem(item.pile_item_id!)}>in pile →</button>
                  {:else if item.status === 'journaled' && item.journal_item_id}
                    <button class="text-[10px] text-violet-400 hover:underline" onclick={() => openJournalItem(item.journal_item_id!)}>in journal →</button>
                  {:else if item.status === 'dismissed' && item.merged_into}
                    <span class="text-[10px] text-text-muted">merged</span>
                  {/if}

                  <div class="ml-auto flex items-center gap-1">
                    {#if item.status === 'new'}
                      <button
                        class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-600/80 hover:bg-emerald-500 text-white"
                        onclick={() => meetings.sendToPile(meta.id, [item.id])}
                        title="Create a pile item (text, no cleanup) ready to launch"
                      >
                        Pile
                      </button>
                      <button
                        class="px-1.5 py-0.5 rounded text-[10px] bg-surface hover:bg-background text-text-secondary"
                        onclick={() => meetings.sendToJournal(meta.id, [item.id])}
                        title={isActionableCategory(item.category) ? 'Keep it in the journal instead' : 'Send to journal'}
                      >
                        Journal
                      </button>
                      <button
                        class="px-1.5 py-0.5 rounded text-[10px] bg-surface hover:bg-background text-text-muted"
                        onclick={() => meetings.dismiss(meta.id, [item.id])}
                      >
                        Dismiss
                      </button>
                    {:else if item.status === 'dismissed'}
                      <button
                        class="px-1.5 py-0.5 rounded text-[10px] bg-surface hover:bg-background text-text-secondary"
                        onclick={() => meetings.restore(meta.id, [item.id])}
                      >
                        Restore
                      </button>
                    {/if}
                    <button
                      class="px-1.5 py-0.5 rounded text-[10px] text-text-muted hover:text-text-secondary"
                      onclick={() => startEdit(item)}
                    >
                      Edit
                    </button>
                  </div>
                </div>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .line-clamp-2 {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
