<script lang="ts">
  import type { SdkMessage, SdkImageContent, EffortLevel } from "$lib/stores/sdkSessions";
  import { renderMarkdown } from "$lib/utils/markdown";
  import { formatToolCallInput, getToolCallSummary } from "$lib/utils/toolCallFormatting";
  import { getModelType } from "$lib/utils/modelColors";
  import RerunDropdown from "./RerunDropdown.svelte";

  let {
    message,
    copiedMessageId = null,
    onCopy,
    sessionCwd = "",
    sessionModel = "",
    sessionEffortLevel = null,
  }: {
    message: SdkMessage;
    copiedMessageId?: number | null;
    onCopy: (msg: SdkMessage) => void;
    sessionCwd?: string;
    sessionModel?: string;
    sessionEffortLevel?: EffortLevel;
  } = $props();

  function createImagePreviewUrl(img: SdkImageContent): string {
    return `data:${img.mediaType};base64,${img.base64Data}`;
  }

  function formatInput(input: Record<string, unknown> | undefined, tool: string | undefined): string {
    return formatToolCallInput(tool, input);
  }

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
    };
    return icons[tool] || `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5.433 2.304A4.494 4.494 0 0 0 3.5 6c0 1.598.832 3.002 2.09 3.802.518.328.929.923.929 1.61v.89a1 1 0 0 1-1.003 1c-.573 0-1.043.451-1.09 1.023l-.008.112a1.25 1.25 0 0 0 1.245 1.363h4.674a1.25 1.25 0 0 0 1.247-1.363l-.008-.112a1.103 1.103 0 0 0-1.09-1.023 1 1 0 0 1-1.003-1v-.89c0-.687.41-1.282.929-1.61A4.494 4.494 0 0 0 12.5 6a4.494 4.494 0 0 0-1.933-3.696c-.024.017-.067.067-.067.146v.452a.25.25 0 0 1-.25.25h-.5a.75.75 0 0 1-.75-.75v-.452c0-.326.11-.679.397-.894A2.975 2.975 0 0 1 8 1c-.52 0-1.017.133-1.446.361.271.222.379.559.379.869v.422a.75.75 0 0 1-.75.75h-.5a.25.25 0 0 1-.25-.25v-.452c0-.099-.048-.157-.085-.185a4.512 4.512 0 0 0-.915-.311Z"/></svg>`;
  }

  // Format duration in seconds
  function formatDuration(ms: number | undefined): string {
    if (!ms) return "";
    const seconds = ms / 1000;
    return `${seconds.toFixed(1)}s`;
  }

  let isCopied = $derived(copiedMessageId === message.timestamp);
  let toolSummary = $derived(
    message.type === "tool_start" || message.type === "tool_result"
      ? getToolCallSummary(message.tool || "", message.input, 80)
      : ""
  );
  let thinkingDuration = $derived(formatDuration(message.thinkingDurationMs));
  let isThinkingComplete = $derived(message.type === "thinking" && message.thinkingDurationMs !== undefined);
</script>

<div class="message message-{message.type}">
  {#if message.type === "user"}
    <div class="user-message">
      <div class="user-message-body">
        {#if message.images && message.images.length > 0}
          <div class="message-images">
            {#each message.images as img}
              <img
                src={createImagePreviewUrl(img)}
                alt="Attached"
                class="message-image"
              />
            {/each}
          </div>
        {/if}
        {#if message.content}
          <pre class="user-content">{message.content}</pre>
        {/if}
      </div>
      <div class="message-actions">
        {#if sessionCwd && sessionModel && message.content}
          <RerunDropdown
            prompt={message.content}
            images={message.images}
            currentCwd={sessionCwd}
            currentModel={sessionModel}
            currentEffortLevel={sessionEffortLevel}
          />
        {/if}
        <button
          class="copy-message-button"
          class:copied={isCopied}
          onclick={() => onCopy(message)}
          title="Copy message"
        >
          {#if isCopied}
            <svg viewBox="0 0 20 20" fill="currentColor">
              <path
                fill-rule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clip-rule="evenodd"
              />
            </svg>
          {:else}
            <svg viewBox="0 0 20 20" fill="currentColor">
              <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
              <path
                d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"
              />
            </svg>
          {/if}
        </button>
      </div>
    </div>
  {:else if message.type === "text"}
    <div class="text-message-container">
      <div class="text-content markdown-body">
        {@html renderMarkdown(message.content ?? "")}
      </div>
      <button
        class="copy-message-button"
        class:copied={isCopied}
        onclick={() => onCopy(message)}
        title="Copy message"
      >
        {#if isCopied}
          <svg viewBox="0 0 20 20" fill="currentColor">
            <path
              fill-rule="evenodd"
              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
              clip-rule="evenodd"
            />
          </svg>
        {:else}
          <svg viewBox="0 0 20 20" fill="currentColor">
            <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
            <path
              d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"
            />
          </svg>
        {/if}
      </button>
    </div>
  {:else if message.type === "tool_start"}
    <details class="tool-call tool-running">
      <summary class="tool-header">
        <svg class="chevron" viewBox="0 0 16 16" fill="currentColor">
          <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/>
        </svg>
        <div class="tool-icon-wrapper">
          {@html getToolSvgIcon(message.tool || "")}
        </div>
        <span class="tool-name">{message.tool}</span>
        {#if toolSummary}
          <span class="tool-summary">{toolSummary}</span>
        {/if}
        <span class="tool-badge running">
          <span class="spinner"></span>
          Running
        </span>
      </summary>
      {#if message.input && Object.keys(message.input).length > 0}
        <pre class="tool-params">{formatInput(message.input, message.tool)}</pre>
      {/if}
    </details>
  {:else if message.type === "tool_result"}
    <details class="tool-call tool-completed">
      <summary class="tool-header">
        <svg class="chevron" viewBox="0 0 16 16" fill="currentColor">
          <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/>
        </svg>
        <div class="tool-icon-wrapper">
          {@html getToolSvgIcon(message.tool || "")}
        </div>
        <span class="tool-name">{message.tool}</span>
        {#if toolSummary}
          <span class="tool-summary">{toolSummary}</span>
        {/if}
        <span class="tool-badge completed">
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
          </svg>
          Done
        </span>
      </summary>
      {#if message.output}
        <pre class="tool-output-content">{message.output}</pre>
      {/if}
    </details>
  {:else if message.type === "error"}
    <div class="error-message">
      <div class="error-icon-wrapper">
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z"/>
        </svg>
      </div>
      <span class="error-text">{message.content}</span>
    </div>
  {:else if message.type === "notification"}
    <div class="notification-message">
      <div class="notification-icon-wrapper">
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path fill-rule="evenodd" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm6.5-.25A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/>
        </svg>
      </div>
      <span class="notification-text">{message.content}</span>
    </div>
  {:else if message.type === "subagent_start"}
    {@const modelType = getModelType(sessionModel)}
    <div class="subagent-call" style="background: color-mix(in srgb, var(--color-model-{modelType}) 8%, var(--color-surface));">
      <div class="subagent-header">
        <div class="subagent-icon-wrapper" style="color: var(--color-model-{modelType});">
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.5 3.25c0-.966.784-1.75 1.75-1.75h2.5c.966 0 1.75.784 1.75 1.75v2.5A1.75 1.75 0 0 1 5.75 7.5H5v1.5h.25a1.75 1.75 0 0 1 1.75 1.75v2.5A1.75 1.75 0 0 1 5.25 15h-2.5A1.75 1.75 0 0 1 1 13.25v-2.5C1 9.784 1.784 9 2.75 9H3V7.5h-.25A1.75 1.75 0 0 1 1 5.75v-2.5Zm9.75 0A1.75 1.75 0 0 0 9.5 5v6a1.75 1.75 0 0 0 1.75 1.75h1a.75.75 0 0 1 .75.75v1.19l2.72-2.72a.75.75 0 0 1 .53-.22h.5a.25.25 0 0 0 .25-.25V5a.25.25 0 0 0-.25-.25h-5.5Z"/>
          </svg>
        </div>
        <span class="subagent-name">Task</span>
        <span class="subagent-type-label">{message.agentType}</span>
        <span class="subagent-badge" style="background: color-mix(in srgb, var(--color-model-{modelType}) 15%, transparent); color: var(--color-model-{modelType});">
          <span class="spinner"></span>
          Running
        </span>
      </div>
    </div>
  {:else if message.type === "thinking"}
    <details class="tool-call" class:tool-running={!isThinkingComplete} class:tool-completed={isThinkingComplete}>
      <summary class="tool-header">
        <svg class="chevron" viewBox="0 0 16 16" fill="currentColor">
          <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/>
        </svg>
        <div class="tool-icon-wrapper">
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16ZM6.5 8.5a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Zm1.5-4a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0v-1A.75.75 0 0 1 8 4.5Z"/>
          </svg>
        </div>
        <span class="tool-name">Thinking</span>
        {#if isThinkingComplete}
          <span class="tool-badge completed">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
            </svg>
            {thinkingDuration}
          </span>
        {:else}
          <span class="tool-badge running">
            <span class="spinner"></span>
            Thinking
          </span>
        {/if}
      </summary>
      {#if message.content}
        <pre class="tool-output-content thinking-content">{message.content}</pre>
      {/if}
    </details>
  {/if}
</div>

<style>
  .message {
    animation: fadeIn 0.2s ease-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .user-message {
    padding: 0.75rem 1rem;
    background: var(--color-surface);
    border-radius: 8px;
    position: relative;
  }

  .user-message-body {
    max-height: 24rem;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 0.25rem;
  }

  .user-message:hover .message-actions {
    opacity: 1;
  }

  .text-message-container {
    position: relative;
  }

  .text-message-container:hover .copy-message-button {
    opacity: 1;
  }

  .message-actions {
    position: absolute;
    bottom: 0.5rem;
    right: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    opacity: 0;
    transition: opacity 0.2s;
  }

  .user-message:hover .message-actions,
  .message-actions:focus-within {
    opacity: 1;
  }

  .copy-message-button {
    background: var(--color-surface-elevated);
    color: var(--color-text-secondary);
    border: none;
    border-radius: 4px;
    padding: 0.35rem;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: unset;
  }

  /* For text messages that don't use message-actions wrapper */
  .text-message-container .copy-message-button {
    position: sticky;
    bottom: 0.5rem;
    float: right;
    margin-top: -1.75rem;
    margin-right: 0.25rem;
    opacity: 0;
  }

  .copy-message-button:hover {
    background: var(--color-border);
    color: var(--color-text-primary);
  }

  .copy-message-button.copied {
    background: color-mix(in srgb, var(--color-success) 20%, transparent);
    color: var(--color-success);
    opacity: 1;
  }

  .copy-message-button svg {
    width: 14px;
    height: 14px;
  }

  .user-content {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.9rem;
    line-height: 1.5;
    color: var(--color-text-primary);
  }

  .text-content {
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.6;
  }

  /* Markdown body styles */
  .markdown-body {
    color: var(--color-text-primary);
  }

  .markdown-body :global(h1),
  .markdown-body :global(h2),
  .markdown-body :global(h3),
  .markdown-body :global(h4),
  .markdown-body :global(h5),
  .markdown-body :global(h6) {
    margin-top: 1.25em;
    margin-bottom: 0.5em;
    font-weight: 600;
    line-height: 1.25;
    color: var(--color-text-primary);
  }

  .markdown-body :global(h1:first-child),
  .markdown-body :global(h2:first-child),
  .markdown-body :global(h3:first-child),
  .markdown-body :global(h4:first-child),
  .markdown-body :global(h5:first-child),
  .markdown-body :global(h6:first-child) {
    margin-top: 0;
  }

  .markdown-body :global(h1) {
    font-size: 1.5em;
    border-bottom: 1px solid var(--color-border);
    padding-bottom: 0.3em;
  }
  .markdown-body :global(h2) {
    font-size: 1.3em;
    border-bottom: 1px solid var(--color-border);
    padding-bottom: 0.3em;
  }
  .markdown-body :global(h3) {
    font-size: 1.15em;
  }
  .markdown-body :global(h4) {
    font-size: 1em;
  }
  .markdown-body :global(h5) {
    font-size: 0.9em;
  }
  .markdown-body :global(h6) {
    font-size: 0.85em;
    color: var(--color-text-muted);
  }

  .markdown-body :global(p) {
    margin-top: 0;
    margin-bottom: 0.75em;
  }

  .markdown-body :global(p:last-child) {
    margin-bottom: 0;
  }

  .markdown-body :global(a) {
    color: var(--color-accent);
    text-decoration: none;
  }

  .markdown-body :global(a:hover) {
    text-decoration: underline;
  }

  .markdown-body :global(strong) {
    font-weight: 600;
    color: var(--color-text-primary);
  }

  .markdown-body :global(em) {
    font-style: italic;
  }

  .markdown-body :global(code) {
    background: var(--color-surface);
    padding: 0.2em 0.4em;
    border-radius: 4px;
    font-size: 0.9em;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
      monospace;
  }

  .markdown-body :global(pre) {
    background: var(--color-surface);
    padding: 1em;
    border-radius: 6px;
    overflow-x: auto;
    margin: 0.75em 0;
  }

  .markdown-body :global(pre code) {
    background: transparent;
    padding: 0;
    border-radius: 0;
    font-size: 0.85em;
    line-height: 1.5;
  }

  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    margin-top: 0;
    margin-bottom: 0.75em;
    padding-left: 1.5em;
    list-style-position: outside;
  }

  .markdown-body :global(ul) {
    list-style-type: disc;
  }

  .markdown-body :global(ol) {
    list-style-type: decimal;
  }

  .markdown-body :global(li) {
    margin-bottom: 0.25em;
  }

  .markdown-body :global(li > ul),
  .markdown-body :global(li > ol) {
    margin-bottom: 0;
  }

  .markdown-body :global(blockquote) {
    margin: 0.75em 0;
    padding: 0.5em 1em;
    border-left: 4px solid var(--color-accent);
    background: var(--color-surface);
    color: var(--color-text-secondary);
  }

  .markdown-body :global(blockquote p) {
    margin-bottom: 0;
  }

  .markdown-body :global(hr) {
    border: none;
    border-top: 1px solid var(--color-border);
    margin: 1em 0;
  }

  .markdown-body :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 0.75em 0;
  }

  .markdown-body :global(th),
  .markdown-body :global(td) {
    border: 1px solid var(--color-border);
    padding: 0.5em 0.75em;
    text-align: left;
  }

  .markdown-body :global(th) {
    background: var(--color-surface);
    font-weight: 600;
  }

  .markdown-body :global(tr:nth-child(even)) {
    background: color-mix(in srgb, var(--color-surface) 50%, transparent);
  }

  /* Highlight.js theme overrides - these remain fixed for good syntax contrast */
  .markdown-body :global(.hljs) {
    background: transparent;
    color: var(--color-text-primary);
  }

  .markdown-body :global(.hljs-keyword),
  .markdown-body :global(.hljs-selector-tag),
  .markdown-body :global(.hljs-built_in) {
    color: #c678dd;
  }

  .markdown-body :global(.hljs-string),
  .markdown-body :global(.hljs-attr) {
    color: #98c379;
  }

  .markdown-body :global(.hljs-number),
  .markdown-body :global(.hljs-literal) {
    color: #d19a66;
  }

  .markdown-body :global(.hljs-comment) {
    color: #5c6370;
    font-style: italic;
  }

  .markdown-body :global(.hljs-function),
  .markdown-body :global(.hljs-title) {
    color: #61afef;
  }

  .markdown-body :global(.hljs-variable),
  .markdown-body :global(.hljs-params) {
    color: #e06c75;
  }

  .markdown-body :global(.hljs-type),
  .markdown-body :global(.hljs-class) {
    color: #e5c07b;
  }

  /* Tool call styles */
  .tool-call {
    border-radius: 6px;
    background: var(--color-surface);
  }

  .tool-call.tool-running {
    background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
  }

  .tool-call.tool-completed {
    background: var(--color-surface);
  }

  .tool-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 1.5rem;
    padding: 0.375rem 0.5rem;
    cursor: pointer;
    user-select: none;
    list-style: none;
  }

  .tool-header::-webkit-details-marker {
    display: none;
  }

  .tool-header:hover {
    background: color-mix(in srgb, var(--color-text-primary) 5%, transparent);
    border-radius: 6px;
  }

  .tool-header .chevron {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
    color: var(--color-text-muted);
    transition: transform 0.15s;
  }

  .tool-call[open] > .tool-header .chevron {
    transform: rotate(90deg);
  }

  .tool-icon-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    color: var(--color-text-muted);
    flex-shrink: 0;
  }

  .tool-icon-wrapper :global(svg) {
    width: 14px;
    height: 14px;
  }

  .tool-running .tool-icon-wrapper {
    color: var(--color-accent);
  }

  .tool-completed .tool-icon-wrapper {
    color: var(--color-success);
  }

  .tool-name {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--color-text-secondary);
  }

  .tool-summary {
    font-size: 0.8rem;
    color: var(--color-text-muted);
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .tool-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.025em;
    flex-shrink: 0;
    margin-left: auto;
  }

  .tool-badge svg {
    width: 10px;
    height: 10px;
  }

  .tool-badge.running {
    background: color-mix(in srgb, var(--color-accent) 15%, transparent);
    color: var(--color-accent);
  }

  .tool-badge.completed {
    background: color-mix(in srgb, var(--color-success) 15%, transparent);
    color: var(--color-success);
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

  .tool-params,
  .tool-output-content {
    margin: 0;
    padding: 0.5rem 0.75rem;
    background: color-mix(in srgb, var(--color-surface) 50%, var(--color-background));
    border-top: 1px solid var(--color-border);
    border-radius: 0 0 6px 6px;
    font-size: 0.75rem;
    line-height: 1.5;
    overflow-x: auto;
    max-height: 200px;
    overflow-y: auto;
    color: var(--color-text-secondary);
  }

  /* Thinking content - taller and with text wrapping */
  .thinking-content {
    white-space: pre-wrap;
    word-wrap: break-word;
    max-height: 400px;
    font-family: inherit;
    font-style: italic;
    color: var(--color-text-muted);
  }

  /* Error styles */
  .error-message {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    background: color-mix(in srgb, var(--color-error) 10%, var(--color-surface));
  }

  .error-icon-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    color: var(--color-error);
    flex-shrink: 0;
    margin-top: 0.1rem;
  }

  .error-icon-wrapper svg {
    width: 14px;
    height: 14px;
  }

  .error-text {
    color: var(--color-error);
    font-size: 0.8rem;
    line-height: 1.5;
  }

  /* Notification styles */
  .notification-message {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.625rem;
    border-radius: 6px;
    background: color-mix(in srgb, var(--color-accent) 10%, var(--color-surface));
    border: 1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);
  }

  .notification-icon-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    color: var(--color-accent);
    flex-shrink: 0;
  }

  .notification-icon-wrapper svg {
    width: 14px;
    height: 14px;
  }

  .notification-text {
    color: var(--color-text-secondary);
    font-size: 0.75rem;
    line-height: 1.4;
  }

  /* Subagent styles */
  .subagent-call {
    padding: 0.375rem 0.5rem;
    border-radius: 6px;
  }

  .subagent-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 1.5rem;
  }

  .subagent-icon-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    flex-shrink: 0;
  }

  .subagent-icon-wrapper svg {
    width: 14px;
    height: 14px;
  }

  .subagent-name {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--color-text-secondary);
  }

  .subagent-type-label {
    font-size: 0.8rem;
    color: var(--color-text-muted);
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }


  .subagent-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.025em;
    flex-shrink: 0;
    margin-left: auto;
  }

  /* Message images */
  .message-images {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .message-image {
    max-width: 300px;
    max-height: 200px;
    border-radius: 4px;
    cursor: pointer;
    transition: transform 0.2s;
  }

  .message-image:hover {
    transform: scale(1.02);
  }
</style>
