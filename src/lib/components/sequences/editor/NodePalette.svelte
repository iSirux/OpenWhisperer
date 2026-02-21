<script lang="ts">
  import { getCategoryColor, type NodeCategory } from '$lib/utils/sequenceConverter';

  interface PaletteItem {
    type: string;
    label: string;
    category: NodeCategory;
  }

  let {
    onAddNode = (_type: string) => {},
  }: {
    onAddNode?: (type: string) => void;
  } = $props();

  const categories: { name: string; category: NodeCategory; items: PaletteItem[] }[] = [
    {
      name: 'AI',
      category: 'ai',
      items: [
        { type: 'prompt', label: 'Prompt', category: 'ai' },
        { type: 'route', label: 'Route', category: 'ai' },
      ],
    },
    {
      name: 'Git',
      category: 'git',
      items: [
        { type: 'git_branch', label: 'Branch', category: 'git' },
        { type: 'git_worktree', label: 'Worktree', category: 'git' },
        { type: 'git_commit', label: 'Commit', category: 'git' },
        { type: 'git_push', label: 'Push', category: 'git' },
        { type: 'git_delete_branch', label: 'Delete Branch', category: 'git' },
      ],
    },
    {
      name: 'GitHub',
      category: 'github',
      items: [
        { type: 'github_pr', label: 'Pull Request', category: 'github' },
        { type: 'github_pr_wait', label: 'PR Wait', category: 'github' },
        { type: 'github_pr_merge', label: 'PR Merge', category: 'github' },
      ],
    },
    {
      name: 'Control',
      category: 'control',
      items: [
        { type: 'approval', label: 'Approval', category: 'control' },
        { type: 'wait', label: 'Wait', category: 'control' },
        { type: 'loop', label: 'Loop', category: 'control' },
        { type: 'parallel', label: 'Parallel', category: 'control' },
        { type: 'for_each', label: 'For Each', category: 'control' },
        { type: 'sub_sequence', label: 'Sub-Sequence', category: 'control' },
      ],
    },
    {
      name: 'Actions',
      category: 'action',
      items: [
        { type: 'script', label: 'Script', category: 'action' },
        { type: 'notify', label: 'Notify', category: 'action' },
        { type: 'delay', label: 'Delay', category: 'action' },
        { type: 'file', label: 'File', category: 'action' },
        { type: 'http', label: 'HTTP', category: 'action' },
        { type: 'transform', label: 'Transform', category: 'action' },
      ],
    },
  ];
</script>

<div class="w-[200px] border-r border-border bg-surface overflow-y-auto flex-shrink-0">
  <div class="p-2">
    <h3 class="text-xs font-semibold text-text-primary mb-2 px-1">Add Nodes</h3>
    {#each categories as cat}
      <div class="mb-3">
        <div class="text-[10px] font-semibold text-text-muted uppercase tracking-wider px-1 mb-1">{cat.name}</div>
        <div class="space-y-0.5">
          {#each cat.items as item}
            <button
              class="group flex items-center gap-2 px-2 py-1.5 rounded border border-transparent hover:border-border hover:bg-surface-elevated active:scale-[0.97] transition-all text-xs text-text-secondary hover:text-text-primary w-full text-left select-none cursor-pointer"
              onclick={() => onAddNode(item.type)}
              type="button"
            >
              <div class="w-2 h-2 rounded-full flex-shrink-0" style="background-color: {getCategoryColor(item.category)}"></div>
              <span class="flex-1">{item.label}</span>
              <svg class="w-3.5 h-3.5 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
              </svg>
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </div>
</div>
