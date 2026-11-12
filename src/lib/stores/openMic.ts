import { writable, derived, get } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { settings, OPEN_MIC_PRESETS } from "./settings";
import { transcriptEndsWithCommand } from "$lib/utils/voiceCommands";
import { acquireMicStream, type MicLease } from "./micStream";

export type OpenMicState =
  | "disabled"
  | "initializing"
  | "listening"
  | "paused"
  | "triggered"
  | "error";

interface OpenMicStore {
  state: OpenMicState;
  error: string | null;
  lastTranscript: string;
  detectedCommand: string | null;
}

function createOpenMicStore() {
  const { subscribe, set, update } = writable<OpenMicStore>({
    state: "disabled",
    error: null,
    lastTranscript: "",
    detectedCommand: null,
  });

  const OPEN_MIC_SESSION_ID = "open_mic_passive";

  // Audio context and processor for passive listening
  let mediaStream: MediaStream | null = null;
  // Lease on the shared mic stream — released (never track-stopped) in cleanup.
  let micLease: MicLease | null = null;
  let audioContext: AudioContext | null = null;
  let audioSource: MediaStreamAudioSourceNode | null = null; // Store source for proper cleanup
  let processor: ScriptProcessorNode | null = null;
  let unlistenPartial: UnlistenFn | null = null;
  let unlistenFinal: UnlistenFn | null = null;
  let unlistenError: UnlistenFn | null = null;
  // Accumulated final text from real-time transcription (when accumulate_transcript is enabled)
  let realtimeAccumulatedText: string = "";

  // Guard against concurrent start() calls - tracks the current initialization promise
  let startPromise: Promise<void> | null = null;
  // Bumped by stop()/pause(): an in-flight start() that sees a newer generation
  // tears down what it built instead of flipping state back to "listening".
  // (A stop during start — e.g. the wake-triggered recording stopping open mic
  // while a restart was connecting — used to leave a zombie "listening" session.)
  let startGeneration = 0;
  // Set once the realtime connection of the current listening session is dead.
  let connectionLost = false;
  let unlistenClosed: UnlistenFn | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // The user's explicit pause, remembered across recordings, settings changes
  // and app restarts. Only pause()/resume() change it.
  const USER_PAUSED_KEY = "openMic.userPaused";
  let userPaused = (() => {
    try {
      return localStorage.getItem(USER_PAUSED_KEY) === "1";
    } catch {
      return false;
    }
  })();
  function setUserPaused(value: boolean) {
    userPaused = value;
    try {
      if (value) localStorage.setItem(USER_PAUSED_KEY, "1");
      else localStorage.removeItem(USER_PAUSED_KEY);
    } catch {
      // Storage unavailable — the pause still holds for this run.
    }
  }

  // Visualization context (to match recording store's audio pipeline)
  let vizAudioContext: AudioContext | null = null;
  let vizAnalyser: AnalyserNode | null = null;
  let vizSource: MediaStreamAudioSourceNode | null = null; // Store source for proper cleanup
  let vizAnimationId: number | null = null;

  // Pre-roll buffering: keep recent audio to avoid cutting off start of speech
  const PRE_ROLL_BUFFERS = 8; // ~128ms at 16kHz with 256-sample buffers
  const HANGOVER_BUFFERS = 8; // Continue sending ~128ms after threshold drops
  let preRollBuffer: Int16Array[] = [];
  let wasAboveThreshold = false;
  let hangoverRemaining = 0;

  // Convert Float32 audio samples to Int16 for real-time transcription
  function convertFloat32ToInt16(float32Array: Float32Array): Int16Array {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16Array;
  }

  // Calculate RMS (Root Mean Square) volume of audio samples
  function calculateRMS(float32Array: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < float32Array.length; i++) {
      sum += float32Array[i] * float32Array[i];
    }
    return Math.sqrt(sum / float32Array.length);
  }

  // Check if a transcript ends with any wake command, tolerating the
  // punctuation/casing transcribers add (Moonshine emits "Hey, Claude."
  // where the realtime engine emits "hey claude")
  function detectWakeCommand(transcript: string): string | null {
    const currentSettings = get(settings);
    const wakeCommands = currentSettings.audio.open_mic.wake_commands;

    for (const command of wakeCommands) {
      if (transcriptEndsWithCommand(transcript, command)) {
        return command;
      }
    }

    return null;
  }

  async function start() {
    // The user's pause is sticky: nothing automatic (recording stop, settings
    // change, reconnect, app restart) may resume listening — only resume().
    if (userPaused && get(settings).audio.open_mic.enabled) {
      update((s) => (s.state === "paused" ? s : { ...s, state: "paused", lastTranscript: "" }));
      return;
    }

    // Prevent double-starting - check both state AND if there's an ongoing start
    const currentState = get({ subscribe });
    if (currentState.state === "listening" || currentState.state === "initializing") {
      console.log("[open-mic] Already running, skipping start");
      return;
    }

    // A start still in flight while state isn't initializing/listening was
    // superseded by stop() — let it finish tearing down, then start fresh.
    if (startPromise) {
      console.log("[open-mic] Previous start still winding down, waiting for it");
      await startPromise;
      return start();
    }

    const currentSettings = get(settings);

    // Check prerequisites
    if (!currentSettings.realtime?.enabled) {
      update((s) => ({
        ...s,
        state: "error",
        error: "Real-time transcription must be enabled for open mic mode",
      }));
      return;
    }

    if (!currentSettings.audio.open_mic.enabled) {
      update((s) => ({
        ...s,
        state: "disabled",
        error: null,
      }));
      return;
    }

    if (currentSettings.audio.open_mic.wake_commands.length === 0) {
      update((s) => ({
        ...s,
        state: "error",
        error: "No wake commands configured",
      }));
      return;
    }

    // Clear accumulated text at the start of each listening session
    realtimeAccumulatedText = "";

    // Reset pre-roll buffer state
    preRollBuffer = [];
    wasAboveThreshold = false;
    hangoverRemaining = 0;

    // Clean up any existing listeners first (safety measure)
    if (unlistenPartial) {
      unlistenPartial();
      unlistenPartial = null;
    }
    if (unlistenFinal) {
      unlistenFinal();
      unlistenFinal = null;
    }
    if (unlistenError) {
      unlistenError();
      unlistenError = null;
    }
    if (unlistenClosed) {
      unlistenClosed();
      unlistenClosed = null;
    }

    update((s) => ({
      ...s,
      state: "initializing",
      error: null,
      detectedCommand: null,
      lastTranscript: "",
    }));

    const generation = ++startGeneration;
    const superseded = () => generation !== startGeneration;
    connectionLost = false;

    // Wrap the async initialization in a tracked promise
    startPromise = (async () => {
    try {
      // Lease the shared mic stream (same device as recordings, so a recording
      // starting while open mic listens attaches to the already-open stream)
      micLease = await acquireMicStream(currentSettings.audio.device_id || undefined);
      mediaStream = micLease.stream;
      if (superseded()) {
        await cleanup();
        return;
      }

      // Create visualization context (matches recording store's audio pipeline)
      // This adds another consumer to the audio stream for consistent timing
      vizAudioContext = new AudioContext();
      vizAnalyser = vizAudioContext.createAnalyser();
      vizAnalyser.fftSize = 256;
      vizAnalyser.smoothingTimeConstant = 0.8;
      vizSource = vizAudioContext.createMediaStreamSource(mediaStream);
      vizSource.connect(vizAnalyser);

      // Run visualization loop (matches recording store behavior)
      // Emit audio visualization data for OpenMicMarquee
      const vizDataArray = new Uint8Array(vizAnalyser.frequencyBinCount);

      function runVisualization() {
        if (!vizAnalyser) return;
        vizAnalyser.getByteFrequencyData(vizDataArray);
        emit("open-mic-visualization", { data: Array.from(vizDataArray) });
        vizAnimationId = requestAnimationFrame(runVisualization);
      }
      runVisualization();

      // Create audio context at provider's required sample rate (16kHz)
      const sampleRate = currentSettings.realtime.provider === 'VoiceStreamAI'
        ? (currentSettings.realtime.voice_stream_ai?.sample_rate || 16000)
        : currentSettings.realtime.provider === 'SherpaOnnx'
          ? (currentSettings.realtime.sherpa_onnx?.sample_rate || 16000)
          : currentSettings.realtime.provider === 'Speaches'
            ? (currentSettings.realtime.speaches?.sample_rate || 16000)
        : currentSettings.realtime.provider === 'Moonshine'
            ? (currentSettings.realtime.moonshine?.sample_rate || 16000)
          : (currentSettings.realtime.sample_rate || 16000);
      audioContext = new AudioContext({ sampleRate });
      audioSource = audioContext.createMediaStreamSource(mediaStream);

      // ScriptProcessor to extract PCM samples (256 buffer = ~16ms at 16kHz, minimum valid size)
      processor = audioContext.createScriptProcessor(256, 1, 1);

      // Store context reference to check validity in callback
      const contextRef = audioContext;

      // Errors are ignored here ("not found" is expected while the backend
      // session is still connecting); a dead socket is reported once via the
      // `realtime-closed` event, which stops all sends (handleConnectionLost).
      const send = (chunk: Int16Array) => {
        invoke("send_realtime_audio", {
          sessionId: OPEN_MIC_SESSION_ID,
          samples: Array.from(chunk),
        }).catch(() => {});
      };

      // Match recording store's audio processing - use non-blocking invoke
      processor.onaudioprocess = (event) => {
        // Skip if context was closed (prevents zombie callbacks)
        if (contextRef.state === 'closed' || !processor || connectionLost) return;

        const float32Data = event.inputBuffer.getChannelData(0);
        const int16Data = convertFloat32ToInt16(float32Data);

        // Check volume threshold before sending to realtime provider
        const rms = calculateRMS(float32Data);
        const threshold = get(settings).audio.open_mic.volume_threshold ?? 0.01;
        const isAboveThreshold = rms >= threshold;

        // Emit current audio level for UI visualization
        emit("open-mic-audio-level", { rms, threshold, isAboveThreshold });

        if (isAboveThreshold) {
          // If we just crossed the threshold, send buffered pre-roll audio first
          if (!wasAboveThreshold && preRollBuffer.length > 0) {
            for (const bufferedChunk of preRollBuffer) {
              send(bufferedChunk);
            }
            preRollBuffer = [];
          }

          // Send current audio
          send(int16Data);

          wasAboveThreshold = true;
          hangoverRemaining = HANGOVER_BUFFERS;
        } else if (hangoverRemaining > 0) {
          // Post-roll: continue sending briefly after threshold drops to avoid cutting off word endings
          hangoverRemaining--;
          send(int16Data);

          if (hangoverRemaining === 0) {
            wasAboveThreshold = false;
          }
        } else {
          // Below threshold and hangover expired - buffer for pre-roll
          preRollBuffer.push(int16Data);
          if (preRollBuffer.length > PRE_ROLL_BUFFERS) {
            preRollBuffer.shift(); // Remove oldest, keep buffer size fixed
          }
          wasAboveThreshold = false;
        }
      };

      audioSource.connect(processor);
      processor.connect(audioContext.destination);

      // Listen for realtime partial events (real-time)
      // NOTE: Open mic does NOT accumulate across utterances like recording does.
      // Open mic runs continuously, so we show only the CURRENT utterance directly.
      // Partials already contain the full current utterance (they replace, not add).
      let lastPartialTime = Date.now();
      let lastPartialText = "";
      unlistenPartial = await listen(
        `realtime-partial-${OPEN_MIC_SESSION_ID}`,
        (event: any) => {
          const partial = event.payload?.partial || "";

          // Skip if partial hasn't changed (avoid duplicate updates)
          if (partial === lastPartialText) {
            return;
          }
          lastPartialText = partial;

          const now = Date.now();
          const delta = now - lastPartialTime;
          lastPartialTime = now;

          update((s) => ({ ...s, lastTranscript: partial }));
          emit("open-mic-realtime-transcript", { text: partial });

          // Check for wake command in partial transcript (only if non-empty)
          if (partial) {
            const detectedCommand = detectWakeCommand(partial);
            if (detectedCommand) {
              handleWakeCommandDetected(detectedCommand);
            }
          }
        }
      );

      // Listen for realtime final events
      unlistenFinal = await listen(
        `realtime-final-${OPEN_MIC_SESSION_ID}`,
        (event: any) => {
          const text = event.payload?.text || "";
          console.log("[open-mic][final]", { text });

          if (text) {
            update((s) => ({ ...s, lastTranscript: text }));
            emit("open-mic-realtime-transcript", { text });

            // Check for wake command in final transcript
            const detectedCommand = detectWakeCommand(text);
            if (detectedCommand) {
              handleWakeCommandDetected(detectedCommand);
            }
          }
        }
      );

      // Listen for realtime errors
      unlistenError = await listen(
        `realtime-error-${OPEN_MIC_SESSION_ID}`,
        (event: any) => {
          console.error("[open-mic] Realtime transcription error:", event.payload?.error);
        }
      );

      // Emitted once by the backend when the socket dies.
      unlistenClosed = await listen(
        `realtime-closed-${OPEN_MIC_SESSION_ID}`,
        (event: any) => {
          handleConnectionLost(event.payload?.reason ?? "connection closed");
        }
      );

      if (superseded()) {
        await cleanup();
        return;
      }

      // Start the realtime session on the backend
      await invoke("start_realtime_session", { sessionId: OPEN_MIC_SESSION_ID });

      if (superseded()) {
        // stop() ran while we were connecting — its cleanup can't have closed
        // the session we just created, so tear everything down here.
        console.log("[open-mic] Start superseded by stop, tearing down");
        await cleanup();
        return;
      }

      // Clear the UI transcript when starting fresh
      emit("open-mic-realtime-transcript", { text: "" });

      update((s) => ({ ...s, state: "listening" }));
      console.log("[open-mic] Started passive listening");
    } catch (error) {
      if (superseded()) {
        await cleanup();
        return;
      }
      console.error("[open-mic] Failed to start:", error);
      update((s) => ({
        ...s,
        state: "error",
        error: error instanceof Error ? error.message : "Failed to start",
      }));
      await cleanup();
    } finally {
      startPromise = null;
    }
    })();

    await startPromise;
  }

  function handleWakeCommandDetected(command: string) {
    const currentState = get({ subscribe });
    if (currentState.state !== "listening") return;

    console.log("[open-mic] Wake command detected:", command);

    update((s) => ({
      ...s,
      state: "triggered",
      detectedCommand: command,
    }));

    // Emit event to trigger recording in main app
    emit("open-mic-triggered", { command });

    // After a short delay, return to listening state
    // (The main app will handle starting the actual recording)
    setTimeout(() => {
      const state = get({ subscribe });
      if (state.state === "triggered") {
        // Clear accumulated text when returning to listening
        realtimeAccumulatedText = "";
        update((s) => ({
          ...s,
          state: "listening",
          detectedCommand: null,
          lastTranscript: "",
        }));
      }
    }, 1000);
  }

  // Reconnect after a dropped realtime connection, at most 3 times per 5 min
  // (a server that keeps dropping us ends in the error state instead of looping).
  const RECONNECT_DELAY_MS = 3000;
  const RECONNECT_WINDOW_MS = 5 * 60_000;
  const MAX_RECONNECTS_PER_WINDOW = 3;
  let recentReconnects: number[] = [];

  function cancelReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function handleConnectionLost(reason: unknown) {
    if (connectionLost) return;
    connectionLost = true;
    // Stop streaming right away; the processor stays attached until cleanup.
    preRollBuffer = [];

    const now = Date.now();
    recentReconnects = recentReconnects.filter((t) => now - t < RECONNECT_WINDOW_MS);
    if (recentReconnects.length >= MAX_RECONNECTS_PER_WINDOW) {
      console.error(
        `[open-mic] Realtime connection lost again (${String(reason)}); giving up after ${MAX_RECONNECTS_PER_WINDOW} reconnects — open mic paused`
      );
      // "paused" (not "error"): the open-mic lifecycle effect auto-restarts
      // from any other non-listening state, which would defeat the limit.
      startGeneration++;
      void cleanup().then(() =>
        update((s) => ({
          ...s,
          state: "paused",
          error: "Realtime connection keeps dropping — resume to retry",
          lastTranscript: "",
          detectedCommand: null,
        }))
      );
      return;
    }

    console.warn(
      `[open-mic] Realtime connection lost (${String(reason)}); reconnecting in ${RECONNECT_DELAY_MS / 1000}s`
    );
    cancelReconnect();
    const generation = startGeneration;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // Stopped, paused or restarted meanwhile — nothing to do.
      if (generation !== startGeneration) return;
      if (get({ subscribe }).state !== "listening") return;
      recentReconnects.push(Date.now());
      restart().catch((e) => console.error("[open-mic] Reconnect failed:", e));
    }, RECONNECT_DELAY_MS);
  }

  async function stop() {
    console.log("[open-mic] Stopping passive listening");
    startGeneration++;
    cancelReconnect();
    await cleanup();
    // Clear accumulated text when stopping
    realtimeAccumulatedText = "";
    update((s) => ({
      ...s,
      state: "disabled",
      error: null,
      lastTranscript: "",
      detectedCommand: null,
    }));
  }

  async function pause() {
    setUserPaused(true);
    const currentState = get({ subscribe });
    if (currentState.state === "paused" || currentState.state === "disabled") return;

    console.log("[open-mic] Pausing passive listening");
    startGeneration++;
    cancelReconnect();
    await cleanup();
    update((s) => ({
      ...s,
      state: "paused",
      lastTranscript: "",
    }));
  }

  async function resume() {
    setUserPaused(false);
    const currentState = get({ subscribe });
    if (currentState.state !== "paused") {
      console.log("[open-mic] Cannot resume - not paused");
      return;
    }

    console.log("[open-mic] Resuming passive listening");
    // Set to disabled first so start() will actually run
    update((s) => ({ ...s, state: "disabled" }));
    await start();
  }

  async function togglePause() {
    const currentState = get({ subscribe });
    if (currentState.state === "listening") {
      await pause();
    } else if (currentState.state === "paused") {
      await resume();
    }
  }

  async function cleanup() {
    // Clean up event listeners first (before any async operations)
    if (unlistenPartial) {
      unlistenPartial();
      unlistenPartial = null;
    }
    if (unlistenFinal) {
      unlistenFinal();
      unlistenFinal = null;
    }
    if (unlistenError) {
      unlistenError();
      unlistenError = null;
    }
    if (unlistenClosed) {
      unlistenClosed();
      unlistenClosed = null;
    }

    // Clear pre-roll buffer state
    preRollBuffer = [];
    wasAboveThreshold = false;
    hangoverRemaining = 0;

    // Clean up visualization - disconnect source before closing context
    if (vizAnimationId !== null) {
      cancelAnimationFrame(vizAnimationId);
      vizAnimationId = null;
    }
    if (vizSource) {
      try {
        vizSource.disconnect();
      } catch (e) {
        // Ignore - may already be disconnected
      }
      vizSource = null;
    }
    vizAnalyser = null;
    if (vizAudioContext) {
      try {
        if (vizAudioContext.state !== 'closed') {
          await vizAudioContext.close();
        }
      } catch (e) {
        // Ignore errors closing audio context
      }
      vizAudioContext = null;
    }

    // Clean up audio processing - disconnect source first, then processor
    if (audioSource) {
      try {
        audioSource.disconnect();
      } catch (e) {
        // Ignore - may already be disconnected
      }
      audioSource = null;
    }
    if (processor) {
      try {
        processor.disconnect();
      } catch (e) {
        // Ignore - may already be disconnected
      }
      processor = null;
    }
    if (audioContext) {
      try {
        if (audioContext.state !== 'closed') {
          await audioContext.close();
        }
      } catch (e) {
        // Ignore errors closing audio context
      }
      audioContext = null;
    }

    // Release the shared mic stream (tracks stay live for other consumers —
    // e.g. the recording that triggered this stop)
    micLease?.release();
    micLease = null;
    mediaStream = null;

    // Stop the backend realtime session
    try {
      await invoke("stop_realtime_session", { sessionId: OPEN_MIC_SESSION_ID });
    } catch (error) {
      // Ignore errors stopping session (may not exist)
    }
  }

  // Restart listening (useful after settings change)
  async function restart() {
    await stop();
    const currentSettings = get(settings);
    if (
      currentSettings.audio.open_mic.enabled &&
      currentSettings.realtime?.enabled
    ) {
      await start();
    }
  }

  return {
    subscribe,
    start,
    stop,
    pause,
    resume,
    togglePause,
    restart,
  };
}

export const openMic = createOpenMicStore();

// Derived stores for easier access
export const openMicState = derived(openMic, ($openMic) => $openMic.state);
export const isOpenMicListening = derived(
  openMic,
  ($openMic) => $openMic.state === "listening"
);
export const isOpenMicPaused = derived(
  openMic,
  ($openMic) => $openMic.state === "paused"
);
export const isOpenMicActive = derived(
  openMic,
  ($openMic) => $openMic.state === "listening" || $openMic.state === "paused"
);
export const openMicError = derived(openMic, ($openMic) => $openMic.error);

// Helper to check if open mic is enabled in settings
export function isOpenMicEnabled(): boolean {
  const currentSettings = get(settings);
  return (
    currentSettings.audio.open_mic.enabled &&
    (currentSettings.realtime?.enabled ?? false)
  );
}

// Helper to get active wake commands
export function getActiveWakeCommands(): string[] {
  const currentSettings = get(settings);
  return currentSettings.audio.open_mic.wake_commands;
}

// Helper to get all wake command presets
export function getWakeCommandPresets(): readonly string[] {
  return OPEN_MIC_PRESETS;
}

// Helper to validate a wake command
export function isValidWakeCommand(command: string): boolean {
  const trimmed = command.trim();
  return trimmed.length >= 2 && trimmed.length <= 30;
}
