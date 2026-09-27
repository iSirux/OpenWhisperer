<script lang="ts">
  /**
   * Sidebar "Journal" tab: journal items grouped by category, filterable by
   * repo / meeting / tag, sorted by sightings or recency. Selecting an item
   * opens it in the main pane (`JournalDetailView`), like the pile.
   */
  import {
    journal,
    selectedJournalItemId,
    JOURNAL_CATEGORIES,
    JOURNAL_CATEGORY_STYLE,
    type JournalItem,
  } from '$lib/stores/journal';
  import { selectedPileItemId } from '$lib/stores/pile';
  import { selectedScheduleId } from '$lib/stores/schedules';
  import { activeSdkSessionId } from '$lib/stores/sdkSessions';
  import { navigation } from '$lib/stores/navigation';
  import { meetings } from '$lib/stores/meetings';
  import { repos, findRepoById } from '$lib/stores/repos';

  let repoFilter = $state('');
  let meetingFilter = $state('');
  let tagFilter = $state('');
  let sortBy = $state<'sightings' | 'recent'>('sightings');
  let showClosed = $state(false);
  let collapsed = $state<Set<string>>(new Set());

  const meetingOptions = $derived.by(() => {
    const ids = new Set<string>();
    for (const item of $journal) for (const o of item.occurrences) if (o.meetingId) ids.add(o.meetingId);
    return [...ids].map((id) => ({
      id,
      label: $meetings.list.find((m) => m.id === id)?.title || id,
    }));
  });

  const tagOptions = $derived([...new Set($journal.flatMap((i) => i.tags))].sort());
  const repoOptions = $derived(
    [...new Set($journal.map((i) => i.repoId).filter(Boolean) as string[])].map((id) => ({
      id,
      label: findRepoById($repos.list, id)?.name ?? 'Missing repo',
    }))
  );

  const filtered = $derived(
    $journal
      .filter((i) => showClosed || i.status === 'open')
      .filter((i) => !repoFilter || (repoFilter === '__none' ? !i.repoId : i.repoId === repoFilter))
      .filter((i) => !meetingFilter || i.occurrences.some((o) => o.meetingId === meetingFilter))
      .filter((i) => !tagFilter || i.tags.includes(tagFilter))
      .sort((a, b) =>
        sortBy === 'sightings'
          ? b.occurrences.length - a.occurrences.length || b.updatedAt - a.updatedAt
          : b.updatedAt - a.updatedAt
      )
  );

  const groups = $derived(
    JOURNAL_CATEGORIES.map((category) => ({
      category,
      items: filtered.filter((i) => i.category === category),
    })).filter((g) => g.items.length > 0)
  );

  function openItem(item: JournalItem) {
    selectedJournalItemId.set(item.id);
    selectedPileItemId.set(null);
    selectedScheduleId.set(null);
    activeSdkSessionId.set(null);
    navigation.setView('sessions');
  }

  function toggleGroup(category: string) {
    const next = new Set(collapsed);
    if (next.has(category)) next.delete(category);
    else next.add(category);
    collapsed = next;
  }

  function formatAge(ts: number): string {
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 60) return 'now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  }

  const selectClass =
    'min-w-0 flex-1 px-1.5 py-0.5 text-[11px] bg-surface-elevated border border-border rounded text-text-secondary';
</script>

<div class="flex flex-col h-full">
  <div class="p-1.5 border-b border-border shrink-0 space-y-1">
    <div class="flex items-center gap-1">
      <select class={selectClass} bind:value={repoFilter} title="Filter by repository">
        <option value="">All repos</option>
        <option value="__none">No repo</option>
        {#each repoOptions as r (r.id)}
          <option value={r.id}>{r.label}</option>
        {/each}
      </select>
      <select class={selectClass} bind:value={meetingFilter} title="Filter by meeting">
        <option value="">All meetings</option>
        {#each meetingOptions as m (m.id)}
          <option value={m.id}>{m.label}</option>
        {/each}
      </select>
    </div>
    <div class="flex items-center gap-1">
      {#if tagOptions.length > 0}
        <select class={selectClass} bind:value={tagFilter} title="Filter by tag">
          <option value="">All tags</option>
          {#each tagOptions as t}
            <option value={t}>#{t}</option>
          {/each}
        </select>
      {/if}
      <select class={selectClass} bind:value={sortBy} title="Sort">
        <option value="sightings">Most mentioned</option>
        <option value="recent">Most recent</option>
      </select>
      <label class="flex items-center gap-1 text-[11px] text-text-muted cursor-pointer shrink-0 px-1" title="Show promoted and dismissed items">
        <input type="checkbox" class="accent-accent" bind:checked={showClosed} />
        All
      </label>
    </div>
  </div>

  <div class="flex-1 overflow-y-auto">
    {#if $journal.length === 0}
      <div class="p-4 text-center text-xs text-text-muted">
        <p class="mb-1 font-medium text-text-secondary">Journal is empty</p>
        <p>
          Feedback, ideas, decisions and notes from meetings collect here — start one from the
          Meeting button.
        </p>
        <button
          class="mt-2 px-2 py-1 rounded text-[11px] font-medium bg-accent/15 text-accent hover:bg-accent/25"
          onclick={() => meetings.openHome()}
        >
          Open Meeting Mode
        </button>
      </div>
    {:else if groups.length === 0}
      <p class="p-4 text-center text-xs text-text-muted">No items match the filters.</p>
    {:else}
      <div class="flex flex-col gap-1 p-1.5">
        {#each groups as group (group.category)}
          {@const style = JOURNAL_CATEGORY_STYLE[group.category]}
          <button
            class="flex items-center gap-1.5 px-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-text-muted hover:text-text-secondary"
            onclick={() => toggleGroup(group.category)}
          >
            <span>{collapsed.has(group.category) ? '▸' : '▾'}</span>
            {style.label}
            <span class="font-normal">({group.items.length})</span>
          </button>
          {#if !collapsed.has(group.category)}
            {#each group.items as item (item.id)}
              {@const repoName = item.repoId ? findRepoById($repos.list, item.repoId)?.name : null}
              <div
                class="rounded border p-2 cursor-pointer transition-colors {$selectedJournalItemId === item.id
                  ? 'border-accent bg-accent/10'
                  : 'border-border bg-surface-elevated/50 hover:bg-surface-elevated'}"
                class:opacity-60={item.status !== 'open'}
                role="button"
                tabindex="0"
                onclick={() => openItem(item)}
                onkeydown={(e) => e.key === 'Enter' && openItem(item)}
              >
                <div class="flex items-center gap-1.5">
                  <span class="text-xs font-medium text-text-primary truncate flex-1">{item.title}</span>
                  {#if item.occurrences.length > 1}
                    <span class="text-[10px] px-1 rounded bg-surface text-text-secondary shrink-0" title="Sightings">
                      ×{item.occurrences.length}
                    </span>
                  {/if}
                </div>
                {#if item.detail}
                  <p class="text-[11px] text-text-muted truncate mt-0.5">{item.detail}</p>
                {/if}
                <div class="flex items-center gap-1.5 mt-1 flex-wrap">
                  {#if repoName}
                    <span class="text-[10px] px-1.5 py-px rounded bg-surface text-text-secondary truncate max-w-[100px]">{repoName}</span>
                  {/if}
                  {#each item.tags.slice(0, 3) as tag}
                    <span class="text-[10px] text-text-muted">#{tag}</span>
                  {/each}
                  {#if item.status === 'promoted'}
                    <span class="text-[10px] text-emerald-400">in pile</span>
                  {:else if item.status === 'dismissed'}
                    <span class="text-[10px] text-text-muted">dismissed</span>
                  {/if}
                  <span class="text-[10px] text-text-muted ml-auto shrink-0">{formatAge(item.updatedAt)}</span>
                </div>
              </div>
            {/each}
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</div>
