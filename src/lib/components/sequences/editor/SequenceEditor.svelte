<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import type { SequenceDefinition } from '$lib/types/sequence';
  import { definitionToGraph, graphToDefinition, type EditorNode, type EditorEdge } from '$lib/utils/sequenceConverter';
  import { settings } from '$lib/stores/settings';
  import { goto } from '$app/navigation';
  import NodePalette from './NodePalette.svelte';
  import NodeCanvas from './NodeCanvas.svelte';
  import NodeInspector from './NodeInspector.svelte';

  let { definition: initialDefinition }: { definition?: SequenceDefinition } = $props();

  // Sequence metadata
  let sequenceName = $state(initialDefinition?.name || 'New Sequence');
  let sequenceDescription = $state(initialDefinition?.description || '');
  let sequenceId = $state(initialDefinition?.id || '');
  let sequenceRepos = $state<string[]>(initialDefinition?.repos || []);
  let sequenceTags = $state<string[]>(initialDefinition?.tags || []);
  let showMetadata = $state(false);
  let newTag = $state('');

  // Graph state
  let nodes = $state<EditorNode[]>([]);
  let edges = $state<EditorEdge[]>([]);
  let selectedNode = $state<EditorNode | null>(null);

  // Node addition trigger
  let addNodeType = $state<string | null>(null);

  // UI state
  let showYamlPreview = $state(false);
  let yamlPreview = $state('');
  let saveStatus = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');
  let aiGenerateDescription = $state('');
  let aiGenerating = $state(false);

  // Initialize from definition
  if (initialDefinition) {
    const graph = definitionToGraph(initialDefinition);
    nodes = graph.nodes;
    edges = graph.edges;
  }

  function handleNodeSelect(nodeId: string | null) {
    if (nodeId) {
      selectedNode = nodes.find(n => n.id === nodeId) || null;
    } else {
      selectedNode = null;
    }
  }

  function handleNodeDelete(nodeId: string) {
    nodes = nodes.filter(n => n.id !== nodeId);
    edges = edges.filter(e => e.source !== nodeId && e.target !== nodeId);
    selectedNode = null;
  }

  function handleNodeUpdate(updated: EditorNode) {
    nodes = nodes.map(n => n.id === updated.id ? updated : n);
    // Also update the label in case name changed
    const idx = nodes.findIndex(n => n.id === updated.id);
    if (idx !== -1) {
      nodes[idx] = {
        ...updated,
        data: {
          ...updated.data,
          label: updated.data.nodeDefinition.name || updated.data.nodeDefinition.id,
        },
      };
      nodes = [...nodes]; // trigger reactivity
    }
  }

  function buildDefinition(): SequenceDefinition {
    const baseDef: SequenceDefinition = initialDefinition || {
      id: sequenceId || sequenceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      name: sequenceName,
      description: sequenceDescription,
      tags: sequenceTags,
      inputs: [],
      nodes: [],
      cleanup: [],
      triggers: [{ type: 'manual' }],
      repos: sequenceRepos,
    };

    return graphToDefinition(nodes, edges, {
      ...baseDef,
      name: sequenceName,
      description: sequenceDescription || undefined,
      tags: sequenceTags,
      repos: sequenceRepos,
    });
  }

  function toggleRepo(path: string) {
    if (sequenceRepos.includes(path)) {
      sequenceRepos = sequenceRepos.filter(r => r !== path);
    } else {
      sequenceRepos = [...sequenceRepos, path];
    }
  }

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

  async function handleSave() {
    saveStatus = 'saving';
    try {
      const def = buildDefinition();
      await invoke('save_sequence', { definition: def });
      saveStatus = 'saved';
      setTimeout(() => { saveStatus = 'idle'; }, 2000);
    } catch (e) {
      console.error('Save failed:', e);
      saveStatus = 'error';
      setTimeout(() => { saveStatus = 'idle'; }, 3000);
    }
  }

  async function handlePreviewYaml() {
    showYamlPreview = !showYamlPreview;
    if (showYamlPreview) {
      try {
        const def = buildDefinition();
        // Try to export as YAML via backend
        yamlPreview = await invoke<string>('export_sequence', { id: def.id }).catch(() => {
          return JSON.stringify(def, null, 2); // Fallback to JSON
        });
      } catch {
        yamlPreview = JSON.stringify(buildDefinition(), null, 2);
      }
    }
  }

  async function handleAiGenerate() {
    if (!aiGenerateDescription.trim()) return;
    aiGenerating = true;
    try {
      const yaml = await invoke<string>('generate_sequence_yaml', { description: aiGenerateDescription });
      // Validate and import the generated YAML
      const def = await invoke<SequenceDefinition>('validate_sequence', { yaml });
      sequenceName = def.name;
      sequenceDescription = def.description || '';
      sequenceRepos = def.repos || [];
      sequenceTags = def.tags || [];
      const graph = definitionToGraph(def);
      nodes = graph.nodes;
      edges = graph.edges;
      aiGenerateDescription = '';
    } catch (e) {
      console.error('AI generation failed:', e);
    } finally {
      aiGenerating = false;
    }
  }

  async function handleRun() {
    try {
      const def = buildDefinition();
      await invoke('save_sequence', { definition: def });
      // Navigate to sequences page which has the run dialog
      goto('/sequences');
    } catch (e) {
      console.error('Failed to save before run:', e);
    }
  }
</script>

<div class="flex flex-col h-full bg-surface-base">
  <!-- Toolbar -->
  <header class="flex items-center justify-between px-4 py-2 border-b border-border bg-surface">
    <div class="flex items-center gap-3">
      <button
        class="p-1.5 hover:bg-surface-elevated rounded transition-colors text-text-muted hover:text-text-primary"
        onclick={() => goto('/sequences')}
        title="Back to library"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"/>
        </svg>
      </button>
      <input type="text" bind:value={sequenceName}
        class="text-sm font-semibold bg-transparent border-none text-text-primary focus:outline-none focus:ring-1 focus:ring-accent rounded px-1 w-64"
        placeholder="Sequence name" />

      <button
        class="p-1.5 rounded transition-colors {showMetadata ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary hover:bg-surface-elevated'}"
        onclick={() => showMetadata = !showMetadata}
        title="Edit description, repos & tags"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
      </button>
    </div>

    <div class="flex items-center gap-2">
      <!-- AI Generate -->
      <div class="flex items-center gap-1">
        <input type="text" bind:value={aiGenerateDescription}
          class="px-2 py-1 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none w-48"
          placeholder="Describe sequence for AI..."
          onkeydown={(e) => e.key === 'Enter' && handleAiGenerate()} />
        <button class="px-2 py-1 text-xs rounded bg-purple-600 text-white hover:bg-purple-500 transition-colors disabled:opacity-50"
          onclick={handleAiGenerate}
          disabled={aiGenerating || !aiGenerateDescription.trim()}>
          {aiGenerating ? '...' : 'AI'}
        </button>
      </div>

      <button class="px-3 py-1 text-xs rounded border border-border text-text-secondary hover:bg-surface-elevated transition-colors"
        onclick={handlePreviewYaml}>
        {showYamlPreview ? 'Hide YAML' : 'YAML'}
      </button>

      <button class="px-3 py-1 text-xs rounded border border-border text-text-secondary hover:bg-surface-elevated transition-colors"
        onclick={handleRun}>
        Run
      </button>

      <button class="px-3 py-1 text-xs rounded bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-50"
        onclick={handleSave}
        disabled={saveStatus === 'saving'}>
        {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved!' : saveStatus === 'error' ? 'Error' : 'Save'}
      </button>
    </div>
  </header>

  <!-- Metadata panel (collapsible) -->
  {#if showMetadata}
    <div class="px-4 py-3 border-b border-border bg-surface space-y-3">
      <!-- Description -->
      <div>
        <label class="block text-xs font-medium text-text-secondary mb-1">Description</label>
        <textarea
          bind:value={sequenceDescription}
          class="w-full px-2 py-1.5 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none resize-none"
          rows="2"
          placeholder="What does this sequence do?"
        ></textarea>
      </div>

      <div class="flex gap-6">
        <!-- Repos -->
        <div class="flex-1">
          <label class="block text-xs font-medium text-text-secondary mb-1">
            Repositories
            <span class="font-normal text-text-muted ml-1">
              {sequenceRepos.length === 0 ? '(all repos)' : `(${sequenceRepos.length} selected)`}
            </span>
          </label>
          {#if $settings.repos.length === 0}
            <p class="text-xs text-text-muted italic">No repositories configured. Add repos in Settings.</p>
          {:else}
            <div class="flex flex-wrap gap-1.5">
              {#each $settings.repos as repo}
                <button
                  class="px-2 py-0.5 text-xs rounded-full border transition-colors {sequenceRepos.includes(repo.path)
                    ? 'bg-accent/20 border-accent text-accent'
                    : 'border-border text-text-muted hover:border-text-secondary hover:text-text-secondary'}"
                  onclick={() => toggleRepo(repo.path)}
                  title={repo.path}
                >
                  {repo.name}
                </button>
              {/each}
            </div>
            <p class="text-[10px] text-text-muted mt-1">Leave empty to allow this sequence on all repos.</p>
          {/if}
        </div>

        <!-- Tags -->
        <div class="flex-1">
          <label class="block text-xs font-medium text-text-secondary mb-1">Tags</label>
          <div class="flex flex-wrap gap-1.5 mb-1.5">
            {#each sequenceTags as tag}
              <span class="inline-flex items-center gap-0.5 px-2 py-0.5 text-xs rounded-full bg-surface-elevated text-text-secondary border border-border">
                {tag}
                <button class="ml-0.5 hover:text-red-400 transition-colors" onclick={() => removeTag(tag)}>&times;</button>
              </span>
            {/each}
          </div>
          <div class="flex items-center gap-1">
            <input
              type="text"
              bind:value={newTag}
              class="px-2 py-0.5 text-xs rounded border border-border bg-surface-elevated text-text-primary focus:border-accent focus:outline-none w-32"
              placeholder="Add tag..."
              onkeydown={(e) => e.key === 'Enter' && addTag()}
            />
            <button
              class="px-2 py-0.5 text-xs rounded border border-border text-text-muted hover:text-text-primary hover:bg-surface-elevated transition-colors disabled:opacity-50"
              onclick={addTag}
              disabled={!newTag.trim()}
            >+</button>
          </div>
        </div>
      </div>
    </div>
  {/if}

  <!-- Main area -->
  <div class="flex flex-1 overflow-hidden">
    <NodePalette onAddNode={(type) => { addNodeType = type; }} />

    {#if showYamlPreview}
      <div class="flex-1 overflow-auto p-4">
        <pre class="text-xs font-mono text-text-secondary whitespace-pre-wrap">{yamlPreview}</pre>
      </div>
    {:else}
      <NodeCanvas bind:nodes bind:edges bind:addNodeType onNodeSelect={handleNodeSelect} />
    {/if}

    <NodeInspector bind:selectedNode allNodes={nodes} onNodeUpdate={handleNodeUpdate} onNodeDelete={handleNodeDelete} />
  </div>
</div>
