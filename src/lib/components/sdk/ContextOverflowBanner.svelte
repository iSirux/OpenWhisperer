<script lang="ts">
  import { sdkSessions, activeSdkSessionId, type SdkSession } from '$lib/stores/sdkSessions';
  import { activeSessionId } from '$lib/stores/sessions';

  interface Props {
    session: SdkSession;
  }

  let { session }: Props = $props();

  let busy = $state(false);

  // The most recent message index with a turnUuid is the best auto fork-point:
  // forking there preserves the conversation minus the final over-limit turn.
  let forkableIndex = $derived.by(() => {
    const msgs = session.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].turnUuid) return i;
    }
    return -1;
  });

  let canFork = $derived(
    !!session.sdkSessionId &&
    session.provider !== 'openai' &&
    forkableIndex >= 0
  );

  async function handleFork() {
    if (busy || !canFork) return;
    busy = true;
    try {
      const newId = await sdkSessions.forkSession(session.id, forkableIndex);
      if (newId) {
        activeSessionId.set(null);
        activeSdkSessionId.set(newId);
      }
    } catch (err) {
      console.error('[ContextOverflowBanner] Fork failed:', err);
    } finally {
      busy = false;
    }
  }

  async function handleStartFresh() {
    if (busy) return;
    busy = true;
    try {
      const newId = sdkSessions.createSetupSession(
        session.model,
        session.effortLevel,
        false,
        session.provider,
        session.cwd,
        session.readOnlyMode ?? false,
      );
      activeSessionId.set(null);
      activeSdkSessionId.set(newId);
    } catch (err) {
      console.error('[ContextOverflowBanner] Start fresh failed:', err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="context-overflow-banner">
  <div class="banner-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  </div>
  <div class="banner-body">
    <div class="banner-title">Context window exceeded</div>
    <div class="banner-text">
      This session has exceeded its context window. It cannot continue — Claude will return the same error on every retry.
    </div>
    <div class="banner-actions">
      <button
        class="banner-btn primary"
        onclick={handleFork}
        disabled={busy || !canFork}
        title={canFork ? 'Fork from the last successful turn' : 'No prior turn available to fork from'}
      >
        <svg viewBox="0 0 16 16" fill="currentColor" class="btn-icon">
          <path fill-rule="evenodd" d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM5 5.372a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5v2.128a2.251 2.251 0 1 0 1.5 0V8.5h1.5a2.25 2.25 0 0 0 2.25-2.25v-.878a2.25 2.25 0 1 0-1.5 0v.878a.75.75 0 0 1-.75.75h-4.5A.75.75 0 0 1 5 6.25v-.878ZM8.75 12.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.25 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" />
        </svg>
        Fork from earlier
      </button>
      <button
        class="banner-btn"
        onclick={handleStartFresh}
        disabled={busy}
        title="Create a new session in the same repository with the same model settings"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-icon">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Start fresh session
      </button>
    </div>
  </div>
  <button
    class="banner-close"
    onclick={() => sdkSessions.dismissContextOverflow(session.id)}
    title="Dismiss"
    aria-label="Dismiss"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  </button>
</div>

<style>
  .context-overflow-banner {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    margin: 0.5rem 0.75rem;
    border: 1px solid color-mix(in srgb, var(--color-error) 40%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--color-error) 10%, transparent);
    color: var(--color-text-primary);
  }

  .banner-icon {
    flex-shrink: 0;
    color: var(--color-error);
    margin-top: 0.125rem;
  }

  .banner-icon svg {
    width: 20px;
    height: 20px;
  }

  .banner-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .banner-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-error);
  }

  .banner-text {
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    line-height: 1.4;
  }

  .banner-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.25rem;
    flex-wrap: wrap;
  }

  .banner-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 500;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text-primary);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }

  .banner-btn:hover:not(:disabled) {
    background: var(--color-border);
  }

  .banner-btn.primary {
    border-color: color-mix(in srgb, var(--color-error) 50%, transparent);
    background: color-mix(in srgb, var(--color-error) 18%, transparent);
    color: var(--color-text-primary);
  }

  .banner-btn.primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-error) 28%, transparent);
  }

  .banner-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
  }

  .banner-close {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--color-text-muted);
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .banner-close:hover {
    background: color-mix(in srgb, var(--color-error) 15%, transparent);
    color: var(--color-text-primary);
  }

  .banner-close svg {
    width: 14px;
    height: 14px;
  }
</style>
