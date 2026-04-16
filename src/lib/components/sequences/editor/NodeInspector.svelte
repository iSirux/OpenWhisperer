<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import type { NodeDefinition } from '$lib/types/sequence';
  import type { EditorNode } from '$lib/utils/sequenceConverter';
  import { settings } from '$lib/stores/settings';
  import { repos } from '$lib/stores/repos';
  import { sequences } from '$lib/stores/sequences';
  import { playNotificationSound } from '$lib/utils/sound';
  import RepoIcon from '$lib/components/RepoIcon.svelte';

  let {
    selectedNode = $bindable<EditorNode | null>(null),
    allNodes = [] as EditorNode[],
    onNodeUpdate = (node: EditorNode) => {},
    onNodeDelete = (nodeId: string) => {},
    sequenceDescription = $bindable(''),
    sequenceRepos = $bindable<string[]>([]),
    sequenceTags = $bindable<string[]>([]),
  }: {
    selectedNode: EditorNode | null;
    allNodes?: EditorNode[];
    onNodeUpdate?: (node: EditorNode) => void;
    onNodeDelete?: (nodeId: string) => void;
    sequenceDescription?: string;
    sequenceRepos?: string[];
    sequenceTags?: string[];
  } = $props();

  let confirmingDelete = $state(false);
  let newTag = $state('');

  let aiAssistDescription = $state('');
  let aiAssistLoading = $state(false);

  function addTag() {
    const tag = newTag.trim().toLowerCase();
    if (tag && !sequenceTags.includes(tag)) {
      sequenceTags = [...sequenceTags, tag];
    }
    newTag = '';
  }

  function removeTag(tag: string) {
    sequenceTags = sequenceTags.filter(t => t !== tag);
  }

  function toggleRepo(path: string) {
    if (sequenceRepos.includes(path)) {
      sequenceRepos = sequenceRepos.filter(r => r !== path);
    } else {
      sequenceRepos = [...sequenceRepos, path];
    }
  }

  // Common CSS classes
  const inputCls = 'w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none';
  const selectCls = inputCls;
  const textareaCls = `${inputCls} font-mono resize-y`;
  const smallInputCls = 'w-full px-1.5 py-0.5 text-[10px] rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none';

  // Helper to update a field on the node definition
  function updateField(field: string, value: unknown) {
    if (!selectedNode) return;
    const updated = {
      ...selectedNode,
      data: {
        ...selectedNode.data,
        nodeDefinition: {
          ...selectedNode.data.nodeDefinition,
          [field]: value,
        },
      },
    };
    selectedNode = updated;
    onNodeUpdate(updated);
  }

  // Helper to get a field value
  function getField(field: string): unknown {
    if (!selectedNode) return undefined;
    return (selectedNode.data.nodeDefinition as Record<string, unknown>)[field];
  }

  let nodeType = $derived(selectedNode?.data.nodeDefinition.type || '');
  let errorStrategy = $derived(getErrorStrategy());
  let gotoTarget = $derived(getGotoTarget());

  // Other nodes for datalist / goto target pickers
  let otherNodes = $derived(
    allNodes.filter(n => n.id !== selectedNode?.id)
  );

  // Error strategy helpers
  function getErrorStrategy(): string {
    const val = getField('on_error');
    if (!val) return '';
    if (typeof val === 'string') return val;
    if (typeof val === 'object' && val !== null && 'goto' in val) return 'goto';
    return '';
  }

  function getGotoTarget(): string {
    const val = getField('on_error');
    if (typeof val === 'object' && val !== null && 'goto' in val) {
      return ((val as { goto: { target: string } }).goto?.target) || '';
    }
    return '';
  }

  // Duration helpers for delay node
  function parseDuration(d: string): { value: number; unit: string } {
    if (!d) return { value: 5, unit: 's' };
    const match = d.match(/^(\d+\.?\d*)\s*(s|m|h|ms)$/i);
    if (match) return { value: parseFloat(match[1]), unit: match[2].toLowerCase() };
    const num = parseFloat(d);
    if (!isNaN(num)) return { value: num, unit: 's' };
    return { value: 5, unit: 's' };
  }

  // Reset delete confirmation when selection changes
  $effect(() => {
    selectedNode;
    confirmingDelete = false;
  });

  async function handleAiAssist() {
    if (!selectedNode || !aiAssistDescription.trim()) return;
    aiAssistLoading = true;
    try {
      const result = await invoke('generate_node_config', {
        nodeType: selectedNode.data.nodeDefinition.type,
        description: aiAssistDescription,
        context: JSON.stringify(selectedNode.data.nodeDefinition),
      });
      // Merge AI result into node definition
      if (result && typeof result === 'object') {
        const merged = { ...selectedNode.data.nodeDefinition, ...(result as Record<string, unknown>) };
        const updated = {
          ...selectedNode,
          data: { ...selectedNode.data, nodeDefinition: merged as NodeDefinition },
        };
        selectedNode = updated;
        onNodeUpdate(updated);
      }
      aiAssistDescription = '';
    } catch (e) {
      console.error('AI assist failed:', e);
    } finally {
      aiAssistLoading = false;
    }
  }
</script>

<div class="w-[300px] border-l border-border bg-surface overflow-y-auto flex-shrink-0">
  {#if !selectedNode}
    <div class="p-3 space-y-4 overflow-y-auto h-full">
      <h3 class="text-sm font-semibold text-text-primary">Sequence Details</h3>

      <!-- Description -->
      <div>
        <label class="block text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-1">Description</label>
        <textarea
          bind:value={sequenceDescription}
          class="w-full px-2 py-1.5 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none resize-y"
          rows="3"
          placeholder="What does this sequence do?"
        ></textarea>
      </div>

      <!-- Repositories -->
      <div>
        <label class="block text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-1">
          Repositories
          <span class="font-normal text-text-muted ml-1">
            {sequenceRepos.length === 0 ? '(all)' : `(${sequenceRepos.length})`}
          </span>
        </label>
        {#if $repos.list.length === 0}
          <p class="text-[10px] text-text-muted italic">No repos configured.</p>
        {:else}
          <div class="flex flex-wrap gap-1">
            {#each $repos.list as repo}
              <button
                class="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-full border transition-colors {sequenceRepos.includes(repo.path)
                  ? 'bg-accent/20 border-accent text-accent'
                  : 'border-border text-text-muted hover:border-text-secondary hover:text-text-secondary'}"
                onclick={() => toggleRepo(repo.path)}
                title={repo.path}
              >
                <RepoIcon repo={repo} size="xs" />
                {repo.name}
              </button>
            {/each}
          </div>
          <p class="text-[10px] text-text-muted mt-1">Leave empty for all repos.</p>
        {/if}
      </div>

      <!-- Tags -->
      <div>
        <label class="block text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-1">Tags</label>
        {#if sequenceTags.length > 0}
          <div class="flex flex-wrap gap-1 mb-1.5">
            {#each sequenceTags as tag}
              <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded-full bg-surface-elevated text-text-secondary border border-border/50">
                {tag}
                <button class="ml-0.5 hover:text-red-400 transition-colors" onclick={() => removeTag(tag)}>&times;</button>
              </span>
            {/each}
          </div>
        {/if}
        <div class="flex items-center gap-1">
          <input
            type="text"
            bind:value={newTag}
            class="flex-1 px-1.5 py-0.5 text-[10px] rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
            placeholder="Add tag..."
            onkeydown={(e) => e.key === 'Enter' && addTag()}
          />
          <button
            class="px-1.5 py-0.5 text-[10px] rounded border border-border text-text-muted hover:text-text-primary hover:bg-surface-elevated transition-colors disabled:opacity-50"
            onclick={addTag}
            disabled={!newTag.trim()}
          >+</button>
        </div>
      </div>

      <p class="text-[10px] text-text-muted italic pt-2 border-t border-border">Select a node on the canvas to edit its properties.</p>
    </div>
  {:else}
    <!-- Reusable snippet: Tag editor for string arrays -->
    {#snippet tagEditor(field: string, placeholder: string)}
      {@const items = (getField(field) as string[]) || []}
      {#if items.length > 0}
        <div class="flex flex-wrap gap-1 mb-1">
          {#each items as item, i}
            <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded bg-surface-elevated text-text-secondary border border-border/50">
              {item}
              <button class="hover:text-red-400 transition-colors" onclick={() => {
                updateField(field, items.filter((_: string, idx: number) => idx !== i));
              }}>&times;</button>
            </span>
          {/each}
        </div>
      {/if}
      <input type="text" placeholder={placeholder}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            const val = e.currentTarget.value.trim();
            if (val && !items.includes(val)) {
              updateField(field, [...items, val]);
              e.currentTarget.value = '';
            }
            e.preventDefault();
          }
        }}
        class={smallInputCls} />
    {/snippet}

    <!-- Reusable snippet: Key-value editor for Record<string, string> -->
    {#snippet kvEditor(field: string, keyPlaceholder: string, valuePlaceholder: string)}
      {@const items = (getField(field) as Record<string, string>) || {}}
      {@const keys = Object.keys(items)}
      <div class="space-y-1">
        {#each keys as key, i (i)}
          <div class="flex items-center gap-1">
            <input type="text" value={key}
              onchange={(e) => {
                const newKey = e.currentTarget.value;
                const updated = { ...items };
                const val = updated[key];
                delete updated[key];
                if (newKey) updated[newKey] = val;
                updateField(field, Object.keys(updated).length ? updated : undefined);
              }}
              class="flex-1 px-1.5 py-0.5 text-[10px] rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
              placeholder={keyPlaceholder} />
            <input type="text" value={items[key]}
              onchange={(e) => {
                updateField(field, { ...items, [key]: e.currentTarget.value });
              }}
              class="flex-1 px-1.5 py-0.5 text-[10px] rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
              placeholder={valuePlaceholder} />
            <button class="p-0.5 rounded text-text-muted hover:text-red-400 transition-colors"
              onclick={() => {
                const updated = { ...items };
                delete updated[key];
                updateField(field, Object.keys(updated).length ? updated : undefined);
              }}
              title="Remove">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
        {/each}
        <button class="w-full px-2 py-0.5 text-[10px] rounded border border-dashed border-border text-text-muted hover:border-accent hover:text-accent transition-colors"
          onclick={() => {
            const k = keys.length === 0 ? '' : `key_${keys.length + 1}`;
            updateField(field, { ...items, [k]: '' });
          }}>+ Add</button>
      </div>
    {/snippet}

    <div class="p-3 space-y-4">
      <!-- Header -->
      <div class="flex items-start justify-between">
        <div>
          <h3 class="text-sm font-semibold text-text-primary mb-2">Node Properties</h3>
          <span class="px-1.5 py-0.5 text-[10px] rounded bg-surface-elevated text-text-muted">{nodeType}</span>
        </div>
        {#if confirmingDelete}
          <div class="flex items-center gap-1">
            <button
              class="px-2 py-1 text-[10px] rounded bg-red-600 text-white hover:bg-red-500 transition-colors"
              onclick={() => { confirmingDelete = false; onNodeDelete(selectedNode!.id); }}
            >Delete</button>
            <button
              class="px-2 py-1 text-[10px] rounded border border-border text-text-muted hover:bg-surface-elevated transition-colors"
              onclick={() => { confirmingDelete = false; }}
            >Cancel</button>
          </div>
        {:else}
          <button
            class="p-1 rounded text-text-muted hover:text-red-400 hover:bg-surface-elevated transition-colors"
            onclick={() => { confirmingDelete = true; }}
            title="Delete node"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
          </button>
        {/if}
      </div>

      <!-- AI Assist Section -->
      <div class="space-y-2 border-t border-border pt-3">
        <h4 class="text-[10px] font-semibold text-text-muted uppercase tracking-wider">AI Assist</h4>
        <textarea bind:value={aiAssistDescription}
          rows="2"
          class="{textareaCls}"
          placeholder="Describe what this node should do..."></textarea>
        <button
          class="w-full px-2 py-1 text-xs rounded bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-50"
          onclick={handleAiAssist}
          disabled={aiAssistLoading || !aiAssistDescription.trim()}>
          {aiAssistLoading ? 'Generating...' : 'Generate with AI'}
        </button>
      </div>

      <!-- Common fields -->
      <div class="space-y-2">
        <div>
          <label class="block text-[10px] text-text-muted mb-0.5">ID</label>
          <input type="text" value={selectedNode.data.nodeDefinition.id}
            onchange={(e) => updateField('id', e.currentTarget.value)}
            class={inputCls} />
        </div>
        <div>
          <label class="block text-[10px] text-text-muted mb-0.5">Name</label>
          <input type="text" value={selectedNode.data.nodeDefinition.name || ''}
            onchange={(e) => updateField('name', e.currentTarget.value || undefined)}
            class={inputCls}
            placeholder="Optional display name" />
        </div>
        {#if nodeType !== 'trigger'}
        <div>
          <label class="block text-[10px] text-text-muted mb-0.5">Condition</label>
          <input type="text" value={selectedNode.data.nodeDefinition.condition || ''}
            onchange={(e) => updateField('condition', e.currentTarget.value || undefined)}
            class="{inputCls} font-mono"
            placeholder="Template expression" />
        </div>
        <div>
          <label class="block text-[10px] text-text-muted mb-0.5">Next Node</label>
          <input type="text" value={selectedNode.data.nodeDefinition.next || ''}
            onchange={(e) => updateField('next', e.currentTarget.value || undefined)}
            list="inspector-node-ids"
            class={inputCls}
            placeholder="Auto (sequential)" />
          <datalist id="inspector-node-ids">
            {#each otherNodes as node}
              <option value={node.data.nodeDefinition.id}>{node.data.label} ({node.data.nodeDefinition.type})</option>
            {/each}
          </datalist>
        </div>
        {/if}
      </div>

      <!-- ================================================================= -->
      <!-- Type-specific fields                                              -->
      <!-- ================================================================= -->
      <div class="space-y-2 border-t border-border pt-3">
        <h4 class="text-[10px] font-semibold text-text-muted uppercase tracking-wider">{nodeType.replace(/_/g, ' ')} Config</h4>

        <!-- ============================================================= -->
        <!-- TRIGGER NODE                                                   -->
        <!-- ============================================================= -->
        {#if nodeType === 'trigger'}
          {@const triggerType = (getField('trigger_type') as Record<string, unknown>) || { trigger_kind: 'manual' }}
          {@const triggerKind = (triggerType.trigger_kind as string) || 'manual'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Trigger Kind</label>
            <select value={triggerKind}
              onchange={(e) => {
                const kind = e.currentTarget.value;
                if (kind === 'manual') {
                  updateField('trigger_type', { trigger_kind: 'manual' });
                } else if (kind === 'schedule') {
                  updateField('trigger_type', { trigger_kind: 'schedule', cron: '0 0 * * *' });
                } else {
                  updateField('trigger_type', { trigger_kind: 'event', event_type: 'session_end' });
                }
              }}
              class={selectCls}>
              <option value="manual">Manual</option>
              <option value="schedule">Schedule</option>
              <option value="event">Event</option>
            </select>
          </div>

          {#if triggerKind === 'schedule'}
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Cron Expression</label>
              <input type="text" value={(triggerType.cron as string) || ''}
                onchange={(e) => updateField('trigger_type', { ...triggerType, cron: e.currentTarget.value })}
                class="{inputCls} font-mono"
                placeholder="0 0 * * *" />
              <p class="text-[10px] text-text-muted mt-0.5">e.g. "0 9 * * 1-5" = weekdays at 9am</p>
            </div>
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Timezone</label>
              <input type="text" value={(triggerType.timezone as string) || ''}
                onchange={(e) => updateField('trigger_type', { ...triggerType, timezone: e.currentTarget.value || undefined })}
                class={inputCls}
                placeholder="UTC (default)" />
            </div>

          {:else if triggerKind === 'event'}
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Event Type</label>
              <select value={(triggerType.event_type as string) || 'session_end'}
                onchange={(e) => updateField('trigger_type', { ...triggerType, event_type: e.currentTarget.value })}
                class={selectCls}>
                <option value="session_end">Session End</option>
                <option value="sequence_end">Sequence End</option>
                <option value="recording_end">Recording End</option>
                <option value="app_start">App Start</option>
              </select>
            </div>
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Cooldown (ms)</label>
              <input type="number" value={(triggerType.cooldown as number) || ''}
                onchange={(e) => updateField('trigger_type', { ...triggerType, cooldown: parseInt(e.currentTarget.value) || undefined })}
                min="0"
                class={inputCls}
                placeholder="No cooldown" />
            </div>
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Max Per Day</label>
              <input type="number" value={(triggerType.max_per_day as number) || ''}
                onchange={(e) => updateField('trigger_type', { ...triggerType, max_per_day: parseInt(e.currentTarget.value) || undefined })}
                min="1"
                class={inputCls}
                placeholder="Unlimited" />
            </div>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={(triggerType.once_per_day as boolean) || false}
                onchange={(e) => updateField('trigger_type', { ...triggerType, once_per_day: e.currentTarget.checked || undefined })}
                class="rounded border-border accent-accent" />
              <span class="text-xs text-text-secondary">Once per day only</span>
            </label>
          {/if}

          <div class="p-2 rounded bg-teal-500/5 border border-teal-500/20 mt-2">
            <p class="text-[10px] text-text-muted">
              Connect this trigger's output to a node to set the entry point.
              Different triggers can enter the sequence at different nodes.
            </p>
          </div>

        <!-- ============================================================= -->
        <!-- PROMPT NODE                                                    -->
        <!-- ============================================================= -->
        {:else if nodeType === 'prompt'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Prompt</label>
            <textarea value={(getField('prompt') as string) || ''}
              onchange={(e) => updateField('prompt', e.currentTarget.value)}
              rows="4"
              class={textareaCls}
              placeholder="Enter prompt template..."></textarea>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Model</label>
            <select value={(getField('model') as string) || ''}
              onchange={(e) => updateField('model', e.currentTarget.value || undefined)}
              class={selectCls}>
              <option value="">Default</option>
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
              <option value="haiku">Haiku</option>
            </select>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Effort</label>
            <select value={(getField('effort') as string) || ''}
              onchange={(e) => updateField('effort', e.currentTarget.value || undefined)}
              class={selectCls}>
              <option value="">Default</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">XHigh</option>
              <option value="max">Max</option>
            </select>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">System Prompt</label>
            <textarea value={(getField('system_prompt') as string) || ''}
              onchange={(e) => updateField('system_prompt', e.currentTarget.value || undefined)}
              rows="2"
              class={textareaCls}
              placeholder="Optional system prompt"></textarea>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Output Format</label>
            <select value={(getField('output_format') as string) || ''}
              onchange={(e) => updateField('output_format', e.currentTarget.value || undefined)}
              class={selectCls}>
              <option value="">Default (text)</option>
              <option value="json">JSON</option>
              <option value="markdown">Markdown</option>
              <option value="xml">XML</option>
            </select>
          </div>

          <!-- MCP Servers -->
          {#if $settings.mcp.servers.filter(s => s.enabled).length > 0}
            <div>
              <label class="block text-[10px] text-text-muted mb-1">MCP Servers</label>
              <div class="space-y-1 max-h-32 overflow-y-auto">
                {#each $settings.mcp.servers.filter(s => s.enabled) as server}
                  {@const selectedServers = (getField('mcp_servers') as string[]) || []}
                  {@const isSelected = selectedServers.includes(server.id)}
                  <label class="flex items-center gap-2 cursor-pointer px-1.5 py-0.5 rounded hover:bg-surface-elevated/50 transition-colors">
                    <input type="checkbox" checked={isSelected}
                      onchange={() => {
                        const current = (getField('mcp_servers') as string[]) || [];
                        const updated = isSelected
                          ? current.filter((id: string) => id !== server.id)
                          : [...current, server.id];
                        updateField('mcp_servers', updated.length ? updated : undefined);
                      }}
                      class="rounded border-border accent-accent" />
                    <span class="text-xs text-text-secondary truncate">{server.name}</span>
                    <span class="text-[10px] text-text-muted ml-auto">{server.server_type}</span>
                  </label>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Tools -->
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Allowed Tools</label>
            {@render tagEditor('tools', 'Add tool name + Enter')}
            <p class="text-[10px] text-text-muted mt-0.5">e.g. Bash, Read, Write, Glob, Grep</p>
          </div>

          <!-- Session Config -->
          {@const session = (getField('session') as { mode?: string; id?: string }) || {}}
          <div class="space-y-1.5 border-t border-border/50 pt-2 mt-2">
            <h5 class="text-[10px] font-semibold text-text-muted uppercase tracking-wider">Session</h5>
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Mode</label>
              <select value={session.mode || ''}
                onchange={(e) => {
                  const mode = e.currentTarget.value || undefined;
                  updateField('session', mode ? { ...session, mode } : undefined);
                }}
                class={selectCls}>
                <option value="">Default (new)</option>
                <option value="new">New Session</option>
                <option value="continue">Continue Existing</option>
                <option value="resume">Resume Previous</option>
              </select>
            </div>
            {#if session.mode === 'continue' || session.mode === 'resume'}
              <div>
                <label class="block text-[10px] text-text-muted mb-0.5">Session ID</label>
                <input type="text" value={session.id || ''}
                  onchange={(e) => updateField('session', { ...session, id: e.currentTarget.value || undefined })}
                  class={inputCls}
                  placeholder="Session ID or {'{{'} variable {'}}'}" />
              </div>
            {/if}
          </div>

        <!-- ============================================================= -->
        <!-- ROUTE NODE                                                     -->
        <!-- ============================================================= -->
        {:else if nodeType === 'route'}
          {@const branches = (getField('branches') as Record<string, string | { description?: string; next: string }>) || {}}
          {@const branchKeys = Object.keys(branches)}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Routing Mode</label>
            <select value={(getField('eval') ? 'eval' : getField('prompt') ? 'prompt' : 'eval')}
              onchange={(e) => {
                const mode = e.currentTarget.value;
                if (mode === 'eval') {
                  updateField('prompt', undefined);
                  updateField('context', undefined);
                  updateField('model', undefined);
                  if (!getField('eval')) updateField('eval', '');
                } else {
                  updateField('eval', undefined);
                  if (!getField('prompt')) updateField('prompt', '');
                }
              }}
              class={selectCls}>
              <option value="eval">Expression (eval)</option>
              <option value="prompt">LLM Prompt</option>
            </select>
          </div>

          {#if getField('prompt') !== undefined}
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Prompt</label>
              <textarea value={(getField('prompt') as string) || ''}
                onchange={(e) => updateField('prompt', e.currentTarget.value || undefined)}
                rows="3"
                class={textareaCls}
                placeholder="LLM prompt to decide branch..."></textarea>
            </div>
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Context</label>
              <textarea value={(getField('context') as string) || ''}
                onchange={(e) => updateField('context', e.currentTarget.value || undefined)}
                rows="2"
                class={textareaCls}
                placeholder="Additional context..."></textarea>
            </div>
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Model</label>
              <select value={(getField('model') as string) || ''}
                onchange={(e) => updateField('model', e.currentTarget.value || undefined)}
                class={selectCls}>
                <option value="">Default</option>
                <option value="opus">Opus</option>
                <option value="sonnet">Sonnet</option>
                <option value="haiku">Haiku</option>
              </select>
            </div>
          {:else}
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Eval Expression</label>
              <textarea value={(getField('eval') as string) || ''}
                onchange={(e) => updateField('eval', e.currentTarget.value || undefined)}
                rows="2"
                class={textareaCls}
                placeholder="Template expression..."></textarea>
            </div>
          {/if}

          <!-- Branches -->
          <div class="space-y-2 border-t border-border pt-2 mt-2">
            <div class="flex items-center justify-between">
              <h5 class="text-[10px] font-semibold text-text-muted uppercase tracking-wider">Branches ({branchKeys.length})</h5>
              <button
                class="px-1.5 py-0.5 text-[10px] rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
                onclick={() => {
                  const key = `branch_${branchKeys.length + 1}`;
                  const updated = { ...branches, [key]: { next: '', description: '' } };
                  updateField('branches', updated);
                }}
              >+ Add</button>
            </div>

            {#each branchKeys as key (key)}
              {@const branch = branches[key]}
              {@const isLong = typeof branch === 'object'}
              {@const next = isLong ? branch.next : (branch as string)}
              {@const description = isLong ? branch.description || '' : ''}
              <div class="p-2 rounded border border-border/50 bg-surface-elevated/50 space-y-1.5">
                <div class="flex items-center gap-1.5">
                  <input type="text" value={key}
                    onchange={(e) => {
                      const newKey = e.currentTarget.value.trim();
                      if (!newKey || newKey === key) return;
                      const updated = { ...branches };
                      updated[newKey] = updated[key];
                      delete updated[key];
                      updateField('branches', updated);
                    }}
                    class="flex-1 px-1.5 py-0.5 text-[10px] font-semibold rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
                    placeholder="Branch key" />
                  <button
                    class="p-0.5 rounded text-text-muted hover:text-red-400 hover:bg-surface-elevated transition-colors"
                    onclick={() => {
                      const updated = { ...branches };
                      delete updated[key];
                      updateField('branches', updated);
                    }}
                    title="Remove branch"
                  >
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                    </svg>
                  </button>
                </div>
                <div>
                  <input type="text" value={next}
                    onchange={(e) => {
                      const updated = { ...branches };
                      if (isLong) {
                        updated[key] = { ...(branch as { description?: string; next: string }), next: e.currentTarget.value };
                      } else {
                        updated[key] = e.currentTarget.value;
                      }
                      updateField('branches', updated);
                    }}
                    list="inspector-node-ids"
                    class={smallInputCls}
                    placeholder="Target node ID" />
                </div>
                <div>
                  <input type="text" value={description}
                    onchange={(e) => {
                      const updated = { ...branches };
                      const desc = e.currentTarget.value;
                      if (desc || isLong) {
                        updated[key] = { next: next || '', description: desc || undefined };
                      }
                      updateField('branches', updated);
                    }}
                    class={smallInputCls}
                    placeholder="Description (optional)" />
                </div>
              </div>
            {/each}
          </div>

          <!-- Route options -->
          <div class="space-y-2 border-t border-border pt-2 mt-2">
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Default Branch</label>
              <input type="text" value={(getField('default') as string) || ''}
                onchange={(e) => updateField('default', e.currentTarget.value || undefined)}
                class={inputCls}
                placeholder="Fallback branch key" />
            </div>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={(getField('multi') as boolean) || false}
                onchange={(e) => updateField('multi', e.currentTarget.checked || undefined)}
                class="rounded border-border accent-accent" />
              <span class="text-xs text-text-secondary">Allow multiple branches</span>
            </label>
            {#if getField('multi')}
              <div class="flex gap-2">
                <div class="flex-1">
                  <label class="block text-[10px] text-text-muted mb-0.5">Min</label>
                  <input type="number" value={(getField('min') as number) || ''}
                    onchange={(e) => updateField('min', parseInt(e.currentTarget.value) || undefined)}
                    min="0"
                    class={inputCls} />
                </div>
                <div class="flex-1">
                  <label class="block text-[10px] text-text-muted mb-0.5">Max</label>
                  <input type="number" value={(getField('max') as number) || ''}
                    onchange={(e) => updateField('max', parseInt(e.currentTarget.value) || undefined)}
                    min="0"
                    class={inputCls} />
                </div>
              </div>
            {/if}
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Execution</label>
              <select value={(getField('execution') as string) || ''}
                onchange={(e) => updateField('execution', e.currentTarget.value || undefined)}
                class={selectCls}>
                <option value="">Default</option>
                <option value="sequential">Sequential</option>
                <option value="parallel">Parallel</option>
              </select>
            </div>
          </div>

        <!-- ============================================================= -->
        <!-- SCRIPT NODE                                                    -->
        <!-- ============================================================= -->
        {:else if nodeType === 'script'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Command</label>
            <textarea value={(getField('command') as string) || ''}
              onchange={(e) => updateField('command', e.currentTarget.value)}
              rows="3"
              class={textareaCls}
              placeholder="Shell command..."></textarea>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Working Directory</label>
            <input type="text" value={(getField('cwd') as string) || ''}
              onchange={(e) => updateField('cwd', e.currentTarget.value || undefined)}
              class={inputCls}
              placeholder="Default (sequence repo)" />
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-1">Environment Variables</label>
            {@render kvEditor('env', 'Variable', 'Value')}
          </div>

        <!-- ============================================================= -->
        <!-- NOTIFY NODE                                                    -->
        <!-- ============================================================= -->
        {:else if nodeType === 'notify'}
          <!-- Built-in: System Notification -->
          <label class="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={getField('system_notification') !== false}
              onchange={(e) => updateField('system_notification', e.currentTarget.checked)}
              class="rounded border-border accent-accent w-3.5 h-3.5" />
            <span class="text-[10px] text-text-secondary">System notification</span>
          </label>

          <!-- Built-in: Play Sound -->
          <label class="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={getField('play_sound') === true}
              onchange={(e) => updateField('play_sound', e.currentTarget.checked)}
              class="rounded border-border accent-accent w-3.5 h-3.5" />
            <span class="text-[10px] text-text-secondary">Play sound</span>
          </label>
          {#if getField('play_sound') === true}
            <div class="ml-5">
              <label class="block text-[10px] text-text-muted mb-0.5">Sound</label>
              <div class="flex items-center gap-1">
                <select value={String((getField('sound') as number) || 1)}
                  onchange={(e) => updateField('sound', parseInt(e.currentTarget.value))}
                  class="{selectCls} flex-1">
                  <option value="1">1 - Chime</option>
                  <option value="2">2 - Ping</option>
                  <option value="3">3 - Bell</option>
                  <option value="4">4 - Chirp</option>
                  <option value="5">5 - Blip</option>
                  <option value="6">6 - Ding</option>
                  <option value="7">7 - Tone</option>
                  <option value="8">8 - Alert</option>
                  <option value="9">9 - Pop</option>
                  <option value="10">10 - Gong</option>
                </select>
                <button
                  type="button"
                  class="px-1.5 py-1 text-[10px] rounded border border-border text-text-muted hover:text-accent hover:border-accent transition-colors shrink-0"
                  onclick={() => playNotificationSound((getField('sound') as number) || 1)}
                  title="Preview sound"
                >&#9654;</button>
              </div>
            </div>
          {/if}

          <!-- External Channel (optional) -->
          <div class="pt-1 mt-1 border-t border-border/30">
            <label class="block text-[10px] text-text-muted mb-0.5">External Channel</label>
            {#if $settings.sequences.notification_channels.length > 0}
              <select value={(getField('channel') as string) || ''}
                onchange={(e) => updateField('channel', e.currentTarget.value || undefined)}
                class={selectCls}>
                <option value="">None</option>
                {#each $settings.sequences.notification_channels as ch}
                  <option value={ch.id}>{ch.name} ({ch.channel_type})</option>
                {/each}
              </select>
            {:else}
              <p class="text-[10px] text-text-muted italic">No external channels configured. Add in Settings &rarr; Sequences.</p>
            {/if}
          </div>

          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Title</label>
            <input type="text" value={(getField('title') as string) || ''}
              onchange={(e) => updateField('title', e.currentTarget.value || undefined)}
              class={inputCls}
              placeholder="Notification title" />
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Message</label>
            <textarea value={(getField('message') as string) || ''}
              onchange={(e) => updateField('message', e.currentTarget.value)}
              rows="3"
              class={textareaCls}
              placeholder="Message template..."></textarea>
          </div>

        <!-- ============================================================= -->
        <!-- DELAY NODE                                                     -->
        <!-- ============================================================= -->
        {:else if nodeType === 'delay'}
          {@const dur = parseDuration((getField('duration') as string) || '5s')}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Duration</label>
            <div class="flex gap-1.5">
              <input type="number" value={dur.value}
                onchange={(e) => {
                  const val = parseFloat(e.currentTarget.value) || 0;
                  updateField('duration', `${val}${dur.unit}`);
                }}
                min="0" step="1"
                class="flex-1 px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none" />
              <select value={dur.unit}
                onchange={(e) => {
                  updateField('duration', `${dur.value}${e.currentTarget.value}`);
                }}
                class="w-24 px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none">
                <option value="ms">ms</option>
                <option value="s">seconds</option>
                <option value="m">minutes</option>
                <option value="h">hours</option>
              </select>
            </div>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Message</label>
            <input type="text" value={(getField('message') as string) || ''}
              onchange={(e) => updateField('message', e.currentTarget.value || undefined)}
              class={inputCls}
              placeholder="Optional status message" />
          </div>

        <!-- ============================================================= -->
        <!-- APPROVAL NODE                                                  -->
        <!-- ============================================================= -->
        {:else if nodeType === 'approval'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Message</label>
            <textarea value={(getField('message') as string) || ''}
              onchange={(e) => updateField('message', e.currentTarget.value)}
              rows="2"
              class={textareaCls}
              placeholder="Approval prompt message..."></textarea>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Timeout (seconds)</label>
            <input type="number" value={(getField('timeout') as number) || ''}
              onchange={(e) => updateField('timeout', parseInt(e.currentTarget.value) || undefined)}
              min="0"
              class={inputCls}
              placeholder="No timeout" />
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">On Timeout</label>
            <select value={(getField('on_timeout') as string) || ''}
              onchange={(e) => updateField('on_timeout', e.currentTarget.value || undefined)}
              class={selectCls}>
              <option value="">Default (fail)</option>
              <option value="skip">Skip node</option>
              <option value="stop">Stop sequence</option>
              <option value="approve">Auto-approve</option>
            </select>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Notify Channel</label>
            {#if $settings.sequences.notification_channels.length > 0}
              <select value={(getField('notify') as string) || ''}
                onchange={(e) => updateField('notify', e.currentTarget.value || undefined)}
                class={selectCls}>
                <option value="">None</option>
                {#each $settings.sequences.notification_channels as ch}
                  <option value={ch.id}>{ch.name}</option>
                {/each}
              </select>
            {:else}
              <p class="text-[10px] text-text-muted italic">No channels configured</p>
            {/if}
          </div>

        <!-- ============================================================= -->
        <!-- FILE NODE                                                      -->
        <!-- ============================================================= -->
        {:else if nodeType === 'file'}
          {@const fileOp = (getField('operation') as string) || 'read'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Operation</label>
            <select value={fileOp}
              onchange={(e) => updateField('operation', e.currentTarget.value)}
              class={selectCls}>
              <option value="read">Read</option>
              <option value="write">Write</option>
              <option value="append">Append</option>
              <option value="delete">Delete</option>
              <option value="move">Move</option>
              <option value="copy">Copy</option>
              <option value="mkdir">Create Directory</option>
              <option value="exists">Check Exists</option>
            </select>
          </div>
          {#if ['read', 'write', 'append', 'delete', 'mkdir', 'exists'].includes(fileOp)}
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Path</label>
              <input type="text" value={(getField('path') as string) || ''}
                onchange={(e) => updateField('path', e.currentTarget.value || undefined)}
                class="{inputCls} font-mono"
                placeholder="File path or template variable" />
            </div>
          {/if}
          {#if ['write', 'append'].includes(fileOp)}
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Content</label>
              <textarea value={(getField('content') as string) || ''}
                onchange={(e) => updateField('content', e.currentTarget.value || undefined)}
                rows="3"
                class={textareaCls}
                placeholder="File content or template..."></textarea>
            </div>
          {/if}
          {#if ['move', 'copy'].includes(fileOp)}
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Source</label>
              <input type="text" value={(getField('source') as string) || ''}
                onchange={(e) => updateField('source', e.currentTarget.value || undefined)}
                class="{inputCls} font-mono"
                placeholder="Source path" />
            </div>
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Destination</label>
              <input type="text" value={(getField('destination') as string) || ''}
                onchange={(e) => updateField('destination', e.currentTarget.value || undefined)}
                class="{inputCls} font-mono"
                placeholder="Destination path" />
            </div>
          {/if}

        <!-- ============================================================= -->
        <!-- HTTP NODE                                                      -->
        <!-- ============================================================= -->
        {:else if nodeType === 'http'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">URL</label>
            <input type="text" value={(getField('url') as string) || ''}
              onchange={(e) => updateField('url', e.currentTarget.value)}
              class={inputCls}
              placeholder="https://..." />
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Method</label>
            <select value={(getField('method') as string) || 'GET'}
              onchange={(e) => updateField('method', e.currentTarget.value)}
              class={selectCls}>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="DELETE">DELETE</option>
              <option value="PATCH">PATCH</option>
            </select>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-1">Headers</label>
            {@render kvEditor('headers', 'Header name', 'Value')}
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Body</label>
            <textarea value={(getField('body') as string) || ''}
              onchange={(e) => updateField('body', e.currentTarget.value || undefined)}
              rows="3"
              class={textareaCls}
              placeholder="Request body..."></textarea>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Expected Status Codes</label>
            <input type="text" value={((getField('expected_status') as number[]) || []).join(', ')}
              onchange={(e) => {
                const val = e.currentTarget.value.trim();
                const codes = val ? val.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n)) : undefined;
                updateField('expected_status', codes?.length ? codes : undefined);
              }}
              class={inputCls}
              placeholder="200, 201 (empty = any success)" />
          </div>

        <!-- ============================================================= -->
        <!-- WAIT NODE                                                      -->
        <!-- ============================================================= -->
        {:else if nodeType === 'wait'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Condition</label>
            <textarea value={(getField('condition') as string) || ''}
              onchange={(e) => updateField('condition', e.currentTarget.value || undefined)}
              rows="2"
              class={textareaCls}
              placeholder="Template expression to evaluate..."></textarea>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Poll Command</label>
            <input type="text" value={(getField('poll_command') as string) || ''}
              onchange={(e) => updateField('poll_command', e.currentTarget.value || undefined)}
              class="{inputCls} font-mono"
              placeholder="Shell command to check condition" />
          </div>
          <div class="flex gap-2">
            <div class="flex-1">
              <label class="block text-[10px] text-text-muted mb-0.5">Poll Interval (s)</label>
              <input type="number" value={(getField('poll_interval') as number) || ''}
                onchange={(e) => updateField('poll_interval', parseInt(e.currentTarget.value) || undefined)}
                min="1"
                class={inputCls}
                placeholder="10" />
            </div>
            <div class="flex-1">
              <label class="block text-[10px] text-text-muted mb-0.5">Timeout (s)</label>
              <input type="number" value={(getField('timeout') as number) || ''}
                onchange={(e) => updateField('timeout', parseInt(e.currentTarget.value) || undefined)}
                min="0"
                class={inputCls}
                placeholder="None" />
            </div>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">On Timeout</label>
            <select value={(getField('on_timeout') as string) || ''}
              onchange={(e) => updateField('on_timeout', e.currentTarget.value || undefined)}
              class={selectCls}>
              <option value="">Default (fail)</option>
              <option value="skip">Skip</option>
              <option value="continue">Continue</option>
            </select>
          </div>

        <!-- ============================================================= -->
        <!-- LOOP NODE                                                      -->
        <!-- ============================================================= -->
        {:else if nodeType === 'loop'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Max Iterations</label>
            <input type="number" value={(getField('max_iterations') as number) || ''}
              onchange={(e) => updateField('max_iterations', parseInt(e.currentTarget.value) || undefined)}
              min="1" max="1000"
              class={inputCls}
              placeholder="10" />
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Until Condition</label>
            <input type="text" value={(getField('until') as string) || ''}
              onchange={(e) => updateField('until', e.currentTarget.value || undefined)}
              class="{inputCls} font-mono"
              placeholder="Expression that stops loop when true" />
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Delay Between Iterations</label>
            <input type="text" value={(getField('delay') as string) || ''}
              onchange={(e) => updateField('delay', e.currentTarget.value || undefined)}
              class={inputCls}
              placeholder="e.g., 5s, 1m" />
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">On Max Iterations</label>
            <select value={(getField('on_max_iterations') as string) || ''}
              onchange={(e) => updateField('on_max_iterations', e.currentTarget.value || undefined)}
              class={selectCls}>
              <option value="">Default (continue)</option>
              <option value="stop">Stop sequence</option>
              <option value="fail">Fail with error</option>
            </select>
          </div>
          <div class="p-2 rounded bg-surface-elevated/50 border border-border/50">
            <p class="text-[10px] text-text-muted">
              <span class="font-semibold">Nested nodes:</span>
              {((getField('nodes') as unknown[]) || []).length} node(s) configured.
              Edit nested nodes via YAML preview.
            </p>
          </div>

        <!-- ============================================================= -->
        <!-- PARALLEL NODE                                                  -->
        <!-- ============================================================= -->
        {:else if nodeType === 'parallel'}
          {@const parallelBranches = (getField('branches') as Record<string, unknown[]>) || {}}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Wait Mode</label>
            <select value={typeof (getField('wait')) === 'number' ? 'count' : (getField('wait') as string) || 'all'}
              onchange={(e) => {
                const val = e.currentTarget.value;
                if (val === 'count') {
                  updateField('wait', 1);
                } else {
                  updateField('wait', val === 'all' ? undefined : val);
                }
              }}
              class={selectCls}>
              <option value="all">Wait for All</option>
              <option value="first">Wait for First</option>
              <option value="any">Wait for Any</option>
              <option value="count">Wait for N</option>
            </select>
          </div>
          {#if typeof (getField('wait')) === 'number'}
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Wait Count</label>
              <input type="number" value={(getField('wait') as number) || 1}
                onchange={(e) => updateField('wait', parseInt(e.currentTarget.value) || 1)}
                min="1"
                class={inputCls} />
            </div>
          {/if}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">On Branch Error</label>
            <select value={(getField('on_branch_error') as string) || ''}
              onchange={(e) => updateField('on_branch_error', e.currentTarget.value || undefined)}
              class={selectCls}>
              <option value="">Default (fail)</option>
              <option value="ignore">Ignore</option>
              <option value="skip">Skip</option>
              <option value="cancel_others">Cancel Others</option>
              <option value="fail">Fail</option>
            </select>
          </div>
          <div class="p-2 rounded bg-surface-elevated/50 border border-border/50">
            <p class="text-[10px] text-text-muted">
              <span class="font-semibold">Branches:</span>
              {Object.keys(parallelBranches).length} branch(es) configured.
              Edit parallel branches via YAML preview.
            </p>
          </div>

        <!-- ============================================================= -->
        <!-- FOR_EACH NODE                                                  -->
        <!-- ============================================================= -->
        {:else if nodeType === 'for_each'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Items</label>
            <textarea value={(getField('items') as string) || ''}
              onchange={(e) => updateField('items', e.currentTarget.value)}
              rows="2"
              class={textareaCls}
              placeholder="Expression returning array, e.g. repos variable"></textarea>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Variable Name</label>
            <input type="text" value={(getField('variable') as string) || ''}
              onchange={(e) => updateField('variable', e.currentTarget.value || undefined)}
              class={inputCls}
              placeholder="item (default)" />
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Execution Mode</label>
            <select value={(getField('mode') as string) || 'sequential'}
              onchange={(e) => updateField('mode', e.currentTarget.value || undefined)}
              class={selectCls}>
              <option value="sequential">Sequential</option>
              <option value="parallel">Parallel</option>
            </select>
          </div>
          {#if (getField('mode') as string) === 'parallel'}
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Max Parallel</label>
              <input type="number" value={(getField('max_parallel') as number) || ''}
                onchange={(e) => updateField('max_parallel', parseInt(e.currentTarget.value) || undefined)}
                min="1"
                class={inputCls}
                placeholder="Unlimited" />
            </div>
          {/if}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">On Item Error</label>
            <select value={(getField('on_item_error') as string) || ''}
              onchange={(e) => updateField('on_item_error', e.currentTarget.value || undefined)}
              class={selectCls}>
              <option value="">Default (stop)</option>
              <option value="skip">Skip item</option>
              <option value="continue">Continue</option>
              <option value="stop">Stop loop</option>
            </select>
          </div>
          <div class="p-2 rounded bg-surface-elevated/50 border border-border/50">
            <p class="text-[10px] text-text-muted">
              <span class="font-semibold">Loop body:</span>
              {((getField('nodes') as unknown[]) || []).length} node(s) configured.
              Edit nested nodes via YAML preview.
            </p>
          </div>

        <!-- ============================================================= -->
        <!-- SUB_SEQUENCE NODE                                              -->
        <!-- ============================================================= -->
        {:else if nodeType === 'sub_sequence'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Sequence</label>
            {#if $sequences.length > 0}
              <select value={(getField('sequence') as string) || ''}
                onchange={(e) => updateField('sequence', e.currentTarget.value || undefined)}
                class={selectCls}>
                <option value="">Select sequence...</option>
                {#each $sequences as seq}
                  <option value={seq.id}>{seq.name}</option>
                {/each}
              </select>
            {:else}
              <input type="text" value={(getField('sequence') as string) || ''}
                onchange={(e) => updateField('sequence', e.currentTarget.value || undefined)}
                class={inputCls}
                placeholder="Sequence ID" />
              <p class="text-[10px] text-text-muted mt-0.5">No saved sequences found.</p>
            {/if}
          </div>
          {@const subInputs = (getField('inputs') as Record<string, unknown>) || {}}
          {@const subInputKeys = Object.keys(subInputs)}
          {#if subInputKeys.length > 0 || true}
            <div>
              <label class="block text-[10px] text-text-muted mb-1">Input Mappings</label>
              <div class="space-y-1">
                {#each subInputKeys as key, i (i)}
                  <div class="flex items-center gap-1">
                    <input type="text" value={key}
                      onchange={(e) => {
                        const newKey = e.currentTarget.value;
                        const updated = { ...subInputs };
                        const val = updated[key];
                        delete updated[key];
                        if (newKey) updated[newKey] = val;
                        updateField('inputs', Object.keys(updated).length ? updated : undefined);
                      }}
                      class="flex-1 px-1.5 py-0.5 text-[10px] rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
                      placeholder="Input name" />
                    <input type="text" value={String(subInputs[key] ?? '')}
                      onchange={(e) => {
                        updateField('inputs', { ...subInputs, [key]: e.currentTarget.value });
                      }}
                      class="flex-1 px-1.5 py-0.5 text-[10px] rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
                      placeholder="Value or {'{{'}var{'}}'}" />
                    <button class="p-0.5 rounded text-text-muted hover:text-red-400 transition-colors"
                      onclick={() => {
                        const updated = { ...subInputs };
                        delete updated[key];
                        updateField('inputs', Object.keys(updated).length ? updated : undefined);
                      }}>
                      <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                      </svg>
                    </button>
                  </div>
                {/each}
                <button class="w-full px-2 py-0.5 text-[10px] rounded border border-dashed border-border text-text-muted hover:border-accent hover:text-accent transition-colors"
                  onclick={() => {
                    const k = subInputKeys.length === 0 ? '' : `input_${subInputKeys.length + 1}`;
                    updateField('inputs', { ...subInputs, [k]: '' });
                  }}>+ Add Input</button>
              </div>
            </div>
          {/if}

        <!-- ============================================================= -->
        <!-- TRANSFORM NODE                                                 -->
        <!-- ============================================================= -->
        {:else if nodeType === 'transform'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Input</label>
            <textarea value={(getField('input') as string) || ''}
              onchange={(e) => updateField('input', e.currentTarget.value)}
              rows="2"
              class={textareaCls}
              placeholder="Template expression for input data..."></textarea>
          </div>
          {@const operations = (getField('operations') as Array<{ type: string; pattern?: string; replacement?: string; path?: string; template?: string }>) || []}
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <label class="text-[10px] font-semibold text-text-muted uppercase tracking-wider">Operations ({operations.length})</label>
              <button class="px-1.5 py-0.5 text-[10px] rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
                onclick={() => updateField('operations', [...operations, { type: 'template', template: '' }])}>+ Add</button>
            </div>
            {#each operations as op, i}
              <div class="p-2 rounded border border-border/50 bg-surface-elevated/50 space-y-1.5">
                <div class="flex items-center gap-1.5">
                  <select value={op.type}
                    onchange={(e) => {
                      const updated = [...operations];
                      updated[i] = { type: e.currentTarget.value };
                      updateField('operations', updated);
                    }}
                    class="flex-1 px-1.5 py-0.5 text-[10px] rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none">
                    <option value="regex">Regex</option>
                    <option value="json_path">JSON Path</option>
                    <option value="template">Template</option>
                  </select>
                  <button class="p-0.5 rounded text-text-muted hover:text-red-400 transition-colors"
                    onclick={() => updateField('operations', operations.filter((_: unknown, idx: number) => idx !== i))}
                    title="Remove operation">
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                    </svg>
                  </button>
                </div>
                {#if op.type === 'regex'}
                  <input type="text" value={op.pattern || ''}
                    onchange={(e) => {
                      const updated = [...operations];
                      updated[i] = { ...op, pattern: e.currentTarget.value };
                      updateField('operations', updated);
                    }}
                    class={smallInputCls}
                    placeholder="Regex pattern" />
                  <input type="text" value={op.replacement || ''}
                    onchange={(e) => {
                      const updated = [...operations];
                      updated[i] = { ...op, replacement: e.currentTarget.value };
                      updateField('operations', updated);
                    }}
                    class={smallInputCls}
                    placeholder="Replacement" />
                {:else if op.type === 'json_path'}
                  <input type="text" value={op.path || ''}
                    onchange={(e) => {
                      const updated = [...operations];
                      updated[i] = { ...op, path: e.currentTarget.value };
                      updateField('operations', updated);
                    }}
                    class={smallInputCls}
                    placeholder="$.path.to.value" />
                {:else if op.type === 'template'}
                  <input type="text" value={op.template || ''}
                    onchange={(e) => {
                      const updated = [...operations];
                      updated[i] = { ...op, template: e.currentTarget.value };
                      updateField('operations', updated);
                    }}
                    class={smallInputCls}
                    placeholder="Template expression" />
                {/if}
              </div>
            {/each}
          </div>

        <!-- ============================================================= -->
        <!-- GIT BRANCH NODE                                                -->
        <!-- ============================================================= -->
        {:else if nodeType === 'git_branch'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Branch Name</label>
            <input type="text" value={(getField('branch_name') as string) || ''}
              onchange={(e) => updateField('branch_name', e.currentTarget.value)}
              class={inputCls}
              placeholder="feature/..." />
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">From</label>
            <input type="text" value={(getField('from') as string) || ''}
              onchange={(e) => updateField('from', e.currentTarget.value || undefined)}
              class={inputCls}
              placeholder="main" />
          </div>

        <!-- ============================================================= -->
        <!-- GIT WORKTREE NODE                                              -->
        <!-- ============================================================= -->
        {:else if nodeType === 'git_worktree'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Branch Name</label>
            <input type="text" value={(getField('branch_name') as string) || ''}
              onchange={(e) => updateField('branch_name', e.currentTarget.value)}
              class={inputCls}
              placeholder="feature/..." />
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Worktree Path</label>
            <input type="text" value={(getField('worktree_path') as string) || ''}
              onchange={(e) => updateField('worktree_path', e.currentTarget.value || undefined)}
              class="{inputCls} font-mono"
              placeholder="Auto-generated" />
          </div>

        <!-- ============================================================= -->
        <!-- GIT COMMIT NODE                                                -->
        <!-- ============================================================= -->
        {:else if nodeType === 'git_commit'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Commit Message</label>
            <textarea value={(getField('message') as string) || ''}
              onchange={(e) => updateField('message', e.currentTarget.value)}
              rows="2"
              class={textareaCls}
              placeholder="Commit message or template variable"></textarea>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Stage Patterns</label>
            {@render tagEditor('add', 'Add glob pattern + Enter')}
            <p class="text-[10px] text-text-muted mt-0.5">e.g. ".", "*.ts", "src/"</p>
          </div>

        <!-- ============================================================= -->
        <!-- GIT PUSH NODE                                                  -->
        <!-- ============================================================= -->
        {:else if nodeType === 'git_push'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Remote</label>
            <input type="text" value={(getField('remote') as string) || ''}
              onchange={(e) => updateField('remote', e.currentTarget.value || undefined)}
              class={inputCls}
              placeholder="origin (default)" />
          </div>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={(getField('force') as boolean) || false}
              onchange={(e) => updateField('force', e.currentTarget.checked || undefined)}
              class="rounded border-border accent-accent" />
            <span class="text-xs text-text-secondary">Force push</span>
          </label>

        <!-- ============================================================= -->
        <!-- GIT DELETE BRANCH NODE                                         -->
        <!-- ============================================================= -->
        {:else if nodeType === 'git_delete_branch'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Branch</label>
            <input type="text" value={(getField('branch') as string) || ''}
              onchange={(e) => updateField('branch', e.currentTarget.value)}
              class={inputCls}
              placeholder="Branch name or template variable" />
          </div>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={(getField('remote') as boolean) || false}
              onchange={(e) => updateField('remote', e.currentTarget.checked || undefined)}
              class="rounded border-border accent-accent" />
            <span class="text-xs text-text-secondary">Delete remote branch too</span>
          </label>

        <!-- ============================================================= -->
        <!-- GIT DELETE WORKTREE NODE                                       -->
        <!-- ============================================================= -->
        {:else if nodeType === 'git_delete_worktree'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Worktree Path</label>
            <input type="text" value={(getField('path') as string) || ''}
              onchange={(e) => updateField('path', e.currentTarget.value)}
              class="{inputCls} font-mono"
              placeholder="Path to worktree or template variable" />
          </div>

        <!-- ============================================================= -->
        <!-- GITHUB PR NODE                                                 -->
        <!-- ============================================================= -->
        {:else if nodeType === 'github_pr'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">PR Title</label>
            <input type="text" value={(getField('title') as string) || ''}
              onchange={(e) => updateField('title', e.currentTarget.value)}
              class={inputCls} />
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Body</label>
            <textarea value={(getField('body') as string) || ''}
              onchange={(e) => updateField('body', e.currentTarget.value || undefined)}
              rows="3"
              class={textareaCls}
              placeholder="PR description..."></textarea>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Target Branch</label>
            <input type="text" value={(getField('target_branch') as string) || ''}
              onchange={(e) => updateField('target_branch', e.currentTarget.value || undefined)}
              class={inputCls}
              placeholder="main" />
          </div>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={(getField('draft') as boolean) || false}
              onchange={(e) => updateField('draft', e.currentTarget.checked || undefined)}
              class="rounded border-border accent-accent" />
            <span class="text-xs text-text-secondary">Draft PR</span>
          </label>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Labels</label>
            {@render tagEditor('labels', 'Add label + Enter')}
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Reviewers</label>
            {@render tagEditor('reviewers', 'Add reviewer + Enter')}
          </div>

        <!-- ============================================================= -->
        <!-- GITHUB PR WAIT NODE                                            -->
        <!-- ============================================================= -->
        {:else if nodeType === 'github_pr_wait'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">PR Reference</label>
            <input type="text" value={(getField('pr') as string) || ''}
              onchange={(e) => updateField('pr', e.currentTarget.value)}
              class={inputCls}
              placeholder="PR number or template variable" />
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Wait For</label>
            <select value={(getField('wait_for') as string) || 'checks'}
              onchange={(e) => updateField('wait_for', e.currentTarget.value)}
              class={selectCls}>
              <option value="checks">CI Checks</option>
              <option value="review">Review Approval</option>
              <option value="merge">PR Merged</option>
              <option value="mergeable">Mergeable (no conflicts)</option>
            </select>
          </div>
          <div class="flex gap-2">
            <div class="flex-1">
              <label class="block text-[10px] text-text-muted mb-0.5">Poll Interval (s)</label>
              <input type="number" value={(getField('poll_interval') as number) || ''}
                onchange={(e) => updateField('poll_interval', parseInt(e.currentTarget.value) || undefined)}
                min="5"
                class={inputCls}
                placeholder="30" />
            </div>
            <div class="flex-1">
              <label class="block text-[10px] text-text-muted mb-0.5">Timeout (s)</label>
              <input type="number" value={(getField('timeout') as number) || ''}
                onchange={(e) => updateField('timeout', parseInt(e.currentTarget.value) || undefined)}
                min="0"
                class={inputCls}
                placeholder="None" />
            </div>
          </div>

        <!-- ============================================================= -->
        <!-- GITHUB PR MERGE NODE                                           -->
        <!-- ============================================================= -->
        {:else if nodeType === 'github_pr_merge'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">PR Reference</label>
            <input type="text" value={(getField('pr') as string) || ''}
              onchange={(e) => updateField('pr', e.currentTarget.value)}
              class={inputCls}
              placeholder="PR number or template variable" />
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Merge Method</label>
            <select value={(getField('method') as string) || ''}
              onchange={(e) => updateField('method', e.currentTarget.value || undefined)}
              class={selectCls}>
              <option value="">Default (merge)</option>
              <option value="merge">Merge commit</option>
              <option value="squash">Squash and merge</option>
              <option value="rebase">Rebase and merge</option>
            </select>
          </div>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={(getField('delete_branch') as boolean) || false}
              onchange={(e) => updateField('delete_branch', e.currentTarget.checked || undefined)}
              class="rounded border-border accent-accent" />
            <span class="text-xs text-text-secondary">Delete branch after merge</span>
          </label>

        <!-- ============================================================= -->
        <!-- FALLBACK - Unknown node type                                   -->
        <!-- ============================================================= -->
        {:else}
          <p class="text-[10px] text-text-muted italic">Edit this node type via YAML preview.</p>
        {/if}
      </div>

      <!-- ================================================================= -->
      <!-- Error handling (enhanced with goto) - hidden for trigger nodes   -->
      <!-- ================================================================= -->
      {#if nodeType !== 'trigger'}
      <div class="space-y-2 border-t border-border pt-3">
        <h4 class="text-[10px] font-semibold text-text-muted uppercase tracking-wider">Error Handling</h4>
        <div>
          <label class="block text-[10px] text-text-muted mb-0.5">On Error</label>
          <select value={errorStrategy}
            onchange={(e) => {
              const val = e.currentTarget.value;
              if (val === 'goto') {
                updateField('on_error', { goto: { target: '' } });
              } else {
                updateField('on_error', val || undefined);
              }
            }}
            class={selectCls}>
            <option value="">Default</option>
            <option value="stop">Stop</option>
            <option value="retry">Retry</option>
            <option value="skip">Skip</option>
            <option value="goto">Go to node...</option>
          </select>
        </div>
        {#if errorStrategy === 'goto'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Target Node</label>
            {#if otherNodes.length > 0}
              <select value={gotoTarget}
                onchange={(e) => updateField('on_error', { goto: { target: e.currentTarget.value } })}
                class={selectCls}>
                <option value="">Select node...</option>
                {#each otherNodes as node}
                  <option value={node.data.nodeDefinition.id}>{node.data.label} ({node.data.nodeDefinition.type})</option>
                {/each}
              </select>
            {:else}
              <p class="text-[10px] text-text-muted italic">No other nodes available</p>
            {/if}
          </div>
        {/if}
        {#if errorStrategy === 'retry' || (getField('retry_count') as number) > 0}
          <div class="flex gap-2">
            <div class="flex-1">
              <label class="block text-[10px] text-text-muted mb-0.5">Retry Count</label>
              <input type="number" value={selectedNode.data.nodeDefinition.retry_count || 0}
                onchange={(e) => updateField('retry_count', parseInt(e.currentTarget.value) || undefined)}
                min="0" max="10"
                class={inputCls} />
            </div>
            <div class="flex-1">
              <label class="block text-[10px] text-text-muted mb-0.5">Retry Delay (s)</label>
              <input type="number" value={selectedNode.data.nodeDefinition.retry_delay || 0}
                onchange={(e) => updateField('retry_delay', parseInt(e.currentTarget.value) || undefined)}
                min="0"
                class={inputCls} />
            </div>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Backoff Multiplier</label>
            <input type="number" value={selectedNode.data.nodeDefinition.retry_backoff || ''}
              onchange={(e) => updateField('retry_backoff', parseFloat(e.currentTarget.value) || undefined)}
              min="1" step="0.5"
              class={inputCls}
              placeholder="1.0 (no backoff)" />
          </div>
        {:else}
          <div class="flex gap-2">
            <div class="flex-1">
              <label class="block text-[10px] text-text-muted mb-0.5">Retry Count</label>
              <input type="number" value={selectedNode.data.nodeDefinition.retry_count || 0}
                onchange={(e) => updateField('retry_count', parseInt(e.currentTarget.value) || undefined)}
                min="0" max="10"
                class={inputCls} />
            </div>
            <div class="flex-1">
              <label class="block text-[10px] text-text-muted mb-0.5">Retry Delay (s)</label>
              <input type="number" value={selectedNode.data.nodeDefinition.retry_delay || 0}
                onchange={(e) => updateField('retry_delay', parseInt(e.currentTarget.value) || undefined)}
                min="0"
                class={inputCls} />
            </div>
          </div>
        {/if}
        <div>
          <label class="block text-[10px] text-text-muted mb-0.5">Timeout (seconds)</label>
          <input type="number" value={selectedNode.data.nodeDefinition.timeout || ''}
            onchange={(e) => updateField('timeout', parseInt(e.currentTarget.value) || undefined)}
            class={inputCls}
            placeholder="Default" />
        </div>
      </div>
      {/if}
    </div>
  {/if}
</div>
