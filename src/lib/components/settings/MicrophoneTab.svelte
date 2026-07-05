<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import { onMount } from "svelte";
  import "./toggle.css";

  let audioDevices: MediaDeviceInfo[] = $state([]);
  let loadingDevices = $state(false);

  onMount(() => {
    loadAudioDevices();
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
</script>

<div class="space-y-4">
  <div>
    <label class="block text-sm font-medium text-text-secondary mb-1"
      >Microphone</label
    >
    <p class="text-xs text-text-muted mb-2">
      Select the microphone to use for voice recording
    </p>
    <div class="flex gap-2">
      <select
        class="flex-1 px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
        bind:value={$settings.audio.device_id}
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
      <button
        class="px-3 py-2 bg-surface-elevated hover:bg-border rounded text-sm transition-colors"
        onclick={loadAudioDevices}
        disabled={loadingDevices}
      >
        {#if loadingDevices}
          <div
            class="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin"
          ></div>
        {:else}
          Refresh
        {/if}
      </button>
    </div>
  </div>

  <div class="border-t border-border pt-4 mt-4">
    <h3 class="text-sm font-medium text-text-primary mb-3">Recording Behavior</h3>

    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <label class="text-sm font-medium text-text-secondary"
            >Use Hotkey</label
          >
          <p class="text-xs text-text-muted mt-0.5">
            Enable global hotkey for recording (configure in Hotkeys tab)
          </p>
        </div>
        <input
          type="checkbox"
          class="toggle"
          bind:checked={$settings.audio.use_hotkey}
        />
      </div>

      <div class="flex items-center justify-between">
        <div>
          <label class="text-sm font-medium text-text-secondary"
            >Hold Space for Inline Recording</label
          >
          <p class="text-xs text-text-muted mt-0.5">
            While an SDK session is open and OpenWhisperer is focused, hold Space to record into the prompt and transcribe on release
          </p>
        </div>
        <input
          type="checkbox"
          class="toggle"
          bind:checked={$settings.audio.hold_space_to_record_inline}
        />
      </div>

      <div class="flex items-center justify-between">
        <div>
          <label class="text-sm font-medium text-text-secondary"
            >Require Transcription Approval</label
          >
          <p class="text-xs text-text-muted mt-0.5">
            Review and approve transcriptions before sending
          </p>
        </div>
        <input
          type="checkbox"
          class="toggle"
          bind:checked={$settings.audio.require_transcription_approval}
        />
      </div>

      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1"
          >Recording Linger Time</label
        >
        <p class="text-xs text-text-muted mb-2">
          Delay before stopping recording to prevent audio cutoff (0 to
          disable)
        </p>
        <div class="flex items-center gap-3">
          <input
            type="range"
            min="0"
            max="1000"
            step="50"
            class="flex-1 accent-accent"
            bind:value={$settings.audio.recording_linger_ms}
          />
          <span class="text-sm text-text-primary w-16 text-right"
            >{$settings.audio.recording_linger_ms}ms</span
          >
        </div>
      </div>
    </div>
  </div>
</div>
