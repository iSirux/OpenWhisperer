<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { onMount } from "svelte";
  import RepoIcon from "$lib/components/RepoIcon.svelte";
  import { REPO_ICON_NAMES, REPO_COLORS, getDefaultRepoColor } from "$lib/utils/repoIcons";

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
          const updatedRepos = [...$settings.repos];
          updatedRepos[idx] = {
            ...updatedRepos[idx],
            description: event.payload.description,
            keywords: event.payload.keywords,
            vocabulary: event.payload.vocabulary,
            icon: event.payload.icon || updatedRepos[idx].icon,
            color: event.payload.color || updatedRepos[idx].color,
          };
          settings.update((s) => ({ ...s, repos: updatedRepos }));
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
    const repo = $settings.repos[index];
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
    const repo = $settings.repos[index];
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

  async function addRepo() {
    if (!newRepoPath || !newRepoName) return;
    try {
      await settings.addRepo(newRepoPath, newRepoName);
      newRepoPath = "";
      newRepoName = "";
    } catch (error) {
      console.error("[addRepo] Failed to add repo:", error);
    }
  }

  async function removeRepo(index: number) {
    try {
      await settings.removeRepo(index);
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
    {#each $settings.repos as repo, index}
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
              onclick={() => settings.setRepoActive(index, repo.active === false)}
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
                    const updatedRepos = [...$settings.repos];
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
                    settings.update((s) => ({ ...s, repos: updatedRepos }));
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
                    const updatedRepos = [...$settings.repos];
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
                    settings.update((s) => ({ ...s, repos: updatedRepos }));
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
                    const updatedRepos = [...$settings.repos];
                    updatedRepos[index] = { ...repo, tags: newTags };
                    settings.save({ ...$settings, repos: updatedRepos });
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
                    const updatedRepos = [...$settings.repos];
                    updatedRepos[index] = { ...repo, tags: [...currentTags, tag] };
                    settings.save({ ...$settings, repos: updatedRepos });
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
                  const updatedRepos = [...$settings.repos];
                  updatedRepos[index] = { ...updatedRepos[index], icon: (e.currentTarget as HTMLSelectElement).value };
                  settings.update((s) => ({ ...s, repos: updatedRepos }));
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
                  const updatedRepos = [...$settings.repos];
                  updatedRepos[index] = { ...updatedRepos[index], color: (e.currentTarget as HTMLInputElement).value };
                  settings.update((s) => ({ ...s, repos: updatedRepos }));
                }}
              />
              {#if repo.color}
                <button
                  class="text-text-muted hover:text-error transition-colors text-[10px]"
                  onclick={() => {
                    const updatedRepos = [...$settings.repos];
                    updatedRepos[index] = { ...updatedRepos[index], color: undefined };
                    settings.update((s) => ({ ...s, repos: updatedRepos }));
                  }}
                  title="Reset to default color"
                >&times;</button>
              {/if}
            </div>
          </div>
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
