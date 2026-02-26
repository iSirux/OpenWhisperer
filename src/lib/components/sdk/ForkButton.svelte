<script lang="ts">
  import { sdkSessions, activeSdkSessionId, type SdkMessage, type SdkSession } from '$lib/stores/sdkSessions';
  import { activeSessionId } from '$lib/stores/sessions';

  interface Props {
    /** The source session ID */
    sessionId: string;
    /** The index of the message in the raw messages array to fork from */
    messageIndex: number;
    /** The message being forked from (used to determine fork availability) */
    message: SdkMessage;
    /** The source session (used to check sdkSessionId availability) */
    session?: SdkSession;
  }

  let { sessionId, messageIndex, message, session }: Props = $props();
  let forking = $state(false);

  // Fork is available when:
  // 0. The message is not the first message in the session
  // 1. The message has a turnUuid (assistant content) OR is a user message
  // 2. The session has an sdkSessionId (has sent at least one query)
  // 3. The provider is not openai (Codex doesn't support fork yet)
  let canFork = $derived(
    messageIndex > 0 &&
    (!!message.turnUuid || message.type === 'user') &&
    !!session?.sdkSessionId &&
    session?.provider !== 'openai'
  );

  async function handleFork() {
    if (forking) return;
    forking = true;
    try {
      const newSessionId = await sdkSessions.forkSession(sessionId, messageIndex);
      if (newSessionId) {
        activeSessionId.set(null);
        activeSdkSessionId.set(newSessionId);
      }
    } catch (err) {
      console.error('[ForkButton] Fork failed:', err);
    } finally {
      forking = false;
    }
  }
</script>

{#if canFork}
  <button
    class="fork-button"
    onclick={handleFork}
    disabled={forking}
    title="Fork conversation from this point"
  >
    <svg viewBox="0 0 16 16" fill="currentColor">
      <path fill-rule="evenodd" d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM5 5.372a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5v2.128a2.251 2.251 0 1 0 1.5 0V8.5h1.5a2.25 2.25 0 0 0 2.25-2.25v-.878a2.25 2.25 0 1 0-1.5 0v.878a.75.75 0 0 1-.75.75h-4.5A.75.75 0 0 1 5 6.25v-.878ZM8.75 12.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.25 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" />
    </svg>
  </button>
{/if}

<style>
  .fork-button {
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
    border: none;
    border-radius: 4px;
    padding: 0.35rem;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: unset;
  }

  .fork-button:hover {
    background: var(--color-border);
    color: var(--color-text-primary);
  }

  .fork-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .fork-button svg {
    width: 14px;
    height: 14px;
  }
</style>
