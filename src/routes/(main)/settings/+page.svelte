<script lang="ts">
  import { settings, settingsLoaded } from "$lib/stores/settings";
  import { invoke } from "@tauri-apps/api/core";
  import { emit } from "@tauri-apps/api/event";
  import { onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { page } from "$app/stores";
  import {
    GeneralTab,
    ClaudeTab,
    CodexTab,
    ThemesTab,
    SystemTab,
    DeveloperTab,
    MicrophoneTab,
    AudioTab,
    TranscriptionTab,
    LlmTab,
    HotkeysTab,
    OverlayTab,
    McpTab,
    VoiceCommandsTab,
    SequencesTab,
    QueueTab,
    RecordingsLogTab,
    AboutTab,
  } from "$lib/components/settings";

  function normalizeTab(tab: string | null): string {
    if (tab === 'repos') return 'llm';
    // The Whisper and Real-time tabs were merged into one Transcription tab
    // ('vosk' kept as a legacy deep-link alias for the old realtime tab)
    if (tab === 'whisper' || tab === 'realtime' || tab === 'vosk') return 'transcription';
    return tab || 'claude';
  }

  // Read initial tab from URL query param (e.g. /settings?tab=llm)
  let activeTab = $state(normalizeTab($page.url.searchParams.get('tab')));

  // Update tab when URL changes
  $effect(() => {
    const tabFromUrl = $page.url.searchParams.get('tab');
    if (tabFromUrl) {
      activeTab = normalizeTab(tabFromUrl);
    }
  });

  let saveStatus: "idle" | "saving" | "error" = $state("idle");
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;
  let statusTimeout: ReturnType<typeof setTimeout> | null = null;
  let hasPendingChanges = false;

  // Immediately save settings (no debounce)
  async function saveNow() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = null;
    hasPendingChanges = false;

    saveStatus = "saving";
    try {
      await invoke("save_config", { newConfig: $settings });
      emit("settings-changed");
      saveStatus = "idle";
    } catch (error) {
      console.error("Failed to save settings:", error);
      saveStatus = "error";
      if (statusTimeout) clearTimeout(statusTimeout);
      statusTimeout = setTimeout(() => (saveStatus = "idle"), 3000);
    }
  }

  // Debounced auto-save
  async function autoSave() {
    if (saveTimeout) clearTimeout(saveTimeout);
    if (statusTimeout) clearTimeout(statusTimeout);
    hasPendingChanges = true;

    saveTimeout = setTimeout(async () => {
      hasPendingChanges = false;
      saveStatus = "saving";
      try {
        await invoke("save_config", { newConfig: $settings });
        emit("settings-changed");
        saveStatus = "idle";
      } catch (error) {
        console.error("Failed to save settings:", error);
        saveStatus = "error";
        statusTimeout = setTimeout(() => (saveStatus = "idle"), 3000);
      }
    }, 500);
  }

  // Subscribe to settings changes for auto-save.
  // Skip auto-save until settings have actually been loaded from disk,
  // otherwise reloading on /settings would show defaults and risk overwriting the real config.
  let hasReceivedLoadedSettings = false;
  const unsubscribe = settings.subscribe(() => {
    if (!hasReceivedLoadedSettings) {
      if (get(settingsLoaded)) {
        // Settings just loaded from disk - mark as ready but don't auto-save the loaded values
        hasReceivedLoadedSettings = true;
      }
      return;
    }
    autoSave();
  });

  onDestroy(() => {
    unsubscribe();
    if (hasPendingChanges) {
      saveNow();
    }
    if (saveTimeout) clearTimeout(saveTimeout);
    if (statusTimeout) clearTimeout(statusTimeout);
  });

  // Tabs that only make sense when voice/recording features are enabled.
  const VOICE_ONLY_TABS = [
    "microphone",
    "audio",
    "voice-commands",
    "transcription",
    "recordings-log",
  ];

  const tabs = $derived(
    [
      { id: "claude", label: "Claude" },
      { id: "codex", label: "Codex" },
      { id: "sessions", label: "Sessions" },
      { id: "themes", label: "Themes" },
      { id: "system", label: "System" },
      { id: "microphone", label: "Microphone" },
      { id: "audio", label: "Audio" },
      { id: "voice-commands", label: "Voice Commands" },
      { id: "transcription", label: "Transcription" },
      { id: "llm", label: "LLM" },
      { id: "queue", label: "Smart Queue" },
      { id: "mcp", label: "MCP Servers" },
      { id: "hotkeys", label: "Hotkeys" },
      { id: "overlay", label: "Overlay" },
      { id: "sequences", label: "Sequences" },
      { id: "recordings-log", label: "Recordings Log" },
      { id: "developer", label: "Developer" },
      { id: "about", label: "About" },
    ].filter(
      (tab) =>
        (!$settings.system.voice_mode_disabled ||
          !VOICE_ONLY_TABS.includes(tab.id)) &&
        // Sequences are gated entirely behind developer mode.
        (tab.id !== "sequences" || $settings.system.dev_mode) &&
        // Disabled providers (onboarding choice) hide their settings tab.
        (tab.id !== "claude" || ($settings.enabled_providers?.claude ?? true)) &&
        (tab.id !== "codex" || ($settings.enabled_providers?.openai ?? true))
    )
  );

  // If the active tab was hidden (voice tab while no-voice mode is on, or a
  // hidden ?tab= value), fall back to the first available tab.
  $effect(() => {
    if (!tabs.some((tab) => tab.id === activeTab)) {
      activeTab = tabs[0]?.id ?? "claude";
    }
  });
</script>

<div class="settings-panel flex-1 flex flex-col overflow-hidden">
  <div class="flex flex-1 overflow-hidden">
    <nav
      class="w-40 border-r border-border bg-surface-elevated p-2 overflow-y-auto"
    >
      {#each tabs as tab}
        <button
          class="w-full px-3 py-2 text-left text-sm rounded transition-colors"
          class:bg-accent={activeTab === tab.id}
          class:text-white={activeTab === tab.id}
          class:text-text-secondary={activeTab !== tab.id}
          class:hover:bg-border={activeTab !== tab.id}
          onclick={() => (activeTab = tab.id)}
        >
          {tab.label}
        </button>
      {/each}
    </nav>

    <div class="flex-1 p-4 overflow-y-auto">
      {#if activeTab === "sessions"}
        <GeneralTab />
      {:else if activeTab === "claude"}
        <ClaudeTab />
      {:else if activeTab === "codex"}
        <CodexTab />
      {:else if activeTab === "themes"}
        <ThemesTab />
      {:else if activeTab === "system"}
        <SystemTab />
      {:else if activeTab === "microphone"}
        <MicrophoneTab />
      {:else if activeTab === "audio"}
        <AudioTab />
      {:else if activeTab === "voice-commands"}
        <VoiceCommandsTab />
      {:else if activeTab === "transcription"}
        <TranscriptionTab />
      {:else if activeTab === "llm"}
        <LlmTab />
      {:else if activeTab === "queue"}
        <QueueTab />
      {:else if activeTab === "mcp"}
        <McpTab />
      {:else if activeTab === "hotkeys"}
        <HotkeysTab />
      {:else if activeTab === "overlay"}
        <OverlayTab />
      {:else if activeTab === "sequences"}
        <SequencesTab />
      {:else if activeTab === "recordings-log"}
        <RecordingsLogTab />
      {:else if activeTab === "developer"}
        <DeveloperTab />
      {:else if activeTab === "about"}
        <AboutTab />
      {/if}
    </div>
  </div>

  {#if saveStatus !== "idle"}
    <footer
      class="flex justify-end items-center gap-2 px-4 py-2 border-t border-border"
    >
      {#if saveStatus === "saving"}
        <div
          class="w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin"
        ></div>
        <span class="text-xs text-text-muted">Saving...</span>
      {:else if saveStatus === "error"}
        <svg
          class="w-3 h-3 text-error"
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
        <span class="text-xs text-error">Failed to save</span>
      {/if}
    </footer>
  {/if}
</div>
