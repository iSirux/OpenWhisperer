<script lang="ts">
  import type { QuickAction } from '$lib/utils/llm';
  import { settings } from '$lib/stores/settings';
  import { ctrlHeld } from '$lib/stores/ctrlHint';

  let {
    onSendPrompt,
    onSendAfterIdle,
    generatedActions,
    builtinActions,
    hasOutcomeAbove = false,
  }: {
    onSendPrompt: (prompt: string) => void;
    /** Ctrl+click routes the action here: defer until the repo/worktree scope is idle. */
    onSendAfterIdle?: (prompt: string) => void;
    generatedActions?: QuickAction[];
    /** App-provided actions (e.g. the PR "commit, push, create PR" chip), shown before custom ones. */
    builtinActions?: QuickAction[];
    hasOutcomeAbove?: boolean;
  } = $props();

  function handleClick(e: MouseEvent, prompt: string) {
    if (onSendAfterIdle && (e.ctrlKey || e.metaKey)) {
      onSendAfterIdle(prompt);
    } else {
      onSendPrompt(prompt);
    }
  }

  // User-defined quick actions from settings (converted from string[] to QuickAction[])
  const customActions = $derived(
    ($settings.quick_actions ?? []).map((prompt: string) => ({ prompt }))
  );

  // AI-generated contextual actions (from LLM)
  const contextualActions = $derived(
    generatedActions && generatedActions.length > 0 ? generatedActions : []
  );

  const appActions = $derived(builtinActions ?? []);

  // Whether we have any actions to show at all
  const hasAnyActions = $derived(
    customActions.length > 0 || contextualActions.length > 0 || appActions.length > 0
  );
</script>

{#if hasAnyActions}
<div class="quick-actions" class:no-border={hasOutcomeAbove}>
  {#if appActions.length > 0}
    <div class="quick-actions-buttons">
      {#each appActions as action}
        <button
          class="quick-action-button builtin"
          onclick={(e) => handleClick(e, action.prompt)}
          title={[
            action.label ? action.prompt : undefined,
            onSendAfterIdle ? 'Ctrl+click: run when this repo/worktree is idle' : undefined,
          ].filter(Boolean).join(' — ') || undefined}
        >
          {action.label ?? action.prompt}
          {#if $ctrlHeld && onSendAfterIdle}
            <span class="ctrl-hint-badge" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  {#if customActions.length > 0}
    <div class="quick-actions-buttons">
      {#each customActions as action}
        <button
          class="quick-action-button"
          onclick={(e) => handleClick(e, action.prompt)}
          title={onSendAfterIdle ? 'Ctrl+click: run when this repo/worktree is idle' : undefined}
        >
          {action.prompt}
          {#if $ctrlHeld && onSendAfterIdle}
            <span class="ctrl-hint-badge" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  {#if contextualActions.length > 0}
    <div class="quick-actions-buttons">
      {#each contextualActions as action}
        <button
          class="quick-action-button contextual"
          title={[
            action.label ? action.prompt : undefined,
            onSendAfterIdle ? 'Ctrl+click: run when this repo/worktree is idle' : undefined,
          ].filter(Boolean).join(' — ') || undefined}
          onclick={(e) => handleClick(e, action.prompt)}
        >
          {action.label ?? action.prompt}
          {#if $ctrlHeld && onSendAfterIdle}
            <span class="ctrl-hint-badge" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
{/if}

<style>
  .quick-actions {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.375rem;
    padding: 0.375rem 0 0.25rem;
    border-top: 1px dashed var(--color-border);
  }

  .quick-actions.no-border {
    border-top: none;
  }

  .quick-actions-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .quick-action-button {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    background: var(--color-surface);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    font-size: 0.8rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
    min-width: unset;
  }

  .quick-action-button:hover {
    background: var(--color-surface-elevated);
    color: var(--color-text-primary);
    border-color: var(--color-accent);
  }

  .quick-action-button:active {
    transform: scale(0.97);
  }

  .quick-action-button.contextual {
    border-color: color-mix(in srgb, var(--color-accent) 30%, var(--color-border));
  }

  .quick-action-button.contextual:hover {
    border-color: var(--color-accent);
  }

  .quick-action-button.builtin {
    border-color: color-mix(in srgb, rgb(74, 222, 128) 30%, var(--color-border));
  }

  .quick-action-button.builtin:hover {
    border-color: rgb(74, 222, 128);
  }

  .ctrl-hint-badge {
    position: absolute;
    top: -0.45rem;
    right: -0.45rem;
    width: 1rem;
    height: 1rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-accent);
    color: white;
    border-radius: 0.25rem;
    z-index: 5;
    pointer-events: none;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  }

  .ctrl-hint-badge svg {
    width: 11px;
    height: 11px;
  }
</style>
