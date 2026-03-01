<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { getVersion } from "@tauri-apps/api/app";
  import { onMount } from "svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";

  let appVersion = $state("...");
  let configPath = $state("");
  let configDir = $state("");
  let openingFolder = $state(false);
  let openingFile = $state(false);
  let copySuccess = $state(false);

  onMount(async () => {
    try {
      appVersion = await getVersion();
    } catch {
      appVersion = "0.11.0";
    }

    try {
      const [file, dir] = await invoke<[string, string]>("get_config_paths");
      configPath = file;
      configDir = dir;
    } catch (e) {
      console.error("Failed to get config paths:", e);
    }
  });

  async function openFolder() {
    openingFolder = true;
    try {
      await invoke("open_config_folder");
    } catch (e) {
      console.error("Failed to open config folder:", e);
    } finally {
      openingFolder = false;
    }
  }

  async function openFile() {
    openingFile = true;
    try {
      await invoke("open_config_file");
    } catch (e) {
      console.error("Failed to open config file:", e);
    } finally {
      openingFile = false;
    }
  }

  async function openGitHub() {
    try {
      await openUrl("https://github.com/iSirux/ClaudeWhisperer");
    } catch (e) {
      console.error("Failed to open GitHub:", e);
    }
  }

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(configDir);
      copySuccess = true;
      setTimeout(() => (copySuccess = false), 2000);
    } catch {
      // fallback
    }
  }
</script>

<div class="space-y-6">
  <!-- App identity -->
  <div class="border-b border-border pb-6">
    <div class="flex items-center gap-4 mb-4">
      <img
        src="/icon.png"
        alt="Claude Whisperer"
        class="w-14 h-14 rounded-xl"
      />
      <div>
        <h2 class="text-xl font-semibold text-text">Claude Whisperer</h2>
        <p class="text-sm text-text-muted">Version {appVersion}</p>
      </div>
    </div>
    <p class="text-sm text-text-secondary leading-relaxed">
      A voice-controlled desktop interface for Claude Code. Record voice prompts
      via hotkeys, transcribe with Whisper, and send directly to Claude via PTY
      terminal or the Claude Agent SDK.
    </p>
  </div>

  <!-- Links -->
  <div class="border-b border-border pb-6">
    <h3 class="text-sm font-medium text-text-secondary mb-3">Links</h3>
    <div class="space-y-2">
      <button
        onclick={openGitHub}
        class="flex items-center gap-3 w-full px-3 py-2.5 bg-background border border-border rounded hover:border-accent hover:bg-accent/5 transition-colors group text-left"
      >
        <svg
          class="w-4 h-4 text-text-muted group-hover:text-accent flex-shrink-0"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path
            d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"
          />
        </svg>
        <div>
          <p class="text-sm font-medium text-text group-hover:text-accent">
            GitHub Repository
          </p>
          <p class="text-xs text-text-muted">
            github.com/iSirux/ClaudeWhisperer
          </p>
        </div>
        <svg
          class="w-3.5 h-3.5 text-text-muted ml-auto group-hover:text-accent"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
          />
        </svg>
      </button>
    </div>
  </div>

  <!-- Config location -->
  <div class="border-b border-border pb-6">
    <h3 class="text-sm font-medium text-text-secondary mb-3">
      Settings Storage
    </h3>
    <p class="text-xs text-text-muted mb-3">
      Your settings are stored locally on disk. You can open the folder to back
      them up, share them, or edit the raw JSON file directly.
    </p>

    {#if configDir}
      <div
        class="flex items-center gap-2 mb-3 px-3 py-2 bg-background border border-border rounded font-mono text-xs text-text-muted break-all"
      >
        <span class="flex-1 truncate" title={configDir}>{configDir}</span>
        <button
          onclick={copyPath}
          title="Copy path"
          class="flex-shrink-0 p-1 rounded hover:bg-border transition-colors"
        >
          {#if copySuccess}
            <svg
              class="w-3.5 h-3.5 text-success"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M5 13l4 4L19 7"
              />
            </svg>
          {:else}
            <svg
              class="w-3.5 h-3.5 text-text-muted hover:text-text"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          {/if}
        </button>
      </div>
    {/if}

    <div class="flex gap-2">
      <button
        onclick={openFolder}
        disabled={openingFolder}
        class="flex items-center gap-2 px-3 py-2 bg-accent text-white rounded text-sm hover:bg-accent/90 transition-colors disabled:opacity-50"
      >
        <svg
          class="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M3 7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
          />
        </svg>
        {openingFolder ? "Opening..." : "Open Settings Folder"}
      </button>

      <button
        onclick={openFile}
        disabled={openingFile}
        class="flex items-center gap-2 px-3 py-2 bg-background border border-border rounded text-sm text-text-secondary hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
      >
        <svg
          class="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
          />
        </svg>
        {openingFile ? "Opening..." : "Edit config.json"}
      </button>
    </div>
  </div>

  <!-- Built with -->
  <div>
    <h3 class="text-sm font-medium text-text-secondary mb-3">Built With</h3>
    <div class="grid grid-cols-2 gap-2 text-xs text-text-muted">
      <div class="flex items-center gap-2">
        <span class="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0"></span>
        Tauri v2 (Rust)
      </div>
      <div class="flex items-center gap-2">
        <span class="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0"></span>
        SvelteKit + Svelte 5
      </div>
      <div class="flex items-center gap-2">
        <span class="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0"></span>
        Claude Agent SDK
      </div>
      <div class="flex items-center gap-2">
        <span class="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0"></span>
        Whisper / Vosk ASR
      </div>
      <div class="flex items-center gap-2">
        <span class="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0"></span>
        xterm.js
      </div>
      <div class="flex items-center gap-2">
        <span class="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0"></span>
        TailwindCSS 4
      </div>
    </div>
  </div>
</div>
