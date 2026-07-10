<script lang="ts">
  import type { LaunchCommand, LaunchProfile, LaunchRuntime, QueuedLaunch } from "$lib/types/launch";
  import { launchStore } from "$lib/stores/launchProfiles";
  import { ctrlHeld } from "$lib/stores/ctrlHint";

  interface Props {
    repoId: string;
    repoPath: string;
    repoBasePath: string;
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
    repoBasePath,
    profiles,
    commands,
    runtime,
    queued,
    isAgentRunning,
    sessionId,
  }: Props = $props();

  let commandsExpanded = $state(false);
  let contextMenuProfileId = $state<string | null>(null);
  let selectedCommandIds = $state<Set<string>>(new Set());
  let isStopping = $state(false);
  let isRestarting = $state(false);

  /** Elapsed time since launch */
  let elapsedMs = $state(0);
  let tickId: ReturnType<typeof setInterval> | undefined;
  let pollId: ReturnType<typeof setInterval> | undefined;

  $effect(() => {
    if (runtime?.startedAt) {
      elapsedMs = Date.now() - runtime.startedAt;
      tickId = setInterval(() => {
        elapsedMs = Date.now() - runtime!.startedAt;
      }, 1000);
      pollId = setInterval(() => {
        launchStore.refreshStatus(repoId);
      }, 2000);
    } else {
      elapsedMs = 0;
      if (tickId) clearInterval(tickId);
      if (pollId) clearInterval(pollId);
    }
    return () => {
      if (tickId) clearInterval(tickId);
      if (pollId) clearInterval(pollId);
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
      await launchStore.launchProfile(repoId, profileId, repoPath);
    } catch (e) {
      console.error("[LaunchBar] Launch failed:", e);
    }
  }

  async function handleQueueProfile(profileId: string) {
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return;
    await launchStore.queueAfterAgent(repoId, profileId, profile.name, sessionId, repoPath);
  }

  async function handleStopAll() {
    isStopping = true;
    try {
      await launchStore.stopAll(repoId);
    } catch (e) {
      console.error("[LaunchBar] Stop failed:", e);
    } finally {
      isStopping = false;
    }
  }

  async function handleRestart() {
    if (!runtime?.profileId) return;
    const profileId = runtime.profileId;
    const launchCwd = runtime.launchedFromCwd ?? repoPath;
    isRestarting = true;
    try {
      await launchStore.stopAll(repoId);
      await launchStore.launchProfile(repoId, profileId, launchCwd);
    } catch (e) {
      console.error("[LaunchBar] Restart failed:", e);
    } finally {
      isRestarting = false;
    }
  }

  function handleCancelQueue() {
    launchStore.cancelQueue();
  }

  async function handleStartNow() {
    if (!queued) return;
    const { repoId: qRepoId, profileId, launchedFromCwd } = queued;
    launchStore.cancelQueue();
    try {
      await launchStore.launchProfile(qRepoId, profileId, launchedFromCwd ?? repoPath);
    } catch (e) {
      console.error("[LaunchBar] Start now failed:", e);
    }
  }

  async function handleQueueRepoIdle(profileId: string) {
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return;
    await launchStore.queueUntilRepoIdle(repoId, profileId, profile.name, repoPath);
  }

  function handleProfileClick(e: MouseEvent, profileId: string) {
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+click = queue until EVERY session in this repo/worktree has finished
      // (launches immediately if the scope is already idle)
      handleQueueRepoIdle(profileId);
    } else if (isAgentRunning && !e.shiftKey) {
      // Agent running + normal click = queue after agent finishes
      handleQueueProfile(profileId);
    } else {
      // Agent idle (normal click) or force launch (Shift+click while running)
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
      await launchStore.launchCommands(repoId, repoPath, cmds, repoPath);
    } catch (e) {
      console.error("[LaunchBar] Subset launch failed:", e);
    }
    contextMenuProfileId = null;
  }

  async function handleLaunchCommand(command: LaunchCommand) {
    try {
      await launchStore.launchCommands(repoId, repoPath, [command], repoPath);
    } catch (e) {
      console.error("[LaunchBar] Command launch failed:", e);
    }
  }

  const isRunning = $derived(!!runtime);
  const isQueued = $derived(!!queued && queued.repoId === repoId);

  /** Worktree folder name to show when the launch was started from a worktree */
  const worktreeName = $derived((): string | null => {
    const from = runtime?.launchedFromCwd;
    if (!from || !repoBasePath || from === repoBasePath) return null;
    return from.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? null;
  });
</script>

<div class="launch-bar">
  <div class="launch-main-row">
    <button
      class:expanded={commandsExpanded}
      class="commands-toggle"
      onclick={() => (commandsExpanded = !commandsExpanded)}
      title={commandsExpanded ? "Hide individual launch commands" : "Show individual launch commands"}
      aria-expanded={commandsExpanded}
      aria-label={commandsExpanded ? "Hide individual launch commands" : "Show individual launch commands"}
    >
      <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
        <path fill-rule="evenodd" d="M5.22 2.97a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L8.94 8 5.22 4.28a.75.75 0 0 1 0-1.06z"/>
      </svg>
    </button>

    {#if isRunning && runtime}
      <!-- Running state -->
      <div class="launch-running">
        <span class="running-dot"></span>
        <span class="running-label">
          {runtime.profileName ?? "Custom"} running
        </span>
        {#if worktreeName()}
          <span class="worktree-badge" title={runtime.launchedFromCwd}>
            <svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10">
              <path fill-rule="evenodd" d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm0 2.122a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5v2.128a2.251 2.251 0 1 0 1.5 0V8.5h1.5a2.25 2.25 0 0 0 2.25-2.25v-.878a2.25 2.25 0 1 0-1.5 0v.878a.75.75 0 0 1-.75.75h-4.5A.75.75 0 0 1 5 6.25v-.878zm3.75 7.378a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm3-8.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0z"/>
            </svg>
            {worktreeName()}
          </span>
        {/if}
        <button class="stop-btn" onclick={handleStopAll} disabled={isStopping || isRestarting} title="Stop all processes">
          {#if isStopping}
            <svg class="spin" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
              <path d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5A.75.75 0 0 1 16 8a8 8 0 1 1-8-8 .75.75 0 0 1 0 1.5z"/>
            </svg>
            Stopping…
          {:else}
            <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
              <rect x="3" y="3" width="10" height="10" rx="1" />
            </svg>
            Stop All
          {/if}
        </button>
        {#if runtime.profileId}
          <button class="restart-btn" onclick={handleRestart} disabled={isStopping || isRestarting} title="Restart">
            {#if isRestarting}
              <svg class="spin" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
                <path d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5A.75.75 0 0 1 16 8a8 8 0 1 1-8-8 .75.75 0 0 1 0 1.5z"/>
              </svg>
              Restarting…
            {:else}
              <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
                <path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-11 2h3.932a.25.25 0 0 0 .192-.41L2.692 6.23a.25.25 0 0 0-.384 0L.342 8.59A.25.25 0 0 0 .534 9z"/>
                <path fill-rule="evenodd" d="M8 3c-1.552 0-2.94.707-3.857 1.818a.5.5 0 1 1-.771-.636A6.002 6.002 0 0 1 13.917 7H12.9A5.002 5.002 0 0 0 8 3zM3.1 9a5.002 5.002 0 0 0 8.757 2.182.5.5 0 1 1 .771.636A6.002 6.002 0 0 1 2.083 9H3.1z"/>
              </svg>
              Restart
            {/if}
          </button>
        {/if}
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
          "{queued.profileName}" {queued.mode === "repo_idle"
            ? "queued until repo is idle"
            : "queued after agent"}
        </span>
        <button class="start-now-btn" onclick={handleStartNow} title="Launch immediately without waiting">
          Start Now
        </button>
        <button class="cancel-btn" onclick={handleCancelQueue} title="Cancel queued launch">
          Cancel
        </button>
      </div>
    {:else}
      <!-- Idle state: show profile buttons -->
      <div class="launch-idle">
        {#each profiles as profile (profile.id)}
          <button
            class="profile-btn"
            onclick={(e) => handleProfileClick(e, profile.id)}
            oncontextmenu={(e) => handleContextMenu(e, profile.id)}
            title={(isAgentRunning
              ? "Click to queue after agent, Shift+click to launch now"
              : `Launch ${profile.name}`) + " — Ctrl+click: run when this repo/worktree is idle"}
          >
            {profile.name}
            <span class="profile-count">{profile.command_ids.length}</span>
            {#if $ctrlHeld}
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

  {#if commandsExpanded}
    <div class="launch-commands-row">
      {#each commands as command (command.id)}
        <button
          class="command-btn"
          onclick={() => handleLaunchCommand(command)}
          title={command.command}
        >
          <span class="command-name">{command.name}</span>
          <span class="command-shell">{command.command}</span>
        </button>
      {/each}
    </div>
  {/if}
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

<style>
  .launch-bar {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.5rem;
    padding: 0.375rem 1rem;
    border-top: 1px solid var(--color-border);
    background: var(--color-surface);
    flex-shrink: 0;
    font-size: 0.8rem;
    min-height: 2rem;
  }

  .launch-main-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    min-width: 0;
  }

  .launch-idle,
  .launch-running,
  .launch-queued {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    flex: 1;
    min-width: 0;
  }

  .queue-icon {
    color: var(--color-text-tertiary);
    flex-shrink: 0;
  }

  .commands-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-surface-elevated);
    color: var(--color-text-tertiary);
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s, color 0.15s, transform 0.15s;
  }

  .commands-toggle:hover {
    background: var(--color-surface);
    color: var(--color-text-secondary);
  }

  .commands-toggle.expanded svg {
    transform: rotate(90deg);
  }

  .profile-btn {
    position: relative;
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

  /* Ctrl-held hint: Ctrl+click queues the launch until the repo/worktree is idle */
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

  .worktree-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    color: var(--color-text-tertiary);
    font-size: 0.68rem;
    white-space: nowrap;
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

  .stop-btn:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.1);
  }

  .stop-btn:disabled,
  .restart-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .restart-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: var(--color-text-tertiary);
    font-size: 0.7rem;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .restart-btn:hover:not(:disabled) {
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
  }

  .spin {
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .elapsed {
    color: var(--color-text-tertiary);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    margin-left: auto;
  }

  .launch-commands-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding-left: 2rem;
  }

  .command-btn {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
    min-width: 0;
    max-width: 100%;
    padding: 0.45rem 0.65rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }

  .command-btn:hover {
    background: var(--color-surface);
    border-color: var(--color-accent);
    color: var(--color-text-primary);
  }

  .command-name {
    font-size: 0.72rem;
    font-weight: 600;
  }

  .command-shell {
    max-width: 100%;
    color: var(--color-text-tertiary);
    font-family: monospace;
    font-size: 0.68rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Queued state */
  .queued-label {
    color: var(--color-text-secondary);
    font-style: italic;
  }

  .start-now-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: var(--color-accent);
    font-size: 0.7rem;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .start-now-btn:hover {
    background: var(--color-accent);
    color: var(--color-text-on-accent, #fff);
    border-color: var(--color-accent);
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
