<script lang="ts">
  import type { RepoConfig } from '$lib/stores/repos';
  import {
    getRepoIconPaths,
    getContrastColor,
    getRepoColor,
  } from '$lib/utils/repoIcons';

  interface Props {
    /** The repo config to display an icon for. If null, shows a default code icon. */
    repo: RepoConfig | null;
    /** Size of the icon badge */
    size?: 'xs' | 'sm' | 'md' | 'lg';
  }

  let { repo, size = 'sm' }: Props = $props();

  const sizeMap = {
    xs: { container: 'w-4 h-4 rounded', icon: 'w-2.5 h-2.5' },
    sm: { container: 'w-6 h-6 rounded-md', icon: 'w-3.5 h-3.5' },
    md: { container: 'w-8 h-8 rounded-lg', icon: 'w-5 h-5' },
    lg: { container: 'w-10 h-10 rounded-lg', icon: 'w-6 h-6' },
  };

  const bgColor = $derived(getRepoColor(repo));
  const fgColor = $derived(getContrastColor(bgColor));
  const iconPaths = $derived(getRepoIconPaths(repo?.icon));
  const s = $derived(sizeMap[size]);
</script>

<div
  class="{s.container} flex items-center justify-center flex-shrink-0"
  style="background-color: {bgColor};"
>
  <svg
    class={s.icon}
    fill="none"
    stroke={fgColor}
    viewBox="0 0 24 24"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d={iconPaths} />
  </svg>
</div>
