<script lang="ts">
  import { settings, type SdkProvider, type ToolDisplayMode } from "$lib/stores/settings";
  import "./toggle.css";
</script>

<div class="space-y-4">
  <!-- SDK Provider -->
  <div class="border-b border-border pb-4 mb-4">
    <h3 class="text-sm font-medium text-text-primary mb-3">SDK Provider</h3>
    <div>
      <label class="block text-sm font-medium text-text-secondary mb-1">Default Provider</label>
      <select
        class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
        bind:value={$settings.sdk_provider}
      >
        <option value="Claude">Claude (Anthropic)</option>
        <option value="OpenAI">OpenAI (Codex)</option>
      </select>
      <p class="text-xs text-text-muted mt-1">
        Default SDK provider for new sessions. Configure models in the Claude or Codex tabs.
      </p>
    </div>
  </div>

  <div>
    <label class="block text-sm font-medium text-text-secondary mb-1"
      >Session List Sort Order</label
    >
    <select
      class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
      bind:value={$settings.session_sort_order}
    >
      <option value="Chronological">Chronological (newest first)</option>
      <option value="StatusThenChronological"
        >Status, then chronological</option
      >
    </select>
    <p class="text-xs text-text-muted mt-1">
      {#if $settings.session_sort_order === "Chronological"}
        Sessions sorted by creation time, newest first.
      {:else}
        Active sessions first, then by creation time.
      {/if}
    </p>
  </div>
  <div>
    <label class="block text-sm font-medium text-text-secondary mb-1"
      >Tool Call Display Mode</label
    >
    <div class="flex gap-2">
      <button
        class="flex-1 px-3 py-2 rounded text-sm font-medium transition-colors {$settings.tool_display_mode === 'list'
          ? 'bg-accent text-white'
          : 'bg-surface border border-border text-text-secondary hover:bg-border'}"
        onclick={() => $settings.tool_display_mode = 'list' as ToolDisplayMode}
      >
        <svg class="w-4 h-4 inline-block mr-1.5 -mt-0.5" viewBox="0 0 16 16" fill="currentColor">
          <path d="M2 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm3.75-1.5a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5h-8.5zm0 5a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5h-8.5zm0 5a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5h-8.5zM3 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm-1 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/>
        </svg>
        List
      </button>
      <button
        class="flex-1 px-3 py-2 rounded text-sm font-medium transition-colors {$settings.tool_display_mode === 'grid'
          ? 'bg-accent text-white'
          : 'bg-surface border border-border text-text-secondary hover:bg-border'}"
        onclick={() => $settings.tool_display_mode = 'grid' as ToolDisplayMode}
      >
        <svg class="w-4 h-4 inline-block mr-1.5 -mt-0.5" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h3A1.5 1.5 0 0 1 7 2.5v3A1.5 1.5 0 0 1 5.5 7h-3A1.5 1.5 0 0 1 1 5.5v-3zm8 0A1.5 1.5 0 0 1 10.5 1h3A1.5 1.5 0 0 1 15 2.5v3A1.5 1.5 0 0 1 13.5 7h-3A1.5 1.5 0 0 1 9 5.5v-3zm-8 8A1.5 1.5 0 0 1 2.5 9h3A1.5 1.5 0 0 1 7 10.5v3A1.5 1.5 0 0 1 5.5 15h-3A1.5 1.5 0 0 1 1 13.5v-3zm8 0A1.5 1.5 0 0 1 10.5 9h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 9 13.5v-3z"/>
        </svg>
        Grid
      </button>
    </div>
    <p class="text-xs text-text-muted mt-1">
      {#if $settings.tool_display_mode === "list"}
        Tool calls shown in a vertical list with expandable details.
      {:else}
        Tool calls shown in a compact grid layout.
      {/if}
    </p>
  </div>
  <div class="flex items-center justify-between">
    <div>
      <label class="text-sm font-medium text-text-secondary"
        >Mark Completed Sessions as Unread</label
      >
      <p class="text-xs text-text-muted">
        Highlight sessions that have completed until you click on them
      </p>
    </div>
    <input
      type="checkbox"
      class="toggle"
      bind:checked={$settings.mark_sessions_unread}
    />
  </div>
  <div class="flex items-center justify-between">
    <div>
      <label class="text-sm font-medium text-text-secondary"
        >Show Latest Message Preview</label
      >
      <p class="text-xs text-text-muted">
        Display a snippet of the latest response in each SDK session
      </p>
    </div>
    <input
      type="checkbox"
      class="toggle"
      bind:checked={$settings.show_latest_message_preview}
    />
  </div>
  <div class="border-t border-border pt-4 mt-4">
    <h3 class="text-sm font-medium text-text-primary mb-3">
      Session List Row Limits
    </h3>
    <div class="space-y-4">
      <div>
        <label
          class="block text-sm font-medium text-text-secondary mb-1"
          >User Prompt Rows</label
        >
        <div class="flex items-center gap-3">
          <input
            type="range"
            min="1"
            max="6"
            step="1"
            class="flex-1 accent-accent"
            bind:value={$settings.session_prompt_rows}
          />
          <span class="text-sm text-text-primary w-8 text-right"
            >{$settings.session_prompt_rows}</span
          >
        </div>
        <p class="text-xs text-text-muted mt-1">
          Maximum rows to show for user prompts in session list
        </p>
      </div>
      <div>
        <label
          class="block text-sm font-medium text-text-secondary mb-1"
          >Agent Response Rows</label
        >
        <div class="flex items-center gap-3">
          <input
            type="range"
            min="1"
            max="6"
            step="1"
            class="flex-1 accent-accent"
            bind:value={$settings.session_response_rows}
          />
          <span class="text-sm text-text-primary w-8 text-right"
            >{$settings.session_response_rows}</span
          >
        </div>
        <p class="text-xs text-text-muted mt-1">
          Maximum rows to show for agent responses in session list
        </p>
      </div>
    </div>
  </div>
</div>
