<script lang="ts">
  interface Props {
    value: string;
    enabled?: boolean;
    onchange?: (value: string) => void;
  }

  let { value = $bindable(), enabled = true, onchange }: Props = $props();

  let isCapturing = $state(false);
  let inputElement: HTMLButtonElement | null = $state(null);

  // Convert internal format to display format
  function formatForDisplay(hotkey: string): string {
    if (!hotkey) return 'Click to set';
    return hotkey
      .replace(/CommandOrControl/g, 'Ctrl')
      .replace(/\+/g, ' + ');
  }

  // Convert a KeyboardEvent to the hotkey format
  function keyEventToHotkey(e: KeyboardEvent): string | null {
    const parts: string[] = [];

    // Add modifiers in consistent order
    if (e.ctrlKey || e.metaKey) {
      parts.push('CommandOrControl');
    }
    if (e.altKey) {
      parts.push('Alt');
    }
    if (e.shiftKey) {
      parts.push('Shift');
    }

    // Get the actual key
    const key = e.key;

    // Skip if only modifier keys are pressed
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
      return null;
    }

    // Normalize key names
    let normalizedKey = key;

    // Handle special keys
    const keyMap: Record<string, string> = {
      ' ': 'Space',
      'ArrowUp': 'Up',
      'ArrowDown': 'Down',
      'ArrowLeft': 'Left',
      'ArrowRight': 'Right',
      'Escape': 'Escape',
      'Enter': 'Enter',
      'Backspace': 'Backspace',
      'Delete': 'Delete',
      'Tab': 'Tab',
      'Home': 'Home',
      'End': 'End',
      'PageUp': 'PageUp',
      'PageDown': 'PageDown',
      'Insert': 'Insert',
    };

    if (keyMap[key]) {
      normalizedKey = keyMap[key];
    } else if (key.length === 1) {
      // Single character - uppercase it
      normalizedKey = key.toUpperCase();
    } else if (key.startsWith('F') && key.length <= 3) {
      // Function keys (F1-F12)
      normalizedKey = key;
    } else {
      // Unknown key, use as-is but capitalize first letter
      normalizedKey = key.charAt(0).toUpperCase() + key.slice(1);
    }

    parts.push(normalizedKey);

    return parts.join('+');
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (!isCapturing) return;

    e.preventDefault();
    e.stopPropagation();

    // Handle Escape to cancel
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      isCapturing = false;
      return;
    }

    const hotkey = keyEventToHotkey(e);
    if (hotkey) {
      value = hotkey;
      isCapturing = false;
      onchange?.(hotkey);
    }
  }

  function handleClick() {
    if (!enabled) return;
    isCapturing = true;
    // Focus will be handled by the button's native focus
  }

  function handleBlur() {
    // Small delay to allow click events to process
    setTimeout(() => {
      isCapturing = false;
    }, 100);
  }

  function handleClear(e: MouseEvent) {
    e.stopPropagation();
    value = '';
    isCapturing = false;
    onchange?.('');
  }
</script>

<div class="hotkey-input-wrapper" class:disabled={!enabled}>
  <button
    bind:this={inputElement}
    type="button"
    class="hotkey-input"
    class:capturing={isCapturing}
    class:disabled={!enabled}
    onclick={handleClick}
    onkeydown={handleKeyDown}
    onblur={handleBlur}
  >
    {#if isCapturing}
      <span class="capturing-text">Press a key combination...</span>
    {:else}
      <span class="hotkey-display">{formatForDisplay(value)}</span>
    {/if}
  </button>
  {#if value && !isCapturing && enabled}
    <button
      type="button"
      class="clear-button"
      onclick={handleClear}
      title="Clear hotkey"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  {/if}
</div>

<style>
  .hotkey-input-wrapper {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .hotkey-input {
    flex: 1;
    padding: 0.5rem 0.75rem;
    background: var(--color-background);
    border: 1px solid var(--color-border);
    border-radius: 0.25rem;
    font-size: 0.875rem;
    font-family: ui-monospace, monospace;
    text-align: left;
    cursor: pointer;
    transition: border-color 0.2s, box-shadow 0.2s;
    color: var(--color-text-primary);
  }

  .hotkey-input-wrapper.disabled {
    opacity: 0.45;
    pointer-events: none;
  }

  .hotkey-input.disabled {
    cursor: default;
  }

  .hotkey-input:hover:not(.disabled) {
    border-color: var(--color-accent);
  }

  .hotkey-input:focus {
    outline: none;
    border-color: var(--color-accent);
    box-shadow: 0 0 0 2px rgba(var(--color-accent-rgb, 99, 102, 241), 0.2);
  }

  .hotkey-input.capturing {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 2px rgba(var(--color-accent-rgb, 99, 102, 241), 0.3);
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% {
      box-shadow: 0 0 0 2px rgba(var(--color-accent-rgb, 99, 102, 241), 0.3);
    }
    50% {
      box-shadow: 0 0 0 4px rgba(var(--color-accent-rgb, 99, 102, 241), 0.15);
    }
  }

  .capturing-text {
    color: var(--color-text-muted);
    font-style: italic;
  }

  .hotkey-display {
    color: var(--color-text-primary);
  }

  .clear-button {
    padding: 0.375rem;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: 0.25rem;
    cursor: pointer;
    color: var(--color-text-muted);
    transition: color 0.2s, border-color 0.2s, background 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .clear-button:hover {
    color: var(--color-error);
    border-color: var(--color-error);
    background: rgba(var(--color-error-rgb, 239, 68, 68), 0.1);
  }
</style>
