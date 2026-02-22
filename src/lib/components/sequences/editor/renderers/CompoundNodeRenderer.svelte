<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
  import type { EditorNodeData } from '$lib/utils/sequenceConverter';

  let { data }: { data: EditorNodeData } = $props();

  let nodeType = $derived(data.nodeDefinition.type);

  let childCount = $derived.by(() => {
    const n = data.nodeDefinition as Record<string, unknown>;
    if (n.nodes && Array.isArray(n.nodes)) return (n.nodes as unknown[]).length;
    if (n.branches && typeof n.branches === 'object' && !Array.isArray(n.branches))
      return Object.keys(n.branches as object).length;
    return 0;
  });

  let detail = $derived.by(() => {
    const n = data.nodeDefinition as Record<string, unknown>;
    switch (nodeType) {
      case 'loop': return `max: ${(n.max_iterations as number) || '\u221E'}`;
      case 'parallel': return `${childCount} branches`;
      case 'for_each': return `over ${(n.items as string) || '?'}`;
      case 'sub_sequence': return (n.sequence as string) || '';
      default: return '';
    }
  });
</script>

<Handle type="target" position={Position.Top} />
<div class="px-3 py-2 rounded-lg border-2 border-yellow-500 bg-yellow-500/10 min-w-[160px] max-w-[220px]">
  <div class="flex items-center gap-1.5 mb-1">
    <div class="w-2 h-2 rounded-full bg-yellow-500"></div>
    <span class="text-xs font-semibold text-yellow-400 truncate">{data.label}</span>
    <span class="px-1 py-0.5 text-[9px] rounded-full bg-yellow-500/30 text-yellow-300 font-bold">{childCount}</span>
  </div>
  <span class="px-1 py-0.5 text-[9px] rounded bg-yellow-500/20 text-yellow-300">{nodeType.replace(/_/g, ' ')}</span>
  {#if detail}
    <div class="text-[10px] text-gray-400 mt-0.5 truncate">{detail}</div>
  {/if}
</div>
<Handle type="source" position={Position.Bottom} />
