<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import { invoke } from "@tauri-apps/api/core";
  import { onDestroy } from "svelte";
  import {
    GeneralTab,
    ClaudeTab,
    CodexTab,
    ThemesTab,
    SystemTab,
    MicrophoneTab,
    AudioTab,
    WhisperTab,
    VoskTab,
    LlmTab,
    GitTab,
    HotkeysTab,
    OverlayTab,
    ReposTab,
    McpTab,
  } from "$lib/components/settings";

  // Accept an initial tab from parent component
  interface Props {
    initialTab?: string;
  }
  let { initialTab = "claude" }: Props = $props();

  let activeTab = $state(initialTab);

  // Update active tab when initialTab prop changes
  $effect(() => {
    activeTab = initialTab;
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
        saveStatus = "idle";
      } catch (error) {
        console.error("Failed to save settings:", error);
        saveStatus = "error";
        statusTimeout = setTimeout(() => (saveStatus = "idle"), 3000);
      }
    }, 500);
  }

  // Subscribe to settings changes for auto-save
  let isInitialLoad = true;
  const unsubscribe = settings.subscribe(() => {
    if (isInitialLoad) {
      isInitialLoad = false;
      return;
    }
    autoSave();
  });

  onDestroy(() => {
    unsubscribe();
    // Flush any pending save immediately instead of cancelling it
    if (hasPendingChanges) {
      // Use synchronous save to ensure it completes before unmount
      // Note: We can't await in onDestroy, so we fire-and-forget
      saveNow();
    }
    if (saveTimeout) clearTimeout(saveTimeout);
    if (statusTimeout) clearTimeout(statusTimeout);
  });

  const tabs = [
    { id: "claude", label: "Claude" },
    { id: "codex", label: "Codex" },
    { id: "sessions", label: "Sessions" },
    { id: "themes", label: "Themes" },
    { id: "system", label: "System" },
    { id: "microphone", label: "Microphone" },
    { id: "audio", label: "Audio" },
    { id: "whisper", label: "Transcription (Whisper)" },
    { id: "vosk", label: "Real-time Transcription (Vosk)" },
    { id: "llm", label: "LLM" },
    { id: "mcp", label: "MCP Servers" },
    { id: "git", label: "Git" },
    { id: "hotkeys", label: "Hotkeys" },
    { id: "overlay", label: "Overlay" },
    { id: "repos", label: "Repositories" },
  ];
</script>

<div class="settings-panel flex flex-col h-full">
  <header
    class="flex items-center justify-between px-4 py-3 border-b border-border"
  >
    <div class="flex items-center gap-3">
      <button
        class="p-1.5 hover:bg-surface-elevated rounded transition-colors text-text-muted hover:text-text-primary"
        onclick={() => window.dispatchEvent(new CustomEvent("close-settings"))}
        title="Back to sessions"
      >
        <svg
          class="w-5 h-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M10 19l-7-7m0 0l7-7m-7 7h18"
          />
        </svg>
      </button>
      <h2 class="text-lg font-semibold text-text-primary">Settings</h2>
    </div>
  </header>

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
      {:else if activeTab === "whisper"}
        <WhisperTab />
      {:else if activeTab === "vosk"}
        <VoskTab />
      {:else if activeTab === "llm"}
        <LlmTab />
      {:else if activeTab === "mcp"}
        <McpTab />
      {:else if activeTab === "git"}
        <GitTab />
      {:else if activeTab === "hotkeys"}
        <HotkeysTab />
      {:else if activeTab === "overlay"}
        <OverlayTab />
      {:else if activeTab === "repos"}
        <ReposTab />
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
