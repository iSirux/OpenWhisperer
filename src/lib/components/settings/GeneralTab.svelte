<script lang="ts">
  import { settings, type SdkProvider, type ToolDisplayMode } from "$lib/stores/settings";
  import "./toggle.css";

  let newAction = $state("");
  let actionError = $state("");

  function toggleProvider(which: "claude" | "openai") {
    settings.update((s) => {
      const current = s.enabled_providers ?? { claude: true, openai: true };
      const next = { ...current, [which]: !current[which] };
      // At least one provider must stay enabled.
      if (!next.claude && !next.openai) return s;
      // Keep the default provider inside the enabled set.
      const sdk_provider: SdkProvider = !next.claude
        ? "OpenAI"
        : !next.openai
          ? "Claude"
          : s.sdk_provider;
      return { ...s, enabled_providers: next, sdk_provider };
    });
  }

  let newChip = $state("");
  let chipError = $state("");

  let newServerPattern = $state("");
  let serverPatternError = $state("");

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

  // Drag-and-drop reordering for the quick-action and prompt-chip pill rows.
  type ReorderList = "quick_actions" | "prompt_chips";
  let dragList = $state<ReorderList | null>(null);
  let dragIndex = $state<number | null>(null);
  // Insertion position: the dragged pill would land *before* the pill at this index.
  let dropIndex = $state<number | null>(null);

  function handleDragStart(list: ReorderList, index: number, event: DragEvent) {
    dragList = list;
    dragIndex = index;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(index));
    }
  }

  function handleDragOver(list: ReorderList, index: number, event: DragEvent) {
    if (dragList !== list || dragIndex === null) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const before = event.clientX < rect.left + rect.width / 2;
    dropIndex = before ? index : index + 1;
  }

  function handleDrop(list: ReorderList, event: DragEvent) {
    event.preventDefault();
    if (dragList === list && dragIndex !== null && dropIndex !== null) {
      // Removing the dragged item first shifts a later insertion point down by one.
      const target = dropIndex > dragIndex ? dropIndex - 1 : dropIndex;
      if (target !== dragIndex) {
        const items = [...($settings[list] ?? [])];
        const [moved] = items.splice(dragIndex, 1);
        items.splice(target, 0, moved);
        $settings[list] = items;
      }
    }
    handleDragEnd();
  }

  function handleDragEnd() {
    dragList = null;
    dragIndex = null;
    dropIndex = null;
  }

  function addChip() {
    const trimmed = newChip.trim();
    if (!trimmed) {
      chipError = "";
      return;
    }

    if (trimmed.length > 40) {
      chipError = "Chip must be 40 characters or fewer";
      return;
    }

    const existing = ($settings.prompt_chips ?? []).map((c) => c.toLowerCase());
    if (existing.includes(trimmed.toLowerCase())) {
      chipError = "Chip already exists";
      return;
    }

    $settings.prompt_chips = [...($settings.prompt_chips ?? []), trimmed];
    newChip = "";
    chipError = "";
  }

  function removeChip(index: number) {
    $settings.prompt_chips = ($settings.prompt_chips ?? []).filter((_, i) => i !== index);
  }

  function addServerPattern() {
    const trimmed = newServerPattern.trim();
    if (!trimmed) {
      serverPatternError = "";
      return;
    }

    const existing = ($settings.server_command_patterns ?? []).map((p) => p.toLowerCase());
    if (existing.includes(trimmed.toLowerCase())) {
      serverPatternError = "Pattern already exists";
      return;
    }

    $settings.server_command_patterns = [...($settings.server_command_patterns ?? []), trimmed];
    newServerPattern = "";
    serverPatternError = "";
  }

  function removeServerPattern(index: number) {
    $settings.server_command_patterns = ($settings.server_command_patterns ?? []).filter(
      (_, i) => i !== index,
    );
  }
</script>

<div class="space-y-4">
  <!-- SDK Provider -->
  <div class="border-b border-border pb-4 mb-4">
    <h3 class="text-sm font-medium text-text-primary mb-3">SDK Provider</h3>
    <div class="space-y-3">
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1">Enabled Providers</label>
        <div class="flex gap-2">
          <button
            class="flex-1 px-3 py-2 rounded text-sm font-medium transition-colors border-2 {($settings.enabled_providers?.claude ?? true)
              ? 'border-accent bg-accent/10 text-text-primary'
              : 'border-border bg-surface text-text-muted'}"
            onclick={() => toggleProvider('claude')}
          >
            Claude (Anthropic)
          </button>
          <button
            class="flex-1 px-3 py-2 rounded text-sm font-medium transition-colors border-2 {($settings.enabled_providers?.openai ?? true)
              ? 'border-accent bg-accent/10 text-text-primary'
              : 'border-border bg-surface text-text-muted'}"
            onclick={() => toggleProvider('openai')}
          >
            OpenAI (Codex)
          </button>
        </div>
        <p class="text-xs text-text-muted mt-1">
          Disabled providers are hidden everywhere — header, session setup, and their settings tab.
          At least one must stay enabled.
        </p>
      </div>
      {#if ($settings.enabled_providers?.claude ?? true) && ($settings.enabled_providers?.openai ?? true)}
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
      {/if}
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
        >Auto-open PR &amp; Validation Panels</label
      >
      <p class="text-xs text-text-muted">
        Automatically open a session's dock panel when its pull request is detected or a
        validation run needs your attention
      </p>
    </div>
    <input
      type="checkbox"
      class="toggle"
      bind:checked={$settings.auto_open_session_panels}
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
        {#each $settings.quick_actions ?? [] as action, i (action)}
          <div
            class="flex items-center gap-1 px-3 py-1.5 text-sm rounded-full bg-surface border border-border text-text-secondary cursor-grab select-none transition-all active:cursor-grabbing"
            class:opacity-40={dragList === 'quick_actions' && dragIndex === i}
            class:reorder-before={dragList === 'quick_actions' && dropIndex === i && dragIndex !== i}
            class:reorder-after={dragList === 'quick_actions' &&
              dropIndex === i + 1 &&
              i === ($settings.quick_actions ?? []).length - 1 &&
              dragIndex !== i}
            draggable="true"
            ondragstart={(e) => handleDragStart('quick_actions', i, e)}
            ondragover={(e) => handleDragOver('quick_actions', i, e)}
            ondrop={(e) => handleDrop('quick_actions', e)}
            ondragend={handleDragEnd}
            title="Drag to reorder"
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

  <!-- Prompt Chips -->
  <div class="border-t border-border pt-4 mt-4">
    <h3 class="text-sm font-medium text-text-primary mb-1">Prompt Chips</h3>
    <p class="text-xs text-text-muted mb-3">
      Toggleable tags shown when preparing a new session or a pile item. The ones you
      enable are appended to the prompt on a new line, comma-separated, when it's sent.
    </p>

    <!-- Existing chips as removable pills -->
    {#if ($settings.prompt_chips ?? []).length > 0}
      <div class="flex flex-wrap gap-2 mb-3">
        {#each $settings.prompt_chips ?? [] as chip, i (chip)}
          <div
            class="flex items-center gap-1 px-3 py-1.5 text-sm rounded-full bg-surface border border-border text-text-secondary cursor-grab select-none transition-all active:cursor-grabbing"
            class:opacity-40={dragList === 'prompt_chips' && dragIndex === i}
            class:reorder-before={dragList === 'prompt_chips' && dropIndex === i && dragIndex !== i}
            class:reorder-after={dragList === 'prompt_chips' &&
              dropIndex === i + 1 &&
              i === ($settings.prompt_chips ?? []).length - 1 &&
              dragIndex !== i}
            draggable="true"
            ondragstart={(e) => handleDragStart('prompt_chips', i, e)}
            ondragover={(e) => handleDragOver('prompt_chips', i, e)}
            ondrop={(e) => handleDrop('prompt_chips', e)}
            ondragend={handleDragEnd}
            title="Drag to reorder"
          >
            <span>{chip}</span>
            <button
              type="button"
              class="ml-1 hover:text-red-400 rounded-full p-0.5 transition-colors"
              onclick={() => removeChip(i)}
              title="Remove chip"
            >
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Add new chip -->
    <div class="flex gap-2">
      <input
        type="text"
        placeholder="Add chip (e.g. search web)..."
        class="flex-1 px-3 py-1.5 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
        bind:value={newChip}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addChip();
          }
        }}
      />
      <button
        type="button"
        class="px-3 py-1.5 bg-accent text-white rounded text-sm hover:bg-accent/90 transition-colors disabled:opacity-50"
        onclick={addChip}
        disabled={!newChip.trim()}
      >
        Add
      </button>
    </div>
    {#if chipError}
      <p class="text-xs text-red-500 mt-1">{chipError}</p>
    {/if}

    {#if ($settings.prompt_chips ?? []).length === 0}
      <p class="text-xs text-text-muted mt-2 italic">
        No prompt chips configured.
      </p>
    {/if}
  </div>

  <!-- Background Server Commands -->
  <div class="border-t border-border pt-4 mt-4">
    <h3 class="text-sm font-medium text-text-primary mb-1">Background Server Commands</h3>
    <p class="text-xs text-text-muted mb-3">
      Background terminal commands matching one of these patterns (case-insensitive, matched on
      word boundaries) are treated as long-running servers: they're shown as running in the
      session, but never delay session completion. Other background commands keep the session
      busy until they finish.
    </p>

    <!-- Existing patterns as removable pills -->
    {#if ($settings.server_command_patterns ?? []).length > 0}
      <div class="flex flex-wrap gap-2 mb-3">
        {#each $settings.server_command_patterns ?? [] as pattern, i}
          <div
            class="flex items-center gap-1 px-3 py-1.5 text-sm rounded-full bg-surface border border-border text-text-secondary font-mono"
          >
            <span>{pattern}</span>
            <button
              type="button"
              class="ml-1 hover:text-red-400 rounded-full p-0.5 transition-colors"
              onclick={() => removeServerPattern(i)}
              title="Remove pattern"
            >
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Add new pattern -->
    <div class="flex gap-2">
      <input
        type="text"
        placeholder="Add pattern (e.g. npm run dev)..."
        class="flex-1 px-3 py-1.5 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
        bind:value={newServerPattern}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addServerPattern();
          }
        }}
      />
      <button
        type="button"
        class="px-3 py-1.5 bg-accent text-white rounded text-sm hover:bg-accent/90 transition-colors disabled:opacity-50"
        onclick={addServerPattern}
        disabled={!newServerPattern.trim()}
      >
        Add
      </button>
    </div>
    {#if serverPatternError}
      <p class="text-xs text-red-500 mt-1">{serverPatternError}</p>
    {/if}

    {#if ($settings.server_command_patterns ?? []).length === 0}
      <p class="text-xs text-text-muted mt-2 italic">
        No server patterns configured — every background command will keep its session busy until
        it finishes.
      </p>
    {/if}
  </div>
</div>

<style>
  /* Drop-position indicator for the draggable pill rows. */
  .reorder-before {
    box-shadow: -3px 0 0 0 var(--color-accent);
  }
  .reorder-after {
    box-shadow: 3px 0 0 0 var(--color-accent);
  }
</style>
