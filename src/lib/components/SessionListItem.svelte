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
  import { settings } from "$lib/stores/settings";
  import { accountById, isDefaultAccountId } from "$lib/utils/accounts";
  import { visibleSessionIds, focusedPaneSessionId } from "$lib/stores/panes";
  import { ctrlHeld } from "$lib/stores/ctrlHint";
  import { SPARE_TOKENS_LIBRARY } from "$lib/spareTokens/library";

  /** DnD payload type shared with SessionPanes (keep in sync). */
  const SESSION_DND_TYPE = "application/x-openwhisperer-session-id";

  interface Props {
    session: DisplaySession;
    /** 1-9 for the first sessions in the list; shown as an overlay badge while Ctrl is held (Ctrl+number switches). */
    hotkeyNumber?: number;
    isActive: boolean;
    now: number;
    showLatestMessage: boolean;
    showSessionSummary: boolean;
    promptRows: number;
    responseRows: number;
    onselect: () => void;
    onclose: (event: MouseEvent) => void;
    /** Toggle pin for this session (SDK sessions only; button/menu hidden when absent). */
    ontogglepin?: () => void;
    oncontextmenu?: (event: MouseEvent) => void;
  }

  let {
    session,
    hotkeyNumber = undefined,
    isActive,
    now,
    showLatestMessage,
    showSessionSummary,
    promptRows,
    responseRows,
    onselect,
    onclose,
    ontogglepin = undefined,
    oncontextmenu = undefined,
  }: Props = $props();

  // Pinned agent account (configured accounts only; machine default shows nothing).
  const accountBadge = $derived(
    session.type === "sdk" && session.accountId && !isDefaultAccountId(session.accountId)
      ? accountById($settings.accounts, session.accountId)
      : undefined,
  );

  // Cap the length of the session summary/description so a runaway AI outcome
  // can't blow out the list item. Full text stays available via the title attr.
  const MAX_DESCRIPTION_CHARS = 200;
  function capText(text: string, max = MAX_DESCRIPTION_CHARS): string {
    if (text.length <= max) return text;
    return text.slice(0, max).trimEnd() + "…";
  }

  // Live countdown to an epoch-ms target. `refMs` must be in milliseconds — note
  // the `now` prop is in SECONDS (it drives getElapsedTime), so callers multiply.
  // Mirrors the formatting of `formatTimeRemaining` in rateLimits.ts.
  function formatMsRemaining(target: number | undefined | null, refMs: number): string {
    if (target == null) return "";
    const diff = target - refMs;
    if (diff <= 0) return "now";
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function getDisplayedDuration(): string | null {
    return getElapsedTime(
      session.accumulatedDurationMs,
      session.currentWorkStartedAt,
      session.isFinished,
      now,
    );
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

  // Compact validation-run status badge from the mirrored session summary.
  const validationBadge = $derived.by(() => {
    if (session.type !== "sdk" || !session.validation) return null;
    const v = session.validation;
    const map: Record<string, { cls: string; label: string }> = {
      running: { cls: "val-running", label: v.step ? `Validating · ${v.step}` : "Validating" },
      gate: { cls: "val-gate", label: v.findingCount > 0 ? `Gate · ${v.findingCount}` : "Gate" },
      passed: { cls: "val-passed", label: "Validated" },
      failed: { cls: "val-failed", label: "Failed" },
      cancelled: { cls: "val-cancelled", label: "Cancelled" },
    };
    return map[v.status] ?? null;
  });
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
  oncontextmenu={oncontextmenu}
>
  {#if hotkeyNumber != null && $ctrlHeld}
    <span class="hotkey-number-badge" aria-hidden="true">{hotkeyNumber}</span>
  {/if}
  <!-- Header row: type badge, status dot, interaction indicator, time, close button -->
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-2">
      {#if session.type === "sequence"}
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
      {#if accountBadge}
        <span
          class="w-2 h-2 rounded-full flex-shrink-0"
          style="background: {accountBadge.color};"
          title="Account: {accountBadge.label}"
        ></span>
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
      {#if ontogglepin}
        <button
          class="pin-button rounded p-0.5 transition-colors {session.pinned
            ? 'pinned text-accent hover:bg-accent/10'
            : 'text-text-muted hover:text-accent hover:bg-accent/10'}"
          onclick={(e) => {
            e.stopPropagation();
            ontogglepin();
          }}
          title={session.pinned ? "Unpin session" : "Pin session"}
        >
          <svg
            class="w-3.5 h-3.5"
            fill={session.pinned ? "currentColor" : "none"}
            stroke="currentColor"
            stroke-width="2"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"
            />
          </svg>
        </button>
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
        {capText(session.aiMetadata.outcome)}
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

  {#if session.githubIssue}
    <div class="notion-card-link" title="GitHub issue #{session.githubIssue.number}: {session.githubIssue.title}">
      <svg class="w-3 h-3 shrink-0" viewBox="0 0 16 16" fill="currentColor" opacity="0.7">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
      </svg>
      <span class="truncate">#{session.githubIssue.number} {session.githubIssue.title}</span>
    </div>
  {/if}

  {#if session.spareTokens}
    {@const spareTitle =
      SPARE_TOKENS_LIBRARY.find((p) => p.id === session.spareTokens?.promptId)?.title ??
      "Spare Tokens"}
    <div
      class="notion-card-link"
      title={`Spare Tokens: ${spareTitle}${session.spareTokens.auto ? " (auto)" : ""}`}
    >
      <svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.7">
        <rect x="2" y="7" width="18" height="10" rx="2" />
        <path stroke-linecap="round" d="M22 10v4" />
      </svg>
      <span class="truncate">{session.spareTokens.auto ? "Auto · " : ""}{spareTitle}</span>
    </div>
  {/if}

  <!-- Schedule / queue row (Smart Queue: parked until reset / scheduled window) -->
  {#if session.status === "queued"}
    {@const qi = session.queueInfo}
    {@const qWindow = qi?.window === "7d" ? "7d" : "5h"}
    {@const qCountdown = formatMsRemaining(qi?.targetStartAt, now * 1000)}
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
      {#if session.type === "sdk" && session.pr}
        {@const prState = session.pr.isDraft && session.pr.state === "open" ? "draft" : session.pr.state}
        <span
          class="pr-badge pr-{prState}"
          title="PR #{session.pr.number}: {session.pr.title} ({prState})"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
          </svg>
          #{session.pr.number}
        </span>
      {/if}
      {#if validationBadge}
        <span class="val-badge {validationBadge.cls}" title="Validation: {validationBadge.label}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          {validationBadge.label}
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

  /* Ctrl-held hint: the number to press (with Ctrl) to switch to this session */
  .hotkey-number-badge {
    position: absolute;
    top: 50%;
    right: 0.5rem;
    transform: translateY(-50%);
    width: 1.5rem;
    height: 1.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-accent);
    color: white;
    border-radius: 0.375rem;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 0.8rem;
    font-weight: 700;
    z-index: 5;
    pointer-events: none;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
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

  .pr-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.65rem;
    font-weight: 600;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    padding: 0.02rem 0.3rem;
    border-radius: 0.25rem;
    flex-shrink: 0;
  }

  .pr-badge svg {
    width: 0.65rem;
    height: 0.65rem;
  }

  .pr-badge.pr-open {
    color: rgb(74, 222, 128);
    background: rgba(74, 222, 128, 0.12);
  }

  .pr-badge.pr-draft {
    color: rgb(148, 163, 184);
    background: rgba(148, 163, 184, 0.12);
  }

  .pr-badge.pr-merged {
    color: rgb(192, 132, 252);
    background: rgba(192, 132, 252, 0.12);
  }

  .pr-badge.pr-closed {
    color: rgb(248, 113, 113);
    background: rgba(248, 113, 113, 0.12);
  }

  .val-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.65rem;
    font-weight: 600;
    padding: 0.02rem 0.3rem;
    border-radius: 0.25rem;
    flex-shrink: 0;
    max-width: 50%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .val-badge svg {
    width: 0.65rem;
    height: 0.65rem;
    flex-shrink: 0;
  }

  .val-badge.val-running {
    color: rgb(96, 165, 250);
    background: rgba(96, 165, 250, 0.12);
  }

  .val-badge.val-gate {
    color: rgb(251, 191, 36);
    background: rgba(251, 191, 36, 0.12);
  }

  .val-badge.val-passed {
    color: rgb(74, 222, 128);
    background: rgba(74, 222, 128, 0.12);
  }

  .val-badge.val-failed {
    color: rgb(248, 113, 113);
    background: rgba(248, 113, 113, 0.12);
  }

  .val-badge.val-cancelled {
    color: rgb(148, 163, 184);
    background: rgba(148, 163, 184, 0.12);
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
