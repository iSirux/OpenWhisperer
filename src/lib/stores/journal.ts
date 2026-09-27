/**
 * Journal store (Meeting Mode).
 *
 * The journal holds everything worth keeping from meetings that isn't a task
 * *yet*: feedback, ideas, decisions, notes (and questions sent here by the
 * user). Items accumulate across meetings — meeting triage receives the repo's
 * open journal items and emits `update` ops against them, so "the jump feels
 * floaty" said in three playtests is one item with three sightings.
 *
 * Persisted to its own file via `get_journal` / `save_journal` (opaque JSON,
 * frontend owns the schema, `.dev.json` split in debug builds) — the pile /
 * schedules pattern. Entries come only from meetings (no direct-entry hotkey).
 */

import { writable, derived, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';

import { pile, type PileItemSource } from './pile';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JournalCategory = 'feedback' | 'idea' | 'decision' | 'note' | 'question';
export type JournalStatus = 'open' | 'promoted' | 'dismissed';

export const JOURNAL_CATEGORIES: JournalCategory[] = [
  'feedback',
  'idea',
  'decision',
  'note',
  'question',
];

export interface JournalOccurrence {
  meetingId?: string;
  quote: string;
  /** Seconds from meeting start */
  t0?: number;
  t1?: number;
  speaker?: string;
  /** Meeting segment id — makes the sighting's clip playable */
  segId?: string;
  /** Epoch ms when this sighting was recorded */
  at: number;
}

export interface JournalItem {
  id: string;
  category: JournalCategory;
  title: string;
  detail: string;
  repoId?: string;
  tags: string[];
  occurrences: JournalOccurrence[];
  status: JournalStatus;
  promotedPileItemId?: string;
  /** Meeting item this journal item was created from (first meeting) */
  meetingItemId?: string;
  /** Set once the user edited title/detail — triage/consolidation then stop rewriting them */
  edited?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AddJournalItemInput {
  category: JournalCategory;
  title: string;
  detail?: string;
  repoId?: string;
  tags?: string[];
  occurrences?: JournalOccurrence[];
  meetingItemId?: string;
}

/** Coerce any triage/meeting category into a journal category. */
export function toJournalCategory(category: string | null | undefined): JournalCategory {
  if (category && (JOURNAL_CATEGORIES as string[]).includes(category)) {
    return category as JournalCategory;
  }
  // Actionable categories sent to the journal by the user keep their meaning
  // best as a question (investigate) or a note (bug/task).
  if (category === 'investigate') return 'question';
  return 'note';
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function createJournalStore() {
  const { subscribe, set, update } = writable<JournalItem[]>([]);

  let loaded = false;
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;

  function schedulePersist() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(persist, 500);
  }

  async function persist() {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    // Never overwrite the file with the empty pre-load state.
    if (!loaded) return;
    try {
      await invoke('save_journal', { items: get({ subscribe }) });
    } catch (error) {
      console.error('[journal] Failed to save journal:', error);
    }
  }

  async function load() {
    try {
      const items = await invoke<JournalItem[]>('get_journal');
      set(
        (Array.isArray(items) ? items : []).map((item) => ({
          ...item,
          tags: item.tags ?? [],
          occurrences: item.occurrences ?? [],
          status: item.status ?? 'open',
        }))
      );
      loaded = true;
    } catch (error) {
      console.error('[journal] Failed to load journal:', error);
    }
  }

  function getItem(id: string): JournalItem | undefined {
    return get({ subscribe }).find((item) => item.id === id);
  }

  function add(input: AddJournalItemInput): JournalItem {
    const now = Date.now();
    const item: JournalItem = {
      id: crypto.randomUUID(),
      category: input.category,
      title: input.title.trim() || 'Untitled',
      detail: input.detail ?? '',
      repoId: input.repoId || undefined,
      tags: input.tags ?? [],
      occurrences: input.occurrences ?? [],
      status: 'open',
      meetingItemId: input.meetingItemId,
      createdAt: now,
      updatedAt: now,
    };
    update((items) => [item, ...items]);
    schedulePersist();
    return item;
  }

  function updateItem(id: string, patch: Partial<JournalItem>) {
    update((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item))
    );
    schedulePersist();
  }

  /** User edit: like `updateItem`, but marks the item `edited` so automated
   *  passes (triage updates, consolidation) no longer rewrite title/detail. */
  function editItem(id: string, patch: Partial<Pick<JournalItem, 'title' | 'detail'>>) {
    updateItem(id, { ...patch, edited: true });
  }

  /** Automated (non-user) title/detail rewrite — skipped for user-edited items. */
  function updateItemIfUnedited(id: string, patch: Partial<JournalItem>) {
    const item = getItem(id);
    if (!item) return;
    if (item.edited) {
      const { title: _t, detail: _d, ...rest } = patch;
      if (Object.keys(rest).length > 0) updateItem(id, rest);
      return;
    }
    updateItem(id, patch);
  }

  /** Append a sighting (deduped by meeting + segment + quote). `detail` only
   *  replaces the item's detail when the user hasn't edited it. */
  function addOccurrence(id: string, occurrence: JournalOccurrence, detail?: string | null) {
    update((items) =>
      items.map((item) => {
        if (item.id !== id) return item;
        const duplicate = item.occurrences.some(
          (o) =>
            o.meetingId === occurrence.meetingId &&
            o.quote.trim() === occurrence.quote.trim() &&
            (o.segId ?? '') === (occurrence.segId ?? '')
        );
        return {
          ...item,
          detail: detail?.trim() && !item.edited ? detail : item.detail,
          occurrences: duplicate ? item.occurrences : [...item.occurrences, occurrence],
          updatedAt: Date.now(),
        };
      })
    );
    schedulePersist();
  }

  function remove(id: string) {
    update((items) => items.filter((item) => item.id !== id));
    schedulePersist();
  }

  function setStatus(id: string, status: JournalStatus) {
    updateItem(id, { status });
  }

  /**
   * Promote a journal item to the pile as a text item. Keeps the link both
   * ways: the pile item's `source.journal_item_id` and the journal item's
   * `promotedPileItemId`. Returns the pile item id.
   */
  function promote(id: string): string | null {
    const item = getItem(id);
    if (!item) return null;

    const first = item.occurrences.find((o) => o.meetingId) ?? item.occurrences[0];
    const quotes = item.occurrences
      .slice(0, 5)
      .map((o) => `> ${o.quote}${o.speaker ? ` — ${o.speaker}` : ''}`)
      .join('\n');
    const transcript = [
      item.title,
      item.detail,
      item.occurrences.length > 0
        ? `Raised ${item.occurrences.length} time(s) in meetings (${item.category}):\n${quotes}`
        : '',
    ]
      .filter((part) => part && part.trim())
      .join('\n\n');

    const source: PileItemSource | undefined = first?.meetingId
      ? {
          kind: 'meeting',
          meeting_id: first.meetingId,
          item_id: item.meetingItemId ?? item.id,
          quote: first.quote,
          t0: first.t0 ?? 0,
          t1: first.t1 ?? first.t0 ?? 0,
          seg_id: first.segId,
          speaker: first.speaker,
          journal_item_id: item.id,
        }
      : undefined;

    const pileItemId = pile.addTextItem({
      transcript,
      title: item.title,
      category: item.category,
      repoId: item.repoId,
      source,
    });
    updateItem(id, { status: 'promoted', promotedPileItemId: pileItemId });
    return pileItemId;
  }

  /**
   * Open items relevant to a repo, for cross-meeting dedupe in triage. With a
   * null repo (auto-repo meetings) every open item is a candidate. Items
   * without a repo always qualify.
   */
  function openItemsForRepo(repoId: string | null, limit = 80): JournalItem[] {
    return get({ subscribe })
      .filter(
        (item) =>
          item.status === 'open' && (repoId == null || !item.repoId || item.repoId === repoId)
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  return {
    subscribe,
    load,
    persist,
    isLoaded: () => loaded,
    getItem,
    add,
    updateItem,
    editItem,
    updateItemIfUnedited,
    addOccurrence,
    remove,
    setStatus,
    promote,
    openItemsForRepo,
  };
}

export const journal = createJournalStore();

/** Currently selected journal item (shown in the main pane). */
export const selectedJournalItemId = writable<string | null>(null);

export const selectedJournalItem = derived(
  [journal, selectedJournalItemId],
  ([$journal, $id]) => ($id ? ($journal.find((item) => item.id === $id) ?? null) : null)
);

/** Open journal items (sidebar tab count). */
export const journalOpenCount = derived(
  journal,
  ($journal) => $journal.filter((item) => item.status === 'open').length
);

export const JOURNAL_CATEGORY_STYLE: Record<JournalCategory, { label: string; cls: string }> = {
  feedback: { label: 'Feedback', cls: 'bg-sky-500/15 text-sky-400' },
  idea: { label: 'Idea', cls: 'bg-violet-500/15 text-violet-400' },
  decision: { label: 'Decision', cls: 'bg-emerald-500/15 text-emerald-400' },
  note: { label: 'Note', cls: 'bg-surface text-text-secondary' },
  question: { label: 'Question', cls: 'bg-amber-500/15 text-amber-400' },
};
