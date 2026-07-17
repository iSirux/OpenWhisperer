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
  import { settings } from '$lib/stores/settings';
  import { accountsForProvider } from '$lib/utils/accounts';
  import type { LaunchCommand, LaunchProfile } from '$lib/types/launch';
  import { startRepoExploreSession } from '$lib/utils/repoExplore';
  import { REPO_ICON_NAMES, getDefaultRepoColor } from '$lib/utils/repoIcons';

  interface Props {
    repoId?: string | null;
    showAddForm?: boolean;
  }

  interface LaunchGenerationResult {
    commands: Array<{ name: string; command: string; working_dir?: string }>;
    profiles: Array<{ name: string; command_names: string[] }>;
  }

  interface GhAccount {
    username: string;
    host: string;
    active: boolean;
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
  let ghAccounts = $state<GhAccount[]>([]);
  let ghAccountsLoaded = $state(false);
  // Repo ids where the owner→account auto-match already ran this session.
  let ghAutoMatchAttempted = $state<Set<string>>(new Set());
  let ghInstalled = $state<boolean | null>(null);
  let detectingGithub = $state(false);
  // Repo ids where auto-detection already ran this session and found nothing,
  // so the effect doesn't re-probe on every store update.
  let githubDetectAttempted = $state<Set<string>>(new Set());

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

  // Agent accounts: only show the whitelist when at least one configured account exists.
  const hasConfiguredAccounts = $derived(($settings.accounts ?? []).length > 0);
  // All selectable accounts (virtual defaults + configured) across enabled providers.
  const accountOptions = $derived([
    ...(($settings.enabled_providers?.claude ?? true) ? accountsForProvider($settings.accounts, 'Claude') : []),
    ...(($settings.enabled_providers?.openai ?? true) ? accountsForProvider($settings.accounts, 'OpenAI') : []),
  ]);

  function toggleRepoAccount(id: string) {
    if (!selectedRepo) return;
    const current = selectedRepo.account_ids ?? [];
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    updateRepo({ account_ids: next });
  }

  onMount(async () => {
    const enabledProviders = $settings.enabled_providers ?? { claude: true, openai: true };
    try {
      claudeAvailable =
        enabledProviders.claude &&
        (await invoke<{ authenticated: boolean }>('check_claude_auth')).authenticated;
    } catch {
      claudeAvailable = false;
    }

    try {
      const codexAuth = await invoke<{ authenticated: boolean }>('check_openai_codex_auth');
      const hasApiKey = await invoke<boolean>('has_openai_api_key');
      codexAvailable = enabledProviders.openai && (codexAuth.authenticated || hasApiKey);
    } catch {
      codexAvailable = false;
    }

    try {
      const result = await invoke<{ installed: boolean; accounts: GhAccount[] }>('list_gh_accounts');
      ghInstalled = result.installed;
      ghAccounts = result.accounts;
    } catch {
      ghInstalled = false;
      ghAccounts = [];
    } finally {
      ghAccountsLoaded = true;
    }
  });

  // Auto-detect the GitHub remote once per repo when none is stored yet.
  $effect(() => {
    const repo = selectedRepo;
    if (!repo?.id || repo.github_url !== undefined || githubDetectAttempted.has(repo.id)) return;
    githubDetectAttempted = new Set([...githubDetectAttempted, repo.id]);
    void detectGithubUrl(repo.id, repo.path);
  });

  /** Owner segment of a normalized GitHub URL ("https://host/owner/repo"). */
  function githubUrlOwner(url: string): string | null {
    const parts = url.split('/').filter(Boolean); // ["https:", host, owner, repo]
    return parts.length >= 4 ? parts[2] : null;
  }

  // First-time default: when a repo has a GitHub URL but gh_user was never set,
  // auto-pick the logged-in gh account whose username matches the URL's owner.
  // An explicit "Default" choice is stored as '' so this never overrides it.
  $effect(() => {
    const repo = selectedRepo;
    if (!ghAccountsLoaded || !repo?.id || !repo.github_url || repo.gh_user !== undefined) return;
    if (ghAutoMatchAttempted.has(repo.id)) return;
    ghAutoMatchAttempted = new Set([...ghAutoMatchAttempted, repo.id]);
    const owner = githubUrlOwner(repo.github_url)?.toLowerCase();
    const match = owner ? ghAccounts.find((a) => a.username.toLowerCase() === owner) : undefined;
    if (match) {
      updateRepoById(repo.id, { gh_user: match.username });
    }
  });

  async function detectGithubUrl(targetRepoId: string, repoPath: string) {
    detectingGithub = true;
    try {
      const url = await invoke<string | null>('detect_github_url', { repoPath });
      if (url) {
        updateRepoById(targetRepoId, { github_url: url });
      }
    } catch (error) {
      console.warn('[repos] GitHub remote detection failed:', error);
    } finally {
      detectingGithub = false;
    }
  }

  async function openGithubUrl(url: string) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    } catch (error) {
      console.error('[repos] Failed to open GitHub URL:', error);
    }
  }

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

  // --- Validation pipeline per-repo settings ---
  const VALIDATION_STEP_NAMES = ['review', 'test', 'docs', 'lint', 'ship', 'ci'] as const;
  const VALIDATION_STEP_LABELS: Record<string, string> = {
    review: 'Review',
    test: 'Test',
    docs: 'Docs',
    lint: 'Lint',
    ship: 'Ship',
    ci: 'CI',
  };

  function updateValidationCommand(field: 'test' | 'lint', value: string) {
    const trimmed = value.trim();
    const current = selectedRepo?.validation_commands ?? {};
    const next = { ...current, [field]: trimmed || undefined };
    const hasAny = !!next.test || !!next.lint;
    updateRepo({ validation_commands: hasAny ? next : undefined });
  }

  function toggleValidationStep(step: string, on: boolean) {
    const current = new Set(selectedRepo?.validation_steps ?? []);
    if (on) current.add(step);
    else current.delete(step);
    const ordered = VALIDATION_STEP_NAMES.filter((s) => current.has(s));
    updateRepo({ validation_steps: ordered.length > 0 ? ordered : undefined });
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

  async function exploreRepo(provider: 'claude' | 'codex') {
    if (!selectedRepo?.id) return;
    const targetRepoId = selectedRepo.id;
    setRepoGenerating(provider, targetRepoId, true);

    try {
      // Runs as a real, visible SDK session; the repo metadata is applied
      // automatically when the session's first turn completes.
      await startRepoExploreSession(selectedRepo, provider === 'codex' ? 'openai' : 'claude');
    } catch (error) {
      console.error('Failed to start explore session:', error);
    } finally {
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

  async function browseRepoPath() {
    if (!selectedRepo) return;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: false, defaultPath: selectedRepo.path });
    if (selected) {
      updateRepo({ path: selected as string });
    }
  }

  function addListItemFromInput(event: KeyboardEvent, field: 'tags' | 'keywords' | 'vocabulary') {
    if (event.key !== 'Enter' || !selectedRepo) return;
    const input = event.currentTarget as HTMLInputElement;
    const value = field === 'tags' ? input.value.trim().toLowerCase() : input.value.trim();
    if (!value) return;

    const current = selectedRepo[field] || [];
    if (!current.includes(value)) {
      updateRepo({ [field]: [...current, value] });
    }
    input.value = '';
  }

  function removeListItem(field: 'tags' | 'keywords' | 'vocabulary', value: string) {
    if (!selectedRepo) return;
    updateRepo({ [field]: (selectedRepo[field] || []).filter((item) => item !== value) });
  }

  function updateLaunchCommand(commandId: string, updates: Partial<LaunchCommand>) {
    if (!selectedRepo) return;
    updateRepo({
      launch_commands: (selectedRepo.launch_commands ?? []).map((command) =>
        command.id === commandId ? { ...command, ...updates } : command
      ),
    });
  }

  function updateLaunchProfile(profileId: string, updates: Partial<LaunchProfile>) {
    if (!selectedRepo) return;
    updateRepo({
      launch_profiles: (selectedRepo.launch_profiles ?? []).map((profile) =>
        profile.id === profileId ? { ...profile, ...updates } : profile
      ),
    });
  }

  function toggleProfileMembership(profileId: string, commandId: string) {
    if (!selectedRepo) return;
    const profile = (selectedRepo.launch_profiles ?? []).find((p) => p.id === profileId);
    if (!profile) return;
    const has = profile.command_ids.includes(commandId);
    updateLaunchProfile(profileId, {
      command_ids: has
        ? profile.command_ids.filter((id) => id !== commandId)
        : [...profile.command_ids, commandId],
    });
  }

  function toggleMcpServer(serverId: string) {
    if (!selectedRepo) return;
    const current = selectedRepo.mcp_servers || [];
    const enabled = current.includes(serverId);
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
            <input
              class="hero-name-input"
              value={selectedRepo.name}
              aria-label="Repository name"
              onchange={(event) => {
                const value = (event.currentTarget as HTMLInputElement).value.trim();
                if (value) updateRepo({ name: value });
                else (event.currentTarget as HTMLInputElement).value = selectedRepo.name;
              }}
            />
            <div class="hero-path-row">
              <input
                class="hero-path-input"
                value={selectedRepo.path}
                title={selectedRepo.path}
                aria-label="Repository path"
                onchange={(event) => {
                  const value = (event.currentTarget as HTMLInputElement).value.trim();
                  if (value) updateRepo({ path: value });
                  else (event.currentTarget as HTMLInputElement).value = selectedRepo.path;
                }}
              />
              <button class="btn btn-secondary btn-small" onclick={browseRepoPath}>Browse</button>
            </div>
          </div>
        </div>

        <div class="button-row">
          <button class="btn btn-secondary" onclick={() => repos.setRepoActive(selectedRepoIndex, selectedRepo.active === false)}>
            {selectedRepo.active === false ? 'Mark Active' : 'Mark Inactive'}
          </button>
          <button class="btn btn-danger" onclick={removeSelectedRepo}>Remove</button>
        </div>
      </div>

      <div class="field">
        <label for="repo-description">Description</label>
        <textarea
          id="repo-description"
          class="description-input"
          rows="3"
          value={selectedRepo.description || ''}
          placeholder="No repository summary yet. Write one here, or generate one to populate description, keywords, icon, and vocabulary."
          onchange={(event) => updateRepo({ description: (event.currentTarget as HTMLTextAreaElement).value.trim() || undefined })}
        ></textarea>
      </div>

      <div class="button-row">
        {#if claudeAvailable}
          <button class="btn btn-secondary" onclick={() => exploreRepo('claude')} disabled={generatingClaude || generatingCodex}>
            {generatingClaude ? 'Exploring with Claude...' : 'Explore with Claude'}
          </button>
        {/if}
        {#if codexAvailable}
          <button class="btn btn-secondary" onclick={() => exploreRepo('codex')} disabled={generatingClaude || generatingCodex}>
            {generatingCodex ? 'Exploring with Codex...' : 'Explore with Codex'}
          </button>
        {/if}
      </div>

      <div class="detail-grid">
        <div class="detail-block">
          <div class="detail-label">Keywords</div>
          <div class="chip-list chip-list-wrap">
            {#each selectedRepo.keywords || [] as keyword}
              <span class="chip chip-editable">
                {keyword}
                <button class="chip-remove" onclick={() => removeListItem('keywords', keyword)} aria-label={`Remove ${keyword}`}>
                  <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
                  </svg>
                </button>
              </span>
            {/each}
            <input class="tag-input" placeholder="Add keyword and press Enter" onkeydown={(event) => addListItemFromInput(event, 'keywords')} />
          </div>
        </div>

        <div class="detail-block">
          <div class="detail-label">Vocabulary</div>
          <div class="chip-list chip-list-wrap">
            {#each selectedRepo.vocabulary || [] as word}
              <span class="chip chip-soft chip-editable">
                {word}
                <button class="chip-remove" onclick={() => removeListItem('vocabulary', word)} aria-label={`Remove ${word}`}>
                  <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
                  </svg>
                </button>
              </span>
            {/each}
            <input class="tag-input" placeholder="Add word and press Enter" onkeydown={(event) => addListItemFromInput(event, 'vocabulary')} />
          </div>
        </div>
      </div>
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

      <div class="field">
        <div class="field-title">GitHub</div>
        <div class="github-row">
          {#if selectedRepo.github_url}
            {@const githubUrl = selectedRepo.github_url}
            <button class="github-link" title={githubUrl} onclick={() => openGithubUrl(githubUrl)}>
              <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
              </svg>
              {selectedRepo.github_url.replace(/^https:\/\/github\.com\//, '')}
            </button>
          {:else}
            <span class="field-help">{detectingGithub ? 'Detecting GitHub remote...' : 'No GitHub remote detected'}</span>
          {/if}
          <button
            class="btn btn-secondary btn-small"
            onclick={() => selectedRepo.id && detectGithubUrl(selectedRepo.id, selectedRepo.path)}
            disabled={detectingGithub}
          >
            {detectingGithub ? 'Detecting...' : 'Re-detect'}
          </button>
          {#if selectedRepo.github_url && ghInstalled}
            <button
              class="btn btn-primary btn-small"
              onclick={() => navigation.showIssues(selectedRepo.id ?? null)}
              title="Browse this repo's GitHub issues and launch sessions from them"
            >
              Issues
            </button>
          {/if}
        </div>

        {#if ghInstalled === false}
          <p class="field-help">GitHub CLI (gh) not found — install it to pin a GitHub account for this repo.</p>
        {:else if ghAccounts.length > 0 || selectedRepo.gh_user}
          <div class="github-account-row">
            <label for="repo-gh-user">gh account</label>
            <select
              id="repo-gh-user"
              value={selectedRepo.gh_user ?? ''}
              onchange={(event) => {
                const value = (event.currentTarget as HTMLSelectElement).value;
                // '' = explicit Default; distinguishable from never-set (undefined)
                // so the owner auto-match doesn't override a deliberate choice.
                updateRepo({ gh_user: value });
              }}
            >
              <option value="">Default{ghAccounts.find((a) => a.active) ? ` (${ghAccounts.find((a) => a.active)?.username})` : ''}</option>
              {#each ghAccounts as account}
                <option value={account.username}>{account.username}{account.active ? ' (active)' : ''}</option>
              {/each}
              {#if selectedRepo.gh_user && !ghAccounts.some((a) => a.username === selectedRepo.gh_user)}
                <option value={selectedRepo.gh_user}>{selectedRepo.gh_user} (not logged in)</option>
              {/if}
            </select>
          </div>
          {#if selectedRepo.gh_user}
            <p class="field-help">Sessions in this repo run gh as {selectedRepo.gh_user} (via GH_TOKEN).</p>
          {/if}
        {/if}
      </div>

      {#if hasConfiguredAccounts}
        <div class="field">
          <div class="field-title">Agent accounts</div>
          <div class="chip-list chip-list-wrap">
            {#each accountOptions as acct (acct.id)}
              {@const selected = selectedRepo.account_ids?.includes(acct.id)}
              <button
                class="chip-button"
                class:is-selected={selected}
                onclick={() => toggleRepoAccount(acct.id)}
                title={`${acct.label} · ${acct.provider === 'OpenAI' ? 'Codex' : 'Claude'}`}
              >
                <span class="account-swatch" style="background: {acct.color};"></span>
                {acct.label}
                <span class="account-provider-tag">{acct.provider === 'OpenAI' ? 'Codex' : 'Claude'}</span>
              </button>
            {/each}
          </div>
          {#if !selectedRepo.account_ids || selectedRepo.account_ids.length === 0}
            <p class="field-help">All accounts allowed. Select accounts to restrict sessions in this repo.</p>
          {/if}
        </div>
      {/if}

      {#if enabledMcpServers.length > 0}
        <div class="field">
          <div class="field-title">MCP Servers</div>
          <div class="chip-list">
            {#each enabledMcpServers as server}
              {@const enabled = selectedRepo.mcp_servers?.includes(server.id)}
              <button class="chip-button" class:is-selected={enabled} onclick={() => toggleMcpServer(server.id)}>
                {server.name}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <div class="field">
        <div class="field-title">Validation</div>
        <div class="settings-grid">
          <div class="field">
            <label for="repo-val-test">Test command</label>
            <input
              id="repo-val-test"
              type="text"
              placeholder="e.g. npm test"
              value={selectedRepo.validation_commands?.test ?? ''}
              onchange={(event) => updateValidationCommand('test', (event.currentTarget as HTMLInputElement).value)}
            />
          </div>
          <div class="field">
            <label for="repo-val-lint">Lint command</label>
            <input
              id="repo-val-lint"
              type="text"
              placeholder="e.g. npm run lint"
              value={selectedRepo.validation_commands?.lint ?? ''}
              onchange={(event) => updateValidationCommand('lint', (event.currentTarget as HTMLInputElement).value)}
            />
          </div>
        </div>
        <label for="repo-val-guidelines">Review guidelines</label>
        <textarea
          id="repo-val-guidelines"
          class="description-input"
          rows="3"
          placeholder="Extra guidance injected into the reviewer prompt for this repo (conventions, gotchas, what to scrutinise)."
          value={selectedRepo.review_guidelines ?? ''}
          onchange={(event) => updateRepo({ review_guidelines: (event.currentTarget as HTMLTextAreaElement).value.trim() || undefined })}
        ></textarea>
        <div class="field-title">Default steps</div>
        <p class="field-help">Overrides the global default step set for runs started in this repo.</p>
        <div class="chip-list chip-list-wrap">
          {#each VALIDATION_STEP_NAMES as step (step)}
            {@const on = selectedRepo.validation_steps?.includes(step)}
            <button
              class="chip-button"
              class:is-selected={on}
              onclick={() => toggleValidationStep(step, !on)}
            >
              {VALIDATION_STEP_LABELS[step]}
            </button>
          {/each}
        </div>
      </div>

      <div class="field">
        <label for="repo-tag-input">Tags</label>
        <div class="chip-list chip-list-wrap">
          {#each selectedRepo.tags || [] as tag}
            <span class="chip chip-editable">
              {tag}
              <button class="chip-remove" onclick={() => removeListItem('tags', tag)} aria-label={`Remove ${tag}`}>
                <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
                </svg>
              </button>
            </span>
          {/each}
          <input id="repo-tag-input" class="tag-input" placeholder="Add tag and press Enter" onkeydown={(event) => addListItemFromInput(event, 'tags')} />
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
                      <input
                        class="row-edit-input"
                        value={command.name}
                        aria-label="Command name"
                        onchange={(event) => {
                          const value = (event.currentTarget as HTMLInputElement).value.trim();
                          if (value) updateLaunchCommand(command.id, { name: value });
                          else (event.currentTarget as HTMLInputElement).value = command.name;
                        }}
                      />
                      {#if command.auto_detected}
                        <span class="status-pill status-pill-muted">Auto</span>
                      {/if}
                    </div>
                    <input
                      class="row-edit-input row-edit-code"
                      value={command.command}
                      aria-label="Command"
                      onchange={(event) => {
                        const value = (event.currentTarget as HTMLInputElement).value.trim();
                        if (value) updateLaunchCommand(command.id, { command: value });
                        else (event.currentTarget as HTMLInputElement).value = command.command;
                      }}
                    />
                    <input
                      class="row-edit-input row-edit-meta"
                      value={command.working_dir || ''}
                      placeholder="Working dir (optional)"
                      aria-label="Working directory"
                      onchange={(event) => updateLaunchCommand(command.id, { working_dir: (event.currentTarget as HTMLInputElement).value.trim() || undefined })}
                    />
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
                      <input
                        class="row-edit-input"
                        value={profile.name}
                        aria-label="Profile name"
                        onchange={(event) => {
                          const value = (event.currentTarget as HTMLInputElement).value.trim();
                          if (value) updateLaunchProfile(profile.id, { name: value });
                          else (event.currentTarget as HTMLInputElement).value = profile.name;
                        }}
                      />
                      <span class="status-pill status-pill-muted">{profile.command_ids.length} cmds</span>
                    </div>
                    <div class="chip-list">
                      {#each selectedRepo.launch_commands ?? [] as command (command.id)}
                        <label class="checkbox-chip">
                          <input type="checkbox" checked={profile.command_ids.includes(command.id)} onchange={() => toggleProfileMembership(profile.id, command.id)} />
                          <span>{command.name}</span>
                        </label>
                      {/each}
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
  .empty-state p,
  .empty-inline {
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
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .hero-name-input {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--color-text-primary);
    background: transparent;
    border-color: transparent;
    padding: 0.2rem 0.35rem;
    margin-left: -0.35rem;
    width: 100%;
    max-width: 24rem;
  }

  .hero-name-input:hover,
  .hero-name-input:focus {
    background: var(--color-background);
  }

  .hero-path-row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }

  .hero-path-input {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    background: transparent;
    border-color: transparent;
    padding: 0.2rem 0.35rem;
    margin-left: -0.35rem;
    max-width: 32rem;
  }

  .hero-path-input:hover,
  .hero-path-input:focus {
    background: var(--color-background);
  }

  .description-input {
    width: 100%;
    min-width: 0;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--color-border);
    border-radius: 0.375rem;
    background: var(--color-background);
    color: var(--color-text-secondary);
    font-size: 0.75rem;
    font-family: inherit;
    line-height: 1.45;
    resize: vertical;
    transition: border-color 0.16s ease, box-shadow 0.16s ease;
  }

  .description-input:hover {
    border-color: color-mix(in srgb, var(--color-accent) 40%, var(--color-border));
  }

  .description-input:focus {
    outline: none;
    border-color: var(--color-accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 18%, transparent);
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

  .github-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    min-width: 0;
  }

  .github-link {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.55rem;
    border: 1px solid var(--color-border);
    border-radius: 0.375rem;
    background: var(--color-background);
    color: var(--color-text-primary);
    font-size: 0.75rem;
    cursor: pointer;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: border-color 0.16s ease, color 0.16s ease;
  }

  .github-link:hover {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  .github-link svg {
    width: 0.9rem;
    height: 0.9rem;
    flex-shrink: 0;
  }

  .github-account-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-top: 0.4rem;
  }

  .github-account-row label {
    flex-shrink: 0;
  }

  .github-account-row select {
    width: auto;
    min-width: 12rem;
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

  .account-swatch {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 999px;
    flex-shrink: 0;
  }

  .account-provider-tag {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
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

  .list-copy .row-edit-input {
    background: transparent;
    border-color: transparent;
    padding: 0.2rem 0.35rem;
    margin-left: -0.35rem;
  }

  .list-copy .row-edit-input:hover,
  .list-copy .row-edit-input:focus {
    background: var(--color-surface-elevated);
  }

  .list-title-row .row-edit-input {
    flex: 1;
    min-width: 6rem;
    font-weight: 600;
    color: var(--color-text-primary);
  }

  .row-edit-code {
    font-family: monospace;
    color: var(--color-text-secondary);
  }

  .row-edit-meta {
    color: var(--color-text-muted);
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
