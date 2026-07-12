<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { settings } from '$lib/stores/settings';

  interface DockerStatus {
    installed: boolean;
    running: boolean;
    error: string | null;
  }
  interface RealtimeTestResult {
    connected: boolean;
    error: string | null;
  }
  interface WhisperTestResult {
    health_ok: boolean;
    health_error: string | null;
    transcription_ok: boolean;
    transcription_error: string | null;
  }

  type ServiceStatus = 'unknown' | 'checking' | 'connected' | 'down';

  let docker = $state<DockerStatus | null>(null);
  let checkingDocker = $state(false);
  let realtimeStatus = $state<ServiceStatus>('unknown');
  let whisperStatus = $state<ServiceStatus>('unknown');
  let moonshineSetupStarted = $state(false);
  let whisperSetupStarted = $state(false);
  let setupError = $state<string | null>(null);

  // Test recording ("hello hello")
  let testState = $state<'idle' | 'recording' | 'transcribing' | 'done' | 'error'>('idle');
  let testTranscript = $state('');
  let testError = $state('');
  let mediaRecorder: MediaRecorder | null = null;
  let recordTimeout: ReturnType<typeof setTimeout> | null = null;

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const isWindows = navigator.userAgent.includes('Windows');
  const moonshineContainer = $derived(
    $settings.realtime.moonshine.docker.container_name || 'open-whisperer-moonshine'
  );
  const whisperContainer = $derived($settings.whisper.docker.container_name || 'whisper');

  const moonshineRunCommand = $derived(
    `docker run -d --restart unless-stopped -p 2702:2702 --name ${moonshineContainer} open-whisperer-moonshine`
  );
  const whisperRunCommand = $derived(
    [
      'docker run -d --restart unless-stopped',
      `--name ${whisperContainer}`,
      '-p 8000:8000',
      isWindows
        ? '-v %USERPROFILE%\\.cache\\huggingface:/root/.cache/huggingface'
        : '-v ~/.cache/huggingface:/root/.cache/huggingface',
      'fedirz/faster-whisper-server:latest-cpu',
    ].join(' ')
  );

  const allConnected = $derived(realtimeStatus === 'connected' && whisperStatus === 'connected');

  onMount(() => {
    void checkDocker();
    void testServices();
    // Keep probing in the background: Docker Desktop starting up, containers
    // finishing their first build/pull — everything resolves without clicks.
    pollTimer = setInterval(() => {
      if (!docker?.running) {
        void checkDocker();
      }
      void testServices();
    }, 5000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (recordTimeout) clearTimeout(recordTimeout);
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  });

  async function checkDocker() {
    checkingDocker = true;
    try {
      docker = await invoke<DockerStatus>('check_docker');
    } catch (e) {
      docker = { installed: false, running: false, error: String(e) };
    }
    checkingDocker = false;
  }

  async function testServices() {
    if (realtimeStatus !== 'connected') {
      if (realtimeStatus === 'unknown') realtimeStatus = 'checking';
      try {
        const result = await invoke<RealtimeTestResult>('test_realtime_connection');
        realtimeStatus = result.connected ? 'connected' : 'down';
      } catch {
        realtimeStatus = 'down';
      }
    }
    if (whisperStatus !== 'connected') {
      if (whisperStatus === 'unknown') whisperStatus = 'checking';
      try {
        const result = await invoke<WhisperTestResult>('test_whisper_connection');
        whisperStatus = result.health_ok && result.transcription_ok ? 'connected' : 'down';
      } catch {
        whisperStatus = 'down';
      }
    }
  }

  async function setupMoonshine() {
    setupError = null;
    moonshineSetupStarted = true;
    try {
      await invoke('run_docker_setup', {
        provider: 'moonshine',
        image: 'open-whisperer-moonshine',
        containerName: moonshineContainer,
        runCommand: moonshineRunCommand,
      });
    } catch (e) {
      setupError = String(e);
      moonshineSetupStarted = false;
    }
  }

  async function setupWhisper() {
    setupError = null;
    whisperSetupStarted = true;
    try {
      await invoke('run_docker_setup', {
        provider: 'whisper',
        image: 'fedirz/faster-whisper-server:latest-cpu',
        containerName: whisperContainer,
        runCommand: whisperRunCommand,
      });
    } catch (e) {
      setupError = String(e);
      whisperSetupStarted = false;
    }
  }

  async function runTestRecording() {
    testError = '';
    testTranscript = '';
    try {
      const deviceId = $settings.audio.device_id;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      const chunks: Blob[] = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        testState = 'transcribing';
        try {
          const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
          const buffer = await blob.arrayBuffer();
          const audioData = Array.from(new Uint8Array(buffer));
          const text = await invoke<string>('transcribe_audio', { audioData });
          testTranscript = text.trim();
          testState = 'done';
        } catch (e) {
          testError = String(e);
          testState = 'error';
        }
      };
      mediaRecorder.start();
      testState = 'recording';
      recordTimeout = setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      }, 3000);
    } catch (e) {
      testError = `Could not access the microphone: ${e}`;
      testState = 'error';
    }
  }
</script>

<div class="space-y-4">
  <div class="p-3 bg-surface rounded-lg border border-border/50 text-sm text-text-secondary">
    The recommended setup runs two small local servers in Docker:
    <strong>Moonshine</strong> streams live text while you speak, and
    <strong>Whisper</strong> is the accurate fallback. Both are CPU-only, private, and free.
  </div>

  {#if checkingDocker && !docker}
    <div class="flex items-center gap-3 p-5 bg-surface-elevated border border-border rounded-lg">
      <div class="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
      <span class="text-sm text-text-secondary">Checking for Docker…</span>
    </div>
  {:else if docker && !docker.installed}
    <div class="p-5 bg-surface-elevated border border-border rounded-lg">
      <h3 class="text-sm font-medium text-text-primary mb-1">Docker Desktop is required</h3>
      <p class="text-xs text-text-muted mb-4">
        The local transcription servers run as Docker containers. Install Docker Desktop,
        start it, and come back — this screen keeps checking automatically.
      </p>
      <div class="flex items-center gap-2">
        <a
          class="px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 transition-colors"
          href="https://www.docker.com/products/docker-desktop/"
        >
          Get Docker Desktop
        </a>
        <button
          class="px-4 py-2 text-sm bg-surface hover:bg-border rounded transition-colors"
          onclick={checkDocker}
        >
          Check again
        </button>
      </div>
      <p class="text-xs text-text-muted mt-4">
        Don't want Docker right now? Skip this step — you can finish it later in
        Settings → Transcription.
      </p>
    </div>
  {:else if docker && !docker.running}
    <div class="flex items-center gap-3 p-5 bg-surface-elevated border border-border rounded-lg">
      <div class="w-4 h-4 border-2 border-warning border-t-transparent rounded-full animate-spin flex-shrink-0"></div>
      <div>
        <p class="text-sm text-text-primary">Docker is installed but not running</p>
        <p class="text-xs text-text-muted">Start Docker Desktop — I'll keep checking and continue automatically.</p>
      </div>
    </div>
  {:else if docker}
    <!-- Docker running: service rows -->
    <div class="bg-surface-elevated border border-border rounded-lg divide-y divide-border">
      <!-- Moonshine -->
      <div class="flex items-center gap-3 p-4">
        <div
          class="w-2.5 h-2.5 rounded-full flex-shrink-0"
          class:bg-success={realtimeStatus === 'connected'}
          class:bg-error={realtimeStatus === 'down' && !moonshineSetupStarted}
          class:bg-warning={realtimeStatus === 'down' && moonshineSetupStarted}
          class:bg-text-muted={realtimeStatus === 'unknown' || realtimeStatus === 'checking'}
        ></div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-text-primary">Moonshine — live transcription</p>
          <p class="text-xs text-text-muted">
            {#if realtimeStatus === 'connected'}
              Connected and ready
            {:else if moonshineSetupStarted}
              Building in the terminal window… this can take a few minutes on first run
            {:else}
              Streams text to the overlay while you speak
            {/if}
          </p>
        </div>
        {#if realtimeStatus !== 'connected'}
          <button
            class="px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/90 transition-colors flex-shrink-0"
            onclick={setupMoonshine}
          >
            {moonshineSetupStarted ? 'Retry setup' : 'Set up'}
          </button>
        {/if}
      </div>

      <!-- Whisper -->
      <div class="flex items-center gap-3 p-4">
        <div
          class="w-2.5 h-2.5 rounded-full flex-shrink-0"
          class:bg-success={whisperStatus === 'connected'}
          class:bg-error={whisperStatus === 'down' && !whisperSetupStarted}
          class:bg-warning={whisperStatus === 'down' && whisperSetupStarted}
          class:bg-text-muted={whisperStatus === 'unknown' || whisperStatus === 'checking'}
        ></div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-text-primary">Whisper — accurate fallback</p>
          <p class="text-xs text-text-muted">
            {#if whisperStatus === 'connected'}
              Connected and ready
            {:else if whisperSetupStarted}
              Pulling the image in the terminal window… this can take a few minutes on first run
            {:else}
              Produces the final transcript when the live engine misses something
            {/if}
          </p>
        </div>
        {#if whisperStatus !== 'connected'}
          <button
            class="px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/90 transition-colors flex-shrink-0"
            onclick={setupWhisper}
          >
            {whisperSetupStarted ? 'Retry setup' : 'Set up'}
          </button>
        {/if}
      </div>
    </div>

    {#if setupError}
      <p class="text-xs text-error">{setupError}</p>
    {/if}

    <!-- Live test once Whisper is reachable -->
    {#if whisperStatus === 'connected'}
      <div class="p-5 bg-surface-elevated border border-border rounded-lg">
        <h3 class="text-sm font-medium text-text-primary mb-1">Try it out</h3>
        <p class="text-xs text-text-muted mb-3">
          Press Record and say <strong class="text-text-secondary">“hello hello”</strong> — recording
          stops by itself after 3 seconds.
        </p>
        <div class="flex items-center gap-3">
          <button
            class="px-4 py-2 text-sm rounded transition-colors flex items-center gap-2 {testState === 'recording'
              ? 'bg-recording text-white'
              : 'bg-red-600 hover:bg-red-700 text-white'}"
            onclick={runTestRecording}
            disabled={testState === 'recording' || testState === 'transcribing'}
          >
            {#if testState === 'recording'}
              <div class="w-2 h-2 bg-white rounded-full animate-pulse"></div>
              Listening…
            {:else if testState === 'transcribing'}
              <div class="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              Transcribing…
            {:else}
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fill-rule="evenodd"
                  d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z"
                  clip-rule="evenodd"
                />
              </svg>
              {testState === 'done' || testState === 'error' ? 'Record again' : 'Record'}
            {/if}
          </button>
          {#if testState === 'done'}
            <div class="flex items-center gap-2 text-sm min-w-0">
              {#if testTranscript}
                <svg class="w-4 h-4 text-success flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fill-rule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clip-rule="evenodd"
                  />
                </svg>
                <span class="text-text-primary truncate">“{testTranscript}”</span>
              {:else}
                <span class="text-text-muted">Heard nothing — try again a little louder</span>
              {/if}
            </div>
          {:else if testState === 'error'}
            <span class="text-xs text-error truncate">{testError}</span>
          {/if}
        </div>
      </div>
    {/if}

    {#if allConnected}
      <p class="text-sm text-success flex items-center gap-1.5">
        <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path
            fill-rule="evenodd"
            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
            clip-rule="evenodd"
          />
        </svg>
        Dual transcription is fully set up.
      </p>
    {/if}
  {/if}
</div>
