<script lang="ts">
  import { SvelteFlow, Controls, MiniMap, Background, BackgroundVariant } from '@xyflow/svelte';
  import type { NodeTypes } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';

  import PromptNodeRenderer from './renderers/PromptNodeRenderer.svelte';
  import RouteNodeRenderer from './renderers/RouteNodeRenderer.svelte';
  import ScriptNodeRenderer from './renderers/ScriptNodeRenderer.svelte';
  import ActionNodeRenderer from './renderers/ActionNodeRenderer.svelte';
  import GitNodeRenderer from './renderers/GitNodeRenderer.svelte';
  import ControlNodeRenderer from './renderers/ControlNodeRenderer.svelte';
  import CompoundNodeRenderer from './renderers/CompoundNodeRenderer.svelte';

  import { createDefaultNode, getNodeCategory, getCategoryColor, type EditorNode, type EditorEdge } from '$lib/utils/sequenceConverter';

  let {
    nodes = $bindable<EditorNode[]>([]),
    edges = $bindable<EditorEdge[]>([]),
    onNodeSelect = (_nodeId: string | null) => {},
    addNodeType = $bindable<string | null>(null),
  }: {
    nodes: EditorNode[];
    edges: EditorEdge[];
    onNodeSelect?: (nodeId: string | null) => void;
    addNodeType?: string | null;
  } = $props();

  const nodeTypes: NodeTypes = {
    prompt: PromptNodeRenderer,
    route: RouteNodeRenderer,
    script: ScriptNodeRenderer,
    action: ActionNodeRenderer,
    git: GitNodeRenderer,
    control: ControlNodeRenderer,
    compound: CompoundNodeRenderer,
  } as unknown as NodeTypes;

  let nodeIdCounter = $state(0);
  let containerEl: HTMLDivElement | undefined = $state();

  function getRendererType(nodeType: string): string {
    if (nodeType === 'prompt') return 'prompt';
    if (nodeType === 'route') return 'route';
    if (nodeType === 'script') return 'script';
    if (nodeType.startsWith('git') || nodeType.startsWith('github')) return 'git';
    if (['approval', 'wait'].includes(nodeType)) return 'control';
    if (['loop', 'parallel', 'for_each', 'sub_sequence'].includes(nodeType)) return 'compound';
    return 'action';
  }

  // Get the center of the current viewport in flow coordinates
  function getViewportCenter(): { x: number; y: number } {
    if (!containerEl) return { x: 200, y: 200 };

    const flowEl = containerEl.querySelector('.svelte-flow') as HTMLElement | null;
    const viewport = containerEl.querySelector('.svelte-flow__viewport') as HTMLElement | null;

    if (flowEl && viewport) {
      const rect = flowEl.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      const transform = viewport.style.transform;
      const match = transform.match(/translate\(([^p,]+)px?,\s*([^p)]+)px?\)\s*scale\(([^)]+)\)/);
      if (match) {
        const tx = parseFloat(match[1]);
        const ty = parseFloat(match[2]);
        const scale = parseFloat(match[3]);
        return {
          x: (centerX - rect.left - tx) / scale,
          y: (centerY - rect.top - ty) / scale,
        };
      }
    }

    return { x: 200, y: 200 };
  }

  // Find an open position near a target, avoiding overlap with existing nodes
  function findOpenPosition(target: { x: number; y: number }): { x: number; y: number } {
    const SPACING = 40;
    let pos = { ...target };

    // Nudge down/right if another node is too close
    let attempts = 0;
    while (attempts < 20) {
      const overlap = nodes.some(n =>
        Math.abs(n.position.x - pos.x) < 100 && Math.abs(n.position.y - pos.y) < 50
      );
      if (!overlap) break;
      pos.y += SPACING;
      attempts++;
    }

    return pos;
  }

  function addNode(nodeType: string) {
    nodeIdCounter++;
    const id = `${nodeType}_${nodeIdCounter}`;
    const nodeDef = createDefaultNode(nodeType, id);
    const category = getNodeCategory(nodeType);
    const center = getViewportCenter();
    const position = findOpenPosition(center);

    const newNode: EditorNode = {
      id,
      type: getRendererType(nodeType),
      position,
      data: {
        nodeDefinition: nodeDef,
        label: id,
        category,
      },
    };

    nodes = [...nodes, newNode];
    onNodeSelect(id);
  }

  // Watch for addNodeType changes from parent
  $effect(() => {
    if (addNodeType) {
      addNode(addNodeType);
      addNodeType = null;
    }
  });

  // Use 'any' for event handler params since @xyflow/svelte's Node type doesn't carry our EditorNodeData
  function handleNodeClick({ node }: { node: any; event: MouseEvent | TouchEvent }) {
    onNodeSelect(node.id);
  }

  function handlePaneClick() {
    onNodeSelect(null);
  }

  function handleDelete({ nodes: deletedNodes, edges: deletedEdges }: { nodes: any[]; edges: any[] }) {
    const deletedNodeIds = new Set(deletedNodes.map(n => n.id));
    const deletedEdgeIds = new Set(deletedEdges.map(e => e.id));

    if (deletedNodeIds.size > 0) {
      nodes = nodes.filter(n => !deletedNodeIds.has(n.id));
      edges = edges.filter(e => !deletedNodeIds.has(e.source) && !deletedNodeIds.has(e.target) && !deletedEdgeIds.has(e.id));
    } else if (deletedEdgeIds.size > 0) {
      edges = edges.filter(e => !deletedEdgeIds.has(e.id));
    }
  }
</script>

<div class="flex-1 h-full" bind:this={containerEl}>
  <SvelteFlow
    bind:nodes
    bind:edges
    {nodeTypes}
    fitView
    colorMode="dark"
    onnodeclick={handleNodeClick}
    onpaneclick={handlePaneClick}
    ondelete={handleDelete}
  >
    <Controls />
    <MiniMap nodeColor={(node: any) => getCategoryColor(node.data?.category ?? 'action')} />
    <Background variant={BackgroundVariant.Dots} />
  </SvelteFlow>
</div>
