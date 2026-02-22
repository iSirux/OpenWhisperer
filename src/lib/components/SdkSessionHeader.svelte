<script lang="ts">
  import RepoIcon from '$lib/components/RepoIcon.svelte';
  import { findRepoByPath } from '$lib/utils/repoIcons';
  import { settings } from '$lib/stores/settings';

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
    repoPath?: string;
    branch?: string | null;
    firstPrompt?: string | null;
    onClose: () => void;
    onCancel?: () => void;
  }

  let {
    createdAt,
    messages = [],
    isPending = false,
    repoName = '',
    repoPath = '',
    branch = null,
    firstPrompt = null,
    onClose,
    onCancel,
  }: Props = $props();

  const repoConfig = $derived(findRepoByPath($settings.repos, repoPath));

  let isChatCopied = $state(false);

  const sessionTime = $derived(
    createdAt ? new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  );

  async function copyChat() {
    const text = messages
      .filter(msg => msg.type !== 'done')
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
</script>

<div class="session-header flex items-center justify-between px-4 py-2 border-b border-border bg-surface-elevated">
  <div class="header-left">
    {#if sessionTime}
      <span class="session-time">{sessionTime}</span>
    {/if}
    {#if repoName}
      {#if sessionTime}<span class="separator">·</span>{/if}
      <RepoIcon repo={repoConfig} size="xs" />
      <span class="repo-name">{repoName}</span>
      {#if branch}
        <span class="separator">·</span>
        <svg class="branch-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <span class="branch-name">{branch}</span>
      {/if}
    {/if}
    {#if firstPrompt}
      {#if sessionTime || repoName}<span class="separator">·</span>{/if}
      <span class="prompt-preview">{firstPrompt}</span>
    {/if}
  </div>
  <div class="flex items-center gap-2">
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

  .branch-icon {
    width: 0.75rem;
    height: 0.75rem;
    color: rgb(96, 165, 250);
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
    flex: 1;
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
