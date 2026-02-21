<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import HotkeyInput from "$lib/components/HotkeyInput.svelte";
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
        <strong>Record & Send</strong> — transcribes and sends to Claude
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
      and press your desired key combination to set it.
    </p>
  </div>
  <div>
    <label class="block text-sm font-medium text-text-secondary mb-1"
      >Record & Send</label
    >
    <p class="text-xs text-text-muted mb-2">
      Starts recording. Press again to transcribe and send to Claude.
    </p>
    <HotkeyInput bind:value={$settings.hotkeys.toggle_recording} />
  </div>
  <div>
    <label class="block text-sm font-medium text-text-secondary mb-1"
      >Transcribe Only</label
    >
    <p class="text-xs text-text-muted mb-2">
      While recording, transcribes and pastes into current app (does not
      send to Claude)
    </p>
    <HotkeyInput bind:value={$settings.hotkeys.transcribe_to_input} />
  </div>
  <div class="border-t border-border pt-4">
    <label class="block text-sm font-medium text-text-secondary mb-1"
      >Cycle Repository</label
    >
    <p class="text-xs text-text-muted mb-2">
      While recording, cycles through repositories
    </p>
    <HotkeyInput bind:value={$settings.hotkeys.cycle_repo} />
  </div>
  <div>
    <label class="block text-sm font-medium text-text-secondary mb-1"
      >Cycle Model</label
    >
    <p class="text-xs text-text-muted mb-2">
      While recording, cycles through models (Opus → Sonnet → Haiku)
    </p>
    <HotkeyInput bind:value={$settings.hotkeys.cycle_model} />
  </div>
  <div class="border-t border-border pt-4">
    <label class="block text-sm font-medium text-text-secondary mb-1"
      >Note Mode</label
    >
    <p class="text-xs text-text-muted mb-2">
      Start recording in note-taking mode. Uses Haiku with note MCP tools.
    </p>
    <HotkeyInput bind:value={$settings.hotkeys.note_mode} />
  </div>
</div>
