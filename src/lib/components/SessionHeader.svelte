<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { TerminalSession } from '$lib/stores/sessions';
  import { sessions } from '$lib/stores/sessions';
  import { settings } from '$lib/stores/settings';
  import RepoIcon from '$lib/components/RepoIcon.svelte';
  import { findRepoByPath } from '$lib/utils/repoIcons';

  export let session: TerminalSession;

  let elapsed = 0;
  let interval: ReturnType<typeof setInterval> | null = null;

  $: isRunning = session.status === 'Running' || session.status === 'Starting';

  onMount(() => {
    updateElapsed();
    interval = setInterval(updateElapsed, 1000);
  });

  onDestroy(() => {
    if (interval) clearInterval(interval);
  });

  function updateElapsed() {
    const now = Math.floor(Date.now() / 1000);
    elapsed = Math.max(0, now - session.created_at);
  }

  function formatTime(seconds: number): string {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function getStatusColor(status: string): string {
    switch (status) {
      case 'Starting': return 'text-yellow-400';
      case 'Running': return 'text-emerald-400';
      case 'Completed': return 'text-blue-400';
      case 'Failed': return 'text-red-400';
      default: return 'text-text-muted';
    }
  }

  function getStatusBgColor(status: string): string {
    switch (status) {
      case 'Starting': return 'bg-yellow-400/10 border-yellow-400/20';
      case 'Running': return 'bg-emerald-400/10 border-emerald-400/20';
      case 'Completed': return 'bg-blue-400/10 border-blue-400/20';
      case 'Failed': return 'bg-red-400/10 border-red-400/20';
      default: return 'bg-surface-elevated border-border';
    }
  }

  function getStatusLabel(status: string): string {
    return status === 'Running' ? 'Active' : status;
  }

  async function closeSession() {
    await sessions.closeSession(session.id);
  }

  // Extract repo name from path
  $: repoName = session.repo_path.split(/[/\\]/).pop() || session.repo_path;
</script>

<div class="session-header border-b border-border bg-surface">
  <!-- Top bar with status, timer, and actions -->
  <div class="flex items-center justify-between px-4 py-2 border-b border-border/50">
    <div class="flex items-center gap-3">
      <!-- Status badge -->
      <div class="flex items-center gap-2 px-2.5 py-1 rounded-full border {getStatusBgColor(session.status)}">
        {#if isRunning}
          <span class="status-dot {getStatusColor(session.status)}"></span>
        {/if}
        <span class="text-xs font-medium {getStatusColor(session.status)}">{getStatusLabel(session.status)}</span>
      </div>

      <!-- Timer -->
      <div class="flex items-center gap-1.5 text-text-muted">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span class="text-sm font-mono tabular-nums">{formatTime(elapsed)}</span>
      </div>

      <!-- Repo -->
      <div class="flex items-center gap-1.5 text-text-muted">
        <RepoIcon repo={findRepoByPath($settings.repos, session.repo_path)} size="xs" />
        <span class="text-sm">{repoName}</span>
      </div>
    </div>

    <div class="flex items-center gap-2">
      <!-- Close button -->
      <button
        class="p-1.5 text-text-muted hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
        onclick={closeSession}
        title="Close session"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  </div>

  <!-- Prompt/Transcript section (only if there's a prompt) -->
  {#if session.prompt}
    <div class="px-4 py-3">
      <div class="flex items-start gap-3">
        <div class="flex-shrink-0 w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center">
          <svg class="w-4 h-4 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-xs text-text-muted mb-1 font-medium uppercase tracking-wide">Voice Prompt</div>
          <p class="text-sm text-text-primary leading-relaxed select-text">{session.prompt}</p>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background-color: currentColor;
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
</style>
