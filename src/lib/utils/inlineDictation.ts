import { get } from 'svelte/store';
import { recording } from '$lib/stores/recording';
import { debugRecordings } from '$lib/stores/debugRecordings';
import { settings } from '$lib/stores/settings';
import { isTranscriptionCleanupEnabled } from '$lib/utils/llm';
import {
  cleanupTranscript,
  buildSingleRepoContext,
} from '$lib/composables/useTranscriptionProcessor.svelte';

interface RepoLike {
  path: string;
  name: string;
  description?: string;
}

/**
 * start/stop controls for hold-to-record dictation that drive the global
 * recording store directly and apply LLM transcription cleanup (dual-source when
 * a realtime transcript is available). For prompt inputs that don't already own
 * a record -> transcribe pipeline (pile detail, prepared/approval editors).
 *
 * Pair with the `holdSpaceRecord` action, which handles the Space gesture and
 * inserts the returned transcript at the caret.
 *
 * @param getRepo optional accessor for the repo in context, used to bias cleanup.
 */
export function makeInlineDictation(getRepo?: () => RepoLike | undefined) {
  return {
    start: (): Promise<void> =>
      recording.startRecording(get(settings).audio.device_id || undefined),

    async stop(): Promise<string | null> {
      // Capture the realtime/Vosk transcript before stopping clears it.
      const voskTranscript = get(recording).realtimeTranscript || '';

      // Own the debug-recordings id so the LLM cleanup stage lands in the log.
      const debugId = recording.newRecordingId();

      let raw: string | null;
      try {
        raw = await recording.stopRecording(true, debugId);
      } catch (err) {
        // Transcription failed; the store already surfaced the error. There is
        // no live conversation to salvage into here, so just drop it.
        console.error('[inlineDictation] Transcription failed:', err);
        recording.clearError();
        return null;
      }

      debugRecordings.update(debugId, { destination: 'dictation' });

      if (!raw || !raw.trim() || !isTranscriptionCleanupEnabled()) return raw;

      const repo = getRepo?.();
      const repoContext = repo ? buildSingleRepoContext(repo) : undefined;
      try {
        const result = await cleanupTranscript(raw, voskTranscript, repoContext);
        debugRecordings.update(debugId, {
          cleanedTranscript: result.text,
          wasCleanedUp: result.wasCleanedUp,
          cleanupCorrections: result.corrections,
          usedDualSource: result.usedDualSource,
        });
        return result.text;
      } catch (err) {
        console.error('[inlineDictation] Cleanup failed, using raw transcript:', err);
        return raw;
      }
    },
  };
}
