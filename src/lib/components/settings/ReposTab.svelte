<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";

  interface RepoDescriptionResult {
    description: string;
    keywords: string[];
    vocabulary: string[];
  }

  let newRepoPath = $state("");
  let newRepoName = $state("");
  let generatingIndices = $state(new Set<number>());
  let generatingClaudeIndices = $state(new Set<number>());
  let generatingBatch = $state(false);
  let batchProgress = $state({ current: 0, total: 0, failed: 0 });

  // Track pending Claude generation requests (id -> index)
  const pendingClaudeRequests = new Map<string, number>();

  async function generateRepoDescriptionWithClaude(index: number) {
    const repo = $settings.repos[index];
    if (!repo || generatingClaudeIndices.has(index)) return false;

    const requestId = `claude-repo-${index}-${Date.now()}`;
    pendingClaudeRequests.set(requestId, index);
    generatingClaudeIndices = new Set([...generatingClaudeIndices, index]);

    // Set up event listeners for this request
    const resultListener = await listen<RepoDescriptionResult>(
      `repo-description-result-${requestId}`,
      (event) => {
        const idx = pendingClaudeRequests.get(requestId);
        if (idx !== undefined) {
          // Update the repo's description, keywords, and vocabulary in settings
          const updatedRepos = [...$settings.repos];
          updatedRepos[idx] = {
            ...updatedRepos[idx],
            description: event.payload.description,
            keywords: event.payload.keywords,
            vocabulary: event.payload.vocabulary,
          };
          settings.update((s) => ({ ...s, repos: updatedRepos }));
          pendingClaudeRequests.delete(requestId);
          generatingClaudeIndices = new Set([...generatingClaudeIndices].filter(i => i !== idx));
        }
        resultListener();
        errorListener();
      }
    );

    const errorListener = await listen<string>(
      `repo-description-error-${requestId}`,
      (event) => {
        const idx = pendingClaudeRequests.get(requestId);
        if (idx !== undefined) {
          console.error("Claude repo description failed:", event.payload);
          alert(`Failed to generate description with Claude: ${event.payload}`);
          pendingClaudeRequests.delete(requestId);
          generatingClaudeIndices = new Set([...generatingClaudeIndices].filter(i => i !== idx));
        }
        resultListener();
        errorListener();
      }
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

  async function addRepo() {
    console.log(
      "[addRepo] Called with path:",
      newRepoPath,
      "name:",
      newRepoName
    );
    if (!newRepoPath || !newRepoName) {
      console.log("[addRepo] Missing path or name, returning");
      return;
    }
    console.log("[addRepo] Calling settings.addRepo...");
    try {
      await settings.addRepo(newRepoPath, newRepoName);
      console.log("[addRepo] Successfully added repo");
      newRepoPath = "";
      newRepoName = "";
    } catch (error) {
      console.error("[addRepo] Failed to add repo:", error);
    }
  }

  async function removeRepo(index: number) {
    console.log("[removeRepo] Removing repo at index:", index);
    try {
      await settings.removeRepo(index);
      console.log("[removeRepo] Successfully removed repo");
    } catch (error) {
      console.error("[removeRepo] Failed to remove repo:", error);
    }
  }

  async function generateRepoDescription(index: number, silent = false) {
    const repo = $settings.repos[index];
    if (!repo || generatingIndices.has(index)) return false;

    generatingIndices = new Set([...generatingIndices, index]);
    try {
      const result = await invoke<RepoDescriptionResult>(
        "generate_repo_description",
        {
          repoPath: repo.path,
          repoName: repo.name,
        }
      );

      // Update the repo's description, keywords, and vocabulary in settings
      const updatedRepos = [...$settings.repos];
      updatedRepos[index] = {
        ...updatedRepos[index],
        description: result.description,
        keywords: result.keywords,
        vocabulary: result.vocabulary,
      };
      settings.update((s) => ({ ...s, repos: updatedRepos }));
      return true;
    } catch (error) {
      console.error("Failed to generate repo description:", error);
      if (!silent) {
        alert(`Failed to generate description: ${error}`);
      }
      return false;
    } finally {
      generatingIndices = new Set([...generatingIndices].filter(i => i !== index));
    }
  }

  // Get repos that need descriptions generated
  function getReposNeedingDescriptions(): number[] {
    return $settings.repos
      .map((repo, index) => ({ repo, index }))
      .filter(({ repo }) => !repo.description)
      .map(({ index }) => index);
  }

  async function generateAllDescriptions() {
    const indices = getReposNeedingDescriptions();
    if (indices.length === 0) {
      alert("All repositories already have descriptions.");
      return;
    }

    generatingBatch = true;
    batchProgress = { current: 0, total: indices.length, failed: 0 };

    // Process all repos in parallel
    const results = await Promise.all(
      indices.map(async (index) => {
        const success = await generateRepoDescription(index, true);
        batchProgress = {
          ...batchProgress,
          current: batchProgress.current + 1,
          failed: batchProgress.failed + (success ? 0 : 1),
        };
        return success;
      })
    );

    generatingBatch = false;

    const failed = results.filter((r) => !r).length;
    if (failed > 0) {
      alert(
        `Generated ${batchProgress.total - failed} of ${batchProgress.total} descriptions. ${failed} failed.`
      );
    }
  }

  async function browseFolder() {
    console.log("[browseFolder] Opening folder dialog...");
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      console.log(
        "[browseFolder] Dialog plugin imported, calling openDialog..."
      );
      const selected = await openDialog({
        directory: true,
        multiple: false,
      });
      console.log("[browseFolder] Dialog result:", selected);
      if (selected) {
        newRepoPath = selected as string;
        console.log("[browseFolder] Set newRepoPath to:", newRepoPath);
        if (!newRepoName) {
          newRepoName = newRepoPath.split(/[/\\]/).pop() || "";
          console.log("[browseFolder] Auto-set newRepoName to:", newRepoName);
        }
      } else {
        console.log("[browseFolder] No folder selected (user cancelled)");
      }
    } catch (error) {
      console.error("[browseFolder] Failed to open folder dialog:", error);
    }
  }
</script>

<div class="space-y-4">
  <!-- Generate All button -->
  {#if $settings.repos.length > 0 && $settings.llm.enabled}
    <div class="flex items-center justify-between">
      <div class="text-xs text-text-muted">
        {#if generatingBatch}
          Generating {batchProgress.current}/{batchProgress.total}...
        {:else}
          {getReposNeedingDescriptions().length} of {$settings.repos.length} repos need descriptions
        {/if}
      </div>
      <button
        class="flex items-center gap-1.5 px-3 py-1.5 bg-accent/10 hover:bg-accent/20 text-accent rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        onclick={generateAllDescriptions}
        disabled={generatingBatch || generatingIndices.size > 0 || getReposNeedingDescriptions().length === 0}
      >
        {#if generatingBatch}
          <svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          Generating...
        {:else}
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
          </svg>
          Generate All
        {/if}
      </button>
    </div>
  {/if}

  <div class="space-y-3">
    {#each $settings.repos as repo, index}
      <div class="p-3 bg-surface-elevated rounded space-y-2">
        <div class="flex items-start gap-2">
          <div class="flex-1 min-w-0">
            <div class="font-medium text-sm text-text-primary">
              {repo.name}
            </div>
            <div class="text-xs text-text-muted truncate">
              {repo.path}
            </div>
          </div>
          <div class="flex gap-1 shrink-0">
            <!-- Generate description with LLM button -->
            <button
              class="p-1.5 text-text-muted hover:text-accent transition-colors rounded hover:bg-border disabled:opacity-50"
              onclick={() => generateRepoDescription(index)}
              disabled={!$settings.llm.enabled || generatingIndices.has(index)}
              title={!$settings.llm.enabled
                ? "Enable LLM integration in LLM settings to generate descriptions"
                : "Generate with LLM (reads CLAUDE.md/README)"}
            >
              {#if generatingIndices.has(index)}
                <svg
                  class="w-4 h-4 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    class="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    stroke-width="4"
                  ></circle>
                  <path
                    class="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
              {:else}
                <!-- Sparkle/AI icon -->
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
                    d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
                  />
                </svg>
              {/if}
            </button>
            <!-- Generate description with Claude SDK button -->
            <button
              class="p-1.5 text-text-muted hover:text-orange-400 transition-colors rounded hover:bg-border disabled:opacity-50"
              onclick={() => generateRepoDescriptionWithClaude(index)}
              disabled={generatingClaudeIndices.has(index)}
              title="Generate with Claude (explores codebase with tools)"
            >
              {#if generatingClaudeIndices.has(index)}
                <svg
                  class="w-4 h-4 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    class="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    stroke-width="4"
                  ></circle>
                  <path
                    class="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
              {:else}
                <!-- Claude/robot icon -->
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
                    d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                  />
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
        {:else}
          <div class="text-xs text-text-muted italic">
            No description. Click ✨ (LLM) or 🖥️ (Claude) to generate.
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
