import { writable, derived, get } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { settings, OPEN_MIC_PRESETS } from "./settings";

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
  let audioContext: AudioContext | null = null;
  let audioSource: MediaStreamAudioSourceNode | null = null; // Store source for proper cleanup
  let processor: ScriptProcessorNode | null = null;
  let unlistenPartial: UnlistenFn | null = null;
  let unlistenFinal: UnlistenFn | null = null;
  let unlistenError: UnlistenFn | null = null;
  // Accumulated final text from Vosk (when accumulate_transcript is enabled)
  let voskAccumulatedText: string = "";

  // Guard against concurrent start() calls - tracks the current initialization promise
  let startPromise: Promise<void> | null = null;

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

  // Convert Float32 audio samples to Int16 for Vosk
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

  // Check if a transcript contains any wake command
  function detectWakeCommand(transcript: string): string | null {
    const currentSettings = get(settings);
    const wakeCommands = currentSettings.audio.open_mic.wake_commands;

    if (wakeCommands.length === 0) return null;

    const lowerTranscript = transcript.toLowerCase().trim();

    // Check for each wake command (exact match or at the end)
    for (const command of wakeCommands) {
      const lowerCommand = command.toLowerCase();

      // Check if transcript ends with the command
      if (lowerTranscript.endsWith(lowerCommand)) {
        return command;
      }

      // Check if transcript equals the command exactly
      if (lowerTranscript === lowerCommand) {
        return command;
      }

      // Check with common punctuation variations at the end
      const punctuationVariants = [
        `. ${lowerCommand}`,
        `, ${lowerCommand}`,
        `! ${lowerCommand}`,
        `? ${lowerCommand}`,
      ];

      for (const variant of punctuationVariants) {
        if (lowerTranscript.endsWith(variant)) {
          return command;
        }
      }
    }

    return null;
  }

  async function start() {
    // Prevent double-starting - check both state AND if there's an ongoing start
    const currentState = get({ subscribe });
    if (currentState.state === "listening" || currentState.state === "initializing") {
      console.log("[open-mic] Already running, skipping start");
      return;
    }

    // If there's already a start in progress, wait for it instead of starting again
    if (startPromise) {
      console.log("[open-mic] Start already in progress, waiting for it");
      await startPromise;
      return;
    }

    const currentSettings = get(settings);

    // Check prerequisites
    if (!currentSettings.vosk?.enabled) {
      update((s) => ({
        ...s,
        state: "error",
        error: "Vosk must be enabled for open mic mode",
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
    voskAccumulatedText = "";

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

    update((s) => ({
      ...s,
      state: "initializing",
      error: null,
      detectedCommand: null,
      lastTranscript: "",
    }));

    // Wrap the async initialization in a tracked promise
    startPromise = (async () => {
    try {
      // Request microphone access (use same constraints as recording store)
      const deviceId = currentSettings.audio.device_id;
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });

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

      // Create audio context at Vosk's required sample rate (16kHz)
      audioContext = new AudioContext({
        sampleRate: currentSettings.vosk.sample_rate || 16000,
      });
      audioSource = audioContext.createMediaStreamSource(mediaStream);

      // ScriptProcessor to extract PCM samples (256 buffer = ~16ms at 16kHz, minimum valid size)
      processor = audioContext.createScriptProcessor(256, 1, 1);

      // Store context reference to check validity in callback
      const contextRef = audioContext;

      // Match recording store's audio processing - use non-blocking invoke
      processor.onaudioprocess = (event) => {
        // Skip if context was closed (prevents zombie callbacks)
        if (contextRef.state === 'closed' || !processor) return;

        const float32Data = event.inputBuffer.getChannelData(0);
        const int16Data = convertFloat32ToInt16(float32Data);

        // Check volume threshold before sending to Vosk
        const rms = calculateRMS(float32Data);
        const threshold = get(settings).audio.open_mic.volume_threshold ?? 0.01;
        const isAboveThreshold = rms >= threshold;

        // Emit current audio level for UI visualization
        emit("open-mic-audio-level", { rms, threshold, isAboveThreshold });

        if (isAboveThreshold) {
          // If we just crossed the threshold, send buffered pre-roll audio first
          if (!wasAboveThreshold && preRollBuffer.length > 0) {
            for (const bufferedChunk of preRollBuffer) {
              invoke("send_vosk_audio", {
                sessionId: OPEN_MIC_SESSION_ID,
                samples: Array.from(bufferedChunk),
              }).catch(() => {});
            }
            preRollBuffer = [];
          }

          // Send current audio
          invoke("send_vosk_audio", {
            sessionId: OPEN_MIC_SESSION_ID,
            samples: Array.from(int16Data),
          }).catch(() => {});

          wasAboveThreshold = true;
          hangoverRemaining = HANGOVER_BUFFERS;
        } else if (hangoverRemaining > 0) {
          // Post-roll: continue sending briefly after threshold drops to avoid cutting off word endings
          hangoverRemaining--;
          invoke("send_vosk_audio", {
            sessionId: OPEN_MIC_SESSION_ID,
            samples: Array.from(int16Data),
          }).catch(() => {});

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

      // Listen for Vosk partial events (real-time)
      // NOTE: Open mic does NOT accumulate across utterances like recording does.
      // Open mic runs continuously, so we show only the CURRENT utterance directly.
      // Vosk partials already contain the full current utterance (they replace, not add).
      let lastPartialTime = Date.now();
      let lastPartialText = "";
      unlistenPartial = await listen(
        `vosk-partial-${OPEN_MIC_SESSION_ID}`,
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

          console.log("[open-mic][partial]", { partial, deltaMs: delta });

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

      // Listen for Vosk final events
      unlistenFinal = await listen(
        `vosk-final-${OPEN_MIC_SESSION_ID}`,
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

      // Listen for Vosk errors
      unlistenError = await listen(
        `vosk-error-${OPEN_MIC_SESSION_ID}`,
        (event: any) => {
          console.error("[open-mic] Vosk error:", event.payload?.error);
        }
      );

      // Start the Vosk session on the backend
      await invoke("start_vosk_session", { sessionId: OPEN_MIC_SESSION_ID });

      // Clear the UI transcript when starting fresh
      emit("open-mic-realtime-transcript", { text: "" });

      update((s) => ({ ...s, state: "listening" }));
      console.log("[open-mic] Started passive listening");
    } catch (error) {
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
        voskAccumulatedText = "";
        update((s) => ({
          ...s,
          state: "listening",
          detectedCommand: null,
          lastTranscript: "",
        }));
      }
    }, 1000);
  }

  async function stop() {
    console.log("[open-mic] Stopping passive listening");
    await cleanup();
    // Clear accumulated text when stopping
    voskAccumulatedText = "";
    update((s) => ({
      ...s,
      state: "disabled",
      error: null,
      lastTranscript: "",
      detectedCommand: null,
    }));
  }

  async function pause() {
    const currentState = get({ subscribe });
    if (currentState.state !== "listening") {
      console.log("[open-mic] Cannot pause - not listening");
      return;
    }

    console.log("[open-mic] Pausing passive listening");
    await cleanup();
    update((s) => ({
      ...s,
      state: "paused",
      lastTranscript: "",
    }));
  }

  async function resume() {
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

    // Stop media stream
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }

    // Stop the backend Vosk session
    try {
      await invoke("stop_vosk_session", { sessionId: OPEN_MIC_SESSION_ID });
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
      currentSettings.vosk?.enabled
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
    (currentSettings.vosk?.enabled ?? false)
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
