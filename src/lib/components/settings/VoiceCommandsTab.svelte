<script lang="ts">
  import {
    settings,
    VOICE_COMMAND_PRESETS,
    TRANSCRIBE_COMMAND_PRESETS,
    CANCEL_COMMAND_PRESETS,
    NOTE_COMMAND_PRESETS,
    OPEN_MIC_PRESETS,
    SEQUENCE_COMMAND_PRESETS,
    APPROVE_COMMAND_PRESETS,
    REJECT_COMMAND_PRESETS,
    PREPARE_COMMAND_PRESETS,
  } from "$lib/stores/settings";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { isValidVoiceCommand } from "$lib/utils/voiceCommands";
  import { isValidWakeCommand } from "$lib/stores/openMic";
  import "./toggle.css";

  // Audio level from open mic for threshold preview
  let currentRms = $state(0);
  let isAboveThreshold = $state(false);

  // Start listening for audio level when open mic is enabled
  $effect(() => {
    const shouldListen = $settings.audio.open_mic.enabled && $settings.vosk?.enabled;
    let unlistenFn: UnlistenFn | null = null;
    let cancelled = false;

    if (shouldListen) {
      // Set up listener
      listen<{ rms: number; threshold: number; isAboveThreshold: boolean }>(
        "open-mic-audio-level",
        (event) => {
          if (cancelled) return;
          currentRms = event.payload?.rms ?? 0;
          isAboveThreshold = event.payload?.isAboveThreshold ?? false;
        }
      ).then((unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          unlistenFn = unlisten;
        }
      });
    } else {
      currentRms = 0;
      isAboveThreshold = false;
    }

    // Cleanup function - runs when effect re-runs or component unmounts
    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  });

  let customCommand = $state("");
  let customCommandError = $state("");
  let customTranscribeCommand = $state("");
  let customTranscribeCommandError = $state("");
  let customCancelCommand = $state("");
  let customCancelCommandError = $state("");
  let customNoteCommand = $state("");
  let customNoteCommandError = $state("");
  let customWakeCommand = $state("");
  let customWakeCommandError = $state("");

  // Send prompt command functions
  function toggleVoiceCommand(command: string) {
    const activeCommands = $settings.audio.voice_commands.active_commands;
    const index = activeCommands.indexOf(command);
    if (index === -1) {
      $settings.audio.voice_commands.active_commands = [
        ...activeCommands,
        command,
      ];
    } else {
      $settings.audio.voice_commands.active_commands = activeCommands.filter(
        (c) => c !== command
      );
    }
  }

  function isCommandActive(command: string): boolean {
    return $settings.audio.voice_commands.active_commands.includes(command);
  }

  function addCustomCommand() {
    const trimmed = customCommand.trim().toLowerCase();
    if (!trimmed) {
      customCommandError = "";
      return;
    }

    if (!isValidVoiceCommand(trimmed)) {
      customCommandError = "Command must be 2-30 characters";
      return;
    }

    // Check if already exists (in presets or active commands)
    const allCommands = [
      ...VOICE_COMMAND_PRESETS,
      ...$settings.audio.voice_commands.active_commands,
    ].map((c) => c.toLowerCase());

    if (allCommands.includes(trimmed)) {
      customCommandError = "Command already exists";
      return;
    }

    $settings.audio.voice_commands.active_commands = [
      ...$settings.audio.voice_commands.active_commands,
      trimmed,
    ];
    customCommand = "";
    customCommandError = "";
  }

  function removeCustomCommand(command: string) {
    $settings.audio.voice_commands.active_commands =
      $settings.audio.voice_commands.active_commands.filter(
        (c) => c !== command
      );
  }

  // Get custom commands (commands not in presets)
  function getCustomCommands(): string[] {
    const presetSet = new Set(
      VOICE_COMMAND_PRESETS.map((c) => c.toLowerCase())
    );
    return $settings.audio.voice_commands.active_commands.filter(
      (c) => !presetSet.has(c.toLowerCase())
    );
  }

  // Transcribe command functions
  function toggleTranscribeCommand(command: string) {
    const transcribeCommands = $settings.audio.voice_commands.transcribe_commands ?? [];
    const index = transcribeCommands.indexOf(command);
    if (index === -1) {
      $settings.audio.voice_commands.transcribe_commands = [
        ...transcribeCommands,
        command,
      ];
    } else {
      $settings.audio.voice_commands.transcribe_commands = transcribeCommands.filter(
        (c) => c !== command
      );
    }
  }

  function isTranscribeCommandActive(command: string): boolean {
    return ($settings.audio.voice_commands.transcribe_commands ?? []).includes(command);
  }

  function addCustomTranscribeCommand() {
    const trimmed = customTranscribeCommand.trim().toLowerCase();
    if (!trimmed) {
      customTranscribeCommandError = "";
      return;
    }

    if (!isValidVoiceCommand(trimmed)) {
      customTranscribeCommandError = "Command must be 2-30 characters";
      return;
    }

    // Check if already exists (in presets or active commands)
    const allCommands = [
      ...TRANSCRIBE_COMMAND_PRESETS,
      ...($settings.audio.voice_commands.transcribe_commands ?? []),
    ].map((c) => c.toLowerCase());

    if (allCommands.includes(trimmed)) {
      customTranscribeCommandError = "Command already exists";
      return;
    }

    $settings.audio.voice_commands.transcribe_commands = [
      ...($settings.audio.voice_commands.transcribe_commands ?? []),
      trimmed,
    ];
    customTranscribeCommand = "";
    customTranscribeCommandError = "";
  }

  function removeCustomTranscribeCommand(command: string) {
    $settings.audio.voice_commands.transcribe_commands =
      ($settings.audio.voice_commands.transcribe_commands ?? []).filter(
        (c) => c !== command
      );
  }

  // Get custom transcribe commands (commands not in presets)
  function getCustomTranscribeCommands(): string[] {
    const presetSet = new Set(
      TRANSCRIBE_COMMAND_PRESETS.map((c) => c.toLowerCase())
    );
    return ($settings.audio.voice_commands.transcribe_commands ?? []).filter(
      (c) => !presetSet.has(c.toLowerCase())
    );
  }

  // Cancel command functions
  function toggleCancelCommand(command: string) {
    const cancelCommands = $settings.audio.voice_commands.cancel_commands ?? [];
    const index = cancelCommands.indexOf(command);
    if (index === -1) {
      $settings.audio.voice_commands.cancel_commands = [
        ...cancelCommands,
        command,
      ];
    } else {
      $settings.audio.voice_commands.cancel_commands = cancelCommands.filter(
        (c) => c !== command
      );
    }
  }

  function isCancelCommandActive(command: string): boolean {
    return ($settings.audio.voice_commands.cancel_commands ?? []).includes(command);
  }

  function addCustomCancelCommand() {
    const trimmed = customCancelCommand.trim().toLowerCase();
    if (!trimmed) {
      customCancelCommandError = "";
      return;
    }

    if (!isValidVoiceCommand(trimmed)) {
      customCancelCommandError = "Command must be 2-30 characters";
      return;
    }

    // Check if already exists (in presets or active commands)
    const allCommands = [
      ...CANCEL_COMMAND_PRESETS,
      ...($settings.audio.voice_commands.cancel_commands ?? []),
    ].map((c) => c.toLowerCase());

    if (allCommands.includes(trimmed)) {
      customCancelCommandError = "Command already exists";
      return;
    }

    $settings.audio.voice_commands.cancel_commands = [
      ...($settings.audio.voice_commands.cancel_commands ?? []),
      trimmed,
    ];
    customCancelCommand = "";
    customCancelCommandError = "";
  }

  function removeCustomCancelCommand(command: string) {
    $settings.audio.voice_commands.cancel_commands =
      ($settings.audio.voice_commands.cancel_commands ?? []).filter(
        (c) => c !== command
      );
  }

  // Get custom cancel commands (commands not in presets)
  function getCustomCancelCommands(): string[] {
    const presetSet = new Set(
      CANCEL_COMMAND_PRESETS.map((c) => c.toLowerCase())
    );
    return ($settings.audio.voice_commands.cancel_commands ?? []).filter(
      (c) => !presetSet.has(c.toLowerCase())
    );
  }

  // Note command functions
  function toggleNoteCommand(command: string) {
    const noteCommands = $settings.audio.voice_commands.note_commands ?? [];
    const index = noteCommands.indexOf(command);
    if (index === -1) {
      $settings.audio.voice_commands.note_commands = [
        ...noteCommands,
        command,
      ];
    } else {
      $settings.audio.voice_commands.note_commands = noteCommands.filter(
        (c) => c !== command
      );
    }
  }

  function isNoteCommandActive(command: string): boolean {
    return ($settings.audio.voice_commands.note_commands ?? []).includes(command);
  }

  function addCustomNoteCommand() {
    const trimmed = customNoteCommand.trim().toLowerCase();
    if (!trimmed) {
      customNoteCommandError = "";
      return;
    }

    if (!isValidVoiceCommand(trimmed)) {
      customNoteCommandError = "Command must be 2-30 characters";
      return;
    }

    // Check if already exists (in presets or active commands)
    const allCommands = [
      ...NOTE_COMMAND_PRESETS,
      ...($settings.audio.voice_commands.note_commands ?? []),
    ].map((c) => c.toLowerCase());

    if (allCommands.includes(trimmed)) {
      customNoteCommandError = "Command already exists";
      return;
    }

    $settings.audio.voice_commands.note_commands = [
      ...($settings.audio.voice_commands.note_commands ?? []),
      trimmed,
    ];
    customNoteCommand = "";
    customNoteCommandError = "";
  }

  function removeCustomNoteCommand(command: string) {
    $settings.audio.voice_commands.note_commands =
      ($settings.audio.voice_commands.note_commands ?? []).filter(
        (c) => c !== command
      );
  }

  // Get custom note commands (commands not in presets)
  function getCustomNoteCommands(): string[] {
    const presetSet = new Set(
      NOTE_COMMAND_PRESETS.map((c) => c.toLowerCase())
    );
    return ($settings.audio.voice_commands.note_commands ?? []).filter(
      (c) => !presetSet.has(c.toLowerCase())
    );
  }

  // Open Mic wake command functions
  function toggleWakeCommand(command: string) {
    const wakeCommands = $settings.audio.open_mic.wake_commands;
    const index = wakeCommands.indexOf(command);
    if (index === -1) {
      $settings.audio.open_mic.wake_commands = [...wakeCommands, command];
    } else {
      $settings.audio.open_mic.wake_commands = wakeCommands.filter(
        (c) => c !== command
      );
    }
  }

  function isWakeCommandActive(command: string): boolean {
    return $settings.audio.open_mic.wake_commands.includes(command);
  }

  function addCustomWakeCommand() {
    const trimmed = customWakeCommand.trim().toLowerCase();
    if (!trimmed) {
      customWakeCommandError = "";
      return;
    }

    if (!isValidWakeCommand(trimmed)) {
      customWakeCommandError = "Command must be 2-30 characters";
      return;
    }

    // Check if already exists (in presets or active commands)
    const allCommands = [
      ...OPEN_MIC_PRESETS,
      ...$settings.audio.open_mic.wake_commands,
    ].map((c) => c.toLowerCase());

    if (allCommands.includes(trimmed)) {
      customWakeCommandError = "Command already exists";
      return;
    }

    $settings.audio.open_mic.wake_commands = [
      ...$settings.audio.open_mic.wake_commands,
      trimmed,
    ];
    customWakeCommand = "";
    customWakeCommandError = "";
  }

  function removeCustomWakeCommand(command: string) {
    $settings.audio.open_mic.wake_commands =
      $settings.audio.open_mic.wake_commands.filter((c) => c !== command);
  }

  // Get custom wake commands (commands not in presets)
  function getCustomWakeCommands(): string[] {
    const presetSet = new Set(OPEN_MIC_PRESETS.map((c) => c.toLowerCase()));
    return $settings.audio.open_mic.wake_commands.filter(
      (c) => !presetSet.has(c.toLowerCase())
    );
  }
</script>

<div class="space-y-4">
  <!-- Voice Commands Section -->
  <div>
    <div class="flex items-center justify-between mb-3">
      <div>
        <label class="text-sm font-medium text-text-secondary"
          >Voice Commands</label
        >
        <p class="text-xs text-text-muted mt-0.5">
          Say a command at the end of your recording to automatically send the
          prompt
        </p>
      </div>
      <input
        type="checkbox"
        class="toggle"
        bind:checked={$settings.audio.voice_commands.enabled}
      />
    </div>

    {#if $settings.audio.voice_commands.enabled}
      <div class="space-y-3 mt-4">
        <!-- Preset Commands -->
        <div>
          <label class="block text-xs font-medium text-text-muted mb-2"
            >Preset Commands</label
          >
          <div class="flex flex-wrap gap-2">
            {#each VOICE_COMMAND_PRESETS as command}
              <button
                type="button"
                class="px-3 py-1.5 text-sm rounded-full border transition-colors {isCommandActive(
                  command
                )
                  ? 'bg-accent text-white border-accent'
                  : 'bg-surface-elevated text-text-secondary border-border hover:border-accent hover:text-text-primary'}"
                onclick={() => toggleVoiceCommand(command)}
              >
                "{command}"
              </button>
            {/each}
          </div>
        </div>

        <!-- Custom Commands -->
        <div>
          <label class="block text-xs font-medium text-text-muted mb-2"
            >Custom Commands</label
          >
          <div class="flex gap-2">
            <input
              type="text"
              placeholder="Add custom command..."
              class="flex-1 px-3 py-1.5 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
              bind:value={customCommand}
              onkeydown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustomCommand();
                }
              }}
            />
            <button
              type="button"
              class="px-3 py-1.5 bg-accent text-white rounded text-sm hover:bg-accent/90 transition-colors disabled:opacity-50"
              onclick={addCustomCommand}
              disabled={!customCommand.trim()}
            >
              Add
            </button>
          </div>
          {#if customCommandError}
            <p class="text-xs text-red-500 mt-1">{customCommandError}</p>
          {/if}

          {#if getCustomCommands().length > 0}
            <div class="flex flex-wrap gap-2 mt-2">
              {#each getCustomCommands() as command}
                <div
                  class="flex items-center gap-1 px-3 py-1.5 text-sm rounded-full bg-accent text-white"
                >
                  <span>"{command}"</span>
                  <button
                    type="button"
                    class="ml-1 hover:bg-white/20 rounded-full p-0.5 transition-colors"
                    onclick={() => removeCustomCommand(command)}
                    title="Remove command"
                  >
                    <svg
                      class="w-3 h-3"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Active Commands Summary -->
        {#if $settings.audio.voice_commands.active_commands.length > 0}
          <p class="text-xs text-text-muted">
            Active commands: {$settings.audio.voice_commands.active_commands.length}
            - Commands will be removed from the transcript before sending
          </p>
        {:else}
          <p class="text-xs text-yellow-500">
            No commands selected. Select at least one command to enable voice
            triggering.
          </p>
        {/if}

        <!-- Transcribe Commands Section -->
        <div class="border-t border-border/50 pt-4 mt-4">
          <div class="mb-3">
            <label class="text-sm font-medium text-text-secondary"
              >Transcribe-to-Input Commands</label
            >
            <p class="text-xs text-text-muted mt-0.5">
              Say these commands to paste the transcription into the current app instead of sending as a prompt
            </p>
          </div>

          <!-- Preset Transcribe Commands -->
          <div>
            <label class="block text-xs font-medium text-text-muted mb-2"
              >Preset Commands</label
            >
            <div class="flex flex-wrap gap-2">
              {#each TRANSCRIBE_COMMAND_PRESETS as command}
                <button
                  type="button"
                  class="px-3 py-1.5 text-sm rounded-full border transition-colors {isTranscribeCommandActive(
                    command
                  )
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-surface-elevated text-text-secondary border-border hover:border-blue-500 hover:text-text-primary'}"
                  onclick={() => toggleTranscribeCommand(command)}
                >
                  "{command}"
                </button>
              {/each}
            </div>
          </div>

          <!-- Custom Transcribe Commands -->
          <div class="mt-3">
            <label class="block text-xs font-medium text-text-muted mb-2"
              >Custom Commands</label
            >
            <div class="flex gap-2">
              <input
                type="text"
                placeholder="Add custom command..."
                class="flex-1 px-3 py-1.5 bg-background border border-border rounded text-sm focus:outline-none focus:border-blue-500"
                bind:value={customTranscribeCommand}
                onkeydown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomTranscribeCommand();
                  }
                }}
              />
              <button
                type="button"
                class="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 transition-colors disabled:opacity-50"
                onclick={addCustomTranscribeCommand}
                disabled={!customTranscribeCommand.trim()}
              >
                Add
              </button>
            </div>
            {#if customTranscribeCommandError}
              <p class="text-xs text-red-500 mt-1">{customTranscribeCommandError}</p>
            {/if}

            {#if getCustomTranscribeCommands().length > 0}
              <div class="flex flex-wrap gap-2 mt-2">
                {#each getCustomTranscribeCommands() as command}
                  <div
                    class="flex items-center gap-1 px-3 py-1.5 text-sm rounded-full bg-blue-600 text-white"
                  >
                    <span>"{command}"</span>
                    <button
                      type="button"
                      class="ml-1 hover:bg-white/20 rounded-full p-0.5 transition-colors"
                      onclick={() => removeCustomTranscribeCommand(command)}
                      title="Remove command"
                    >
                      <svg
                        class="w-3 h-3"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          <!-- Active Transcribe Commands Summary -->
          {#if ($settings.audio.voice_commands.transcribe_commands ?? []).length > 0}
            <p class="text-xs text-text-muted mt-3">
              Active transcribe commands: {($settings.audio.voice_commands.transcribe_commands ?? []).length}
              - Commands will paste the transcript into the current app
            </p>
          {:else}
            <p class="text-xs text-text-muted mt-3">
              No transcribe commands selected. Optional: select commands to enable voice-triggered transcription.
            </p>
          {/if}
        </div>

        <!-- Cancel Commands Section -->
        <div class="border-t border-border/50 pt-4 mt-4">
          <div class="mb-3">
            <label class="text-sm font-medium text-text-secondary"
              >Cancel/Discard Commands</label
            >
            <p class="text-xs text-text-muted mt-0.5">
              Say these commands to cancel and discard the current recording
            </p>
          </div>

          <!-- Preset Cancel Commands -->
          <div>
            <label class="block text-xs font-medium text-text-muted mb-2"
              >Preset Commands</label
            >
            <div class="flex flex-wrap gap-2">
              {#each CANCEL_COMMAND_PRESETS as command}
                <button
                  type="button"
                  class="px-3 py-1.5 text-sm rounded-full border transition-colors {isCancelCommandActive(
                    command
                  )
                    ? 'bg-red-600 text-white border-red-600'
                    : 'bg-surface-elevated text-text-secondary border-border hover:border-red-500 hover:text-text-primary'}"
                  onclick={() => toggleCancelCommand(command)}
                >
                  "{command}"
                </button>
              {/each}
            </div>
          </div>

          <!-- Custom Cancel Commands -->
          <div class="mt-3">
            <label class="block text-xs font-medium text-text-muted mb-2"
              >Custom Commands</label
            >
            <div class="flex gap-2">
              <input
                type="text"
                placeholder="Add custom command..."
                class="flex-1 px-3 py-1.5 bg-background border border-border rounded text-sm focus:outline-none focus:border-red-500"
                bind:value={customCancelCommand}
                onkeydown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomCancelCommand();
                  }
                }}
              />
              <button
                type="button"
                class="px-3 py-1.5 bg-red-600 text-white rounded text-sm hover:bg-red-700 transition-colors disabled:opacity-50"
                onclick={addCustomCancelCommand}
                disabled={!customCancelCommand.trim()}
              >
                Add
              </button>
            </div>
            {#if customCancelCommandError}
              <p class="text-xs text-red-500 mt-1">{customCancelCommandError}</p>
            {/if}

            {#if getCustomCancelCommands().length > 0}
              <div class="flex flex-wrap gap-2 mt-2">
                {#each getCustomCancelCommands() as command}
                  <div
                    class="flex items-center gap-1 px-3 py-1.5 text-sm rounded-full bg-red-600 text-white"
                  >
                    <span>"{command}"</span>
                    <button
                      type="button"
                      class="ml-1 hover:bg-white/20 rounded-full p-0.5 transition-colors"
                      onclick={() => removeCustomCancelCommand(command)}
                      title="Remove command"
                    >
                      <svg
                        class="w-3 h-3"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          <!-- Active Cancel Commands Summary -->
          {#if ($settings.audio.voice_commands.cancel_commands ?? []).length > 0}
            <p class="text-xs text-text-muted mt-3">
              Active cancel commands: {($settings.audio.voice_commands.cancel_commands ?? []).length}
              - Recording will be discarded when these commands are detected
            </p>
          {:else}
            <p class="text-xs text-text-muted mt-3">
              No cancel commands selected. Optional: select commands to enable voice-triggered cancellation.
            </p>
          {/if}
        </div>

        <!-- Note Commands Section -->
        <div class="border-t border-border/50 pt-4 mt-4">
          <div class="mb-3">
            <label class="text-sm font-medium text-text-secondary"
              >Note-Taking Commands</label
            >
            <p class="text-xs text-text-muted mt-0.5">
              Say these commands to enter note-taking mode instead of sending as a prompt
            </p>
          </div>

          <!-- Preset Note Commands -->
          <div>
            <label class="block text-xs font-medium text-text-muted mb-2"
              >Preset Commands</label
            >
            <div class="flex flex-wrap gap-2">
              {#each NOTE_COMMAND_PRESETS as command}
                <button
                  type="button"
                  class="px-3 py-1.5 text-sm rounded-full border transition-colors {isNoteCommandActive(
                    command
                  )
                    ? 'bg-amber-600 text-white border-amber-600'
                    : 'bg-surface-elevated text-text-secondary border-border hover:border-amber-500 hover:text-text-primary'}"
                  onclick={() => toggleNoteCommand(command)}
                >
                  "{command}"
                </button>
              {/each}
            </div>
          </div>

          <!-- Custom Note Commands -->
          <div class="mt-3">
            <label class="block text-xs font-medium text-text-muted mb-2"
              >Custom Commands</label
            >
            <div class="flex gap-2">
              <input
                type="text"
                placeholder="Add custom command..."
                class="flex-1 px-3 py-1.5 bg-background border border-border rounded text-sm focus:outline-none focus:border-amber-500"
                bind:value={customNoteCommand}
                onkeydown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomNoteCommand();
                  }
                }}
              />
              <button
                type="button"
                class="px-3 py-1.5 bg-amber-600 text-white rounded text-sm hover:bg-amber-700 transition-colors disabled:opacity-50"
                onclick={addCustomNoteCommand}
                disabled={!customNoteCommand.trim()}
              >
                Add
              </button>
            </div>
            {#if customNoteCommandError}
              <p class="text-xs text-red-500 mt-1">{customNoteCommandError}</p>
            {/if}

            {#if getCustomNoteCommands().length > 0}
              <div class="flex flex-wrap gap-2 mt-2">
                {#each getCustomNoteCommands() as command}
                  <div
                    class="flex items-center gap-1 px-3 py-1.5 text-sm rounded-full bg-amber-600 text-white"
                  >
                    <span>"{command}"</span>
                    <button
                      type="button"
                      class="ml-1 hover:bg-white/20 rounded-full p-0.5 transition-colors"
                      onclick={() => removeCustomNoteCommand(command)}
                      title="Remove command"
                    >
                      <svg
                        class="w-3 h-3"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          <!-- Active Note Commands Summary -->
          {#if ($settings.audio.voice_commands.note_commands ?? []).length > 0}
            <p class="text-xs text-text-muted mt-3">
              Active note commands: {($settings.audio.voice_commands.note_commands ?? []).length}
              - Recording will use the fastest model and note-taking MCP tools
            </p>
          {:else}
            <p class="text-xs text-text-muted mt-3">
              No note commands selected. Optional: select commands to enable voice-triggered note-taking.
            </p>
          {/if}
        </div>

        <!-- Sequence Voice Commands Section -->
        <div class="border-t border-border/50 pt-4 mt-4">
          <h3 class="text-sm font-medium text-text-secondary mb-1">Sequence Voice Commands</h3>
          <p class="text-xs text-text-muted mb-3">
            Voice commands for controlling sequences
          </p>

          <div class="space-y-4">
            <!-- Run Sequence Commands -->
            <div>
              <label class="text-xs font-medium text-text-secondary block mb-1">Run Sequence Commands</label>
              <p class="text-[10px] text-text-muted mb-1.5">
                Say these followed by a sequence name to start it (e.g., "run sequence deploy")
              </p>
              <div class="flex flex-wrap gap-1.5">
                {#each $settings.audio.voice_commands.sequence_commands ?? [] as cmd}
                  <span class="inline-flex items-center gap-1 px-2 py-0.5 bg-accent/10 text-accent rounded text-xs">
                    {cmd}
                    <button class="hover:text-red-400" onclick={() => {
                      const cmds = ($settings.audio.voice_commands.sequence_commands ?? []).filter(c => c !== cmd);
                      settings.save({ ...$settings, audio: { ...$settings.audio, voice_commands: { ...$settings.audio.voice_commands, sequence_commands: cmds } } });
                    }}>&times;</button>
                  </span>
                {/each}
                <input
                  type="text"
                  class="w-32 px-2 py-0.5 text-xs rounded border border-border bg-background focus:outline-none focus:border-accent"
                  placeholder="Add command..."
                  onkeydown={(e) => {
                    const input = e.currentTarget as HTMLInputElement;
                    if (e.key === 'Enter' && input.value.trim()) {
                      const cmds = [...($settings.audio.voice_commands.sequence_commands ?? []), input.value.trim()];
                      settings.save({ ...$settings, audio: { ...$settings.audio, voice_commands: { ...$settings.audio.voice_commands, sequence_commands: cmds } } });
                      input.value = '';
                    }
                  }}
                />
              </div>
            </div>

            <!-- Approve Commands -->
            <div>
              <label class="text-xs font-medium text-text-secondary block mb-1">Approve Commands</label>
              <p class="text-[10px] text-text-muted mb-1.5">
                Say these to approve a pending approval node
              </p>
              <div class="flex flex-wrap gap-1.5">
                {#each $settings.audio.voice_commands.approve_commands ?? [] as cmd}
                  <span class="inline-flex items-center gap-1 px-2 py-0.5 bg-green-500/10 text-green-400 rounded text-xs">
                    {cmd}
                    <button class="hover:text-red-400" onclick={() => {
                      const cmds = ($settings.audio.voice_commands.approve_commands ?? []).filter(c => c !== cmd);
                      settings.save({ ...$settings, audio: { ...$settings.audio, voice_commands: { ...$settings.audio.voice_commands, approve_commands: cmds } } });
                    }}>&times;</button>
                  </span>
                {/each}
                <input
                  type="text"
                  class="w-32 px-2 py-0.5 text-xs rounded border border-border bg-background focus:outline-none focus:border-accent"
                  placeholder="Add command..."
                  onkeydown={(e) => {
                    const input = e.currentTarget as HTMLInputElement;
                    if (e.key === 'Enter' && input.value.trim()) {
                      const cmds = [...($settings.audio.voice_commands.approve_commands ?? []), input.value.trim()];
                      settings.save({ ...$settings, audio: { ...$settings.audio, voice_commands: { ...$settings.audio.voice_commands, approve_commands: cmds } } });
                      input.value = '';
                    }
                  }}
                />
              </div>
            </div>

            <!-- Reject Commands -->
            <div>
              <label class="text-xs font-medium text-text-secondary block mb-1">Reject Commands</label>
              <p class="text-[10px] text-text-muted mb-1.5">
                Say these to reject a pending approval node
              </p>
              <div class="flex flex-wrap gap-1.5">
                {#each $settings.audio.voice_commands.reject_commands ?? [] as cmd}
                  <span class="inline-flex items-center gap-1 px-2 py-0.5 bg-red-500/10 text-red-400 rounded text-xs">
                    {cmd}
                    <button class="hover:text-red-400" onclick={() => {
                      const cmds = ($settings.audio.voice_commands.reject_commands ?? []).filter(c => c !== cmd);
                      settings.save({ ...$settings, audio: { ...$settings.audio, voice_commands: { ...$settings.audio.voice_commands, reject_commands: cmds } } });
                    }}>&times;</button>
                  </span>
                {/each}
                <input
                  type="text"
                  class="w-32 px-2 py-0.5 text-xs rounded border border-border bg-background focus:outline-none focus:border-accent"
                  placeholder="Add command..."
                  onkeydown={(e) => {
                    const input = e.currentTarget as HTMLInputElement;
                    if (e.key === 'Enter' && input.value.trim()) {
                      const cmds = [...($settings.audio.voice_commands.reject_commands ?? []), input.value.trim()];
                      settings.save({ ...$settings, audio: { ...$settings.audio, voice_commands: { ...$settings.audio.voice_commands, reject_commands: cmds } } });
                      input.value = '';
                    }
                  }}
                />
              </div>
            </div>

            <!-- Prepare Commands -->
            <div>
              <label class="text-xs font-medium text-text-secondary block mb-1">Prepare Commands</label>
              <p class="text-[10px] text-text-muted mb-1.5">
                Say these to prepare a session without starting it
              </p>
              <div class="flex flex-wrap gap-1.5">
                {#each $settings.audio.voice_commands.prepare_commands ?? [] as cmd}
                  <span class="inline-flex items-center gap-1 px-2 py-0.5 bg-teal-500/10 text-teal-400 rounded text-xs">
                    {cmd}
                    <button class="hover:text-red-400" onclick={() => {
                      const cmds = ($settings.audio.voice_commands.prepare_commands ?? []).filter(c => c !== cmd);
                      settings.save({ ...$settings, audio: { ...$settings.audio, voice_commands: { ...$settings.audio.voice_commands, prepare_commands: cmds } } });
                    }}>&times;</button>
                  </span>
                {/each}
                <input
                  type="text"
                  class="w-32 px-2 py-0.5 text-xs rounded border border-border bg-background focus:outline-none focus:border-accent"
                  placeholder="Add command..."
                  onkeydown={(e) => {
                    const input = e.currentTarget as HTMLInputElement;
                    if (e.key === 'Enter' && input.value.trim()) {
                      const cmds = [...($settings.audio.voice_commands.prepare_commands ?? []), input.value.trim()];
                      settings.save({ ...$settings, audio: { ...$settings.audio, voice_commands: { ...$settings.audio.voice_commands, prepare_commands: cmds } } });
                      input.value = '';
                    }
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    {/if}
  </div>

  <!-- Open Mic Section -->
  <div class="border-t border-border pt-4 mt-4">
    <div class="flex items-center justify-between mb-3">
      <div>
        <label class="text-sm font-medium text-text-secondary">Open Mic</label>
        <p class="text-xs text-text-muted mt-0.5">
          Passively listen for wake commands to start recording hands-free
        </p>
      </div>
      <input
        type="checkbox"
        class="toggle"
        bind:checked={$settings.audio.open_mic.enabled}
        disabled={!$settings.vosk?.enabled}
      />
    </div>

    {#if !$settings.vosk?.enabled}
      <p class="text-xs text-yellow-500">
        Vosk must be enabled for open mic mode. Enable it in the Vosk tab.
      </p>
    {:else if $settings.audio.open_mic.enabled}
      <div class="space-y-3 mt-4">
        <!-- Preset Wake Commands -->
        <div>
          <label class="block text-xs font-medium text-text-muted mb-2"
            >Wake Commands</label
          >
          <div class="flex flex-wrap gap-2">
            {#each OPEN_MIC_PRESETS as command}
              <button
                type="button"
                class="px-3 py-1.5 text-sm rounded-full border transition-colors {isWakeCommandActive(
                  command
                )
                  ? 'bg-green-600 text-white border-green-600'
                  : 'bg-surface-elevated text-text-secondary border-border hover:border-green-500 hover:text-text-primary'}"
                onclick={() => toggleWakeCommand(command)}
              >
                "{command}"
              </button>
            {/each}
          </div>
        </div>

        <!-- Custom Wake Commands -->
        <div>
          <label class="block text-xs font-medium text-text-muted mb-2"
            >Custom Wake Commands</label
          >
          <div class="flex gap-2">
            <input
              type="text"
              placeholder="Add custom wake command..."
              class="flex-1 px-3 py-1.5 bg-background border border-border rounded text-sm focus:outline-none focus:border-green-500"
              bind:value={customWakeCommand}
              onkeydown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustomWakeCommand();
                }
              }}
            />
            <button
              type="button"
              class="px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700 transition-colors disabled:opacity-50"
              onclick={addCustomWakeCommand}
              disabled={!customWakeCommand.trim()}
            >
              Add
            </button>
          </div>
          {#if customWakeCommandError}
            <p class="text-xs text-red-500 mt-1">{customWakeCommandError}</p>
          {/if}

          {#if getCustomWakeCommands().length > 0}
            <div class="flex flex-wrap gap-2 mt-2">
              {#each getCustomWakeCommands() as command}
                <div
                  class="flex items-center gap-1 px-3 py-1.5 text-sm rounded-full bg-green-600 text-white"
                >
                  <span>"{command}"</span>
                  <button
                    type="button"
                    class="ml-1 hover:bg-white/20 rounded-full p-0.5 transition-colors"
                    onclick={() => removeCustomWakeCommand(command)}
                    title="Remove command"
                  >
                    <svg
                      class="w-3 h-3"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Active Wake Commands Summary -->
        {#if $settings.audio.open_mic.wake_commands.length > 0}
          <p class="text-xs text-text-muted">
            Active wake commands: {$settings.audio.open_mic.wake_commands
              .length} - Say any of these to start recording
          </p>
        {:else}
          <p class="text-xs text-yellow-500">
            No wake commands selected. Select at least one command to enable
            open mic.
          </p>
        {/if}

        <!-- Volume Threshold Slider -->
        <div class="border-t border-border/50 pt-4 mt-4">
          <label class="block text-sm font-medium text-text-secondary mb-1"
            >Volume Threshold</label
          >
          <p class="text-xs text-text-muted mb-2">
            Minimum audio level to send to Vosk. Higher values save resources but may miss quiet speech.
          </p>
          <!-- Live audio level bar -->
          <div class="relative h-6 bg-surface rounded overflow-hidden mb-2">
            <!-- Current level bar -->
            <div
              class="absolute inset-y-0 left-0"
              class:bg-green-600={isAboveThreshold}
              class:bg-gray-500={!isAboveThreshold}
              style="width: {Math.min(currentRms * 1000, 100)}%"
            ></div>
            <!-- Threshold marker -->
            <div
              class="absolute inset-y-0 w-0.5 bg-white/80"
              style="left: {$settings.audio.open_mic.volume_threshold * 1000}%"
            ></div>
            <!-- Label -->
            <div class="absolute inset-0 flex items-center justify-center text-xs text-white/80 font-medium">
              {#if currentRms > 0}
                {isAboveThreshold ? "Above threshold" : "Below threshold"}
              {:else}
                <span class="text-text-muted">Waiting for audio...</span>
              {/if}
            </div>
          </div>
          <div class="flex items-center gap-3">
            <input
              type="range"
              min="0"
              max="0.1"
              step="0.0001"
              class="flex-1 accent-green-600"
              bind:value={$settings.audio.open_mic.volume_threshold}
            />
            <span class="text-sm text-text-primary w-20 text-right font-mono"
              >{($settings.audio.open_mic.volume_threshold * 100).toFixed(2)}%</span
            >
          </div>
          <div class="flex justify-between text-xs text-text-muted mt-1">
            <span>Sensitive</span>
            <span>Conservative</span>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>
