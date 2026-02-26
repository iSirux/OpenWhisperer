<script lang="ts">
  import type { DisplaySession } from '$lib/types/session';
  import type { SessionsGridSize } from '$lib/stores/settings';
  import {
    getStatusColor,
    getStatusBgColor,
    getStatusLabel,
    isStatusAnimating
  } from '$lib/utils/sessionStatus';
  import { getElapsedTime, getRepoName } from '$lib/utils/duration';
  import { getShortModelName, getModelBadgeBgColor, getModelTextColor } from '$lib/utils/modelColors';
  import RepoIcon from '$lib/components/RepoIcon.svelte';
  import { findRepoByPath } from '$lib/utils/repoIcons';
  import { repos, findRepoById } from '$lib/stores/repos';

  interface Props {
    session: DisplaySession;
    size: SessionsGridSize;
    isActive: boolean;
    now: number;
    showLatestMessage: boolean;
    showSessionSummary: boolean;
    promptRows: number;
    responseRows: number;
    onselect: () => void;
    onclose: (event: MouseEvent) => void;
  }

  let {
    session,
    size,
    isActive,
    now,
    showLatestMessage,
    showSessionSummary,
    promptRows,
    responseRows,
    onselect,
    onclose
  }: Props = $props();

  function getDisplayedDuration(): string | null {
    return getElapsedTime(
      session.accumulatedDurationMs,
      session.currentWorkStartedAt,
      session.isFinished,
      now
    );
  }

  const displayedRepoName = $derived.by(() => {
    if (session.repoId) {
      const repo = findRepoById($repos.list, session.repoId);
      if (repo?.name) return repo.name;
    }
    return getRepoName(session.repoPath);
  });

  // Size-based styling
  let sizeClasses = $derived.by(() => {
    switch (size) {
      case 'small':
        return {
          padding: 'p-2',
          title: 'text-xs',
          text: 'text-[10px]',
          badge: 'text-[8px] px-1 py-0.5',
          dot: 'w-1.5 h-1.5',
          icon: 'w-3 h-3',
          gap: 'gap-1'
        };
      case 'large':
        return {
          padding: 'p-4',
          title: 'text-base',
          text: 'text-sm',
          badge: 'text-xs px-2 py-1',
          dot: 'w-2.5 h-2.5',
          icon: 'w-4 h-4',
          gap: 'gap-3'
        };
      default: // medium
        return {
          padding: 'p-3',
          title: 'text-sm',
          text: 'text-xs',
          badge: 'text-[10px] px-1.5 py-0.5',
          dot: 'w-2 h-2',
          icon: 'w-3.5 h-3.5',
          gap: 'gap-2'
        };
    }
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="session-card {sizeClasses.padding} rounded-lg border transition-all cursor-pointer hover:shadow-md {isActive
    ? 'active border-accent bg-accent-subtle'
    : 'border-border bg-surface-elevated hover:bg-surface-elevated hover:border-accent-muted'}"
  class:unread={session.unread}
  onmousedown={(e) => {
    if (e.button === 1) {
      e.preventDefault();
      onclose(e);
    }
  }}
  onclick={onselect}
>
  <!-- Header row -->
  <div class="flex items-center justify-between mb-2">
    <div class="flex items-center {sizeClasses.gap}">
      {#if session.noteMode?.isActive}
        <!-- Note mode badge takes priority -->
        <span
          class="{sizeClasses.badge} font-medium bg-amber-500/20 text-amber-400 rounded flex items-center gap-1"
          title={session.noteMode.noteCreated
            ? "Note created"
            : "Taking note..."}
        >
          <svg
            class="w-2.5 h-2.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
            />
          </svg>
          Note
        </span>
      {:else if session.planMode?.isActive}
        <!-- Planning badge - changes color when awaiting plan approval -->
        <span
          class="{sizeClasses.badge} font-medium rounded flex items-center gap-1 {
            session.pendingPlanApproval
              ? 'bg-orange-500/20 text-orange-400'
              : 'bg-cyan-500/20 text-cyan-400'
          }"
          title={session.pendingPlanApproval
            ? "Plan ready for review"
            : session.planMode.isComplete
              ? "Planning complete"
              : "Planning in progress"}
        >
          <svg
            class="w-2.5 h-2.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            {#if session.pendingPlanApproval}
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            {:else}
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              />
            {/if}
          </svg>
          {session.pendingPlanApproval ? "Review Plan" : session.planMode.isComplete ? "Plan" : "Planning"}
        </span>
      {:else if session.askUserQuestion}
        <!-- AskUserQuestion badge -->
        <span
          class="{sizeClasses.badge} font-medium bg-orange-500/20 text-orange-400 rounded flex items-center gap-1"
          title="Claude is asking a question"
        >
          <svg
            class="w-2.5 h-2.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          Input Needed
        </span>
      {:else if session.status === "prepared"}
        <!-- Prepared badge (teal) -->
        <span
          class="{sizeClasses.badge} font-medium bg-teal-500/20 text-teal-400 rounded flex items-center gap-1"
          title="Session prepared - ready to launch"
        >
          <svg
            class="w-2.5 h-2.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
            />
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          Prepared
        </span>
      {:else if session.type === "sequence"}
        <!-- Sequence badge -->
        <span
          class="{sizeClasses.badge} font-medium bg-indigo-500/20 text-indigo-400 rounded flex items-center gap-1"
          title="Sequence execution"
        >
          <svg
            class="w-2.5 h-2.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
          Sequence
        </span>
      {:else if session.type === 'sdk' && session.model}
        <span
          class="{sizeClasses.badge} font-medium {getModelBadgeBgColor(session.model)} {getModelTextColor(session.model)} rounded"
        >
          {getShortModelName(session.model)}
        </span>
      {/if}
      <div class="relative">
        <div class="{sizeClasses.dot} rounded-full {getStatusBgColor(session.status)}"></div>
        {#if isStatusAnimating(session.status)}
          <div
            class="absolute inset-0 {sizeClasses.dot} rounded-full {getStatusBgColor(session.status)} animate-ping opacity-75"
          ></div>
        {/if}
      </div>
      {#if session.aiMetadata?.needsInteraction}
        {@const urgency = session.aiMetadata.interactionUrgency || 'low'}
        <span
          class="{sizeClasses.text} font-medium flex items-center gap-0.5 {urgency === 'high'
            ? 'text-orange-400'
            : urgency === 'medium'
              ? 'text-yellow-400'
              : 'text-blue-400'}"
          title={session.aiMetadata.interactionReason || 'Needs your input'}
        >
          <svg class="{sizeClasses.icon}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          {session.aiMetadata.waitingFor || 'Input needed'}
        </span>
      {:else}
        <span class="{sizeClasses.text} font-medium {getStatusColor(session.status)}">
          {getStatusLabel(session.status, session.statusDetail)}
        </span>
      {/if}
    </div>
    <div class="flex items-center {sizeClasses.gap}">
      {#if getDisplayedDuration() !== null}
        <span class="{sizeClasses.text} text-text-muted font-mono tabular-nums">
          {getDisplayedDuration()}
        </span>
      {/if}
      <button
        class="text-text-muted hover:text-red-400 hover:bg-red-400/10 rounded p-0.5 transition-colors"
        onclick={(e) => {
          e.stopPropagation();
          onclose(e);
        }}
        title="Close session"
      >
        <svg class="{sizeClasses.icon}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  </div>

  <!-- Session name or prompt text -->
  {#if session.aiMetadata?.name}
    <div class="mb-1">
      <span class="{sizeClasses.title} font-medium text-text-primary">{session.aiMetadata.name}</span
      >
    </div>
    {#if showSessionSummary && session.aiMetadata.outcome && size !== 'small'}
      <p
        class="{sizeClasses.text} text-text-muted leading-snug mb-1.5"
        title={session.aiMetadata.outcome}
      >
        {session.aiMetadata.outcome}
      </p>
    {/if}
  {:else if session.prompt}
    <!-- Only show prompt text if we have actual content -->
    <p
      class="{sizeClasses.title} text-text-primary leading-snug mb-1.5 select-text overflow-hidden"
      style="display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: {promptRows};"
      title={session.prompt}
    >
      {session.prompt}
    </p>
  {/if}

  <!-- Latest message preview (SDK sessions only, hide when showing outcome) -->
  {#if showLatestMessage && session.type === 'sdk' && session.latestMessage && size !== 'small' && !session.aiMetadata?.outcome}
    <p
      class="{sizeClasses.text} text-text-muted leading-snug mb-1.5 italic overflow-hidden"
      style="display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: {responseRows};"
      title={session.latestMessage}
    >
      {session.latestMessage}
    </p>
  {/if}

  <!-- Todo progress (SDK sessions with TodoWrite calls) -->
  {#if session.type === "sdk" && session.todoProgress && size !== 'small'}
    <div class="flex items-center gap-2 mb-1.5">
      <div class="flex-1 h-1 bg-border rounded-full overflow-hidden">
        <div
          class="h-full bg-emerald-400 rounded-full transition-all"
          style="width:{Math.round(
            (session.todoProgress.completed /
              session.todoProgress.total) *
              100,
          )}%"
        ></div>
      </div>
      <span
        class="{sizeClasses.text} text-text-muted font-mono tabular-nums flex-shrink-0"
      >
        {session.todoProgress.completed}/{session.todoProgress.total}
      </span>
    </div>
  {/if}

  <!-- Repo name, branch -->
  <div class="flex items-center gap-1.5 text-text-muted">
    <RepoIcon repo={session.repoId ? findRepoById($repos.list, session.repoId) : findRepoByPath($repos.list, session.repoPath)} size="xs" />
    <span class="{sizeClasses.text} truncate">{displayedRepoName()}</span>
    {#if session.branch}
      <span class="{sizeClasses.text} text-text-muted">·</span>
      <span class="{sizeClasses.text} text-blue-400/70" title="Git branch: {session.branch}">
        {session.branch}
      </span>
    {/if}
  </div>
</div>

<style>
  .session-card {
    position: relative;
  }

  /* Active session - purple/accent styling */
  .session-card.active {
    background-color: color-mix(in srgb, var(--color-accent) 10%, transparent);
  }

  .session-card:not(.active):hover {
    border-color: color-mix(in srgb, var(--color-accent) 50%, transparent);
  }

  /* Unread session - blue border with subtle tint */
  .session-card.unread:not(.active) {
    background-color: rgba(59, 130, 246, 0.08);
    border-color: rgb(59, 130, 246);
  }

  .session-card.unread:not(.active):hover {
    border-color: rgb(59, 130, 246);
    background-color: rgba(59, 130, 246, 0.12);
  }

  /* Active + unread - active takes visual precedence, add blue inner glow */
  .session-card.unread.active {
    box-shadow: inset 0 0 0 2px rgba(59, 130, 246, 0.5);
  }

  /* Custom classes for accent colors with opacity */
  :global(.bg-accent-subtle) {
    background-color: color-mix(in srgb, var(--color-accent) 10%, transparent);
  }

  :global(.border-accent-muted) {
    border-color: color-mix(in srgb, var(--color-accent) 50%, transparent);
  }
</style>
