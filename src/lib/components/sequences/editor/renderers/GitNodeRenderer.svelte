<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
  import type { EditorNodeData } from '$lib/utils/sequenceConverter';

  let { data }: { data: EditorNodeData } = $props();

  let nodeType = $derived(data.nodeDefinition.type);
  let isGithub = $derived(nodeType.startsWith('github_'));

  let detail = $derived.by(() => {
    const n = data.nodeDefinition as Record<string, unknown>;
    switch (nodeType) {
      case 'git_branch': return (n.branch_name as string) || '';
      case 'git_commit': return (n.message as string)?.slice(0, 40) || '';
      case 'github_pr': return (n.title as string)?.slice(0, 40) || '';
      default: return '';
    }
  });
</script>

<Handle type="target" position={Position.Top} />
<div
  class="px-3 py-2 rounded-lg border-2 min-w-[160px] max-w-[220px]"
  style="border-color: {isGithub ? '#a855f7' : '#22c55e'}; background-color: {isGithub ? 'rgba(168, 85, 247, 0.1)' : 'rgba(34, 197, 94, 0.1)'};"
>
  <div class="flex items-center gap-1.5 mb-1">
    <div
      class="w-2 h-2 rounded-full"
      style="background-color: {isGithub ? '#a855f7' : '#22c55e'};"
    ></div>
    <span
      class="text-xs font-semibold truncate"
      style="color: {isGithub ? '#c084fc' : '#4ade80'};"
    >{data.label}</span>
  </div>
  <span
    class="px-1 py-0.5 text-[9px] rounded"
    style="background-color: {isGithub ? 'rgba(168, 85, 247, 0.2)' : 'rgba(34, 197, 94, 0.2)'}; color: {isGithub ? '#d8b4fe' : '#86efac'};"
  >{nodeType.replace(/_/g, ' ')}</span>
  {#if detail}
    <div class="text-[10px] text-gray-400 mt-0.5 truncate">{detail}</div>
  {/if}
</div>
<Handle type="source" position={Position.Bottom} />
