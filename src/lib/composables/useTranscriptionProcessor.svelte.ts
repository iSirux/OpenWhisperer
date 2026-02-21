/**
 * Composable for processing voice transcriptions
 * Handles cleanup, model/repo recommendations, and system prompt building
 */

import { settings } from '$lib/stores/settings';
import { sdkSessions, settingsToStoreThinking, type ThinkingLevel } from '$lib/stores/sdkSessions';
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
import { isAutoModel } from '$lib/utils/models';
import { get } from 'svelte/store';

// System prompt for voice-transcribed sessions
export const VOICE_TRANSCRIPTION_SYSTEM_PROMPT =
  "The user's prompt was recorded via voice and transcribed using speech-to-text. " +
  "There may be minor transcription errors such as homophones, missing punctuation, or misheard words. " +
  "Please interpret the intent behind the request even if there are small errors in the transcription.";

export interface ProcessedTranscript {
  /** Final cleaned transcript */
  transcript: string;
  /** Vosk transcript (if available), also cleaned */
  voskTranscript?: string;
  /** Whether a voice command was detected */
  commandDetected: boolean;
  /** The detected command (if any) */
  detectedCommand?: string;
  /** The type of command detected */
  commandType: VoiceCommandType;
  /** Whether the transcript is empty after processing */
  isEmpty: boolean;
}

export interface CleanupResult {
  /** Cleaned transcript */
  text: string;
  /** Whether cleanup was applied */
  wasCleanedUp: boolean;
  /** List of corrections made */
  corrections?: string[];
  /** Whether dual-source (Whisper + Vosk) cleanup was used */
  usedDualSource?: boolean;
}

export interface RepoRecommendation {
  repoIndex: number;
  reasoning: string;
  confidence: string;
}

export interface ModelRecommendation {
  modelId: string;
  reasoning: string;
  thinkingLevel?: ThinkingLevel;
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
  voskTranscript?: string
): ProcessedTranscript {
  const result = processVoiceCommand(whisperTranscript);
  let processedVosk = voskTranscript;

  // Also strip command from Vosk if detected
  if (voskTranscript && result.commandDetected && result.detectedCommand) {
    const voskResult = processVoiceCommand(voskTranscript);
    processedVosk = voskResult.cleanedTranscript;
  }

  if (result.commandDetected) {
    console.log('[voice-command] Detected:', result.detectedCommand, 'type:', result.commandType);
    console.log('[voice-command] Original:', whisperTranscript);
    console.log('[voice-command] Cleaned:', result.cleanedTranscript);
  }

  return {
    transcript: result.cleanedTranscript,
    voskTranscript: processedVosk,
    commandDetected: result.commandDetected,
    detectedCommand: result.detectedCommand ?? undefined,
    commandType: result.commandType,
    isEmpty: !result.cleanedTranscript.trim(),
  };
}

/**
 * Clean up a transcript using LLM
 */
export async function cleanupTranscript(
  transcript: string,
  voskTranscript?: string,
  repoContext?: string
): Promise<CleanupResult> {
  if (!isTranscriptionCleanupEnabled()) {
    return { text: transcript, wasCleanedUp: false };
  }

  try {
    const cleanupResult = await cleanTranscription(transcript, voskTranscript, repoContext);

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
    };
  } catch (error) {
    console.error('[llm] Transcription cleanup failed, using original:', error);
    return { text: transcript, wasCleanedUp: false };
  }
}

/**
 * Get model recommendation for a transcript
 */
export async function getModelRecommendation(
  transcript: string,
  enabledModels: string[]
): Promise<{ model: string; thinkingLevel: ThinkingLevel | null; recommendation?: ModelRecommendation }> {
  const currentSettings = get(settings);
  let model = currentSettings.default_model;
  let thinkingLevel = settingsToStoreThinking(currentSettings.default_thinking_level);
  const autoModelThinking = currentSettings.llm.features.auto_model_thinking;

  if (!isAutoModel(model)) {
    return { model, thinkingLevel };
  }

  // Apply auto model thinking setting when using auto model
  // This applies even if model recommendation is disabled
  if (autoModelThinking === 'off') {
    thinkingLevel = null;
  } else if (autoModelThinking === 'on') {
    thinkingLevel = 'on';
  }
  // 'dynamic' will let the LLM decide if recommendation is enabled

  if (!isModelRecommendationEnabled()) {
    // Auto selected but recommendation not enabled - fall back to first enabled model
    model = enabledModels[0] || 'claude-sonnet-4-5-20250929';
    console.log('[llm] Auto model selected but recommendation disabled, falling back to:', model);
    return { model, thinkingLevel };
  }

  try {
    const recommendation = await recommendModel(transcript);

    if (recommendation) {
      // Only use if the model is enabled
      if (enabledModels.includes(recommendation.modelId)) {
        model = recommendation.modelId;
        console.log('[llm] Auto selected model:', model, '-', recommendation.reasoning);
      } else {
        model = enabledModels[0] || 'claude-sonnet-4-5-20250929';
        console.log('[llm] Recommended model not enabled, falling back to:', model);
      }

      // Apply thinking level based on auto_model_thinking setting
      if (autoModelThinking === 'dynamic' && recommendation.thinkingLevel) {
        // Dynamic mode: use LLM recommendation
        thinkingLevel = recommendation.thinkingLevel as ThinkingLevel;
        console.log('[llm] Using recommended thinking level:', thinkingLevel);
      } else {
        // off/on mode: thinking level already set above
        console.log('[llm] Using auto_model_thinking setting:', autoModelThinking, '-> thinking:', thinkingLevel);
      }

      return {
        model,
        thinkingLevel,
        recommendation: {
          modelId: recommendation.modelId,
          reasoning: recommendation.reasoning,
          thinkingLevel: recommendation.thinkingLevel as ThinkingLevel | undefined,
        },
      };
    }
  } catch (error) {
    console.error('[llm] Model recommendation failed, falling back to default:', error);
  }

  // Fallback
  model = enabledModels[0] || 'claude-sonnet-4-5-20250929';
  console.log('[llm] No recommendation, falling back to:', model);
  return { model, thinkingLevel };
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
  voskTranscript: string | undefined,
  cleanedTranscript: string,
  wasCleanedUp: boolean,
  corrections?: string[],
  usedDualSource?: boolean
): void {
  sdkSessions.updatePendingTranscription(sessionId, {
    voskTranscript: voskTranscript || undefined,
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
      thinkingLevel: recommendation.thinkingLevel ?? undefined,
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
