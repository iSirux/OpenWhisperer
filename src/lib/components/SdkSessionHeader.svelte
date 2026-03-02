<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import RepoIcon from '$lib/components/RepoIcon.svelte';
  import { findRepoByPath } from '$lib/utils/repoIcons';
  import { repos, findRepoById } from '$lib/stores/repos';
  import { getShortModelName, getModelBadgeBgColor, getModelTextColor } from '$lib/utils/modelColors';
  import type { EffortLevel } from '$lib/stores/sdkSessions';

  interface Message {
    type: string;
    content?: string;
    tool?: string;
    input?: unknown;
    output?: string;
  }

  interface Props {
    createdAt?: number;
    messages?: Message[];
    isPending?: boolean;
    repoName?: string;
    repoId?: string;
    /** Working directory — may be a worktree path different from the repo path */
    repoPath?: string;
    model?: string | null;
    effortLevel?: EffortLevel;
    createdBranch?: string | null;
    currentBranch?: string | null;
    firstPrompt?: string | null;
    onClose: () => void;
    onCancel?: () => void;
  }

  let {
    createdAt,
    messages = [],
    isPending = false,
    repoName = '',
    repoId,
    repoPath = '',
    model = null,
    effortLevel = null,
    createdBranch = null,
    currentBranch = null,
    firstPrompt = null,
    onClose,
    onCancel,
  }: Props = $props();

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
    const labels: Record<string, string> = { low: 'Low', medium: 'Med', high: 'High', max: 'Max' };
    return effortLevel ? labels[effortLevel] ?? null : null;
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
</script>

<div class="session-header flex flex-col px-4 py-2 border-b border-border bg-surface-elevated gap-1">
  <div class="flex items-center justify-between">
    <div class="header-left">
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
</style>
