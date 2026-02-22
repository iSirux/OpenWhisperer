<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
  import type { EditorNodeData } from '$lib/utils/sequenceConverter';

  let { data }: { data: EditorNodeData } = $props();

  let nodeType = $derived(data.nodeDefinition.type);

  let detail = $derived.by(() => {
    const n = data.nodeDefinition as Record<string, unknown>;
    switch (nodeType) {
      case 'notify': {
        const parts: string[] = [];
        if (n.system_notification !== false) parts.push('system');
        if (n.play_sound) parts.push('sound');
        if (n.channel) parts.push(n.channel as string);
        return parts.join(' + ') || 'notify';
      }
      case 'delay': return (n.duration as string) || '';
      case 'file': return (n.operation as string) || '';
      case 'http': return `${(n.method as string) || 'GET'} ${((n.url as string) || '').slice(0, 30)}`;
      case 'transform': return `${((n.operations as unknown[]) || []).length} ops`;
      default: return '';
    }
  });
</script>

<Handle type="target" position={Position.Top} />
<div class="px-3 py-2 rounded-lg border-2 border-orange-500 bg-orange-500/10 min-w-[160px] max-w-[220px]">
  <div class="flex items-center gap-1.5 mb-1">
    <div class="w-2 h-2 rounded-full bg-orange-500"></div>
    <span class="text-xs font-semibold text-orange-400 truncate">{data.label}</span>
  </div>
  <span class="px-1 py-0.5 text-[9px] rounded bg-orange-500/20 text-orange-300">{nodeType}</span>
  {#if detail}
    <div class="text-[10px] text-gray-400 mt-0.5 truncate">{detail}</div>
  {/if}
</div>
<Handle type="source" position={Position.Bottom} />
