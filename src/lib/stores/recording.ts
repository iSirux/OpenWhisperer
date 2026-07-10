import { writable, derived, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { usageStats } from './usageStats';
import { settings } from './settings';
import { debugRecordings } from './debugRecordings';
import { processVoiceCommand } from '$lib/utils/voiceCommands';
import { acquireMicStream, type MicLease } from './micStream';

export type RecordingState = 'idle' | 'recording' | 'recorded' | 'processing' | 'error';

interface QueuedRecording {
  id: string;
  audioData: Uint8Array;
  status: 'pending' | 'transcribing' | 'done' | 'error';
  transcript?: string;
  error?: string;
  // Id of the on-disk capture (crash insurance); deleted once transcription settles.
  captureId?: string;
  onComplete?: (transcript: string) => void;
  onError?: (error: Error) => void;
}

interface RecordingStore {
  state: RecordingState;
  transcript: string;
  error: string | null;
  audioData: Uint8Array | null;
  stream: MediaStream | null;
  // Queue for pending transcriptions
  queue: QueuedRecording[];
  // Number of recordings currently being transcribed
  transcribingCount: number;
  // Real-time transcription
  realtimeTranscript: string;
  realtimeSessionId: string | null;
  // Id of the most recent recording in the debug-recordings log (dev mode);
  // read by the transcript pipeline to attach cleanup/recommendations later.
  lastDebugId: string | null;
}

function createRecordingStore() {
  const { subscribe, set, update } = writable<RecordingStore>({
    state: 'idle',
    transcript: '',
    error: null,
    audioData: null,
    stream: null,
    queue: [],
    transcribingCount: 0,
    realtimeTranscript: '',
    realtimeSessionId: null,
    lastDebugId: null,
  });

  let mediaRecorder: MediaRecorder | null = null;
  // Lease on the shared mic stream — released (never track-stopped) on stop/cancel.
  let micLease: MicLease | null = null;
  let audioChunks: Blob[] = [];
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let audioSource: MediaStreamAudioSourceNode | null = null; // Store source for proper cleanup
  let visualizationAnimationId: number | null = null;
  let recordingStartTime: number | null = null;

  // Real-time transcription state
  let realtimeAudioContext: AudioContext | null = null;
  let realtimeProcessor: ScriptProcessorNode | null = null;
  let realtimeSource: MediaStreamAudioSourceNode | null = null; // Store source for proper cleanup
  let realtimeUnlistenPartial: UnlistenFn | null = null;
  let realtimeUnlistenFinal: UnlistenFn | null = null;
  let realtimeUnlistenError: UnlistenFn | null = null;
  // Accumulated final text from real-time transcription (when accumulate_transcript is enabled)
  let realtimeAccumulatedText: string = '';
  // Every final segment of the current realtime session, kept regardless of the
  // accumulate_transcript display setting — source of truth when the
  // transcription mode (Realtime/Both) uses the realtime harvest as the transcript.
  let realtimeFinalSegments: string[] = [];
  // Flag to prevent double-triggering of voice commands
  let voiceCommandTriggered: boolean = false;
  // Flag to prevent concurrent realtime session starts
  let realtimeSessionStarting: boolean = false;
  // In-flight background realtime start (recording no longer awaits it).
  // Stop paths settle this first so they can't race a half-started session.
  let realtimeStartPromise: Promise<void> | null = null;

  async function settleRealtimeStart() {
    if (realtimeStartPromise) {
      try {
        await realtimeStartPromise;
      } catch {
        // Realtime start failures are already logged and non-fatal.
      }
    }
  }

  // Convert Float32 audio samples to Int16 for real-time transcription
  function convertFloat32ToInt16(float32Array: Float32Array): Int16Array {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
  }

  // Start real-time transcription session
  async function startRealtimeSession(stream: MediaStream, sessionId: string) {
    const currentSettings = get(settings);
    console.log('[recording] startRealtimeSession called', {
      sessionId,
      realtimeEnabled: currentSettings.vosk?.enabled,
    });
    // The realtime engine runs when it's enabled for live preview OR when the
    // transcription mode needs it to produce the final transcript (Realtime /
    // Both) — the enabled toggle only governs preview-only use in Whisper mode.
    const transcriptionMode = currentSettings.vosk?.transcription_mode ?? 'Both';
    const realtimeNeeded =
      (currentSettings.vosk?.enabled ?? false) || transcriptionMode !== 'Whisper';
    if (!realtimeNeeded) {
      console.log('[recording] Real-time transcription disabled, skipping');
      return;
    }

    // Prevent concurrent session starts
    if (realtimeSessionStarting) {
      console.log('[recording] Realtime session already starting, skipping');
      return;
    }
    realtimeSessionStarting = true;

    // Clean up any existing session first (guard against listener leaks);
    // joins a still-draining stop from the previous recording if there is one.
    await stopRealtimeSessionShared();

    // Reset voice command flag for new session
    voiceCommandTriggered = false;

    // Clear accumulated text FIRST before anything else
    realtimeAccumulatedText = '';
    realtimeFinalSegments = [];
    // Emit clear event immediately
    emit('realtime-transcript', { text: '' });

    try {
      // Create audio context at provider's required sample rate (16kHz)
      const sampleRate = currentSettings.vosk.provider === 'VoiceStreamAI'
        ? (currentSettings.vosk.voice_stream_ai?.sample_rate || 16000)
        : currentSettings.vosk.provider === 'SherpaOnnx'
          ? (currentSettings.vosk.sherpa_onnx?.sample_rate || 16000)
          : currentSettings.vosk.provider === 'Speaches'
            ? (currentSettings.vosk.speaches?.sample_rate || 16000)
        : currentSettings.vosk.provider === 'Moonshine'
            ? (currentSettings.vosk.moonshine?.sample_rate || 16000)
          : (currentSettings.vosk.sample_rate || 16000);
      realtimeAudioContext = new AudioContext({ sampleRate });
      realtimeSource = realtimeAudioContext.createMediaStreamSource(stream);

      // ScriptProcessor to extract PCM samples (4096 samples per buffer)
      realtimeProcessor = realtimeAudioContext.createScriptProcessor(4096, 1, 1);

      // Store sessionId in closure, but check if context is still valid before sending
      const contextRef = realtimeAudioContext;
      realtimeProcessor.onaudioprocess = (event) => {
        // Skip if context was closed (prevents zombie callbacks)
        if (contextRef.state === 'closed' || !realtimeProcessor) return;

        const float32Data = event.inputBuffer.getChannelData(0);
        const int16Data = convertFloat32ToInt16(float32Data);

        // Use non-blocking invoke with catch (don't await to prevent backpressure)
        invoke('send_realtime_audio', {
          sessionId,
          samples: Array.from(int16Data),
        }).catch((error) => {
          // Only log if context is still active
          if (contextRef.state !== 'closed') {
            console.error('Failed to send realtime audio:', error);
          }
        });
      };

      realtimeSource.connect(realtimeProcessor);
      // Connect to destination to keep processing active (required by ScriptProcessorNode)
      realtimeProcessor.connect(realtimeAudioContext.destination);

      // Listen for realtime events
      let lastPartialTime = Date.now();
      let lastPartialText = '';
      realtimeUnlistenPartial = await listen(`realtime-partial-${sessionId}`, (event: any) => {
        const partial = event.payload?.partial || '';

        const shouldAccumulate = currentSettings.vosk?.accumulate_transcript ?? false;
        // When accumulating, prepend accumulated text to partial
        const displayText = shouldAccumulate && realtimeAccumulatedText
          ? `${realtimeAccumulatedText} ${partial}`.trim()
          : partial;

        // Skip if displayText hasn't changed (avoid duplicate updates)
        if (displayText === lastPartialText) {
          return;
        }
        lastPartialText = displayText;

        const now = Date.now();
        const delta = now - lastPartialTime;
        lastPartialTime = now;

        console.log('[recording][partial]', {
          partial,
          deltaMs: delta,
          displayText,
        });

        update((s) => ({ ...s, realtimeTranscript: displayText }));
        emit('realtime-transcript', { text: displayText });

        // Check for voice commands in partial transcript for instant detection
        if (displayText && !voiceCommandTriggered) {
          const voiceCommandResult = processVoiceCommand(displayText);
          if (voiceCommandResult.commandDetected) {
            voiceCommandTriggered = true;
            console.log('[realtime] Voice command detected in partial:', voiceCommandResult.detectedCommand, 'type:', voiceCommandResult.commandType);
            emit('voice-command-triggered', {
              command: voiceCommandResult.detectedCommand,
              cleanedTranscript: voiceCommandResult.cleanedTranscript,
              originalTranscript: displayText,
              commandType: voiceCommandResult.commandType,
            });
          }
        }
      });

      realtimeUnlistenFinal = await listen(`realtime-final-${sessionId}`, (event: any) => {
        const text = event.payload?.text || '';
        console.log('[recording][final]', {
          raw: event.payload?.text,
          text,
          hasText: !!text,
        });
        if (text) {
          realtimeFinalSegments.push(text.trim());
          const shouldAccumulate = currentSettings.vosk?.accumulate_transcript ?? false;
          const prevAccumulated = realtimeAccumulatedText;
          if (shouldAccumulate) {
            // Append this final text to accumulated text
            realtimeAccumulatedText = realtimeAccumulatedText
              ? `${realtimeAccumulatedText} ${text}`.trim()
              : text;
          }
          const displayText = shouldAccumulate ? realtimeAccumulatedText : text;

          console.log('[recording][final] processed', {
            shouldAccumulate,
            prevAccumulated,
            newAccumulated: realtimeAccumulatedText,
            displayText,
          });

          update((s) => ({ ...s, realtimeTranscript: displayText }));
          emit('realtime-transcript', { text: displayText });

          // Check for voice commands in the accumulated/final transcript
          if (!voiceCommandTriggered) {
            const voiceCommandResult = processVoiceCommand(displayText);
            if (voiceCommandResult.commandDetected) {
              voiceCommandTriggered = true;
              console.log('[realtime] Voice command detected:', voiceCommandResult.detectedCommand, 'type:', voiceCommandResult.commandType);
              console.log('[realtime] Cleaned transcript:', voiceCommandResult.cleanedTranscript);
              // Emit event to trigger action (will be handled by +page.svelte)
              emit('voice-command-triggered', {
                command: voiceCommandResult.detectedCommand,
                cleanedTranscript: voiceCommandResult.cleanedTranscript,
                originalTranscript: displayText,
                commandType: voiceCommandResult.commandType,
              });
            }
          }
        }
      });

      realtimeUnlistenError = await listen(`realtime-error-${sessionId}`, (event: any) => {
        console.error('Realtime transcription error:', event.payload?.error);
      });

      // Start the realtime session on the backend
      console.log('[recording] Starting realtime backend session...');
      await invoke('start_realtime_session', { sessionId });
      console.log('[recording] Realtime backend session started, listening for events on:', `realtime-partial-${sessionId}`);

      update((s) => ({ ...s, realtimeSessionId: sessionId }));
    } catch (error) {
      console.error('Failed to start realtime session:', error);
      // Clean up on error
      await stopRealtimeSessionShared();
    } finally {
      realtimeSessionStarting = false;
    }
  }

  // Stop real-time transcription session. Returns the harvested full-session
  // transcript (all final segments + the eof-finalized tail returned by the
  // backend) — empty string when there was no session or it produced nothing.
  async function stopRealtimeSession(): Promise<string> {
    const currentState = get({ subscribe });
    const sessionId = currentState.realtimeSessionId;

    // Stop feeding audio first. Event listeners are deliberately kept alive
    // until AFTER the backend session stops: the engine often completes the
    // last line right as recording stops, and the poll loop's realtime-final
    // event for it may still be in flight — unlistening now would drop that
    // segment and cut the end off the harvested transcript.

    // Clean up audio processing - disconnect source first, then processor
    if (realtimeSource) {
      try {
        realtimeSource.disconnect();
      } catch (e) {
        // Ignore - may already be disconnected
      }
      realtimeSource = null;
    }
    if (realtimeProcessor) {
      try {
        realtimeProcessor.disconnect();
      } catch (e) {
        // Ignore - may already be disconnected
      }
      realtimeProcessor = null;
    }
    if (realtimeAudioContext) {
      try {
        // Check state before closing to avoid errors on already closed contexts
        if (realtimeAudioContext.state !== 'closed') {
          await realtimeAudioContext.close();
        }
      } catch (e) {
        console.warn('[recording] Error closing realtime audio context:', e);
      }
      realtimeAudioContext = null;
    }

    // Stop the backend session; finalize (eof) returns the tail text for audio
    // that hadn't produced a final segment yet.
    let tailText = '';
    if (sessionId) {
      try {
        tailText = (await invoke<string>('stop_realtime_session', { sessionId })) || '';
      } catch (error) {
        console.error('Failed to stop realtime session:', error);
      }
      // Grace period: let realtime-final events emitted just before/during the
      // stop finish delivering into realtimeFinalSegments.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    // Only now is it safe to detach the event listeners
    if (realtimeUnlistenPartial) {
      realtimeUnlistenPartial();
      realtimeUnlistenPartial = null;
    }
    if (realtimeUnlistenFinal) {
      realtimeUnlistenFinal();
      realtimeUnlistenFinal = null;
    }
    if (realtimeUnlistenError) {
      realtimeUnlistenError();
      realtimeUnlistenError = null;
    }

    const segments = [...realtimeFinalSegments];
    tailText = tailText.trim();
    // Some engines return an eof-final duplicating the already-emitted last
    // segment (e.g. the Moonshine shim's last partial) — skip exact repeats.
    if (tailText && tailText !== segments[segments.length - 1]) {
      segments.push(tailText);
    }
    const harvested = segments.join(' ').trim();

    // Clear accumulated text when session ends
    realtimeAccumulatedText = '';
    realtimeFinalSegments = [];
    update((s) => ({ ...s, realtimeSessionId: null, realtimeTranscript: '' }));
    return harvested;
  }

  // De-dupes concurrent stops: with the Whisper enqueue no longer waiting for
  // the realtime finalize, a new recording can start while the previous
  // session's harvest is still draining — its startRealtimeSession cleanup
  // must join that in-flight stop, not race it.
  let realtimeStopPromise: Promise<string> | null = null;
  function stopRealtimeSessionShared(): Promise<string> {
    if (!realtimeStopPromise) {
      realtimeStopPromise = stopRealtimeSession().finally(() => {
        realtimeStopPromise = null;
      });
    }
    return realtimeStopPromise;
  }

  function startVisualizationBroadcast(stream: MediaStream) {
    // Clean up any existing visualization first
    stopVisualizationBroadcastSync();

    try {
      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;

      audioSource = audioContext.createMediaStreamSource(stream);
      audioSource.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      function broadcastVisualization() {
        if (!analyser) return;

        analyser.getByteFrequencyData(dataArray);

        emit('audio-visualization', { data: Array.from(dataArray) });

        visualizationAnimationId = requestAnimationFrame(broadcastVisualization);
      }

      broadcastVisualization();
    } catch (error) {
      console.error('Failed to start visualization broadcast:', error);
    }
  }

  // Synchronous cleanup for visualization (used internally)
  function stopVisualizationBroadcastSync() {
    if (visualizationAnimationId !== null) {
      cancelAnimationFrame(visualizationAnimationId);
      visualizationAnimationId = null;
    }
    // Disconnect source before closing context
    if (audioSource) {
      try {
        audioSource.disconnect();
      } catch (e) {
        // Ignore - may already be disconnected
      }
      audioSource = null;
    }
    analyser = null;
  }

  async function stopVisualizationBroadcast() {
    stopVisualizationBroadcastSync();

    if (audioContext) {
      try {
        // Check state before closing to avoid errors on already closed contexts
        if (audioContext.state !== 'closed') {
          await audioContext.close();
        }
      } catch (e) {
        console.warn('[recording] Error closing visualization audio context:', e);
      }
      audioContext = null;
    }

    // Emit empty data to signal recording stopped
    emit('audio-visualization', { data: null });
  }

  // Generate a unique ID for queued recordings
  function generateId(): string {
    return `rec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Flag to track if queue processing is active
  let queueProcessing = false;

  // Process the next item in the transcription queue
  async function processQueue() {
    // Prevent concurrent processing
    if (queueProcessing) return;

    const currentState = get({ subscribe });

    // Find the next pending recording
    const pendingRecording = currentState.queue.find(r => r.status === 'pending');
    if (!pendingRecording) return;

    queueProcessing = true;

    // Mark it as transcribing
    update((s) => ({
      ...s,
      transcribingCount: s.transcribingCount + 1,
      queue: s.queue.map(r =>
        r.id === pendingRecording.id ? { ...r, status: 'transcribing' as const } : r
      ),
    }));

    try {
      const transcript = await invoke<string>('transcribe_audio', {
        audioData: Array.from(pendingRecording.audioData),
      });

      // Track transcription
      usageStats.trackTranscription();

      // Transcription settled successfully: the transcript is durable, drop the capture.
      if (pendingRecording.captureId) {
        invoke('delete_capture', { id: pendingRecording.captureId }).catch((e) =>
          console.warn('[recording] Failed to delete capture after success:', e)
        );
      }

      // Update the queue item as done
      update((s) => ({
        ...s,
        transcribingCount: s.transcribingCount - 1,
        queue: s.queue.map(r =>
          r.id === pendingRecording.id ? { ...r, status: 'done' as const, transcript } : r
        ),
      }));

      // Call the completion callback if provided
      if (pendingRecording.onComplete) {
        pendingRecording.onComplete(transcript);
      }

      // Emit event for the completed transcription
      emit('transcription-complete', { id: pendingRecording.id, transcript });

    } catch (error) {
      console.error('Failed to transcribe queued recording:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to transcribe';

      // The app is alive, so the caller's failure handler will salvage the in-memory
      // audio to the pile; the on-disk capture is only crash insurance — drop it now.
      if (pendingRecording.captureId) {
        invoke('delete_capture', { id: pendingRecording.captureId }).catch((e) =>
          console.warn('[recording] Failed to delete capture after error:', e)
        );
      }

      update((s) => ({
        ...s,
        transcribingCount: s.transcribingCount - 1,
        queue: s.queue.map(r =>
          r.id === pendingRecording.id ? { ...r, status: 'error' as const, error: errorMessage } : r
        ),
      }));

      // Emit error event
      emit('transcription-error', { id: pendingRecording.id, error: errorMessage });

      // Settle the caller's stopRecording(true) promise so the failure is handled
      // (routed to the pile) instead of silently hanging forever.
      if (pendingRecording.onError) {
        pendingRecording.onError(error instanceof Error ? error : new Error(errorMessage));
      }
    }

    queueProcessing = false;

    // Process the next item in the queue using queueMicrotask to avoid stack overflow
    queueMicrotask(() => processQueue());
  }

  return {
    subscribe,

    /** Mint a recording/debug id up-front so a caller can own it across the
     * async transcription window (pass it into stopRecording). */
    newRecordingId: generateId,

    async startRecording(deviceId?: string) {
      let stream: MediaStream | null = null;

      try {
        // Shared mic stream: when open mic (or a recent recording) already has
        // the device open, this returns instantly instead of re-acquiring it.
        micLease = await acquireMicStream(deviceId);
        stream = micLease.stream;
        mediaRecorder = new MediaRecorder(stream, {
          mimeType: 'audio/webm;codecs=opus',
        });
        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunks.push(event.data);
          }
        };

        mediaRecorder.start(100);
        recordingStartTime = Date.now();

        // Start broadcasting audio visualization data to all windows
        startVisualizationBroadcast(stream);

        // Audio is being captured — show 'recording' NOW. The realtime engine
        // connects in the background so the UI never waits on a WebSocket
        // handshake; its failure is non-fatal (recording works without it).
        emit('recording-state', { state: 'recording' });
        update((s) => ({ ...s, state: 'recording', error: null, transcript: '', realtimeTranscript: '', stream }));

        const realtimeSessionId = `rt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        realtimeStartPromise = startRealtimeSession(stream, realtimeSessionId)
          .catch((realtimeError) => {
            console.warn('[recording] Realtime session failed to start, continuing without real-time transcription:', realtimeError);
          })
          .finally(() => {
            realtimeStartPromise = null;
          });
      } catch (error) {
        console.error('Failed to start recording:', error);

        // Clean up any resources that were allocated before the error
        await stopVisualizationBroadcast();
        await stopRealtimeSessionShared();

        micLease?.release();
        micLease = null;
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          try {
            mediaRecorder.stop();
          } catch (e) {
            // Ignore
          }
        }
        mediaRecorder = null;
        audioChunks = [];

        update((s) => ({
          ...s,
          state: 'error',
          error: error instanceof Error ? error.message : 'Failed to start recording',
          stream: null,
        }));
      }
    },

    async stopRecording(
      autoTranscribe: boolean = true,
      providedDebugId?: string
    ): Promise<string | null> {
      return new Promise((resolve, reject) => {
        if (!mediaRecorder || mediaRecorder.state === 'inactive') {
          // Still need to clean up visualization and realtime transcription even if mediaRecorder is inactive
          stopVisualizationBroadcast().catch(console.error);
          settleRealtimeStart().then(() => stopRealtimeSessionShared()).catch(console.error);
          emit('recording-state', { state: 'idle' });
          resolve(null);
          return;
        }

        mediaRecorder.onstop = async () => {
          try {
            // Stop visualization broadcast after recording has stopped
            await stopVisualizationBroadcast();
          } catch (vizError) {
            console.warn('[recording] Error stopping visualization:', vizError);
          }

          // Transcription mode decides who produces the transcript:
          //  - Whisper:  harvest ignored, batch Whisper transcribes
          //  - Realtime: harvest IS the transcript; empty harvest = failure
          //  - Both:     BOTH run — Whisper is the primary transcript and the
          //              harvest is the dual-source secondary; harvest is the
          //              fallback only if Whisper is unreachable
          // Stable id shared by the on-disk capture, the transcription queue, and
          // the debug-recordings log so all stages of this one recording line up.
          // The caller may own the id (passed in) so it can attach later stages
          // (destination, LLM cleanup) without racing the mutable lastDebugId
          // store field across the async transcription window.
          const debugId = providedDebugId ?? generateId();
          update((s) => ({ ...s, lastDebugId: debugId }));

          const transcriptionMode = get(settings).vosk?.transcription_mode ?? 'Both';

          // Finalize the realtime engine in the BACKGROUND — its eof drain
          // takes up to ~1.5s and the Whisper request doesn't need the
          // harvest, so awaiting it here would delay every transcription.
          // The harvest is awaited only where it's actually consumed:
          // Realtime-only mode (it IS the transcript) and the 'Both'-mode
          // Whisper-failure fallback. Settling a still-connecting background
          // start first ensures we can't miss a session registering mid-stop.
          const harvestPromise: Promise<string> = (async () => {
            try {
              await settleRealtimeStart();
              return await stopRealtimeSessionShared();
            } catch (realtimeError) {
              console.warn('[recording] Error stopping realtime session:', realtimeError);
              return '';
            }
          })();
          // Debug log (dev mode): attach the raw harvest whenever it lands.
          const attachHarvestToDebugLog = () => {
            harvestPromise.then((harvest) => {
              if (harvest) debugRecordings.update(debugId, { voskTranscript: harvest });
            });
          };

          let durationMs: number | undefined;
          try {
            // Track recording duration
            if (recordingStartTime) {
              durationMs = Date.now() - recordingStartTime;
              usageStats.trackRecording(durationMs);
              recordingStartTime = null;
            }

            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            const arrayBuffer = await audioBlob.arrayBuffer();
            const audioData = new Uint8Array(arrayBuffer);

            // Clean up media resources immediately (release the shared stream,
            // never stop its tracks — open mic may still be using it)
            micLease?.release();
            micLease = null;
            mediaRecorder = null;
            audioChunks = [];

            if (autoTranscribe && transcriptionMode === 'Realtime') {
              // Realtime-only mode: the harvest IS the transcript — no capture
              // staging or Whisper round-trip — so this is the one mode that
              // must wait for the finalize. (In 'Both' mode we deliberately
              // fall through to the Whisper queue below so BOTH engines run and
              // the realtime harvest feeds the dual-source cleanup.)
              const harvestedTranscript = await harvestPromise;
              if (harvestedTranscript) {
                console.log('[recording] Realtime transcript used, skipping Whisper:', harvestedTranscript);
                usageStats.trackTranscription();
                update((s) => ({
                  ...s,
                  state: 'idle',
                  audioData,
                  stream: null,
                  transcript: harvestedTranscript,
                }));
                emit('recording-state', { state: 'idle' });
                emit('transcription-complete', { id: generateId(), transcript: harvestedTranscript });
                debugRecordings.capture({
                  id: debugId,
                  audioData,
                  durationMs,
                  transcriptionMode,
                  voskTranscript: harvestedTranscript,
                });
                resolve(harvestedTranscript);
              } else {
                // Empty harvest: there is no Whisper to fall back to, so
                // surface it as a transcription failure — the callers'
                // failure paths salvage the audio (pile).
                console.error('[recording] Realtime-only mode but the realtime harvest was empty');
                update((s) => ({ ...s, state: 'idle', audioData, stream: null }));
                emit('recording-state', { state: 'idle' });
                debugRecordings.capture({
                  id: debugId,
                  audioData,
                  durationMs,
                  transcriptionMode,
                  error: 'Real-time transcription produced no text',
                });
                reject(new Error(
                  'Real-time transcription produced no text (Realtime-only mode; is the live engine running?)'
                ));
              }
            } else if (autoTranscribe) {
              // Whisper / Both: queue the Whisper transcription IMMEDIATELY —
              // the realtime engine finalizes concurrently. Reuse debugId so the
              // capture, queue item and debug-log entry all share one id.
              const recordingId = debugId;

              // Debug log: record audio now; the harvest and Whisper/error
              // stages are attached as they land.
              debugRecordings.capture({
                id: debugId,
                audioData,
                durationMs,
                transcriptionMode,
              });
              attachHarvestToDebugLog();

              // Capture-first durability: stage the audio to disk BEFORE attempting
              // transcription so an app crash mid-transcribe can't lose the recording.
              // Best-effort — if staging fails we still transcribe (in-memory audio +
              // the pile salvage path keep it durable while the app is alive).
              let captureId: string | undefined = recordingId;
              try {
                await invoke('save_capture', {
                  id: recordingId,
                  audioData: Array.from(audioData),
                });
              } catch (captureError) {
                console.warn('[recording] Failed to stage recording capture:', captureError);
                captureId = undefined;
              }

              // Add to queue with callbacks that settle the promise
              update((s) => ({
                ...s,
                state: 'idle', // Go back to idle so new recordings can start
                audioData,
                stream: null,
                queue: [
                  ...s.queue,
                  {
                    id: recordingId,
                    audioData,
                    captureId,
                    status: 'pending',
                    onComplete: (transcript: string) => {
                      // Update the store with the transcript when done
                      update((s2) => ({ ...s2, transcript }));
                      debugRecordings.update(recordingId, { whisperTranscript: transcript });
                      resolve(transcript);
                    },
                    onError: async (transcriptionError: Error) => {
                      debugRecordings.update(recordingId, {
                        error: transcriptionError?.message || 'Transcription failed',
                      });
                      // 'Both' mode: Whisper is the primary transcript but a
                      // realtime harvest may be available — fall back to it
                      // rather than losing the recording to the pile when
                      // Whisper is unreachable. This is the only spot in the
                      // Whisper path that needs the harvest, so it alone waits
                      // for the finalize. ('Whisper' mode never uses it.)
                      const harvestedTranscript =
                        transcriptionMode !== 'Whisper' ? await harvestPromise : '';
                      if (harvestedTranscript) {
                        console.warn(
                          '[recording] Whisper failed in Both mode; falling back to realtime harvest:',
                          transcriptionError?.message
                        );
                        update((s2) => ({ ...s2, transcript: harvestedTranscript }));
                        resolve(harvestedTranscript);
                      } else {
                        reject(transcriptionError);
                      }
                    },
                  },
                ],
              }));

              // Emit that we're processing (for UI feedback)
              emit('recording-state', { state: 'processing' });

              // Start processing the queue if not already running
              processQueue();
            } else {
              update((s) => ({ ...s, state: 'recorded', audioData, stream: null }));
              emit('recording-state', { state: 'recorded' });
              debugRecordings.capture({
                id: debugId,
                audioData,
                durationMs,
                transcriptionMode,
              });
              attachHarvestToDebugLog();
              resolve(null);
            }
          } catch (error) {
            console.error('Failed to process recording:', error);
            update((s) => ({
              ...s,
              state: 'error',
              error: error instanceof Error ? error.message : 'Failed to process recording',
            }));
            emit('recording-state', { state: 'error' });
            reject(error);
          }
        };

        // Add a small delay before stopping to prevent audio cutoff
        const lingerMs = get(settings).audio.recording_linger_ms;
        if (lingerMs > 0) {
          setTimeout(() => {
            mediaRecorder?.stop();
          }, lingerMs);
        } else {
          mediaRecorder.stop();
        }
      });
    },

    async stopAndTranscribe(): Promise<string | null> {
      return this.stopRecording(true);
    },

    async stopOnly(): Promise<void> {
      await this.stopRecording(false);
    },

    async transcribeAndSend() {
      try {
        update((s) => ({ ...s, state: 'processing' }));

        let currentAudioData: Uint8Array | null = null;
        recording.subscribe((s) => {
          currentAudioData = s.audioData;
        })();

        if (!currentAudioData) {
          throw new Error('No audio data available');
        }

        const transcript = await invoke<string>('transcribe_audio', {
          audioData: Array.from(currentAudioData),
        });

        // Track transcription
        usageStats.trackTranscription();

        update((s) => ({
          ...s,
          state: 'idle',
          transcript,
          stream: null,
        }));

        return transcript;
      } catch (error) {
        console.error('Failed to transcribe:', error);
        update((s) => ({
          ...s,
          state: 'error',
          error: error instanceof Error ? error.message : 'Failed to transcribe audio',
        }));
        throw error;
      }
    },

    async cancelRecording() {
      stopVisualizationBroadcast();
      await settleRealtimeStart();
      await stopRealtimeSessionShared();
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
      micLease?.release();
      micLease = null;
      mediaRecorder = null;
      audioChunks = [];
      set({ state: 'idle', transcript: '', error: null, audioData: null, stream: null, queue: [], transcribingCount: 0, realtimeTranscript: '', realtimeSessionId: null, lastDebugId: null });
      emit('recording-state', { state: 'idle' });
    },

    // Clear completed/errored items from the queue
    clearCompletedFromQueue() {
      update((s) => ({
        ...s,
        queue: s.queue.filter(r => r.status === 'pending' || r.status === 'transcribing'),
      }));
    },

    // Get the current queue length (pending + transcribing)
    getQueueLength(): number {
      const state = get({ subscribe });
      return state.queue.filter(r => r.status === 'pending' || r.status === 'transcribing').length;
    },

    clearTranscript() {
      update((s) => ({ ...s, transcript: '' }));
    },

    clearError() {
      update((s) => ({ ...s, error: null }));
    },
  };
}

export const recording = createRecordingStore();

export const isRecording = derived(recording, ($recording) => $recording.state === 'recording');
export const isProcessing = derived(recording, ($recording) => $recording.state === 'processing');
export const hasRecorded = derived(recording, ($recording) => $recording.state === 'recorded');
export const hasError = derived(recording, ($recording) => $recording.state === 'error');

// Queue-related derived stores
export const transcriptionQueue = derived(recording, ($recording) => $recording.queue);
export const pendingTranscriptions = derived(recording, ($recording) =>
  $recording.queue.filter(r => r.status === 'pending' || r.status === 'transcribing').length
);
export const isTranscribing = derived(recording, ($recording) => $recording.transcribingCount > 0);
export const hasQueuedTranscriptions = derived(recording, ($recording) =>
  $recording.queue.some(r => r.status === 'pending' || r.status === 'transcribing')
);

// Real-time transcription
export const realtimeTranscript = derived(recording, ($recording) => $recording.realtimeTranscript);
export const hasRealtimeSession = derived(recording, ($recording) => $recording.realtimeSessionId !== null);
