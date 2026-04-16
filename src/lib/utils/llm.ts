import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { settings } from '$lib/stores/settings';
import { repos } from '$lib/stores/repos';
import type { SessionAiMetadata, SdkMessage } from '$lib/stores/sdkSessions';

export interface SessionNameResult {
  name: string;
  category: string;
}

export interface SessionOutcomeResult {
  outcome: string;
}

export interface InteractionAnalysis {
  needs_interaction: boolean;
  reason: string | null;
  urgency: string;
  waiting_for: string | null;
}

export interface TranscriptionCleanupResult {
  cleaned_text: string;
  corrections_made: string[];
}

export interface ModelRecommendation {
  recommended_model: 'haiku' | 'sonnet' | 'opus';
  reasoning: string;
  confidence: 'low' | 'medium' | 'high';
  suggested_effort: 'null' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  /** @deprecated Use suggested_effort */
  suggested_thinking?: 'null' | 'on' | null;
}

export interface RepoRecommendation {
  /** The index of the recommended repository (0-based), or -1 if no clear match */
  recommended_index: number;
  /** The name of the recommended repository, or empty string if no clear match */
  recommended_name: string;
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
}

export interface QuickAction {
  prompt: string;
}

export interface QuickActionsResult {
  actions: QuickAction[];
}

/**
 * Check if LLM features are enabled
 */
export function isLlmEnabled(): boolean {
  const currentSettings = get(settings);
  return currentSettings.llm?.enabled ?? false;
}

// Alias for backwards compatibility
export const isGeminiEnabled = isLlmEnabled;

/**
 * Check if auto-naming is enabled
 */
export function isAutoNamingEnabled(): boolean {
  const currentSettings = get(settings);
  return (currentSettings.llm?.enabled && currentSettings.llm?.features?.auto_name_sessions) ?? false;
}

/**
 * Check if interaction detection is enabled
 */
export function isInteractionDetectionEnabled(): boolean {
  const currentSettings = get(settings);
  return (currentSettings.llm?.enabled && currentSettings.llm?.features?.detect_interaction_needed) ?? false;
}

/**
 * Check if transcription cleanup is enabled
 */
export function isTranscriptionCleanupEnabled(): boolean {
  const currentSettings = get(settings);
  return (currentSettings.llm?.enabled && currentSettings.llm?.features?.clean_transcription) ?? false;
}

/**
 * Check if dual-source transcription cleanup is enabled (using both Vosk and Whisper)
 */
export function isDualTranscriptionEnabled(): boolean {
  const currentSettings = get(settings);
  return (
    isTranscriptionCleanupEnabled() &&
    currentSettings.llm?.features?.use_dual_transcription &&
    currentSettings.vosk?.enabled
  ) ?? false;
}

/**
 * Check if model recommendation is enabled
 */
export function isModelRecommendationEnabled(): boolean {
  const currentSettings = get(settings);
  return (currentSettings.llm?.enabled && currentSettings.llm?.features?.recommend_model) ?? false;
}

/**
 * Check if auto-select repository is enabled
 */
export function isRepoAutoSelectEnabled(): boolean {
  const currentSettings = get(settings);
  return (currentSettings.llm?.enabled && currentSettings.llm?.features?.auto_select_repo) ?? false;
}

/**
 * Check if repo confirmation is enabled (Claude will question wrong repo selections)
 */
export function isRepoConfirmationEnabled(): boolean {
  const currentSettings = get(settings);
  return (
    isRepoAutoSelectEnabled() && currentSettings.llm?.confirm_repo_selection
  ) ?? false;
}

/**
 * Check if quick actions generation is enabled
 */
export function isQuickActionsEnabled(): boolean {
  const currentSettings = get(settings);
  return (currentSettings.llm?.enabled && currentSettings.llm?.features?.generate_quick_actions) ?? false;
}

/**
 * Get the minimum confidence level required for auto-selection
 */
export function getMinAutoSelectConfidence(): string {
  const currentSettings = get(settings);
  return currentSettings.llm?.min_auto_select_confidence ?? 'high';
}

/**
 * Check if confidence level meets the minimum threshold for auto-selection
 * Returns true if user confirmation is needed (confidence below threshold)
 */
export function needsUserConfirmation(confidence: string): boolean {
  if (!isRepoAutoSelectEnabled()) return false;

  const minConfidence = getMinAutoSelectConfidence();
  const confidenceOrder = { low: 1, medium: 2, high: 3 };

  const actualConfidence = confidenceOrder[confidence as keyof typeof confidenceOrder] ?? 0;
  const requiredConfidence = confidenceOrder[minConfidence as keyof typeof confidenceOrder] ?? 3;

  // Need confirmation if actual confidence is below the required minimum
  return actualConfidence < requiredConfidence;
}

/**
 * Build repo context string for transcription cleanup.
 * Returns a string with the repo name, description, keywords, and vocabulary.
 */
export function buildRepoContextForCleanup(repo: {
  name: string;
  description?: string;
  keywords?: string[];
  vocabulary?: string[];
}): string {
  const parts: string[] = [`Repository: ${repo.name}`];

  if (repo.description) {
    parts.push(`Description: ${repo.description}`);
  }

  if (repo.keywords && repo.keywords.length > 0) {
    parts.push(`Keywords: ${repo.keywords.join(', ')}`);
  }

  if (repo.vocabulary && repo.vocabulary.length > 0) {
    parts.push(`Vocabulary (project-specific terms that may be spoken): ${repo.vocabulary.join(', ')}`);
  }

  return parts.join('\n');
}

/**
 * Build combined context from ALL repos for transcription cleanup.
 * Aggregates vocabulary and keywords from all repos for better recognition.
 */
export function buildAllReposContextForCleanup(repos: Array<{
  name: string;
  description?: string;
  keywords?: string[];
  vocabulary?: string[];
}>): string | undefined {
  if (!repos || repos.length === 0) return undefined;

  // Collect all unique vocabulary and keywords from all repos
  const allVocabulary = new Set<string>();
  const allKeywords = new Set<string>();
  const repoNames: string[] = [];

  for (const repo of repos) {
    repoNames.push(repo.name);
    if (repo.vocabulary) {
      repo.vocabulary.forEach(v => allVocabulary.add(v));
    }
    if (repo.keywords) {
      repo.keywords.forEach(k => allKeywords.add(k));
    }
  }

  // Only return context if we have vocabulary or keywords
  if (allVocabulary.size === 0 && allKeywords.size === 0) return undefined;

  const parts: string[] = [`Projects: ${repoNames.join(', ')}`];

  if (allKeywords.size > 0) {
    parts.push(`Keywords: ${Array.from(allKeywords).join(', ')}`);
  }

  if (allVocabulary.size > 0) {
    parts.push(`Vocabulary (project-specific terms that may be spoken): ${Array.from(allVocabulary).join(', ')}`);
  }

  return parts.join('\n');
}

/**
 * Generate a session name from the user's prompt (called immediately when prompt is sent)
 */
export async function generateSessionName(
  userPrompt: string
): Promise<SessionNameResult | null> {
  if (!isAutoNamingEnabled()) {
    return null;
  }

  try {
    const result = await invoke<SessionNameResult>('generate_session_name', {
      userPrompt,
    });
    return result;
  } catch (error) {
    console.error('[llm] Failed to generate session name:', error);
    return null;
  }
}

/**
 * Generate a session outcome after the session completes
 */
export async function generateSessionOutcome(
  userPrompt: string,
  assistantMessages: string
): Promise<SessionOutcomeResult | null> {
  if (!isAutoNamingEnabled()) {
    return null;
  }

  try {
    const result = await invoke<SessionOutcomeResult>('generate_session_outcome', {
      userPrompt,
      assistantMessages,
    });
    return result;
  } catch (error) {
    console.error('[llm] Failed to generate session outcome:', error);
    return null;
  }
}

/**
 * Analyze if the last message needs human interaction
 */
export async function analyzeInteractionNeeded(
  lastMessage: string
): Promise<InteractionAnalysis | null> {
  if (!isInteractionDetectionEnabled()) {
    return null;
  }

  try {
    const result = await invoke<InteractionAnalysis>('analyze_interaction_needed', {
      lastMessage,
    });
    return result;
  } catch (error) {
    console.error('[llm] Failed to analyze interaction needed:', error);
    return null;
  }
}

/**
 * Clean up a voice transcription using the LLM integration
 * Returns the original text if cleanup is disabled or fails
 * @param whisperTranscription - The Whisper transcription (primary source)
 * @param voskTranscription - Optional Vosk real-time transcription (secondary source for comparison)
 * @param repoContext - Optional repo context (description + keywords) to help with cleanup
 */
export async function cleanTranscription(
  whisperTranscription: string,
  voskTranscription?: string,
  repoContext?: string
): Promise<{ text: string; wasCleanedUp: boolean; corrections: string[]; usedDualSource: boolean }> {
  if (!isTranscriptionCleanupEnabled()) {
    return { text: whisperTranscription, wasCleanedUp: false, corrections: [], usedDualSource: false };
  }

  // Only pass Vosk transcription if dual-source is enabled
  const voskToUse = isDualTranscriptionEnabled() ? voskTranscription : undefined;

  try {
    const result = await invoke<TranscriptionCleanupResult>('clean_transcription', {
      rawTranscription: whisperTranscription,
      voskTranscription: voskToUse || null,
      repoContext: repoContext || null,
    });
    console.log('[llm] Transcription cleaned:', result.corrections_made, voskToUse ? '(dual-source)' : '(whisper only)');
    return {
      text: result.cleaned_text,
      wasCleanedUp: result.corrections_made.length > 0,
      corrections: result.corrections_made,
      usedDualSource: !!voskToUse,
    };
  } catch (error) {
    console.error('[llm] Failed to clean transcription:', error);
    // Fall back to original text on error
    return { text: whisperTranscription, wasCleanedUp: false, corrections: [], usedDualSource: false };
  }
}

/**
 * Model ID mapping from LLM recommendation to actual model IDs
 */
const MODEL_ID_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
};

/**
 * Effort level mapping from LLM recommendation
 * Maps effort level suggestions to standard values
 */
const EFFORT_LEVEL_MAP: Record<string, string | null> = {
  null: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  // Legacy mappings from old thinking system
  on: 'high',
  think: 'high',
  megathink: 'xhigh',
  ultrathink: 'max',
};

/**
 * Recommend the best model for a prompt using the LLM integration
 * Returns null if recommendation is disabled or fails
 */
export async function recommendModel(
  prompt: string
): Promise<{
  modelId: string;
  effortLevel: string | null;
  /** @deprecated Use effortLevel */
  thinkingLevel: string | null;
  reasoning: string;
  confidence: string;
} | null> {
  if (!isModelRecommendationEnabled()) {
    return null;
  }

  try {
    // Get enabled models from settings
    const currentSettings = get(settings);
    const enabledModels = currentSettings.enabled_models || [];

    const result = await invoke<ModelRecommendation>('recommend_model', {
      prompt,
      enabledModels: enabledModels.length > 0 ? enabledModels : null
    });
    console.log('[llm] Model recommendation:', result);

    const modelId = MODEL_ID_MAP[result.recommended_model] || MODEL_ID_MAP.sonnet;

    // Prefer suggested_effort, fall back to suggested_thinking for backward compat
    const rawEffort = result.suggested_effort ?? result.suggested_thinking;
    const effortLevel = rawEffort
      ? EFFORT_LEVEL_MAP[rawEffort] ?? null
      : null;

    return {
      modelId,
      effortLevel,
      thinkingLevel: effortLevel, // Backward compat alias
      reasoning: result.reasoning,
      confidence: result.confidence,
    };
  } catch (error) {
    console.error('[llm] Failed to recommend model:', error);
    return null;
  }
}

/**
 * Recommend the best repository for a prompt using the LLM integration
 * Returns null if recommendation is disabled or fails
 * @param prompt The user's prompt
 * @param isTranscribed Whether the prompt was transcribed from voice (helps LLM understand potential errors)
 */
export async function recommendRepo(
  prompt: string,
  isTranscribed: boolean = false
): Promise<{
  repoIndex: number;
  repoName: string;
  reasoning: string;
  confidence: string;
} | null> {
  if (!isRepoAutoSelectEnabled()) {
    return null;
  }

  // Check if we have multiple active repos configured
  const currentSettings = get(settings);
  const activeRepos = get(repos).list.filter((r) => r.active !== false);
  if (activeRepos.length <= 1) {
    // No need to recommend if there's only 0 or 1 active repo
    return null;
  }

  // Check if any active repos have descriptions
  const hasDescriptions = activeRepos.some((r) => r.description);
  if (!hasDescriptions) {
    console.log('[llm] No repo descriptions found, skipping auto-select');
    return null;
  }

  try {
    const result = await invoke<RepoRecommendation>('recommend_repo', { prompt, isTranscribed });
    console.log('[llm] Repo recommendation:', result);

    // -1 index or empty name means no clear match
    if (result.recommended_index < 0 || result.recommended_name === '') {
      return null;
    }

    return {
      repoIndex: result.recommended_index,
      repoName: result.recommended_name,
      reasoning: result.reasoning,
      confidence: result.confidence,
    };
  } catch (error) {
    console.error('[llm] Failed to recommend repo:', error);
    return null;
  }
}

/**
 * Generate contextual quick actions based on the session's final message
 * Returns null if the feature is disabled or fails
 */
export async function generateQuickActions(
  userPrompt: string,
  lastMessage: string
): Promise<QuickAction[] | null> {
  if (!isQuickActionsEnabled()) {
    return null;
  }

  try {
    const result = await invoke<QuickActionsResult>('generate_quick_actions', {
      userPrompt,
      lastMessage,
    });
    console.log('[llm] Quick actions generated:', result.actions);
    return result.actions;
  } catch (error) {
    console.error('[llm] Failed to generate quick actions:', error);
    return null;
  }
}

/**
 * Generate a system prompt that instructs Claude to question the repo selection if it seems wrong
 * @param repoName The name of the selected repository
 * @param otherRepos List of other available repositories
 */
export function getRepoConfirmationSystemPrompt(
  repoName: string,
  otherRepos: string[]
): string {
  if (!isRepoConfirmationEnabled() || otherRepos.length === 0) {
    return '';
  }

  return `
IMPORTANT: The user's request was auto-routed to the "${repoName}" repository. If the request seems unrelated to this repository or would be better suited for a different project (other available repos: ${otherRepos.join(', ')}), please briefly ask the user to confirm before proceeding. Only question if you're reasonably confident the routing may be incorrect.
`.trim();
}

/**
 * Extract the first user prompt from messages
 */
export function extractFirstUserPrompt(messages: SdkMessage[]): string | null {
  for (const msg of messages) {
    if (msg.type === 'user' && msg.content) {
      return msg.content;
    }
  }
  return null;
}

/**
 * Extract assistant text messages, preferring newer messages when truncating
 * Returns messages in reverse order (newest first) for truncation to preserve recent context
 */
export function extractAssistantMessages(messages: SdkMessage[], maxLength: number = 2000): string {
  const textMessages = messages
    .filter((msg) => msg.type === 'text' && msg.content)
    .map((msg) => msg.content!);

  // Start from the end (newest) and work backwards
  let result = '';
  for (let i = textMessages.length - 1; i >= 0; i--) {
    const msg = textMessages[i];
    const separator = result ? '\n\n---\n\n' : '';
    const candidate = msg + separator + result;

    if (candidate.length > maxLength) {
      // If we haven't added anything yet, take what we can from this message
      if (!result) {
        result = msg.slice(-maxLength);
      }
      break;
    }
    result = candidate;
  }

  return result;
}

/**
 * Extract the last assistant message from the session
 */
export function extractLastAssistantMessage(messages: SdkMessage[]): string | null {
  // Find the last text message (not counting done/error)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'text' && msg.content) {
      return msg.content;
    }
  }
  return null;
}

/**
 * Analyze a completed session and generate outcome + interaction analysis + quick actions
 * This should be called after a session completes (sdk-done event)
 * Note: Session name is generated separately when the prompt is sent
 */
export async function analyzeSessionCompletion(messages: SdkMessage[]): Promise<SessionAiMetadata> {
  const metadata: SessionAiMetadata = {};

  // Only proceed if at least one LLM feature is enabled
  if (!isLlmEnabled()) {
    return metadata;
  }

  const userPrompt = extractFirstUserPrompt(messages);
  const assistantMessages = extractAssistantMessages(messages);
  const lastMessage = extractLastAssistantMessage(messages);

  // Generate session outcome if we have the exchange
  if (isAutoNamingEnabled() && userPrompt && assistantMessages) {
    const outcomeResult = await generateSessionOutcome(userPrompt, assistantMessages);
    if (outcomeResult) {
      metadata.outcome = outcomeResult.outcome;
    }
  }

  // Analyze if interaction is needed
  if (isInteractionDetectionEnabled() && lastMessage) {
    const interactionResult = await analyzeInteractionNeeded(lastMessage);
    if (interactionResult) {
      metadata.needsInteraction = interactionResult.needs_interaction;
      metadata.interactionReason = interactionResult.reason ?? undefined;
      metadata.interactionUrgency = interactionResult.urgency;
      metadata.waitingFor = interactionResult.waiting_for ?? undefined;
    }
  }

  // Generate contextual quick actions
  if (isQuickActionsEnabled() && userPrompt && lastMessage) {
    const quickActions = await generateQuickActions(userPrompt, lastMessage);
    if (quickActions && quickActions.length > 0) {
      metadata.quickActions = quickActions;
    }
  }

  return metadata;
}

/**
 * Generate session name from the user's first prompt
 * This should be called immediately when a prompt is sent
 */
export async function generateSessionNameFromPrompt(userPrompt: string): Promise<SessionAiMetadata> {
  const metadata: SessionAiMetadata = {};

  if (!isAutoNamingEnabled()) {
    return metadata;
  }

  const nameResult = await generateSessionName(userPrompt);
  if (nameResult) {
    metadata.name = nameResult.name;
    metadata.category = nameResult.category;
  }

  return metadata;
}
