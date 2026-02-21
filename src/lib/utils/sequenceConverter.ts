import type { Node, Edge } from '@xyflow/svelte';
import type { SequenceDefinition, NodeDefinition } from '$lib/types/sequence';

// Category assignment for visual styling
export type NodeCategory = 'ai' | 'git' | 'github' | 'control' | 'action';

export interface EditorNodeData {
  nodeDefinition: NodeDefinition;
  label: string;
  category: NodeCategory;
  [key: string]: unknown;
}

export type EditorNode = Node<EditorNodeData>;
export type EditorEdge = Edge;

export function getNodeCategory(nodeType: string): NodeCategory {
  if (['prompt', 'route'].includes(nodeType)) return 'ai';
  if (nodeType.startsWith('git_') && !nodeType.startsWith('github_')) return 'git';
  if (nodeType.startsWith('github_')) return 'github';
  if (['approval', 'wait', 'loop', 'parallel', 'for_each', 'sub_sequence'].includes(nodeType)) return 'control';
  return 'action'; // script, notify, delay, file, http, transform
}

export function getCategoryColor(category: NodeCategory): string {
  switch (category) {
    case 'ai': return '#3b82f6';       // blue
    case 'git': return '#22c55e';      // green
    case 'github': return '#a855f7';   // purple
    case 'control': return '#eab308';  // yellow
    case 'action': return '#f97316';   // orange
  }
}

export function getNodeLabel(node: NodeDefinition): string {
  return node.name || node.id;
}

// Get child count for compound nodes
function getChildCount(node: NodeDefinition): number {
  const n = node as Record<string, unknown>;
  if (n.nodes && Array.isArray(n.nodes)) return (n.nodes as unknown[]).length;
  if (n.branches && typeof n.branches === 'object') return Object.keys(n.branches as object).length;
  return 0;
}

/**
 * Convert a SequenceDefinition to graph nodes and edges for the visual editor.
 */
export function definitionToGraph(def: SequenceDefinition): { nodes: EditorNode[]; edges: EditorEdge[] } {
  const nodes: EditorNode[] = [];
  const edges: EditorEdge[] = [];

  def.nodes.forEach((nodeDef, index) => {
    const category = getNodeCategory(nodeDef.type);
    const position = nodeDef._editor_position || { x: 250, y: index * 120 };

    nodes.push({
      id: nodeDef.id,
      type: getRendererType(nodeDef.type),
      position,
      data: {
        nodeDefinition: nodeDef,
        label: getNodeLabel(nodeDef),
        category,
      },
    });

    // Create edges
    if (nodeDef.next) {
      // Explicit next
      edges.push({
        id: `${nodeDef.id}->${nodeDef.next}`,
        source: nodeDef.id,
        target: nodeDef.next,
        type: 'default',
      });
    } else if (index < def.nodes.length - 1) {
      // Implicit sequential: i -> i+1
      edges.push({
        id: `${nodeDef.id}->${def.nodes[index + 1].id}`,
        source: nodeDef.id,
        target: def.nodes[index + 1].id,
        type: 'default',
        style: 'stroke-dasharray: 5 5',
      });
    }

    // Route node branch edges
    if (nodeDef.type === 'route') {
      const branches = (nodeDef as Record<string, unknown>).branches as Record<string, { next?: string; description?: string } | string> | undefined;
      if (branches) {
        Object.entries(branches).forEach(([branchKey, branch]) => {
          const target = typeof branch === 'string' ? branch : branch.next;
          if (target) {
            edges.push({
              id: `${nodeDef.id}->branch:${branchKey}->${target}`,
              source: nodeDef.id,
              sourceHandle: `branch-${branchKey}`,
              target,
              label: branchKey,
              type: 'default',
              style: 'stroke: #a855f7',
            });
          }
        });
      }
    }
  });

  // Cleanup zone edges (cleanup nodes connected separately)
  def.cleanup.forEach((nodeDef, index) => {
    const category = getNodeCategory(nodeDef.type);
    const position = nodeDef._editor_position || { x: 600, y: index * 120 };

    nodes.push({
      id: `cleanup:${nodeDef.id}`,
      type: getRendererType(nodeDef.type),
      position,
      data: {
        nodeDefinition: nodeDef,
        label: `[Cleanup] ${getNodeLabel(nodeDef)}`,
        category,
      },
    });
  });

  return { nodes, edges };
}

/**
 * Map node type string to renderer component name.
 */
function getRendererType(nodeType: string): string {
  if (nodeType === 'prompt') return 'prompt';
  if (nodeType === 'route') return 'route';
  if (nodeType === 'script') return 'script';
  if (nodeType.startsWith('git') || nodeType.startsWith('github')) return 'git';
  if (['approval', 'wait'].includes(nodeType)) return 'control';
  if (['loop', 'parallel', 'for_each', 'sub_sequence'].includes(nodeType)) return 'compound';
  return 'action'; // notify, delay, file, http, transform
}

/**
 * Convert graph nodes and edges back to a SequenceDefinition.
 * Preserves editor positions.
 */
export function graphToDefinition(
  nodes: EditorNode[],
  edges: EditorEdge[],
  originalDef: SequenceDefinition
): SequenceDefinition {
  // Separate cleanup nodes from regular nodes
  const regularNodes = nodes.filter(n => !n.id.startsWith('cleanup:'));
  const cleanupNodes = nodes.filter(n => n.id.startsWith('cleanup:'));

  // Sort by y-position for execution order
  const sortedRegular = [...regularNodes].sort((a, b) => a.position.y - b.position.y);
  const sortedCleanup = [...cleanupNodes].sort((a, b) => a.position.y - b.position.y);

  // Build edge map: source -> target(s)
  const edgeMap = new Map<string, string[]>();
  const branchEdgeMap = new Map<string, Map<string, string>>(); // source -> (branchKey -> target)

  for (const edge of edges) {
    if (edge.sourceHandle?.startsWith('branch-')) {
      const branchKey = edge.sourceHandle.replace('branch-', '');
      if (!branchEdgeMap.has(edge.source)) branchEdgeMap.set(edge.source, new Map());
      branchEdgeMap.get(edge.source)!.set(branchKey, edge.target);
    } else {
      if (!edgeMap.has(edge.source)) edgeMap.set(edge.source, []);
      edgeMap.get(edge.source)!.push(edge.target);
    }
  }

  // Convert nodes back to NodeDefinitions
  const mainNodes: NodeDefinition[] = sortedRegular.map((node, index) => {
    const def = { ...node.data.nodeDefinition };
    def._editor_position = { x: node.position.x, y: node.position.y };

    // Reconstruct 'next' from edges
    const targets = edgeMap.get(node.id);
    if (targets && targets.length > 0) {
      // Check if the target is the natural next node
      const naturalNext = index < sortedRegular.length - 1 ? sortedRegular[index + 1].id : undefined;
      if (targets[0] !== naturalNext) {
        def.next = targets[0];
      } else {
        def.next = undefined; // implicit sequential
      }
    }

    return def;
  });

  const cleanupDefs: NodeDefinition[] = sortedCleanup.map((node) => {
    const def = { ...node.data.nodeDefinition };
    const realId = node.id.replace('cleanup:', '');
    def.id = realId;
    def._editor_position = { x: node.position.x, y: node.position.y };
    return def;
  });

  return {
    ...originalDef,
    nodes: mainNodes,
    cleanup: cleanupDefs,
  };
}

/**
 * Create a default NodeDefinition template for a given type.
 * Used when dragging a new node from the palette.
 */
export function createDefaultNode(nodeType: string, id: string): NodeDefinition {
  const base: NodeDefinition = {
    id,
    type: nodeType,
    outputs: [],
  };

  switch (nodeType) {
    case 'prompt':
      return { ...base, prompt: '', model: 'sonnet' } as NodeDefinition;
    case 'route':
      return { ...base, branches: {} } as NodeDefinition;
    case 'script':
      return { ...base, command: '' } as NodeDefinition;
    case 'notify':
      return { ...base, message: '' } as NodeDefinition;
    case 'delay':
      return { ...base, duration: '5s' } as NodeDefinition;
    case 'transform':
      return { ...base, input: '', operations: [] } as NodeDefinition;
    case 'approval':
      return { ...base, message: 'Approve to continue?' } as NodeDefinition;
    case 'wait':
      return { ...base } as NodeDefinition;
    case 'loop':
      return { ...base, nodes: [], max_iterations: 10 } as NodeDefinition;
    case 'parallel':
      return { ...base, branches: {} } as NodeDefinition;
    case 'for_each':
      return { ...base, items: '', nodes: [] } as NodeDefinition;
    case 'sub_sequence':
      return { ...base, sequence: '' } as NodeDefinition;
    case 'git_branch':
      return { ...base, branch_name: '' } as NodeDefinition;
    case 'git_worktree':
      return { ...base, branch_name: '' } as NodeDefinition;
    case 'git_commit':
      return { ...base, message: '' } as NodeDefinition;
    case 'git_push':
      return { ...base } as NodeDefinition;
    case 'git_delete_branch':
      return { ...base, branch: '' } as NodeDefinition;
    case 'git_delete_worktree':
      return { ...base, path: '' } as NodeDefinition;
    case 'github_pr':
      return { ...base, title: '' } as NodeDefinition;
    case 'github_pr_wait':
      return { ...base, pr: '', wait_for: 'checks' } as NodeDefinition;
    case 'github_pr_merge':
      return { ...base, pr: '' } as NodeDefinition;
    case 'file':
      return { ...base, operation: 'read' } as NodeDefinition;
    case 'http':
      return { ...base, url: '' } as NodeDefinition;
    default:
      return base;
  }
}
