<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import RepoIcon from '$lib/components/RepoIcon.svelte';
  import LaunchBar from '$lib/components/sdk/LaunchBar.svelte';
  import { getWorktreeLabel, type WorktreeInfo } from '$lib/components/session-setup/sessionSetupHelpers';
  import { launchStore, queuedLaunch } from '$lib/stores/launchProfiles';
  import { navigation } from '$lib/stores/navigation';
  import { repos, type RepoConfig } from '$lib/stores/repos';
  import { settings, isNoteModeAvailable } from '$lib/stores/settings';
  import type { LaunchCommand, LaunchProfile } from '$lib/types/launch';
  import { REPO_ICON_NAMES, getDefaultRepoColor } from '$lib/utils/repoIcons';

  interface Props {
    repoId?: string | null;
    showAddForm?: boolean;
  }

  interface RepoDescriptionResult {
    description: string;
    keywords: string[];
    vocabulary: string[];
    icon?: string;
    color?: string;
  }

  interface LaunchGenerationResult {
    commands: Array<{ name: string; command: string; working_dir?: string }>;
    profiles: Array<{ name: string; command_names: string[] }>;
  }

  let { repoId = null, showAddForm = false }: Props = $props();

  let newRepoPath = $state('');
  let newRepoName = $state('');
  let worktreeMode = $state<'main' | 'existing'>('main');
  let selectedWorktreePath = $state('');
  let worktrees = $state<WorktreeInfo[]>([]);
  let isLoadingWorktrees = $state(false);
  let claudeAvailable = $state(false);
  let codexAvailable = $state(false);
  // Track generation per-repo-id so exploring one repo doesn't lock the others.
  let generatingClaudeRepos = $state<Set<string>>(new Set());
  let generatingCodexRepos = $state<Set<string>>(new Set());
  let scanningLaunch = $state(false);
  let generatingLaunchClaudeRepos = $state<Set<string>>(new Set());
  let generatingLaunchCodexRepos = $state<Set<string>>(new Set());
  let newCmdName = $state('');
  let newCmdCommand = $state('');
  let newCmdWorkingDir = $state('');
  let newProfileName = $state('');
  let newProfileCmdIds = $state<Set<string>>(new Set());
  let lastRepoModeSyncKey = $state('');

  const noteModeAvailable = $derived(isNoteModeAvailable());
  const selectedRepo = $derived(repoId ? $repos.list.find((repo) => repo.id === repoId) ?? null : null);
  const selectedRepoIndex = $derived(selectedRepo ? $repos.list.findIndex((repo) => repo.id === selectedRepo.id) : -1);
  const generatingClaude = $derived(!!repoId && generatingClaudeRepos.has(repoId));
  const generatingCodex = $derived(!!repoId && generatingCodexRepos.has(repoId));
  const generatingLaunchClaude = $derived(!!repoId && generatingLaunchClaudeRepos.has(repoId));
  const generatingLaunchCodex = $derived(!!repoId && generatingLaunchCodexRepos.has(repoId));
  const launchCwd = $derived(
    selectedRepo
      ? worktreeMode === 'existing' && selectedWorktreePath
        ? selectedWorktreePath
        : selectedRepo.path
      : ''
  );
  const selectedWorktree = $derived(worktrees.find((worktree) => worktree.path === selectedWorktreePath) ?? null);
  const enabledMcpServers = $derived(($settings.mcp?.servers ?? []).filter((server) => server.enabled));

  onMount(async () => {
    try {
      claudeAvailable = (await invoke<{ authenticated: boolean }>('check_claude_auth')).authenticated;
    } catch {
      claudeAvailable = false;
    }

    try {
      const codexAuth = await invoke<{ authenticated: boolean }>('check_openai_codex_auth');
      const hasApiKey = await invoke<boolean>('has_openai_api_key');
      codexAvailable = codexAuth.authenticated || hasApiKey;
    } catch {
      codexAvailable = false;
    }
  });

  $effect(() => {
    const syncKey = selectedRepo ? `${selectedRepo.id}:${selectedRepo.worktree_mode ?? 'main'}` : 'none';
    if (syncKey === lastRepoModeSyncKey) return;

    lastRepoModeSyncKey = syncKey;
    worktreeMode = selectedRepo?.worktree_mode === 'existing' ? 'existing' : 'main';
    selectedWorktreePath = '';
  });

  $effect(() => {
    if (selectedRepo && worktreeMode === 'existing') {
      void loadWorktrees(selectedRepo.path);
    } else {
      worktrees = [];
      selectedWorktreePath = '';
    }
  });

  function updateRepo(updates: Partial<RepoConfig>) {
    if (selectedRepoIndex < 0) return;
    void repos.updateRepo(selectedRepoIndex, updates);
  }

  /** Update a repo by id, regardless of which repo is currently selected. */
  function updateRepoById(id: string, updates: Partial<RepoConfig>) {
    const index = $repos.list.findIndex((repo) => repo.id === id);
    if (index < 0) return;
    void repos.updateRepo(index, updates);
  }

  function setRepoGenerating(provider: 'claude' | 'codex', id: string, active: boolean) {
    const target = provider === 'claude' ? generatingClaudeRepos : generatingCodexRepos;
    const next = new Set(target);
    if (active) next.add(id);
    else next.delete(id);
    if (provider === 'claude') generatingClaudeRepos = next;
    else generatingCodexRepos = next;
  }

  function setRepoGeneratingLaunch(provider: 'claude' | 'codex', id: string, active: boolean) {
    const target = provider === 'claude' ? generatingLaunchClaudeRepos : generatingLaunchCodexRepos;
    const next = new Set(target);
    if (active) next.add(id);
    else next.delete(id);
    if (provider === 'claude') generatingLaunchClaudeRepos = next;
    else generatingLaunchCodexRepos = next;
  }

  function replaceRepo(mutator: (repo: RepoConfig) => RepoConfig) {
    if (!selectedRepo || selectedRepoIndex < 0) return;
    const updated = [...$repos.list];
    updated[selectedRepoIndex] = mutator(selectedRepo);
    void repos.updateList(updated);
  }

  function handleWorktreeModeChange(mode: 'main' | 'existing') {
    worktreeMode = mode;
    selectedWorktreePath = '';
    if (selectedRepo) {
      updateRepo({ worktree_mode: mode });
    }
  }

  async function browseFolder() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      newRepoPath = selected as string;
      if (!newRepoName) {
        newRepoName = newRepoPath.split(/[/\\]/).pop() || '';
      }
    }
  }

  async function addRepo() {
    const path = newRepoPath.trim();
    const name = newRepoName.trim();
    if (!path || !name) return;

    await repos.addRepo(path, name);
    const createdRepo = $repos.list.find((repo) => repo.path === path && repo.name === name);
    newRepoPath = '';
    newRepoName = '';
    navigation.showRepository(createdRepo?.id ?? null);
  }

  async function removeSelectedRepo() {
    if (selectedRepoIndex < 0) return;
    const nextRepo = $repos.list[selectedRepoIndex + 1] ?? $repos.list[selectedRepoIndex - 1] ?? null;
    await repos.removeRepo(selectedRepoIndex);
    if (nextRepo?.id) navigation.showRepository(nextRepo.id);
    else navigation.showRepositoryAdd();
  }

  async function loadWorktrees(repoPath: string) {
    isLoadingWorktrees = true;
    try {
      const listed = await invoke<WorktreeInfo[]>('list_git_worktrees', { repoPath });
      worktrees = listed.filter((worktree) => !worktree.is_main);
      if (!worktrees.some((worktree) => worktree.path === selectedWorktreePath)) {
        selectedWorktreePath = '';
      }
    } catch {
      worktrees = [];
    } finally {
      isLoadingWorktrees = false;
    }
  }

  async function setupDescriptionListeners(
    requestId: string,
    provider: 'claude' | 'codex',
    targetRepoId: string
  ) {
    const resultListener = await listen<RepoDescriptionResult>(`repo-description-result-${requestId}`, (event) => {
      const targetRepo = $repos.list.find((repo) => repo.id === targetRepoId) ?? null;
      updateRepoById(targetRepoId, {
        description: event.payload.description,
        keywords: event.payload.keywords,
        vocabulary: event.payload.vocabulary,
        icon: event.payload.icon || targetRepo?.icon,
        color: event.payload.color || targetRepo?.color,
      });
      setRepoGenerating(provider, targetRepoId, false);
      resultListener();
      errorListener();
    });

    const errorListener = await listen<string>(`repo-description-error-${requestId}`, () => {
      setRepoGenerating(provider, targetRepoId, false);
      resultListener();
      errorListener();
    });
  }

  async function generateDescription(provider: 'claude' | 'codex') {
    if (!selectedRepo?.id) return;
    const targetRepoId = selectedRepo.id;
    const requestId = `${provider}-repo-${targetRepoId}-${Date.now()}`;
    setRepoGenerating(provider, targetRepoId, true);
    await setupDescriptionListeners(requestId, provider, targetRepoId);

    try {
      await invoke(
        provider === 'claude'
          ? 'generate_repo_description_with_claude'
          : 'generate_repo_description_with_codex',
        {
          id: requestId,
          repoPath: selectedRepo.path,
          repoName: selectedRepo.name,
        }
      );
    } catch {
      setRepoGenerating(provider, targetRepoId, false);
    }
  }

  function applyLaunchProfileResult(payload: LaunchGenerationResult, targetRepoId: string) {
    const commands: LaunchCommand[] = payload.commands.map((command) => ({
      id: crypto.randomUUID(),
      name: command.name,
      command: command.command,
      working_dir: command.working_dir,
      auto_detected: true,
    }));

    const profiles: LaunchProfile[] = payload.profiles.map((profile) => ({
      id: crypto.randomUUID(),
      name: profile.name,
      command_ids: profile.command_names
        .map((name) => commands.find((command) => command.name === name)?.id)
        .filter((id): id is string => !!id),
    }));

    updateRepoById(targetRepoId, { launch_commands: commands, launch_profiles: profiles });
  }

  async function generateLaunch(provider: 'claude' | 'codex') {
    if (!selectedRepo?.id) return;
    const targetRepoId = selectedRepo.id;
    const requestId = `${provider}-launch-${targetRepoId}-${Date.now()}`;
    setRepoGeneratingLaunch(provider, targetRepoId, true);

    const resultListener = await listen<LaunchGenerationResult>(`launch-profile-result-${requestId}`, (event) => {
      applyLaunchProfileResult(event.payload, targetRepoId);
      setRepoGeneratingLaunch(provider, targetRepoId, false);
      resultListener();
      errorListener();
    });

    const errorListener = await listen<string>(`launch-profile-error-${requestId}`, () => {
      setRepoGeneratingLaunch(provider, targetRepoId, false);
      resultListener();
      errorListener();
    });

    try {
      await invoke(
        provider === 'claude' ? 'generate_launch_profile_with_claude' : 'generate_launch_profile_with_codex',
        {
          id: requestId,
          repoPath: selectedRepo.path,
          repoName: selectedRepo.name,
        }
      );
    } catch {
      setRepoGeneratingLaunch(provider, targetRepoId, false);
    }
  }

  async function scanRepoCommands() {
    if (!selectedRepo) return;
    scanningLaunch = true;
    try {
      const detected = await invoke<LaunchCommand[]>('scan_repo_launch_commands', { repoPath: selectedRepo.path });
      const manual = (selectedRepo.launch_commands ?? []).filter((command) => !command.auto_detected);
      updateRepo({ launch_commands: [...manual, ...detected] });
    } finally {
      scanningLaunch = false;
    }
  }

  function addLaunchCommand() {
    if (!selectedRepo || !newCmdName.trim() || !newCmdCommand.trim()) return;
    const nextCommand: LaunchCommand = {
      id: crypto.randomUUID(),
      name: newCmdName.trim(),
      command: newCmdCommand.trim(),
      working_dir: newCmdWorkingDir.trim() || undefined,
      auto_detected: false,
    };

    updateRepo({ launch_commands: [...(selectedRepo.launch_commands ?? []), nextCommand] });
    newCmdName = '';
    newCmdCommand = '';
    newCmdWorkingDir = '';
  }

  function removeLaunchCommand(commandId: string) {
    if (!selectedRepo) return;
    updateRepo({
      launch_commands: (selectedRepo.launch_commands ?? []).filter((command) => command.id !== commandId),
      launch_profiles: (selectedRepo.launch_profiles ?? []).map((profile) => ({
        ...profile,
        command_ids: profile.command_ids.filter((id) => id !== commandId),
      })),
    });
  }

  function toggleProfileCommand(commandId: string) {
    const next = new Set(newProfileCmdIds);
    if (next.has(commandId)) next.delete(commandId);
    else next.add(commandId);
    newProfileCmdIds = next;
  }

  function addLaunchProfile() {
    if (!selectedRepo || !newProfileName.trim() || newProfileCmdIds.size === 0) return;
    const nextProfile: LaunchProfile = {
      id: crypto.randomUUID(),
      name: newProfileName.trim(),
      command_ids: [...newProfileCmdIds],
    };

    updateRepo({ launch_profiles: [...(selectedRepo.launch_profiles ?? []), nextProfile] });
    newProfileName = '';
    newProfileCmdIds = new Set();
  }

  function removeLaunchProfile(profileId: string) {
    if (!selectedRepo) return;
    updateRepo({
      launch_profiles: (selectedRepo.launch_profiles ?? []).filter((profile) => profile.id !== profileId),
    });
  }

  function addTagFromInput(event: KeyboardEvent) {
    if (event.key !== 'Enter' || !selectedRepo) return;
    const input = event.currentTarget as HTMLInputElement;
    const value = input.value.trim().toLowerCase();
    if (!value) return;

    if (!(selectedRepo.tags || []).includes(value)) {
      updateRepo({ tags: [...(selectedRepo.tags || []), value] });
    }
    input.value = '';
  }

  function toggleMcpServer(serverId: string, noteMode: boolean) {
    if (!selectedRepo) return;
    const current = noteMode ? selectedRepo.note_mcp_servers || [] : selectedRepo.mcp_servers || [];
    const enabled = current.includes(serverId);
    if (noteMode) {
      updateRepo({
        note_mcp_servers: enabled ? current.filter((id) => id !== serverId) : [...current, serverId],
      });
      return;
    }

    updateRepo({
      mcp_servers: enabled ? current.filter((id) => id !== serverId) : [...current, serverId],
    });
  }
</script>

{#if showAddForm || (!$repos.list.length && !selectedRepo)}
  <div class="repo-page">
    <section class="card card-form add-card">
      <div class="section-header">
        <div>
          <h2>Add Repository</h2>
          <p>Repositories live here now. Add one to configure launch profiles, worktrees, and repo-specific settings.</p>
        </div>
      </div>

      <div class="field">
        <label for="repo-path">Path</label>
        <div class="inline-field">
          <input id="repo-path" bind:value={newRepoPath} placeholder="Path to repository" />
          <button class="btn btn-secondary" onclick={browseFolder}>Browse</button>
        </div>
      </div>

      <div class="field">
        <label for="repo-name">Name</label>
        <input id="repo-name" bind:value={newRepoName} placeholder="Display name" />
      </div>

      <div class="button-row">
        <button class="btn btn-primary" onclick={addRepo} disabled={!newRepoPath.trim() || !newRepoName.trim()}>
          Add Repository
        </button>
      </div>
    </section>
  </div>
{:else if selectedRepo}
  <div class="repo-page">
    <section class="card hero-card">
      <div class="section-header section-header-top">
        <div class="hero-meta">
          <div class="hero-icon">
            <RepoIcon repo={selectedRepo} size="lg" />
          </div>
          <div class="hero-copy">
            <div class="eyebrow-row">
              <span class="eyebrow">Repository</span>
              {#if selectedRepo.active === false}
                <span class="status-pill status-pill-muted">Inactive</span>
              {:else}
                <span class="status-pill">Active</span>
              {/if}
            </div>
            <h2>{selectedRepo.name}</h2>
            <p class="hero-path" title={selectedRepo.path}>{selectedRepo.path}</p>
          </div>
        </div>

        <div class="button-row">
          <button class="btn btn-secondary" onclick={() => repos.setRepoActive(selectedRepoIndex, selectedRepo.active === false)}>
            {selectedRepo.active === false ? 'Mark Active' : 'Mark Inactive'}
          </button>
          <button class="btn btn-danger" onclick={removeSelectedRepo}>Remove</button>
        </div>
      </div>

      {#if selectedRepo.description}
        <p class="hero-description">{selectedRepo.description}</p>
      {:else}
        <p class="hero-description hero-description-empty">
          No repository summary yet. Generate one to populate description, keywords, icon, and vocabulary.
        </p>
      {/if}

      <div class="button-row">
        {#if claudeAvailable}
          <button class="btn btn-secondary" onclick={() => generateDescription('claude')} disabled={generatingClaude || generatingCodex}>
            {generatingClaude ? 'Exploring with Claude...' : 'Explore with Claude'}
          </button>
        {/if}
        {#if codexAvailable}
          <button class="btn btn-secondary" onclick={() => generateDescription('codex')} disabled={generatingClaude || generatingCodex}>
            {generatingCodex ? 'Exploring with Codex...' : 'Explore with Codex'}
          </button>
        {/if}
      </div>

      {#if selectedRepo.keywords?.length || selectedRepo.vocabulary?.length}
        <div class="detail-grid">
          {#if selectedRepo.keywords?.length}
            <div class="detail-block">
              <div class="detail-label">Keywords</div>
              <div class="chip-list">
                {#each selectedRepo.keywords as keyword}
                  <span class="chip">{keyword}</span>
                {/each}
              </div>
            </div>
          {/if}

          {#if selectedRepo.vocabulary?.length}
            <div class="detail-block">
              <div class="detail-label">Vocabulary</div>
              <div class="chip-list">
                {#each selectedRepo.vocabulary as word}
                  <span class="chip chip-soft">{word}</span>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </section>

    <section class="card">
      <div class="section-header">
        <div>
          <h3>Launch Workspace</h3>
          <p>Pick the repo root or an existing worktree, then launch a saved profile in that directory.</p>
        </div>
      </div>

      <div class="toolbar-row">
        <div class="segmented-control" role="tablist" aria-label="Worktree mode">
          <button class="segment-btn" class:is-selected={worktreeMode === 'main'} onclick={() => handleWorktreeModeChange('main')}>
            Main Repo
          </button>
          <button class="segment-btn" class:is-selected={worktreeMode === 'existing'} onclick={() => handleWorktreeModeChange('existing')}>
            Existing Worktree
          </button>
        </div>

        {#if worktreeMode === 'existing'}
          <button class="btn btn-secondary" onclick={() => loadWorktrees(selectedRepo.path)} disabled={isLoadingWorktrees}>
            {isLoadingWorktrees ? 'Refreshing...' : 'Refresh Worktrees'}
          </button>
        {/if}
      </div>

      {#if worktreeMode === 'existing'}
        <div class="field">
          <label for="worktree-select">Worktree</label>
          <select id="worktree-select" bind:value={selectedWorktreePath} disabled={isLoadingWorktrees || worktrees.length === 0}>
            <option value="">
              {isLoadingWorktrees
                ? 'Loading worktrees...'
                : worktrees.length === 0
                  ? 'No worktrees found'
                  : 'Select worktree'}
            </option>
            {#each worktrees as worktree}
              <option value={worktree.path}>{getWorktreeLabel(worktree)}</option>
            {/each}
          </select>
          {#if selectedWorktree}
            <p class="field-help">{selectedWorktree.path}</p>
          {/if}
        </div>
      {/if}

      <div class="launch-shell">
        {#if selectedRepo.launch_profiles?.length}
          <LaunchBar
            repoId={selectedRepo.id ?? ''}
            repoPath={launchCwd}
            repoBasePath={selectedRepo.path}
            profiles={selectedRepo.launch_profiles ?? []}
            commands={selectedRepo.launch_commands ?? []}
            runtime={$launchStore.runtimes[selectedRepo.id ?? ''] ?? null}
            queued={$queuedLaunch?.repoId === selectedRepo.id ? $queuedLaunch : null}
            isAgentRunning={false}
            sessionId=""
          />
        {:else}
          <div class="empty-state">
            <div class="empty-title">No launch profiles yet</div>
            <p>Create commands and profiles below, then they will appear here for one-click launch.</p>
          </div>
        {/if}
      </div>
    </section>

    <section class="card">
      <div class="section-header">
        <div>
          <h3>Repository Settings</h3>
          <p>These replace the old repository settings page.</p>
        </div>
      </div>

      <div class="settings-grid">
        <div class="field">
          <label for="repo-icon">Icon</label>
          <select id="repo-icon" value={selectedRepo.icon || 'code'} onchange={(event) => updateRepo({ icon: (event.currentTarget as HTMLSelectElement).value })}>
            {#each REPO_ICON_NAMES as iconName}
              <option value={iconName}>{iconName}</option>
            {/each}
          </select>
        </div>

        <div class="field">
          <label for="repo-color">Color</label>
          <div class="inline-field">
            <input
              id="repo-color"
              class="color-input"
              type="color"
              value={selectedRepo.color || getDefaultRepoColor(selectedRepo.path)}
              onchange={(event) => updateRepo({ color: (event.currentTarget as HTMLInputElement).value })}
            />
            <button class="btn btn-secondary" onclick={() => updateRepo({ color: undefined })}>Reset</button>
          </div>
        </div>
      </div>

      {#if enabledMcpServers.length > 0}
        <div class="field">
          <div class="field-title">MCP Servers</div>
          <div class="chip-list">
            {#each enabledMcpServers as server}
              {@const enabled = selectedRepo.mcp_servers?.includes(server.id)}
              <button class="chip-button" class:is-selected={enabled} onclick={() => toggleMcpServer(server.id, false)}>
                {server.name}
              </button>
            {/each}
          </div>
        </div>

        {#if noteModeAvailable}
          <div class="field">
            <div class="field-title">Note Mode MCP Servers</div>
            <div class="chip-list">
              {#each enabledMcpServers as server}
                {@const enabled = selectedRepo.note_mcp_servers?.includes(server.id)}
                <button class="chip-button" class:is-selected={enabled} onclick={() => toggleMcpServer(server.id, true)}>
                  {server.name}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      {/if}

      <div class="field">
        <label for="repo-tag-input">Tags</label>
        <div class="chip-list chip-list-wrap">
          {#each selectedRepo.tags || [] as tag}
            <span class="chip chip-editable">
              {tag}
              <button class="chip-remove" onclick={() => updateRepo({ tags: (selectedRepo.tags || []).filter((currentTag) => currentTag !== tag) })} aria-label={`Remove ${tag}`}>
                <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
                </svg>
              </button>
            </span>
          {/each}
          <input id="repo-tag-input" class="tag-input" placeholder="Add tag and press Enter" onkeydown={addTagFromInput} />
        </div>
      </div>
    </section>

    <section class="card">
      <div class="section-header section-header-top">
        <div>
          <h3>Launch Profiles</h3>
          <p>Manage commands and reusable launch groups for this repository.</p>
        </div>
        <div class="button-row">
          <button class="btn btn-secondary" onclick={scanRepoCommands} disabled={scanningLaunch}>
            {scanningLaunch ? 'Scanning...' : 'Scan Repo'}
          </button>
          {#if claudeAvailable}
            <button class="btn btn-secondary" onclick={() => generateLaunch('claude')} disabled={generatingLaunchClaude || generatingLaunchCodex}>
              {generatingLaunchClaude ? 'Claude...' : 'Generate with Claude'}
            </button>
          {/if}
          {#if codexAvailable}
            <button class="btn btn-secondary" onclick={() => generateLaunch('codex')} disabled={generatingLaunchClaude || generatingLaunchCodex}>
              {generatingLaunchCodex ? 'Codex...' : 'Generate with Codex'}
            </button>
          {/if}
        </div>
      </div>

      <div class="two-column-layout">
        <div class="subsection">
          <div class="subsection-title">Commands</div>
          {#if selectedRepo.launch_commands?.length}
            <div class="list">
              {#each selectedRepo.launch_commands as command (command.id)}
                <div class="list-row">
                  <div class="list-copy">
                    <div class="list-title-row">
                      <strong>{command.name}</strong>
                      {#if command.auto_detected}
                        <span class="status-pill status-pill-muted">Auto</span>
                      {/if}
                    </div>
                    <div class="list-code">{command.command}</div>
                    {#if command.working_dir}
                      <div class="list-meta">Working dir: {command.working_dir}</div>
                    {/if}
                  </div>
                  <button class="icon-btn" onclick={() => removeLaunchCommand(command.id)} aria-label={`Remove ${command.name}`}>
                    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
                    </svg>
                  </button>
                </div>
              {/each}
            </div>
          {:else}
            <div class="empty-inline">No commands configured yet.</div>
          {/if}

          <div class="editor-grid">
            <input bind:value={newCmdName} placeholder="Command name" />
            <input bind:value={newCmdCommand} placeholder="npm run dev" />
            <input bind:value={newCmdWorkingDir} placeholder="Optional subdir" />
          </div>
          <button class="btn btn-primary" onclick={addLaunchCommand} disabled={!newCmdName.trim() || !newCmdCommand.trim()}>
            Add Command
          </button>
        </div>

        <div class="subsection">
          <div class="subsection-title">Profiles</div>
          {#if selectedRepo.launch_profiles?.length}
            <div class="list">
              {#each selectedRepo.launch_profiles as profile (profile.id)}
                <div class="list-row">
                  <div class="list-copy">
                    <div class="list-title-row">
                      <strong>{profile.name}</strong>
                      <span class="status-pill status-pill-muted">{profile.command_ids.length} cmds</span>
                    </div>
                    <div class="list-meta">
                      {profile.command_ids
                        .map((id) => selectedRepo.launch_commands?.find((command) => command.id === id)?.name)
                        .filter(Boolean)
                        .join(', ')}
                    </div>
                  </div>
                  <button class="icon-btn" onclick={() => removeLaunchProfile(profile.id)} aria-label={`Remove ${profile.name}`}>
                    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
                    </svg>
                  </button>
                </div>
              {/each}
            </div>
          {:else}
            <div class="empty-inline">No profiles configured yet.</div>
          {/if}

          {#if selectedRepo.launch_commands?.length}
            <div class="field">
              <label for="profile-name">Profile Name</label>
              <input id="profile-name" bind:value={newProfileName} placeholder="Full Stack" />
            </div>
            <div class="chip-list">
              {#each selectedRepo.launch_commands as command (command.id)}
                <label class="checkbox-chip">
                  <input type="checkbox" checked={newProfileCmdIds.has(command.id)} onchange={() => toggleProfileCommand(command.id)} />
                  <span>{command.name}</span>
                </label>
              {/each}
            </div>
            <button class="btn btn-primary" onclick={addLaunchProfile} disabled={!newProfileName.trim() || newProfileCmdIds.size === 0}>
              Add Profile
            </button>
          {/if}
        </div>
      </div>
    </section>

    <section class="card">
      <div class="section-header">
        <div>
          <h3>Worktree Setup</h3>
          <p>Used when the app creates worktrees from this repository elsewhere in the app.</p>
        </div>
      </div>

      <div class="field">
        <label for="base-branch">Base Branch</label>
        <input
          id="base-branch"
          value={selectedRepo.worktree_base_branch || ''}
          placeholder="Auto-detect (for example origin/main)"
          onchange={(event) => updateRepo({ worktree_base_branch: (event.currentTarget as HTMLInputElement).value.trim() || undefined })}
        />
      </div>

      <div class="two-column-layout">
        <div class="subsection">
          <div class="subsection-title with-action">
            <span>Copy Files</span>
            <button class="btn btn-secondary btn-small" onclick={() => replaceRepo((repo) => ({ ...repo, worktree_copy_files: [...(repo.worktree_copy_files || []), ''] }))}>
              Add
            </button>
          </div>

          {#if selectedRepo.worktree_copy_files?.length}
            <div class="list">
              {#each selectedRepo.worktree_copy_files ?? [] as filePath, fileIndex}
                <div class="list-row list-row-inline">
                  <input
                    value={filePath}
                    onchange={(event) => replaceRepo((repo) => {
                      const nextFiles = [...(repo.worktree_copy_files || [])];
                      nextFiles[fileIndex] = (event.currentTarget as HTMLInputElement).value;
                      return { ...repo, worktree_copy_files: nextFiles };
                    })}
                  />
                  <button class="icon-btn" onclick={() => replaceRepo((repo) => {
                    const nextFiles = [...(repo.worktree_copy_files || [])];
                    nextFiles.splice(fileIndex, 1);
                    return { ...repo, worktree_copy_files: nextFiles };
                  })} aria-label="Remove file">
                    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
                    </svg>
                  </button>
                </div>
              {/each}
            </div>
          {:else}
            <div class="empty-inline">No files configured.</div>
          {/if}
        </div>

        <div class="subsection">
          <div class="subsection-title with-action">
            <span>Post-Create Commands</span>
            <button class="btn btn-secondary btn-small" onclick={() => replaceRepo((repo) => ({ ...repo, worktree_post_create_commands: [...(repo.worktree_post_create_commands || []), ''] }))}>
              Add
            </button>
          </div>

          {#if selectedRepo.worktree_post_create_commands?.length}
            <div class="list">
              {#each selectedRepo.worktree_post_create_commands ?? [] as command, commandIndex}
                <div class="list-row list-row-inline">
                  <input
                    value={command}
                    onchange={(event) => replaceRepo((repo) => {
                      const nextCommands = [...(repo.worktree_post_create_commands || [])];
                      nextCommands[commandIndex] = (event.currentTarget as HTMLInputElement).value;
                      return { ...repo, worktree_post_create_commands: nextCommands };
                    })}
                  />
                  <button class="icon-btn" onclick={() => replaceRepo((repo) => {
                    const nextCommands = [...(repo.worktree_post_create_commands || [])];
                    nextCommands.splice(commandIndex, 1);
                    return { ...repo, worktree_post_create_commands: nextCommands };
                  })} aria-label="Remove command">
                    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
                    </svg>
                  </button>
                </div>
              {/each}
            </div>
          {:else}
            <div class="empty-inline">No commands configured.</div>
          {/if}
        </div>
      </div>
    </section>
  </div>
{:else}
  <div class="repo-page">
    <section class="card empty-card">
      <div class="section-header">
        <div>
          <h2>Select a Repository</h2>
          <p>Choose a repository from the rail or add a new one.</p>
        </div>
      </div>
      <div class="button-row">
        <button class="btn btn-primary" onclick={() => navigation.showRepositoryAdd()}>Add Repository</button>
      </div>
    </section>
  </div>
{/if}

<style>
  .repo-page {
    height: 100%;
    overflow-y: auto;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    background: var(--color-background);
    font-size: 0.8125rem;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem;
    border: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
    border-radius: 0.375rem;
    background: var(--color-surface-elevated);
  }

  .hero-card {
    background: var(--color-surface-elevated);
  }

  .add-card,
  .empty-card {
    max-width: 46rem;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .section-header-top {
    align-items: center;
  }

  .section-header h2,
  .section-header h3 {
    margin: 0;
    color: var(--color-text-primary);
    font-size: 0.95rem;
    font-weight: 600;
  }

  .section-header p,
  .field-help,
  .hero-description,
  .hero-path,
  .empty-state p,
  .empty-inline,
  .list-meta {
    margin: 0;
    color: var(--color-text-muted);
    font-size: 0.75rem;
    line-height: 1.4;
  }

  .hero-meta {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    min-width: 0;
  }

  .hero-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 0.5rem;
    background: var(--color-background);
    border: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
    flex-shrink: 0;
  }

  .hero-copy {
    min-width: 0;
  }

  .hero-copy h2 {
    margin: 0.1rem 0 0;
    font-size: 0.95rem;
    font-weight: 600;
  }

  .hero-path {
    font-size: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hero-description {
    line-height: 1.45;
    color: var(--color-text-secondary);
  }

  .hero-description-empty {
    font-style: italic;
  }

  .eyebrow-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .eyebrow {
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-text-muted);
  }

  .toolbar-row,
  .button-row,
  .chip-list,
  .detail-grid {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .toolbar-row {
    justify-content: space-between;
    align-items: center;
  }

  .detail-grid {
    gap: 0.75rem;
  }

  .detail-block {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    min-width: 14rem;
    flex: 1;
  }

  .detail-label,
  .subsection-title {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text-secondary);
  }

  .subsection-title.with-action {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }

  .settings-grid,
  .editor-grid,
  .two-column-layout {
    display: grid;
    gap: 0.5rem;
  }

  .settings-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .editor-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .two-column-layout {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .subsection {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .field label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text-secondary);
  }

  .field-title {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text-secondary);
  }

  .inline-field {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  input,
  select {
    width: 100%;
    min-width: 0;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--color-border);
    border-radius: 0.375rem;
    background: var(--color-background);
    color: var(--color-text-primary);
    font-size: 0.75rem;
    transition: border-color 0.16s ease, background 0.16s ease, box-shadow 0.16s ease;
  }

  input:hover,
  select:hover {
    border-color: color-mix(in srgb, var(--color-accent) 40%, var(--color-border));
  }

  input:focus,
  select:focus {
    outline: none;
    border-color: var(--color-accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 18%, transparent);
  }

  input:disabled,
  select:disabled {
    opacity: 0.65;
    cursor: not-allowed;
  }

  .tag-input {
    width: 10rem;
    max-width: 100%;
  }

  .color-input {
    width: 2rem;
    height: 1.8rem;
    padding: 0.125rem;
    cursor: pointer;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    padding: 0.45rem 0.7rem;
    border: 1px solid var(--color-border);
    border-radius: 0.375rem;
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
    font-weight: 500;
    font-size: 0.75rem;
    transition:
      background 0.16s ease,
      border-color 0.16s ease,
      color 0.16s ease,
      box-shadow 0.16s ease;
  }

  .btn:hover:not(:disabled) {
    background: var(--color-border);
    border-color: color-mix(in srgb, var(--color-accent) 35%, var(--color-border));
    color: var(--color-text-primary);
  }

  .btn:focus-visible,
  .icon-btn:focus-visible,
  .chip-button:focus-visible,
  .segment-btn:focus-visible,
  .checkbox-chip:focus-within,
  .chip-remove:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 18%, transparent);
  }

  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--color-accent);
    color: white;
    border-color: color-mix(in srgb, var(--color-accent) 70%, black 10%);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
    color: white;
  }

  .btn-danger {
    background: color-mix(in srgb, var(--color-error) 16%, var(--color-surface));
    color: var(--color-text-primary);
    border-color: color-mix(in srgb, var(--color-error) 36%, var(--color-border));
  }

  .btn-danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-error) 20%, var(--color-surface-elevated));
    color: var(--color-text-primary);
  }

  .btn-small {
    padding: 0.3rem 0.5rem;
    font-size: 0.7rem;
  }

  .segmented-control {
    display: inline-flex;
    gap: 0.25rem;
    padding: 0.2rem;
    border: 1px solid var(--color-border);
    border-radius: 0.375rem;
    background: var(--color-background);
  }

  .segment-btn {
    padding: 0.35rem 0.65rem;
    border: none;
    border-radius: 0.25rem;
    background: transparent;
    color: var(--color-text-secondary);
    font-weight: 500;
    font-size: 0.75rem;
    transition: background 0.16s ease, color 0.16s ease;
  }

  .segment-btn:hover {
    background: var(--color-surface-elevated);
    color: var(--color-text-primary);
  }

  .segment-btn.is-selected {
    background: color-mix(in srgb, var(--color-accent) 18%, var(--color-surface-elevated));
    color: var(--color-text-primary);
  }

  .status-pill,
  .chip,
  .chip-button,
  .checkbox-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.16rem 0.45rem;
    border-radius: 0.375rem;
    border: 1px solid color-mix(in srgb, var(--color-accent) 20%, var(--color-border));
    background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
    color: var(--color-text-secondary);
    font-size: 0.6875rem;
  }

  .status-pill-muted,
  .chip-soft {
    background: color-mix(in srgb, var(--color-surface) 75%, transparent);
    border-color: var(--color-border);
    color: var(--color-text-muted);
  }

  .chip-list-wrap {
    align-items: center;
  }

  .chip-button {
    transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
  }

  .chip-button:hover {
    background: var(--color-surface);
    border-color: color-mix(in srgb, var(--color-accent) 38%, var(--color-border));
    color: var(--color-text-primary);
  }

  .chip-button.is-selected {
    background: color-mix(in srgb, var(--color-accent) 18%, var(--color-surface-elevated));
    border-color: color-mix(in srgb, var(--color-accent) 50%, var(--color-border));
    color: var(--color-text-primary);
  }

  .chip-editable {
    padding-right: 0.3rem;
  }

  .chip-remove,
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.35rem;
    height: 1.35rem;
    border: none;
    border-radius: 0.25rem;
    background: transparent;
    color: var(--color-text-muted);
    transition: background 0.16s ease, color 0.16s ease;
  }

  .chip-remove:hover,
  .icon-btn:hover {
    background: color-mix(in srgb, var(--color-error) 10%, transparent);
    color: var(--color-text-primary);
  }

  .chip-remove svg,
  .icon-btn svg {
    width: 0.8rem;
    height: 0.8rem;
  }

  .checkbox-chip {
    cursor: pointer;
    background: var(--color-surface);
    border-color: var(--color-border);
  }

  .checkbox-chip:hover {
    border-color: color-mix(in srgb, var(--color-accent) 36%, var(--color-border));
  }

  .checkbox-chip input {
    width: 0.75rem;
    height: 0.75rem;
    margin: 0;
    accent-color: var(--color-accent);
  }

  .launch-shell {
    border: 1px solid color-mix(in srgb, var(--color-border) 80%, transparent);
    border-radius: 0.375rem;
    overflow: hidden;
    background: var(--color-background);
  }

  .empty-state,
  .empty-inline {
    padding: 0.65rem;
    border: 1px dashed color-mix(in srgb, var(--color-border) 85%, transparent);
    border-radius: 0.375rem;
    background: color-mix(in srgb, var(--color-surface) 60%, transparent);
  }

  .empty-title {
    font-weight: 600;
    color: var(--color-text-primary);
    margin-bottom: 0.25rem;
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .list-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid color-mix(in srgb, var(--color-border) 85%, transparent);
    border-radius: 0.375rem;
    background: var(--color-background);
  }

  .list-row-inline {
    align-items: center;
  }

  .list-copy {
    min-width: 0;
    flex: 1;
  }

  .list-title-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
    margin-bottom: 0.1rem;
  }

  .list-code {
    color: var(--color-text-secondary);
    font-family: monospace;
    font-size: 0.75rem;
    word-break: break-word;
  }

  @media (max-width: 1024px) {
    .settings-grid,
    .editor-grid,
    .two-column-layout {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 720px) {
    .repo-page {
      padding: 0.6rem;
    }

    .hero-meta,
    .inline-field {
      flex-direction: column;
      align-items: stretch;
    }

    .tag-input {
      width: 100%;
    }
  }
</style>
