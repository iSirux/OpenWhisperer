/**
 * Composable for managing open mic lifecycle
 * Handles automatic start/stop based on settings and recording state
 */

import { openMic, isOpenMicListening, isOpenMicPaused } from '$lib/stores/openMic';
import { settings } from '$lib/stores/settings';
import { isRecording } from '$lib/stores/recording';
import { get } from 'svelte/store';

export function useOpenMicLifecycle() {
  let restartTimeout: ReturnType<typeof setTimeout> | null = null;
  let prevRecording = false;
  let prevRealtimeConfigFingerprint: string | null = null;
  let initialized = false;

  /**
   * Check conditions and manage open mic state
   * Should be called reactively when dependencies change
   */
  function update(
    openMicEnabled: boolean,
    realtimeEnabled: boolean,
    realtimeConfigFingerprint: string,
    currentlyRecording: boolean,
    currentlyListening: boolean,
    currentlyPaused: boolean
  ) {
    const realtimeConfigChanged =
      prevRealtimeConfigFingerprint !== null &&
      prevRealtimeConfigFingerprint !== realtimeConfigFingerprint;
    prevRealtimeConfigFingerprint = realtimeConfigFingerprint;

    // Detect recording state transition
    const recordingJustStopped = prevRecording && !currentlyRecording;
    prevRecording = currentlyRecording;

    // Clear any pending restart timeout if conditions change
    if (restartTimeout && (currentlyRecording || !openMicEnabled || !realtimeEnabled)) {
      clearTimeout(restartTimeout);
      restartTimeout = null;
    }

    if (openMicEnabled && realtimeEnabled) {
      if (currentlyRecording) {
        // Don't start while recording
      } else if (currentlyPaused) {
        // User manually paused - don't auto-start, respect their choice
      } else if (realtimeConfigChanged && currentlyListening) {
        // Provider/endpoint/sample-rate changed while listening - reconnect with new settings
        console.log('[open-mic] Realtime config changed, restarting open mic session');
        openMic.restart();
      } else if (recordingJustStopped) {
        // Recording just stopped - delay restart to ensure audio resources are released
        if (!currentlyListening && !restartTimeout) {
          console.log('[open-mic] Recording stopped, scheduling restart');
          restartTimeout = setTimeout(() => {
            restartTimeout = null;
            openMic.start();
          }, 500);
        }
      } else if (!currentlyListening) {
        // Not recording, not listening, not paused - start immediately
        openMic.start();
      }
    } else {
      // Stop if currently listening (but not if paused - user controls that)
      if (currentlyListening) {
        openMic.stop();
      }
    }
  }

  /**
   * Create a Svelte 5 effect that manages open mic lifecycle
   * Call this in a component's script to set up automatic management
   */
  function createEffect() {
    $effect(() => {
      const currentSettings = get(settings);
      const openMicEnabled = currentSettings.audio.open_mic.enabled;
      const realtimeEnabled = currentSettings.realtime?.enabled ?? false;
      const realtimeConfigFingerprint = JSON.stringify({
        provider: currentSettings.realtime?.provider ?? "Vosk",
        endpoint: currentSettings.realtime?.provider === "VoiceStreamAI"
          ? currentSettings.realtime?.voice_stream_ai?.endpoint
          : currentSettings.realtime?.provider === "SherpaOnnx"
            ? currentSettings.realtime?.sherpa_onnx?.endpoint
            : currentSettings.realtime?.provider === "Speaches"
              ? currentSettings.realtime?.speaches?.endpoint
              : currentSettings.realtime?.endpoint,
        sampleRate: currentSettings.realtime?.provider === "VoiceStreamAI"
          ? currentSettings.realtime?.voice_stream_ai?.sample_rate
          : currentSettings.realtime?.provider === "SherpaOnnx"
            ? currentSettings.realtime?.sherpa_onnx?.sample_rate
            : currentSettings.realtime?.provider === "Speaches"
              ? currentSettings.realtime?.speaches?.sample_rate
              : currentSettings.realtime?.sample_rate,
      });
      const recording = get(isRecording);
      const listening = get(isOpenMicListening);
      const paused = get(isOpenMicPaused);

      update(openMicEnabled, realtimeEnabled, realtimeConfigFingerprint, recording, listening, paused);
    });
  }

  /**
   * Try to restart open mic after a failed recording start
   * Respects paused state - won't restart if user manually paused
   */
  async function restartAfterError() {
    const currentSettings = get(settings);
    const paused = get(isOpenMicPaused);
    if (currentSettings.audio.open_mic.enabled && currentSettings.realtime?.enabled && !paused) {
      await openMic.start();
    }
  }

  /**
   * Stop open mic and clean up
   */
  function stop() {
    if (restartTimeout) {
      clearTimeout(restartTimeout);
      restartTimeout = null;
    }
    openMic.stop();
  }

  /**
   * Clean up resources
   */
  function cleanup() {
    if (restartTimeout) {
      clearTimeout(restartTimeout);
      restartTimeout = null;
    }
    openMic.stop();
  }

  return {
    update,
    createEffect,
    restartAfterError,
    stop,
    cleanup,
  };
}
