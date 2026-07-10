import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { settings } from '$lib/stores/settings';
import { repos } from '$lib/stores/repos';
import type { SessionAiMetadata, SdkMessage } from '$lib/stores/sdkSessions';

export interface SessionNameResult {
  name: string;
  category: string;
}

/**
 * Curated pool of short, ASR-friendly callsign words. Session nicknames are picked
 * from this pool deterministically (no LLM involvement). Sharp consonants and 1-2
 * syllables for easy speech recognition.
 */
const CALLSIGN_WORDS = [
  'falcon', 'delta', 'birch', 'tango', 'cobra', 'flint', 'raven', 'bravo',
  'comet', 'ember', 'piston', 'quartz', 'basil', 'topaz', 'pilot', 'drake',
  'cedar', 'talon', 'kilo', 'vector', 'pixel', 'oscar', 'granite', 'clover',
  'badger', 'jasper', 'copper', 'domino', 'echo', 'foxtrot', 'ginger', 'harbor',
  'ibex', 'juniper', 'kestrel', 'lupine', 'maple', 'nomad', 'onyx', 'poppy',
  'quill', 'rocket', 'sable', 'timber', 'umber', 'viper', 'walnut', 'yankee',
  'zephyr', 'anvil',
];

/**
 * Pick a unique voice callsign from the curated pool: the first word not already in
 * `existingNicknames` (case-insensitive). If the pool is exhausted, append an
 * incrementing number to the first callsign until unique.
 */
export function pickNickname(existingNicknames: string[]): string {
  const used = new Set(existingNicknames.map(n => n.trim().toLowerCase()));

  const unused = CALLSIGN_WORDS.find(w => !used.has(w));
  if (unused) {
    return unused.charAt(0).toUpperCase() + unused.slice(1);
  }

  // Pool exhausted: append an incrementing number to the first callsign until unique.
  const base = CALLSIGN_WORDS[0];
  let n = 2;
  while (used.has(`${base}${n}`.toLowerCase())) n++;
  return `${base.charAt(0).toUpperCase()}${base.slice(1)}${n}`;
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
  /** Full instruction sent verbatim to the coding agent */
  prompt: string;
  /** Short button text (2-4 words); falls back to `prompt` when absent */
  label?: string;
}

export interface QuickActionsResult {
  actions: QuickAction[];
}

/**
 * Parse the provider's suggested wait from a rate-limit error message,
 * e.g. "Please try again in 2m16.944s" or "try again in 7.66s".
 */
function parseRetryDelayMs(message: string): number | null {
  const match = message.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
  if (!match) return null;
  const minutes = match[1] ? parseInt(match[1], 10) : 0;
  const seconds = parseFloat(match[2]);
  if (Number.isNaN(seconds)) return null;
  return Math.ceil(minutes * 60_000 + seconds * 1000);
}

const RATE_LIMIT_MAX_RETRIES = 2;
const RATE_LIMIT_MAX_WAIT_MS = 5 * 60_000;
const RATE_LIMIT_DEFAULT_WAIT_MS = 60_000;

/**
 * `invoke` with retry on provider rate limits (429). Token-per-minute/day windows
 * refill continuously, so waiting the provider's suggested delay usually succeeds.
 * ONLY for fire-and-forget background analysis (session naming, outcome, interaction,
 * quick actions) — never for latency-sensitive calls like transcription cleanup,
 * where the recording flow is waiting on the result.
 */
async function invokeWithRateLimitRetry<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await invoke<T>(cmd, args);
    } catch (error) {
      const message = String(error);
      const isRateLimit = message.includes('429') || /rate.?limit/i.test(message);
      if (!isRateLimit || attempt >= RATE_LIMIT_MAX_RETRIES) throw error;
      // Small margin on top of the suggested delay so we don't re-hit the edge of the window.
      const waitMs = Math.min(
        (parseRetryDelayMs(message) ?? RATE_LIMIT_DEFAULT_WAIT_MS) + 2000,
        RATE_LIMIT_MAX_WAIT_MS
      );
      console.warn(`[llm] ${cmd} rate-limited, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
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
 * App-level terms that are frequently spoken regardless of repo and commonly
 * mangled by speech-to-text. Always included in the cleanup bias list.
 */
const BASE_CLEANUP_VOCABULARY = [
  'Claude',
  'Claude Code',
  'Anthropic',
  'Opus',
  'Sonnet',
  'Haiku',
  'MCP',
  'subagent',
  'worktree',
  'Playwright',
  'CLAUDE.md',
];

/**
 * Build repo context string for transcription cleanup.
 * Produces a context-biasing term list (repo name + keywords + vocabulary +
 * base app vocabulary) the LLM should prefer when the audio sounds similar.
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

  const biasTerms = new Set<string>([repo.name, ...BASE_CLEANUP_VOCABULARY]);
  repo.keywords?.forEach(k => biasTerms.add(k));
  repo.vocabulary?.forEach(v => biasTerms.add(v));

  parts.push(`Known terms: ${Array.from(biasTerms).join(', ')}`);

  return parts.join('\n');
}

/**
 * Build combined context from ALL repos for transcription cleanup.
 * Aggregates repo names, keywords, and vocabulary from all repos into one
 * context-biasing term list. Repo names are prime mistranscription targets
 * (used for voice routing), so context is returned even without keywords.
 */
export function buildAllReposContextForCleanup(repos: Array<{
  name: string;
  description?: string;
  keywords?: string[];
  vocabulary?: string[];
}>): string | undefined {
  if (!repos || repos.length === 0) return undefined;

  const repoNames = repos.map(r => r.name);
  const biasTerms = new Set<string>([...repoNames, ...BASE_CLEANUP_VOCABULARY]);

  for (const repo of repos) {
    repo.keywords?.forEach(k => biasTerms.add(k));
    repo.vocabulary?.forEach(v => biasTerms.add(v));
  }

  return [
    `Projects: ${repoNames.join(', ')}`,
    `Known terms: ${Array.from(biasTerms).join(', ')}`,
  ].join('\n');
}

/**
 * Generate a session name from the user's prompt (called immediately when prompt is sent).
 * Nicknames are NOT generated here — they are assigned deterministically at session
 * creation via {@link pickNickname}.
 */
export async function generateSessionName(
  userPrompt: string
): Promise<SessionNameResult | null> {
  if (!isAutoNamingEnabled()) {
    return null;
  }

  try {
    const result = await invokeWithRateLimitRetry<SessionNameResult>('generate_session_name', {
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
    const result = await invokeWithRateLimitRetry<SessionOutcomeResult>('generate_session_outcome', {
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
    const result = await invokeWithRateLimitRetry<InteractionAnalysis>('analyze_interaction_needed', {
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
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
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
  lastMessage: string,
  latestPrompt?: string,
  sessionActivity?: string
): Promise<QuickAction[] | null> {
  if (!isQuickActionsEnabled()) {
    return null;
  }

  try {
    const result = await invokeWithRateLimitRetry<QuickActionsResult>('generate_quick_actions', {
      userPrompt,
      lastMessage,
      latestPrompt: latestPrompt ?? null,
      sessionActivity: sessionActivity ?? null,
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
 * Extract the most recent user prompt from messages (the session's current focus
 * in multi-turn sessions, as opposed to the original request)
 */
export function extractLatestUserPrompt(messages: SdkMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'user' && msg.content) {
      return msg.content;
    }
  }
  return null;
}

/**
 * Build a compact digest of the tool calls a session performed, newest last,
 * so the quick-actions LLM knows what already happened (tests run, commits
 * made, files edited) and doesn't suggest repeating it.
 */
export function extractSessionActivity(messages: SdkMessage[], maxLength: number = 1500): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.type !== 'tool_start' || !msg.tool) continue;
    // Skip subagent-internal tool calls; the top-level Agent/Task entry covers them
    if (msg.parentToolUseId) continue;
    const input = (msg.input ?? {}) as Record<string, unknown>;
    let detail = '';
    if (typeof input.command === 'string') {
      detail = input.command;
    } else if (typeof input.file_path === 'string') {
      detail = input.file_path;
    } else if (typeof input.description === 'string') {
      detail = input.description;
    } else if (typeof input.prompt === 'string') {
      detail = input.prompt;
    } else if (typeof input.pattern === 'string') {
      detail = input.pattern;
    }
    detail = detail.replace(/\s+/g, ' ').trim();
    lines.push(detail ? `${msg.tool}: ${detail.slice(0, 120)}` : msg.tool);
  }

  // Keep the newest entries within the length budget
  let result = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = result ? `${lines[i]}\n${result}` : lines[i];
    if (candidate.length > maxLength) break;
    result = candidate;
  }
  const dropped = lines.length - (result ? result.split('\n').length : 0);
  return dropped > 0 ? `(${dropped} earlier tool calls omitted)\n${result}` : result;
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
    const latestPrompt = extractLatestUserPrompt(messages) ?? undefined;
    const sessionActivity = extractSessionActivity(messages) || undefined;
    const quickActions = await generateQuickActions(userPrompt, lastMessage, latestPrompt, sessionActivity);
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
export async function generateSessionNameFromPrompt(
  userPrompt: string
): Promise<SessionAiMetadata> {
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
