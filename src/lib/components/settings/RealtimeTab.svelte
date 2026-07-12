<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import { invoke } from "@tauri-apps/api/core";
  import "./toggle.css";

  interface RealtimeConnectionTestResult {
    connected: boolean;
    error: string | null;
  }

  let testing = $state(false);
  let testStatus: "idle" | "success" | "error" = $state("idle");
  let testResult: RealtimeConnectionTestResult | null = $state(null);
  let buildError: string | null = $state(null);

  /**
   * One-click setup for the bundled images (sherpa-onnx / moonshine): the
   * backend writes the embedded Docker build context plus a setup script to
   * disk, then opens a terminal window running the script (remove old
   * container, docker build, docker run) so progress is visible.
   */
  async function buildAndStartContainer(
    provider: string,
    image: string,
    runCommand: string,
    containerName?: string
  ) {
    buildError = null;
    try {
      await invoke("run_docker_setup", {
        provider,
        image,
        containerName: containerName || "",
        runCommand,
      });
    } catch (e) {
      buildError = String(e);
      console.error("Failed to build/start container:", e);
    }
  }

  async function testConnection() {
    testing = true;
    testStatus = "idle";
    testResult = null;
    try {
      const result = await invoke<RealtimeConnectionTestResult>(
        "test_realtime_connection"
      );
      testResult = result;
      testStatus = result.connected ? "success" : "error";
    } catch (error) {
      testStatus = "error";
      testResult = {
        connected: false,
        error: String(error),
      };
    }
    testing = false;
  }
</script>

<div class="space-y-4">
  <div class="p-3 bg-surface rounded-lg border border-border/50">
    <p class="text-sm text-text-secondary">
      <strong>Real-time transcription</strong> shows live text in the overlay as you speak.
      It runs alongside Whisper (which provides the final accurate transcription).
    </p>
    <ul class="mt-2 text-sm text-text-muted list-disc list-inside">
      <li><strong>Vosk</strong> — Lightweight, low latency, CPU-friendly (Kaldi-based)</li>
      <li><strong>VoiceStreamAI</strong> — Higher accuracy, uses faster-whisper (GPU recommended)</li>
      <li><strong>Speaches</strong> — Ready Docker images + OpenAI-compatible realtime API</li>
      <li><strong>Sherpa-ONNX</strong> — Fast streaming ASR with permissive licensing (Apache-2.0)</li>
      <li><strong>Moonshine v2</strong> — Streaming-native, Whisper-level accuracy on CPU (English)</li>
    </ul>
  </div>

  <!-- Enable toggle -->
  <div class="flex items-center justify-between">
    <span class="text-sm text-text-secondary"
      >Enable real-time transcription</span
    >
    <input
      type="checkbox"
      class="toggle"
      bind:checked={$settings.realtime.enabled}
    />
  </div>

  {#if $settings.realtime.enabled}
    <!-- Provider Selection -->
    <div>
      <label class="block text-sm font-medium text-text-secondary mb-1"
        >Provider</label
      >
      <select
        class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
        bind:value={$settings.realtime.provider}
        onchange={(e) => {
          const value = (e.target as HTMLSelectElement).value;
          settings.update((s) => ({
            ...s,
            realtime: {
              ...s.realtime,
              provider: value as "Vosk" | "VoiceStreamAI" | "SherpaOnnx" | "Speaches" | "Moonshine",
            },
          }));
        }}
      >
        <option value="Moonshine">Moonshine v2 (recommended — streaming, Whisper-level accuracy)</option>
        <option value="Vosk">Vosk (lightweight, low latency)</option>
        <option value="VoiceStreamAI">VoiceStreamAI (faster-whisper, higher accuracy)</option>
        <option value="Speaches">Speaches (docker-ready realtime API)</option>
        <option value="SherpaOnnx">Sherpa-ONNX (streaming, Apache-2.0)</option>
      </select>
    </div>

    {#if $settings.realtime.provider === "Vosk"}
      <!-- ═══ Vosk-specific configuration ═══ -->

      <!-- WebSocket Endpoint -->
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1"
          >WebSocket Endpoint</label
        >
        <input
          type="text"
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
          bind:value={$settings.realtime.endpoint}
          placeholder="ws://localhost:2700"
        />
        <p class="text-xs text-text-muted mt-1">
          Default Vosk server uses port 2700
        </p>
      </div>

      <!-- Sample Rate -->
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1"
          >Sample Rate</label
        >
        <select
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
          bind:value={$settings.realtime.sample_rate}
        >
          <option value={8000}>8000 Hz (telephony)</option>
          <option value={16000}>16000 Hz (recommended)</option>
          <option value={44100}>44100 Hz (CD quality)</option>
          <option value={48000}>48000 Hz (professional)</option>
        </select>
        <p class="text-xs text-text-muted mt-1">
          Must match the Vosk model's expected sample rate (usually 16kHz)
        </p>
      </div>
    {:else if $settings.realtime.provider === "VoiceStreamAI"}
      <!-- ═══ VoiceStreamAI-specific configuration ═══ -->

      <!-- WebSocket Endpoint -->
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1"
          >WebSocket Endpoint</label
        >
        <input
          type="text"
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
          bind:value={$settings.realtime.voice_stream_ai.endpoint}
          placeholder="ws://localhost:8765"
        />
        <p class="text-xs text-text-muted mt-1">
          Default VoiceStreamAI server uses port 8765
        </p>
      </div>

      <!-- Sample Rate -->
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1"
          >Sample Rate</label
        >
        <select
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
          bind:value={$settings.realtime.voice_stream_ai.sample_rate}
        >
          <option value={8000}>8000 Hz</option>
          <option value={16000}>16000 Hz (recommended)</option>
          <option value={44100}>44100 Hz</option>
          <option value={48000}>48000 Hz</option>
        </select>
      </div>

      <!-- Chunk Length -->
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1"
          >Chunk Length (seconds)</label
        >
        <input
          type="number"
          step="0.5"
          min="1"
          max="30"
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
          bind:value={$settings.realtime.voice_stream_ai.chunk_length_seconds}
        />
        <p class="text-xs text-text-muted mt-1">
          Duration of audio chunks sent for processing (lower = more responsive, higher = more accurate)
        </p>
      </div>

      <!-- Chunk Offset -->
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1"
          >Silence Offset (seconds)</label
        >
        <input
          type="number"
          step="0.1"
          min="0"
          max="5"
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
          bind:value={$settings.realtime.voice_stream_ai.chunk_offset_seconds}
        />
        <p class="text-xs text-text-muted mt-1">
          Silence duration before a chunk is processed
        </p>
      </div>

      <!-- Language -->
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1"
          >Language</label
        >
        <select
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
          bind:value={$settings.realtime.voice_stream_ai.language}
        >
          <option value="multilanguage">Auto-detect (multilingual)</option>
          <option value="en">English</option>
          <option value="es">Spanish</option>
          <option value="fr">French</option>
          <option value="de">German</option>
          <option value="it">Italian</option>
          <option value="pt">Portuguese</option>
          <option value="nl">Dutch</option>
          <option value="ja">Japanese</option>
          <option value="ko">Korean</option>
          <option value="zh">Chinese</option>
          <option value="ru">Russian</option>
          <option value="ar">Arabic</option>
        </select>
      </div>
    {:else if $settings.realtime.provider === "Speaches"}
      <!-- ═══ Speaches-specific configuration ═══ -->

      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1"
          >WebSocket Endpoint</label
        >
        <input
          type="text"
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
          bind:value={$settings.realtime.speaches.endpoint}
          placeholder="ws://localhost:2701/v1/realtime"
        />
        <p class="text-xs text-text-muted mt-1">
          Speaches realtime endpoint (port 2701; query params are added automatically)
        </p>
      </div>

      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1"
          >Model</label
        >
        <select
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
          bind:value={$settings.realtime.speaches.model}
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
      </div>

      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1"
          >Sample Rate</label
        >
        <select
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
          bind:value={$settings.realtime.speaches.sample_rate}
        >
          <option value={8000}>8000 Hz</option>
          <option value={16000}>16000 Hz (recommended)</option>
          <option value={44100}>44100 Hz</option>
          <option value={48000}>48000 Hz</option>
        </select>
      </div>

      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1"
          >API Key (optional)</label
        >
        <input
          type="password"
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
          bind:value={$settings.realtime.speaches.api_key}
          placeholder="Only if your Speaches server requires auth"
        />
      </div>
    {:else if $settings.realtime.provider === "SherpaOnnx"}
      <!-- ═══ sherpa-onnx-specific configuration ═══ -->

      <!-- WebSocket Endpoint -->
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1"
          >WebSocket Endpoint</label
        >
        <input
          type="text"
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
          bind:value={$settings.realtime.sherpa_onnx.endpoint}
          placeholder="ws://localhost:6006"
        />
        <p class="text-xs text-text-muted mt-1">
          Default sherpa-onnx online WebSocket server commonly uses port 6006
        </p>
      </div>

      <!-- Sample Rate -->
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1"
          >Sample Rate</label
        >
        <select
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
          bind:value={$settings.realtime.sherpa_onnx.sample_rate}
        >
          <option value={8000}>8000 Hz</option>
          <option value={16000}>16000 Hz (recommended)</option>
          <option value={44100}>44100 Hz</option>
          <option value={48000}>48000 Hz</option>
        </select>
      </div>
    {:else if $settings.realtime.provider === "Moonshine"}
      <!-- ═══ Moonshine-specific configuration ═══ -->

      <!-- WebSocket Endpoint -->
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1"
          >WebSocket Endpoint</label
        >
        <input
          type="text"
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
          bind:value={$settings.realtime.moonshine.endpoint}
          placeholder="ws://localhost:2702"
        />
        <p class="text-xs text-text-muted mt-1">
          The bundled Moonshine server listens on port 2702 (2700 = Vosk, 2701 = Speaches)
        </p>
      </div>

      <!-- Sample Rate -->
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1"
          >Sample Rate</label
        >
        <select
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
          bind:value={$settings.realtime.moonshine.sample_rate}
        >
          <option value={16000}>16000 Hz (recommended)</option>
          <option value={44100}>44100 Hz</option>
          <option value={48000}>48000 Hz</option>
        </select>
      </div>
    {/if}

    <!-- ═══ Shared settings (both providers) ═══ -->

    <!-- Show in overlay toggle -->
    <div class="flex items-center justify-between">
      <span class="text-sm text-text-secondary"
        >Show real-time transcript in overlay</span
      >
      <input
        type="checkbox"
        class="toggle"
        bind:checked={$settings.realtime.show_realtime_transcript}
      />
    </div>

    <!-- Accumulate transcript toggle -->
    <div class="flex items-center justify-between">
      <div>
        <span class="text-sm text-text-secondary"
          >Accumulate text across pauses</span
        >
        <p class="text-xs text-text-muted mt-1">
          When enabled, text accumulates as you speak with pauses. When
          disabled, the transcript resets after each pause.
        </p>
      </div>
      <input
        type="checkbox"
        class="toggle"
        bind:checked={$settings.realtime.accumulate_transcript}
      />
    </div>

    <!-- Connection test -->
    <div class="pt-4 border-t border-border/50">
      <button
        class="px-4 py-2 bg-accent text-white text-sm rounded hover:bg-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
        onclick={testConnection}
        disabled={testing}
      >
        {testing ? "Testing..." : "Test Connection"}
      </button>
      {#if testStatus === "success"}
        <span class="ml-2 text-success text-sm"
          >Connected successfully!</span
        >
      {:else if testStatus === "error" && testResult}
        <span class="ml-2 text-error text-sm"
          >{testResult.error || "Connection failed"}</span
        >
      {/if}
    </div>

    <!-- ═══ Docker Setup (provider-specific) ═══ -->
    {#if $settings.realtime.provider === "Vosk"}
      {@const dockerCommand = (() => {
        const parts = ["docker run -d"];
        if ($settings.realtime.docker.auto_restart) {
          parts.push("--restart unless-stopped");
        }
        parts.push("-p 2700:2700");
        if ($settings.realtime.docker.container_name) {
          parts.push(`--name ${$settings.realtime.docker.container_name}`);
        }
        parts.push("alphacep/kaldi-en:latest");
        return parts.join(" ");
      })()}
      <div class="border-t border-border pt-4 mt-4">
        <label class="block text-sm font-medium text-text-secondary mb-3"
          >Docker Setup (Vosk)</label
        >

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
            checked={$settings.realtime.docker.auto_restart}
            onchange={(e) => {
              const checked = (e.target as HTMLInputElement).checked;
              settings.update((s) => ({
                ...s,
                realtime: {
                  ...s.realtime,
                  docker: { ...s.realtime.docker, auto_restart: checked },
                },
              }));
            }}
          />
        </div>

        <!-- Container Name -->
        <div class="mb-4">
          <label class="block text-xs font-medium text-text-muted mb-2"
            >Container Name</label
          >
          <input
            type="text"
            class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent font-mono"
            value={$settings.realtime.docker.container_name}
            oninput={(e) => {
              const value = (e.target as HTMLInputElement).value;
              settings.update((s) => ({
                ...s,
                realtime: {
                  ...s.realtime,
                  docker: { ...s.realtime.docker, container_name: value },
                },
              }));
            }}
            placeholder="open-whisperer-vosk"
          />
        </div>

        <!-- Generated Command -->
        <div class="mb-3">
          <label class="block text-xs font-medium text-text-muted mb-2"
            >Docker Command</label
          >
          <div class="relative group">
            <pre
              class="p-3 bg-background border border-border rounded text-xs font-mono text-text-secondary overflow-x-auto whitespace-pre-wrap">{dockerCommand}</pre>
            <button
              class="absolute top-2 right-2 p-1.5 bg-surface-elevated hover:bg-border rounded text-text-muted hover:text-text-primary transition-colors opacity-0 group-hover:opacity-100"
              onclick={async () => {
                await navigator.clipboard.writeText(
                  dockerCommand.replace(/\s*\\\n\s*/g, " ")
                );
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
              const singleLine = dockerCommand.replace(/\s*\\\n\s*/g, " ");
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

        <p class="text-xs text-text-muted">
          Other language models: <code class="bg-surface px-1 rounded"
            >kaldi-cn</code
          >, <code class="bg-surface px-1 rounded">kaldi-ru</code>,
          <code class="bg-surface px-1 rounded">kaldi-fr</code>,
          <code class="bg-surface px-1 rounded">kaldi-de</code>
        </p>
      </div>
    {:else if $settings.realtime.provider === "VoiceStreamAI"}
      {@const dockerCommand = (() => {
        const parts = ["docker run -d"];
        if ($settings.realtime.voice_stream_ai.docker.auto_restart) {
          parts.push("--restart unless-stopped");
        }
        parts.push("-p 8765:8765");
        if ($settings.realtime.voice_stream_ai.docker.compute_type === "GPU") {
          parts.push("--gpus all");
        }
        if ($settings.realtime.voice_stream_ai.docker.container_name) {
          parts.push(`--name ${$settings.realtime.voice_stream_ai.docker.container_name}`);
        }
        parts.push("voicestreamai");
        return parts.join(" ");
      })()}
      <div class="border-t border-border pt-4 mt-4">
        <label class="block text-sm font-medium text-text-secondary mb-3"
          >Docker Setup (VoiceStreamAI)</label
        >

        <!-- Compute Type -->
        <div class="flex items-center justify-between mb-4">
          <div>
            <label class="text-sm font-medium text-text-secondary"
              >GPU Acceleration</label
            >
            <p class="text-xs text-text-muted">
              Use NVIDIA GPU for faster transcription (requires nvidia-docker)
            </p>
          </div>
          <select
            class="px-3 py-1.5 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
            value={$settings.realtime.voice_stream_ai.docker.compute_type}
            onchange={(e) => {
              const value = (e.target as HTMLSelectElement).value;
              settings.update((s) => ({
                ...s,
                realtime: {
                  ...s.realtime,
                  voice_stream_ai: {
                    ...s.realtime.voice_stream_ai,
                    docker: { ...s.realtime.voice_stream_ai.docker, compute_type: value as "CPU" | "GPU" },
                  },
                },
              }));
            }}
          >
            <option value="CPU">CPU</option>
            <option value="GPU">GPU (CUDA)</option>
          </select>
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
            checked={$settings.realtime.voice_stream_ai.docker.auto_restart}
            onchange={(e) => {
              const checked = (e.target as HTMLInputElement).checked;
              settings.update((s) => ({
                ...s,
                realtime: {
                  ...s.realtime,
                  voice_stream_ai: {
                    ...s.realtime.voice_stream_ai,
                    docker: { ...s.realtime.voice_stream_ai.docker, auto_restart: checked },
                  },
                },
              }));
            }}
          />
        </div>

        <!-- Container Name -->
        <div class="mb-4">
          <label class="block text-xs font-medium text-text-muted mb-2"
            >Container Name</label
          >
          <input
            type="text"
            class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent font-mono"
            value={$settings.realtime.voice_stream_ai.docker.container_name}
            oninput={(e) => {
              const value = (e.target as HTMLInputElement).value;
              settings.update((s) => ({
                ...s,
                realtime: {
                  ...s.realtime,
                  voice_stream_ai: {
                    ...s.realtime.voice_stream_ai,
                    docker: { ...s.realtime.voice_stream_ai.docker, container_name: value },
                  },
                },
              }));
            }}
            placeholder="open-whisperer-voicestreamai"
          />
        </div>

        <!-- Generated Command -->
        <div class="mb-3">
          <label class="block text-xs font-medium text-text-muted mb-2"
            >Docker Command</label
          >
          <div class="relative group">
            <pre
              class="p-3 bg-background border border-border rounded text-xs font-mono text-text-secondary overflow-x-auto whitespace-pre-wrap">{dockerCommand}</pre>
            <button
              class="absolute top-2 right-2 p-1.5 bg-surface-elevated hover:bg-border rounded text-text-muted hover:text-text-primary transition-colors opacity-0 group-hover:opacity-100"
              onclick={async () => {
                await navigator.clipboard.writeText(
                  dockerCommand.replace(/\s*\\\n\s*/g, " ")
                );
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
              const singleLine = dockerCommand.replace(/\s*\\\n\s*/g, " ");
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

        <p class="text-xs text-text-muted">
          Build with: <code class="bg-surface px-1 rounded">docker build -t voicestreamai .</code>
          from the <a href="https://github.com/alesaccoia/VoiceStreamAI" target="_blank" class="text-accent hover:underline">VoiceStreamAI repo</a>
        </p>
      </div>
    {:else if $settings.realtime.provider === "Speaches"}
      {@const dockerCommand = (() => {
        const parts = ["docker run -d"];
        if ($settings.realtime.speaches.docker.auto_restart) {
          parts.push("--restart unless-stopped");
        }
        parts.push("-p 2701:8000");
        if ($settings.realtime.speaches.docker.compute_type === "GPU") {
          parts.push("--gpus all");
        }
        if ($settings.realtime.speaches.docker.container_name) {
          parts.push(`--name ${$settings.realtime.speaches.docker.container_name}`);
        }
        // Required for realtime path so internal calls resolve to the local API server.
        parts.push("-e LOOPBACK_HOST_URL=http://localhost:8000");
        parts.push(
          $settings.realtime.speaches.docker.compute_type === "GPU"
            ? "ghcr.io/speaches-ai/speaches:latest-cuda"
            : "ghcr.io/speaches-ai/speaches:latest-cpu"
        );
        return parts.join(" ");
      })()}
      {@const speachesBaseUrl = (() => {
        try {
          const url = new URL($settings.realtime.speaches.endpoint);
          const protocol = url.protocol === "wss:" ? "https:" : "http:";
          return `${protocol}//${url.host}`;
        } catch {
          return "http://localhost:2701";
        }
      })()}
      {@const encodedModelId = encodeURIComponent($settings.realtime.speaches.model)}
      {@const installModelCommand = `curl -X POST "${speachesBaseUrl}/v1/models/${encodedModelId}"`}
      {@const listModelsCommand = `curl "${speachesBaseUrl}/v1/models"`}
      {@const listRegistryAsrCommand = `curl "${speachesBaseUrl}/v1/registry?task=automatic-speech-recognition"`}
      <div class="border-t border-border pt-4 mt-4">
        <label class="block text-sm font-medium text-text-secondary mb-3"
          >Docker Setup (Speaches)</label
        >

        <div class="mb-4">
          <label class="block text-xs font-medium text-text-muted mb-2"
            >Compute Type</label
          >
          <div class="flex gap-2">
            <button
              class="flex-1 px-3 py-2 text-sm rounded border-2 transition-all flex items-center justify-center gap-2 {$settings
                .realtime.speaches.docker.compute_type === 'CPU'
                ? 'border-accent bg-accent/10'
                : 'border-border'}"
              onclick={() =>
                settings.update((s) => ({
                  ...s,
                  realtime: {
                    ...s.realtime,
                    speaches: {
                      ...s.realtime.speaches,
                      docker: { ...s.realtime.speaches.docker, compute_type: "CPU" },
                    },
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
                .realtime.speaches.docker.compute_type === 'GPU'
                ? 'border-accent bg-accent/10'
                : 'border-border'}"
              onclick={() =>
                settings.update((s) => ({
                  ...s,
                  realtime: {
                    ...s.realtime,
                    speaches: {
                      ...s.realtime.speaches,
                      docker: { ...s.realtime.speaches.docker, compute_type: "GPU" },
                    },
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
            {#if $settings.realtime.speaches.docker.compute_type === "CPU"}
              Good for laptops and systems without NVIDIA GPUs. Slower but
              works everywhere.
            {:else}
              Requires NVIDIA GPU with CUDA. Much faster transcription for
              desktops.
            {/if}
          </p>
        </div>

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
            checked={$settings.realtime.speaches.docker.auto_restart}
            onchange={(e) => {
              const checked = (e.target as HTMLInputElement).checked;
              settings.update((s) => ({
                ...s,
                realtime: {
                  ...s.realtime,
                  speaches: {
                    ...s.realtime.speaches,
                    docker: { ...s.realtime.speaches.docker, auto_restart: checked },
                  },
                },
              }));
            }}
          />
        </div>

        <div class="mb-4">
          <label class="block text-xs font-medium text-text-muted mb-2"
            >Container Name</label
          >
          <input
            type="text"
            class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent font-mono"
            value={$settings.realtime.speaches.docker.container_name}
            oninput={(e) => {
              const value = (e.target as HTMLInputElement).value;
              settings.update((s) => ({
                ...s,
                realtime: {
                  ...s.realtime,
                  speaches: {
                    ...s.realtime.speaches,
                    docker: { ...s.realtime.speaches.docker, container_name: value },
                  },
                },
              }));
            }}
            placeholder="open-whisperer-speaches"
          />
        </div>

        <div class="mb-3">
          <label class="block text-xs font-medium text-text-muted mb-2"
            >Docker Command</label
          >
          <div class="relative group">
            <pre
              class="p-3 bg-background border border-border rounded text-xs font-mono text-text-secondary overflow-x-auto whitespace-pre-wrap">{dockerCommand}</pre>
            <button
              class="absolute top-2 right-2 p-1.5 bg-surface-elevated hover:bg-border rounded text-text-muted hover:text-text-primary transition-colors opacity-0 group-hover:opacity-100"
              onclick={async () => {
                await navigator.clipboard.writeText(
                  dockerCommand.replace(/\s*\\\n\s*/g, " ")
                );
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
              const singleLine = dockerCommand.replace(/\s*\\\n\s*/g, " ");
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

        <div class="mb-3 border border-border rounded p-3 bg-surface/40">
          <label class="block text-xs font-medium text-text-muted mb-2"
            >Model Installation (Optional but recommended)</label
          >
          <p class="text-xs text-text-muted mb-2">
            Pre-install the selected model to avoid first-use download latency.
          </p>

          <label class="block text-xs font-medium text-text-muted mb-1"
            >Install Selected Model</label
          >
          <div class="relative group mb-2">
            <pre
              class="p-2 bg-background border border-border rounded text-xs font-mono text-text-secondary overflow-x-auto whitespace-pre-wrap">{installModelCommand}</pre>
            <button
              class="absolute top-1.5 right-1.5 p-1 bg-surface-elevated hover:bg-border rounded text-text-muted hover:text-text-primary transition-colors opacity-0 group-hover:opacity-100"
              onclick={async () => {
                await navigator.clipboard.writeText(installModelCommand);
              }}
              title="Copy to clipboard"
            >
              <svg
                class="w-3.5 h-3.5"
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
            class="mb-3 px-3 py-1.5 text-sm bg-accent hover:bg-accent/80 text-white rounded transition-colors flex items-center gap-2"
            onclick={async () => {
              try {
                await invoke("run_in_terminal", { command: installModelCommand });
              } catch (e) {
                console.error("Failed to run in terminal:", e);
              }
            }}
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Install Model
          </button>

          <label class="block text-xs font-medium text-text-muted mb-1"
            >List Installed Models</label
          >
          <div class="relative group mb-2">
            <pre
              class="p-2 bg-background border border-border rounded text-xs font-mono text-text-secondary overflow-x-auto whitespace-pre-wrap">{listModelsCommand}</pre>
            <button
              class="absolute top-1.5 right-1.5 p-1 bg-surface-elevated hover:bg-border rounded text-text-muted hover:text-text-primary transition-colors opacity-0 group-hover:opacity-100"
              onclick={async () => {
                await navigator.clipboard.writeText(listModelsCommand);
              }}
              title="Copy to clipboard"
            >
              <svg
                class="w-3.5 h-3.5"
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
            class="px-3 py-1.5 text-sm bg-surface-elevated hover:bg-border text-text-secondary rounded transition-colors flex items-center gap-2"
            onclick={async () => {
              try {
                await invoke("run_in_terminal", { command: listModelsCommand });
              } catch (e) {
                console.error("Failed to run in terminal:", e);
              }
            }}
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            List Models
          </button>

          <label class="block text-xs font-medium text-text-muted mt-3 mb-1"
            >List Available Registry Models</label
          >
          <div class="relative group mb-2">
            <pre
              class="p-2 bg-background border border-border rounded text-xs font-mono text-text-secondary overflow-x-auto whitespace-pre-wrap">{listRegistryAsrCommand}</pre>
            <button
              class="absolute top-1.5 right-1.5 p-1 bg-surface-elevated hover:bg-border rounded text-text-muted hover:text-text-primary transition-colors opacity-0 group-hover:opacity-100"
              onclick={async () => {
                await navigator.clipboard.writeText(listRegistryAsrCommand);
              }}
              title="Copy to clipboard"
            >
              <svg
                class="w-3.5 h-3.5"
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
        </div>

        <p class="text-xs text-text-muted">
          Official images: <code class="bg-surface px-1 rounded">ghcr.io/speaches-ai/speaches:latest-cpu</code>
          and <code class="bg-surface px-1 rounded">ghcr.io/speaches-ai/speaches:latest-cuda</code>
        </p>
      </div>
    {:else if $settings.realtime.provider === "SherpaOnnx"}
      {@const dockerCommand = (() => {
        const parts = ["docker run -d"];
        if ($settings.realtime.sherpa_onnx.docker.auto_restart) {
          parts.push("--restart unless-stopped");
        }
        parts.push("-p 6006:6006");
        if ($settings.realtime.sherpa_onnx.docker.compute_type === "GPU") {
          parts.push("--gpus all");
        }
        if ($settings.realtime.sherpa_onnx.docker.container_name) {
          parts.push(`--name ${$settings.realtime.sherpa_onnx.docker.container_name}`);
        }
        parts.push("open-whisperer-sherpa-onnx");
        return parts.join(" ");
      })()}
      <div class="border-t border-border pt-4 mt-4">
        <label class="block text-sm font-medium text-text-secondary mb-3"
          >Docker Setup (Sherpa-ONNX)</label
        >

        <div class="flex items-center justify-between mb-4">
          <div>
            <label class="text-sm font-medium text-text-secondary"
              >GPU Acceleration</label
            >
            <p class="text-xs text-text-muted">
              Optional: use NVIDIA GPU if your sherpa image supports CUDA
            </p>
          </div>
          <select
            class="px-3 py-1.5 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
            value={$settings.realtime.sherpa_onnx.docker.compute_type}
            onchange={(e) => {
              const value = (e.target as HTMLSelectElement).value;
              settings.update((s) => ({
                ...s,
                realtime: {
                  ...s.realtime,
                  sherpa_onnx: {
                    ...s.realtime.sherpa_onnx,
                    docker: { ...s.realtime.sherpa_onnx.docker, compute_type: value as "CPU" | "GPU" },
                  },
                },
              }));
            }}
          >
            <option value="CPU">CPU</option>
            <option value="GPU">GPU (CUDA)</option>
          </select>
        </div>

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
            checked={$settings.realtime.sherpa_onnx.docker.auto_restart}
            onchange={(e) => {
              const checked = (e.target as HTMLInputElement).checked;
              settings.update((s) => ({
                ...s,
                realtime: {
                  ...s.realtime,
                  sherpa_onnx: {
                    ...s.realtime.sherpa_onnx,
                    docker: { ...s.realtime.sherpa_onnx.docker, auto_restart: checked },
                  },
                },
              }));
            }}
          />
        </div>

        <div class="mb-4">
          <label class="block text-xs font-medium text-text-muted mb-2"
            >Container Name</label
          >
          <input
            type="text"
            class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent font-mono"
            value={$settings.realtime.sherpa_onnx.docker.container_name}
            oninput={(e) => {
              const value = (e.target as HTMLInputElement).value;
              settings.update((s) => ({
                ...s,
                realtime: {
                  ...s.realtime,
                  sherpa_onnx: {
                    ...s.realtime.sherpa_onnx,
                    docker: { ...s.realtime.sherpa_onnx.docker, container_name: value },
                  },
                },
              }));
            }}
            placeholder="open-whisperer-sherpa-onnx"
          />
        </div>

        <div class="mb-3">
          <label class="block text-xs font-medium text-text-muted mb-2"
            >Docker Command</label
          >
          <div class="relative group">
            <pre
              class="p-3 bg-background border border-border rounded text-xs font-mono text-text-secondary overflow-x-auto whitespace-pre-wrap">{dockerCommand}</pre>
            <button
              class="absolute top-2 right-2 p-1.5 bg-surface-elevated hover:bg-border rounded text-text-muted hover:text-text-primary transition-colors opacity-0 group-hover:opacity-100"
              onclick={async () => {
                await navigator.clipboard.writeText(
                  dockerCommand.replace(/\s*\\\n\s*/g, " ")
                );
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
              const singleLine = dockerCommand.replace(/\s*\\\n\s*/g, " ");
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

        <button
          class="px-4 py-2 bg-accent text-white text-sm rounded hover:bg-accent/80 transition-colors"
          onclick={() =>
            buildAndStartContainer(
              "sherpa-onnx",
              "open-whisperer-sherpa-onnx",
              dockerCommand,
              $settings.realtime.sherpa_onnx.docker.container_name
            )}
        >
          Build &amp; Start Container
        </button>
        {#if buildError}
          <p class="text-xs text-error mt-2">{buildError}</p>
        {/if}
        <p class="text-xs text-text-muted mt-2">
          One click: writes the bundled build context to disk, then opens a terminal that builds
          the image (downloads the streaming Zipformer model on first build) and starts the
          container. Requires Docker Desktop to be running. CPU-only — streaming Zipformer runs
          faster than real time on CPU.
        </p>
      </div>
    {:else if $settings.realtime.provider === "Moonshine"}
      {@const dockerCommand = (() => {
        const parts = ["docker run -d"];
        if ($settings.realtime.moonshine.docker.auto_restart) {
          parts.push("--restart unless-stopped");
        }
        parts.push("-p 2702:2702");
        if ($settings.realtime.moonshine.docker.container_name) {
          parts.push(`--name ${$settings.realtime.moonshine.docker.container_name}`);
        }
        parts.push("open-whisperer-moonshine");
        return parts.join(" ");
      })()}
      <div class="border-t border-border pt-4 mt-4">
        <label class="block text-sm font-medium text-text-secondary mb-3"
          >Docker Setup (Moonshine)</label
        >

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
            checked={$settings.realtime.moonshine.docker.auto_restart}
            onchange={(e) => {
              const checked = (e.target as HTMLInputElement).checked;
              settings.update((s) => ({
                ...s,
                realtime: {
                  ...s.realtime,
                  moonshine: {
                    ...s.realtime.moonshine,
                    docker: { ...s.realtime.moonshine.docker, auto_restart: checked },
                  },
                },
              }));
            }}
          />
        </div>

        <div class="mb-4">
          <label class="block text-xs font-medium text-text-muted mb-2"
            >Container Name</label
          >
          <input
            type="text"
            class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent font-mono"
            value={$settings.realtime.moonshine.docker.container_name}
            oninput={(e) => {
              const value = (e.target as HTMLInputElement).value;
              settings.update((s) => ({
                ...s,
                realtime: {
                  ...s.realtime,
                  moonshine: {
                    ...s.realtime.moonshine,
                    docker: { ...s.realtime.moonshine.docker, container_name: value },
                  },
                },
              }));
            }}
            placeholder="open-whisperer-moonshine"
          />
        </div>

        <div class="mb-3">
          <label class="block text-xs font-medium text-text-muted mb-2"
            >Docker Command</label
          >
          <pre
            class="p-3 bg-background border border-border rounded text-xs font-mono text-text-secondary overflow-x-auto whitespace-pre-wrap">{dockerCommand}</pre>
        </div>

        <button
          class="px-4 py-2 bg-accent text-white text-sm rounded hover:bg-accent/80 transition-colors"
          onclick={() =>
            buildAndStartContainer(
              "moonshine",
              "open-whisperer-moonshine",
              dockerCommand,
              $settings.realtime.moonshine.docker.container_name
            )}
        >
          Build &amp; Start Container
        </button>
        {#if buildError}
          <p class="text-xs text-error mt-2">{buildError}</p>
        {/if}
        <p class="text-xs text-text-muted mt-2">
          One click: writes the bundled build context to disk, then opens a terminal that builds
          the image (downloads the Moonshine model on first build) and starts the container.
          Requires Docker Desktop to be running. CPU-only by design — Moonshine v2 streams faster
          than real time on CPU. English only.
        </p>
      </div>
    {/if}
  {/if}
</div>
