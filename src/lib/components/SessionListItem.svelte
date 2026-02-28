<script lang="ts">
  import type { DisplaySession } from "$lib/types/session";
  import {
    getStatusColor,
    getStatusBgColor,
    getStatusLabel,
    isStatusAnimating,
  } from "$lib/utils/sessionStatus";
  import {
    getElapsedTime,
    getLegacyElapsedTime,
    getRepoName,
  } from "$lib/utils/duration";
  import {
    getShortModelName,
    getModelBadgeBgColor,
    getModelTextColor,
  } from "$lib/utils/modelColors";
  import RepoIcon from "$lib/components/RepoIcon.svelte";
  import { findRepoByPath } from "$lib/utils/repoIcons";
  import { repos, findRepoById } from "$lib/stores/repos";

  interface Props {
    session: DisplaySession;
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
    isActive,
    now,
    showLatestMessage,
    showSessionSummary,
    promptRows,
    responseRows,
    onselect,
    onclose,
  }: Props = $props();

  function getDisplayedDuration(): string | null {
    if (session.type === "sdk" || session.type === "sequence") {
      return getElapsedTime(
        session.accumulatedDurationMs,
        session.currentWorkStartedAt,
        session.isFinished,
        now,
      );
    } else {
      return getLegacyElapsedTime(session.startedAt, session.endedAt, now);
    }
  }

  const displayedRepoName = $derived.by(() => {
    if (session.repoId) {
      const repo = findRepoById($repos.list, session.repoId);
      if (repo?.name) return repo.name;
    }
    return getRepoName(session.repoPath);
  });

  // Check if there's any text content between the header row and the repo row
  // (session name, prompt, summary, latest message). Used to add spacing when empty.
  let hasTextContent = $derived(
    !!session.aiMetadata?.name ||
      !!session.prompt ||
      (showSessionSummary && !!session.aiMetadata?.outcome) ||
      (showLatestMessage &&
        session.type === "sdk" &&
        !!session.latestMessage &&
        !session.aiMetadata?.outcome),
  );
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="session-item p-3 border-b border-border/50 hover:bg-surface-elevated/50 transition-all cursor-pointer"
  class:active={isActive}
  class:unread={session.unread}
  onmousedown={(e) => {
    // Middle mouse button closes the session
    if (e.button === 1) {
      e.preventDefault();
      onclose(e);
    }
  }}
  onclick={onselect}
>
  <!-- Header row: type badge, status dot, interaction indicator, time, close button -->
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-2">
      {#if session.noteMode?.isActive}
        <!-- Note mode badge takes priority -->
        <span
          class="px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/20 text-amber-400 rounded flex items-center gap-1"
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
          class="px-1.5 py-0.5 text-[10px] font-medium rounded flex items-center gap-1 {
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
          class="px-1.5 py-0.5 text-[10px] font-medium bg-orange-500/20 text-orange-400 rounded flex items-center gap-1"
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
          class="px-1.5 py-0.5 text-[10px] font-medium bg-teal-500/20 text-teal-400 rounded flex items-center gap-1"
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
          class="px-1.5 py-0.5 text-[10px] font-medium bg-indigo-500/20 text-indigo-400 rounded flex items-center gap-1"
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
      {:else if session.type === "sdk" && session.model}
        <span
          class="px-1.5 py-0.5 text-[10px] font-medium {getModelBadgeBgColor(
            session.model,
          )} {getModelTextColor(session.model)} rounded"
        >
          {getShortModelName(session.model)}
        </span>
      {/if}
      {#if !session.aiMetadata?.needsInteraction}
        <div class="relative">
          <div
            class="w-2 h-2 rounded-full {getStatusBgColor(session.status)}"
          ></div>
          {#if isStatusAnimating(session.status)}
            <div
              class="absolute inset-0 w-2 h-2 rounded-full {getStatusBgColor(
                session.status,
              )} animate-ping opacity-75"
            ></div>
          {/if}
        </div>
      {/if}
      {#if session.aiMetadata?.needsInteraction}
        {@const urgency = session.aiMetadata.interactionUrgency || "low"}
        <span
          class="text-xs font-medium flex items-center gap-1 {urgency === 'high'
            ? 'text-orange-400'
            : 'text-yellow-400'}"
          title={session.aiMetadata.interactionReason || "Needs your input"}
        >
          <svg
            class="w-3 h-3"
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
          {session.aiMetadata.waitingFor || "Input needed"}
        </span>
      {:else}
        <span class="text-xs font-medium {getStatusColor(session.status)}">
          {getStatusLabel(session.status, session.statusDetail)}
        </span>
      {/if}
    </div>
    <div class="flex items-center gap-2">
      {#if getDisplayedDuration() !== null}
        <span class="text-xs text-text-muted font-mono tabular-nums">
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
        <svg
          class="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
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
    <!-- AI-generated session name -->
    <div class="mb-1">
      <span
        class="text-sm text-text-primary"
        class:font-semibold={session.unread}
        class:font-medium={!session.unread}>{session.aiMetadata.name}</span
      >
    </div>
    {#if showSessionSummary && session.aiMetadata.outcome}
      <p
        class="text-xs text-text-muted leading-snug mb-1.5"
        title={session.aiMetadata.outcome}
      >
        {session.aiMetadata.outcome}
      </p>
    {/if}
  {:else if session.prompt}
    <!-- Original prompt text (only show if we have actual content) -->
    <p
      class="text-sm text-text-primary leading-snug mb-1.5 select-text overflow-hidden"
      class:font-semibold={session.unread}
      style="display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: {promptRows};"
      title={session.prompt}
    >
      {session.prompt}
    </p>
  {/if}

  <!-- Sequence progress -->
  {#if session.type === "sequence" && session.sequenceProgress}
    <div class="flex items-center gap-2 mb-1.5">
      <div class="flex-1 h-1 bg-border rounded-full overflow-hidden">
        <div
          class="h-full bg-accent rounded-full transition-all"
          style="width:{Math.round(
            (session.sequenceProgress.completed /
              session.sequenceProgress.total) *
              100,
          )}%"
        ></div>
      </div>
      <span
        class="text-[10px] text-text-muted font-mono tabular-nums flex-shrink-0"
      >
        {session.sequenceProgress.completed}/{session.sequenceProgress.total}
      </span>
    </div>
  {/if}

  <!-- Todo progress (SDK sessions with TodoWrite calls) -->
  {#if session.type === "sdk" && session.todoProgress}
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
        class="text-[10px] text-text-muted font-mono tabular-nums flex-shrink-0"
      >
        {session.todoProgress.completed}/{session.todoProgress.total}
      </span>
    </div>
  {/if}

  <!-- Latest message preview (SDK sessions only, hide when showing outcome) -->
  {#if showLatestMessage && session.type === "sdk" && session.latestMessage && !session.aiMetadata?.outcome}
    <p
      class="text-xs text-text-muted leading-snug mb-1.5 italic overflow-hidden"
      style="display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: {responseRows};"
      title={session.latestMessage}
    >
      {session.latestMessage}
    </p>
  {/if}

  <!-- Repo name and branch (skip for pending_repo; setup sessions show repo when one is selected) -->
  {#if session.status !== "pending_repo" && session.repoPath && session.repoPath !== "."}
    <div class="flex items-center gap-1.5 text-text-muted min-w-0 overflow-hidden" class:mt-1.5={!hasTextContent}>
      <RepoIcon
        repo={session.repoId ? findRepoById($repos.list, session.repoId) : findRepoByPath($repos.list, session.repoPath)}
        size="xs"
      />
      <span class="text-xs truncate min-w-0 max-w-[50%]">{displayedRepoName}</span>
      {#if session.branch}
        <span class="text-xs text-text-muted flex-shrink-0">·</span>
        <span
          class="text-xs text-blue-400/70 truncate min-w-0 max-w-[50%]"
          title="Git branch: {session.branch}"
        >
          {session.branch}
        </span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .session-item {
    border-left: 3px solid transparent;
    position: relative;
  }

  /* Active/focused session - white background */
  .session-item.active {
    background-color: rgba(255, 255, 255, 0.12);
  }

  /* Unread session - background highlight */
  .session-item.unread {
    background-color: rgba(99, 102, 241, 0.15);
  }

  /* Both active and unread */
  .session-item.active.unread {
    background-color: rgba(255, 255, 255, 0.12);
  }
</style>
