<script lang="ts">
  import { settings, type McpServerConfig } from "$lib/stores/settings";
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-shell";
  import type { McpAuthType, McpOAuthConfig } from "$lib/types/mcp";
  import "./toggle.css";

  interface TestResult {
    success: boolean;
    error: string | null;
  }

  interface OAuthFlowResult {
    authorization_url: string;
    state: string;
    code_verifier: string;
  }

  // New server form state
  let isAddingServer = $state(false);
  let editingServerId = $state<string | null>(null);
  let newServer = $state<Partial<McpServerConfig>>({
    name: "",
    server_type: "stdio",
    command: "",
    args: [],
    env: {},
    url: "",
    enabled: true,
    auth_type: "none",
  });
  let argsInput = $state("");
  let envInput = $state("");

  // OAuth configuration state
  let oauthConfig = $state<McpOAuthConfig>({
    client_id: "",
    authorization_url: "",
    token_url: "",
    scopes: "",
    redirect_uri: "",
  });
  let bearerToken = $state("");

  // OAuth flow state
  let pendingOAuthServerId = $state<string | null>(null);
  let pendingCodeVerifier = $state<string>("");
  let oauthCode = $state("");
  let authStatus = $state<Record<string, { authenticated: boolean; error?: string }>>({});

  // Testing state
  let testingServerId = $state<string | null>(null);
  let testResults = $state<Record<string, TestResult>>({});

  function resetNewServer() {
    newServer = {
      name: "",
      server_type: "stdio",
      command: "",
      args: [],
      env: {},
      url: "",
      enabled: true,
      auth_type: "none",
    };
    argsInput = "";
    envInput = "";
    oauthConfig = {
      client_id: "",
      authorization_url: "",
      token_url: "",
      scopes: "",
      redirect_uri: "",
    };
    bearerToken = "";
    isAddingServer = false;
    editingServerId = null;
  }

  // Check authentication status for all servers on mount
  async function checkAuthStatus() {
    for (const server of $settings.mcp.servers) {
      if (server.auth_type && server.auth_type !== "none") {
        try {
          const hasToken = await invoke<boolean>("has_mcp_token", { serverId: server.id });
          authStatus[server.id] = { authenticated: hasToken };
        } catch {
          authStatus[server.id] = { authenticated: false };
        }
      }
    }
  }

  // Run on component mount
  $effect(() => {
    checkAuthStatus();
  });

  function parseArgs(input: string): string[] {
    if (!input.trim()) return [];
    // Simple split by whitespace, respecting quoted strings
    const args: string[] = [];
    let current = "";
    let inQuotes = false;
    let quoteChar = "";

    for (const char of input) {
      if ((char === '"' || char === "'") && !inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar && inQuotes) {
        inQuotes = false;
        quoteChar = "";
      } else if (char === " " && !inQuotes) {
        if (current) {
          args.push(current);
          current = "";
        }
      } else {
        current += char;
      }
    }
    if (current) args.push(current);
    return args;
  }

  function parseEnv(input: string): Record<string, string> {
    if (!input.trim()) return {};
    const env: Record<string, string> = {};
    // Parse KEY=VALUE pairs, one per line or comma-separated
    const pairs = input.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    for (const pair of pairs) {
      const eqIndex = pair.indexOf("=");
      if (eqIndex > 0) {
        const key = pair.substring(0, eqIndex).trim();
        const value = pair.substring(eqIndex + 1).trim();
        env[key] = value;
      }
    }
    return env;
  }

  function generateId(): string {
    return `mcp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  async function addServer() {
    if (!newServer.name?.trim()) return;

    const serverId = editingServerId || generateId();
    const authType = newServer.server_type !== "stdio" ? (newServer.auth_type || "none") : "none";

    const server: McpServerConfig = {
      id: serverId,
      name: newServer.name.trim(),
      server_type: newServer.server_type || "stdio",
      command: newServer.server_type === "stdio" ? newServer.command?.trim() : undefined,
      args: newServer.server_type === "stdio" ? parseArgs(argsInput) : undefined,
      env: Object.keys(parseEnv(envInput)).length > 0 ? parseEnv(envInput) : undefined,
      url: newServer.server_type !== "stdio" ? newServer.url?.trim() : undefined,
      enabled: newServer.enabled ?? true,
      auth_type: authType as McpAuthType,
      oauth: authType === "oauth" ? {
        client_id: oauthConfig.client_id || undefined,
        authorization_url: oauthConfig.authorization_url || undefined,
        token_url: oauthConfig.token_url || undefined,
        scopes: oauthConfig.scopes || undefined,
        redirect_uri: oauthConfig.redirect_uri || undefined,
      } : undefined,
    };

    settings.update((s) => {
      const servers = [...s.mcp.servers];
      if (editingServerId) {
        // Update existing
        const index = servers.findIndex(srv => srv.id === editingServerId);
        if (index >= 0) {
          servers[index] = server;
        }
      } else {
        // Add new
        servers.push(server);
      }
      return { ...s, mcp: { ...s.mcp, servers } };
    });

    await invoke("save_config", { newConfig: $settings });

    // Save bearer token if provided
    if (authType === "bearer_token" && bearerToken.trim()) {
      try {
        await invoke("save_mcp_bearer_token", { serverId, token: bearerToken.trim() });
        authStatus[serverId] = { authenticated: true };
      } catch (e) {
        console.error("Failed to save bearer token:", e);
      }
    }

    resetNewServer();
  }

  function editServer(server: McpServerConfig) {
    editingServerId = server.id;
    newServer = { ...server };
    argsInput = server.args?.join(" ") || "";
    envInput = server.env
      ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join("\n")
      : "";
    // Populate OAuth config if present
    if (server.oauth) {
      oauthConfig = {
        client_id: server.oauth.client_id || "",
        authorization_url: server.oauth.authorization_url || "",
        token_url: server.oauth.token_url || "",
        scopes: server.oauth.scopes || "",
        redirect_uri: server.oauth.redirect_uri || "",
      };
    } else {
      oauthConfig = {
        client_id: "",
        authorization_url: "",
        token_url: "",
        scopes: "",
        redirect_uri: "",
      };
    }
    bearerToken = ""; // Don't show existing token, just allow setting new one
    isAddingServer = true;
  }

  // OAuth flow functions
  async function startOAuthFlow(serverId: string) {
    try {
      const result = await invoke<OAuthFlowResult>("start_mcp_oauth_flow", { serverId });
      pendingOAuthServerId = serverId;
      pendingCodeVerifier = result.code_verifier;
      // Open authorization URL in browser
      await open(result.authorization_url);
    } catch (e) {
      console.error("Failed to start OAuth flow:", e);
      authStatus[serverId] = { authenticated: false, error: String(e) };
    }
  }

  async function completeOAuthFlow() {
    if (!pendingOAuthServerId || !oauthCode.trim()) return;

    const serverId = pendingOAuthServerId;
    try {
      await invoke("exchange_mcp_oauth_code", {
        serverId,
        code: oauthCode.trim(),
        codeVerifier: pendingCodeVerifier,
      });
      authStatus[serverId] = { authenticated: true };
      pendingOAuthServerId = null;
      pendingCodeVerifier = "";
      oauthCode = "";
    } catch (e) {
      console.error("Failed to complete OAuth flow:", e);
      authStatus[serverId] = { authenticated: false, error: String(e) };
    }
  }

  async function logout(serverId: string, authType: McpAuthType) {
    try {
      if (authType === "bearer_token") {
        await invoke("delete_mcp_bearer_token", { serverId });
      } else if (authType === "oauth") {
        await invoke("delete_mcp_oauth_tokens", { serverId });
      }
      authStatus[serverId] = { authenticated: false };
    } catch (e) {
      console.error("Failed to logout:", e);
    }
  }

  async function deleteServer(id: string) {
    if (!confirm("Are you sure you want to delete this MCP server?")) return;

    settings.update((s) => ({
      ...s,
      mcp: {
        ...s.mcp,
        servers: s.mcp.servers.filter((srv) => srv.id !== id),
      },
    }));

    await invoke("save_config", { newConfig: $settings });
    delete testResults[id];
  }

  async function toggleServer(id: string) {
    settings.update((s) => ({
      ...s,
      mcp: {
        ...s.mcp,
        servers: s.mcp.servers.map((srv) =>
          srv.id === id ? { ...srv, enabled: !srv.enabled } : srv
        ),
      },
    }));
    await invoke("save_config", { newConfig: $settings });
  }

  async function testServer(server: McpServerConfig) {
    if (server.server_type === "stdio") {
      // Can't test stdio servers without actually running them
      testResults[server.id] = {
        success: true,
        error: null,
      };
      return;
    }

    testingServerId = server.id;
    try {
      const result = await invoke<TestResult>("test_mcp_server", {
        serverId: server.id
      });
      testResults[server.id] = result;
    } catch (error) {
      testResults[server.id] = {
        success: false,
        error: String(error),
      };
    }
    testingServerId = null;
  }

  function getServerTypeLabel(type: string): string {
    switch (type) {
      case "stdio": return "Command (stdio)";
      case "http": return "HTTP";
      case "sse": return "SSE";
      default: return type;
    }
  }
</script>

<div class="space-y-4">
  <!-- Header -->
  <div class="p-3 bg-surface-elevated rounded border border-border">
    <div class="flex items-center gap-2 mb-2">
      <svg class="w-5 h-5 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
      <span class="text-sm font-medium text-text-primary">MCP Servers</span>
    </div>
    <p class="text-xs text-text-muted">
      Configure external MCP (Model Context Protocol) servers to extend the AI's capabilities
      with custom tools. Servers are started on-demand when sessions need them.
    </p>
  </div>

  <!-- Server List -->
  {#if $settings.mcp.servers.length > 0}
    <div class="space-y-2">
      {#each $settings.mcp.servers as server (server.id)}
        <div class="p-3 bg-surface-elevated rounded border border-border">
          <div class="flex items-start justify-between gap-3">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-medium text-text-primary truncate">{server.name}</span>
                <span class="text-xs px-1.5 py-0.5 rounded bg-border text-text-muted">
                  {getServerTypeLabel(server.server_type)}
                </span>
                {#if !server.enabled}
                  <span class="text-xs px-1.5 py-0.5 rounded bg-warning/20 text-warning">
                    Disabled
                  </span>
                {/if}
                {#if server.auth_type && server.auth_type !== "none"}
                  {#if authStatus[server.id]?.authenticated}
                    <span class="text-xs px-1.5 py-0.5 rounded bg-success/20 text-success">
                      Authenticated
                    </span>
                  {:else}
                    <span class="text-xs px-1.5 py-0.5 rounded bg-error/20 text-error">
                      Not authenticated
                    </span>
                  {/if}
                {/if}
              </div>
              <p class="text-xs text-text-muted mt-1 truncate">
                {#if server.server_type === "stdio"}
                  {server.command} {server.args?.join(" ") || ""}
                {:else}
                  {server.url}
                  {#if server.auth_type === "oauth"}
                    <span class="ml-2 text-accent">(OAuth)</span>
                  {:else if server.auth_type === "bearer_token"}
                    <span class="ml-2 text-accent">(Bearer Token)</span>
                  {/if}
                {/if}
              </p>

              {#if testResults[server.id]}
                <p class="text-xs mt-1" class:text-success={testResults[server.id].success} class:text-error={!testResults[server.id].success}>
                  {#if testResults[server.id].success}
                    Connection successful
                  {:else}
                    {testResults[server.id].error}
                  {/if}
                </p>
              {/if}
            </div>

            <div class="flex items-center gap-1">
              <!-- Auth buttons for OAuth/Bearer Token servers -->
              {#if server.auth_type === "oauth"}
                {#if authStatus[server.id]?.authenticated}
                  <button
                    class="p-1.5 text-text-muted hover:text-warning hover:bg-warning/10 rounded transition-colors"
                    onclick={() => logout(server.id, "oauth")}
                    title="Logout"
                  >
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                    </svg>
                  </button>
                {:else}
                  <button
                    class="p-1.5 text-accent hover:text-accent-hover hover:bg-accent/10 rounded transition-colors"
                    onclick={() => startOAuthFlow(server.id)}
                    title="Authorize with OAuth"
                  >
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                    </svg>
                  </button>
                {/if}
              {:else if server.auth_type === "bearer_token"}
                {#if authStatus[server.id]?.authenticated}
                  <button
                    class="p-1.5 text-text-muted hover:text-warning hover:bg-warning/10 rounded transition-colors"
                    onclick={() => logout(server.id, "bearer_token")}
                    title="Clear token"
                  >
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                    </svg>
                  </button>
                {/if}
              {/if}
              {#if server.server_type !== "stdio"}
                <button
                  class="p-1.5 text-text-muted hover:text-text-primary hover:bg-border rounded transition-colors"
                  onclick={() => testServer(server)}
                  disabled={testingServerId === server.id}
                  title="Test connection"
                >
                  {#if testingServerId === server.id}
                    <div class="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
                  {:else}
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                    </svg>
                  {/if}
                </button>
              {/if}
              <button
                class="p-1.5 text-text-muted hover:text-text-primary hover:bg-border rounded transition-colors"
                onclick={() => toggleServer(server.id)}
                title={server.enabled ? "Disable" : "Enable"}
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {#if server.enabled}
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  {:else}
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
                  {/if}
                </svg>
              </button>
              <button
                class="p-1.5 text-text-muted hover:text-text-primary hover:bg-border rounded transition-colors"
                onclick={() => editServer(server)}
                title="Edit"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                class="p-1.5 text-text-muted hover:text-error hover:bg-error/10 rounded transition-colors"
                onclick={() => deleteServer(server.id)}
                title="Delete"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {:else if !isAddingServer}
    <div class="p-6 text-center text-text-muted border-2 border-dashed border-border rounded">
      <svg class="w-8 h-8 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
      </svg>
      <p class="text-sm">No MCP servers configured</p>
      <p class="text-xs mt-1">Add a server to extend the AI's capabilities</p>
    </div>
  {/if}

  <!-- Add/Edit Server Form -->
  {#if isAddingServer}
    <div class="p-4 bg-surface-elevated rounded border border-accent">
      <h3 class="text-sm font-medium text-text-primary mb-3">
        {editingServerId ? "Edit Server" : "Add New Server"}
      </h3>

      <div class="space-y-3">
        <div>
          <label class="block text-sm font-medium text-text-secondary mb-1">Name</label>
          <input
            type="text"
            class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
            bind:value={newServer.name}
            placeholder="My MCP Server"
          />
        </div>

        <div>
          <label class="block text-sm font-medium text-text-secondary mb-1">Server Type</label>
          <select
            class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
            bind:value={newServer.server_type}
          >
            <option value="stdio">Command (stdio)</option>
            <option value="http">HTTP</option>
            <option value="sse">SSE (Server-Sent Events)</option>
          </select>
        </div>

        {#if newServer.server_type === "stdio"}
          <div>
            <label class="block text-sm font-medium text-text-secondary mb-1">Command</label>
            <input
              type="text"
              class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
              bind:value={newServer.command}
              placeholder="npx -y @modelcontextprotocol/server-filesystem"
            />
          </div>

          <div>
            <label class="block text-sm font-medium text-text-secondary mb-1">Arguments</label>
            <input
              type="text"
              class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
              bind:value={argsInput}
              placeholder="/path/to/directory"
            />
            <p class="text-xs text-text-muted mt-1">Space-separated, use quotes for arguments with spaces</p>
          </div>

          <div>
            <label class="block text-sm font-medium text-text-secondary mb-1">Environment Variables</label>
            <textarea
              class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent resize-none"
              rows="2"
              bind:value={envInput}
              placeholder="KEY=value&#10;ANOTHER_KEY=another_value"
            ></textarea>
            <p class="text-xs text-text-muted mt-1">One per line: KEY=value</p>
          </div>
        {:else}
          <div>
            <label class="block text-sm font-medium text-text-secondary mb-1">URL</label>
            <input
              type="text"
              class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
              bind:value={newServer.url}
              placeholder={newServer.server_type === "sse" ? "http://localhost:3000/sse" : "http://localhost:3000"}
            />
          </div>

          <!-- Authentication Type -->
          <div>
            <label class="block text-sm font-medium text-text-secondary mb-1">Authentication</label>
            <select
              class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
              bind:value={newServer.auth_type}
            >
              <option value="none">None</option>
              <option value="bearer_token">Bearer Token (API Key)</option>
              <option value="oauth">OAuth 2.0</option>
            </select>
          </div>

          <!-- Bearer Token Input -->
          {#if newServer.auth_type === "bearer_token"}
            <div>
              <label class="block text-sm font-medium text-text-secondary mb-1">Bearer Token</label>
              <input
                type="password"
                class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
                bind:value={bearerToken}
                placeholder="Enter API key or bearer token"
              />
              <p class="text-xs text-text-muted mt-1">Token is stored securely in system keychain</p>
            </div>
          {/if}

          <!-- OAuth Configuration -->
          {#if newServer.auth_type === "oauth"}
            <div class="space-y-3 p-3 bg-background rounded border border-border">
              <p class="text-xs text-text-muted font-medium">OAuth 2.0 Configuration</p>

              <div>
                <label class="block text-xs font-medium text-text-secondary mb-1">Client ID</label>
                <input
                  type="text"
                  class="w-full px-2 py-1.5 bg-surface-elevated border border-border rounded text-sm focus:outline-none focus:border-accent"
                  bind:value={oauthConfig.client_id}
                  placeholder="your-client-id"
                />
              </div>

              <div>
                <label class="block text-xs font-medium text-text-secondary mb-1">Authorization URL</label>
                <input
                  type="text"
                  class="w-full px-2 py-1.5 bg-surface-elevated border border-border rounded text-sm focus:outline-none focus:border-accent"
                  bind:value={oauthConfig.authorization_url}
                  placeholder="https://auth.example.com/authorize"
                />
              </div>

              <div>
                <label class="block text-xs font-medium text-text-secondary mb-1">Token URL</label>
                <input
                  type="text"
                  class="w-full px-2 py-1.5 bg-surface-elevated border border-border rounded text-sm focus:outline-none focus:border-accent"
                  bind:value={oauthConfig.token_url}
                  placeholder="https://auth.example.com/token"
                />
              </div>

              <div>
                <label class="block text-xs font-medium text-text-secondary mb-1">Scopes (optional)</label>
                <input
                  type="text"
                  class="w-full px-2 py-1.5 bg-surface-elevated border border-border rounded text-sm focus:outline-none focus:border-accent"
                  bind:value={oauthConfig.scopes}
                  placeholder="read write (space-separated)"
                />
              </div>

              <div>
                <label class="block text-xs font-medium text-text-secondary mb-1">Redirect URI (optional)</label>
                <input
                  type="text"
                  class="w-full px-2 py-1.5 bg-surface-elevated border border-border rounded text-sm focus:outline-none focus:border-accent"
                  bind:value={oauthConfig.redirect_uri}
                  placeholder="http://localhost:19256/callback"
                />
                <p class="text-xs text-text-muted mt-1">Default: http://localhost:19256/callback</p>
              </div>
            </div>
          {/if}
        {/if}

        <div class="flex items-center justify-between pt-2">
          <label class="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              class="toggle"
              bind:checked={newServer.enabled}
            />
            Enabled
          </label>

          <div class="flex gap-2">
            <button
              class="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:bg-border rounded transition-colors"
              onclick={resetNewServer}
            >
              Cancel
            </button>
            <button
              class="px-3 py-1.5 text-sm bg-accent hover:bg-accent-hover text-white rounded transition-colors"
              onclick={addServer}
              disabled={!newServer.name?.trim()}
            >
              {editingServerId ? "Save Changes" : "Add Server"}
            </button>
          </div>
        </div>
      </div>
    </div>
  {:else}
    <button
      class="w-full p-3 border-2 border-dashed border-border hover:border-accent rounded text-text-muted hover:text-accent transition-colors flex items-center justify-center gap-2"
      onclick={() => (isAddingServer = true)}
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
      </svg>
      Add MCP Server
    </button>
  {/if}

  <!-- OAuth Code Entry Modal -->
  {#if pendingOAuthServerId}
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div class="bg-surface-elevated p-6 rounded-lg border border-border max-w-md w-full mx-4">
        <h3 class="text-lg font-medium text-text-primary mb-2">Complete OAuth Authorization</h3>
        <p class="text-sm text-text-muted mb-4">
          After authorizing in your browser, paste the authorization code below:
        </p>
        <input
          type="text"
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent mb-4"
          bind:value={oauthCode}
          placeholder="Paste authorization code here"
        />
        <div class="flex justify-end gap-2">
          <button
            class="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-border rounded transition-colors"
            onclick={() => { pendingOAuthServerId = null; oauthCode = ""; }}
          >
            Cancel
          </button>
          <button
            class="px-4 py-2 text-sm bg-accent hover:bg-accent-hover text-white rounded transition-colors"
            onclick={completeOAuthFlow}
            disabled={!oauthCode.trim()}
          >
            Complete Authorization
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Info Section -->
  <div class="border-t border-border pt-4 mt-4">
    <h3 class="text-sm font-medium text-text-secondary mb-2">About MCP</h3>
    <div class="text-xs text-text-muted space-y-2">
      <p>
        <strong>Model Context Protocol (MCP)</strong> allows external tools and services
        to extend the AI's capabilities. MCP servers provide additional tools that the AI
        can use during sessions.
      </p>
      <p>
        <strong>Server Types:</strong>
      </p>
      <ul class="list-disc list-inside ml-2 space-y-1">
        <li><strong>Stdio:</strong> Local command-line tools (most common)</li>
        <li><strong>HTTP:</strong> Remote HTTP-based MCP servers</li>
        <li><strong>SSE:</strong> Server-Sent Events for real-time communication</li>
      </ul>
      <p class="mt-2">
        <strong>Authentication:</strong> HTTP/SSE servers can use Bearer Token (API key) or OAuth 2.0 authentication.
        Tokens are stored securely in your system's keychain.
      </p>
      <p class="mt-2">
        Learn more at <a
          href="https://modelcontextprotocol.io"
          class="text-accent hover:underline"
          target="_blank"
          rel="noopener noreferrer"
        >modelcontextprotocol.io</a>
      </p>
    </div>
  </div>
</div>
