<script lang="ts">
  /**
   * Main-pane Meeting view (`MainView 'meeting'`). Home = start panel (or the
   * live meeting banner) + past meetings; selecting a meeting opens its detail
   * (live status, delayed transcript, review list, summary).
   */
  import { meetings, activeMeeting } from '$lib/stores/meetings';
  import MeetingStartPanel from './MeetingStartPanel.svelte';
  import MeetingPastList from './MeetingPastList.svelte';
  import MeetingDetail from './MeetingDetail.svelte';

  const selectedId = $derived($meetings.selectedId);
  const selectedExists = $derived(
    !!selectedId && (!!$meetings.runtimes[selectedId] || $meetings.list.some((m) => m.id === selectedId))
  );

  $effect(() => {
    if (selectedId) void meetings.ensureLoaded(selectedId);
  });
</script>

{#if selectedId && selectedExists}
  <MeetingDetail meetingId={selectedId} />
{:else}
  <div class="flex-1 flex flex-col overflow-hidden">
    <div class="px-4 py-3 border-b border-border flex items-center gap-3">
      <svg class="w-5 h-5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
      <div class="flex-1 min-w-0">
        <h1 class="text-base font-medium text-text-primary">Meeting Mode</h1>
        <p class="text-xs text-text-muted">
          Record a call or in-person meeting and collect bugs, tasks and ideas without dictating.
        </p>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto p-4 space-y-4 max-w-3xl w-full mx-auto">
      {#if $activeMeeting}
        <button
          class="w-full p-3 rounded border border-red-500/40 bg-red-500/10 flex items-center gap-3 text-left hover:bg-red-500/15 transition-colors"
          onclick={() => meetings.openMeeting($activeMeeting!.id)}
        >
          <span class="relative w-2.5 h-2.5 shrink-0">
            <span class="absolute inset-0 rounded-full bg-red-500"></span>
            {#if $activeMeeting.status === 'recording'}
              <span class="absolute inset-0 rounded-full bg-red-500 animate-ping opacity-60"></span>
            {/if}
          </span>
          <span class="flex-1 min-w-0">
            <span class="block text-sm font-medium text-text-primary truncate">
              {$activeMeeting.title || 'Meeting'} — {$activeMeeting.status}
            </span>
            <span class="block text-xs text-text-muted">Open the live meeting</span>
          </span>
          <svg class="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      {:else}
        <MeetingStartPanel />
      {/if}

      <MeetingPastList />
    </div>
  </div>
{/if}
