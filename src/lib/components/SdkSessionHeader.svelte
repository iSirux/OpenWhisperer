<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import RepoIcon from '$lib/components/RepoIcon.svelte';
  import { findRepoByPath } from '$lib/utils/repoIcons';
  import { repos, findRepoById } from '$lib/stores/repos';
  import { getShortModelName, getModelBadgeBgColor, getModelTextColor } from '$lib/utils/modelColors';
  import { sdkSessions, type EffortLevel } from '$lib/stores/sdkSessions';
  import type { SdkProvider } from '$lib/utils/models';
  import { panes, paneLayout, MAX_PANES } from '$lib/stores/panes';
  import { get } from 'svelte/store';
  import { nmRuns, noMistakes } from '$lib/stores/noMistakes';
  import { buildIntent } from '$lib/utils/noMistakesIntent';
  import { validationRuns } from '$lib/stores/validation';
  import ValidationStartPopover from '$lib/components/sdk/ValidationStartPopover.svelte';
  import { sessionPrs } from '$lib/stores/sessionPrs';
  import type { SessionPrSummary } from '$lib/stores/sdkSessions';
  import { settings } from '$lib/stores/settings';
  import { accountById, isDefaultAccountId } from '$lib/utils/accounts';
  import { ctrlHeld } from '$lib/stores/ctrlHint';
  import { createSessionInSameRepo } from '$lib/utils/sessionCreation';
  import { formatHotkeyForDisplay, getHotkeyKeyLabel } from '$lib/utils/hotkeys';

  interface Message {
    type: string;
    content?: string;
    tool?: string;
    input?: unknown;
    output?: string;
  }

  interface Props {
    /** Session ID — required to wire SDK-only actions like /compact */
    sessionId?: string;
    /** SDK session ID — gates SDK-only actions until the session has been initialized */
    sdkSessionId?: string;
    /** True while a query is in flight; disables /compact to avoid overlapping sends */
    isQuerying?: boolean;
    createdAt?: number;
    messages?: Message[];
    isPending?: boolean;
    repoName?: string;
    repoId?: string;
    /** Working directory — may be a worktree path different from the repo path */
    repoPath?: string;
    model?: string | null;
    effortLevel?: EffortLevel;
    provider?: SdkProvider;
    /** Agent account this session is pinned to (undefined = machine default). */
    accountId?: string;
    createdBranch?: string | null;
    currentBranch?: string | null;
    /** Number of files changed in this session's cwd. Badge hidden when 0/undefined. */
    changedFileCount?: number;
    /** PR detected for this session's branch; badge opens the PR panel. */
    pr?: SessionPrSummary | null;
    firstPrompt?: string | null;
    /** Short speakable voice callsign for this session (e.g. "Falcon") */
    nickname?: string | null;
    onClose: () => void;
    onCancel?: () => void;
  }

  let {
    sessionId,
    sdkSessionId,
    isQuerying = false,
    createdAt,
    messages = [],
    isPending = false,
    repoName = '',
    repoId,
    repoPath = '',
    model = null,
    effortLevel = null,
    provider = 'claude',
    accountId = undefined,
    createdBranch = null,
    currentBranch = null,
    changedFileCount = undefined,
    pr = null,
    firstPrompt = null,
    nickname = null,
    onClose,
    onCancel,
  }: Props = $props();

  let isCompacting = $state(false);
  const canCompact = $derived(!!sessionId && !!sdkSessionId && !isPending && !isQuerying);

  async function compactConversation() {
    if (!sessionId || isCompacting || !canCompact) return;
    isCompacting = true;
    try {
      await sdkSessions.sendPrompt(sessionId, '/compact');
    } catch (err) {
      console.error('[SdkSessionHeader] /compact failed:', err);
    } finally {
      isCompacting = false;
    }
  }

  // Resolve repo config: prefer stable repoId, fall back to path match
  const repoConfig = $derived(
    repoId ? findRepoById($repos.list, repoId) : findRepoByPath($repos.list, repoPath)
  );

  /** True when the cwd is a worktree (different from the canonical repo path) */
  const isWorktree = $derived(
    !!repoConfig && !!repoPath && repoPath !== '.' && repoConfig.path !== repoPath
  );

  /** Short worktree folder name for display (last path segment) */
  const worktreeName = $derived(
    isWorktree ? repoPath.split(/[/\\]/).pop() || repoPath : null
  );

  const effortLabel = $derived.by(() => {
    const labels: Record<string, string> = { low: 'Low', medium: 'Med', high: 'High', xhigh: 'XHigh', max: 'Max' };
    return effortLevel ? labels[effortLevel] ?? null : null;
  });

  // Resolve the pinned agent account. Only configured accounts get a pill;
  // the machine-default (virtual) account renders nothing.
  const accountBadge = $derived(
    accountId && !isDefaultAccountId(accountId)
      ? accountById($settings.accounts, accountId)
      : undefined
  );

  // --- No mistakes (validation pipeline) ---
  const nmHasCwd = $derived(!!repoPath && repoPath !== '.');
  const nmRun = $derived(
    sessionId ? [...$nmRuns.values()].find((r) => r.sessionId === sessionId) : undefined,
  );
  const nmActive = $derived(
    !!nmRun &&
      (nmRun.status === 'starting' || nmRun.status === 'running' || nmRun.status === 'gate'),
  );
  // Enabled only with a real cwd, not pending, not querying, and no active run.
  const nmCanStart = $derived(nmHasCwd && !isPending && !isQuerying && !nmActive);
  const showNoMistakes = $derived(!isPending && !!sessionId && $settings.system.dev_mode);

  function startNoMistakes() {
    if (!sessionId || !nmCanStart) return;
    const session = get(sdkSessions).find((s) => s.id === sessionId);
    if (!session) return;
    noMistakes.startRun(sessionId, repoPath, buildIntent(session)).catch((err) => {
      console.error('[SdkSessionHeader] no-mistakes start failed:', err);
    });
  }

  // --- Validation pipeline (native; NOT dev-mode gated) ---
  const validationSession = $derived(
    sessionId ? $sdkSessions.find((s) => s.id === sessionId) : undefined,
  );
  const validationRun = $derived(
    sessionId ? [...$validationRuns.values()].find((r) => r.sessionId === sessionId) : undefined,
  );
  const validationActive = $derived(
    !!validationRun && (validationRun.status === 'running' || validationRun.status === 'gate'),
  );
  // Enabled with a real cwd, not pending, not querying, and no active run.
  const validationCanStart = $derived(
    nmHasCwd && !isPending && !isQuerying && !validationActive && !!validationSession,
  );
  const showValidate = $derived(!isPending && !!sessionId);
  let showValidatePopover = $state(false);
  $effect(() => {
    // Close the popover if the session can no longer start a run.
    if (showValidatePopover && !validationCanStart) showValidatePopover = false;
  });


  let isChatCopied = $state(false);

  const sessionTime = $derived(
    createdAt ? new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  );

  const normalizedCreatedBranch = $derived(
    createdBranch?.trim() ? createdBranch.trim() : null
  );

  const normalizedCurrentBranch = $derived(
    currentBranch?.trim() ? currentBranch.trim() : null
  );

  const showSplitBranchLabels = $derived(
    !!normalizedCreatedBranch &&
    !!normalizedCurrentBranch &&
    normalizedCreatedBranch !== normalizedCurrentBranch
  );

  const singleBranchDisplay = $derived(
    showSplitBranchLabels
      ? null
      : normalizedCurrentBranch || normalizedCreatedBranch
  );

  /** True when the worktree folder name matches the displayed branch — no need to show both */
  const worktreeMatchesBranch = $derived(
    isWorktree && !!worktreeName && !!singleBranchDisplay && worktreeName === singleBranchDisplay
  );

  async function copyChat() {
    const text = messages
      .filter(msg => msg.type !== 'done' && msg.type !== 'stopped')
      .map(msg => {
        const prefix = msg.type === 'user' ? 'User: ' : msg.type === 'text' ? 'Claude: ' : '';
        if (msg.type === 'user') return prefix + (msg.content ?? '');
        if (msg.type === 'text') return prefix + (msg.content ?? '');
        if (msg.type === 'error') return `Error: ${msg.content ?? ''}`;
        if (msg.type === 'tool_start') return `[Tool: ${msg.tool}]\nInput: ${JSON.stringify(msg.input, null, 2)}`;
        if (msg.type === 'tool_result') return `[Tool: ${msg.tool} completed]\nOutput: ${msg.output ?? ''}`;
        return '';
      })
      .join('\n\n');

    await navigator.clipboard.writeText(text);
    isChatCopied = true;
    setTimeout(() => {
      isChatCopied = false;
    }, 2000);
  }

  async function openInVSCode() {
    if (repoPath) {
      try {
        await invoke('open_in_vscode', { path: repoPath });
      } catch (e) {
        console.error('Failed to open VS Code:', e);
      }
    }
  }

  async function openInTerminal() {
    if (repoPath) {
      try {
        await invoke('open_in_terminal', { path: repoPath });
      } catch (e) {
        console.error('Failed to open terminal:', e);
      }
    }
  }

  async function openInExplorer() {
    if (repoPath) {
      try {
        await invoke('open_in_explorer', { path: repoPath });
      } catch (e) {
        console.error('Failed to open explorer:', e);
      }
    }
  }
</script>

<div class="session-header flex flex-col px-4 py-2 border-b border-border bg-surface-elevated gap-1">
  <div class="flex items-center justify-between">
    <div class="header-left">
      {#if nickname}
        <span
          class="px-1 py-0.5 text-[9px] font-mono uppercase tracking-wide text-text-muted bg-border/60 rounded flex-shrink-0"
          title="Voice callsign">{nickname}</span
        >
      {/if}
      {#if sessionTime}
        <span class="session-time">{sessionTime}</span>
      {/if}
      {#if repoName}
        {#if sessionTime}<span class="separator">·</span>{/if}
        <RepoIcon repo={repoConfig} size="xs" />
        <span class="repo-name">{repoName}</span>
        {#if worktreeMatchesBranch}
          <span class="separator">·</span>
          <span class="branch-name" title="Worktree & branch: {repoPath}">{worktreeName}</span>
        {:else}
          {#if isWorktree && worktreeName}
            <span class="separator">·</span>
            <span class="worktree-name" title="Worktree: {repoPath}">{worktreeName}</span>
          {/if}
          {#if showSplitBranchLabels}
            <span class="separator">·</span>
            <span class="branch-name" title="Branch when session was created">created:{normalizedCreatedBranch}</span>
            <span class="separator">·</span>
            <span class="branch-name" title="Current branch">current:{normalizedCurrentBranch}</span>
          {:else if singleBranchDisplay}
            <span class="separator">·</span>
            <span class="branch-name">{singleBranchDisplay}</span>
          {/if}
        {/if}
        {#if changedFileCount && changedFileCount > 0}
          <span class="separator">·</span>
          <span
            class="changed-count"
            title="{changedFileCount} file{changedFileCount === 1 ? '' : 's'} changed"
          >
            {changedFileCount} changed
          </span>
        {/if}
        {#if pr && sessionId}
          <span class="separator">·</span>
          <button
            class="pr-badge pr-{pr.isDraft && pr.state === 'open' ? 'draft' : pr.state}"
            onclick={() => sessionPrs.togglePanel(sessionId)}
            title="PR #{pr.number}: {pr.title} ({pr.isDraft && pr.state === 'open' ? 'draft' : pr.state}) — click for status & merge"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
            </svg>
            #{pr.number}
          </button>
        {/if}
      {/if}
      {#if model}
        {#if sessionTime || repoName}<span class="separator">·</span>{/if}
        <span class="px-1.5 py-0.5 text-[10px] font-medium {getModelBadgeBgColor(model)} {getModelTextColor(model)} rounded flex-shrink-0">
          {getShortModelName(model)}
        </span>
      {/if}
      {#if effortLabel}
        <span class="px-1.5 py-0.5 text-[10px] font-medium bg-cyan-600/20 text-cyan-400 rounded flex-shrink-0">
          {effortLabel}
        </span>
      {/if}
      {#if accountBadge}
        <span
          class="px-1.5 py-0.5 text-[10px] font-medium rounded flex items-center gap-1 flex-shrink-0"
          style="background: color-mix(in srgb, {accountBadge.color} 18%, transparent); color: {accountBadge.color};"
          title="Account: {accountBadge.label}"
        >
          <span class="w-1.5 h-1.5 rounded-full flex-shrink-0" style="background: {accountBadge.color};"></span>
          {accountBadge.label}
        </span>
      {/if}
    </div>
    <div class="flex items-center gap-2">
      {#if repoPath}
        <button
          class="action-icon-btn p-1 rounded transition-colors text-text-muted hover:text-text-primary hover:bg-border"
          onclick={openInVSCode}
          title="Open in VS Code"
        >
          <svg class="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
        </button>
        <button
          class="action-icon-btn p-1 rounded transition-colors text-text-muted hover:text-text-primary hover:bg-border"
          onclick={openInTerminal}
          title="Open in Terminal"
        >
          <svg class="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </button>
        <button
          class="action-icon-btn p-1 rounded transition-colors text-text-muted hover:text-text-primary hover:bg-border"
          onclick={openInExplorer}
          title="Open in Explorer"
        >
          <svg class="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      {/if}
      {#if !isPending && sessionId && repoPath && repoPath !== '.'}
        <button
          class="action-icon-btn same-repo-btn p-1 rounded transition-colors text-text-muted hover:text-text-primary hover:bg-border"
          onclick={() => createSessionInSameRepo(sessionId)}
          title="New session in same repo/worktree ({formatHotkeyForDisplay($settings.hotkeys.new_session_same_repo)})"
          aria-label="New session in same repo/worktree"
        >
          <svg class="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            <line x1="12" y1="11" x2="12" y2="17" />
            <line x1="9" y1="14" x2="15" y2="14" />
          </svg>
          {#if $ctrlHeld && $settings.hotkeys_enabled.new_session_same_repo}
            <span class="ctrl-hint-badge" aria-hidden="true">{getHotkeyKeyLabel($settings.hotkeys.new_session_same_repo)}</span>
          {/if}
        </button>
      {/if}
      {#if !isPending && $paneLayout.panes.length < MAX_PANES}
        <button
          class="action-icon-btn p-1 rounded transition-colors text-text-muted hover:text-text-primary hover:bg-border"
          onclick={() => panes.splitPane()}
          title="Split view"
          aria-label="Split view"
        >
          <svg class="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="12" y1="4" x2="12" y2="20" />
          </svg>
        </button>
      {/if}
      {#if !isPending && sessionId && sdkSessionId}
        <button
          class="action-icon-btn p-1 rounded transition-colors text-text-muted hover:text-text-primary hover:bg-border"
          onclick={compactConversation}
          disabled={!canCompact || isCompacting}
          title="Compact conversation history"
          aria-label="Compact conversation history"
        >
          <svg class="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <!-- Two arrows pointing inward: signals "compact" -->
            <polyline points="4 14 10 14 10 20" />
            <polyline points="20 10 14 10 14 4" />
            <line x1="14" y1="10" x2="21" y2="3" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
      {/if}
      {#if showValidate}
        <div class="validate-wrap">
          <button
            class="validate-btn px-2 py-1 text-xs bg-surface hover:bg-border rounded transition-colors flex items-center gap-1"
            class:active={validationActive}
            onclick={() => (showValidatePopover = !showValidatePopover)}
            disabled={!validationCanStart}
            title="Run the validation pipeline (review, test, docs, lint, ship, CI) on this session's branch."
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
            Validate
          </button>
          {#if showValidatePopover && validationSession}
            <button
              class="validate-backdrop"
              onclick={() => (showValidatePopover = false)}
              aria-label="Close validation options"
            ></button>
            <div class="validate-popover">
              <ValidationStartPopover
                session={validationSession}
                cwd={repoPath}
                repoId={repoId}
                repoSteps={repoConfig?.validation_steps}
                onClose={() => (showValidatePopover = false)}
              />
            </div>
          {/if}
        </div>
      {/if}
      {#if showNoMistakes}
        <button
          class="no-mistakes-btn px-2 py-1 text-xs bg-surface hover:bg-border rounded transition-colors flex items-center gap-1"
          class:active={!!nmRun}
          onclick={startNoMistakes}
          disabled={!nmCanStart}
          title="Run the no-mistakes validation pipeline (review, test, docs, lint) on this session's branch — only pushes and opens a PR when everything is green."
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
          No mistakes
        </button>
      {/if}
      {#if !isPending}
        <button
          class="copy-all-btn px-2 py-1 text-xs bg-surface hover:bg-border rounded transition-colors flex items-center gap-1"
          class:copied={isChatCopied}
          onclick={copyChat}
          title="Copy entire chat"
          disabled={messages.length === 0}
        >
          {#if isChatCopied}
            <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
            </svg>
            Copied!
          {:else}
            <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M8 2a1 1 0 000 2h2a1 1 0 100-2H8z" />
              <path d="M3 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v6h-4.586l1.293-1.293a1 1 0 00-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L10.414 13H15v3a2 2 0 01-2 2H5a2 2 0 01-2-2V5zM15 11h2a1 1 0 110 2h-2v-2z" />
            </svg>
            Copy
          {/if}
        </button>
      {/if}
      <button
        class="p-1 hover:bg-border rounded transition-colors text-text-muted hover:text-error"
        onclick={isPending && onCancel ? onCancel : onClose}
        title={isPending ? "Cancel session" : "Close session"}
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  </div>
  {#if firstPrompt}
    <div class="prompt-preview">{firstPrompt}</div>
  {/if}
</div>

<style>
  .header-left {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }

  .session-time {
    font-size: 0.8rem;
    color: var(--color-text-muted);
    flex-shrink: 0;
  }

  .separator {
    color: var(--color-text-muted);
    font-size: 0.8rem;
    flex-shrink: 0;
  }

  .repo-icon {
    width: 0.875rem;
    height: 0.875rem;
    color: var(--color-text-muted);
    flex-shrink: 0;
  }

  .repo-name {
    font-size: 0.8rem;
    color: var(--color-text-secondary);
    font-weight: 500;
    flex-shrink: 0;
  }

  .worktree-name {
    font-size: 0.75rem;
    color: rgb(168, 162, 158);
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    flex-shrink: 0;
  }

  .branch-name {
    font-size: 0.8rem;
    color: rgb(96, 165, 250);
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    flex-shrink: 0;
  }

  .changed-count {
    font-size: 0.7rem;
    font-weight: 600;
    color: rgb(251, 191, 36);
    background: rgba(251, 191, 36, 0.12);
    padding: 0.05rem 0.35rem;
    border-radius: 0.25rem;
    flex-shrink: 0;
  }

  .pr-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.7rem;
    font-weight: 600;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    padding: 0.05rem 0.35rem;
    border-radius: 0.25rem;
    flex-shrink: 0;
    cursor: pointer;
    transition: filter 0.15s ease;
  }

  .pr-badge:hover {
    filter: brightness(1.25);
  }

  .pr-badge svg {
    width: 0.75rem;
    height: 0.75rem;
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

  .prompt-preview {
    font-size: 0.8rem;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .copy-all-btn {
    color: var(--color-text-muted);
  }

  .copy-all-btn:hover {
    color: var(--color-text-primary);
  }

  .copy-all-btn.copied {
    background: color-mix(in srgb, var(--color-success) 20%, transparent);
    color: var(--color-success);
  }

  .validate-wrap {
    position: relative;
    display: inline-flex;
  }

  .validate-btn {
    color: var(--color-text-muted);
  }

  .validate-btn:hover:not(:disabled) {
    color: var(--color-text-primary);
  }

  .validate-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .validate-btn.active {
    background: color-mix(in srgb, var(--color-accent) 18%, transparent);
    color: var(--color-accent);
  }

  .validate-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: transparent;
    cursor: default;
  }

  .validate-popover {
    position: absolute;
    top: calc(100% + 0.4rem);
    right: 0;
    z-index: 50;
  }

  .no-mistakes-btn {
    color: var(--color-text-muted);
  }

  .no-mistakes-btn:hover:not(:disabled) {
    color: var(--color-text-primary);
  }

  .no-mistakes-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .no-mistakes-btn.active {
    background: color-mix(in srgb, var(--color-accent) 18%, transparent);
    color: var(--color-accent);
  }

  .same-repo-btn {
    position: relative;
  }

  /* Ctrl-held hint: the key to press (with Ctrl) to trigger this button */
  .ctrl-hint-badge {
    position: absolute;
    top: -0.45rem;
    right: -0.45rem;
    min-width: 1rem;
    height: 1rem;
    padding: 0 0.15rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-accent);
    color: white;
    border-radius: 0.25rem;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 0.65rem;
    font-weight: 700;
    z-index: 5;
    pointer-events: none;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  }
</style>
