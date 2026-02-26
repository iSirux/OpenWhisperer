<script lang="ts">
  import { settings, type SdkProvider, type ToolDisplayMode } from "$lib/stores/settings";
  import "./toggle.css";

  let newAction = $state("");
  let actionError = $state("");

  function addQuickAction() {
    const trimmed = newAction.trim();
    if (!trimmed) {
      actionError = "";
      return;
    }

    if (trimmed.length > 60) {
      actionError = "Quick action must be 60 characters or fewer";
      return;
    }

    // Check for duplicates (case-insensitive)
    const existing = ($settings.quick_actions ?? []).map((a) => a.toLowerCase());
    if (existing.includes(trimmed.toLowerCase())) {
      actionError = "Quick action already exists";
      return;
    }

    $settings.quick_actions = [...($settings.quick_actions ?? []), trimmed];
    newAction = "";
    actionError = "";
  }

  function removeQuickAction(index: number) {
    $settings.quick_actions = ($settings.quick_actions ?? []).filter((_, i) => i !== index);
  }
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
  <div class="flex items-center justify-between">
    <div>
      <label class="text-sm font-medium text-text-secondary"
        >Show Session Summary</label
      >
      <p class="text-xs text-text-muted">
        Display the AI-generated outcome summary in each session
      </p>
    </div>
    <input
      type="checkbox"
      class="toggle"
      bind:checked={$settings.show_session_summary}
    />
  </div>
  <div class="flex items-center justify-between">
    <div>
      <label class="text-sm font-medium text-text-secondary"
        >Notify Agents of Parallel Work</label
      >
      <p class="text-xs text-text-muted">
        Include a system message telling agents that other agents may be working
        on the same repo simultaneously
      </p>
    </div>
    <input
      type="checkbox"
      class="toggle"
      bind:checked={$settings.notify_parallel_agents}
    />
  </div>
  <!-- Quick Actions -->
  <div class="border-t border-border pt-4 mt-4">
    <h3 class="text-sm font-medium text-text-primary mb-1">Quick Actions</h3>
    <p class="text-xs text-text-muted mb-3">
      Custom prompts shown as quick action buttons after each session response. Add, remove, or reorder to suit your workflow.
    </p>

    <!-- Existing actions as removable chips -->
    {#if ($settings.quick_actions ?? []).length > 0}
      <div class="flex flex-wrap gap-2 mb-3">
        {#each $settings.quick_actions ?? [] as action, i}
          <div
            class="flex items-center gap-1 px-3 py-1.5 text-sm rounded-full bg-surface border border-border text-text-secondary"
          >
            <span>{action}</span>
            <button
              type="button"
              class="ml-1 hover:text-red-400 rounded-full p-0.5 transition-colors"
              onclick={() => removeQuickAction(i)}
              title="Remove quick action"
            >
              <svg
                class="w-3 h-3"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Add new action -->
    <div class="flex gap-2">
      <input
        type="text"
        placeholder="Add quick action..."
        class="flex-1 px-3 py-1.5 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
        bind:value={newAction}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addQuickAction();
          }
        }}
      />
      <button
        type="button"
        class="px-3 py-1.5 bg-accent text-white rounded text-sm hover:bg-accent/90 transition-colors disabled:opacity-50"
        onclick={addQuickAction}
        disabled={!newAction.trim()}
      >
        Add
      </button>
    </div>
    {#if actionError}
      <p class="text-xs text-red-500 mt-1">{actionError}</p>
    {/if}

    {#if ($settings.quick_actions ?? []).length === 0}
      <p class="text-xs text-text-muted mt-2 italic">
        No quick actions configured. Only AI-suggested actions will appear (if LLM is enabled).
      </p>
    {/if}
  </div>
</div>
