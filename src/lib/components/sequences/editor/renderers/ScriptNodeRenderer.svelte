<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
  import type { EditorNodeData } from '$lib/utils/sequenceConverter';

  let { data }: { data: EditorNodeData } = $props();

  let command = $derived((data.nodeDefinition as Record<string, unknown>).command as string || '');
</script>

<Handle type="target" position={Position.Top} />
<div class="px-3 py-2 rounded-lg border-2 border-orange-500 bg-orange-500/10 min-w-[160px] max-w-[220px]">
  <div class="flex items-center gap-1.5 mb-1">
    <div class="w-2 h-2 rounded-full bg-orange-500"></div>
    <span class="text-xs font-semibold text-orange-400 truncate">{data.label}</span>
  </div>
  <code class="text-[10px] text-gray-400 block truncate">{command.slice(0, 50)}{command.length > 50 ? '...' : ''}</code>
</div>
<Handle type="source" position={Position.Bottom} />
