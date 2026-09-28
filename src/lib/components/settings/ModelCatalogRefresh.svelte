<script lang="ts">
  import { modelCatalogStatus, refreshModelCatalog } from "$lib/stores/modelCatalog";
  import type { SdkProvider } from "$lib/utils/models";

  let { provider }: { provider: SdkProvider } = $props();

  const status = $derived($modelCatalogStatus[provider]);
  const source = $derived(provider === "openai" ? "Codex" : "the Claude Agent SDK");

  function ago(ts: number): string {
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours} h ago`;
    return `${Math.round(hours / 24)} days ago`;
  }
</script>

<div class="flex items-center justify-between gap-2 mb-3 text-xs text-text-muted">
  <span>
    {#if status.loading}
      Fetching models from {source}…
    {:else if status.error}
      <span class="text-red-400">Couldn't fetch models: {status.error}</span>
    {:else if status.fetchedAt}
      Models fetched from {source} {ago(status.fetchedAt)}. New releases are enabled automatically.
    {:else}
      Showing the built-in model list until models are fetched from {source}.
    {/if}
  </span>
  <button
    class="shrink-0 px-2 py-1 rounded border border-border hover:bg-surface-elevated disabled:opacity-50"
    disabled={status.loading}
    onclick={() => refreshModelCatalog(provider)}
  >
    {status.loading ? "Refreshing…" : "Refresh"}
  </button>
</div>
