import type { Node, Edge } from '@xyflow/svelte';
import type { SequenceDefinition, NodeDefinition } from '$lib/types/sequence';

// Category assignment for visual styling
export type NodeCategory = 'ai' | 'git' | 'github' | 'control' | 'action' | 'trigger';

export interface EditorNodeData {
  nodeDefinition: NodeDefinition;
  label: string;
  category: NodeCategory;
  [key: string]: unknown;
}

export type EditorNode = Node<EditorNodeData>;
export type EditorEdge = Edge;

export function getNodeCategory(nodeType: string): NodeCategory {
  if (nodeType === 'trigger') return 'trigger';
  if (['prompt', 'route'].includes(nodeType)) return 'ai';
  if (nodeType.startsWith('git_') && !nodeType.startsWith('github_')) return 'git';
  if (nodeType.startsWith('github_')) return 'github';
  if (['approval', 'wait', 'loop', 'parallel', 'for_each', 'sub_sequence'].includes(nodeType)) return 'control';
  return 'action'; // script, notify, delay, file, http, transform
}

export function getCategoryColor(category: NodeCategory): string {
  switch (category) {
    case 'trigger': return '#14b8a6';  // teal
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

  // Check if nodes already contain trigger-type nodes
  const hasTriggerNodes = def.nodes.some(n => n.type === 'trigger');

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

    // Skip implicit sequential edges for trigger nodes
    if (nodeDef.type === 'trigger') return;

    // Create edges
    if (nodeDef.next) {
      // Explicit next
      edges.push({
        id: `${nodeDef.id}->${nodeDef.next}`,
        source: nodeDef.id,
        target: nodeDef.next,
        type: 'default',
      });
    } else {
      // Find next non-trigger node for implicit sequential edge
      let nextIdx = index + 1;
      while (nextIdx < def.nodes.length && def.nodes[nextIdx].type === 'trigger') {
        nextIdx++;
      }
      if (nextIdx < def.nodes.length) {
        edges.push({
          id: `${nodeDef.id}->${def.nodes[nextIdx].id}`,
          source: nodeDef.id,
          target: def.nodes[nextIdx].id,
          type: 'default',
          style: 'stroke-dasharray: 5 5',
        });
      }
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

  // Synthesize trigger nodes from triggers[] if no trigger nodes exist in nodes[]
  if (!hasTriggerNodes && def.triggers.length > 0) {
    const firstNonTriggerNode = def.nodes.find(n => n.type !== 'trigger');
    def.triggers.forEach((trigger, i) => {
      const triggerId = `trigger_${trigger.type}_${i}`;
      let triggerType: Record<string, unknown>;
      let label: string;

      if (trigger.type === 'manual') {
        triggerType = { trigger_kind: 'manual' };
        label = 'Manual';
      } else if (trigger.type === 'schedule') {
        triggerType = { trigger_kind: 'schedule', cron: trigger.cron, timezone: trigger.timezone };
        label = `Schedule: ${trigger.cron}`;
      } else {
        triggerType = {
          trigger_kind: 'event',
          event_type: trigger.event_type,
          filter: trigger.filter,
          cooldown: trigger.cooldown,
          max_per_day: trigger.max_per_day,
          once_per_day: trigger.once_per_day,
        };
        label = `Event: ${trigger.event_type}`;
      }

      const position = { x: 50 + i * 200, y: -80 };
      const nodeDef: NodeDefinition = {
        id: triggerId,
        name: label,
        type: 'trigger',
        outputs: [],
        trigger_type: triggerType,
        _editor_position: position,
      } as NodeDefinition;

      nodes.push({
        id: triggerId,
        type: 'trigger',
        position,
        data: {
          nodeDefinition: nodeDef,
          label,
          category: 'trigger' as NodeCategory,
        },
      });

      // Edge from trigger to its entry point or first node
      const targetId = trigger.entry_node_id || firstNonTriggerNode?.id;
      if (targetId) {
        edges.push({
          id: `${triggerId}->${targetId}`,
          source: triggerId,
          target: targetId,
          type: 'default',
          style: 'stroke: #14b8a6',
        });
      }
    });
  }

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
  if (nodeType === 'trigger') return 'trigger';
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
  // Separate trigger, cleanup, and regular nodes
  const triggerNodes = nodes.filter(n => n.data.nodeDefinition.type === 'trigger' && !n.id.startsWith('cleanup:'));
  const regularNodes = nodes.filter(n => n.data.nodeDefinition.type !== 'trigger' && !n.id.startsWith('cleanup:'));
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

  // Convert regular nodes back to NodeDefinitions
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

  // Convert trigger nodes to NodeDefinitions (for persistence) and build triggers array
  const triggerNodeDefs: NodeDefinition[] = triggerNodes.map((node) => {
    const def = { ...node.data.nodeDefinition };
    def._editor_position = { x: node.position.x, y: node.position.y };
    return def;
  });

  // Build triggers array from trigger nodes
  let triggers: SequenceDefinition['triggers'];
  if (triggerNodes.length > 0) {
    triggers = triggerNodes.map((node) => {
      const triggerType = (node.data.nodeDefinition as Record<string, unknown>).trigger_type as Record<string, unknown> | undefined;
      const kind = triggerType?.trigger_kind as string || 'manual';
      // Find the edge target from this trigger node
      const targets = edgeMap.get(node.id);
      const entryNodeId = targets?.[0] || undefined;

      if (kind === 'schedule') {
        return {
          type: 'schedule' as const,
          cron: (triggerType?.cron as string) || '0 0 * * *',
          timezone: triggerType?.timezone as string | undefined,
          entry_node_id: entryNodeId,
        };
      } else if (kind === 'event') {
        return {
          type: 'event' as const,
          event_type: (triggerType?.event_type as string) || 'session_end',
          filter: triggerType?.filter as Record<string, string> | undefined,
          cooldown: triggerType?.cooldown as number | undefined,
          max_per_day: triggerType?.max_per_day as number | undefined,
          once_per_day: triggerType?.once_per_day as boolean | undefined,
          entry_node_id: entryNodeId,
        };
      } else {
        return {
          type: 'manual' as const,
          entry_node_id: entryNodeId,
        };
      }
    });
  } else {
    // Preserve original triggers if no trigger nodes on canvas
    triggers = originalDef.triggers.length > 0 ? originalDef.triggers : [{ type: 'manual' as const }];
  }

  const cleanupDefs: NodeDefinition[] = sortedCleanup.map((node) => {
    const def = { ...node.data.nodeDefinition };
    const realId = node.id.replace('cleanup:', '');
    def.id = realId;
    def._editor_position = { x: node.position.x, y: node.position.y };
    return def;
  });

  return {
    ...originalDef,
    nodes: [...triggerNodeDefs, ...mainNodes],
    cleanup: cleanupDefs,
    triggers,
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
    case 'trigger_manual':
      return { ...base, type: 'trigger', trigger_type: { trigger_kind: 'manual' } } as NodeDefinition;
    case 'trigger_schedule':
      return { ...base, type: 'trigger', trigger_type: { trigger_kind: 'schedule', cron: '0 0 * * *' } } as NodeDefinition;
    case 'trigger_event':
      return { ...base, type: 'trigger', trigger_type: { trigger_kind: 'event', event_type: 'session_end' } } as NodeDefinition;
    case 'prompt':
      return { ...base, prompt: '', model: 'sonnet' } as NodeDefinition;
    case 'route':
      return { ...base, branches: {} } as NodeDefinition;
    case 'script':
      return { ...base, command: '' } as NodeDefinition;
    case 'notify':
      return { ...base, system_notification: true, play_sound: false, message: '' } as NodeDefinition;
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
