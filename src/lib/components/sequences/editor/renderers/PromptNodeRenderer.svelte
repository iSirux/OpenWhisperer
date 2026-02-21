<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
  import type { EditorNodeData } from '$lib/utils/sequenceConverter';

  let { data }: { data: EditorNodeData } = $props();

  let prompt = $derived((data.nodeDefinition as Record<string, unknown>).prompt as string || '');
  let model = $derived((data.nodeDefinition as Record<string, unknown>).model as string || 'default');
</script>

<Handle type="target" position={Position.Top} />
<div class="px-3 py-2 rounded-lg border-2 border-blue-500 bg-blue-500/10 min-w-[160px] max-w-[220px]">
  <div class="flex items-center gap-1.5 mb-1">
    <div class="w-2 h-2 rounded-full bg-blue-500"></div>
    <span class="text-xs font-semibold text-blue-400 truncate">{data.label}</span>
  </div>
  <div class="text-[10px] text-blue-300/70 mb-0.5">Model: {model}</div>
  <div class="text-[10px] text-gray-400 truncate">{prompt.slice(0, 60)}{prompt.length > 60 ? '...' : ''}</div>
</div>
<Handle type="source" position={Position.Bottom} />
