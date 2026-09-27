<script lang="ts">
  /** Past meetings: open, finalize interrupted ones, delete. */
  import { meetings, formatMeetingTime, type MeetingMeta } from '$lib/stores/meetings';
  import { repos, findRepoById } from '$lib/stores/repos';
  import ConfirmDialog from '../ConfirmDialog.svelte';

  let confirmDelete = $state<MeetingMeta | null>(null);
  let finalizing = $state<string | null>(null);

  const past = $derived($meetings.list.filter((m) => m.id !== $meetings.activeId));

  const STATUS_CLASS: Record<string, string> = {
    done: 'bg-emerald-500/15 text-emerald-400',
    interrupted: 'bg-amber-500/15 text-amber-400',
    finalizing: 'bg-sky-500/15 text-sky-400',
    recording: 'bg-red-500/15 text-red-400',
    paused: 'bg-amber-500/15 text-amber-400',
  };

  function repoName(meta: MeetingMeta): string {
    if (meta.auto_repo) return 'Auto repo';
    return findRepoById($repos.list, meta.repo_id ?? undefined)?.name ?? '';
  }

  async function finalize(meta: MeetingMeta) {
    finalizing = meta.id;
    try {
      await meetings.finalize(meta.id);
    } finally {
      finalizing = null;
    }
  }

  async function doDelete() {
    const target = confirmDelete;
    confirmDelete = null;
    if (target) await meetings.remove(target.id);
  }
</script>

<div>
  <div class="flex items-center justify-between mb-2">
    <h2 class="text-xs font-medium text-text-secondary uppercase tracking-wide">Past meetings</h2>
    <button
      class="text-[11px] text-text-muted hover:text-text-secondary"
      onclick={() => meetings.refreshList()}
    >
      Refresh
    </button>
  </div>
  {#if !$meetings.listLoaded}
    <p class="text-xs text-text-muted">Loading…</p>
  {:else if past.length === 0}
    <p class="text-xs text-text-muted">No meetings yet.</p>
  {:else}
    <div class="space-y-1">
      {#each past as meta (meta.id)}
        <div
          class="rounded border border-border bg-surface-elevated/50 hover:bg-surface-elevated p-2 flex items-center gap-2 cursor-pointer transition-colors"
          role="button"
          tabindex="0"
          onclick={() => meetings.openMeeting(meta.id)}
          onkeydown={(e) => e.key === 'Enter' && meetings.openMeeting(meta.id)}
        >
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="text-xs font-medium text-text-primary truncate">{meta.title || 'Meeting'}</span>
              <span class="text-[10px] px-1.5 py-px rounded shrink-0 {STATUS_CLASS[meta.status] ?? 'bg-surface text-text-muted'}">
                {meta.status}
              </span>
            </div>
            <div class="flex items-center gap-2 mt-0.5 text-[11px] text-text-muted">
              <span>{new Date(meta.started_at).toLocaleString()}</span>
              <span>· {formatMeetingTime(meta.duration_secs)}</span>
              {#if repoName(meta)}
                <span class="truncate">· {repoName(meta)}</span>
              {/if}
              {#if meta.failed_segments > 0}
                <span class="text-red-400">· {meta.failed_segments} failed</span>
              {/if}
              {#if meta.pending_segments > 0}
                <span class="text-amber-400">· {meta.pending_segments} pending</span>
              {/if}
            </div>
          </div>
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="flex items-center gap-1 shrink-0" onclick={(e) => e.stopPropagation()}>
            {#if meta.status === 'interrupted'}
              <button
                class="px-2 py-0.5 rounded text-[11px] font-medium bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-50"
                disabled={finalizing === meta.id}
                onclick={() => finalize(meta)}
                title="Transcribe the remaining segments, then triage and summarize"
              >
                {finalizing === meta.id ? 'Finalizing…' : 'Finalize'}
              </button>
            {/if}
            <button
              class="px-2 py-0.5 rounded text-[11px] text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
              onclick={() => (confirmDelete = meta)}
            >
              Delete
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<ConfirmDialog
  show={confirmDelete != null}
  title="Delete meeting"
  message={`Delete “${confirmDelete?.title || 'Meeting'}” with its transcript and audio? Pile and journal items it produced are kept.`}
  confirmLabel="Delete"
  variant="danger"
  onconfirm={doDelete}
  oncancel={() => (confirmDelete = null)}
/>
