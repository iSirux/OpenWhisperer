<script lang="ts">
  import { settings, isNoteModeAvailable } from "$lib/stores/settings";
  import HotkeyInput from "$lib/components/HotkeyInput.svelte";

  const noteModeAvailable = $derived(isNoteModeAvailable());
</script>

<div class="space-y-4">
  <div class="p-3 bg-surface-elevated rounded border border-border">
    <p class="text-xs text-text-muted">
      <strong class="text-text-secondary">Recording flow:</strong> Press
      the Record hotkey to start recording. While recording, press either
      hotkey to stop:
    </p>
    <ul class="text-xs text-text-muted mt-1 ml-4 list-disc">
      <li>
        <strong>Record & Send</strong> — transcribes and sends the prompt
      </li>
      <li>
        <strong>Transcribe Only</strong> — transcribes and pastes to current
        app
      </li>
    </ul>
    <p
      class="text-xs text-text-muted mt-2 pt-2 border-t border-border/50"
    >
      <strong class="text-text-secondary">Tip:</strong> Click a hotkey field
      and press your desired key combination to set it. Use the toggle to
      enable or disable a hotkey without clearing it.
    </p>
  </div>

  <!-- Record & Send -->
  <div>
    <div class="flex items-center justify-between mb-1">
      <label class="text-sm font-medium text-text-secondary">Record & Send</label>
      <input
        type="checkbox"
        class="toggle"
        bind:checked={$settings.hotkeys_enabled.toggle_recording}
      />
    </div>
    <p class="text-xs text-text-muted mb-2">
      Starts recording. Press again to transcribe and send the prompt.
    </p>
    <HotkeyInput
      bind:value={$settings.hotkeys.toggle_recording}
      enabled={$settings.hotkeys_enabled.toggle_recording}
    />
  </div>

  <!-- Transcribe Only -->
  <div>
    <div class="flex items-center justify-between mb-1">
      <label class="text-sm font-medium text-text-secondary">Transcribe Only</label>
      <input
        type="checkbox"
        class="toggle"
        bind:checked={$settings.hotkeys_enabled.transcribe_to_input}
      />
    </div>
    <p class="text-xs text-text-muted mb-2">
      While recording, transcribes and pastes into current app (does not
      send as prompt)
    </p>
    <HotkeyInput
      bind:value={$settings.hotkeys.transcribe_to_input}
      enabled={$settings.hotkeys_enabled.transcribe_to_input}
    />
  </div>

  <!-- Cycle Repository -->
  <div class="border-t border-border pt-4">
    <div class="flex items-center justify-between mb-1">
      <label class="text-sm font-medium text-text-secondary">Cycle Repository</label>
      <input
        type="checkbox"
        class="toggle"
        bind:checked={$settings.hotkeys_enabled.cycle_repo}
      />
    </div>
    <p class="text-xs text-text-muted mb-2">
      While recording, cycles through repositories
    </p>
    <HotkeyInput
      bind:value={$settings.hotkeys.cycle_repo}
      enabled={$settings.hotkeys_enabled.cycle_repo}
    />
  </div>

  <!-- Cycle Model -->
  <div>
    <div class="flex items-center justify-between mb-1">
      <label class="text-sm font-medium text-text-secondary">Cycle Model</label>
      <input
        type="checkbox"
        class="toggle"
        bind:checked={$settings.hotkeys_enabled.cycle_model}
      />
    </div>
    <p class="text-xs text-text-muted mb-2">
      While recording, cycles through available models
    </p>
    <HotkeyInput
      bind:value={$settings.hotkeys.cycle_model}
      enabled={$settings.hotkeys_enabled.cycle_model}
    />
  </div>

  <!-- New Session -->
  <div class="border-t border-border pt-4">
    <div class="flex items-center justify-between mb-1">
      <label class="text-sm font-medium text-text-secondary">New Session (In-App)</label>
      <input
        type="checkbox"
        class="toggle"
        bind:checked={$settings.hotkeys_enabled.new_session}
      />
    </div>
    <p class="text-xs text-text-muted mb-2">
      While ClaudeWhisperer is focused, creates a new session.
    </p>
    <HotkeyInput
      bind:value={$settings.hotkeys.new_session}
      enabled={$settings.hotkeys_enabled.new_session}
    />
  </div>

  {#if noteModeAvailable}
    <!-- Note Mode -->
    <div class="border-t border-border pt-4">
      <div class="flex items-center justify-between mb-1">
        <label class="text-sm font-medium text-text-secondary">Note Mode</label>
        <input
          type="checkbox"
          class="toggle"
          bind:checked={$settings.hotkeys_enabled.note_mode}
        />
      </div>
      <p class="text-xs text-text-muted mb-2">
        Start recording in note-taking mode. Uses the fastest model with note MCP tools.
      </p>
      <HotkeyInput
        bind:value={$settings.hotkeys.note_mode}
        enabled={$settings.hotkeys_enabled.note_mode}
      />
    </div>
  {/if}

  <!-- Send Selection -->
  <div class="border-t border-border pt-4">
    <div class="flex items-center justify-between mb-1">
      <label class="text-sm font-medium text-text-secondary">Send Selection</label>
      <input
        type="checkbox"
        class="toggle"
        bind:checked={$settings.hotkeys_enabled.send_selection}
      />
    </div>
    <p class="text-xs text-text-muted mb-2">
      Copies selected text from any app and immediately sends it as a new prompt
    </p>
    <HotkeyInput
      bind:value={$settings.hotkeys.send_selection}
      enabled={$settings.hotkeys_enabled.send_selection}
    />
  </div>

  <!-- Prepare Selection -->
  <div>
    <div class="flex items-center justify-between mb-1">
      <label class="text-sm font-medium text-text-secondary">Prepare Selection</label>
      <input
        type="checkbox"
        class="toggle"
        bind:checked={$settings.hotkeys_enabled.prepare_selection}
      />
    </div>
    <p class="text-xs text-text-muted mb-2">
      Copies selected text from any app and creates a prepared session for review before sending
    </p>
    <HotkeyInput
      bind:value={$settings.hotkeys.prepare_selection}
      enabled={$settings.hotkeys_enabled.prepare_selection}
    />
  </div>
</div>
