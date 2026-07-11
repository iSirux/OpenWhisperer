<script lang="ts">
  import { settings } from '$lib/stores/settings';
  import { sdkSessions, activeSdkSessionId, type SdkImageContent, type EffortLevel, settingsToStoreEffort } from '$lib/stores/sdkSessions';

  interface Props {
    /** The original prompt content to rerun */
    prompt: string;
    /** Optional images from the original message */
    images?: SdkImageContent[];
    /** Current session's repo path (cwd) */
    currentCwd: string;
    /** Current session's model */
    currentModel: string;
    /** Current session's effort level */
    currentEffortLevel?: EffortLevel;
  }

  let { prompt, images, currentCwd, currentModel, currentEffortLevel = null }: Props = $props();

  function handleRerun() {
    const model = currentModel || $settings.default_model;
    const repoPath = currentCwd || '.';
    const effortLevel = currentEffortLevel ?? settingsToStoreEffort($settings.default_effort_level);

    // Open a fresh setup session and prefill the prompt for editing/reuse.
    const newSessionId = sdkSessions.createSetupSession(
      model,
      effortLevel,
      undefined,
      repoPath
    );
    sdkSessions.updateDraft(newSessionId, prompt, images);

    // Select the new session
    activeSdkSessionId.set(newSessionId);
  }
</script>

<div class="rerun-dropdown">
  <button
    class="rerun-button"
    onclick={handleRerun}
    title="Open a new session with this prompt"
  >
    <svg viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5">
      <path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-9.182a.75.75 0 00-.75.75v2.43l-.31-.31A7 7 0 003.77 8.25a.75.75 0 001.449.39 5.5 5.5 0 019.201-2.466l.312.311h-2.433a.75.75 0 000 1.5h4.243a.75.75 0 00.75-.75V2.992a.75.75 0 00-.75-.75z" clip-rule="evenodd" />
    </svg>
  </button>
</div>

<style>
  .rerun-dropdown {
    display: inline-block;
  }

  .rerun-button {
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

  .rerun-button:hover {
    background: var(--color-border);
    color: var(--color-text-primary);
  }
</style>
