<script lang="ts">
  import { settings } from "$lib/stores/settings";

  interface Props {
    /** Currently selected chip labels */
    selected: string[];
    /** Called with the next selection when a chip is toggled */
    onchange: (next: string[]) => void;
    /** Optional label shown before the chips */
    label?: string;
  }

  let { selected, onchange, label = "Add to prompt" }: Props = $props();

  const chips = $derived($settings.prompt_chips ?? []);

  function toggle(chip: string) {
    const next = selected.includes(chip)
      ? selected.filter((c) => c !== chip)
      : [...selected, chip];
    onchange(next);
  }
</script>

{#if chips.length > 0}
  <div class="prompt-chips">
    {#if label}
      <span class="prompt-chips-label">{label}</span>
    {/if}
    <div class="prompt-chips-list">
      {#each chips as chip (chip)}
        <button
          type="button"
          class="prompt-chip"
          class:active={selected.includes(chip)}
          onclick={() => toggle(chip)}
          title={selected.includes(chip)
            ? `Won't append "${chip}"`
            : `Append "${chip}" to the prompt`}
        >
          {chip}
        </button>
      {/each}
    </div>
  </div>
{/if}

<style>
  .prompt-chips {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  .prompt-chips-label {
    font-size: 11px;
    color: var(--color-text-muted);
  }

  .prompt-chips-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .prompt-chip {
    padding: 3px 10px;
    font-size: 12px;
    line-height: 1.4;
    border-radius: 9999px;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all 0.12s ease;
  }

  .prompt-chip:hover {
    border-color: var(--color-accent);
    color: var(--color-text-primary);
  }

  .prompt-chip.active {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: white;
  }
</style>
