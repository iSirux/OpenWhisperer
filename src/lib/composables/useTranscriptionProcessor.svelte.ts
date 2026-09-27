/**
 * Composable for processing voice transcriptions
 * Handles cleanup, model/repo recommendations, and system prompt building
 */

import { normalizeAutoModelEffort, settings } from '$lib/stores/settings';
import { sdkSessions, settingsToStoreEffort, type EffortLevel } from '$lib/stores/sdkSessions';
import {
  cleanTranscription,
  recommendModel,
  recommendRepo,
  getRepoConfirmationSystemPrompt,
  isTranscriptionCleanupEnabled,
  isModelRecommendationEnabled,
  isRepoAutoSelectEnabled,
  needsUserConfirmation,
  buildRepoContextForCleanup,
  buildAllReposContextForCleanup,
} from '$lib/utils/llm';
import { processVoiceCommand, type VoiceCommandType } from '$lib/utils/voiceCommands';
import { isAutoModel, normalizeOpenAiModelId } from '$lib/utils/models';
import { effectiveTiers, type TierOptions } from '$lib/utils/autoModelTiers';
import { get } from 'svelte/store';

// System prompt for voice-transcribed sessions
export const VOICE_TRANSCRIPTION_SYSTEM_PROMPT =
  "The user's prompt was recorded via voice and transcribed using speech-to-text. " +
  "There may be minor transcription errors such as homophones, missing punctuation, or misheard words. " +
  "Please interpret the intent behind the request even if there are small errors in the transcription.";

// System prompt notifying agents about parallel work on the same branch/repo
export const PARALLEL_AGENT_SYSTEM_PROMPT =
  '<system-message>\n' +
  'You may not be the only agent working on this codebase right now. ' +
  'Other AI agents may be running simultaneously on the same branch or repository. ' +
  'Before making changes, check the current state of files you plan to modify. ' +
  'Be aware that files may have changed since the start of this conversation. ' +
  "If you encounter unexpected changes or merge conflicts, they may be from another agent's work.\n" +
  '</system-message>';

export interface ProcessedTranscript {
  /** Final cleaned transcript */
  transcript: string;
  /** Real-time transcript (if available), also cleaned */
  realtimeTranscript?: string;
  /** Whether a voice command was detected */
  commandDetected: boolean;
  /** The detected command (if any) */
  detectedCommand?: string;
  /** The type of command detected */
  commandType: VoiceCommandType;
  /** Whether the transcript is empty after processing */
  isEmpty: boolean;
  /** Whether the command should trigger running a sequence */
  shouldRunSequence?: boolean;
  /** Whether the command should approve a pending approval */
  shouldApprove?: boolean;
  /** Whether the command should reject a pending approval */
  shouldReject?: boolean;
  /** Sequence name extracted from the transcript (for sequence commands) */
  sequenceName?: string;
}

export interface CleanupResult {
  /** Cleaned transcript */
  text: string;
  /** Whether cleanup was applied */
  wasCleanedUp: boolean;
  /** List of corrections made */
  corrections?: string[];
  /** Whether dual-source (Whisper + realtime) cleanup was used */
  usedDualSource?: boolean;
  durationMs?: number;
  profile?: string;
  provider?: string;
  model?: string;
  attempts?: number;
}

export interface RepoRecommendation {
  repoIndex: number;
  reasoning: string;
  confidence: string;
}

export interface ModelRecommendation {
  modelId: string;
  reasoning: string;
  effortLevel?: EffortLevel;
  /** @deprecated Use effortLevel */
  thinkingLevel?: EffortLevel;
  /** Auto-model complexity grade (1-10) that the tier ladder resolved */
  complexity?: number;
}

export interface SystemPromptOptions {
  repoPath: string;
  repoName: string;
  includeTranscriptionNotice: boolean;
  allRepos: Array<{ path: string; name: string }>;
}

/**
 * Process voice commands from a transcript
 */
export function processVoiceCommands(
  whisperTranscript: string,
  realtimeTranscript?: string
): ProcessedTranscript {
  const result = processVoiceCommand(whisperTranscript);
  let processedRealtime = realtimeTranscript;

  // Also strip command from the realtime transcript if detected
  if (realtimeTranscript && result.commandDetected && result.detectedCommand) {
    const realtimeResult = processVoiceCommand(realtimeTranscript);
    processedRealtime = realtimeResult.cleanedTranscript;
  }

  if (result.commandDetected) {
    console.log('[voice-command] Detected:', result.detectedCommand, 'type:', result.commandType);
    console.log('[voice-command] Original:', whisperTranscript);
    console.log('[voice-command] Cleaned:', result.cleanedTranscript);
  }

  return {
    transcript: result.cleanedTranscript,
    realtimeTranscript: processedRealtime,
    commandDetected: result.commandDetected,
    detectedCommand: result.detectedCommand ?? undefined,
    commandType: result.commandType,
    isEmpty: !result.cleanedTranscript.trim(),
    shouldRunSequence: result.shouldRunSequence,
    shouldApprove: result.shouldApprove,
    shouldReject: result.shouldReject,
    sequenceName: result.sequenceName,
  };
}

/**
 * Clean up a transcript using LLM
 */
export async function cleanupTranscript(
  transcript: string,
  realtimeTranscript?: string,
  repoContext?: string
): Promise<CleanupResult> {
  if (!isTranscriptionCleanupEnabled()) {
    return { text: transcript, wasCleanedUp: false };
  }

  try {
    const cleanupResult = await cleanTranscription(transcript, realtimeTranscript, repoContext);

    if (cleanupResult.wasCleanedUp) {
      console.log(
        '[llm] Transcription cleaned up:',
        cleanupResult.corrections,
        cleanupResult.usedDualSource ? '(dual-source)' : ''
      );
    }

    return {
      text: cleanupResult.text,
      wasCleanedUp: cleanupResult.wasCleanedUp,
      corrections: cleanupResult.corrections,
      usedDualSource: cleanupResult.usedDualSource,
      durationMs: cleanupResult.durationMs,
      profile: cleanupResult.profile,
      provider: cleanupResult.provider,
      model: cleanupResult.model,
      attempts: cleanupResult.attempts,
    };
  } catch (error) {
    console.error('[llm] Transcription cleanup failed, using original:', error);
    return { text: transcript, wasCleanedUp: false };
  }
}

/**
 * Resolve the Auto model for a transcript: the LLM grades complexity (1-10)
 * and the tier ladder (utils/autoModelTiers.ts) picks model + effort.
 *
 * @param opts.provider Pass the session's provider when the session already
 *   exists (it can switch model but not provider); omit for new sessions,
 *   whose provider follows the resolved model.
 */
export async function getModelRecommendation(
  transcript: string,
  enabledModels: string[],
  opts: TierOptions = {}
): Promise<{ model: string; effortLevel: EffortLevel | null; recommendation?: ModelRecommendation }> {
  const currentSettings = get(settings);
  let model = currentSettings.default_model;
  let effortLevel: EffortLevel = settingsToStoreEffort(currentSettings.default_effort_level);
  const autoModelEffort = normalizeAutoModelEffort(
    currentSettings.llm.features.auto_model_effort ?? currentSettings.llm.features.auto_model_thinking
  );

  if (!isAutoModel(model)) {
    return { model, effortLevel };
  }

  // Apply auto model effort setting when using auto model
  // This applies even if model recommendation is disabled
  if (autoModelEffort !== 'dynamic') {
    effortLevel = autoModelEffort as EffortLevel;
  }
  // 'dynamic' will let the LLM decide if recommendation is enabled

  // Without a score, fall back to the ladder's bottom rung (cheapest tier).
  const fallback = () => {
    const bottom = effectiveTiers(currentSettings, opts)[0];
    return bottom?.model || enabledModels[0] || 'claude-sonnet-5';
  };

  if (!isModelRecommendationEnabled()) {
    model = fallback();
    console.log('[llm] Auto model selected but recommendation disabled, falling back to:', model);
    return { model, effortLevel };
  }

  try {
    // recommendModel resolves the tier and already applies a fixed
    // auto_model_effort over the tier's effort.
    const recommendation = await recommendModel(transcript, opts);

    // Same guard as SdkView: only accept a model that is still enabled
    // (settings may have changed; the ladder already filters, this is defense).
    if (
      recommendation &&
      !currentSettings.enabled_models.map(normalizeOpenAiModelId).includes(recommendation.modelId)
    ) {
      console.warn('[llm] Recommended model not in enabled_models, falling back:', recommendation.modelId);
    } else if (recommendation) {
      model = recommendation.modelId;
      // The resolved tier's effort is authoritative (already overridden by a
      // fixed auto_model_effort in recommendModel): null means "no effort"
      // (off), never "fall back to default_effort_level".
      effortLevel = (recommendation.effortLevel ?? null) as EffortLevel;
      console.log(
        `[llm] Auto selected model: ${model} (complexity ${recommendation.complexity}, effort ${effortLevel ?? 'none'}) -`,
        recommendation.reasoning
      );

      return {
        model,
        effortLevel,
        recommendation: {
          modelId: recommendation.modelId,
          reasoning: recommendation.reasoning,
          effortLevel: effortLevel ?? undefined,
          complexity: recommendation.complexity,
        },
      };
    }
  } catch (error) {
    console.error('[llm] Model recommendation failed, falling back to default:', error);
  }

  model = fallback();
  console.log('[llm] No recommendation, falling back to:', model);
  return { model, effortLevel };
}

/**
 * Get repository recommendation for a transcript
 */
export async function getRepoRecommendation(
  transcript: string,
  repos: Array<{ path: string; name: string }>
): Promise<RepoRecommendation | null> {
  if (repos.length <= 1 || !isRepoAutoSelectEnabled()) {
    return null;
  }

  try {
    // Pass isTranscribed=true since this is from voice transcription
    const recommendation = await recommendRepo(transcript, true);

    if (!recommendation) {
      console.log('[llm] No repo recommendation returned');
      return null;
    }

    return recommendation;
  } catch (error) {
    console.error('[llm] Repo recommendation failed:', error);
    return null;
  }
}

/**
 * Check if repo recommendation needs user confirmation
 */
export function repoNeedsConfirmation(confidence: string): boolean {
  return needsUserConfirmation(confidence);
}

/**
 * Build system prompt for a session
 */
export function buildSystemPrompt(options: SystemPromptOptions): string | undefined {
  const parts: string[] = [];
  const currentSettings = get(settings);

  // Add parallel agent notification if enabled
  if (currentSettings.notify_parallel_agents) {
    parts.push(PARALLEL_AGENT_SYSTEM_PROMPT);
  }

  // Add voice transcription notice if applicable
  const needsTranscriptionNotice =
    options.includeTranscriptionNotice &&
    currentSettings.audio.include_transcription_notice &&
    !isTranscriptionCleanupEnabled();

  if (needsTranscriptionNotice) {
    parts.push(VOICE_TRANSCRIPTION_SYSTEM_PROMPT);
  }

  // Add repo confirmation prompt if applicable
  const otherRepoNames = options.allRepos
    .filter(r => r.path !== options.repoPath)
    .map(r => r.name);

  const repoConfirmationPrompt = getRepoConfirmationSystemPrompt(options.repoName, otherRepoNames);
  if (repoConfirmationPrompt) {
    parts.push(repoConfirmationPrompt);
  }

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * Build repo context for transcription cleanup using all repos
 */
export function buildAllReposContext(repos: Array<{ path: string; name: string; description?: string }>): string | undefined {
  return buildAllReposContextForCleanup(repos);
}

/**
 * Build repo context for a single repo
 */
export function buildSingleRepoContext(repo: { path: string; name: string; description?: string }): string | undefined {
  return buildRepoContextForCleanup(repo);
}

/**
 * Update pending session with cleanup results
 */
export function updatePendingWithCleanup(
  sessionId: string,
  realtimeTranscript: string | undefined,
  cleanedTranscript: string,
  wasCleanedUp: boolean,
  corrections?: string[],
  usedDualSource?: boolean
): void {
  sdkSessions.updatePendingTranscription(sessionId, {
    realtimeTranscript: realtimeTranscript || undefined,
    cleanedTranscript,
    wasCleanedUp,
    cleanupCorrections: corrections,
    usedDualSource,
  });
}

/**
 * Update pending session with model recommendation
 */
export function updatePendingWithModelRecommendation(
  sessionId: string,
  recommendation: ModelRecommendation
): void {
  sdkSessions.updatePendingTranscription(sessionId, {
    modelRecommendation: {
      modelId: recommendation.modelId,
      reasoning: recommendation.reasoning,
      effortLevel: recommendation.effortLevel ?? undefined,
      complexity: recommendation.complexity,
    },
  });
}

/**
 * Update pending session with repo recommendation
 */
export function updatePendingWithRepoRecommendation(
  sessionId: string,
  recommendation: RepoRecommendation,
  repoName: string
): void {
  sdkSessions.updatePendingTranscription(sessionId, {
    repoRecommendation: {
      repoIndex: recommendation.repoIndex,
      repoName,
      reasoning: recommendation.reasoning,
      confidence: recommendation.confidence,
    },
  });
}
