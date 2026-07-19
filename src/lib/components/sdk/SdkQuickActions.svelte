<script lang="ts">
  import type { QuickAction } from '$lib/utils/llm';
  import { settings } from '$lib/stores/settings';
  import { modifierCombo } from '$lib/stores/ctrlHint';
  import { sendTimingFromEvent } from '$lib/utils/sendTiming';
  import SendTimingIcon from './SendTimingIcon.svelte';

  let {
    onAppend,
    onSendNow,
    onSendSessionIdle,
    onSendRepoIdle,
    onSend5hReset,
    generatedActions,
    builtinActions,
    showContextual = true,
    verb = 'send',
  }: {
    /** Plain click: append the action's text to the prompt draft (editable before sending). */
    onAppend: (prompt: string) => void;
    /** Ctrl+click: send right away (parent combines with the current draft). */
    onSendNow: (prompt: string) => void;
    /** Shift+click: send once this session's own query is done. When absent,
     *  Shift falls back to onSendRepoIdle (e.g. the setup view, where no session
     *  exists yet and repo-idle is the only deferral). */
    onSendSessionIdle?: (prompt: string) => void;
    /** Ctrl+Shift+click: send once the whole repo/worktree scope is idle. */
    onSendRepoIdle?: (prompt: string) => void;
    /** Ctrl+Shift+Alt+click: queue the send for the next 5h usage-window reset. */
    onSend5hReset?: (prompt: string) => void;
    generatedActions?: QuickAction[];
    /** App-provided actions (e.g. the PR "commit, push, create PR" chip), shown before custom ones. */
    builtinActions?: QuickAction[];
    /** AI-generated contextual actions are follow-up suggestions from the last
     *  exchange — only shown while the session is idle (they go stale mid-turn). */
    showContextual?: boolean;
    /** Tooltip verb: "send" for live sessions, "start" for the setup view. */
    verb?: string;
  } = $props();

  type RowAction = QuickAction & { kind: 'builtin' | 'custom' | 'contextual' };

  const actions = $derived<RowAction[]>([
    ...(builtinActions ?? []).map((a) => ({ ...a, kind: 'builtin' as const })),
    ...($settings.quick_actions ?? []).map((prompt: string) => ({
      prompt,
      kind: 'custom' as const,
    })),
    ...(showContextual ? (generatedActions ?? []) : []).map((a) => ({
      ...a,
      kind: 'contextual' as const,
    })),
  ]);

  function handleClick(e: MouseEvent, prompt: string) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl && !e.shiftKey) {
      onAppend(prompt);
      return;
    }
    const timing = sendTimingFromEvent(e);
    if (timing === 'reset_5h' && onSend5hReset) {
      onSend5hReset(prompt);
    } else if (timing === 'repo_idle' && onSendRepoIdle) {
      onSendRepoIdle(prompt);
    } else if (timing === 'session_idle' && (onSendSessionIdle || onSendRepoIdle)) {
      (onSendSessionIdle ?? onSendRepoIdle)!(prompt);
    } else {
      onSendNow(prompt);
    }
  }

  function actionTitle(action: RowAction): string {
    const timings = [
      'Click: add to prompt',
      `Ctrl: ${verb} now`,
      onSendSessionIdle ? `Shift: ${verb} when this session is idle` : undefined,
      onSendRepoIdle
        ? `${onSendSessionIdle ? '' : 'Shift / '}Ctrl+Shift: ${verb} when repo is idle`
        : undefined,
      onSend5hReset ? `Ctrl+Shift+Alt: ${verb} on next 5h reset` : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
    return action.label ? `${action.prompt}\n${timings}` : timings;
  }
</script>

{#if actions.length > 0}
  <div class="quick-actions">
    {#each actions as action}
      <button
        class="quick-action-button"
        class:builtin={action.kind === 'builtin'}
        class:contextual={action.kind === 'contextual'}
        onclick={(e) => handleClick(e, action.prompt)}
        title={actionTitle(action)}
      >
        {action.label ?? action.prompt}
        {#if $modifierCombo === 'ctrl'}
          <span class="ctrl-hint-badge" aria-hidden="true">
            <SendTimingIcon timing="now" />
          </span>
        {:else if $modifierCombo === 'shift' && onSendSessionIdle}
          <span class="ctrl-hint-badge" aria-hidden="true">
            <SendTimingIcon timing="session_idle" />
          </span>
        {:else if ($modifierCombo === 'ctrl+shift' || $modifierCombo === 'shift') && onSendRepoIdle}
          <span class="ctrl-hint-badge" aria-hidden="true">
            <SendTimingIcon timing="repo_idle" />
          </span>
        {:else if $modifierCombo === 'ctrl+shift+alt' && onSend5hReset}
          <span class="ctrl-hint-badge" aria-hidden="true">
            <SendTimingIcon timing="reset_5h" />
          </span>
        {/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .quick-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .quick-action-button {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.625rem;
    background: var(--color-surface);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    font-size: 0.75rem;
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

  /* Modifier-held hint badge: Ctrl = send now, Shift = send when this session
     is idle, Ctrl+Shift = send when the repo/worktree is idle */
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
</style>
