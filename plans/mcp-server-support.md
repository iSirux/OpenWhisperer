# Feature: MCP Server Support

## Overview
Add support for external MCP (Model Context Protocol) servers to OpenWhisperer, allowing users to extend Claude's capabilities with custom tools from stdio-based processes and remote HTTP/SSE servers. MCP servers can be configured globally or associated with specific repositories, and are started on-demand when sessions need them.

## Requirements
Based on user preferences:
- **Server Types**: Stdio + HTTP/SSE (local processes and remote servers)
- **Configuration**: Global + Per-repository MCP server associations
- **Lifecycle**: On-demand startup (lazy loading when sessions need them)
- **UI**: Settings tab + runtime status indicators (no active controls)

## Decisions Made
| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Server types | Stdio + HTTP/SSE | Covers most use cases: local tools via stdio, remote services via HTTP/SSE |
| Configuration scope | Global + Per-repo | Flexibility to have common tools available everywhere plus project-specific tools |
| Server lifecycle | On-demand | Saves resources by only starting servers when actually needed |
| UI complexity | Settings + status indicators | Users manage servers in settings, runtime shows passive status (no start/stop controls) |

## Alternatives Considered
- **Auto-start on app launch**: Rejected - wastes resources if user doesn't need MCP tools in current session
- **Per-session server selection**: Rejected - adds UI complexity; per-repo covers most use cases
- **Full management UI with logs**: Rejected - overkill for v1; status indicators included but no active controls or log viewing

## Implementation Plan

### Phase 1: Configuration & Types
Add MCP server configuration to the Rust config system:

- [ ] Add `McpServerType` enum (Stdio, Http, Sse) in `config.rs`
- [ ] Add `McpServerConfig` struct with fields:
  - `id: String` - Unique identifier
  - `name: String` - Display name
  - `server_type: McpServerType`
  - `command: Option<String>` - For stdio servers
  - `args: Option<Vec<String>>` - For stdio servers
  - `env: Option<HashMap<String, String>>` - Environment variables
  - `url: Option<String>` - For HTTP/SSE servers
  - `enabled: bool` - Whether server is active
- [ ] Add `McpConfig` struct to `AppConfig`:
  - `servers: Vec<McpServerConfig>` - Global MCP servers
- [ ] Add `mcp_servers: Option<Vec<String>>` to `RepoConfig` (list of server IDs to use for this repo)
- [ ] Create TypeScript types in `src/lib/types/mcp.ts` mirroring Rust types

### Phase 2: Settings UI
Create MCP settings tab for managing servers:

- [ ] Create `src/lib/components/settings/McpTab.svelte`:
  - List of configured MCP servers with name, type, status badge
  - Add new server form (type selector, command/url input, args, env vars)
  - Edit existing server (inline or modal)
  - Delete server with confirmation
  - Test connection button for HTTP/SSE servers
- [ ] Add "MCP Servers" option to per-repo settings in `ReposTab.svelte`:
  - Multi-select dropdown to associate servers with repository
  - Shows which global servers are enabled for this repo

### Phase 3: Sidecar Integration
Pass MCP server configs to the sidecar for session creation:

- [ ] Extend `CreateMessage` type in sidecar to accept `mcp_servers` config:
  ```typescript
  interface McpServerConfig {
    id: string;
    name: string;
    type: 'stdio' | 'http' | 'sse';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
  }
  ```
- [ ] Modify `handleCreate()` to register MCP servers with the SDK:
  - For stdio servers: Use `McpStdioServerConfig` format
  - For HTTP servers: Use `McpHttpServerConfig` format
  - For SSE servers: Use `McpSSEServerConfig` format
- [ ] Add server configs to `Options.mcpServers` object
- [ ] Update `Options.allowedTools` to include MCP tool prefixes

### Phase 4: Rust Backend Commands
Add Tauri commands for MCP management:

- [ ] Create `src-tauri/src/commands/mcp_cmds.rs`:
  - `get_mcp_servers()` - Return all configured servers
  - `add_mcp_server(config)` - Add new server to config
  - `update_mcp_server(id, config)` - Update existing server
  - `delete_mcp_server(id)` - Remove server from config
  - `test_mcp_server(id)` - Test HTTP/SSE server connectivity
- [ ] Register commands in `lib.rs`
- [ ] Add to command handler in frontend

### Phase 5: Session Integration
Wire MCP servers into session creation flow:

- [ ] Update `sdkSessions.ts` `createSession()`:
  - Determine which MCP servers to include based on:
    1. If repo has specific MCP servers configured, use those
    2. Otherwise, include all enabled global servers
  - Pass server configs to sidecar via create message
- [ ] Update `src-tauri/src/commands/sdk_cmds.rs` `create_sdk_session()`:
  - Accept MCP server configs
  - Forward to sidecar in create message
- [ ] Update `src-tauri/src/sidecar.rs` `OutboundMessage::Create`:
  - Add `mcp_servers: Vec<McpServerConfig>` field

### Phase 6: Runtime Status Indicators
Add passive status display for active MCP servers:

- [ ] Create `src/lib/components/sdk/McpStatusBar.svelte`:
  - Compact bar showing connected MCP servers for current session
  - Status badges: connecting (yellow), connected (green), error (red)
  - Tooltip showing server name and available tool count
  - Clicking opens settings MCP tab
- [ ] Add MCP server status tracking to sidecar:
  - Emit `sdk-mcp-status-${id}` events on server connect/disconnect/error
  - Include server id, status, and tool count in event payload
- [ ] Update `sdkSessions.ts` to track MCP server states per session
- [ ] Add `McpStatusBar` to `SdkSessionHeader.svelte`

### Phase 7: Testing & Documentation
- [ ] Test stdio MCP server (e.g., filesystem MCP server)
- [ ] Test HTTP/SSE MCP server connectivity
- [ ] Test per-repo MCP server association
- [ ] Test status indicators update correctly (connect/disconnect/error states)
- [ ] Update CLAUDE.md with MCP configuration documentation

## Technical Details

### SDK MCP Server Config Types
From `@anthropic-ai/claude-agent-sdk`:
```typescript
// Stdio server
{ command: string, args?: string[], env?: Record<string, string> }

// HTTP server
{ url: string }

// SSE server
{ url: string }
```

## Open Questions
1. Should we validate MCP server configs before saving? (e.g., check command exists)
2. How should we handle MCP server startup failures? (silent fail vs error toast)
3. Should we add a way to view available tools from an MCP server before using it?
4. Should per-repo MCP settings override global or merge with global?

## File Changes Summary

### New Files
- `src-tauri/src/commands/mcp_cmds.rs` - MCP Tauri commands
- `src/lib/components/settings/McpTab.svelte` - MCP settings UI
- `src/lib/components/sdk/McpStatusBar.svelte` - Runtime status indicator
- `src/lib/types/mcp.ts` - TypeScript MCP types

### Modified Files
- `src-tauri/src/config.rs` - Add MCP config types
- `src-tauri/src/lib.rs` - Register MCP commands
- `src-tauri/src/commands/mod.rs` - Export MCP commands
- `src-tauri/src/commands/sdk_cmds.rs` - Pass MCP configs to sidecar
- `src-tauri/src/sidecar.rs` - Add MCP to OutboundMessage
- `src-tauri/sidecar/src/index.ts` - Register external MCP servers
- `src/lib/stores/sdkSessions.ts` - Include MCP servers in session creation, track MCP status
- `src/lib/components/SdkSessionHeader.svelte` - Add McpStatusBar
- `src/routes/settings/+page.svelte` - Add MCP tab
- `CLAUDE.md` - Document MCP configuration
