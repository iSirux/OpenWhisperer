<script lang="ts">
  /**
   * Main-pane editor for a journal item: category, title, detail, tags, repo,
   * every sighting (quote + ▶ clip + link to its meeting), and the lifecycle
   * actions — Promote to pile (keeps the link both ways), Dismiss/Reopen, Delete.
   */
  import {
    journal,
    selectedJournalItemId,
    JOURNAL_CATEGORIES,
    JOURNAL_CATEGORY_STYLE,
    type JournalItem,
    type JournalCategory,
  } from '$lib/stores/journal';
  import { pile, selectedPileItemId, sidebarTab } from '$lib/stores/pile';
  import { meetings, formatMeetingTime, speakerLabel } from '$lib/stores/meetings';
  import { navigation } from '$lib/stores/navigation';
  import { repos, isRepoActive } from '$lib/stores/repos';
  import ClipButton from '../meeting/ClipButton.svelte';
  import ConfirmDialog from '../ConfirmDialog.svelte';

  interface Props {
    item: JournalItem;
  }

  let { item }: Props = $props();

  let editedTitle = $state('');
  let editedDetail = $state('');
  let tagInput = $state('');
  let lastItemId = $state('');
  let confirmDeleteOpen = $state(false);

  $effect(() => {
    if (item.id !== lastItemId) {
      lastItemId = item.id;
      editedTitle = item.title;
      editedDetail = item.detail;
      tagInput = '';
    } else if (item.detail !== editedDetail && document.activeElement?.tagName !== 'TEXTAREA') {
      editedDetail = item.detail;
    }
  });

  const activeRepos = $derived($repos.list.filter(isRepoActive));
  const occurrences = $derived([...item.occurrences].sort((a, b) => b.at - a.at));
  const pileItemExists = $derived(
    !!item.promotedPileItemId && $pile.some((p) => p.id === item.promotedPileItemId)
  );

  function saveTitle() {
    const title = editedTitle.trim();
    if (title && title !== item.title) journal.editItem(item.id, { title });
  }

  function saveDetail() {
    if (editedDetail !== item.detail) journal.editItem(item.id, { detail: editedDetail });
  }

  function addTag() {
    const tag = tagInput.trim().replace(/^#/, '').toLowerCase();
    tagInput = '';
    if (!tag || item.tags.includes(tag)) return;
    journal.updateItem(item.id, { tags: [...item.tags, tag] });
  }

  function removeTag(tag: string) {
    journal.updateItem(item.id, { tags: item.tags.filter((t) => t !== tag) });
  }

  function promote() {
    saveTitle();
    saveDetail();
    const pileId = journal.promote(item.id);
    if (pileId) openPileItem(pileId);
  }

  function openPileItem(id: string) {
    selectedJournalItemId.set(null);
    selectedPileItemId.set(id);
    sidebarTab.set('pile');
    navigation.setView('sessions');
  }

  function openMeeting(meetingId: string) {
    meetings.openMeeting(meetingId);
  }

  function meetingTitle(meetingId: string): string {
    return $meetings.list.find((m) => m.id === meetingId)?.title || 'Meeting';
  }

  function deleteItem() {
    confirmDeleteOpen = false;
    const id = item.id;
    selectedJournalItemId.set(null);
    journal.remove(id);
  }

  const style = $derived(JOURNAL_CATEGORY_STYLE[item.category] ?? JOURNAL_CATEGORY_STYLE.note);
</script>

<div class="flex-1 flex flex-col overflow-hidden">
  <div class="px-4 py-3 border-b border-border flex items-center gap-3">
    <div class="flex-1 min-w-0">
      <input
        type="text"
        class="w-full bg-transparent text-base font-medium text-text-primary focus:outline-none focus:border-b focus:border-accent"
        bind:value={editedTitle}
        onblur={saveTitle}
        onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      />
      <div class="flex items-center gap-2 mt-0.5 text-xs text-text-muted">
        <span class="px-1.5 py-px rounded {style.cls}">{style.label}</span>
        <span>{item.occurrences.length} sighting{item.occurrences.length === 1 ? '' : 's'}</span>
        <span>· updated {new Date(item.updatedAt).toLocaleString()}</span>
        {#if item.status !== 'open'}
          <span class="px-1.5 py-px rounded bg-surface-elevated">{item.status}</span>
        {/if}
      </div>
    </div>
    <button
      class="px-2.5 py-1 text-xs rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
      onclick={() => (confirmDeleteOpen = true)}
    >
      Delete
    </button>
    <button
      class="px-2.5 py-1 text-xs rounded border border-border text-text-secondary hover:bg-surface-elevated transition-colors shrink-0"
      onclick={() => selectedJournalItemId.set(null)}
    >
      Close
    </button>
  </div>

  <div class="flex-1 overflow-y-auto p-4 space-y-4 max-w-3xl w-full mx-auto">
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label class="text-xs font-medium text-text-secondary block mb-1" for="journal-category">Category</label>
        <select
          id="journal-category"
          class="w-full px-2 py-1.5 text-sm bg-surface-elevated border border-border rounded text-text-primary"
          value={item.category}
          onchange={(e) =>
            journal.updateItem(item.id, { category: e.currentTarget.value as JournalCategory })}
        >
          {#each JOURNAL_CATEGORIES as c}
            <option value={c}>{JOURNAL_CATEGORY_STYLE[c].label}</option>
          {/each}
        </select>
      </div>
      <div>
        <label class="text-xs font-medium text-text-secondary block mb-1" for="journal-repo">Repository</label>
        <select
          id="journal-repo"
          class="w-full px-2 py-1.5 text-sm bg-surface-elevated border border-border rounded text-text-primary"
          value={item.repoId ?? ''}
          onchange={(e) => journal.updateItem(item.id, { repoId: e.currentTarget.value || undefined })}
        >
          <option value="">No repository</option>
          {#each activeRepos as repo (repo.id)}
            <option value={repo.id}>{repo.name}</option>
          {/each}
        </select>
      </div>
    </div>

    <div>
      <label class="text-xs font-medium text-text-secondary block mb-1" for="journal-detail">Detail</label>
      <textarea
        id="journal-detail"
        class="w-full min-h-24 p-3 text-sm bg-surface-elevated border border-border rounded text-text-primary resize-y focus:outline-none focus:border-accent"
        bind:value={editedDetail}
        onblur={saveDetail}
        placeholder="What was said, and why it matters…"
      ></textarea>
    </div>

    <div>
      <span class="text-xs font-medium text-text-secondary block mb-1">Tags</span>
      <div class="flex items-center gap-1.5 flex-wrap">
        {#each item.tags as tag}
          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-elevated border border-border text-xs text-text-primary">
            #{tag}
            <button class="text-text-muted hover:text-error" onclick={() => removeTag(tag)} aria-label="Remove tag {tag}">×</button>
          </span>
        {/each}
        <input
          type="text"
          class="w-28 px-2 py-0.5 text-xs bg-surface-elevated border border-border rounded text-text-primary focus:outline-none focus:border-accent"
          placeholder="+ tag"
          bind:value={tagInput}
          onkeydown={(e) => e.key === 'Enter' && addTag()}
          onblur={addTag}
        />
      </div>
    </div>

    <!-- Actions -->
    <div class="p-3 bg-surface-elevated rounded border border-border flex items-center gap-2 flex-wrap">
      {#if item.status === 'promoted' && pileItemExists}
        <span class="text-xs text-text-secondary">Promoted to the pile.</span>
        <button
          class="px-3 py-1.5 rounded text-xs font-medium bg-surface hover:bg-background text-text-secondary"
          onclick={() => openPileItem(item.promotedPileItemId!)}
        >
          Open pile item →
        </button>
      {:else}
        <button
          class="px-3 py-1.5 rounded text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
          onclick={promote}
          title="Turn this into a pile item you can launch as an agent session"
        >
          Promote to pile
        </button>
      {/if}
      {#if item.status === 'dismissed'}
        <button
          class="px-3 py-1.5 rounded text-xs font-medium bg-surface hover:bg-background text-text-secondary"
          onclick={() => journal.setStatus(item.id, 'open')}
        >
          Reopen
        </button>
      {:else if item.status === 'open'}
        <button
          class="px-3 py-1.5 rounded text-xs font-medium bg-surface hover:bg-background text-text-muted"
          onclick={() => journal.setStatus(item.id, 'dismissed')}
          title="Hide it and stop matching it in future meetings"
        >
          Dismiss
        </button>
      {:else}
        <button
          class="px-3 py-1.5 rounded text-xs font-medium bg-surface hover:bg-background text-text-muted"
          onclick={() => journal.setStatus(item.id, 'open')}
          title="Keep collecting sightings in future meetings"
        >
          Reopen
        </button>
      {/if}
    </div>

    <!-- Sightings -->
    <div>
      <p class="text-xs font-medium text-text-secondary mb-1">Sightings</p>
      {#if occurrences.length === 0}
        <p class="text-xs text-text-muted">No sightings recorded.</p>
      {:else}
        <div class="space-y-1.5">
          {#each occurrences as occ, idx (idx)}
            <div class="p-2 rounded border border-border bg-surface-elevated/50 flex items-start gap-2">
              {#if occ.meetingId}
                <ClipButton meetingId={occ.meetingId} segId={occ.segId} size="sm" />
              {/if}
              <div class="flex-1 min-w-0">
                <p class="text-xs text-text-primary italic">“{occ.quote}”</p>
                <div class="flex items-center gap-1.5 mt-0.5 text-[10px] text-text-muted flex-wrap">
                  {#if occ.speaker}<span>{speakerLabel(occ.speaker)}</span>{/if}
                  {#if occ.t0 != null}<span>@ {formatMeetingTime(occ.t0)}</span>{/if}
                  {#if occ.meetingId}
                    <button class="text-accent hover:underline" onclick={() => openMeeting(occ.meetingId!)}>
                      {meetingTitle(occ.meetingId)}
                    </button>
                  {/if}
                  <span class="ml-auto">{new Date(occ.at).toLocaleDateString()}</span>
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<ConfirmDialog
  show={confirmDeleteOpen}
  title="Delete journal item"
  message="Delete this journal item? Future meetings will no longer add sightings to it."
  confirmLabel="Delete"
  variant="danger"
  onconfirm={deleteItem}
  oncancel={() => (confirmDeleteOpen = false)}
/>
