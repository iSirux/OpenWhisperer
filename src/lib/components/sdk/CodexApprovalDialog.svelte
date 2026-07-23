<script lang="ts">
  import type { CodexApprovalState } from "$lib/stores/sdkSessions";

  let {
    pending,
    onDecision,
  }: {
    pending: CodexApprovalState;
    /** decision: "accept" | "acceptForSession" | "decline" | "cancel" */
    onDecision: (decision: string) => void;
  } = $props();

  let isExec = $derived(pending.kind === "exec");

  function handleKeydown(event: KeyboardEvent) {
    // Ctrl+Enter approves; Ctrl+Shift+Enter approves for the rest of the session.
    if (event.key === "Enter" && event.ctrlKey && event.shiftKey) {
      event.preventDefault();
      onDecision("acceptForSession");
    } else if (event.key === "Enter" && event.ctrlKey) {
      event.preventDefault();
      onDecision("accept");
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="codex-approval">
  <div class="codex-approval-header">
    <svg class="header-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
    <h3>
      {isExec ? "Codex wants to run a command" : "Codex wants to change files"}
    </h3>
  </div>

  <div class="codex-approval-body">
    {#if isExec && pending.command}
      <pre class="codex-command">{pending.command}</pre>
    {:else if !isExec}
      <p class="codex-info">
        Codex is requesting approval to modify files outside the auto-approved
        workspace scope.
      </p>
    {/if}

    {#if pending.cwd}
      <div class="codex-meta"><span class="meta-label">cwd</span><span class="meta-value">{pending.cwd}</span></div>
    {/if}
    {#if pending.reason}
      <div class="codex-meta"><span class="meta-label">reason</span><span class="meta-value">{pending.reason}</span></div>
    {/if}
    {#if pending.grantRoot}
      <div class="codex-meta"><span class="meta-label">grant</span><span class="meta-value">{pending.grantRoot}</span></div>
    {/if}
  </div>

  <div class="codex-approval-footer">
    <div class="codex-actions">
      <button
        class="codex-btn btn-deny"
        onclick={() => onDecision("decline")}
        title="Deny this action; Codex continues the turn"
      >
        Deny
      </button>
      <button
        class="codex-btn btn-approve-session"
        onclick={() => onDecision("acceptForSession")}
        title="Approve and don't ask again this session for matching actions"
      >
        Approve for session
        <span class="kbd">Ctrl+Shift+Enter</span>
      </button>
      <button
        class="codex-btn btn-approve"
        onclick={() => onDecision("accept")}
        title="Approve this action"
      >
        Approve
        <span class="kbd">Ctrl+Enter</span>
      </button>
    </div>
  </div>
</div>

<style>
  .codex-approval {
    margin: 0.75rem;
    border-radius: 0.75rem;
    border: 1px solid var(--color-border);
    background: var(--color-surface-elevated);
  }
  .codex-approval-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--color-border);
  }
  .header-icon {
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    color: #f59e0b;
  }
  .codex-approval-header h3 {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-text-primary);
    margin: 0;
  }
  .codex-approval-body {
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .codex-command {
    margin: 0;
    padding: 0.5rem 0.75rem;
    background: var(--color-background);
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.75rem;
    color: var(--color-text-primary);
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 200px;
    overflow-y: auto;
  }
  .codex-info {
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    line-height: 1.5;
    margin: 0;
  }
  .codex-meta {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.75rem;
  }
  .meta-label {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.6875rem;
    padding: 0.125rem 0.375rem;
    background: var(--color-border);
    border-radius: 0.25rem;
    color: var(--color-text-muted);
    flex-shrink: 0;
  }
  .meta-value {
    color: var(--color-text-secondary);
    word-break: break-all;
  }
  .codex-approval-footer {
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--color-border);
  }
  .codex-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .codex-btn {
    padding: 0.375rem 0.75rem;
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    border: 1px solid transparent;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
  }
  .btn-deny {
    background: transparent;
    border-color: rgba(239, 68, 68, 0.3);
    color: #ef4444;
  }
  .btn-deny:hover {
    background: rgba(239, 68, 68, 0.1);
    border-color: rgba(239, 68, 68, 0.5);
  }
  .btn-approve-session {
    background: transparent;
    border-color: var(--color-border);
    color: var(--color-text-secondary);
  }
  .btn-approve-session:hover {
    background: var(--color-background);
    border-color: var(--color-text-muted);
  }
  .btn-approve {
    background: rgba(16, 185, 129, 0.2);
    border-color: transparent;
    color: #10b981;
  }
  .btn-approve:hover {
    background: rgba(16, 185, 129, 0.3);
  }
  .kbd {
    font-size: 0.625rem;
    padding: 0.0625rem 0.25rem;
    background: rgba(255, 255, 255, 0.08);
    border-radius: 0.1875rem;
    margin-left: 0.375rem;
    color: var(--color-text-muted);
  }
</style>
