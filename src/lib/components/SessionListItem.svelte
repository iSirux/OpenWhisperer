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
  import { visibleSessionIds, focusedPaneSessionId } from "$lib/stores/panes";

  /** DnD payload type shared with SessionPanes (keep in sync). */
  const SESSION_DND_TYPE = "application/x-openwhisperer-session-id";

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

  // Live countdown to an epoch-ms target, driven by the `now` prop so it stays
  // fresh. Mirrors the formatting of `formatTimeRemaining` in rateLimits.ts.
  function formatMsRemaining(target: number | undefined | null, ref: number): string {
    if (target == null) return "";
    const diff = target - ref;
    if (diff <= 0) return "now";
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

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

  // Only SDK sessions can be dropped into a pane.
  const isDraggable = $derived(session.type === "sdk");
  // Shown in a (non-focused) pane right now — distinct from the active/focused styling.
  const isOnScreen = $derived(
    session.type === "sdk" &&
      $visibleSessionIds.has(session.id) &&
      $focusedPaneSessionId !== session.id,
  );

  function handleDragStart(e: DragEvent) {
    if (!isDraggable || !e.dataTransfer) return;
    e.dataTransfer.setData(SESSION_DND_TYPE, session.id);
    e.dataTransfer.effectAllowed = "move";
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="session-item p-3 border-b border-border/50 hover:bg-surface-elevated/50 transition-all cursor-pointer"
  class:active={isActive}
  class:unread={session.unread}
  class:on-screen={isOnScreen}
  draggable={isDraggable}
  ondragstart={handleDragStart}
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
      {#if session.askUserQuestion}
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
      {#if isOnScreen}
        <span class="on-screen-glyph" title="Showing in a pane">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <rect x="4" y="5" width="16" height="14" rx="1.5" />
            <line x1="12" y1="5" x2="12" y2="19" />
          </svg>
        </span>
      {/if}
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
    <div class="mb-1 flex items-center gap-1.5">
      <span
        class="text-sm text-text-primary"
        class:font-semibold={session.unread}
        class:font-medium={!session.unread}>{session.aiMetadata.name}</span
      >
    </div>
    {#if showSessionSummary && session.aiMetadata.outcome}
      <p
        class="text-xs text-text-muted leading-snug mb-1.5 session-text-wrap"
        title={session.aiMetadata.outcome}
      >
        {session.aiMetadata.outcome}
      </p>
    {/if}
  {:else if session.prompt}
    <!-- Original prompt text (only show if we have actual content) -->
    <p
      class="text-sm text-text-primary leading-snug mb-1.5 select-text overflow-hidden session-text-wrap"
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
      class="text-xs text-text-muted leading-snug mb-1.5 italic overflow-hidden session-text-wrap"
      style="display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: {responseRows};"
      title={session.latestMessage}
    >
      {session.latestMessage}
    </p>
  {/if}

  {#if session.forkInfo}
    <div
      class="fork-lineage"
      title={session.forkInfo.parentLabel
        ? `Forked from ${session.forkInfo.parentLabel}`
        : "Forked session"}
    >
      <svg class="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
        <path fill-rule="evenodd" d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM5 5.372a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5v2.128a2.251 2.251 0 1 0 1.5 0V8.5h1.5a2.25 2.25 0 0 0 2.25-2.25v-.878a2.25 2.25 0 1 0-1.5 0v.878a.75.75 0 0 1-.75.75h-4.5A.75.75 0 0 1 5 6.25v-.878ZM8.75 12.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.25 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" />
      </svg>
      <span class="truncate">
        {session.forkInfo.parentLabel
          ? `Fork of ${session.forkInfo.parentLabel}`
          : `Forked session`}
      </span>
    </div>
  {/if}

  {#if session.notionCard}
    <div class="notion-card-link" title="Notion card: {session.notionCard.title}">
      <svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="currentColor" opacity="0.7">
        <path d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z" />
      </svg>
      <span class="truncate">{session.notionCard.title}</span>
    </div>
  {/if}

  {#if session.pileItem}
    <div class="notion-card-link" title="From pile: {session.pileItem.title}">
      <svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.7">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4 17h16M4 12h16M7 7h10" />
      </svg>
      <span class="truncate">{session.pileItem.title}</span>
    </div>
  {/if}

  <!-- Schedule / queue row (Smart Queue: parked until reset / scheduled window) -->
  {#if session.status === "queued"}
    {@const qi = session.queueInfo}
    {@const qWindow = qi?.window === "7d" ? "7d" : "5h"}
    {@const qCountdown = formatMsRemaining(qi?.targetStartAt, now)}
    <div
      class="schedule-row"
      title={qi?.reason === "scheduled"
        ? `Scheduled launch for the next ${qWindow} reset`
        : "Queued - waiting for the rate limit to reset"}
    >
      <svg
        class="w-3 h-3 shrink-0"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        viewBox="0 0 24 24"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
      <span class="truncate">
        {qi?.reason === "scheduled" ? "Scheduled" : "Queued"}
        {#if qCountdown}
          · {qi?.reason === "scheduled"
            ? `next ${qWindow} reset · in ${qCountdown}`
            : `rate limited · resets in ${qCountdown}`}
        {/if}
      </span>
    </div>
  {/if}

  <!-- Repo name and branch (skip for pending_repo; setup sessions show repo when one is selected) -->
  {#if session.status !== "pending_repo" && session.repoPath && session.repoPath !== "."}
    <div class="flex items-center gap-1.5 text-text-muted min-w-0 overflow-hidden" class:mt-1.5={!hasTextContent}>
      <RepoIcon
        repo={session.repoId ? findRepoById($repos.list, session.repoId) : findRepoByPath($repos.list, session.repoPath)}
        size="xs"
      />
      <span class="text-xs truncate min-w-0 max-w-[50%]">{displayedRepoName}</span>
      {#if session.branch && session.status !== "setup"}
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

  /* Session is visible in a non-focused pane: understated accent bar + glyph,
     kept distinct from the .active (focused) styling. */
  .session-item.on-screen:not(.active) {
    border-left-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
  }

  .on-screen-glyph {
    color: color-mix(in srgb, var(--color-accent) 80%, transparent);
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .fork-lineage {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    margin-bottom: 0.35rem;
    font-size: 0.72rem;
    color: rgb(251, 191, 36);
    min-width: 0;
  }

  .notion-card-link {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    margin-bottom: 0.35rem;
    font-size: 0.72rem;
    color: rgb(148, 163, 184);
    min-width: 0;
  }

  .schedule-row {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    margin-bottom: 0.35rem;
    font-size: 0.72rem;
    color: rgb(56, 189, 248);
    min-width: 0;
  }

  .session-text-wrap {
    overflow-wrap: anywhere;
    word-break: break-word;
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
