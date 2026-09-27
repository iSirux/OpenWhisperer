<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { settings } from "$lib/stores/settings";
  import { meetingConfig, meetingConsentAcknowledged } from "$lib/stores/meetings";
  import "./toggle.css";

  // Older backends may not send `meeting` yet — seed it so the bindings work.
  $effect(() => {
    if (!$settings.meeting) {
      $settings.meeting = meetingConfig();
    }
  });

  let inputDevices = $state<string[]>([]);
  let devicesError = $state<string | null>(null);
  let audioProcesses = $state<{ pid: number; name: string }[] | null>(null);
  let processesLoading = $state(false);
  let processesError = $state<string | null>(null);
  let newProcessName = $state("");

  async function loadDevices() {
    devicesError = null;
    try {
      inputDevices = await invoke<string[]>("meeting_list_input_devices");
    } catch (error) {
      devicesError = String(error);
      inputDevices = [];
    }
  }

  $effect(() => {
    void loadDevices();
  });

  async function loadProcesses() {
    processesLoading = true;
    processesError = null;
    try {
      const list = await invoke<{ pid: number; name: string }[]>("meeting_list_audio_processes");
      // One entry per executable name
      const seen = new Set<string>();
      audioProcesses = list.filter((p) => {
        const key = p.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } catch (error) {
      processesError = String(error);
      audioProcesses = [];
    } finally {
      processesLoading = false;
    }
  }

  function addProcess(name: string) {
    const trimmed = name.trim();
    if (!trimmed || !$settings.meeting) return;
    const exists = $settings.meeting.system_process_names.some(
      (n) => n.toLowerCase() === trimmed.toLowerCase()
    );
    if (!exists) {
      $settings.meeting.system_process_names = [...$settings.meeting.system_process_names, trimmed];
    }
  }

  function removeProcess(name: string) {
    if (!$settings.meeting) return;
    $settings.meeting.system_process_names = $settings.meeting.system_process_names.filter(
      (n) => n !== name
    );
  }

  const PROVIDERS: { value: string; label: string; modelHint: string }[] = [
    { value: "", label: "Same as dictation (Transcription tab)", modelHint: "" },
    { value: "Local", label: "Local Whisper (Docker)", modelHint: "dropbox-dash/faster-whisper-large-v3-turbo" },
    { value: "OpenAI", label: "OpenAI", modelHint: "gpt-4o-mini-transcribe" },
    { value: "Groq", label: "Groq", modelHint: "whisper-large-v3-turbo" },
    { value: "OpenRouter", label: "OpenRouter", modelHint: "microsoft/mai-transcribe-2" },
    { value: "Custom", label: "Custom endpoint", modelHint: "" },
  ];

  const providerValue = $derived($settings.meeting?.transcription_provider ?? "");
  const modelHint = $derived(PROVIDERS.find((p) => p.value === providerValue)?.modelHint ?? "");

  const PRESET_ENDPOINTS: Record<string, string> = {
    Local: "http://localhost:8000/v1/audio/transcriptions",
    OpenAI: "https://api.openai.com/v1/audio/transcriptions",
    Groq: "https://api.groq.com/openai/v1/audio/transcriptions",
    OpenRouter: "https://openrouter.ai/api/v1/audio/transcriptions",
  };

  const sameAsDictation = $derived(!!providerValue && providerValue === $settings.whisper?.provider);
  const keyPlaceholder = $derived(
    sameAsDictation
      ? "Empty = reuse the dictation key"
      : providerValue === "OpenRouter"
        ? "sk-or-… (empty = OpenRouter key from Settings → LLM)"
        : providerValue === "Local"
          ? "Not needed for a local server"
          : "Required for this provider"
  );
  const endpointPlaceholder = $derived(
    sameAsDictation
      ? "Empty = the dictation endpoint"
      : PRESET_ENDPOINTS[providerValue] ?? "Required, e.g. http://host:8000/v1/audio/transcriptions"
  );

  function setProvider(value: string) {
    if (!$settings.meeting) return;
    const changed = value !== providerValue;
    $settings.meeting.transcription_provider = (value || null) as typeof $settings.meeting.transcription_provider;
    if (!value) $settings.meeting.transcription_model = null;
    // Key/endpoint belong to the previous provider — never carry them over.
    if (changed) {
      $settings.meeting.transcription_api_key = null;
      $settings.meeting.transcription_endpoint = null;
    }
  }

  function resetConsentNotice() {
    try {
      localStorage.removeItem("openwhisperer.meeting.consentAcknowledged");
    } catch {
      /* ignore */
    }
    meetingConsentAcknowledged.set(false);
  }

  const inputClass =
    "w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent disabled:opacity-50";
</script>

{#if $settings.meeting}
  <div class="space-y-4">
    <div class="p-3 bg-surface-elevated rounded border border-border">
      <p class="text-xs text-text-muted">
        <strong class="text-text-secondary">Meeting Mode</strong> records your microphone ("me")
        and system audio ("them") in the background, transcribes it in segments and lets an LLM
        pick out bugs, tasks and questions for review — feedback, ideas and decisions go to the
        Journal. Start it from the Meeting button in the sidebar or the Start / Stop Meeting hotkey.
      </p>
      <p class="text-xs text-amber-400 mt-2">
        Recording other people may require their consent. Always tell participants you're recording.
      </p>
    </div>

    <!-- Capture -->
    <div>
      <h3 class="text-sm font-medium text-text-primary mb-3">Capture</h3>
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <label class="text-sm font-medium text-text-secondary">Microphone ("me")</label>
            <p class="text-xs text-text-muted mt-0.5">Capture your own voice</p>
          </div>
          <input type="checkbox" class="toggle" bind:checked={$settings.meeting.capture_mic} />
        </div>

        <div>
          <div class="flex items-center justify-between mb-1">
            <label class="text-sm font-medium text-text-secondary" for="meeting-mic">Microphone device</label>
            <button class="text-[11px] text-text-muted hover:text-text-secondary" onclick={loadDevices}>
              Refresh
            </button>
          </div>
          <select
            id="meeting-mic"
            class={inputClass}
            disabled={!$settings.meeting.capture_mic}
            value={$settings.meeting.mic_device ?? ""}
            onchange={(e) => {
              if ($settings.meeting) $settings.meeting.mic_device = e.currentTarget.value || null;
            }}
          >
            <option value="">Default input device</option>
            {#each inputDevices as device}
              <option value={device}>{device}</option>
            {/each}
            {#if $settings.meeting.mic_device && !inputDevices.includes($settings.meeting.mic_device)}
              <option value={$settings.meeting.mic_device}>{$settings.meeting.mic_device} (not found)</option>
            {/if}
          </select>
          {#if devicesError}
            <p class="text-xs text-error mt-1">Couldn't list devices: {devicesError}</p>
          {/if}
          <p class="text-xs text-text-muted mt-1">
            Captured natively (no browser echo cancellation) — headphones avoid "them" audio bleeding into your mic.
          </p>
        </div>

        <div class="flex items-center justify-between border-t border-border pt-4">
          <div>
            <label class="text-sm font-medium text-text-secondary">System audio ("them")</label>
            <p class="text-xs text-text-muted mt-0.5">Capture what other participants say (loopback)</p>
          </div>
          <input type="checkbox" class="toggle" bind:checked={$settings.meeting.capture_system} />
        </div>

        <div>
          <label class="text-sm font-medium text-text-secondary block mb-1" for="meeting-target">System audio source</label>
          <select
            id="meeting-target"
            class={inputClass}
            disabled={!$settings.meeting.capture_system}
            bind:value={$settings.meeting.system_target}
          >
            <option value="process">Only these apps (Windows per-app capture)</option>
            <option value="all">Everything playing on the default output</option>
          </select>
          <p class="text-xs text-text-muted mt-1">
            Per-app capture keeps game audio and music out. It falls back to full system audio when
            none of the apps are running, and on macOS/Linux.
          </p>
        </div>

        {#if $settings.meeting.system_target === "process"}
          <div>
            <span class="text-sm font-medium text-text-secondary block mb-1">Apps to capture</span>
            <div class="flex flex-wrap gap-1.5 mb-2">
              {#each $settings.meeting.system_process_names as name (name)}
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-elevated border border-border text-xs text-text-primary">
                  {name}
                  <button
                    class="text-text-muted hover:text-error"
                    onclick={() => removeProcess(name)}
                    aria-label="Remove {name}"
                  >
                    ×
                  </button>
                </span>
              {:else}
                <span class="text-xs text-text-muted">No apps — full system audio will be captured.</span>
              {/each}
            </div>
            <div class="flex gap-2">
              <input
                type="text"
                class={inputClass}
                placeholder="e.g. Discord.exe"
                bind:value={newProcessName}
                onkeydown={(e) => {
                  if (e.key === "Enter") {
                    addProcess(newProcessName);
                    newProcessName = "";
                  }
                }}
              />
              <button
                class="px-3 py-1.5 rounded text-xs font-medium bg-surface-elevated border border-border text-text-secondary hover:bg-border shrink-0"
                onclick={() => {
                  addProcess(newProcessName);
                  newProcessName = "";
                }}
              >
                Add
              </button>
              <button
                class="px-3 py-1.5 rounded text-xs font-medium bg-accent/15 text-accent hover:bg-accent/25 shrink-0 disabled:opacity-50"
                onclick={loadProcesses}
                disabled={processesLoading}
                title="List apps that are currently playing audio"
              >
                {processesLoading ? "Scanning…" : "Detect running apps"}
              </button>
            </div>
            {#if processesError}
              <p class="text-xs text-error mt-1">{processesError}</p>
            {/if}
            {#if audioProcesses}
              <div class="mt-2 p-2 bg-surface-elevated rounded border border-border">
                {#if audioProcesses.length === 0}
                  <p class="text-xs text-text-muted">No audio apps found (per-app capture is Windows-only).</p>
                {:else}
                  <p class="text-[11px] text-text-muted mb-1">Apps with audio sessions — click to add:</p>
                  <div class="flex flex-wrap gap-1.5">
                    {#each audioProcesses as proc (proc.pid)}
                      {@const added = $settings.meeting.system_process_names.some(
                        (n) => n.toLowerCase() === proc.name.toLowerCase()
                      )}
                      <button
                        class="px-2 py-0.5 rounded text-xs border transition-colors {added
                          ? 'border-accent/40 bg-accent/10 text-accent'
                          : 'border-border bg-surface text-text-secondary hover:bg-border'}"
                        disabled={added}
                        onclick={() => addProcess(proc.name)}
                      >
                        {added ? "✓ " : "+ "}{proc.name}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>

    <!-- Segmentation -->
    <div class="border-t border-border pt-4">
      <h3 class="text-sm font-medium text-text-primary mb-1">Segmentation</h3>
      <p class="text-xs text-text-muted mb-3">
        Speech is cut on silence into short segments that are transcribed one by one.
      </p>
      <div class="grid grid-cols-3 gap-3">
        <div>
          <label class="block text-sm font-medium text-text-secondary mb-1" for="meeting-vad">Voice threshold</label>
          <input
            id="meeting-vad"
            type="number"
            min="0.001"
            max="0.2"
            step="0.001"
            class={inputClass}
            bind:value={$settings.meeting.vad_threshold}
          />
          <p class="text-[11px] text-text-muted mt-1">RMS level counted as speech (lower = more sensitive)</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-text-secondary mb-1" for="meeting-hangover">Silence (ms)</label>
          <input
            id="meeting-hangover"
            type="number"
            min="200"
            max="10000"
            step="100"
            class={inputClass}
            bind:value={$settings.meeting.silence_hangover_ms}
          />
          <p class="text-[11px] text-text-muted mt-1">Pause length that ends a segment</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-text-secondary mb-1" for="meeting-maxseg">Max segment (s)</label>
          <input
            id="meeting-maxseg"
            type="number"
            min="10"
            max="300"
            class={inputClass}
            bind:value={$settings.meeting.max_segment_secs}
          />
          <p class="text-[11px] text-text-muted mt-1">Hard cap per segment</p>
        </div>
      </div>
    </div>

    <!-- Transcription -->
    <div class="border-t border-border pt-4">
      <h3 class="text-sm font-medium text-text-primary mb-1">Transcription</h3>
      <p class="text-xs text-text-muted mb-3">
        Meetings can use a different provider than dictation — e.g. an API provider while a local
        LLM uses the GPU. An override provider has its own API key and endpoint below; the dictation
        key is only reused when the override is the same provider as dictation.
      </p>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-sm font-medium text-text-secondary mb-1" for="meeting-provider">Provider</label>
          <select
            id="meeting-provider"
            class={inputClass}
            value={providerValue}
            onchange={(e) => setProvider(e.currentTarget.value)}
          >
            {#each PROVIDERS as provider}
              <option value={provider.value}>{provider.label}</option>
            {/each}
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium text-text-secondary mb-1" for="meeting-model">Model</label>
          <input
            id="meeting-model"
            type="text"
            class={inputClass}
            disabled={!providerValue}
            placeholder={providerValue ? modelHint || "Provider default" : "Dictation model"}
            value={$settings.meeting.transcription_model ?? ""}
            oninput={(e) => {
              if ($settings.meeting) $settings.meeting.transcription_model = e.currentTarget.value.trim() || null;
            }}
          />
        </div>
      </div>
      {#if providerValue}
        <div class="grid grid-cols-2 gap-3 mt-3">
          <div>
            <label class="block text-sm font-medium text-text-secondary mb-1" for="meeting-api-key">API key</label>
            <input
              id="meeting-api-key"
              type="password"
              class="{inputClass} font-mono"
              placeholder={keyPlaceholder}
              value={$settings.meeting.transcription_api_key ?? ""}
              oninput={(e) => {
                if ($settings.meeting) $settings.meeting.transcription_api_key = e.currentTarget.value.trim() || null;
              }}
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-text-secondary mb-1" for="meeting-endpoint">Endpoint</label>
            <input
              id="meeting-endpoint"
              type="text"
              class={inputClass}
              placeholder={endpointPlaceholder}
              value={$settings.meeting.transcription_endpoint ?? ""}
              oninput={(e) => {
                if ($settings.meeting) $settings.meeting.transcription_endpoint = e.currentTarget.value.trim() || null;
              }}
            />
          </div>
        </div>
        {#if providerValue === "Custom" && !$settings.meeting.transcription_endpoint && !sameAsDictation}
          <p class="text-xs text-warning mt-2">A Custom provider needs an endpoint — meeting transcription fails without one.</p>
        {/if}
      {/if}
      {#if providerValue === "OpenRouter"}
        <p class="text-xs text-text-muted mt-2">
          MAI-Transcribe-2 (<span class="font-mono">microsoft/mai-transcribe-2</span>) supports speaker
          diarization, which splits "them" into separate speakers for free.
        </p>
      {/if}
    </div>

    <!-- Triage -->
    <div class="border-t border-border pt-4">
      <h3 class="text-sm font-medium text-text-primary mb-1">Triage</h3>
      <p class="text-xs text-text-muted mb-3">
        The LLM (quality chain, Settings → LLM) reads new transcript every few minutes and extracts
        items. Bugs, tasks, investigations and questions land in the meeting's review list.
      </p>
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-text-secondary mb-1" for="meeting-interval">Triage interval (minutes)</label>
          <input
            id="meeting-interval"
            type="number"
            min="1"
            max="60"
            class={inputClass}
            bind:value={$settings.meeting.triage_interval_minutes}
          />
        </div>

        <div class="flex items-center justify-between">
          <div>
            <label class="text-sm font-medium text-text-secondary">Auto-send to pile</label>
            <p class="text-xs text-text-muted mt-0.5">
              Actionable items above the confidence threshold go straight to the pile (off = review first)
            </p>
          </div>
          <input type="checkbox" class="toggle" bind:checked={$settings.meeting.auto_pile} />
        </div>

        <div>
          <label class="block text-sm font-medium text-text-secondary mb-1" for="meeting-conf">
            Minimum confidence: {Math.round(($settings.meeting.auto_pile_min_confidence ?? 0.85) * 100)}%
          </label>
          <input
            id="meeting-conf"
            type="range"
            min="0.5"
            max="1"
            step="0.01"
            class="w-full accent-accent disabled:opacity-50"
            disabled={!$settings.meeting.auto_pile}
            bind:value={$settings.meeting.auto_pile_min_confidence}
          />
        </div>

        <div class="flex items-center justify-between">
          <div>
            <label class="text-sm font-medium text-text-secondary">Auto-repo by default</label>
            <p class="text-xs text-text-muted mt-0.5">
              Let the LLM pick a repository per item instead of using the active repository
            </p>
          </div>
          <input type="checkbox" class="toggle" bind:checked={$settings.meeting.default_auto_repo} />
        </div>
      </div>
    </div>

    <!-- Retention -->
    <div class="border-t border-border pt-4">
      <h3 class="text-sm font-medium text-text-primary mb-1">Storage</h3>
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1" for="meeting-retention">Keep meeting audio (days)</label>
        <input
          id="meeting-retention"
          type="number"
          min="1"
          max="3650"
          class={inputClass}
          bind:value={$settings.meeting.retention_days}
        />
        <p class="text-xs text-text-muted mt-1">
          Audio clips of finished meetings are deleted after this many days. Transcripts and items are kept.
        </p>
      </div>
      <div class="mt-3">
        <button
          class="text-xs text-text-muted hover:text-text-secondary underline"
          onclick={resetConsentNotice}
          disabled={!$meetingConsentAcknowledged}
        >
          Show the recording-consent notice again
        </button>
      </div>
    </div>
  </div>
{/if}
