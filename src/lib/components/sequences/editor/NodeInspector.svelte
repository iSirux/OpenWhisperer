<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import type { NodeDefinition } from '$lib/types/sequence';
  import type { EditorNode } from '$lib/utils/sequenceConverter';

  let {
    selectedNode = $bindable<EditorNode | null>(null),
    onNodeUpdate = (node: EditorNode) => {},
    onNodeDelete = (nodeId: string) => {},
  }: {
    selectedNode: EditorNode | null;
    onNodeUpdate?: (node: EditorNode) => void;
    onNodeDelete?: (nodeId: string) => void;
  } = $props();

  let confirmingDelete = $state(false);

  let aiAssistDescription = $state('');
  let aiAssistLoading = $state(false);

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
    <div class="flex items-center justify-center h-full text-text-muted text-xs">
      Select a node to edit
    </div>
  {:else}
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
          class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none resize-y"
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
            class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none" />
        </div>
        <div>
          <label class="block text-[10px] text-text-muted mb-0.5">Name</label>
          <input type="text" value={selectedNode.data.nodeDefinition.name || ''}
            onchange={(e) => updateField('name', e.currentTarget.value || undefined)}
            class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
            placeholder="Optional display name" />
        </div>
        <div>
          <label class="block text-[10px] text-text-muted mb-0.5">Condition</label>
          <input type="text" value={selectedNode.data.nodeDefinition.condition || ''}
            onchange={(e) => updateField('condition', e.currentTarget.value || undefined)}
            class="w-full px-2 py-1 text-xs font-mono rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
            placeholder="Template expression" />
        </div>
        <div>
          <label class="block text-[10px] text-text-muted mb-0.5">Next Node</label>
          <input type="text" value={selectedNode.data.nodeDefinition.next || ''}
            onchange={(e) => updateField('next', e.currentTarget.value || undefined)}
            class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
            placeholder="Auto (sequential)" />
        </div>
      </div>

      <!-- Type-specific fields -->
      <div class="space-y-2 border-t border-border pt-3">
        <h4 class="text-[10px] font-semibold text-text-muted uppercase tracking-wider">{nodeType.replace(/_/g, ' ')} Config</h4>

        {#if nodeType === 'prompt'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Prompt</label>
            <textarea value={(getField('prompt') as string) || ''}
              onchange={(e) => updateField('prompt', e.currentTarget.value)}
              rows="4"
              class="w-full px-2 py-1 text-xs font-mono rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none resize-y"
              placeholder="Enter prompt template..."></textarea>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Model</label>
            <select value={(getField('model') as string) || ''}
              onchange={(e) => updateField('model', e.currentTarget.value || undefined)}
              class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none">
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
              class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none">
              <option value="">Default</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">System Prompt</label>
            <textarea value={(getField('system_prompt') as string) || ''}
              onchange={(e) => updateField('system_prompt', e.currentTarget.value || undefined)}
              rows="2"
              class="w-full px-2 py-1 text-xs font-mono rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none resize-y"
              placeholder="Optional system prompt"></textarea>
          </div>
        {:else if nodeType === 'script'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Command</label>
            <textarea value={(getField('command') as string) || ''}
              onchange={(e) => updateField('command', e.currentTarget.value)}
              rows="3"
              class="w-full px-2 py-1 text-xs font-mono rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none resize-y"
              placeholder="Shell command..."></textarea>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Working Directory</label>
            <input type="text" value={(getField('cwd') as string) || ''}
              onchange={(e) => updateField('cwd', e.currentTarget.value || undefined)}
              class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
              placeholder="Default" />
          </div>
        {:else if nodeType === 'notify'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Channel</label>
            <input type="text" value={(getField('channel') as string) || ''}
              onchange={(e) => updateField('channel', e.currentTarget.value || undefined)}
              class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
              placeholder="Channel ID" />
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Title</label>
            <input type="text" value={(getField('title') as string) || ''}
              onchange={(e) => updateField('title', e.currentTarget.value || undefined)}
              class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
              placeholder="Notification title" />
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Message</label>
            <textarea value={(getField('message') as string) || ''}
              onchange={(e) => updateField('message', e.currentTarget.value)}
              rows="3"
              class="w-full px-2 py-1 text-xs font-mono rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none resize-y"
              placeholder="Message template..."></textarea>
          </div>
        {:else if nodeType === 'delay'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Duration</label>
            <input type="text" value={(getField('duration') as string) || ''}
              onchange={(e) => updateField('duration', e.currentTarget.value)}
              class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
              placeholder="e.g., 5s, 1m, 2h" />
          </div>
        {:else if nodeType === 'approval'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Message</label>
            <textarea value={(getField('message') as string) || ''}
              onchange={(e) => updateField('message', e.currentTarget.value)}
              rows="2"
              class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none resize-y"></textarea>
          </div>
        {:else if nodeType === 'git_branch'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Branch Name</label>
            <input type="text" value={(getField('branch_name') as string) || ''}
              onchange={(e) => updateField('branch_name', e.currentTarget.value)}
              class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
              placeholder="feature/..." />
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">From</label>
            <input type="text" value={(getField('from') as string) || ''}
              onchange={(e) => updateField('from', e.currentTarget.value || undefined)}
              class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
              placeholder="main" />
          </div>
        {:else if nodeType === 'git_commit'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Commit Message</label>
            <textarea value={(getField('message') as string) || ''}
              onchange={(e) => updateField('message', e.currentTarget.value)}
              rows="2"
              class="w-full px-2 py-1 text-xs font-mono rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none resize-y"></textarea>
          </div>
        {:else if nodeType === 'github_pr'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">PR Title</label>
            <input type="text" value={(getField('title') as string) || ''}
              onchange={(e) => updateField('title', e.currentTarget.value)}
              class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none" />
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Body</label>
            <textarea value={(getField('body') as string) || ''}
              onchange={(e) => updateField('body', e.currentTarget.value || undefined)}
              rows="3"
              class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none resize-y"></textarea>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Target Branch</label>
            <input type="text" value={(getField('target_branch') as string) || ''}
              onchange={(e) => updateField('target_branch', e.currentTarget.value || undefined)}
              class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
              placeholder="main" />
          </div>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={(getField('draft') as boolean) || false}
              onchange={(e) => updateField('draft', e.currentTarget.checked || undefined)}
              class="rounded border-border accent-accent" />
            <span class="text-xs text-text-secondary">Draft PR</span>
          </label>
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
              class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none">
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
                class="w-full px-2 py-1 text-xs font-mono rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none resize-y"
                placeholder="LLM prompt to decide branch..."></textarea>
            </div>
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Context</label>
              <textarea value={(getField('context') as string) || ''}
                onchange={(e) => updateField('context', e.currentTarget.value || undefined)}
                rows="2"
                class="w-full px-2 py-1 text-xs font-mono rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none resize-y"
                placeholder="Additional context..."></textarea>
            </div>
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Model</label>
              <select value={(getField('model') as string) || ''}
                onchange={(e) => updateField('model', e.currentTarget.value || undefined)}
                class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none">
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
                class="w-full px-2 py-1 text-xs font-mono rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none resize-y"
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
                    class="w-full px-1.5 py-0.5 text-[10px] rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
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
                    class="w-full px-1.5 py-0.5 text-[10px] rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
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
                class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
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
                    class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none" />
                </div>
                <div class="flex-1">
                  <label class="block text-[10px] text-text-muted mb-0.5">Max</label>
                  <input type="number" value={(getField('max') as number) || ''}
                    onchange={(e) => updateField('max', parseInt(e.currentTarget.value) || undefined)}
                    min="0"
                    class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none" />
                </div>
              </div>
            {/if}
            <div>
              <label class="block text-[10px] text-text-muted mb-0.5">Execution</label>
              <select value={(getField('execution') as string) || ''}
                onchange={(e) => updateField('execution', e.currentTarget.value || undefined)}
                class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none">
                <option value="">Default</option>
                <option value="sequential">Sequential</option>
                <option value="parallel">Parallel</option>
              </select>
            </div>
          </div>
        {:else if nodeType === 'http'}
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">URL</label>
            <input type="text" value={(getField('url') as string) || ''}
              onchange={(e) => updateField('url', e.currentTarget.value)}
              class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
              placeholder="https://..." />
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Method</label>
            <select value={(getField('method') as string) || 'GET'}
              onchange={(e) => updateField('method', e.currentTarget.value)}
              class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none">
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="DELETE">DELETE</option>
              <option value="PATCH">PATCH</option>
            </select>
          </div>
          <div>
            <label class="block text-[10px] text-text-muted mb-0.5">Body</label>
            <textarea value={(getField('body') as string) || ''}
              onchange={(e) => updateField('body', e.currentTarget.value || undefined)}
              rows="3"
              class="w-full px-2 py-1 text-xs font-mono rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none resize-y"
              placeholder="Request body..."></textarea>
          </div>
        {:else}
          <p class="text-[10px] text-text-muted italic">Edit this node type via YAML preview.</p>
        {/if}
      </div>

      <!-- Error handling -->
      <div class="space-y-2 border-t border-border pt-3">
        <h4 class="text-[10px] font-semibold text-text-muted uppercase tracking-wider">Error Handling</h4>
        <div>
          <label class="block text-[10px] text-text-muted mb-0.5">On Error</label>
          <select value={(getField('on_error') as string) || ''}
            onchange={(e) => updateField('on_error', e.currentTarget.value || undefined)}
            class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none">
            <option value="">Default</option>
            <option value="stop">Stop</option>
            <option value="retry">Retry</option>
            <option value="skip">Skip</option>
          </select>
        </div>
        <div class="flex gap-2">
          <div class="flex-1">
            <label class="block text-[10px] text-text-muted mb-0.5">Retry Count</label>
            <input type="number" value={selectedNode.data.nodeDefinition.retry_count || 0}
              onchange={(e) => updateField('retry_count', parseInt(e.currentTarget.value) || undefined)}
              min="0" max="10"
              class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none" />
          </div>
          <div class="flex-1">
            <label class="block text-[10px] text-text-muted mb-0.5">Retry Delay (s)</label>
            <input type="number" value={selectedNode.data.nodeDefinition.retry_delay || 0}
              onchange={(e) => updateField('retry_delay', parseInt(e.currentTarget.value) || undefined)}
              min="0"
              class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none" />
          </div>
        </div>
        <div>
          <label class="block text-[10px] text-text-muted mb-0.5">Timeout (seconds)</label>
          <input type="number" value={selectedNode.data.nodeDefinition.timeout || ''}
            onchange={(e) => updateField('timeout', parseInt(e.currentTarget.value) || undefined)}
            class="w-full px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none"
            placeholder="Default" />
        </div>
      </div>
    </div>
  {/if}
</div>
