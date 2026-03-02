<script lang="ts">
  import type { PlanApprovalState } from "$lib/stores/sdkSessions";
  import { isPlanNewSessionAvailable } from "$lib/stores/settings";
  import { renderMarkdown } from "$lib/utils/markdown";

  let {
    pendingPlanApproval,
    onApprove,
    onApproveNewSession,
    onDeny,
  }: {
    pendingPlanApproval: PlanApprovalState;
    onApprove: (feedback?: string) => void;
    onApproveNewSession: () => void;
    onDeny: (feedback: string) => void;
  } = $props();

  let feedbackText = $state("");
  let showAllowedPrompts = $state(false);
  let textareaEl: HTMLTextAreaElement | undefined = $state();

  let hasAllowedPrompts = $derived(
    pendingPlanApproval.allowedPrompts &&
      pendingPlanApproval.allowedPrompts.length > 0,
  );

  let hasPlan = $derived(
    !!pendingPlanApproval.plan && pendingPlanApproval.plan.trim().length > 0,
  );

  function autoResize() {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    textareaEl.style.height = textareaEl.scrollHeight + "px";
  }

  function handleKeydown(event: KeyboardEvent) {
    if (
      event.key === "Enter" &&
      event.ctrlKey &&
      event.shiftKey &&
      isPlanNewSessionAvailable()
    ) {
      event.preventDefault();
      onApproveNewSession();
    } else if (event.key === "Enter" && event.ctrlKey) {
      event.preventDefault();
      onApprove(feedbackText.trim() || undefined);
    }
  }

  function handleApprove() {
    onApprove(feedbackText.trim() || undefined);
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
    <svg
      class="header-icon"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
    <h3>Plan Ready for Review</h3>
  </div>

  <!-- Plan content -->
  {#if hasPlan}
    <div class="plan-content-body markdown-body">
      {@html renderMarkdown(pendingPlanApproval.plan!)}
    </div>
  {:else}
    <div class="plan-approval-body">
      <p class="plan-info">
        Claude has finished planning. Review the plan in the messages above,
        then choose how to proceed.
      </p>
    </div>
  {/if}

  <!-- Footer -->
  <div class="plan-approval-footer">
    <!-- Allowed prompts (collapsible) -->
    {#if hasAllowedPrompts}
      <button
        class="allowed-prompts-toggle"
        onclick={() => {
          showAllowedPrompts = !showAllowedPrompts;
        }}
      >
        {showAllowedPrompts ? "Hide" : "Show"} allowed tool prompts ({pendingPlanApproval
          .allowedPrompts.length})
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
      placeholder="Optional: add notes for Claude before it starts implementing..."
      rows="1"
      bind:this={textareaEl}
      bind:value={feedbackText}
      oninput={autoResize}
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
        onclick={handleApprove}
        title="Continue implementing in this session"
      >
        Approve & Implement
        <span class="kbd">Ctrl+Enter</span>
      </button>
      {#if isPlanNewSessionAvailable()}
        <button
          class="plan-btn btn-new-session"
          onclick={onApproveNewSession}
          title="Start a fresh session to implement the plan"
        >
          Approve in New Session
          <span class="kbd">Ctrl+Shift+Enter</span>
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .plan-approval {
    margin: 0.75rem;
    border-radius: 0.75rem;
    border: 1px solid var(--color-border);
    background: var(--color-surface-elevated);
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

  /* Plan content (markdown rendered) */
  .plan-content-body {
    padding: 1rem;
    max-height: 400px;
    overflow-y: auto;
    font-size: 0.8125rem;
    line-height: 1.6;
    border-bottom: 1px solid var(--color-border);
  }

  /* Fallback when no plan content */
  .plan-approval-body {
    padding: 1rem;
  }
  .plan-info {
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    line-height: 1.5;
    margin: 0;
  }

  /* Footer with controls */
  .plan-approval-footer {
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
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
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
      monospace;
    font-size: 0.6875rem;
    padding: 0.125rem 0.375rem;
    background: var(--color-border);
    border-radius: 0.25rem;
    color: var(--color-text-muted);
    flex-shrink: 0;
  }
  .feedback-textarea {
    width: 100%;
    padding: 0.375rem 0.75rem;
    background: var(--color-background);
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    color: var(--color-text-primary);
    font-size: 0.8125rem;
    font-family: inherit;
    resize: none;
    overflow: hidden;
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

  /* Markdown styles for plan content */
  .markdown-body {
    color: var(--color-text-primary);
  }
  .markdown-body :global(h1),
  .markdown-body :global(h2),
  .markdown-body :global(h3),
  .markdown-body :global(h4),
  .markdown-body :global(h5),
  .markdown-body :global(h6) {
    margin-top: 1.25em;
    margin-bottom: 0.5em;
    font-weight: 600;
    line-height: 1.25;
    color: var(--color-text-primary);
  }
  .markdown-body :global(h1:first-child),
  .markdown-body :global(h2:first-child),
  .markdown-body :global(h3:first-child),
  .markdown-body :global(h4:first-child),
  .markdown-body :global(h5:first-child),
  .markdown-body :global(h6:first-child) {
    margin-top: 0;
  }
  .markdown-body :global(h1) {
    font-size: 1.5em;
    border-bottom: 1px solid var(--color-border);
    padding-bottom: 0.3em;
  }
  .markdown-body :global(h2) {
    font-size: 1.3em;
    border-bottom: 1px solid var(--color-border);
    padding-bottom: 0.3em;
  }
  .markdown-body :global(h3) {
    font-size: 1.15em;
  }
  .markdown-body :global(h4) {
    font-size: 1em;
  }
  .markdown-body :global(h5) {
    font-size: 0.9em;
  }
  .markdown-body :global(h6) {
    font-size: 0.85em;
    color: var(--color-text-muted);
  }
  .markdown-body :global(p) {
    margin-top: 0;
    margin-bottom: 0.75em;
  }
  .markdown-body :global(p:last-child) {
    margin-bottom: 0;
  }
  .markdown-body :global(*:last-child) {
    margin-bottom: 0;
  }
  .markdown-body :global(a) {
    color: var(--color-accent);
    text-decoration: none;
  }
  .markdown-body :global(a:hover) {
    text-decoration: underline;
  }
  .markdown-body :global(strong) {
    font-weight: 600;
    color: var(--color-text-primary);
  }
  .markdown-body :global(em) {
    font-style: italic;
  }
  .markdown-body :global(code) {
    background: var(--color-surface);
    padding: 0.2em 0.4em;
    border-radius: 4px;
    font-size: 0.9em;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
      monospace;
  }
  .markdown-body :global(pre) {
    background: var(--color-surface);
    padding: 1em;
    border-radius: 6px;
    overflow-x: auto;
    margin: 0.75em 0;
  }
  .markdown-body :global(pre code) {
    background: transparent;
    padding: 0;
    border-radius: 0;
    font-size: 0.85em;
    line-height: 1.5;
  }
  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    margin-top: 0;
    margin-bottom: 0.75em;
    padding-left: 1.5em;
    list-style-position: outside;
  }
  .markdown-body :global(ul) {
    list-style-type: disc;
  }
  .markdown-body :global(ol) {
    list-style-type: decimal;
  }
  .markdown-body :global(li) {
    margin-bottom: 0.25em;
  }
  .markdown-body :global(li > ul),
  .markdown-body :global(li > ol) {
    margin-bottom: 0;
  }
  .markdown-body :global(blockquote) {
    margin: 0.75em 0;
    padding: 0.5em 1em;
    border-left: 4px solid var(--color-accent);
    background: var(--color-surface);
    color: var(--color-text-secondary);
  }
  .markdown-body :global(blockquote p) {
    margin-bottom: 0;
  }
  .markdown-body :global(hr) {
    border: none;
    border-top: 1px solid var(--color-border);
    margin: 1em 0;
  }
  .markdown-body :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 0.75em 0;
  }
  .markdown-body :global(th),
  .markdown-body :global(td) {
    border: 1px solid var(--color-border);
    padding: 0.5em 0.75em;
    text-align: left;
  }
  .markdown-body :global(th) {
    background: var(--color-surface);
    font-weight: 600;
  }
  .markdown-body :global(tr:nth-child(even)) {
    background: color-mix(in srgb, var(--color-surface) 50%, transparent);
  }
  .markdown-body :global(.hljs) {
    background: transparent;
    color: var(--color-text-primary);
  }
  .markdown-body :global(.hljs-keyword),
  .markdown-body :global(.hljs-selector-tag),
  .markdown-body :global(.hljs-built_in) {
    color: #c678dd;
  }
  .markdown-body :global(.hljs-string),
  .markdown-body :global(.hljs-attr) {
    color: #98c379;
  }
  .markdown-body :global(.hljs-number),
  .markdown-body :global(.hljs-literal) {
    color: #d19a66;
  }
  .markdown-body :global(.hljs-comment) {
    color: #5c6370;
    font-style: italic;
  }
  .markdown-body :global(.hljs-function),
  .markdown-body :global(.hljs-title) {
    color: #61afef;
  }
  .markdown-body :global(.hljs-variable),
  .markdown-body :global(.hljs-params) {
    color: #e06c75;
  }
  .markdown-body :global(.hljs-type),
  .markdown-body :global(.hljs-class) {
    color: #e5c07b;
  }
</style>
