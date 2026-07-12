/**
 * Debug recordings log store.
 *
 * A bounded, "rolling" log of the most recent recordings, captured purely for
 * debugging. For every recording it keeps the audio plus all transcription
 * stages — realtime, Whisper raw, and the LLM cleanup result — so a
 * developer can replay the audio and inspect exactly what each stage produced.
 *
 * The list is trimmed to the {@link MAX_RECORDINGS} newest entries; audio for
 * evicted entries is deleted from disk so storage stays bounded. Metadata is
 * persisted via the `get_debug_recordings` / `save_debug_recordings` Tauri
 * commands (frontend owns the schema); audio via `save_debug_audio`.
 */

import { writable, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';

import type { EffortLevel } from '$lib/stores/sdkSessions';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Maximum number of recordings kept in the rolling log. */
export const MAX_RECORDINGS = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DebugRecording {
  id: string;
  /** Epoch ms when the recording stopped. */
  createdAt: number;
  /** Recording length in ms, if known. */
  durationMs?: number;
  /** Transcription mode in effect ('Whisper' | 'Realtime' | 'Both'). */
  transcriptionMode?: string;
  /** Where the recording was headed ('send' | 'prepare' | 'pile' | ...). */
  destination?: string;

  hasAudio?: boolean;
  audioFilePath?: string;

  /** Whisper batch transcription (raw). */
  whisperTranscript?: string;
  /** Real-time harvest. */
  realtimeTranscript?: string;
  /** LLM-cleaned transcript. */
  cleanedTranscript?: string;
  wasCleanedUp?: boolean;
  cleanupCorrections?: string[];
  usedDualSource?: boolean;

  /** Recommendations (when the LLM layer ran). */
  model?: string;
  effortLevel?: EffortLevel;
  modelReasoning?: string;
  repoName?: string;
  repoConfidence?: string;
  repoReasoning?: string;

  /** Set when transcription failed; the audio is still saved. */
  error?: string;
}

/** Fields accepted when first capturing a recording. */
export interface CaptureInput {
  id: string;
  audioData?: Uint8Array;
  durationMs?: number;
  transcriptionMode?: string;
  destination?: string;
  whisperTranscript?: string;
  realtimeTranscript?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function createDebugRecordingsStore() {
  const { subscribe, set, update } = writable<DebugRecording[]>([]);

  let loaded = false;
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;

  function schedulePersist() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(persist, 500);
  }

  async function persist() {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    try {
      await invoke('save_debug_recordings', { items: get({ subscribe }) });
    } catch (error) {
      console.error('[debug-recordings] Failed to save:', error);
    }
  }

  async function load() {
    try {
      const diskItems = await invoke<DebugRecording[]>('get_debug_recordings');
      // MERGE disk into memory instead of replacing: in-memory entries are newer
      // than disk (persistence is debounced), so replacing would (a) revert
      // late-arriving stage patches like the LLM cleanup when the tab mounts
      // mid-flight, and (b) before first load, let a fresh run's persist wipe
      // the previous runs' entries from the file.
      const evicted: string[] = [];
      update((memory) => {
        const memoryIds = new Set(memory.map((i) => i.id));
        const merged = [...memory, ...diskItems.filter((i) => !memoryIds.has(i.id))];
        merged.sort((a, b) => b.createdAt - a.createdAt);
        while (merged.length > MAX_RECORDINGS) {
          const removed = merged.pop();
          if (removed?.id) evicted.push(removed.id);
        }
        return merged;
      });
      if (evicted.length) deleteAudio(evicted);
      loaded = true;
      schedulePersist();
    } catch (error) {
      console.error('[debug-recordings] Failed to load:', error);
    }
  }

  /** Delete on-disk audio for the given ids (best-effort). */
  function deleteAudio(ids: string[]) {
    for (const id of ids) {
      invoke('delete_debug_audio', { id }).catch(() => {});
    }
  }

  /**
   * Record a new recording (newest first). Trims the list to MAX_RECORDINGS
   * and deletes evicted audio. The audio is saved to disk in the background.
   */
  function capture(input: CaptureInput) {
    // Pull older runs' entries off disk before the debounced persist replaces
    // the file, so a fresh app run doesn't wipe the existing log. The merge in
    // load() keeps this just-captured entry (memory wins by id).
    if (!loaded) void load();

    const entry: DebugRecording = {
      id: input.id,
      createdAt: Date.now(),
      durationMs: input.durationMs,
      transcriptionMode: input.transcriptionMode,
      destination: input.destination,
      whisperTranscript: input.whisperTranscript,
      realtimeTranscript: input.realtimeTranscript,
      error: input.error,
      hasAudio: !!input.audioData && input.audioData.length > 0,
    };

    const evicted: string[] = [];
    update((items) => {
      const next = [entry, ...items.filter((i) => i.id !== entry.id)];
      while (next.length > MAX_RECORDINGS) {
        const removed = next.pop();
        if (removed?.id) evicted.push(removed.id);
      }
      return next;
    });
    if (evicted.length) deleteAudio(evicted);

    if (input.audioData && input.audioData.length > 0) {
      invoke<string>('save_debug_audio', {
        id: entry.id,
        audioData: Array.from(input.audioData),
      })
        .then((path) => patch(entry.id, { audioFilePath: path }))
        .catch((error) => console.error('[debug-recordings] Failed to save audio:', error));
    }

    schedulePersist();
  }

  /**
   * Merge a patch into an existing recording (e.g. Whisper result, cleanup,
   * recommendations arriving later). No-op if the id is unknown. Does not
   * create entries.
   */
  function patch(id: string, updates: Partial<DebugRecording>) {
    let found = false;
    update((items) =>
      items.map((item) => {
        if (item.id !== id) return item;
        found = true;
        return { ...item, ...updates };
      })
    );
    if (found) schedulePersist();
  }

  /** Read a recording's audio from disk as a playable blob URL (caller revokes). */
  async function getAudioUrl(id: string): Promise<string | null> {
    try {
      const audioData = await invoke<number[]>('read_debug_audio', { id });
      const blob = new Blob([new Uint8Array(audioData)], { type: 'audio/webm' });
      return URL.createObjectURL(blob);
    } catch (error) {
      console.error('[debug-recordings] Failed to read audio:', error);
      return null;
    }
  }

  /** Clear the entire log, deleting all audio from disk. */
  async function clear() {
    const ids = get({ subscribe }).map((i) => i.id);
    set([]);
    deleteAudio(ids);
    await persist();
  }

  return {
    subscribe,
    load,
    isLoaded: () => loaded,
    capture,
    update: patch,
    getAudioUrl,
    clear,
  };
}

export const debugRecordings = createDebugRecordingsStore();
