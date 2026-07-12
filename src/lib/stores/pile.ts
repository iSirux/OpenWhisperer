/**
 * Recording pile store.
 *
 * The pile is an inbox of voice recordings captured for later: each item is a
 * transcribed (and LLM-processed) recording that the user can pick up, edit,
 * and turn into an SDK session whenever they're ready.
 *
 * Items are persisted to their own file via the `get_pile_items` /
 * `save_pile_items` Tauri commands (frontend owns the schema — the backend
 * stores opaque JSON). Audio is written to disk (`save_pile_audio`) so items
 * can be replayed and re-transcribed even after an app restart.
 */

import { writable, derived, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';

import { settings } from '$lib/stores/settings';
import { repos, activeRepo, isAutoRepoSelected, isRepoActive } from '$lib/stores/repos';
import type { EffortLevel, SdkImageContent } from '$lib/stores/sdkSessions';
import {
  cleanupTranscript,
  getModelRecommendation,
  getRepoRecommendation,
  buildAllReposContext,
} from '$lib/composables/useTranscriptionProcessor.svelte';
import { generateSessionName, isRepoAutoSelectEnabled } from '$lib/utils/llm';
import { debugRecordings } from '$lib/stores/debugRecordings';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PileItemStatus = 'transcribing' | 'processing' | 'ready' | 'error';

export interface PileItem {
  id: string;
  createdAt: number;
  status: PileItemStatus;
  /** LLM-generated short title (falls back to a transcript snippet in the UI) */
  title?: string;
  category?: string;
  /** Current prompt text (cleaned transcript, possibly user-edited) */
  transcript: string;
  /** Original Whisper transcript before cleanup/edits */
  rawTranscript?: string;
  realtimeTranscript?: string;
  wasCleanedUp?: boolean;
  cleanupCorrections?: string[];
  usedDualSource?: boolean;
  /** Stable repo ID (RepoConfig.id) chosen for this item */
  repoId?: string;
  repoConfidence?: string;
  repoReasoning?: string;
  model?: string;
  effortLevel?: EffortLevel;
  modelReasoning?: string;
  /** Path of the saved audio file on disk (informational; reads go through the id) */
  audioFilePath?: string;
  hasAudio?: boolean;
  recordingDurationMs?: number;
  audioVisualizationHistory?: number[][];
  transcriptionError?: string;
  /** Screenshot captured when the recording started (stored on disk; attached at launch) */
  hasScreenshot?: boolean;
  screenshotMediaType?: string;
  /** SDK session IDs launched from this item */
  linkedSessionIds?: string[];
  /** Toggleable prompt chips appended to the prompt when this item is launched */
  selectedChips?: string[];
  /** Debug-recordings log entry for the originating recording, so re-transcription
   *  and the LLM pipeline attach their stages to the log (no-op if evicted). */
  debugRecordingId?: string;
}

export interface AddRecordingInput {
  /** Whisper transcript — may be empty if transcription failed (audio-only item) */
  transcript: string;
  realtimeTranscript?: string;
  audioData?: Uint8Array;
  recordingDurationMs?: number;
  audioVisualizationHistory?: number[][];
  transcriptionError?: string;
  /** Screenshot captured when the recording started */
  screenshot?: SdkImageContent;
  /** Run the LLM pipeline (cleanup/repo/model/title). Default true. Set false
   *  when demoting an already-processed session — pass its results instead. */
  process?: boolean;
  rawTranscript?: string;
  wasCleanedUp?: boolean;
  cleanupCorrections?: string[];
  usedDualSource?: boolean;
  repoId?: string;
  repoConfidence?: string;
  repoReasoning?: string;
  model?: string;
  effortLevel?: EffortLevel;
  title?: string;
  /** Debug-recordings log entry for this recording, so the background LLM
   *  pipeline can attach its cleanup stage to the log. */
  debugRecordingId?: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function createPileStore() {
  const { subscribe, set, update } = writable<PileItem[]>([]);

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
      await invoke('save_pile_items', { items: get({ subscribe }) });
    } catch (error) {
      console.error('[pile] Failed to save pile items:', error);
    }
  }

  async function load() {
    try {
      const items = await invoke<PileItem[]>('get_pile_items');
      // Recover items stuck in a transient state from a previous app run
      set(
        items.map((item) =>
          item.status === 'transcribing' || item.status === 'processing'
            ? { ...item, status: item.transcript?.trim() ? 'ready' : 'error' }
            : item
        )
      );
      loaded = true;
    } catch (error) {
      console.error('[pile] Failed to load pile items:', error);
    }

    // Recover recordings interrupted mid-transcription by a previous app crash:
    // their audio was staged to the capture buffer but never transcribed. Materialize
    // each as a retriable audio-only error item, then clear the capture buffer.
    try {
      const captureIds = await invoke<string[]>('list_captures');
      for (const captureId of captureIds) {
        try {
          const audioData = await invoke<number[]>('read_capture', { id: captureId });
          addRecording({
            audioData: new Uint8Array(audioData),
            transcript: '',
            transcriptionError: 'Recording recovered after interruption',
          });
        } catch (error) {
          console.error('[pile] Failed to recover capture', captureId, error);
        } finally {
          invoke('delete_capture', { id: captureId }).catch(() => {});
        }
      }
    } catch (error) {
      console.error('[pile] Failed to list captures for recovery:', error);
    }
  }

  function updateItem(id: string, updates: Partial<PileItem>) {
    update((items) => items.map((item) => (item.id === id ? { ...item, ...updates } : item)));
    schedulePersist();
  }

  function getItem(id: string): PileItem | undefined {
    return get({ subscribe }).find((item) => item.id === id);
  }

  async function removeItem(id: string) {
    const item = getItem(id);
    update((items) => items.filter((i) => i.id !== id));
    schedulePersist();

    if (item?.hasAudio) {
      try {
        await invoke('delete_pile_audio', { id });
      } catch (error) {
        console.error('[pile] Failed to delete pile audio:', error);
      }
    }

    if (item?.hasScreenshot) {
      try {
        await invoke('delete_pile_screenshot', { id });
      } catch (error) {
        console.error('[pile] Failed to delete pile screenshot:', error);
      }
    }
  }

  function linkSession(id: string, sessionId: string) {
    const item = getItem(id);
    if (!item) return;
    const linked = item.linkedSessionIds || [];
    if (!linked.includes(sessionId)) {
      updateItem(id, { linkedSessionIds: [...linked, sessionId] });
    }
  }

  // -------------------------------------------------------------------------
  // LLM processing pipeline
  // -------------------------------------------------------------------------

  function getActiveReposList() {
    return get(repos).list.filter(isRepoActive);
  }

  /**
   * Run the full processing pipeline on an item: cleanup → repo rec → model
   * rec → title. Each step is best-effort; the item always ends 'ready'.
   */
  async function processItem(id: string, debugRecordingId?: string) {
    const item = getItem(id);
    if (!item || !item.transcript.trim()) return;

    updateItem(id, { status: 'processing' });

    const currentSettings = get(settings);
    const activeReposList = getActiveReposList();
    const rawTranscript = item.rawTranscript ?? item.transcript;
    let finalTranscript = rawTranscript;

    // Step 1: transcription cleanup
    try {
      const repoContext = buildAllReposContext(activeReposList);
      const cleanupResult = await cleanupTranscript(rawTranscript, item.realtimeTranscript, repoContext);
      finalTranscript = cleanupResult.text;
      updateItem(id, {
        transcript: finalTranscript,
        wasCleanedUp: cleanupResult.wasCleanedUp,
        cleanupCorrections: cleanupResult.corrections,
        usedDualSource: cleanupResult.usedDualSource,
      });
      if (debugRecordingId) {
        debugRecordings.update(debugRecordingId, {
          cleanedTranscript: finalTranscript,
          wasCleanedUp: cleanupResult.wasCleanedUp,
          cleanupCorrections: cleanupResult.corrections,
          usedDualSource: cleanupResult.usedDualSource,
        });
      }
    } catch (error) {
      console.error('[pile] Cleanup failed:', error);
    }

    // Step 2: repo recommendation (auto-repo mode) or current active repo
    try {
      if (get(isAutoRepoSelected) && isRepoAutoSelectEnabled() && activeReposList.length > 1) {
        const recommendation = await getRepoRecommendation(finalTranscript, activeReposList);
        if (recommendation) {
          const repo = get(repos).list[recommendation.repoIndex];
          if (repo) {
            updateItem(id, {
              repoId: repo.id,
              repoConfidence: recommendation.confidence,
              repoReasoning: recommendation.reasoning,
            });
          }
        }
      } else if (!getItem(id)?.repoId) {
        const repo = get(activeRepo);
        if (repo?.id) updateItem(id, { repoId: repo.id });
      }
    } catch (error) {
      console.error('[pile] Repo recommendation failed:', error);
    }

    // Step 3: model recommendation (honors Auto model + effort settings)
    try {
      const { model, effortLevel, recommendation } = await getModelRecommendation(
        finalTranscript,
        currentSettings.enabled_models
      );
      updateItem(id, {
        model,
        effortLevel: effortLevel ?? undefined,
        modelReasoning: recommendation?.reasoning,
      });
    } catch (error) {
      console.error('[pile] Model recommendation failed:', error);
    }

    // Step 4: auto-title (reuses the session-naming feature)
    try {
      const nameResult = await generateSessionName(finalTranscript);
      if (nameResult) {
        updateItem(id, { title: nameResult.name, category: nameResult.category });
      }
    } catch (error) {
      console.error('[pile] Title generation failed:', error);
    }

    updateItem(id, { status: 'ready' });
  }

  // -------------------------------------------------------------------------
  // Capture entry points
  // -------------------------------------------------------------------------

  /**
   * Add a finished recording to the pile and process it in the background.
   * Returns the new item's ID.
   */
  function addRecording(input: AddRecordingInput): string {
    const id = crypto.randomUUID();
    const hasTranscript = !!input.transcript?.trim();
    const shouldProcess = input.process !== false;

    const item: PileItem = {
      id,
      createdAt: Date.now(),
      status: hasTranscript ? (shouldProcess ? 'processing' : 'ready') : 'error',
      title: input.title,
      transcript: input.transcript || '',
      rawTranscript: input.rawTranscript ?? (input.transcript || undefined),
      realtimeTranscript: input.realtimeTranscript,
      wasCleanedUp: input.wasCleanedUp,
      cleanupCorrections: input.cleanupCorrections,
      usedDualSource: input.usedDualSource,
      repoId: input.repoId,
      repoConfidence: input.repoConfidence,
      repoReasoning: input.repoReasoning,
      model: input.model,
      effortLevel: input.effortLevel,
      recordingDurationMs: input.recordingDurationMs,
      audioVisualizationHistory: input.audioVisualizationHistory,
      transcriptionError: hasTranscript
        ? undefined
        : input.transcriptionError || 'No transcription returned',
      hasAudio: !!input.audioData,
      hasScreenshot: !!input.screenshot,
      screenshotMediaType: input.screenshot?.mediaType,
      debugRecordingId: input.debugRecordingId,
    };

    update((items) => [item, ...items]);
    schedulePersist();

    // Save audio to disk in the background (enables replay + re-transcription)
    if (input.audioData) {
      const audioArray = Array.from(input.audioData);
      invoke<string>('save_pile_audio', { id, audioData: audioArray })
        .then((path) => updateItem(id, { audioFilePath: path }))
        .catch((error) => {
          console.error('[pile] Failed to save pile audio:', error);
          updateItem(id, { hasAudio: false });
        });
    }

    // Save screenshot to disk in the background (attached to the prompt at launch)
    if (input.screenshot) {
      invoke('save_pile_screenshot', { id, base64Data: input.screenshot.base64Data })
        .catch((error) => {
          console.error('[pile] Failed to save pile screenshot:', error);
          updateItem(id, { hasScreenshot: false, screenshotMediaType: undefined });
        });
    }

    if (hasTranscript) {
      if (shouldProcess) {
        void processItem(id, input.debugRecordingId);
      } else if (!input.title) {
        void generateTitle(id);
      }
    }

    return id;
  }

  /** Generate a title/category for an item without re-running the full pipeline. */
  async function generateTitle(id: string) {
    const item = getItem(id);
    if (!item?.transcript.trim()) return;
    try {
      const nameResult = await generateSessionName(item.transcript);
      if (nameResult) {
        updateItem(id, { title: nameResult.name, category: nameResult.category });
      }
    } catch (error) {
      console.error('[pile] Title generation failed:', error);
    }
  }

  /** Re-transcribe an item from its stored audio, then re-run processing. */
  async function retranscribe(id: string) {
    const item = getItem(id);
    if (!item?.hasAudio) return;

    updateItem(id, { status: 'transcribing', transcriptionError: undefined });

    try {
      const audioData = await invoke<number[]>('read_pile_audio', { id });
      const transcript = await invoke<string>('transcribe_audio', { audioData });

      if (transcript?.trim()) {
        updateItem(id, {
          transcript,
          rawTranscript: transcript,
          transcriptionError: undefined,
        });
        if (item.debugRecordingId) {
          debugRecordings.update(item.debugRecordingId, {
            whisperTranscript: transcript,
            error: undefined,
          });
        }
        await processItem(id, item.debugRecordingId);
      } else {
        updateItem(id, { status: 'error', transcriptionError: 'No transcription returned' });
      }
    } catch (error) {
      console.error('[pile] Re-transcription failed:', error);
      updateItem(id, {
        status: 'error',
        transcriptionError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Retry transcription for every failed item that still has audio, one at a time.
   * Sequential so we don't hammer a recovering service or fight the single-flight
   * transcription path; continues through all items so partial recovery works even
   * if some still fail. Returns a summary.
   */
  async function retryAllFailed(): Promise<{
    attempted: number;
    succeeded: number;
    failed: number;
  }> {
    const targets = get({ subscribe }).filter(
      (item) => item.status === 'error' && item.hasAudio
    );
    if (targets.length === 0) return { attempted: 0, succeeded: 0, failed: 0 };

    let succeeded = 0;
    let failed = 0;
    pileRetryingAll.set(true);
    try {
      for (const target of targets) {
        await retranscribe(target.id);
        const updated = getItem(target.id);
        if (updated && updated.status !== 'error') succeeded += 1;
        else failed += 1;
      }
    } finally {
      pileRetryingAll.set(false);
    }

    return { attempted: targets.length, succeeded, failed };
  }

  /** Read an item's screenshot from disk as an attachable image (null if missing). */
  async function getScreenshotImage(id: string): Promise<SdkImageContent | null> {
    const item = getItem(id);
    if (!item?.hasScreenshot) return null;
    try {
      const base64Data = await invoke<string>('read_pile_screenshot', { id });
      return {
        mediaType: (item.screenshotMediaType || 'image/jpeg') as SdkImageContent['mediaType'],
        base64Data,
        source: 'screenshot',
      };
    } catch (error) {
      console.error('[pile] Failed to read pile screenshot:', error);
      return null;
    }
  }

  /** Remove an item's screenshot (user decided it's irrelevant). */
  async function removeScreenshot(id: string) {
    updateItem(id, { hasScreenshot: false, screenshotMediaType: undefined });
    try {
      await invoke('delete_pile_screenshot', { id });
    } catch (error) {
      console.error('[pile] Failed to delete pile screenshot:', error);
    }
  }

  /** Read an item's audio from disk as a playable blob URL (caller revokes). */
  async function getAudioUrl(id: string): Promise<string | null> {
    const item = getItem(id);
    if (!item?.hasAudio) return null;
    try {
      const audioData = await invoke<number[]>('read_pile_audio', { id });
      const blob = new Blob([new Uint8Array(audioData)], { type: 'audio/webm' });
      return URL.createObjectURL(blob);
    } catch (error) {
      console.error('[pile] Failed to read pile audio:', error);
      return null;
    }
  }

  return {
    subscribe,
    load,
    persist,
    isLoaded: () => loaded,
    addRecording,
    processItem,
    retranscribe,
    retryAllFailed,
    updateItem,
    getItem,
    removeItem,
    linkSession,
    getAudioUrl,
    getScreenshotImage,
    removeScreenshot,
  };
}

/** True while a "retry all failed" run is in progress (drives the retry-all button). */
export const pileRetryingAll = writable(false);

export const pile = createPileStore();

/** Number of failed items that still have audio and can be retried. */
export const failedRetriableCount = derived(
  pile,
  ($pile) => $pile.filter((item) => item.status === 'error' && item.hasAudio).length
);

/** Currently selected pile item (shown in the main pane). */
export const selectedPileItemId = writable<string | null>(null);

export const selectedPileItem = derived(
  [pile, selectedPileItemId],
  ([$pile, $id]) => ($id ? $pile.find((item) => item.id === $id) ?? null : null)
);

/** Which tab the session sidebar shows. */
export const sidebarTab = writable<'sessions' | 'pile'>('sessions');

export const pileCount = derived(pile, ($pile) => $pile.length);

/** Short display title for a pile item (LLM title or transcript snippet). */
export function pileItemTitle(item: PileItem): string {
  if (item.title) return item.title;
  const text = item.transcript?.trim();
  if (!text) return 'Untitled recording';
  return text.length > 60 ? text.slice(0, 60) + '…' : text;
}
