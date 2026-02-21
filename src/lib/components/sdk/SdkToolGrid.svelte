<script lang="ts">
  import type { SdkMessage } from "$lib/stores/sdkSessions";

  let {
    tools,
  }: {
    tools: SdkMessage[];
  } = $props();

  // Track expanded tool for modal
  let expandedTool = $state<SdkMessage | null>(null);

  // SVG icons for tools (16x16 viewBox)
  function getToolSvgIcon(tool: string): string {
    const icons: Record<string, string> = {
      Read: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>`,
      Write: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/></svg>`,
      Edit: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/></svg>`,
      Bash: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM7.25 8a.749.749 0 0 1-.22.53l-2.25 2.25a.749.749 0 1 1-1.06-1.06L5.44 8 3.72 6.28a.749.749 0 1 1 1.06-1.06l2.25 2.25c.141.14.22.331.22.53Zm1.5 1.5h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z"/></svg>`,
      Grep: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/></svg>`,
      Glob: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/></svg>`,
      WebFetch: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM5.78 8.75a9.64 9.64 0 0 0 1.363 4.177c.255.426.542.832.857 1.215.245-.296.551-.705.857-1.215A9.64 9.64 0 0 0 10.22 8.75Zm4.44-1.5a9.64 9.64 0 0 0-1.363-4.177c-.307-.51-.612-.919-.857-1.215a9.927 9.927 0 0 0-.857 1.215A9.64 9.64 0 0 0 5.78 7.25Zm-5.944 1.5H1.543a6.507 6.507 0 0 0 4.666 5.5c-.123-.181-.24-.365-.352-.552-.715-1.192-1.437-2.874-1.581-4.948Zm-2.733-1.5h2.733c.144-2.074.866-3.756 1.58-4.948.12-.197.237-.381.353-.552a6.507 6.507 0 0 0-4.666 5.5Zm10.181 1.5c-.144 2.074-.866 3.756-1.581 4.948-.111.187-.229.371-.352.552a6.507 6.507 0 0 0 4.666-5.5Zm2.733-1.5a6.507 6.507 0 0 0-4.666-5.5c.123.181.24.365.352.552.715 1.192 1.437 2.874 1.581 4.948Z"/></svg>`,
      WebSearch: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/></svg>`,
      Task: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25c0-.966.784-1.75 1.75-1.75h2.5c.966 0 1.75.784 1.75 1.75v2.5A1.75 1.75 0 0 1 5.75 7.5H5v1.5h.25a1.75 1.75 0 0 1 1.75 1.75v2.5A1.75 1.75 0 0 1 5.25 15h-2.5A1.75 1.75 0 0 1 1 13.25v-2.5C1 9.784 1.784 9 2.75 9H3V7.5h-.25A1.75 1.75 0 0 1 1 5.75v-2.5Zm9.75 0A1.75 1.75 0 0 0 9.5 5v6a1.75 1.75 0 0 0 1.75 1.75h1a.75.75 0 0 1 .75.75v1.19l2.72-2.72a.75.75 0 0 1 .53-.22h.5a.25.25 0 0 0 .25-.25V5a.25.25 0 0 0-.25-.25h-5.5Z"/></svg>`,
      TodoWrite: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 1.75v11.5c0 .138.112.25.25.25h3.17a.75.75 0 0 1 0 1.5H2.75A1.75 1.75 0 0 1 1 13.25V1.75C1 .784 1.784 0 2.75 0h8.5C12.216 0 13 .784 13 1.75v7.736a.75.75 0 0 1-1.5 0V1.75a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm5.75 10.56 4.72-4.72a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-5.25 5.25a.75.75 0 0 1-1.06 0l-2.75-2.75a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018l2.22 2.22ZM4 4h5a.75.75 0 0 1 0 1.5H4A.75.75 0 0 1 4 4Zm0 3h3a.75.75 0 0 1 0 1.5H4A.75.75 0 0 1 4 7Z"/></svg>`,
      NotebookEdit: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25ZM8.75 6h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1 0-1.5Zm0 3h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1 0-1.5ZM4 7.25a1.25 1.25 0 1 1 2.5 0 1.25 1.25 0 0 1-2.5 0ZM5.25 9.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Z"/></svg>`,
      Thinking: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16ZM6.5 8.5a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Zm1.5-4a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0v-1A.75.75 0 0 1 8 4.5Z"/></svg>`,
    };
    return icons[tool] || `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5.433 2.304A4.494 4.494 0 0 0 3.5 6c0 1.598.832 3.002 2.09 3.802.518.328.929.923.929 1.61v.89a1 1 0 0 1-1.003 1c-.573 0-1.043.451-1.09 1.023l-.008.112a1.25 1.25 0 0 0 1.245 1.363h4.674a1.25 1.25 0 0 0 1.247-1.363l-.008-.112a1.103 1.103 0 0 0-1.09-1.023 1 1 0 0 1-1.003-1v-.89c0-.687.41-1.282.929-1.61A4.494 4.494 0 0 0 12.5 6a4.494 4.494 0 0 0-1.933-3.696c-.024.017-.067.067-.067.146v.452a.25.25 0 0 1-.25.25h-.5a.75.75 0 0 1-.75-.75v-.452c0-.326.11-.679.397-.894A2.975 2.975 0 0 1 8 1c-.52 0-1.017.133-1.446.361.271.222.379.559.379.869v.422a.75.75 0 0 1-.75.75h-.5a.25.25 0 0 1-.25-.25v-.452c0-.099-.048-.157-.085-.185a4.512 4.512 0 0 0-.915-.311Z"/></svg>`;
  }

  // Get display name for a message
  function getDisplayName(msg: SdkMessage): string {
    if (msg.type === 'thinking') return 'Thinking';
    return msg.tool || 'Unknown';
  }

  // Get the key parameter to display prominently for each tool
  function getToolSummary(msg: SdkMessage): string {
    if (msg.type === 'thinking') return '';

    const tool = msg.tool || '';
    const input = msg.input;
    if (!input) return "";

    switch (tool) {
      case "Read":
        return formatPath(input.file_path as string);
      case "Write":
        return formatPath(input.file_path as string);
      case "Edit":
        return formatPath(input.file_path as string);
      case "Bash":
        return truncate(input.command as string, 40);
      case "Grep":
        return `"${truncate(input.pattern as string, 25)}"`;
      case "Glob":
        return truncate(input.pattern as string, 30);
      case "WebFetch":
        return truncate(input.url as string, 35);
      case "WebSearch":
        return `"${truncate(input.query as string, 30)}"`;
      case "Task":
        return truncate(input.description as string || input.prompt as string, 35);
      case "TodoWrite":
        const todos = input.todos as Array<{ content: string }>;
        return todos?.length ? `${todos.length} item${todos.length > 1 ? 's' : ''}` : "";
      case "NotebookEdit":
        return formatPath(input.notebook_path as string);
      default:
        return "";
    }
  }

  function formatPath(path: string | undefined): string {
    if (!path) return "";
    const parts = path.replace(/\\/g, "/").split("/");
    const filename = parts.pop() || path;
    return filename;
  }

  function truncate(str: string | undefined, maxLen: number): string {
    if (!str) return "";
    const normalized = str.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLen) return normalized;
    return normalized.slice(0, maxLen) + "...";
  }

  function formatInput(input: Record<string, unknown> | undefined): string {
    if (!input) return "";
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  }

  function formatDuration(ms: number | undefined): string {
    if (!ms) return "";
    const seconds = ms / 1000;
    return `${seconds.toFixed(1)}s`;
  }

  function isRunning(msg: SdkMessage): boolean {
    if (msg.type === 'thinking') {
      return msg.thinkingDurationMs === undefined;
    }
    return msg.type === "tool_start";
  }

  function isThinking(msg: SdkMessage): boolean {
    return msg.type === 'thinking';
  }

  function getDuration(msg: SdkMessage): string {
    if (msg.type === 'thinking' && msg.thinkingDurationMs) {
      return formatDuration(msg.thinkingDurationMs);
    }
    return "";
  }

  function openModal(tool: SdkMessage) {
    expandedTool = tool;
  }

  function closeModal() {
    expandedTool = null;
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      closeModal();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      closeModal();
    }
  }

  // Get modal content based on message type
  function getModalContent(msg: SdkMessage): { hasInput: boolean; hasOutput: boolean; inputLabel: string; outputLabel: string } {
    if (msg.type === 'thinking') {
      return {
        hasInput: false,
        hasOutput: !!msg.content,
        inputLabel: '',
        outputLabel: 'Thinking Process'
      };
    }
    return {
      hasInput: !!(msg.input && Object.keys(msg.input).length > 0),
      hasOutput: !!msg.output,
      inputLabel: 'Input',
      outputLabel: 'Output'
    };
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="tool-grid">
  {#each tools as msg (msg.timestamp)}
    {@const running = isRunning(msg)}
    {@const thinking = isThinking(msg)}
    {@const summary = getToolSummary(msg)}
    {@const duration = getDuration(msg)}
    {@const displayName = getDisplayName(msg)}
    <button
      class="tool-card"
      class:running
      class:completed={!running}
      class:thinking
      onclick={() => openModal(msg)}
    >
      <div class="card-header">
        <div class="card-icon" class:icon-running={running} class:icon-completed={!running} class:icon-thinking={thinking}>
          {@html getToolSvgIcon(thinking ? 'Thinking' : (msg.tool || ""))}
        </div>
        <span class="card-name">{displayName}</span>
        {#if running}
          <span class="status-indicator status-running">
            <span class="spinner"></span>
          </span>
        {:else}
          <span class="status-indicator status-done">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
            </svg>
          </span>
        {/if}
      </div>
      {#if summary || duration}
        <div class="card-details">
          {#if summary}
            <span class="card-summary">{summary}</span>
          {/if}
          {#if duration}
            <span class="card-duration">{duration}</span>
          {/if}
        </div>
      {/if}
    </button>
  {/each}
</div>

{#if expandedTool}
  {@const modalContent = getModalContent(expandedTool)}
  {@const running = isRunning(expandedTool)}
  {@const thinking = isThinking(expandedTool)}
  {@const displayName = getDisplayName(expandedTool)}
  {@const duration = getDuration(expandedTool)}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={handleBackdropClick}>
    <div class="modal-content">
      <div class="modal-header">
        <div class="modal-icon" class:icon-running={running} class:icon-completed={!running} class:icon-thinking={thinking}>
          {@html getToolSvgIcon(thinking ? 'Thinking' : (expandedTool.tool || ""))}
        </div>
        <span class="modal-name">{displayName}</span>
        {#if running}
          <span class="modal-badge modal-badge-running">
            <span class="spinner"></span>
            Running
          </span>
        {:else}
          <span class="modal-badge modal-badge-done">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
            </svg>
            {duration || 'Done'}
          </span>
        {/if}
        <button class="modal-close" onclick={closeModal}>
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        {#if modalContent.hasInput}
          <div class="modal-section">
            <div class="section-label">{modalContent.inputLabel}</div>
            <pre class="section-content">{formatInput(expandedTool.input)}</pre>
          </div>
        {/if}
        {#if modalContent.hasOutput}
          <div class="modal-section">
            <div class="section-label">{modalContent.outputLabel}</div>
            <pre class="section-content" class:thinking-content={thinking}>{thinking ? expandedTool.content : expandedTool.output}</pre>
          </div>
        {/if}
        {#if !modalContent.hasInput && !modalContent.hasOutput}
          <div class="modal-empty">No details available</div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .tool-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 0.375rem;
  }

  .tool-card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.5rem 0.625rem;
    border-radius: 6px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: left;
  }

  .tool-card:hover {
    background: var(--color-surface-elevated);
    border-color: var(--color-text-muted);
  }

  .tool-card.running {
    border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
    background: color-mix(in srgb, var(--color-accent) 5%, var(--color-surface));
  }

  .tool-card.completed {
    border-color: color-mix(in srgb, var(--color-success) 30%, transparent);
  }

  .tool-card.thinking {
    border-color: color-mix(in srgb, var(--color-model-opus) 40%, transparent);
  }

  .tool-card.thinking.completed {
    border-color: color-mix(in srgb, var(--color-model-opus) 30%, transparent);
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .card-icon {
    width: 14px;
    height: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .card-icon :global(svg) {
    width: 12px;
    height: 12px;
  }

  .icon-running {
    color: var(--color-accent);
  }

  .icon-completed {
    color: var(--color-success);
  }

  .icon-thinking {
    color: var(--color-model-opus);
  }

  .icon-thinking.icon-completed {
    color: var(--color-model-opus);
  }

  .card-name {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--color-text-secondary);
    flex: 1;
    min-width: 0;
  }

  .status-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    height: 12px;
    flex-shrink: 0;
  }

  .status-indicator svg {
    width: 10px;
    height: 10px;
  }

  .status-running {
    color: var(--color-accent);
  }

  .status-done {
    color: var(--color-success);
  }

  .tool-card.thinking .status-running,
  .tool-card.thinking .status-done {
    color: var(--color-model-opus);
  }

  .card-details {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
  }

  .card-summary {
    font-size: 0.625rem;
    color: var(--color-text-muted);
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }

  .card-duration {
    font-size: 0.6rem;
    color: var(--color-text-muted);
    flex-shrink: 0;
    opacity: 0.8;
  }

  .spinner {
    width: 8px;
    height: 8px;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Modal styles */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
    animation: fadeIn 0.15s ease;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .modal-content {
    background: var(--color-background);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    width: 100%;
    max-width: 600px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    animation: slideUp 0.2s ease;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
  }

  @keyframes slideUp {
    from {
      opacity: 0;
      transform: translateY(20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .modal-header {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--color-border);
  }

  .modal-icon {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .modal-icon :global(svg) {
    width: 18px;
    height: 18px;
  }

  .modal-name {
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-text-primary);
  }

  .modal-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.625rem;
    border-radius: 9999px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }

  .modal-badge svg {
    width: 12px;
    height: 12px;
  }

  .modal-badge-running {
    background: color-mix(in srgb, var(--color-accent) 15%, transparent);
    color: var(--color-accent);
  }

  .modal-badge-done {
    background: color-mix(in srgb, var(--color-success) 15%, transparent);
    color: var(--color-success);
  }

  .modal-close {
    margin-left: auto;
    padding: 0.375rem;
    border-radius: 6px;
    background: transparent;
    border: none;
    color: var(--color-text-muted);
    cursor: pointer;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .modal-close:hover {
    background: var(--color-surface);
    color: var(--color-text-primary);
  }

  .modal-close svg {
    width: 16px;
    height: 16px;
  }

  .modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 1rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .modal-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .section-label {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
  }

  .section-content {
    margin: 0;
    padding: 0.75rem 1rem;
    background: var(--color-surface);
    border-radius: 8px;
    font-size: 0.8rem;
    line-height: 1.5;
    overflow-x: auto;
    max-height: 250px;
    color: var(--color-text-secondary);
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .thinking-content {
    font-family: inherit;
    font-style: italic;
    color: var(--color-text-muted);
    max-height: 400px;
  }

  .modal-empty {
    text-align: center;
    padding: 2rem;
    color: var(--color-text-muted);
    font-size: 0.875rem;
  }
</style>
