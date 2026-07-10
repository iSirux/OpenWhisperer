/**
 * Cockpit continuous-capture manager.
 *
 * Mirrors the open-mic audio pipeline (`src/lib/stores/openMic.ts`):
 *   getUserMedia → AudioContext at the realtime provider's sample rate →
 *   ScriptProcessorNode → Float32→Int16 → RMS volume gate with pre-roll and
 *   hangover → `send_realtime_audio`, with its own realtime session id
 *   (`cockpit_voice`) so it never collides with open mic or recording sessions.
 *
 * Differences from open mic:
 * - No wake-word matching. Every provider FINAL is an utterance boundary and is
 *   handed to the registered `onUtterance` callback (non-empty, trimmed).
 * - Partials are exposed live via the `cockpitPartialTranscript` store for the
 *   cockpit command line.
 * - `setSuspended(true)` fully tears down the mic + backend realtime session
 *   (not just a mute): a regular recording owns getUserMedia and its own
 *   realtime session, and keeping ours alive would double-stream audio and
 *   fight the provider. Resume (`setSuspended(false)`) does a fresh start.
 *   State is kept as 'suspended' in between so the UI can show "yielded".
 *
 * Lifecycle contract with open mic: `start()` calls `openMic.stop()` first
 * (the two can't share the mic); after `stop()` we do NOT restart open mic —
 * the existing layout open-mic lifecycle effect recovers it.
 */

import { writable, derived, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { settings } from '$lib/stores/settings';
import { openMic } from '$lib/stores/openMic';

export type CockpitMicState = 'off' | 'starting' | 'listening' | 'suspended' | 'error';

interface CockpitMicStore {
  state: CockpitMicState;
  error: string | null;
}

/** Realtime session id dedicated to the cockpit voice channel. */
export const COCKPIT_VOICE_SESSION_ID = 'cockpit_voice';

/** Live partial transcript of the in-flight utterance (cleared on each final). */
export const cockpitPartialTranscript = writable<string>('');

function createCockpitMic() {
  const store = writable<CockpitMicStore>({ state: 'off', error: null });
  const { subscribe, update } = store;

  // --- audio pipeline handles (mirrors openMic.ts) ---
  let mediaStream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let audioSource: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let unlistenPartial: UnlistenFn | null = null;
  let unlistenFinal: UnlistenFn | null = null;
  let unlistenError: UnlistenFn | null = null;

  // Guard against concurrent start() calls
  let startPromise: Promise<void> | null = null;
  // True while the cockpit "wants" the mic (listening or suspended); used so
  // setSuspended(false) knows whether to restart.
  let engaged = false;

  // Pre-roll / hangover gate state (same constants as open mic: ~128ms each
  // at 16kHz with 256-sample buffers)
  const PRE_ROLL_BUFFERS = 8;
  const HANGOVER_BUFFERS = 8;
  let preRollBuffer: Int16Array[] = [];
  let wasAboveThreshold = false;
  let hangoverRemaining = 0;

  // Registered utterance sink (the controller wires this to the parser).
  let utteranceCallback: ((text: string) => void) | null = null;

  function convertFloat32ToInt16(float32Array: Float32Array): Int16Array {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16Array;
  }

  function calculateRMS(float32Array: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < float32Array.length; i++) {
      sum += float32Array[i] * float32Array[i];
    }
    return Math.sqrt(sum / float32Array.length);
  }

  /** Provider-specific sample rate (same selection as openMic.ts). */
  function providerSampleRate(): number {
    const s = get(settings);
    const vosk = s.vosk;
    return vosk.provider === 'VoiceStreamAI'
      ? (vosk.voice_stream_ai?.sample_rate || 16000)
      : vosk.provider === 'SherpaOnnx'
        ? (vosk.sherpa_onnx?.sample_rate || 16000)
        : vosk.provider === 'Speaches'
          ? (vosk.speaches?.sample_rate || 16000)
          : vosk.provider === 'Moonshine'
            ? (vosk.moonshine?.sample_rate || 16000)
            : (vosk.sample_rate || 16000);
  }

  /** Register the sink for finalized utterances. Replaces any previous one. */
  function onUtterance(cb: ((text: string) => void) | null): void {
    utteranceCallback = cb;
  }

  async function start(): Promise<void> {
    const current = get(store);
    if (current.state === 'listening' || current.state === 'starting') {
      return;
    }
    if (startPromise) {
      await startPromise;
      return;
    }

    const currentSettings = get(settings);
    if (!currentSettings.vosk?.enabled) {
      update((s) => ({
        ...s,
        state: 'error',
        error: 'Real-time transcription must be enabled for the cockpit mic',
      }));
      return;
    }

    engaged = true;

    // The cockpit and open mic can't share getUserMedia / the realtime channel.
    // The layout's open-mic lifecycle effect restores open mic after we stop.
    try {
      await openMic.stop();
    } catch (e) {
      console.warn('[cockpit-mic] Failed to stop open mic before start:', e);
    }

    // Reset gate + partial state
    preRollBuffer = [];
    wasAboveThreshold = false;
    hangoverRemaining = 0;
    cockpitPartialTranscript.set('');

    update((s) => ({ ...s, state: 'starting', error: null }));

    startPromise = (async () => {
      try {
        const deviceId = currentSettings.audio.device_id;
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        });

        audioContext = new AudioContext({ sampleRate: providerSampleRate() });
        audioSource = audioContext.createMediaStreamSource(mediaStream);

        // 256-sample buffers (~16ms at 16kHz) — same as open mic.
        processor = audioContext.createScriptProcessor(256, 1, 1);
        const contextRef = audioContext;

        processor.onaudioprocess = (event) => {
          if (contextRef.state === 'closed' || !processor) return;

          const float32Data = event.inputBuffer.getChannelData(0);
          const int16Data = convertFloat32ToInt16(float32Data);

          const rms = calculateRMS(float32Data);
          const threshold = get(settings).audio.open_mic.volume_threshold ?? 0.01;
          const isAboveThreshold = rms >= threshold;

          // Level event for the cockpit mic indicator.
          emit('cockpit-audio-level', { rms, threshold, isAboveThreshold });

          if (isAboveThreshold) {
            if (!wasAboveThreshold && preRollBuffer.length > 0) {
              for (const buffered of preRollBuffer) {
                invoke('send_realtime_audio', {
                  sessionId: COCKPIT_VOICE_SESSION_ID,
                  samples: Array.from(buffered),
                }).catch(() => {});
              }
              preRollBuffer = [];
            }
            invoke('send_realtime_audio', {
              sessionId: COCKPIT_VOICE_SESSION_ID,
              samples: Array.from(int16Data),
            }).catch(() => {});
            wasAboveThreshold = true;
            hangoverRemaining = HANGOVER_BUFFERS;
          } else if (hangoverRemaining > 0) {
            hangoverRemaining--;
            invoke('send_realtime_audio', {
              sessionId: COCKPIT_VOICE_SESSION_ID,
              samples: Array.from(int16Data),
            }).catch(() => {});
            if (hangoverRemaining === 0) {
              wasAboveThreshold = false;
            }
          } else {
            preRollBuffer.push(int16Data);
            if (preRollBuffer.length > PRE_ROLL_BUFFERS) {
              preRollBuffer.shift();
            }
            wasAboveThreshold = false;
          }
        };

        audioSource.connect(processor);
        processor.connect(audioContext.destination);

        // Partials → live command-line preview.
        let lastPartialText = '';
        unlistenPartial = await listen(
          `realtime-partial-${COCKPIT_VOICE_SESSION_ID}`,
          (event: any) => {
            const partial = event.payload?.partial || '';
            if (partial === lastPartialText) return;
            lastPartialText = partial;
            cockpitPartialTranscript.set(partial);
          }
        );

        // Finals → utterance boundary (provider-side endpointing).
        unlistenFinal = await listen(
          `realtime-final-${COCKPIT_VOICE_SESSION_ID}`,
          (event: any) => {
            const text = (event.payload?.text || '').trim();
            lastPartialText = '';
            cockpitPartialTranscript.set('');
            if (!text) return;
            console.log('[cockpit-mic][utterance]', text);
            try {
              utteranceCallback?.(text);
            } catch (e) {
              console.error('[cockpit-mic] onUtterance callback failed:', e);
            }
          }
        );

        unlistenError = await listen(
          `realtime-error-${COCKPIT_VOICE_SESSION_ID}`,
          (event: any) => {
            const message = event.payload?.error || 'Realtime transcription error';
            console.error('[cockpit-mic] Realtime error:', message);
            update((s) => ({ ...s, state: 'error', error: String(message) }));
          }
        );

        await invoke('start_realtime_session', { sessionId: COCKPIT_VOICE_SESSION_ID });

        update((s) => ({ ...s, state: 'listening', error: null }));
        console.log('[cockpit-mic] Listening');
      } catch (error) {
        console.error('[cockpit-mic] Failed to start:', error);
        engaged = false;
        update((s) => ({
          ...s,
          state: 'error',
          error: error instanceof Error ? error.message : 'Failed to start cockpit mic',
        }));
        await teardown();
      } finally {
        startPromise = null;
      }
    })();

    await startPromise;
  }

  /** Tear down the audio graph + backend session. Does NOT change `state`. */
  async function teardown(): Promise<void> {
    if (unlistenPartial) { unlistenPartial(); unlistenPartial = null; }
    if (unlistenFinal) { unlistenFinal(); unlistenFinal = null; }
    if (unlistenError) { unlistenError(); unlistenError = null; }

    preRollBuffer = [];
    wasAboveThreshold = false;
    hangoverRemaining = 0;
    cockpitPartialTranscript.set('');

    if (audioSource) {
      try { audioSource.disconnect(); } catch { /* already disconnected */ }
      audioSource = null;
    }
    if (processor) {
      try { processor.disconnect(); } catch { /* already disconnected */ }
      processor = null;
    }
    if (audioContext) {
      try {
        if (audioContext.state !== 'closed') {
          await audioContext.close();
        }
      } catch { /* ignore */ }
      audioContext = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }

    try {
      await invoke('stop_realtime_session', { sessionId: COCKPIT_VOICE_SESSION_ID });
    } catch {
      // Session may not exist — fine.
    }
  }

  async function stop(): Promise<void> {
    console.log('[cockpit-mic] Stopping');
    engaged = false;
    await teardown();
    update((s) => ({ ...s, state: 'off', error: null }));
    // Deliberately NOT restarting open mic here — the layout lifecycle
    // effect owns open-mic recovery.
  }

  /**
   * Yield the mic while a regular recording is active (and reclaim it after).
   * Suspension is a full teardown (see module doc); resume is a fresh start.
   */
  async function setSuspended(suspended: boolean): Promise<void> {
    const current = get(store);
    if (suspended) {
      if (!engaged || current.state === 'suspended') return;
      console.log('[cockpit-mic] Suspending (yielding mic)');
      await teardown();
      update((s) => ({ ...s, state: 'suspended' }));
    } else {
      if (!engaged || current.state !== 'suspended') return;
      console.log('[cockpit-mic] Resuming after suspension');
      // Flip to 'off' so start()'s state guard passes, then restart.
      update((s) => ({ ...s, state: 'off' }));
      await start();
    }
  }

  return {
    subscribe,
    start,
    stop,
    setSuspended,
    onUtterance,
  };
}

export const cockpitMic = createCockpitMic();

/** Convenience derived stores. */
export const cockpitMicState = derived(cockpitMic, ($m) => $m.state);
export const cockpitMicError = derived(cockpitMic, ($m) => $m.error);
export const isCockpitMicListening = derived(cockpitMic, ($m) => $m.state === 'listening');
