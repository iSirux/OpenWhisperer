<script lang="ts">
  import type { LaunchCommand, LaunchProfile, LaunchRuntime, QueuedLaunch } from "$lib/types/launch";
  import { launchStore } from "$lib/stores/launchProfiles";

  interface Props {
    repoId: string;
    repoPath: string;
    profiles: LaunchProfile[];
    commands: LaunchCommand[];
    runtime: LaunchRuntime | null;
    queued: QueuedLaunch | null;
    isAgentRunning: boolean;
    sessionId: string;
  }

  let {
    repoId,
    repoPath,
    profiles,
    commands,
    runtime,
    queued,
    isAgentRunning,
    sessionId,
  }: Props = $props();

  let collapsed = $state(false);
  let contextMenuProfileId = $state<string | null>(null);
  let selectedCommandIds = $state<Set<string>>(new Set());

  /** Elapsed time since launch */
  let elapsedMs = $state(0);
  let intervalId: ReturnType<typeof setInterval> | undefined;

  $effect(() => {
    if (runtime?.startedAt) {
      elapsedMs = Date.now() - runtime.startedAt;
      intervalId = setInterval(() => {
        elapsedMs = Date.now() - runtime!.startedAt;
      }, 1000);
    } else {
      elapsedMs = 0;
      if (intervalId) clearInterval(intervalId);
    }
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  });

  function formatElapsed(ms: number): string {
    const secs = Math.floor(ms / 1000);
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    return mins > 0 ? `${mins}:${s.toString().padStart(2, "0")}` : `${s}s`;
  }

  async function handleLaunchProfile(profileId: string) {
    try {
      await launchStore.launchProfile(repoId, profileId);
    } catch (e) {
      console.error("[LaunchBar] Launch failed:", e);
    }
  }

  async function handleQueueProfile(profileId: string) {
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return;
    await launchStore.queueAfterAgent(repoId, profileId, profile.name, sessionId);
  }

  async function handleStopAll() {
    try {
      await launchStore.stopAll(repoId);
    } catch (e) {
      console.error("[LaunchBar] Stop failed:", e);
    }
  }

  function handleCancelQueue() {
    launchStore.cancelQueue();
  }

  function handleProfileClick(e: MouseEvent, profileId: string) {
    if (e.shiftKey && isAgentRunning) {
      // Shift+click = queue after agent
      handleQueueProfile(profileId);
    } else {
      handleLaunchProfile(profileId);
    }
  }

  function handleContextMenu(e: MouseEvent, profileId: string) {
    e.preventDefault();
    if (contextMenuProfileId === profileId) {
      contextMenuProfileId = null;
    } else {
      contextMenuProfileId = profileId;
      const profile = profiles.find((p) => p.id === profileId);
      selectedCommandIds = new Set(profile?.command_ids ?? []);
    }
  }

  function toggleCommandInSelection(cmdId: string) {
    const newSet = new Set(selectedCommandIds);
    if (newSet.has(cmdId)) {
      newSet.delete(cmdId);
    } else {
      newSet.add(cmdId);
    }
    selectedCommandIds = newSet;
  }

  async function handleLaunchSubset() {
    const cmds = commands.filter((c) => selectedCommandIds.has(c.id));
    if (cmds.length === 0) return;
    try {
      await launchStore.launchCommands(repoId, repoPath, cmds);
    } catch (e) {
      console.error("[LaunchBar] Subset launch failed:", e);
    }
    contextMenuProfileId = null;
  }

  const isRunning = $derived(!!runtime);
  const isQueued = $derived(!!queued && queued.repoId === repoId);
</script>

{#if !collapsed}
  <div class="launch-bar">
    {#if isRunning && runtime}
      <!-- Running state -->
      <div class="launch-running">
        <span class="running-dot"></span>
        <span class="running-label">
          {runtime.profileName ?? "Custom"} running
        </span>
        <button class="stop-btn" onclick={handleStopAll} title="Stop all processes">
          <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
            <rect x="3" y="3" width="10" height="10" rx="1" />
          </svg>
          Stop All
        </button>
        <span class="elapsed">{formatElapsed(elapsedMs)}</span>
      </div>
    {:else if isQueued && queued}
      <!-- Queued state -->
      <div class="launch-queued">
        <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14" class="queue-icon">
          <path d="M8 3.5a.5.5 0 0 0-1 0V8a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 7.71V3.5z"/>
          <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0z"/>
        </svg>
        <span class="queued-label">
          "{queued.profileName}" queued after agent
        </span>
        <button class="cancel-btn" onclick={handleCancelQueue} title="Cancel queued launch">
          Cancel
        </button>
      </div>
    {:else}
      <!-- Idle state: show profile buttons -->
      <div class="launch-idle">
        <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14" class="launch-icon">
          <path d="M11.596 8.697l-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393z"/>
        </svg>
        {#each profiles as profile (profile.id)}
          <button
            class="profile-btn"
            onclick={(e) => handleProfileClick(e, profile.id)}
            oncontextmenu={(e) => handleContextMenu(e, profile.id)}
            title={isAgentRunning ? "Click to launch, Shift+click to queue after agent" : `Launch ${profile.name}`}
          >
            {profile.name}
            <span class="profile-count">{profile.command_ids.length}</span>
          </button>
        {/each}
      </div>
    {/if}

    <button
      class="collapse-toggle"
      onclick={() => (collapsed = true)}
      title="Hide launch bar"
    >
      <svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10">
        <path d="M4 8a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7A.5.5 0 0 1 4 8z"/>
      </svg>
    </button>
  </div>

  <!-- Context menu for subset command selection -->
  {#if contextMenuProfileId}
    <div class="context-overlay" onclick={() => (contextMenuProfileId = null)} role="presentation">
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="context-menu" onclick={(e) => e.stopPropagation()}>
        <div class="context-header">Select commands to launch</div>
        {#each commands as cmd (cmd.id)}
          <label class="context-item">
            <input
              type="checkbox"
              checked={selectedCommandIds.has(cmd.id)}
              onchange={() => toggleCommandInSelection(cmd.id)}
            />
            <span class="cmd-name">{cmd.name}</span>
            <span class="cmd-command">{cmd.command}</span>
          </label>
        {/each}
        <button class="context-launch-btn" onclick={handleLaunchSubset} disabled={selectedCommandIds.size === 0}>
          Launch Selected ({selectedCommandIds.size})
        </button>
      </div>
    </div>
  {/if}
{:else}
  <!-- Collapsed state: tiny expand button -->
  <button
    class="expand-toggle"
    onclick={() => (collapsed = false)}
    title="Show launch bar"
  >
    <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
      <path d="M11.596 8.697l-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393z"/>
    </svg>
  </button>
{/if}

<style>
  .launch-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 1rem;
    border-top: 1px solid var(--color-border);
    background: var(--color-surface);
    flex-shrink: 0;
    font-size: 0.8rem;
    min-height: 2rem;
  }

  .launch-idle,
  .launch-running,
  .launch-queued {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
  }

  .launch-icon,
  .queue-icon {
    color: var(--color-text-tertiary);
    flex-shrink: 0;
  }

  .profile-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
    font-size: 0.75rem;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    white-space: nowrap;
  }

  .profile-btn:hover {
    background: var(--color-accent);
    color: var(--color-text-on-accent, #fff);
    border-color: var(--color-accent);
  }

  .profile-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.1rem;
    height: 1.1rem;
    border-radius: 50%;
    background: var(--color-border);
    color: var(--color-text-tertiary);
    font-size: 0.65rem;
    font-weight: 600;
  }

  .profile-btn:hover .profile-count {
    background: rgba(255, 255, 255, 0.2);
    color: inherit;
  }

  /* Running state */
  .running-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #22c55e;
    flex-shrink: 0;
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .running-label {
    color: var(--color-text-secondary);
    font-weight: 500;
  }

  .stop-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: #ef4444;
    font-size: 0.7rem;
    cursor: pointer;
    transition: background 0.15s;
  }

  .stop-btn:hover {
    background: rgba(239, 68, 68, 0.1);
  }

  .elapsed {
    color: var(--color-text-tertiary);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    margin-left: auto;
  }

  /* Queued state */
  .queued-label {
    color: var(--color-text-secondary);
    font-style: italic;
  }

  .cancel-btn {
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: var(--color-text-tertiary);
    font-size: 0.7rem;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .cancel-btn:hover {
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
  }

  /* Collapse/expand */
  .collapse-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--color-text-tertiary);
    cursor: pointer;
    flex-shrink: 0;
    margin-left: auto;
  }

  .collapse-toggle:hover {
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
  }

  .expand-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-surface);
    color: var(--color-text-tertiary);
    cursor: pointer;
    position: absolute;
    bottom: 4.5rem;
    right: 1rem;
    z-index: 5;
    transition: background 0.15s, color 0.15s;
  }

  .expand-toggle:hover {
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
  }

  /* Context menu */
  .context-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
  }

  .context-menu {
    position: absolute;
    bottom: 3.5rem;
    left: 1rem;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 0.5rem;
    min-width: 280px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .context-header {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--color-text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.25rem 0.5rem;
  }

  .context-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.1s;
  }

  .context-item:hover {
    background: var(--color-surface);
  }

  .cmd-name {
    font-size: 0.8rem;
    color: var(--color-text-primary);
    font-weight: 500;
  }

  .cmd-command {
    font-size: 0.7rem;
    color: var(--color-text-tertiary);
    margin-left: auto;
    font-family: monospace;
  }

  .context-launch-btn {
    margin-top: 0.25rem;
    padding: 0.375rem 0.75rem;
    border: none;
    border-radius: 4px;
    background: var(--color-accent);
    color: var(--color-text-on-accent, #fff);
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.15s;
  }

  .context-launch-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .context-launch-btn:not(:disabled):hover {
    opacity: 0.9;
  }
</style>
