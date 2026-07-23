<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import { invoke } from "@tauri-apps/api/core";
  import "./toggle.css";
  // toggle.css is imported for the transcription notice toggle

  interface ConnectionTestResult {
    health_ok: boolean;
    health_error: string | null;
    transcription_ok: boolean;
    transcription_error: string | null;
  }

  const isWindows = navigator.userAgent.includes("Windows");

  let testingWhisper = $state(false);
  let whisperStatus: "idle" | "success" | "partial" | "error" = $state("idle");
  let whisperTestResult: ConnectionTestResult | null = $state(null);

  async function testWhisperConnection() {
    testingWhisper = true;
    whisperStatus = "idle";
    whisperTestResult = null;
    try {
      const result = await invoke<ConnectionTestResult>(
        "test_whisper_connection"
      );
      whisperTestResult = result;
      if (result.health_ok && result.transcription_ok) {
        whisperStatus = "success";
      } else if (result.health_ok || result.transcription_ok) {
        whisperStatus = "partial";
      } else {
        whisperStatus = "error";
      }
    } catch {
      whisperStatus = "error";
    }
    testingWhisper = false;
  }
</script>

<div class="space-y-4">
  <!-- Provider Selection -->
  <div>
    <label class="block text-sm font-medium text-text-secondary mb-1"
      >Provider</label
    >
    <select
      class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
      bind:value={$settings.whisper.provider}
      onchange={(e) => {
        const provider = (e.target as HTMLSelectElement).value;
        // Apply provider presets
        if (provider === "Local") {
          $settings.whisper.endpoint =
            "http://localhost:8000/v1/audio/transcriptions";
          $settings.whisper.model =
            "dropbox-dash/faster-whisper-large-v3-turbo";
          $settings.whisper.api_key = null;
        } else if (provider === "OpenAI") {
          $settings.whisper.endpoint =
            "https://api.openai.com/v1/audio/transcriptions";
          $settings.whisper.model = "gpt-4o-mini-transcribe";
        } else if (provider === "Groq") {
          $settings.whisper.endpoint =
            "https://api.groq.com/openai/v1/audio/transcriptions";
          $settings.whisper.model = "whisper-large-v3-turbo";
        }
      }}
    >
      <option value="Local">Local (faster-whisper-server)</option>
      <option value="OpenAI">OpenAI</option>
      <option value="Groq">Groq (free tier available)</option>
      <option value="Custom">Custom OpenAI-compatible</option>
    </select>
    <p class="text-xs text-text-muted mt-1">
      {#if $settings.whisper.provider === "Local"}
        Run your own Whisper server locally using Docker
      {:else if $settings.whisper.provider === "OpenAI"}
        Official OpenAI Whisper API - <a
          href="https://platform.openai.com/api-keys"
          class="text-accent hover:underline"
          target="_blank"
          rel="noopener noreferrer">Get API key</a
        >
      {:else if $settings.whisper.provider === "Groq"}
        Fast inference with free tier - <a
          href="https://console.groq.com/keys"
          class="text-accent hover:underline"
          target="_blank"
          rel="noopener noreferrer">Get API key</a
        >
      {:else}
        Any OpenAI-compatible transcription endpoint
      {/if}
    </p>
  </div>

  <!-- API Key (only for non-Local providers) -->
  {#if $settings.whisper.provider !== "Local"}
    <div>
      <label class="block text-sm font-medium text-text-secondary mb-1"
        >API Key</label
      >
      <input
        type="password"
        class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent font-mono"
        bind:value={$settings.whisper.api_key}
        placeholder="sk-..."
      />
    </div>
  {/if}

  <div>
    <label class="block text-sm font-medium text-text-secondary mb-1"
      >Endpoint</label
    >
    <input
      type="text"
      class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
      bind:value={$settings.whisper.endpoint}
      placeholder="http://localhost:8000/v1/audio/transcriptions"
    />
  </div>

  <div>
    <label class="block text-sm font-medium text-text-secondary mb-1"
      >Model</label
    >
    {#if $settings.whisper.provider === "Local"}
      <select
        class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
        bind:value={$settings.whisper.model}
      >
        <optgroup label="Standard Models">
          <option value="Systran/faster-whisper-tiny"
            >tiny (39M) - Fastest</option
          >
          <option value="Systran/faster-whisper-tiny.en"
            >tiny.en (39M) - English only</option
          >
          <option value="Systran/faster-whisper-base"
            >base (74M) - Very fast</option
          >
          <option value="Systran/faster-whisper-base.en"
            >base.en (74M) - English only</option
          >
          <option value="Systran/faster-whisper-small"
            >small (244M) - Fast</option
          >
          <option value="Systran/faster-whisper-small.en"
            >small.en (244M) - English only</option
          >
          <option value="Systran/faster-whisper-medium"
            >medium (769M) - Moderate</option
          >
          <option value="Systran/faster-whisper-medium.en"
            >medium.en (769M) - English only</option
          >
        </optgroup>
        <optgroup label="Large Models">
          <option value="Systran/faster-whisper-large-v1"
            >large-v1 (1550M) - Legacy</option
          >
          <option value="Systran/faster-whisper-large-v2"
            >large-v2 (1550M) - Production</option
          >
          <option value="Systran/faster-whisper-large-v3"
            >large-v3 (1550M) - Best accuracy</option
          >
          <option value="dropbox-dash/faster-whisper-large-v3-turbo"
            >large-v3-turbo (809M) - Recommended</option
          >
        </optgroup>
        <optgroup label="Distil Models (English only)">
          <option value="Systran/faster-distil-whisper-small.en"
            >distil-small.en (~166M) - Very fast</option
          >
          <option value="Systran/faster-distil-whisper-medium.en"
            >distil-medium.en (~394M) - Fast, English only</option
          >
          <option value="Systran/faster-distil-whisper-large-v2"
            >distil-large-v2 (~756M) - 6x faster</option
          >
          <option value="Systran/faster-distil-whisper-large-v3"
            >distil-large-v3 (~756M) - Best distilled</option
          >
        </optgroup>
      </select>
    {:else if $settings.whisper.provider === "OpenAI"}
      <select
        class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
        bind:value={$settings.whisper.model}
      >
        <option value="gpt-4o-mini-transcribe"
          >gpt-4o-mini-transcribe (recommended, cheapest)</option
        >
        <option value="gpt-4o-transcribe"
          >gpt-4o-transcribe (best accuracy)</option
        >
        <option value="whisper-1">whisper-1 (legacy)</option>
      </select>
    {:else if $settings.whisper.provider === "Groq"}
      <select
        class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
        bind:value={$settings.whisper.model}
      >
        <option value="whisper-large-v3-turbo"
          >whisper-large-v3-turbo (recommended)</option
        >
        <option value="whisper-large-v3">whisper-large-v3</option>
        <option value="distil-whisper-large-v3-en"
          >distil-whisper-large-v3-en (English only)</option
        >
      </select>
    {:else}
      <input
        type="text"
        class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
        bind:value={$settings.whisper.model}
        placeholder="whisper-1"
      />
    {/if}
  </div>

  <div>
    <label class="block text-sm font-medium text-text-secondary mb-1"
      >Language</label
    >
    <input
      type="text"
      class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
      bind:value={$settings.whisper.language}
      placeholder="en"
    />
  </div>

  <button
    class="px-4 py-2 bg-surface-elevated hover:bg-border rounded text-sm transition-colors flex items-center gap-2"
    onclick={testWhisperConnection}
    disabled={testingWhisper}
  >
    {#if testingWhisper}
      <div
        class="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin"
      ></div>
      Testing...
    {:else}
      Test Connection
    {/if}
  </button>
  {#if whisperStatus === "success"}
    <p class="text-sm text-success">Connection successful!</p>
  {:else if whisperStatus === "partial"}
    <p class="text-sm text-warning">
      Partial connection (transcription may still work)
    </p>
  {:else if whisperStatus === "error"}
    <p class="text-sm text-error">
      Connection failed. Check your endpoint and API key.
    </p>
  {/if}

  {#if whisperTestResult}
    <div class="space-y-1 text-xs">
      <div class="flex items-center gap-2">
        <div
          class="w-2 h-2 rounded-full {whisperTestResult.health_ok
            ? 'bg-success'
            : 'bg-warning'}"
        ></div>
        <span class="text-text-secondary">Health:</span>
        <span class="text-text-muted"
          >{whisperTestResult.health_ok
            ? "OK"
            : whisperTestResult.health_error ||
              "N/A (some providers don't expose health endpoint)"}</span
        >
      </div>
      <div class="flex items-center gap-2">
        <div
          class="w-2 h-2 rounded-full {whisperTestResult.transcription_ok
            ? 'bg-success'
            : 'bg-error'}"
        ></div>
        <span class="text-text-secondary">Transcription:</span>
        <span class="text-text-muted"
          >{whisperTestResult.transcription_ok
            ? "OK"
            : whisperTestResult.transcription_error || "Failed"}</span
        >
      </div>
    </div>
  {/if}

  <!-- Docker Setup (only for Local provider) -->
  {#if $settings.whisper.provider === "Local"}
    {@const dockerCommand = (() => {
      const parts = ["docker run -d"];

      // Auto-restart option
      if ($settings.whisper.docker.auto_restart) {
        parts.push("--restart unless-stopped");
      }

      // Container name
      if ($settings.whisper.docker.container_name) {
        parts.push(`--name ${$settings.whisper.docker.container_name}`);
      }

      // GPU flag for CUDA
      if ($settings.whisper.docker.compute_type === "GPU") {
        parts.push("--gpus all");
      }

      // Port mapping and volume
      parts.push("-p 8000:8000");
      parts.push(
        isWindows
          ? "-v %USERPROFILE%\\.cache\\huggingface:/root/.cache/huggingface"
          : "-v ~/.cache/huggingface:/root/.cache/huggingface"
      );

      // Image tag based on compute type
      const imageTag =
        $settings.whisper.docker.compute_type === "GPU"
          ? "latest-cuda"
          : "latest-cpu";
      parts.push(`fedirz/faster-whisper-server:${imageTag}`);

      return parts.join(" ");
    })()}
    <div class="border-t border-border pt-4 mt-4">
      <label class="block text-sm font-medium text-text-secondary mb-3"
        >Docker Setup</label
      >

      <!-- Compute Type Selection -->
      <div class="mb-4">
        <label class="block text-xs font-medium text-text-muted mb-2"
          >Compute Type</label
        >
        <div class="flex gap-2">
          <button
            class="flex-1 px-3 py-2 text-sm rounded border-2 transition-all flex items-center justify-center gap-2 {$settings
              .whisper.docker.compute_type === 'CPU'
              ? 'border-accent bg-accent/10'
              : 'border-border'}"
            onclick={() =>
              settings.update((s) => ({
                ...s,
                whisper: {
                  ...s.whisper,
                  docker: { ...s.whisper.docker, compute_type: "CPU" },
                },
              }))}
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
                d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
              />
            </svg>
            <span class="font-medium">CPU</span>
          </button>
          <button
            class="flex-1 px-3 py-2 text-sm rounded border-2 transition-all flex items-center justify-center gap-2 {$settings
              .whisper.docker.compute_type === 'GPU'
              ? 'border-accent bg-accent/10'
              : 'border-border'}"
            onclick={() =>
              settings.update((s) => ({
                ...s,
                whisper: {
                  ...s.whisper,
                  docker: { ...s.whisper.docker, compute_type: "GPU" },
                },
              }))}
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
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
            <span class="font-medium">GPU</span>
          </button>
        </div>
        <p class="text-xs text-text-muted mt-1.5">
          {#if $settings.whisper.docker.compute_type === "CPU"}
            Good for laptops and systems without NVIDIA GPUs. Slower but
            works everywhere.
          {:else}
            Requires NVIDIA GPU with CUDA. Much faster transcription for
            desktops.
          {/if}
        </p>
      </div>

      <!-- Auto-restart Option -->
      <div class="flex items-center justify-between mb-4">
        <div>
          <label class="text-sm font-medium text-text-secondary"
            >Auto-start with Docker</label
          >
          <p class="text-xs text-text-muted">
            Container starts automatically when Docker Engine starts
          </p>
        </div>
        <input
          type="checkbox"
          class="toggle"
          checked={$settings.whisper.docker.auto_restart}
          onchange={(e) => {
            const checked = (e.target as HTMLInputElement).checked;
            settings.update((s) => ({
              ...s,
              whisper: {
                ...s.whisper,
                docker: { ...s.whisper.docker, auto_restart: checked },
              },
            }));
          }}
        />
      </div>

      <!-- Container Name -->
      <div class="mb-4">
        <label class="block text-xs font-medium text-text-muted mb-1"
          >Container Name</label
        >
        <input
          type="text"
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent font-mono"
          value={$settings.whisper.docker.container_name}
          oninput={(e) => {
            const value = (e.target as HTMLInputElement).value;
            settings.update((s) => ({
              ...s,
              whisper: {
                ...s.whisper,
                docker: { ...s.whisper.docker, container_name: value },
              },
            }));
          }}
          placeholder="whisper"
        />
      </div>

      <!-- Generated Command -->
      <div>
        <label class="block text-xs font-medium text-text-muted mb-2"
          >Docker Command</label
        >
        <div class="relative group">
          <pre
            class="p-3 bg-background border border-border rounded text-xs font-mono text-text-primary overflow-x-auto whitespace-pre-wrap break-all">{dockerCommand}</pre>
          <button
            class="absolute top-2 right-2 p-1.5 bg-surface-elevated hover:bg-border rounded text-text-muted hover:text-text-primary transition-colors opacity-0 group-hover:opacity-100"
            onclick={async () => {
              // Copy as single line for easy pasting
              const singleLine = dockerCommand.replace(/ \\\n  /g, " ");
              await navigator.clipboard.writeText(singleLine);
            }}
            title="Copy to clipboard"
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
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          </button>
        </div>
        <button
          class="mt-2 px-3 py-1.5 text-sm bg-accent hover:bg-accent/80 text-white rounded transition-colors flex items-center gap-2"
          onclick={async () => {
            const singleLine = dockerCommand.replace(/ \\\n  /g, " ");
            try {
              await invoke("run_in_terminal", { command: singleLine });
            } catch (e) {
              console.error("Failed to run in terminal:", e);
            }
          }}
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Run in Terminal
        </button>
      </div>
    </div>
  {/if}

  <!-- Transcription Notice -->
  <div class="border-t border-border pt-4 mt-4">
    <div class="flex items-center justify-between">
      <div>
        <label class="text-sm font-medium text-text-secondary"
          >Include Transcription Notice</label
        >
        <p class="text-xs text-text-muted mt-0.5">
          Tell the AI the prompt was voice-transcribed and may contain
          minor errors
        </p>
      </div>
      <input
        type="checkbox"
        class="toggle"
        bind:checked={$settings.audio.include_transcription_notice}
      />
    </div>
  </div>
</div>
