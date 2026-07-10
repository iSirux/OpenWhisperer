<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import { invoke } from "@tauri-apps/api/core";
  import { onMount } from "svelte";

  interface ConnectionTestResult {
    health_ok: boolean;
    health_error: string | null;
    transcription_ok: boolean;
    transcription_error: string | null;
  }

  let audioDevices: MediaDeviceInfo[] = $state([]);
  let loadingDevices = $state(false);
  let testingWhisper = $state(false);
  let whisperStatus: "idle" | "testing" | "success" | "partial" | "error" =
    $state("idle");
  let whisperTestResult: ConnectionTestResult | null = $state(null);

  onMount(async () => {
    // Load audio devices and test whisper connection on mount
    await Promise.all([loadAudioDevices(), testWhisperConnection()]);
  });

  async function loadAudioDevices() {
    loadingDevices = true;
    try {
      // Request permission first to get device labels
      await navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          stream.getTracks().forEach((track) => track.stop());
        });
      const devices = await navigator.mediaDevices.enumerateDevices();
      audioDevices = devices.filter((d) => d.kind === "audioinput");
    } catch (error) {
      console.error("Failed to enumerate audio devices:", error);
    }
    loadingDevices = false;
  }

  async function testWhisperConnection() {
    testingWhisper = true;
    whisperStatus = "testing";
    whisperTestResult = null;
    try {
      const result =
        await invoke<ConnectionTestResult>("test_whisper_connection");
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

  async function saveDeviceSelection() {
    try {
      await invoke("save_config", { newConfig: $settings });
    } catch (error) {
      console.error("Failed to save settings:", error);
    }
  }

  function openWhisperSettings() {
    window.dispatchEvent(
      new CustomEvent("open-settings", { detail: { tab: "transcription" } })
    );
  }

  function openAudioSettings() {
    window.dispatchEvent(
      new CustomEvent("open-settings", { detail: { tab: "audio" } })
    );
  }
</script>

<div class="start-panel flex flex-col h-full">
  <div class="flex-1 flex items-center justify-center p-8 overflow-y-auto">
    <div class="max-w-lg w-full space-y-8">
      <div class="text-center">
        <h2 class="text-2xl font-bold text-text-primary mb-2">Welcome</h2>
      </div>

      <!-- Microphone Selection -->
      <div
        class="bg-surface-elevated border border-border rounded-lg p-6 overflow-hidden"
      >
        <div class="flex items-center gap-3 mb-4">
          <div class="p-2 bg-accent/10 rounded-lg">
            <svg
              class="w-6 h-6 text-accent"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
              />
            </svg>
          </div>
          <div>
            <h3 class="text-lg font-medium text-text-primary">Microphone</h3>
            <p class="text-sm text-text-muted">Select your recording device</p>
          </div>
        </div>

        <div class="flex gap-2">
          <select
            class="flex-1 min-w-0 px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
            bind:value={$settings.audio.device_id}
            onchange={saveDeviceSelection}
            disabled={loadingDevices}
          >
            <option value={null}>System Default</option>
            {#each audioDevices as device}
              <option value={device.deviceId}
                >{device.label ||
                  `Microphone ${device.deviceId.slice(0, 8)}`}</option
              >
            {/each}
          </select>
          <div class="flex gap-2 flex-shrink-0">
            <button
              class="px-3 py-2 bg-surface hover:bg-border rounded text-sm transition-colors flex items-center gap-2"
              onclick={loadAudioDevices}
              disabled={loadingDevices}
            >
              {#if loadingDevices}
                <div
                  class="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin"
                ></div>
              {:else}
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
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
              {/if}
            </button>
            <button
              class="px-3 py-2 bg-surface hover:bg-border rounded transition-colors"
              onclick={openAudioSettings}
              title="Audio Settings"
            >
              <svg
                class="w-5 h-5 text-text-secondary"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
            </button>
          </div>
        </div>

        {#if audioDevices.length === 0 && !loadingDevices}
          <p class="text-xs text-text-muted mt-2">
            No microphones found. Please connect a microphone and click Refresh.
          </p>
        {/if}
      </div>

      <!-- Whisper Connection Status -->
      <div class="bg-surface-elevated border border-border rounded-lg p-6">
        <div class="flex items-center gap-3 mb-4">
          <div
            class="p-2 rounded-lg {whisperStatus === 'success'
              ? 'bg-success/10'
              : whisperStatus === 'partial'
                ? 'bg-warning/10'
                : whisperStatus === 'error'
                  ? 'bg-error/10'
                  : 'bg-accent/10'}"
          >
            {#if whisperStatus === "success"}
              <svg
                class="w-6 h-6 text-success"
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
            {:else if whisperStatus === "partial"}
              <svg
                class="w-6 h-6 text-warning"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            {:else if whisperStatus === "error"}
              <svg
                class="w-6 h-6 text-error"
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
            {:else}
              <svg
                class="w-6 h-6 text-accent"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"
                />
              </svg>
            {/if}
          </div>
          <div class="flex-1">
            <h3 class="text-lg font-medium text-text-primary">
              Whisper Connection
            </h3>
            <p class="text-sm text-text-muted">
              {#if whisperStatus === "testing"}
                Testing connection...
              {:else if whisperStatus === "success"}
                Connected and ready
              {:else if whisperStatus === "partial"}
                Partially connected
              {:else if whisperStatus === "error"}
                Cannot connect to Whisper server
              {:else}
                Check your Whisper API connection
              {/if}
            </p>
          </div>
        </div>

        <!-- Detailed test results -->
        {#if whisperTestResult}
          <div class="mb-4 space-y-2">
            <div class="flex items-center gap-2 text-sm">
              <div
                class="w-2 h-2 rounded-full {whisperTestResult.health_ok
                  ? 'bg-success'
                  : 'bg-error'}"
              ></div>
              <span class="text-text-secondary">Health Check</span>
              <span class="text-text-muted">
                {whisperTestResult.health_ok
                  ? "OK"
                  : whisperTestResult.health_error || "Failed"}
              </span>
            </div>
            <div class="flex items-center gap-2 text-sm">
              <div
                class="w-2 h-2 rounded-full {whisperTestResult.transcription_ok
                  ? 'bg-success'
                  : 'bg-error'}"
              ></div>
              <span class="text-text-secondary">Transcription</span>
              <span class="text-text-muted">
                {whisperTestResult.transcription_ok
                  ? "OK"
                  : whisperTestResult.transcription_error || "Failed"}
              </span>
            </div>
          </div>
        {/if}

        <div class="flex items-center gap-2">
          <button
            class="px-4 py-2 bg-surface hover:bg-border rounded text-sm transition-colors flex items-center gap-2"
            onclick={testWhisperConnection}
            disabled={testingWhisper}
          >
            {#if testingWhisper}
              <div
                class="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin"
              ></div>
              Testing...
            {:else}
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
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              Test Connection
            {/if}
          </button>
          <button
            class="px-3 py-2 bg-surface hover:bg-border rounded transition-colors"
            onclick={openWhisperSettings}
            title="Whisper Settings"
          >
            <svg
              class="w-5 h-5 text-text-secondary"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </button>
        </div>

        {#if whisperStatus === "error"}
          <div
            class="mt-4 p-3 bg-error/10 border border-error/20 rounded text-sm"
          >
            <p class="text-error font-medium mb-1">
              Whisper server not available
            </p>
            <p class="text-text-secondary text-xs">
              Make sure your Whisper server is running at <code
                class="px-1 py-0.5 bg-background rounded"
                >{$settings.whisper.endpoint}</code
              >
            </p>
          </div>
        {/if}
      </div>

      <!-- Quick Status Summary -->
      <div class="flex items-center justify-center gap-6 text-sm">
        <div class="flex items-center gap-2">
          <div
            class="w-2 h-2 rounded-full"
            class:bg-success={audioDevices.length > 0}
            class:bg-error={audioDevices.length === 0}
          ></div>
          <span class="text-text-muted">Microphone</span>
        </div>
        <div class="flex items-center gap-2">
          <div
            class="w-2 h-2 rounded-full"
            class:bg-success={whisperStatus === "success"}
            class:bg-error={whisperStatus === "error"}
            class:bg-text-muted={whisperStatus === "idle" ||
              whisperStatus === "testing"}
          ></div>
          <span class="text-text-muted">Whisper</span>
        </div>
      </div>
    </div>
  </div>
</div>
