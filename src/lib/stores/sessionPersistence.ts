import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { settings } from './settings';
import { sdkSessions, activeSdkSessionId, type SdkSession, type SdkMessage, type SdkImageContent, type EffortLevel, type SessionAiMetadata, type PendingRepoSelection, type SdkSessionUsage, type PendingTranscriptionInfo, type PlanModeState, type NoteModeState } from './sdkSessions';
import { getProviderForModel, type SdkProvider } from '$lib/utils/models';
import { sessions, activeSessionId, type TerminalSession } from './sessions';
import { repos } from './repos';

// ============================================================================
// AUTO-PERSISTENCE SYSTEM
// ============================================================================
//
// This system automatically persists ALL session fields by default.
// Instead of manually listing what to persist, we define what NOT to persist.
//
// To add new fields to sessions:
// 1. Just add them to the type definition - they'll be auto-persisted
// 2. If a field can't/shouldn't be persisted, add it to NON_PERSISTABLE_FIELDS
// 3. If a field needs transformation, add it to FIELD_TRANSFORMERS
//
// ============================================================================

/**
 * Fields that should NOT be persisted.
 * These are either non-serializable (Uint8Array, functions) or runtime-only state.
 */
const NON_PERSISTABLE_FIELDS: Record<string, Set<string>> = {
  // SdkSession fields that shouldn't be persisted
  SdkSession: new Set([
    'currentWorkStartedAt', // Runtime-only timer, accumulated time is persisted instead
    'pendingSystemNotifications', // Transient parallel agent notifications - cleared after first query
  ]),
  // PendingTranscriptionInfo fields that shouldn't be persisted
  PendingTranscriptionInfo: new Set([
    'audioData', // Uint8Array - can't be JSON serialized, also large binary data
  ]),
  // SdkMessage doesn't have non-persistable fields currently
  SdkMessage: new Set([]),
};

/**
 * Fields that need special transformation for serialization.
 * Key: field path (e.g., "messages.images")
 * Value: transform function that makes it JSON-safe, or null to exclude
 */
type TransformFn = (value: unknown) => unknown;
const FIELD_TRANSFORMERS: Record<string, TransformFn> = {
  // Currently no complex transformations needed - images are already base64 strings
  // Add transformers here if needed in the future, e.g.:
  // 'someField': (value) => value ? convertToJsonSafe(value) : null,
};

/**
 * Deep clone an object, excluding non-persistable fields and applying transformers.
 * This is the core of the auto-persistence system.
 */
function serializeForPersistence<T>(
  obj: T,
  typeName: string,
  parentPath: string = ''
): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle primitives
  if (typeof obj !== 'object') {
    return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item, index) =>
      serializeForPersistence(item, typeName, `${parentPath}[${index}]`)
    ) as T;
  }

  // Handle Uint8Array and other typed arrays - skip them
  if (obj instanceof Uint8Array || ArrayBuffer.isView(obj)) {
    return undefined as T;
  }

  // Handle Date objects - convert to ISO string for JSON
  if (obj instanceof Date) {
    return obj.toISOString() as T;
  }

  const nonPersistableSet = NON_PERSISTABLE_FIELDS[typeName] || new Set();
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(obj as object)) {
    // Skip non-persistable fields
    if (nonPersistableSet.has(key)) {
      continue;
    }

    const fullPath = parentPath ? `${parentPath}.${key}` : key;
    let value = (obj as Record<string, unknown>)[key];

    // Apply transformer if defined
    const transformer = FIELD_TRANSFORMERS[fullPath];
    if (transformer) {
      value = transformer(value);
    }

    // Skip undefined values
    if (value === undefined) {
      continue;
    }

    // Determine child type name for nested objects
    let childTypeName = typeName;
    if (key === 'pendingTranscription') {
      childTypeName = 'PendingTranscriptionInfo';
    } else if (key === 'messages') {
      childTypeName = 'SdkMessage';
    } else if (key === 'usage') {
      childTypeName = 'SdkSessionUsage';
    }

    // Recursively serialize
    result[key] = serializeForPersistence(value, childTypeName, fullPath);
  }

  return result as T;
}

/**
 * Deserialize persisted data back to the session type.
 * Applies any necessary transformations and defaults.
 */
function deserializeFromPersistence<T extends object>(
  persisted: Record<string, unknown>,
  defaults: Partial<T> = {}
): T {
  // Start with defaults
  const result: Record<string, unknown> = { ...defaults };

  // Copy all persisted fields
  for (const key of Object.keys(persisted)) {
    const value = persisted[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result as T;
}

// ============================================================================
// PERSISTED TYPES
// ============================================================================
// These are now just documentation/type hints - the actual serialization
// preserves all fields from the source types automatically.

/**
 * Persisted SDK message - all fields from SdkMessage are preserved.
 */
export interface PersistedSdkMessage {
  type: string;
  content?: string;
  images?: Array<{
    mediaType: string;
    base64Data: string;
    width?: number;
    height?: number;
  }>;
  tool?: string;
  toolUseId?: string;
  parentToolUseId?: string | null;
  input?: Record<string, unknown>;
  output?: string;
  agentId?: string;
  agentType?: string;
  transcriptPath?: string;
  thinkingDurationMs?: number;
  // Task lifecycle fields
  taskId?: string;
  description?: string;
  taskType?: string;
  taskStatus?: string;
  summary?: string;
  taskUsage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  timestamp: number;
}

/**
 * Persisted pending transcription info - all fields except audioData (Uint8Array).
 */
export interface PersistedPendingTranscriptionInfo {
  status: 'recording' | 'transcribing' | 'processing';
  audioVisualizationHistory?: number[][];
  recordingStartedAt?: number;
  recordingDurationMs?: number;
  // audioData is NOT persisted (Uint8Array)
  transcript?: string;
  transcriptionError?: string;
  voskTranscript?: string;
  cleanedTranscript?: string;
  wasCleanedUp?: boolean;
  cleanupCorrections?: string[];
  usedDualSource?: boolean;
  modelRecommendation?: {
    modelId: string;
    reasoning: string;
    effortLevel?: string;
    thinkingLevel?: string;
  };
  repoRecommendation?: {
    repoIndex: number;
    repoName: string;
    reasoning: string;
    confidence: string;
  };
}

/**
 * Persisted SDK session - all fields are preserved.
 */
export interface PersistedSdkSession {
  id: string;
  cwd: string;
  repoId?: string;
  createdBranch?: string | null;
  currentBranch?: string | null;
  model: string;
  provider?: SdkProvider;
  readOnlyMode?: boolean;
  autoModelRequested?: boolean;
  effortLevel?: EffortLevel;
  /** @deprecated Use effortLevel - kept for backward compat loading */
  thinkingLevel?: string | null;
  messages: PersistedSdkMessage[];
  status: string;
  createdAt: number;
  lastActivityAt?: number;
  startedAt?: number;
  accumulatedDurationMs?: number;
  usage?: SdkSessionUsage;
  unread?: boolean;
  aiMetadata?: SessionAiMetadata;
  pendingTranscription?: PersistedPendingTranscriptionInfo;
  pendingRepoSelection?: PendingRepoSelection;
  pendingPrompt?: string;
  pendingApprovalPrompt?: string;
  draftPrompt?: string;
  draftImages?: SdkImageContent[];
  planMode?: PlanModeState;
  noteMode?: NoteModeState;
  sdkSessionId?: string;
}

export interface PersistedTerminalSession {
  id: string;
  repo_path: string;
  prompt: string;
  status: string;
  created_at: number;
  output_buffer?: string;
}

export interface PersistedSessions {
  sdk_sessions: PersistedSdkSession[];
  terminal_sessions: PersistedTerminalSession[];
  active_sdk_session_id: string | null;
  active_terminal_session_id: string | null;
  saved_at: number;
}

// ============================================================================
// CONVERSION FUNCTIONS
// ============================================================================

/**
 * Convert frontend SDK session to persisted format.
 * Uses auto-serialization - all fields are preserved except those in NON_PERSISTABLE_FIELDS.
 */
export function sdkSessionToPersisted(session: SdkSession): PersistedSdkSession {
  // Calculate final accumulated duration including current work period
  let accumulatedDurationMs = session.accumulatedDurationMs || 0;
  if (session.currentWorkStartedAt) {
    accumulatedDurationMs += Date.now() - session.currentWorkStartedAt;
  }

  // Use auto-serialization
  const persisted = serializeForPersistence(session, 'SdkSession');

  // Override accumulated duration with calculated value
  return {
    ...persisted,
    accumulatedDurationMs,
  };
}

/**
 * Convert persisted SDK session to frontend format.
 * Applies defaults for fields that need runtime initialization.
 */
export function persistedToSdkSession(persisted: PersistedSdkSession): SdkSession {
  // Determine if this is a pending session
  const isPending = persisted.status === 'pending_transcription' ||
                    persisted.status === 'pending_repo' ||
                    persisted.status === 'pending_approval';

  // Deserialize with runtime defaults
  const session = deserializeFromPersistence<SdkSession>(persisted as unknown as Record<string, unknown>, {
    // Runtime-only fields that need defaults
    currentWorkStartedAt: undefined, // Session is idle when restored
    effortLevel: null, // Default effort level
    accumulatedDurationMs: 0,
    messages: [],
  });

  // Fix up the status - querying sessions become idle since we can't resume mid-query
  if (!isPending && persisted.status === 'querying') {
    session.status = 'idle';
  }

  // Ensure message types are properly typed
  if (persisted.messages) {
    session.messages = persisted.messages.map(msg => ({
      ...msg,
      type: msg.type as SdkMessage['type'],
      // Cast images mediaType back to the union type
      images: msg.images?.map(img => ({
        ...img,
        mediaType: img.mediaType as SdkImageContent['mediaType'],
      })),
    }));
  }

  if (typeof session.draftPrompt !== 'string') {
    session.draftPrompt = undefined;
  }

  if (!Array.isArray(session.draftImages)) {
    session.draftImages = undefined;
  }

  // Migrate old sessions without lastActivityAt
  if (!session.lastActivityAt) {
    session.lastActivityAt = session.createdAt;
  }

  // Migrate old thinkingLevel to effortLevel
  if (persisted.effortLevel !== undefined) {
    session.effortLevel = persisted.effortLevel;
  } else if (persisted.thinkingLevel !== undefined) {
    // Legacy migration: 'on' -> 'high', 'off'/undefined -> null
    session.effortLevel = persisted.thinkingLevel === 'on' ? 'high' : null;
  } else {
    session.effortLevel = null;
  }

  // Normalize provider for legacy/mismatched sessions: derive from model.
  // This prevents invalid pairs like provider=claude with model=gpt-5.3-codex.
  const modelProvider = getProviderForModel(session.model);
  if (session.provider !== modelProvider) {
    session.provider = modelProvider;
  }

  // Resolve repoId from cwd for sessions that predate the repoId field
  if (!session.repoId && session.cwd && session.cwd !== '.') {
    const reposList = get(repos).list;
    session.repoId = reposList.find(r => r.path === session.cwd)?.id;
  }

  return session;
}

/**
 * Convert frontend terminal session to persisted format.
 */
export function terminalSessionToPersisted(session: TerminalSession, outputBuffer?: string): PersistedTerminalSession {
  return {
    id: session.id,
    repo_path: session.repo_path,
    prompt: session.prompt,
    // Persisted terminal sessions are always 'Completed' since we can't restore PTY
    status: 'Completed',
    created_at: session.created_at,
    output_buffer: outputBuffer,
  };
}

/**
 * Convert persisted terminal session to frontend format.
 */
export function persistedToTerminalSession(persisted: PersistedTerminalSession): TerminalSession {
  return {
    id: persisted.id,
    repo_path: persisted.repo_path,
    prompt: persisted.prompt,
    status: 'Completed', // Always completed since PTY can't be restored
    created_at: persisted.created_at,
  };
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Track whether sessions have already been loaded from disk.
 * This prevents reloading (and overwriting in-memory state) when navigating between routes.
 */
let sessionsLoadedFromDisk = false;

/**
 * Reset the loaded flag. Used for testing or when app state needs to be reset.
 */
export function resetSessionLoadedFlag(): void {
  sessionsLoadedFromDisk = false;
}

/**
 * Check if sessions have been loaded from disk.
 */
export function hasLoadedSessionsFromDisk(): boolean {
  return sessionsLoadedFromDisk;
}

/**
 * Save current sessions to disk.
 * All session fields are automatically persisted except those in NON_PERSISTABLE_FIELDS.
 */
export async function saveSessionsToDisk(): Promise<void> {
  const currentSettings = get(settings);

  if (!currentSettings.session_persistence.enabled) {
    return;
  }

  const currentSdkSessions = get(sdkSessions);
  const currentTerminalSessions = get(sessions);
  const currentActiveSdkId = get(activeSdkSessionId);
  const currentActiveTerminalId = get(activeSessionId);

  // Filter out sessions that are still actively recording with no useful data yet.
  // Sessions with transcription data, LLM reasoning, etc. are persisted so
  // users can see the processing state and resume or restart.
  const persistableSdkSessions = currentSdkSessions.filter(s => {
    if (s.status !== 'pending_transcription') {
      return true; // Not pending transcription, include it
    }
    // For pending_transcription sessions, only exclude if still recording with no transcript
    const hasTranscript = s.pendingTranscription?.transcript;
    const hasLlmReasoning = s.pendingTranscription?.modelRecommendation ||
                           s.pendingTranscription?.repoRecommendation ||
                           s.pendingTranscription?.cleanedTranscript;
    // Include if we have meaningful data to restore
    return hasTranscript || hasLlmReasoning;
  });

  const persistedData: PersistedSessions = {
    sdk_sessions: persistableSdkSessions.map(sdkSessionToPersisted),
    terminal_sessions: currentTerminalSessions.map(s => terminalSessionToPersisted(s)),
    active_sdk_session_id: currentActiveSdkId && persistableSdkSessions.some(s => s.id === currentActiveSdkId)
      ? currentActiveSdkId
      : null,
    active_terminal_session_id: currentActiveTerminalId,
    saved_at: Date.now(),
  };

  try {
    // Debug: Log thinking levels being saved
    persistedData.sdk_sessions.forEach(s => {
      console.log(`[sessionPersistence] Saving session ${s.id.slice(0, 8)}: effortLevel =`, s.effortLevel);
    });

    const result = await invoke<{
      overflowSdkSessions: PersistedSdkSession[];
      overflowTerminalSessions: PersistedTerminalSession[];
    }>('save_persisted_sessions', {
      sessions: persistedData,
      maxSessions: currentSettings.session_persistence.max_sessions,
    });

    // Archive overflow sessions instead of losing them
    const hasOverflow = (result.overflowSdkSessions?.length > 0) || (result.overflowTerminalSessions?.length > 0);
    if (hasOverflow) {
      console.log(`[sessionPersistence] Archiving ${result.overflowSdkSessions?.length ?? 0} SDK + ${result.overflowTerminalSessions?.length ?? 0} terminal overflow sessions`);

      for (const session of (result.overflowSdkSessions || [])) {
        try {
          await invoke('archive_sdk_session', { session });
        } catch (err) {
          console.error('[sessionPersistence] Failed to archive overflow SDK session:', err);
        }
      }

      for (const session of (result.overflowTerminalSessions || [])) {
        try {
          await invoke('archive_terminal_session', { session });
        } catch (err) {
          console.error('[sessionPersistence] Failed to archive overflow terminal session:', err);
        }
      }

      // Trim archive after batch archiving
      await invoke('trim_archive', {
        maxEntries: currentSettings.session_persistence.max_archived_sessions ?? 500,
      });

      // Refresh archive metadata and list
      const { archive } = await import('./archive');
      await archive.refresh();
    }

    console.log('[sessionPersistence] Sessions saved to disk');
  } catch (error) {
    console.error('[sessionPersistence] Failed to save sessions:', error);
  }
}

/**
 * Load sessions from disk and restore state.
 * Only loads on the first call - subsequent calls are no-ops to prevent
 * overwriting in-memory state when navigating between routes.
 */
export async function loadSessionsFromDisk(): Promise<void> {
  // Prevent re-loading from disk on route navigation
  // This protects in-memory session state (like querying status)
  if (sessionsLoadedFromDisk) {
    console.log('[sessionPersistence] Sessions already loaded, skipping reload');
    return;
  }

  const currentSettings = get(settings);

  if (!currentSettings.session_persistence.enabled) {
    sessionsLoadedFromDisk = true; // Mark as "loaded" even if disabled
    return;
  }

  const restoreLimit = currentSettings.session_persistence.restore_sessions;

  try {
    const persistedData = await invoke<PersistedSessions>('get_persisted_sessions');

    if (!persistedData || (!persistedData.sdk_sessions.length && !persistedData.terminal_sessions.length)) {
      console.log('[sessionPersistence] No persisted sessions found');
      sessionsLoadedFromDisk = true;
      return;
    }

    // Limit the number of sessions to restore based on setting
    // Sessions are already sorted by created_at descending from the backend
    const limitedSdkSessions = persistedData.sdk_sessions.slice(0, restoreLimit);
    const limitedTerminalSessions = persistedData.terminal_sessions.slice(0, restoreLimit);

    console.log('[sessionPersistence] Restoring', limitedSdkSessions.length, 'of', persistedData.sdk_sessions.length, 'SDK sessions and', limitedTerminalSessions.length, 'of', persistedData.terminal_sessions.length, 'terminal sessions (limit:', restoreLimit + ')');

    // Debug: Log thinking levels being restored
    limitedSdkSessions.forEach(s => {
      console.log(`[sessionPersistence] Loading session ${s.id.slice(0, 8)}: effortLevel =`, s.effortLevel);
    });

    // Restore SDK sessions
    if (limitedSdkSessions.length > 0) {
      const restoredSdkSessions = limitedSdkSessions.map(persistedToSdkSession);
      sdkSessions.set(restoredSdkSessions);

      // Restore active SDK session selection if it exists and is within the restored sessions
      if (persistedData.active_sdk_session_id) {
        const exists = restoredSdkSessions.some(s => s.id === persistedData.active_sdk_session_id);
        if (exists) {
          activeSdkSessionId.set(persistedData.active_sdk_session_id);
        }
      }
    }

    // Restore terminal sessions (as completed/read-only)
    if (limitedTerminalSessions.length > 0) {
      const restoredTerminalSessions = limitedTerminalSessions.map(persistedToTerminalSession);
      sessions.set(restoredTerminalSessions);

      // Restore active terminal session selection if it exists and is within the restored sessions
      if (persistedData.active_terminal_session_id) {
        const exists = restoredTerminalSessions.some(s => s.id === persistedData.active_terminal_session_id);
        if (exists) {
          activeSessionId.set(persistedData.active_terminal_session_id);
        }
      }
    }

    sessionsLoadedFromDisk = true;
    console.log('[sessionPersistence] Sessions restored successfully');
  } catch (error) {
    console.error('[sessionPersistence] Failed to load sessions:', error);
    // Still mark as loaded to prevent retrying on every route change
    sessionsLoadedFromDisk = true;
  }
}

/**
 * Clear all persisted sessions.
 */
export async function clearPersistedSessions(): Promise<void> {
  try {
    await invoke('clear_persisted_sessions');
    console.log('[sessionPersistence] Persisted sessions cleared');
  } catch (error) {
    console.error('[sessionPersistence] Failed to clear sessions:', error);
  }
}

/**
 * Setup auto-save on visibility change (when user switches away from app).
 */
export function setupAutoSave(): () => void {
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      saveSessionsToDisk();
    }
  };

  const handleBeforeUnload = () => {
    // Note: This is a best-effort save. The invoke might not complete before the page unloads.
    saveSessionsToDisk();
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('beforeunload', handleBeforeUnload);

  // Return cleanup function
  return () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('beforeunload', handleBeforeUnload);
  };
}

/**
 * Setup periodic auto-save (every 5 minutes).
 */
export function setupPeriodicAutoSave(intervalMs: number = 5 * 60 * 1000): () => void {
  const intervalId = setInterval(() => {
    const currentSettings = get(settings);
    if (currentSettings.session_persistence.enabled) {
      saveSessionsToDisk();
    }
  }, intervalMs);

  return () => clearInterval(intervalId);
}
