<script lang="ts">
  import type { QuickAction } from '$lib/utils/llm';
  import { settings } from '$lib/stores/settings';

  let {
    onSendPrompt,
    generatedActions,
    hasOutcomeAbove = false,
  }: {
    onSendPrompt: (prompt: string) => void;
    generatedActions?: QuickAction[];
    hasOutcomeAbove?: boolean;
  } = $props();

  // User-defined quick actions from settings (converted from string[] to QuickAction[])
  const customActions = $derived(
    ($settings.quick_actions ?? []).map((prompt: string) => ({ prompt }))
  );

  // AI-generated contextual actions (from LLM)
  const contextualActions = $derived(
    generatedActions && generatedActions.length > 0 ? generatedActions : []
  );

  // Whether we have any actions to show at all
  const hasAnyActions = $derived(
    customActions.length > 0 || contextualActions.length > 0
  );
</script>

{#if hasAnyActions}
<div class="quick-actions" class:no-border={hasOutcomeAbove}>
  {#if customActions.length > 0}
    <div class="quick-actions-buttons">
      {#each customActions as action}
        <button
          class="quick-action-button"
          onclick={() => onSendPrompt(action.prompt)}
        >
          {action.prompt}
        </button>
      {/each}
    </div>
  {/if}

  {#if contextualActions.length > 0}
    <div class="quick-actions-buttons">
      {#each contextualActions as action}
        <button
          class="quick-action-button contextual"
          onclick={() => onSendPrompt(action.prompt)}
        >
          {action.prompt}
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
</style>
