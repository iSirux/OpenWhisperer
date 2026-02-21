<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
  import type { EditorNodeData } from '$lib/utils/sequenceConverter';

  let { data }: { data: EditorNodeData } = $props();

  let nodeType = $derived(data.nodeDefinition.type);
  let message = $derived((data.nodeDefinition as Record<string, unknown>).message as string || '');
</script>

<Handle type="target" position={Position.Top} />
<div class="px-3 py-2 rounded-lg border-2 border-yellow-500 bg-yellow-500/10 min-w-[160px] max-w-[220px]">
  <div class="flex items-center gap-1.5 mb-1">
    <div class="w-2 h-2 rounded-full bg-yellow-500"></div>
    <span class="text-xs font-semibold text-yellow-400 truncate">{data.label}</span>
  </div>
  <span class="px-1 py-0.5 text-[9px] rounded bg-yellow-500/20 text-yellow-300">{nodeType}</span>
  {#if message}
    <div class="text-[10px] text-gray-400 mt-0.5 truncate">{message.slice(0, 50)}</div>
  {/if}
</div>
<Handle type="source" position={Position.Bottom} />
