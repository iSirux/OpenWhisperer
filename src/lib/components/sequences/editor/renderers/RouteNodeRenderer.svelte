<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
  import type { EditorNodeData } from '$lib/utils/sequenceConverter';

  let { data }: { data: EditorNodeData } = $props();

  let branches = $derived(
    Object.keys((data.nodeDefinition as Record<string, unknown>).branches as Record<string, unknown> || {})
  );
</script>

<Handle type="target" position={Position.Top} />
<div class="px-3 py-2 rounded-lg border-2 border-blue-500 bg-blue-500/10 min-w-[160px] max-w-[220px]">
  <div class="flex items-center gap-1.5 mb-1">
    <div class="w-2 h-2 rounded-full bg-blue-500"></div>
    <span class="text-xs font-semibold text-blue-400 truncate">{data.label}</span>
  </div>
  <div class="text-[10px] text-blue-300/70">{branches.length} branches</div>
  {#if branches.length > 0}
    <div class="flex flex-wrap gap-1 mt-1">
      {#each branches as branch}
        <span class="px-1 py-0.5 text-[9px] rounded bg-blue-500/20 text-blue-300">{branch}</span>
      {/each}
    </div>
  {/if}
</div>
<!-- Default output handle -->
<Handle type="source" position={Position.Bottom} />
<!-- Branch-specific handles positioned along the bottom -->
{#each branches as branch, i}
  <Handle
    type="source"
    position={Position.Bottom}
    id="branch-{branch}"
    style="left: {((i + 1) / (branches.length + 1)) * 100}%"
  />
{/each}
