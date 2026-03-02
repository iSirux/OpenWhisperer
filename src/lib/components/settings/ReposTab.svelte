<script lang="ts">
  import { settings, isNoteModeAvailable } from "$lib/stores/settings";
  import { repos } from "$lib/stores/repos";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { onMount } from "svelte";
  import RepoIcon from "$lib/components/RepoIcon.svelte";
  import { REPO_ICON_NAMES, REPO_COLORS, getDefaultRepoColor } from "$lib/utils/repoIcons";
  import type { LaunchCommand, LaunchProfile } from "$lib/types/launch";

  interface RepoDescriptionResult {
    description: string;
    keywords: string[];
    vocabulary: string[];
    icon?: string;
    color?: string;
  }

  let newRepoPath = $state("");
  let newRepoName = $state("");
  let generatingClaudeIndices = $state(new Set<number>());
  let generatingCodexIndices = $state(new Set<number>());
  const noteModeAvailable = $derived(isNoteModeAvailable());

  // Track which repos have their worktree section expanded
  let worktreeExpandedIndices = $state(new Set<number>());

  // Track which repos have their launch profiles section expanded
  let launchExpandedIndices = $state(new Set<number>());
  let scanningIndices = $state(new Set<number>());
  let generatingLaunchClaudeIndices = $state(new Set<number>());
  let generatingLaunchCodexIndices = $state(new Set<number>());
  // New command form state per repo
  let newCmdName = $state<Record<number, string>>({});
  let newCmdCommand = $state<Record<number, string>>({});
  let newCmdWorkingDir = $state<Record<number, string>>({});
  let newProfileName = $state<Record<number, string>>({});
  let newProfileCmdIds = $state<Record<number, Set<string>>>({});

  // Provider availability
  let claudeAvailable = $state(false);
  let codexAvailable = $state(false);

  // Track pending generation requests (id -> index)
  const pendingClaudeRequests = new Map<string, number>();
  const pendingCodexRequests = new Map<string, number>();

  onMount(async () => {
    // Check which providers are available
    try {
      const claudeAuth = await invoke<{ hasEnvKey: boolean; hasOAuth: boolean; hasKeyringKey: boolean; authenticated: boolean }>('check_claude_auth');
      claudeAvailable = claudeAuth.authenticated;
    } catch {
      claudeAvailable = false;
    }

    try {
      const codexAuth = await invoke<{ hasAuthFile: boolean; hasCli: boolean; authenticated: boolean }>('check_openai_codex_auth');
      const hasApiKey = await invoke<boolean>('has_openai_api_key');
      codexAvailable = codexAuth.authenticated || hasApiKey;
    } catch {
      codexAvailable = false;
    }
  });

  // Shared handler for async description generation results
  async function setupDescriptionListeners(
    requestId: string,
    index: number,
    pendingMap: Map<string, number>,
    generatingSet: Set<number>,
    setGenerating: (s: Set<number>) => void,
    providerLabel: string,
  ) {
    const resultListener = await listen<RepoDescriptionResult>(
      `repo-description-result-${requestId}`,
      (event) => {
        const idx = pendingMap.get(requestId);
        if (idx !== undefined) {
          const updatedRepos = [...$repos.list];
          updatedRepos[idx] = {
            ...updatedRepos[idx],
            description: event.payload.description,
            keywords: event.payload.keywords,
            vocabulary: event.payload.vocabulary,
            icon: event.payload.icon || updatedRepos[idx].icon,
            color: event.payload.color || updatedRepos[idx].color,
          };
          repos.updateList(updatedRepos);
          pendingMap.delete(requestId);
          setGenerating(new Set([...generatingSet].filter(i => i !== idx)));
        }
        resultListener();
        errorListener();
      }
    );

    const errorListener = await listen<string>(
      `repo-description-error-${requestId}`,
      (event) => {
        const idx = pendingMap.get(requestId);
        if (idx !== undefined) {
          console.error(`${providerLabel} repo description failed:`, event.payload);
          alert(`Failed to generate description with ${providerLabel}: ${event.payload}`);
          pendingMap.delete(requestId);
          setGenerating(new Set([...generatingSet].filter(i => i !== idx)));
        }
        resultListener();
        errorListener();
      }
    );

    return { resultListener, errorListener };
  }

  async function generateRepoDescriptionWithClaude(index: number) {
    const repo = $repos.list[index];
    if (!repo || generatingClaudeIndices.has(index)) return false;

    const requestId = `claude-repo-${index}-${Date.now()}`;
    pendingClaudeRequests.set(requestId, index);
    generatingClaudeIndices = new Set([...generatingClaudeIndices, index]);

    const { resultListener, errorListener } = await setupDescriptionListeners(
      requestId, index, pendingClaudeRequests, generatingClaudeIndices,
      (s) => { generatingClaudeIndices = s; },
      "Claude",
    );

    try {
      await invoke("generate_repo_description_with_claude", {
        id: requestId,
        repoPath: repo.path,
        repoName: repo.name,
      });
      return true;
    } catch (error) {
      console.error("Failed to invoke Claude repo description:", error);
      alert(`Failed to start Claude generation: ${error}`);
      pendingClaudeRequests.delete(requestId);
      generatingClaudeIndices = new Set([...generatingClaudeIndices].filter(i => i !== index));
      resultListener();
      errorListener();
      return false;
    }
  }

  async function generateRepoDescriptionWithCodex(index: number) {
    const repo = $repos.list[index];
    if (!repo || generatingCodexIndices.has(index)) return false;

    const requestId = `codex-repo-${index}-${Date.now()}`;
    pendingCodexRequests.set(requestId, index);
    generatingCodexIndices = new Set([...generatingCodexIndices, index]);

    const { resultListener, errorListener } = await setupDescriptionListeners(
      requestId, index, pendingCodexRequests, generatingCodexIndices,
      (s) => { generatingCodexIndices = s; },
      "Codex",
    );

    try {
      await invoke("generate_repo_description_with_codex", {
        id: requestId,
        repoPath: repo.path,
        repoName: repo.name,
      });
      return true;
    } catch (error) {
      console.error("Failed to invoke Codex repo description:", error);
      alert(`Failed to start Codex generation: ${error}`);
      pendingCodexRequests.delete(requestId);
      generatingCodexIndices = new Set([...generatingCodexIndices].filter(i => i !== index));
      resultListener();
      errorListener();
      return false;
    }
  }

  // ---- Launch Profile handlers ----

  async function scanRepoCommands(index: number) {
    const repo = $repos.list[index];
    if (!repo || scanningIndices.has(index)) return;
    scanningIndices = new Set([...scanningIndices, index]);
    try {
      const detected = await invoke<LaunchCommand[]>("scan_repo_launch_commands", { repoPath: repo.path });
      if (detected.length > 0) {
        const existing = repo.launch_commands ?? [];
        // Merge: keep existing non-auto-detected, add new auto-detected
        const manualCmds = existing.filter(c => !c.auto_detected);
        const merged = [...manualCmds, ...detected];
        await repos.updateRepo(index, { launch_commands: merged });
      }
    } catch (error) {
      console.error("[scanRepoCommands] Failed:", error);
      alert(`Scan failed: ${error}`);
    } finally {
      scanningIndices = new Set([...scanningIndices].filter(i => i !== index));
    }
  }

  async function generateLaunchWithClaude(index: number) {
    const repo = $repos.list[index];
    if (!repo || generatingLaunchClaudeIndices.has(index)) return;
    generatingLaunchClaudeIndices = new Set([...generatingLaunchClaudeIndices, index]);

    const requestId = `claude-launch-${index}-${Date.now()}`;

    const resultListener = await listen<{ commands: Array<{ name: string; command: string; working_dir?: string }>; profiles: Array<{ name: string; command_names: string[] }> }>(
      `launch-profile-result-${requestId}`,
      (event) => {
        applyLaunchProfileResult(index, event.payload);
        generatingLaunchClaudeIndices = new Set([...generatingLaunchClaudeIndices].filter(i => i !== index));
        resultListener();
        errorListener();
      }
    );

    const errorListener = await listen<string>(
      `launch-profile-error-${requestId}`,
      (event) => {
        console.error("Claude launch profile failed:", event.payload);
        alert(`Failed to generate launch profiles with Claude: ${event.payload}`);
        generatingLaunchClaudeIndices = new Set([...generatingLaunchClaudeIndices].filter(i => i !== index));
        resultListener();
        errorListener();
      }
    );

    try {
      await invoke("generate_launch_profile_with_claude", {
        id: requestId,
        repoPath: repo.path,
        repoName: repo.name,
      });
    } catch (error) {
      console.error("Failed to invoke Claude launch profile:", error);
      alert(`Failed to start Claude generation: ${error}`);
      generatingLaunchClaudeIndices = new Set([...generatingLaunchClaudeIndices].filter(i => i !== index));
      resultListener();
      errorListener();
    }
  }

  async function generateLaunchWithCodex(index: number) {
    const repo = $repos.list[index];
    if (!repo || generatingLaunchCodexIndices.has(index)) return;
    generatingLaunchCodexIndices = new Set([...generatingLaunchCodexIndices, index]);

    const requestId = `codex-launch-${index}-${Date.now()}`;

    const resultListener = await listen<{ commands: Array<{ name: string; command: string; working_dir?: string }>; profiles: Array<{ name: string; command_names: string[] }> }>(
      `launch-profile-result-${requestId}`,
      (event) => {
        applyLaunchProfileResult(index, event.payload);
        generatingLaunchCodexIndices = new Set([...generatingLaunchCodexIndices].filter(i => i !== index));
        resultListener();
        errorListener();
      }
    );

    const errorListener = await listen<string>(
      `launch-profile-error-${requestId}`,
      (event) => {
        console.error("Codex launch profile failed:", event.payload);
        alert(`Failed to generate launch profiles with Codex: ${event.payload}`);
        generatingLaunchCodexIndices = new Set([...generatingLaunchCodexIndices].filter(i => i !== index));
        resultListener();
        errorListener();
      }
    );

    try {
      await invoke("generate_launch_profile_with_codex", {
        id: requestId,
        repoPath: repo.path,
        repoName: repo.name,
      });
    } catch (error) {
      console.error("Failed to invoke Codex launch profile:", error);
      alert(`Failed to start Codex generation: ${error}`);
      generatingLaunchCodexIndices = new Set([...generatingLaunchCodexIndices].filter(i => i !== index));
      resultListener();
      errorListener();
    }
  }

  function applyLaunchProfileResult(index: number, payload: { commands: Array<{ name: string; command: string; working_dir?: string }>; profiles: Array<{ name: string; command_names: string[] }> }) {
    const cmds: LaunchCommand[] = payload.commands.map(c => ({
      id: crypto.randomUUID(),
      name: c.name,
      command: c.command,
      working_dir: c.working_dir,
      auto_detected: true,
    }));

    // Build profiles: resolve command_names to command IDs
    const profiles: LaunchProfile[] = payload.profiles.map(p => ({
      id: crypto.randomUUID(),
      name: p.name,
      command_ids: p.command_names
        .map(name => cmds.find(c => c.name === name)?.id)
        .filter((id): id is string => !!id),
    }));

    repos.updateRepo(index, {
      launch_commands: cmds,
      launch_profiles: profiles,
    });
  }

  function addLaunchCommand(index: number) {
    const name = newCmdName[index]?.trim();
    const command = newCmdCommand[index]?.trim();
    if (!name || !command) return;

    const repo = $repos.list[index];
    const existing = repo.launch_commands ?? [];
    const newCmd: LaunchCommand = {
      id: crypto.randomUUID(),
      name,
      command,
      working_dir: newCmdWorkingDir[index]?.trim() || undefined,
      auto_detected: false,
    };

    repos.updateRepo(index, { launch_commands: [...existing, newCmd] });
    newCmdName[index] = "";
    newCmdCommand[index] = "";
    newCmdWorkingDir[index] = "";
  }

  function removeLaunchCommand(repoIndex: number, cmdId: string) {
    const repo = $repos.list[repoIndex];
    const cmds = (repo.launch_commands ?? []).filter(c => c.id !== cmdId);
    // Also remove from any profiles
    const profiles = (repo.launch_profiles ?? []).map(p => ({
      ...p,
      command_ids: p.command_ids.filter(id => id !== cmdId),
    }));
    repos.updateRepo(repoIndex, { launch_commands: cmds, launch_profiles: profiles });
  }

  function addLaunchProfile(index: number) {
    const name = newProfileName[index]?.trim();
    const cmdIds = newProfileCmdIds[index];
    if (!name || !cmdIds || cmdIds.size === 0) return;

    const repo = $repos.list[index];
    const existing = repo.launch_profiles ?? [];
    const newProfile: LaunchProfile = {
      id: crypto.randomUUID(),
      name,
      command_ids: [...cmdIds],
    };

    repos.updateRepo(index, { launch_profiles: [...existing, newProfile] });
    newProfileName[index] = "";
    newProfileCmdIds[index] = new Set();
  }

  function removeLaunchProfile(repoIndex: number, profileId: string) {
    const repo = $repos.list[repoIndex];
    const profiles = (repo.launch_profiles ?? []).filter(p => p.id !== profileId);
    repos.updateRepo(repoIndex, { launch_profiles: profiles });
  }

  function toggleProfileCommand(repoIndex: number, cmdId: string) {
    const current = newProfileCmdIds[repoIndex] ?? new Set<string>();
    const next = new Set(current);
    if (next.has(cmdId)) {
      next.delete(cmdId);
    } else {
      next.add(cmdId);
    }
    newProfileCmdIds[repoIndex] = next;
  }

  async function addRepo() {
    if (!newRepoPath || !newRepoName) return;
    try {
      await repos.addRepo(newRepoPath, newRepoName);
      newRepoPath = "";
      newRepoName = "";
    } catch (error) {
      console.error("[addRepo] Failed to add repo:", error);
    }
  }

  async function removeRepo(index: number) {
    try {
      await repos.removeRepo(index);
    } catch (error) {
      console.error("[removeRepo] Failed to remove repo:", error);
    }
  }

  async function browseFolder() {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({
        directory: true,
        multiple: false,
      });
      if (selected) {
        newRepoPath = selected as string;
        if (!newRepoName) {
          newRepoName = newRepoPath.split(/[/\\]/).pop() || "";
        }
      }
    } catch (error) {
      console.error("[browseFolder] Failed to open folder dialog:", error);
    }
  }

  function isGenerating(index: number): boolean {
    return generatingClaudeIndices.has(index) || generatingCodexIndices.has(index);
  }
</script>

{#snippet spinnerIcon()}
  <svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
  </svg>
{/snippet}

<div class="space-y-4">
  <div class="space-y-3">
    {#each $repos.list as repo, index}
      <div class="p-3 bg-surface-elevated rounded space-y-2 {repo.active === false ? 'opacity-50' : ''}">
        <div class="flex items-start gap-2">
          <RepoIcon repo={repo} size="md" />
          <div class="flex-1 min-w-0">
            <div class="font-medium text-sm text-text-primary">
              {repo.name}
            </div>
            <div class="text-xs text-text-muted truncate">
              {repo.path}
            </div>
          </div>
          <div class="flex gap-1 shrink-0">
            <!-- Active/Inactive toggle -->
            <button
              class="p-1.5 transition-colors rounded hover:bg-border {repo.active !== false ? 'text-emerald-400' : 'text-text-muted'}"
              onclick={() => repos.setRepoActive(index, repo.active === false)}
              title={repo.active !== false ? 'Active — click to deactivate' : 'Inactive — click to activate'}
            >
              {#if repo.active !== false}
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              {:else}
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
              {/if}
            </button>
            <!-- Remove button -->
            <button
              class="p-1.5 text-text-muted hover:text-error transition-colors rounded hover:bg-border"
              onclick={() => removeRepo(index)}
            >
              <svg
                class="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
            </button>
          </div>
        </div>
        <!-- Description, keywords, and vocabulary area -->
        {#if repo.description || repo.keywords?.length || repo.vocabulary?.length}
          <div
            class="text-xs bg-background/50 p-2 rounded border border-border/50 space-y-2"
          >
            {#if repo.description}
              <div class="text-text-secondary">{repo.description}</div>
            {/if}
            {#if repo.keywords?.length}
              <div>
                <span class="text-text-muted text-[10px]">Keywords:</span>
                <div class="flex flex-wrap gap-1 mt-0.5">
                  {#each repo.keywords as keyword}
                    <span
                      class="px-1.5 py-0.5 bg-accent/10 text-accent text-[10px] rounded"
                      >{keyword}</span
                    >
                  {/each}
                </div>
              </div>
            {/if}
            {#if repo.vocabulary?.length}
              <div>
                <span class="text-text-muted text-[10px]">Vocabulary:</span>
                <div class="flex flex-wrap gap-1 mt-0.5">
                  {#each repo.vocabulary as term}
                    <span
                      class="px-1.5 py-0.5 bg-purple-500/10 text-purple-400 text-[10px] rounded font-mono"
                      >{term}</span
                    >
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {/if}

        <!-- Generate description buttons -->
        {#if claudeAvailable || codexAvailable}
          <div class="flex gap-2 flex-wrap">
            {#if claudeAvailable}
              <button
                class="flex items-center gap-1.5 px-3 py-1.5 bg-orange-500/10 hover:bg-orange-500/20 text-orange-400 rounded-full text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                onclick={() => generateRepoDescriptionWithClaude(index)}
                disabled={isGenerating(index)}
                title="Explore codebase with Claude Haiku to generate description, keywords, and vocabulary"
              >
                {#if generatingClaudeIndices.has(index)}
                  {@render spinnerIcon()}
                  Exploring...
                {:else}
                  <!-- Claude icon -->
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  Explore with Claude
                {/if}
              </button>
            {/if}
            {#if codexAvailable}
              <button
                class="flex items-center gap-1.5 px-3 py-1.5 bg-green-500/10 hover:bg-green-500/20 text-green-400 rounded-full text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                onclick={() => generateRepoDescriptionWithCodex(index)}
                disabled={isGenerating(index)}
                title="Explore codebase with OpenAI Codex to generate description, keywords, and vocabulary"
              >
                {#if generatingCodexIndices.has(index)}
                  {@render spinnerIcon()}
                  Exploring...
                {:else}
                  <!-- Codex/OpenAI icon -->
                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
                  </svg>
                  Explore with Codex
                {/if}
              </button>
            {/if}
          </div>
        {:else if !repo.description}
          <div class="text-xs text-text-muted italic">
            Configure Claude or Codex authentication in settings to generate descriptions.
          </div>
        {/if}

        <!-- MCP Servers selection -->
        {#if $settings.mcp.servers.length > 0}
          <div class="text-xs">
            <div class="flex items-center gap-1 text-text-muted mb-1">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
              </svg>
              <span>MCP Servers:</span>
            </div>
            <div class="flex flex-wrap gap-1">
              {#each $settings.mcp.servers.filter(s => s.enabled) as server}
                {@const isSelected = repo.mcp_servers?.includes(server.id)}
                <button
                  class="px-1.5 py-0.5 rounded text-[10px] transition-colors {isSelected ? 'bg-accent text-white' : 'bg-border text-text-muted hover:bg-border/80'}"
                  onclick={() => {
                    const updatedRepos = [...$repos.list];
                    const currentServers = repo.mcp_servers || [];
                    if (isSelected) {
                      updatedRepos[index] = {
                        ...updatedRepos[index],
                        mcp_servers: currentServers.filter(id => id !== server.id),
                      };
                    } else {
                      updatedRepos[index] = {
                        ...updatedRepos[index],
                        mcp_servers: [...currentServers, server.id],
                      };
                    }
                    repos.updateList(updatedRepos);
                  }}
                >
                  {server.name}
                </button>
              {/each}
            </div>
            {#if !repo.mcp_servers?.length}
              <div class="text-text-muted mt-1 italic">Uses all enabled global servers</div>
            {/if}
          </div>
          {#if noteModeAvailable}
            <!-- Note MCP Servers selection -->
            <div class="text-xs mt-2 pt-2 border-t border-border/30">
              <div class="flex items-center gap-1 text-amber-400/80 mb-1">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                <span>Note Mode MCP:</span>
              </div>
              <div class="flex flex-wrap gap-1">
                {#each $settings.mcp.servers.filter(s => s.enabled) as server}
                  {@const isSelected = repo.note_mcp_servers?.includes(server.id)}
                  <button
                    class="px-1.5 py-0.5 rounded text-[10px] transition-colors {isSelected ? 'bg-amber-600 text-white' : 'bg-border text-text-muted hover:bg-border/80'}"
                    onclick={() => {
                      const updatedRepos = [...$repos.list];
                      const currentServers = repo.note_mcp_servers || [];
                      if (isSelected) {
                        updatedRepos[index] = {
                          ...updatedRepos[index],
                          note_mcp_servers: currentServers.filter(id => id !== server.id),
                        };
                      } else {
                        updatedRepos[index] = {
                          ...updatedRepos[index],
                          note_mcp_servers: [...currentServers, server.id],
                        };
                      }
                      repos.updateList(updatedRepos);
                    }}
                  >
                    {server.name}
                  </button>
                {/each}
              </div>
              {#if !repo.note_mcp_servers?.length}
                <div class="text-text-muted mt-1 italic">Note mode won't use MCP servers</div>
              {/if}
            </div>
          {/if}
        {/if}

        <!-- Tags for sequence filtering -->
        <div class="text-xs">
          <div class="font-medium text-text-secondary mb-1">Tags (for sequence filtering)</div>
          <div class="flex flex-wrap gap-1 items-center">
            {#each repo.tags || [] as tag}
              <span class="inline-flex items-center gap-1 px-2 py-0.5 bg-accent/10 text-accent rounded-full text-[10px]">
                {tag}
                <button
                  class="hover:text-red-400 transition-colors"
                  onclick={() => {
                    const newTags = (repo.tags || []).filter(t => t !== tag);
                    const updatedRepos = [...$repos.list];
                    updatedRepos[index] = { ...repo, tags: newTags };
                    repos.updateList(updatedRepos);
                  }}
                >&times;</button>
              </span>
            {/each}
            <input
              type="text"
              class="w-24 px-2 py-0.5 bg-background border border-border rounded text-[10px] focus:outline-none focus:border-accent"
              placeholder="Add tag..."
              onkeydown={(e) => {
                const input = e.currentTarget as HTMLInputElement;
                if (e.key === 'Enter' && input.value.trim()) {
                  const tag = input.value.trim().toLowerCase();
                  const currentTags = repo.tags || [];
                  if (!currentTags.includes(tag)) {
                    const updatedRepos = [...$repos.list];
                    updatedRepos[index] = { ...repo, tags: [...currentTags, tag] };
                    repos.updateList(updatedRepos);
                  }
                  input.value = '';
                }
              }}
            />
          </div>
        </div>

        <!-- Icon & Color customization -->
        <div class="text-xs mt-2 pt-2 border-t border-border/30">
          <div class="flex items-center gap-4">
            <div class="flex items-center gap-2">
              <span class="text-text-muted">Icon:</span>
              <select
                class="px-2 py-1 bg-background border border-border rounded text-[10px] focus:outline-none focus:border-accent max-w-[120px]"
                value={repo.icon || 'code'}
                onchange={(e) => {
                  const updatedRepos = [...$repos.list];
                  updatedRepos[index] = { ...updatedRepos[index], icon: (e.currentTarget as HTMLSelectElement).value };
                  repos.updateList(updatedRepos);
                }}
              >
                {#each REPO_ICON_NAMES as iconName}
                  <option value={iconName}>{iconName}</option>
                {/each}
              </select>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-text-muted">Color:</span>
              <input
                type="color"
                class="w-6 h-6 rounded border border-border cursor-pointer bg-transparent"
                value={repo.color || getDefaultRepoColor(repo.path)}
                onchange={(e) => {
                  const updatedRepos = [...$repos.list];
                  updatedRepos[index] = { ...updatedRepos[index], color: (e.currentTarget as HTMLInputElement).value };
                  repos.updateList(updatedRepos);
                }}
              />
              {#if repo.color}
                <button
                  class="text-text-muted hover:text-error transition-colors text-[10px]"
                  onclick={() => {
                    const updatedRepos = [...$repos.list];
                    updatedRepos[index] = { ...updatedRepos[index], color: undefined };
                    repos.updateList(updatedRepos);
                  }}
                  title="Reset to default color"
                >&times;</button>
              {/if}
            </div>
          </div>
        </div>

        <!-- Launch Profiles (collapsible) -->
        <div class="text-xs mt-2 pt-2 border-t border-border/30">
          <button
            class="flex items-center gap-1 text-text-muted hover:text-text-secondary transition-colors w-full text-left"
            onclick={() => {
              const next = new Set(launchExpandedIndices);
              if (next.has(index)) {
                next.delete(index);
              } else {
                next.add(index);
              }
              launchExpandedIndices = next;
            }}
          >
            <svg
              class="w-3 h-3 transition-transform {launchExpandedIndices.has(index) ? 'rotate-90' : ''}"
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span class="font-medium">Launch Profiles</span>
            {#if (repo.launch_commands?.length || 0) + (repo.launch_profiles?.length || 0) > 0}
              <span class="text-text-muted text-[10px] ml-1">
                ({repo.launch_commands?.length || 0} cmds, {repo.launch_profiles?.length || 0} profiles)
              </span>
            {/if}
          </button>

          {#if launchExpandedIndices.has(index)}
            <div class="mt-2 space-y-3 pl-4">
              <!-- Action buttons -->
              <div class="flex flex-wrap gap-1.5">
                <button
                  class="px-2 py-0.5 bg-surface-elevated hover:bg-border rounded text-[10px] transition-colors flex items-center gap-1"
                  onclick={() => scanRepoCommands(index)}
                  disabled={scanningIndices.has(index)}
                >
                  {#if scanningIndices.has(index)}
                    <span class="animate-spin">⏳</span> Scanning...
                  {:else}
                    🔍 Scan Repo
                  {/if}
                </button>
                {#if claudeAvailable}
                  <button
                    class="px-2 py-0.5 bg-surface-elevated hover:bg-border rounded text-[10px] transition-colors flex items-center gap-1"
                    onclick={() => generateLaunchWithClaude(index)}
                    disabled={generatingLaunchClaudeIndices.has(index)}
                  >
                    {#if generatingLaunchClaudeIndices.has(index)}
                      <span class="animate-spin">⏳</span> Claude...
                    {:else}
                      🤖 Claude
                    {/if}
                  </button>
                {/if}
                {#if codexAvailable}
                  <button
                    class="px-2 py-0.5 bg-surface-elevated hover:bg-border rounded text-[10px] transition-colors flex items-center gap-1"
                    onclick={() => generateLaunchWithCodex(index)}
                    disabled={generatingLaunchCodexIndices.has(index)}
                  >
                    {#if generatingLaunchCodexIndices.has(index)}
                      <span class="animate-spin">⏳</span> Codex...
                    {:else}
                      🤖 Codex
                    {/if}
                  </button>
                {/if}
              </div>

              <!-- Commands list -->
              <div>
                <div class="text-[10px] font-medium text-text-muted mb-1">Commands</div>
                {#if repo.launch_commands && repo.launch_commands.length > 0}
                  <div class="space-y-1">
                    {#each repo.launch_commands as cmd (cmd.id)}
                      <div class="flex items-center gap-2 bg-background/50 px-2 py-1 rounded group">
                        <span class="text-text-primary font-medium min-w-0 truncate">{cmd.name}</span>
                        <span class="text-text-muted font-mono truncate flex-1">{cmd.command}</span>
                        {#if cmd.working_dir}
                          <span class="text-text-muted/60 text-[9px] shrink-0">📂 {cmd.working_dir}</span>
                        {/if}
                        {#if cmd.auto_detected}
                          <span class="text-text-muted/50 text-[9px] shrink-0">auto</span>
                        {/if}
                        <button
                          class="p-0.5 text-text-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                          onclick={() => removeLaunchCommand(index, cmd.id)}
                          title="Remove command"
                        >✕</button>
                      </div>
                    {/each}
                  </div>
                {:else}
                  <div class="text-text-muted/60 text-[10px] italic">No commands — use Scan or Claude/Codex to detect</div>
                {/if}

                <!-- Add command form -->
                <div class="flex gap-1 mt-1.5">
                  <input
                    type="text"
                    class="w-24 px-1.5 py-0.5 bg-background border border-border rounded text-[10px] focus:outline-none focus:border-accent"
                    bind:value={newCmdName[index]}
                    placeholder="Name"
                  />
                  <input
                    type="text"
                    class="flex-1 px-1.5 py-0.5 bg-background border border-border rounded text-[10px] font-mono focus:outline-none focus:border-accent"
                    bind:value={newCmdCommand[index]}
                    placeholder="Command (e.g., npm run dev)"
                  />
                  <input
                    type="text"
                    class="w-20 px-1.5 py-0.5 bg-background border border-border rounded text-[10px] focus:outline-none focus:border-accent"
                    bind:value={newCmdWorkingDir[index]}
                    placeholder="Subdir"
                  />
                  <button
                    class="px-2 py-0.5 bg-accent/80 hover:bg-accent text-white rounded text-[10px] transition-colors shrink-0"
                    onclick={() => addLaunchCommand(index)}
                    disabled={!newCmdName[index]?.trim() || !newCmdCommand[index]?.trim()}
                  >+ Add</button>
                </div>
              </div>

              <!-- Profiles list -->
              <div>
                <div class="text-[10px] font-medium text-text-muted mb-1">Profiles</div>
                {#if repo.launch_profiles && repo.launch_profiles.length > 0}
                  <div class="space-y-1">
                    {#each repo.launch_profiles as profile (profile.id)}
                      <div class="flex items-center gap-2 bg-background/50 px-2 py-1 rounded group">
                        <span class="text-text-primary font-medium">{profile.name}</span>
                        <div class="flex gap-1 flex-1 min-w-0 overflow-hidden">
                          {#each profile.command_ids as cmdId}
                            {@const cmd = repo.launch_commands?.find(c => c.id === cmdId)}
                            {#if cmd}
                              <span class="px-1.5 py-0 bg-border/50 rounded text-[9px] text-text-muted truncate">{cmd.name}</span>
                            {/if}
                          {/each}
                        </div>
                        <button
                          class="p-0.5 text-text-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                          onclick={() => removeLaunchProfile(index, profile.id)}
                          title="Remove profile"
                        >✕</button>
                      </div>
                    {/each}
                  </div>
                {:else}
                  <div class="text-text-muted/60 text-[10px] italic">No profiles configured</div>
                {/if}

                <!-- Add profile form -->
                {#if repo.launch_commands && repo.launch_commands.length > 0}
                  <div class="mt-1.5 space-y-1">
                    <div class="flex gap-1">
                      <input
                        type="text"
                        class="flex-1 px-1.5 py-0.5 bg-background border border-border rounded text-[10px] focus:outline-none focus:border-accent"
                        bind:value={newProfileName[index]}
                        placeholder="Profile name (e.g., Full Stack)"
                      />
                      <button
                        class="px-2 py-0.5 bg-accent/80 hover:bg-accent text-white rounded text-[10px] transition-colors shrink-0"
                        onclick={() => addLaunchProfile(index)}
                        disabled={!newProfileName[index]?.trim() || !(newProfileCmdIds[index]?.size)}
                      >+ Add</button>
                    </div>
                    <div class="flex flex-wrap gap-1">
                      {#each repo.launch_commands as cmd (cmd.id)}
                        <label class="flex items-center gap-1 px-1.5 py-0.5 bg-background/50 rounded text-[10px] cursor-pointer hover:bg-border/30 transition-colors">
                          <input
                            type="checkbox"
                            checked={newProfileCmdIds[index]?.has(cmd.id) ?? false}
                            onchange={() => toggleProfileCommand(index, cmd.id)}
                            class="w-3 h-3"
                          />
                          {cmd.name}
                        </label>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        </div>

        <!-- Worktree Setup (collapsible) -->
        <div class="text-xs mt-2 pt-2 border-t border-border/30">
          <button
            class="flex items-center gap-1 text-text-muted hover:text-text-secondary transition-colors w-full text-left"
            onclick={() => {
              const next = new Set(worktreeExpandedIndices);
              if (next.has(index)) {
                next.delete(index);
              } else {
                next.add(index);
              }
              worktreeExpandedIndices = next;
            }}
          >
            <svg
              class="w-3 h-3 transition-transform {worktreeExpandedIndices.has(index) ? 'rotate-90' : ''}"
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
            </svg>
            <span class="font-medium">Worktree Setup</span>
            {#if (repo.worktree_copy_files?.length || 0) + (repo.worktree_post_create_commands?.length || 0) > 0 || repo.worktree_base_branch}
              <span class="text-text-muted text-[10px] ml-1">
                ({(repo.worktree_copy_files?.length || 0) + (repo.worktree_post_create_commands?.length || 0) + (repo.worktree_base_branch ? 1 : 0)} configured)
              </span>
            {/if}
          </button>

          {#if worktreeExpandedIndices.has(index)}
            <div class="mt-2 space-y-3 pl-4">
              <!-- Base Branch -->
              <div>
                <span class="text-text-secondary font-medium">Base Branch</span>
                <div class="text-text-muted text-[10px] mb-1">Branch to base new worktrees on. Leave empty to auto-detect remote default.</div>
                <input
                  type="text"
                  class="w-full px-2 py-1 bg-surface border border-border rounded text-[11px] font-mono focus:outline-none focus:border-accent text-text-primary"
                  value={repo.worktree_base_branch || ''}
                  placeholder="Auto-detect (e.g., origin/main)"
                  onchange={(e) => {
                    const val = (e.currentTarget as HTMLInputElement).value.trim();
                    repos.updateRepo(index, { worktree_base_branch: val || undefined });
                  }}
                />
              </div>

              <!-- Copy Files -->
              <div>
                <div class="flex items-center justify-between mb-1">
                  <span class="text-text-secondary font-medium">Copy Files</span>
                  <button
                    class="px-1.5 py-0.5 bg-accent/10 hover:bg-accent/20 text-accent rounded text-[10px] transition-colors"
                    onclick={() => {
                      const updatedRepos = [...$repos.list];
                      const currentFiles = repo.worktree_copy_files || [];
                      updatedRepos[index] = {
                        ...updatedRepos[index],
                        worktree_copy_files: [...currentFiles, ''],
                      };
                      repos.updateList(updatedRepos);
                    }}
                    title="Add file path"
                  >+</button>
                </div>
                <div class="text-text-muted text-[10px] mb-1">Files copied from main worktree to new worktrees</div>
                {#if repo.worktree_copy_files?.length}
                  <div class="space-y-1">
                    {#each repo.worktree_copy_files as filePath, fileIndex}
                      <div class="flex items-center gap-1">
                        <input
                          type="text"
                          class="flex-1 px-2 py-1 bg-surface border border-border rounded text-[11px] font-mono focus:outline-none focus:border-accent text-text-primary"
                          value={filePath}
                          placeholder=".env, settings.local.json"
                          onchange={(e) => {
                            const updatedRepos = [...$repos.list];
                            const updatedFiles = [...(repo.worktree_copy_files || [])];
                            updatedFiles[fileIndex] = (e.currentTarget as HTMLInputElement).value;
                            updatedRepos[index] = {
                              ...updatedRepos[index],
                              worktree_copy_files: updatedFiles,
                            };
                            repos.updateList(updatedRepos);
                          }}
                        />
                        <button
                          class="p-1 text-text-muted hover:text-error transition-colors shrink-0"
                          onclick={() => {
                            const updatedRepos = [...$repos.list];
                            const updatedFiles = [...(repo.worktree_copy_files || [])];
                            updatedFiles.splice(fileIndex, 1);
                            updatedRepos[index] = {
                              ...updatedRepos[index],
                              worktree_copy_files: updatedFiles,
                            };
                            repos.updateList(updatedRepos);
                          }}
                          title="Remove file"
                        >&times;</button>
                      </div>
                    {/each}
                  </div>
                {:else}
                  <div class="text-text-muted text-[10px] italic">No files configured</div>
                {/if}
              </div>

              <!-- Post-Create Commands -->
              <div>
                <div class="flex items-center justify-between mb-1">
                  <span class="text-text-secondary font-medium">Post-Create Commands</span>
                  <button
                    class="px-1.5 py-0.5 bg-accent/10 hover:bg-accent/20 text-accent rounded text-[10px] transition-colors"
                    onclick={() => {
                      const updatedRepos = [...$repos.list];
                      const currentCmds = repo.worktree_post_create_commands || [];
                      updatedRepos[index] = {
                        ...updatedRepos[index],
                        worktree_post_create_commands: [...currentCmds, ''],
                      };
                      repos.updateList(updatedRepos);
                    }}
                    title="Add command"
                  >+</button>
                </div>
                <div class="text-text-muted text-[10px] mb-1">Shell commands run after worktree creation</div>
                {#if repo.worktree_post_create_commands?.length}
                  <div class="space-y-1">
                    {#each repo.worktree_post_create_commands as cmd, cmdIndex}
                      <div class="flex items-center gap-1">
                        <input
                          type="text"
                          class="flex-1 px-2 py-1 bg-surface border border-border rounded text-[11px] font-mono focus:outline-none focus:border-accent text-text-primary"
                          value={cmd}
                          placeholder="npm install"
                          onchange={(e) => {
                            const updatedRepos = [...$repos.list];
                            const updatedCmds = [...(repo.worktree_post_create_commands || [])];
                            updatedCmds[cmdIndex] = (e.currentTarget as HTMLInputElement).value;
                            updatedRepos[index] = {
                              ...updatedRepos[index],
                              worktree_post_create_commands: updatedCmds,
                            };
                            repos.updateList(updatedRepos);
                          }}
                        />
                        <button
                          class="p-1 text-text-muted hover:text-error transition-colors shrink-0"
                          onclick={() => {
                            const updatedRepos = [...$repos.list];
                            const updatedCmds = [...(repo.worktree_post_create_commands || [])];
                            updatedCmds.splice(cmdIndex, 1);
                            updatedRepos[index] = {
                              ...updatedRepos[index],
                              worktree_post_create_commands: updatedCmds,
                            };
                            repos.updateList(updatedRepos);
                          }}
                          title="Remove command"
                        >&times;</button>
                      </div>
                    {/each}
                  </div>
                {:else}
                  <div class="text-text-muted text-[10px] italic">No commands configured</div>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <div class="border-t border-border pt-4">
    <h3 class="text-sm font-medium text-text-secondary mb-2">
      Add Repository
    </h3>
    <div class="space-y-2">
      <div class="flex gap-2">
        <input
          type="text"
          class="flex-1 px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
          bind:value={newRepoPath}
          placeholder="Path to repository"
        />
        <button
          class="px-3 py-2 bg-surface-elevated hover:bg-border rounded text-sm transition-colors"
          onclick={browseFolder}>Browse</button
        >
      </div>
      <input
        type="text"
        class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
        bind:value={newRepoName}
        placeholder="Display name"
      />
      <button
        class="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded text-sm transition-colors"
        onclick={addRepo}
        disabled={!newRepoPath || !newRepoName}>Add Repository</button
      >
    </div>
  </div>
</div>
