<script lang="ts">
  import {
    sessionPrs,
    type SessionPrEntry,
    type MergeStrategy,
  } from '$lib/stores/sessionPrs';
  import {
    sdkSessions,
    hasBusySessionsInScope,
    normalizeScopePath,
    type SdkSession,
  } from '$lib/stores/sdkSessions';
  import type { RepoConfig } from '$lib/stores/repos';
  import { renderMarkdown } from '$lib/utils/markdown';

  let {
    session,
    entry,
    repo,
  }: {
    session: SdkSession;
    entry: SessionPrEntry;
    repo?: RepoConfig;
  } = $props();

  let pr = $derived(entry.pr);
  let effectiveState = $derived(
    pr ? (pr.is_draft && pr.state === 'open' ? 'draft' : pr.state) : null
  );

  let descriptionOpen = $state(true);

  /** Session runs in a linked worktree (vs directly in the main repo checkout). */
  let isWorktree = $derived(
    !!repo?.path &&
      !!session.cwd &&
      normalizeScopePath(session.cwd) !== normalizeScopePath(repo.path)
  );

  /** Any agent still working in this session's repo+worktree scope — don't rip
   *  the worktree out from under it. */
  let scopeBusy = $derived(hasBusySessionsInScope($sdkSessions, session.cwd));

  let strategy = $state<MergeStrategy>('squash');
  // Seed from the repo's remembered strategy once (user changes win afterwards).
  let strategySeeded = $state(false);
  $effect(() => {
    if (!strategySeeded) {
      strategy = repo?.last_merge_strategy ?? 'squash';
      strategySeeded = true;
    }
  });

  let checkCounts = $derived.by(() => {
    const checks = pr?.checks ?? [];
    return {
      total: checks.length,
      pass: checks.filter((c) => c.status === 'pass').length,
      fail: checks.filter((c) => c.status === 'fail').length,
      pending: checks.filter((c) => c.status === 'pending').length,
    };
  });

  let reviewLabel = $derived.by(() => {
    switch (pr?.review_decision) {
      case 'approved':
        return 'Approved';
      case 'changes_requested':
        return 'Changes requested';
      case 'review_required':
        return 'Review required';
      default:
        return null;
    }
  });

  let canMerge = $derived(!!pr && pr.state === 'open' && !pr.is_draft && !entry.merging);

  // Poll while the panel is open on an open PR (checks/reviews move on GitHub).
  $effect(() => {
    if (!pr || pr.state !== 'open') return;
    const t = setInterval(() => {
      void sessionPrs.refresh(session);
    }, 15_000);
    return () => clearInterval(t);
  });

  async function openOnGitHub() {
    if (!pr?.url) return;
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(pr.url);
    } catch (e) {
      console.error('[PrPanel] Failed to open PR url:', e);
    }
  }

  async function openCheckUrl(url: string | null) {
    if (!url) return;
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    } catch (e) {
      console.error('[PrPanel] Failed to open check url:', e);
    }
  }
</script>

<div class="pr-panel">
  <div class="pr-header">
    <div class="pr-header-left">
      <span class="pr-icon state-{effectiveState ?? 'none'}" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
        </svg>
      </span>
      {#if pr}
        <button class="pr-title" onclick={openOnGitHub} title="Open on GitHub">
          <span class="pr-number">#{pr.number}</span>
          {pr.title}
        </button>
        <span class="pr-chip state-{effectiveState}">
          {effectiveState === 'open' ? 'Open' : effectiveState === 'draft' ? 'Draft' : effectiveState === 'merged' ? 'Merged' : 'Closed'}
        </span>
        {#if reviewLabel && pr.state === 'open'}
          <span
            class="pr-chip review-{pr.review_decision}"
          >
            {reviewLabel}
          </span>
        {/if}
      {:else if entry.loading}
        <span class="pr-muted">Checking for a pull request…</span>
      {:else if entry.error}
        <span class="pr-error-text">Failed to fetch PR</span>
      {:else}
        <span class="pr-muted">No pull request found for this branch</span>
      {/if}
    </div>
    <div class="pr-header-right">
      <button
        class="pr-icon-btn"
        class:spinning={entry.loading}
        onclick={() => sessionPrs.refresh(session)}
        disabled={entry.loading}
        title="Refresh PR status"
        aria-label="Refresh PR status"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <polyline points="21 3 21 9 15 9" />
        </svg>
      </button>
      <button
        class="pr-icon-btn"
        onclick={() => sessionPrs.closePanel(session.id)}
        title="Hide PR panel"
        aria-label="Hide PR panel"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  </div>

  {#if entry.error}
    <div class="pr-error">{entry.error}</div>
  {/if}

  {#if pr}
    <div class="pr-meta">
      <span class="pr-refs" title="Merge {pr.head_ref} into {pr.base_ref}">
        <span class="pr-ref">{pr.head_ref}</span>
        <span class="pr-arrow">→</span>
        <span class="pr-ref">{pr.base_ref}</span>
      </span>
      <span class="pr-diffstat">
        <span class="pr-additions">+{pr.additions}</span>
        <span class="pr-deletions">−{pr.deletions}</span>
        · {pr.changed_files} file{pr.changed_files === 1 ? '' : 's'}
      </span>
      {#if pr.state === 'open' && pr.mergeable === 'conflicting'}
        <span class="pr-chip review-changes_requested">Merge conflicts</span>
      {/if}
    </div>

    {#if pr.body?.trim()}
      <div class="pr-description">
        <button
          class="pr-desc-toggle"
          onclick={() => (descriptionOpen = !descriptionOpen)}
          aria-expanded={descriptionOpen}
        >
          <svg class="pr-desc-chevron" class:open={descriptionOpen} viewBox="0 0 16 16" fill="currentColor">
            <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
          Description
        </button>
        {#if descriptionOpen}
          <div class="pr-desc-body">
            {@html renderMarkdown(pr.body)}
          </div>
        {/if}
      </div>
    {/if}

    {#if pr.checks.length > 0}
      <div class="pr-checks">
        <div class="pr-checks-summary">
          Checks:
          {#if checkCounts.fail > 0}<span class="check-fail">{checkCounts.fail} failing</span> ·{/if}
          {#if checkCounts.pending > 0}<span class="check-pending">{checkCounts.pending} running</span> ·{/if}
          <span class="check-pass">{checkCounts.pass}/{checkCounts.total} passing</span>
        </div>
        <div class="pr-checks-list">
          {#each pr.checks as check (check.name)}
            <button
              class="pr-check"
              onclick={() => openCheckUrl(check.url)}
              disabled={!check.url}
              title={check.url ? 'Open check details' : undefined}
            >
              {#if check.status === 'pass'}
                <svg class="check-icon check-pass" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" /></svg>
              {:else if check.status === 'fail'}
                <svg class="check-icon check-fail" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.749.749 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.749.749 0 1 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" /></svg>
              {:else if check.status === 'pending'}
                <svg class="check-icon check-pending" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028 1.352a.75.75 0 0 1-.832 1.248l-2.36-1.573A.75.75 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z" /></svg>
              {:else}
                <svg class="check-icon check-neutral" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm3.25-.75h6.5a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1 0-1.5Z" /></svg>
              {/if}
              <span class="pr-check-name">{check.name}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    {#if pr.state === 'open'}
      <div class="pr-merge-row">
        {#if pr.is_draft}
          <span class="pr-muted">Draft PR — mark it ready for review on GitHub before merging.</span>
        {:else}
          <select class="pr-strategy" bind:value={strategy} disabled={entry.merging} aria-label="Merge strategy">
            <option value="squash">Squash and merge</option>
            <option value="merge">Create a merge commit</option>
            <option value="rebase">Rebase and merge</option>
          </select>
          <button
            class="pr-merge-btn"
            class:ready={pr.merge_state_status === 'clean'}
            onclick={() => sessionPrs.merge(session, strategy)}
            disabled={!canMerge}
            title={pr.merge_state_status === 'clean'
              ? 'All checks green — ready to merge'
              : 'GitHub may reject the merge (pending checks, required reviews, or conflicts)'}
          >
            {entry.merging ? 'Merging…' : 'Merge'}
          </button>
        {/if}
      </div>
      {#if entry.mergeError}
        <div class="pr-error">{entry.mergeError}</div>
      {/if}
    {:else if pr.state === 'merged'}
      <div class="pr-merged-banner">
        {#if entry.cleanupResult}
          Cleaned up:
          {[
            entry.cleanupResult.worktree_removed ? 'worktree removed' : null,
            entry.cleanupResult.local_branch_deleted ? 'local branch deleted' : null,
            entry.cleanupResult.remote_branch_deleted ? 'remote branch deleted' : null,
          ]
            .filter(Boolean)
            .join(' · ') || 'nothing to do'}.
          Archive the session when you're done.
        {:else}
          Merged. You can now clean up: delete the branch/worktree and archive this session when you're done.
        {/if}
      </div>
      {#if entry.cleanupResult?.warnings.length}
        <div class="pr-cleanup-warnings">
          {#each entry.cleanupResult.warnings as warning (warning)}
            <div>{warning}</div>
          {/each}
        </div>
      {/if}
      <div class="pr-cleanup-row">
        {#if !entry.cleanupResult}
          <button
            class="pr-cleanup-btn"
            onclick={() => sessionPrs.cleanup(session)}
            disabled={entry.cleaning || scopeBusy}
            title={scopeBusy
              ? 'An agent is still working in this worktree — wait for it to finish'
              : 'Only proceeds when there are no uncommitted changes or unpushed commits'}
          >
            {entry.cleaning
              ? 'Cleaning up…'
              : isWorktree
                ? 'Delete branch & worktree'
                : 'Delete branch'}
          </button>
        {/if}
        <button
          class="pr-archive-btn"
          onclick={() => sdkSessions.closeSession(session.id)}
          disabled={entry.cleaning}
          title="Close this session and move it to the archive"
        >
          Archive session
        </button>
      </div>
      {#if entry.cleanupError}
        <div class="pr-error">{entry.cleanupError}</div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .pr-panel {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    margin: 0 0.75rem 0.5rem;
    padding: 0.7rem 0.85rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    font-size: 0.8rem;
  }

  .pr-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-width: 0;
  }

  .pr-header-left {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
    flex: 1;
  }

  .pr-header-right {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .pr-icon {
    display: inline-flex;
    flex-shrink: 0;
  }

  .pr-icon svg {
    width: 0.95rem;
    height: 0.95rem;
  }

  .pr-icon.state-open { color: rgb(74, 222, 128); }
  .pr-icon.state-draft { color: rgb(148, 163, 184); }
  .pr-icon.state-merged { color: rgb(192, 132, 252); }
  .pr-icon.state-closed { color: rgb(248, 113, 113); }
  .pr-icon.state-none { color: var(--color-text-muted); }

  .pr-title {
    font-weight: 600;
    color: var(--color-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    cursor: pointer;
    text-align: left;
  }

  .pr-title:hover {
    text-decoration: underline;
  }

  .pr-number {
    color: var(--color-text-muted);
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-weight: 600;
    margin-right: 0.2rem;
  }

  .pr-chip {
    font-size: 0.68rem;
    font-weight: 600;
    padding: 0.06rem 0.4rem;
    border-radius: 999px;
    flex-shrink: 0;
  }

  .pr-chip.state-open { color: rgb(74, 222, 128); background: rgba(74, 222, 128, 0.12); }
  .pr-chip.state-draft { color: rgb(148, 163, 184); background: rgba(148, 163, 184, 0.12); }
  .pr-chip.state-merged { color: rgb(192, 132, 252); background: rgba(192, 132, 252, 0.12); }
  .pr-chip.state-closed { color: rgb(248, 113, 113); background: rgba(248, 113, 113, 0.12); }
  .pr-chip.review-approved { color: rgb(74, 222, 128); background: rgba(74, 222, 128, 0.12); }
  .pr-chip.review-changes_requested { color: rgb(251, 146, 60); background: rgba(251, 146, 60, 0.12); }
  .pr-chip.review-review_required { color: rgb(251, 191, 36); background: rgba(251, 191, 36, 0.12); }

  .pr-muted {
    color: var(--color-text-muted);
  }

  .pr-icon-btn {
    display: inline-flex;
    padding: 0.25rem;
    border-radius: 6px;
    color: var(--color-text-muted);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .pr-icon-btn:hover:not(:disabled) {
    color: var(--color-text-primary);
    background: var(--color-border);
  }

  .pr-icon-btn svg {
    width: 0.85rem;
    height: 0.85rem;
  }

  .pr-icon-btn.spinning svg {
    animation: pr-spin 0.9s linear infinite;
  }

  @keyframes pr-spin {
    to { transform: rotate(360deg); }
  }

  .pr-meta {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    color: var(--color-text-secondary);
  }

  .pr-refs {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    min-width: 0;
  }

  .pr-ref {
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 0.72rem;
    color: rgb(96, 165, 250);
    background: rgba(96, 165, 250, 0.1);
    padding: 0.03rem 0.3rem;
    border-radius: 0.25rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 14rem;
  }

  .pr-arrow {
    color: var(--color-text-muted);
    flex-shrink: 0;
  }

  .pr-diffstat {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    flex-shrink: 0;
  }

  .pr-additions { color: rgb(74, 222, 128); }
  .pr-deletions { color: rgb(248, 113, 113); }

  .pr-checks {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .pr-checks-summary {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    display: flex;
    gap: 0.3rem;
    align-items: center;
  }

  .pr-checks-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .pr-check {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.12rem 0.45rem;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    font-size: 0.7rem;
    color: var(--color-text-secondary);
    cursor: pointer;
    max-width: 100%;
  }

  .pr-check:disabled {
    cursor: default;
  }

  .pr-check:hover:not(:disabled) {
    border-color: var(--color-accent);
  }

  .pr-check-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .check-icon {
    width: 0.7rem;
    height: 0.7rem;
    flex-shrink: 0;
  }

  .check-pass { color: rgb(74, 222, 128); }
  .check-fail { color: rgb(248, 113, 113); }
  .check-pending { color: rgb(251, 191, 36); }
  .check-neutral { color: var(--color-text-muted); }

  .pr-merge-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .pr-strategy {
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 0.75rem;
    padding: 0.3rem 0.4rem;
  }

  .pr-merge-btn {
    padding: 0.3rem 0.9rem;
    border-radius: 6px;
    font-size: 0.75rem;
    font-weight: 600;
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .pr-merge-btn.ready {
    background: rgba(74, 222, 128, 0.15);
    color: rgb(74, 222, 128);
    border-color: rgba(74, 222, 128, 0.4);
  }

  .pr-merge-btn:hover:not(:disabled) {
    filter: brightness(1.2);
  }

  .pr-merge-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .pr-description {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .pr-desc-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    align-self: flex-start;
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--color-text-muted);
    cursor: pointer;
    padding: 0.1rem 0.2rem;
    border-radius: 4px;
  }

  .pr-desc-toggle:hover {
    color: var(--color-text-primary);
  }

  .pr-desc-chevron {
    width: 0.7rem;
    height: 0.7rem;
    transition: transform 0.15s ease;
  }

  .pr-desc-chevron.open {
    transform: rotate(90deg);
  }

  .pr-desc-body {
    font-size: 0.74rem;
    line-height: 1.45;
    color: var(--color-text-secondary);
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 0.45rem 0.6rem;
    max-height: 11rem;
    overflow-y: auto;
    word-break: break-word;
  }

  .pr-desc-body :global(p),
  .pr-desc-body :global(ul),
  .pr-desc-body :global(ol),
  .pr-desc-body :global(pre) {
    margin: 0 0 0.45rem;
  }

  .pr-desc-body :global(> *:last-child) {
    margin-bottom: 0;
  }

  .pr-desc-body :global(h1),
  .pr-desc-body :global(h2),
  .pr-desc-body :global(h3),
  .pr-desc-body :global(h4) {
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--color-text-primary);
    margin: 0.5rem 0 0.3rem;
  }

  .pr-desc-body :global(ul),
  .pr-desc-body :global(ol) {
    padding-left: 1.1rem;
  }

  .pr-desc-body :global(code) {
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 0.68rem;
    background: var(--color-surface);
    border-radius: 3px;
    padding: 0.05rem 0.25rem;
  }

  .pr-desc-body :global(pre) {
    background: var(--color-surface);
    border-radius: 4px;
    padding: 0.4rem 0.5rem;
    overflow-x: auto;
  }

  .pr-desc-body :global(a) {
    color: rgb(96, 165, 250);
  }

  .pr-merged-banner {
    font-size: 0.75rem;
    color: rgb(192, 132, 252);
    background: rgba(192, 132, 252, 0.1);
    border: 1px solid rgba(192, 132, 252, 0.25);
    border-radius: 6px;
    padding: 0.4rem 0.6rem;
  }

  .pr-cleanup-warnings {
    font-size: 0.72rem;
    color: rgb(251, 191, 36);
    background: rgba(251, 191, 36, 0.08);
    border: 1px solid rgba(251, 191, 36, 0.25);
    border-radius: 6px;
    padding: 0.35rem 0.55rem;
  }

  .pr-cleanup-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .pr-cleanup-btn,
  .pr-archive-btn {
    padding: 0.3rem 0.9rem;
    border-radius: 6px;
    font-size: 0.75rem;
    font-weight: 600;
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .pr-cleanup-btn {
    color: rgb(248, 113, 113);
    border-color: rgba(248, 113, 113, 0.35);
  }

  .pr-archive-btn {
    color: rgb(192, 132, 252);
    border-color: rgba(192, 132, 252, 0.35);
  }

  .pr-cleanup-btn:hover:not(:disabled),
  .pr-archive-btn:hover:not(:disabled) {
    filter: brightness(1.2);
  }

  .pr-cleanup-btn:disabled,
  .pr-archive-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .pr-error,
  .pr-error-text {
    font-size: 0.72rem;
    color: rgb(248, 113, 113);
  }

  .pr-error {
    background: rgba(248, 113, 113, 0.08);
    border: 1px solid rgba(248, 113, 113, 0.25);
    border-radius: 6px;
    padding: 0.35rem 0.55rem;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 8rem;
    overflow-y: auto;
  }
</style>
