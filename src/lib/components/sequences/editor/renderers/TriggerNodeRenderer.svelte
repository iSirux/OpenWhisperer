<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
  import type { EditorNodeData } from '$lib/utils/sequenceConverter';

  let { data }: { data: EditorNodeData } = $props();

  let triggerType = $derived.by(() => {
    const n = data.nodeDefinition as Record<string, unknown>;
    const tt = n.trigger_type as Record<string, unknown> | undefined;
    return (tt?.trigger_kind as string) || 'manual';
  });

  let detail = $derived.by(() => {
    const n = data.nodeDefinition as Record<string, unknown>;
    const tt = n.trigger_type as Record<string, unknown> | undefined;
    if (!tt) return '';
    switch (tt.trigger_kind) {
      case 'schedule': return (tt.cron as string) || '';
      case 'event': return (tt.event_type as string) || '';
      default: return '';
    }
  });

  let icon = $derived.by(() => {
    switch (triggerType) {
      case 'schedule': return '\u23F0'; // alarm clock
      case 'event': return '\u26A1'; // lightning
      default: return '\u25B6'; // play
    }
  });
</script>

<!-- No target handle - triggers are entry points (output only) -->
<div class="px-3 py-2 rounded-lg border-2 border-teal-500 bg-teal-500/10 min-w-[160px] max-w-[220px]">
  <div class="flex items-center gap-1.5 mb-1">
    <div class="w-2 h-2 rounded-full bg-teal-500"></div>
    <span class="text-xs font-semibold text-teal-400 truncate">{data.label}</span>
  </div>
  <div class="flex items-center gap-1">
    <span class="text-[10px]">{icon}</span>
    <span class="px-1 py-0.5 text-[9px] rounded bg-teal-500/20 text-teal-300">{triggerType}</span>
  </div>
  {#if detail}
    <div class="text-[10px] text-gray-400 mt-0.5 truncate font-mono">{detail}</div>
  {/if}
</div>
<Handle type="source" position={Position.Bottom} />
