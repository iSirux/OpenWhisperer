<script lang="ts">
  import { settings } from "$lib/stores/settings";

  interface Props {
    /** Currently selected chip labels */
    selected: string[];
    /** Called with the next selection when a chip is toggled */
    onchange: (next: string[]) => void;
    /** Optional label shown before the chips */
    label?: string;
    /** When provided, each chip gets a quickship button that sends immediately with this chip */
    onQuickship?: (chip: string) => void;
    /** Disables the quickship buttons (e.g. empty prompt, launch in flight) */
    quickshipDisabled?: boolean;
  }

  let { selected, onchange, label = "Add to prompt", onQuickship, quickshipDisabled = false }: Props = $props();

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
        {#if onQuickship}
          <div class="prompt-chip prompt-chip--split" class:active={selected.includes(chip)}>
            <button
              type="button"
              class="prompt-chip-toggle"
              onclick={() => toggle(chip)}
              title={selected.includes(chip)
                ? `Won't append "${chip}"`
                : `Append "${chip}" to the prompt`}
            >
              {chip}
            </button>
            <button
              type="button"
              class="prompt-chip-ship"
              disabled={quickshipDisabled}
              onclick={() => onQuickship(chip)}
              title={`Send now with "${chip}"`}
            >
              <svg viewBox="0 0 20 20" fill="currentColor">
                <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
              </svg>
            </button>
          </div>
        {:else}
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
        {/if}
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

  /* Split chip: toggle label + quickship send button */
  .prompt-chip--split {
    display: inline-flex;
    align-items: stretch;
    padding: 0;
    overflow: hidden;
  }

  .prompt-chip-toggle {
    padding: 3px 8px 3px 10px;
    font-size: 12px;
    line-height: 1.4;
    color: inherit;
    cursor: pointer;
  }

  .prompt-chip--split:hover {
    border-color: var(--color-accent);
    color: var(--color-text-primary);
  }

  .prompt-chip--split.active .prompt-chip-toggle {
    color: white;
  }

  .prompt-chip-ship {
    display: inline-flex;
    align-items: center;
    padding: 0 8px 0 6px;
    border-left: 1px solid var(--color-border);
    color: var(--color-text-muted);
    cursor: pointer;
    transition: all 0.12s ease;
  }

  .prompt-chip-ship svg {
    width: 11px;
    height: 11px;
    transform: rotate(90deg);
  }

  .prompt-chip-ship:hover:not(:disabled) {
    background: var(--color-accent);
    color: white;
  }

  .prompt-chip-ship:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .prompt-chip--split.active .prompt-chip-ship {
    border-left-color: rgba(255, 255, 255, 0.3);
    color: rgba(255, 255, 255, 0.85);
  }
</style>
