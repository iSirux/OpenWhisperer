<script lang="ts">
  import type { PlanApprovalState } from '$lib/stores/sdkSessions';

  let {
    pendingPlanApproval,
    onApprove,
    onApproveNewSession,
    onDeny,
  }: {
    pendingPlanApproval: PlanApprovalState;
    onApprove: () => void;
    onApproveNewSession: () => void;
    onDeny: (feedback: string) => void;
  } = $props();

  let feedbackText = $state('');
  let showAllowedPrompts = $state(false);

  let hasAllowedPrompts = $derived(
    pendingPlanApproval.allowedPrompts && pendingPlanApproval.allowedPrompts.length > 0
  );

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && event.ctrlKey && event.shiftKey) {
      event.preventDefault();
      onApproveNewSession();
    } else if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault();
      onApprove();
    }
  }

  function handleDeny() {
    if (feedbackText.trim()) {
      onDeny(feedbackText.trim());
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="plan-approval">
  <!-- Header -->
  <div class="plan-approval-header">
    <svg class="header-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
    <h3>Plan Ready for Review</h3>
  </div>

  <!-- Body -->
  <div class="plan-approval-body">
    <p class="plan-info">
      Claude has finished planning. Review the plan in the messages above, then choose how to proceed.
    </p>

    <!-- Allowed prompts (collapsible) -->
    {#if hasAllowedPrompts}
      <button
        class="allowed-prompts-toggle"
        onclick={() => { showAllowedPrompts = !showAllowedPrompts; }}
      >
        {showAllowedPrompts ? 'Hide' : 'Show'} allowed tool prompts ({pendingPlanApproval.allowedPrompts.length})
      </button>

      {#if showAllowedPrompts}
        <div class="allowed-prompts-list">
          {#each pendingPlanApproval.allowedPrompts as ap}
            <div class="allowed-prompt-item">
              <span class="allowed-prompt-tool">{ap.tool}</span>
              <span>{ap.prompt}</span>
            </div>
          {/each}
        </div>
      {/if}
    {/if}

    <!-- Feedback textarea -->
    <textarea
      class="feedback-textarea"
      placeholder="Describe what changes you'd like to the plan..."
      bind:value={feedbackText}
    ></textarea>

    <!-- Action buttons -->
    <div class="plan-actions">
      <button
        class="plan-btn btn-deny"
        disabled={!feedbackText.trim()}
        onclick={handleDeny}
        title="Send feedback to revise the plan"
      >
        Request Changes
      </button>
      <button
        class="plan-btn btn-approve"
        onclick={onApprove}
        title="Continue implementing in this session"
      >
        Approve & Implement
        <span class="kbd">Ctrl+Enter</span>
      </button>
      <button
        class="plan-btn btn-new-session"
        onclick={onApproveNewSession}
        title="Start a fresh session to implement the plan"
      >
        Approve in New Session
        <span class="kbd">Ctrl+Shift+Enter</span>
      </button>
    </div>
  </div>
</div>

<style>
  .plan-approval {
    margin: 0.75rem;
    border-radius: 0.75rem;
    border: 1px solid var(--color-border);
    background: var(--color-surface-elevated);
    overflow: hidden;
  }
  .plan-approval-header {
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
    color: #10b981;
  }
  .plan-approval-header h3 {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-text-primary);
    margin: 0;
  }
  .plan-approval-body {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .plan-info {
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    line-height: 1.5;
    margin: 0;
  }
  .allowed-prompts-toggle {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    cursor: pointer;
    background: none;
    border: none;
    padding: 0;
    text-decoration: underline;
    text-align: left;
  }
  .allowed-prompts-toggle:hover {
    color: var(--color-text-secondary);
  }
  .allowed-prompts-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.5rem;
    background: var(--color-background);
    border-radius: 0.5rem;
    font-size: 0.75rem;
    color: var(--color-text-secondary);
  }
  .allowed-prompt-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .allowed-prompt-tool {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.6875rem;
    padding: 0.125rem 0.375rem;
    background: var(--color-border);
    border-radius: 0.25rem;
    color: var(--color-text-muted);
    flex-shrink: 0;
  }
  .feedback-textarea {
    width: 100%;
    min-height: 3rem;
    max-height: 8rem;
    padding: 0.5rem 0.75rem;
    background: var(--color-background);
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    color: var(--color-text-primary);
    font-size: 0.8125rem;
    font-family: inherit;
    resize: vertical;
    outline: none;
    transition: border-color 0.15s;
    box-sizing: border-box;
  }
  .feedback-textarea:focus {
    border-color: var(--color-accent);
  }
  .feedback-textarea::placeholder {
    color: var(--color-text-muted);
  }
  .plan-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .plan-btn {
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
  .plan-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn-deny {
    background: transparent;
    border-color: rgba(239, 68, 68, 0.3);
    color: #ef4444;
  }
  .btn-deny:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.1);
    border-color: rgba(239, 68, 68, 0.5);
  }
  .btn-approve {
    background: rgba(16, 185, 129, 0.2);
    border-color: transparent;
    color: #10b981;
  }
  .btn-approve:hover {
    background: rgba(16, 185, 129, 0.3);
  }
  .btn-new-session {
    background: rgba(6, 182, 212, 0.2);
    border-color: transparent;
    color: #06b6d4;
  }
  .btn-new-session:hover {
    background: rgba(6, 182, 212, 0.3);
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
