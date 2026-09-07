import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { settings } from './settings';
import { sdkSessions, activeSdkSessionId, newParkedTurnId, type SdkSession, type SdkMessage, type SdkImageContent, type EffortLevel, type SessionAiMetadata, type PendingRepoSelection, type SdkSessionUsage, type PendingTranscriptionInfo, type AskUserQuestionState, type RateLimitedState } from './sdkSessions';
import { getProviderForModel, type SdkProvider } from '$lib/utils/models';
import { repos } from './repos';
import { panes } from './panes';

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
    'overflowRecovery', // Transient compact-and-retry state for context overflow recovery
    'liveSubagentIds', // Runtime-only: subagents in flight this turn — nothing is live after restart
    'liveBackgroundTasks', // Runtime-only: background tasks in flight — nothing is live after restart
    'completionDeferred', // Runtime-only: deferred-completion flag, meaningless after restart
    'inFlightPrompt', // Smart Queue: transient capture of the current turn's prompt for mid-run recovery
    'inFlightImages', // Smart Queue: transient capture of the current turn's images for mid-run recovery
    'pendingCodexApproval', // Runtime-only: tied to a live app-server JSON-RPC request id, meaningless after restart
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
 * Type names whose subtrees are pure JSON data with nothing to strip, so they can
 * be handed to the serializer by reference instead of deep-cloned.
 *
 * This is the difference between a save costing ~17ms of pure garbage (a 6000-message
 * session is ~11MB of messages, and every save walked and reallocated all of it)
 * and costing nothing. The result only ever gets read — `sdkSessionToPersisted`'s
 * callers hand it straight to `invoke`, which JSON-serializes it — so sharing the
 * live message objects is safe.
 *
 * A type may only be listed here when it carries NO non-persistable fields (asserted
 * below) and no `Uint8Array`/`Date` values anywhere in its subtree. Both would
 * otherwise be silently persisted in the wrong shape rather than stripped/converted.
 * `PendingTranscriptionInfo.audioData` is exactly that case, which is why it is
 * excluded by name and its type is NOT listed here.
 */
const PASSTHROUGH_TYPES = new Set(
  ['SdkMessage', 'SdkSessionUsage'].filter((typeName) => {
    // Self-healing guard: adding a non-persistable field to a passthrough type would
    // otherwise silently persist it. Drop the type back to the cloning path (correct,
    // just slower) and say so loudly rather than shipping the wrong data.
    const excluded = NON_PERSISTABLE_FIELDS[typeName];
    if (excluded && excluded.size > 0) {
      console.error(
        `[sessionPersistence] ${typeName} is listed as a passthrough type but declares ` +
          `non-persistable fields (${[...excluded].join(', ')}); falling back to deep copy. ` +
          `Remove it from PASSTHROUGH_TYPES.`
      );
      return false;
    }
    return true;
  })
);

const hasFieldTransformers = Object.keys(FIELD_TRANSFORMERS).length > 0;

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

  // Nothing to strip or transform in this subtree — share it instead of copying it.
  if (!hasFieldTransformers && PASSTHROUGH_TYPES.has(typeName)) {
    return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    // Path tracking exists solely to look up FIELD_TRANSFORMERS; building index
    // paths for every element of a multi-thousand-entry array when there are no
    // transformers is pure overhead.
    return obj.map((item, index) =>
      serializeForPersistence(item, typeName, hasFieldTransformers ? `${parentPath}[${index}]` : '')
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

    const fullPath = !hasFieldTransformers ? '' : parentPath ? `${parentPath}.${key}` : key;
    let value = (obj as Record<string, unknown>)[key];

    // Apply transformer if defined
    if (hasFieldTransformers) {
      const transformer = FIELD_TRANSFORMERS[fullPath];
      if (transformer) {
        value = transformer(value);
      }
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

function resolveRepoIdFromPath(cwd: string): string | undefined {
  if (!cwd || cwd === '.') return undefined;
  const reposList = get(repos).list;
  const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const normalizedCwd = normalize(cwd);

  const exact = reposList.find(r => normalize(r.path) === normalizedCwd)?.id;
  if (exact) return exact;

  const fromWorktree = reposList.find((r) => {
    const repoBase = normalize(r.path);
    return normalizedCwd.startsWith(`${repoBase}-worktrees/`);
  })?.id;

  return fromWorktree;
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
  /** Deferred-send marker on a parked ghost turn (see SdkMessage.queued) */
  queued?: string | null;
  /** Id of the parked turn this ghost bubble belongs to */
  queuedTurnId?: string | null;
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
  realtimeTranscript?: string;
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
  /** Recording screenshots (base64 — already JSON-safe) */
  screenshots?: { mediaType: string; base64Data: string; width?: number; height?: number; source?: 'screenshot' }[];
}

/**
 * Persisted SDK session - all fields are preserved.
 */
export interface PersistedSdkSession {
  id: string;
  cwd: string;
  setupRepoPath?: string;
  setupWorktreeMode?: 'main' | 'new' | 'existing';
  setupWorktreePath?: string;
  repoId?: string;
  createdBranch?: string | null;
  currentBranch?: string | null;
  model: string;
  provider?: SdkProvider;
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
  draftPrompt?: string;
  draftImages?: SdkImageContent[];
  sdkSessionId?: string;
  askUserQuestion?: AskUserQuestionState;
  pinned?: boolean;
  pinnedAt?: number | null;
  /** Pending turns parked on a live session, oldest first */
  parkedTurns?: RateLimitedState[];
  /** @deprecated Legacy single parked turn — migrated into parkedTurns on load */
  rateLimited?: RateLimitedState | null;
}

export interface PersistedSessions {
  sdk_sessions: PersistedSdkSession[];
  active_sdk_session_id: string | null;
  saved_at: number;
}

// ============================================================================
// CONVERSION FUNCTIONS
// ============================================================================

// Serialized form cached by session object identity. The store is immutable — every
// mutation spreads into a new session object — so an unchanged identity guarantees an
// unchanged serialization. This is what keeps a full save (which walks every session,
// not just the dirty ones) from re-serializing megabytes of untouched history.
const persistedCache = new WeakMap<SdkSession, PersistedSdkSession>();

/**
 * Convert frontend SDK session to persisted format.
 * Uses auto-serialization - all fields are preserved except those in NON_PERSISTABLE_FIELDS.
 */
export function sdkSessionToPersisted(session: SdkSession): PersistedSdkSession {
  // Calculate final accumulated duration including current work period.
  // Recomputed on every call (never cached) — it's clock-dependent, so a live
  // session's duration must not be frozen at whenever we first serialized it.
  let accumulatedDurationMs = session.accumulatedDurationMs || 0;
  if (session.currentWorkStartedAt) {
    accumulatedDurationMs += Date.now() - session.currentWorkStartedAt;
  }

  // Use auto-serialization
  let persisted = persistedCache.get(session);
  if (!persisted) {
    persisted = serializeForPersistence(session, 'SdkSession');
    persistedCache.set(session, persisted);
  }

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
                    persisted.status === 'pending_repo';

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
      queued: (msg.queued ?? undefined) as SdkMessage['queued'],
      queuedTurnId: msg.queuedTurnId ?? undefined,
      // Cast images mediaType back to the union type
      images: msg.images?.map(img => ({
        ...img,
        mediaType: img.mediaType as SdkImageContent['mediaType'],
      })),
    }));
  }

  // Parked turns: normalize the array and migrate the legacy single `rateLimited`
  // slot (one turn per session) into it. Turns persisted before ids existed get one
  // now, so every action can target a specific turn.
  const legacyRateLimited = (persisted as { rateLimited?: RateLimitedState | null }).rateLimited;
  const parked = Array.isArray(session.parkedTurns)
    ? session.parkedTurns
    : legacyRateLimited
      ? [legacyRateLimited]
      : [];
  session.parkedTurns = parked.length
    ? parked.map(turn => ({ ...turn, id: turn.id || newParkedTurnId() }))
    : undefined;
  delete (session as { rateLimited?: unknown }).rateLimited;

  if (typeof session.draftPrompt !== 'string') {
    session.draftPrompt = undefined;
  }

  if (!Array.isArray(session.draftImages)) {
    session.draftImages = undefined;
  }

  // A pending AskUserQuestion outlives the process that raised it: the sidecar's
  // canUseTool promise died with the old process, so the answer can no longer be
  // handed back as a tool result. Keep the question (and any options already picked)
  // so it isn't silently lost, but flag it `stale` — submitting now resumes the
  // session with the answers as a normal prompt instead.
  const restoredQuestion = persisted.askUserQuestion;
  if (restoredQuestion?.questions?.length) {
    session.askUserQuestion = {
      questions: restoredQuestion.questions,
      answers: Array.isArray(restoredQuestion.answers) ? restoredQuestion.answers : [],
      currentQuestionIndex: restoredQuestion.currentQuestionIndex ?? 0,
      stale: true,
    };
  } else {
    session.askUserQuestion = undefined;
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
  // This prevents invalid pairs like provider=claude with model=gpt-5.4.
  const modelProvider = getProviderForModel(session.model);
  if (session.provider !== modelProvider) {
    session.provider = modelProvider;
  }

  // Resolve repoId from cwd for sessions that predate the repoId field
  if (!session.repoId) {
    session.repoId = resolveRepoIdFromPath(session.cwd)
      || resolveRepoIdFromPath(session.setupRepoPath || '');
  }

  // Migrate legacy `prepared` sessions (the old draft/prepared panel) into editable `setup`
  // drafts — drafts now live entirely in the New Session view. Queued/scheduled sessions keep
  // their `queued` status (they still dispatch via launchPrepared and are re-evaluated live).
  if ((session.status as string) === 'prepared') {
    session.status = 'setup';
    session.draftPrompt = session.preparedPrompt ?? session.draftPrompt;
    session.setupRepoPath = session.cwd || session.setupRepoPath;
    session.preparedPrompt = undefined;
    session.preparedSystemPrompt = undefined;
    session.preparedRepoRecommendation = undefined;
  }

  // Migrate legacy `pending_approval` sessions (the removed transcription-approval
  // flow) into editable `setup` drafts so their prompt isn't lost.
  if ((session.status as string) === 'pending_approval') {
    const approvalPrompt = (persisted as { pendingApprovalPrompt?: string }).pendingApprovalPrompt;
    session.status = 'setup';
    session.draftPrompt = approvalPrompt ?? session.draftPrompt;
    session.setupRepoPath = session.cwd || session.setupRepoPath;
    session.pendingTranscription = undefined;
  }

  // Backward-compat for older persisted setup sessions that only had cwd.
  if (session.status === 'setup') {
    if (!session.setupRepoPath) {
      session.setupRepoPath = session.cwd;
    }
    if (!session.setupWorktreeMode) {
      session.setupWorktreeMode = session.setupWorktreePath ? 'existing' : 'main';
    }
  }

  return session;
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
 * Whether an SDK session carries meaningful state worth persisting.
 * Excludes sessions still actively recording with no useful data yet;
 * sessions with transcription data, LLM reasoning, etc. are kept so users can
 * see the processing state and resume or restart. Shared by the full save and
 * the partial (upsert) save so both apply identical rules.
 */
function isSdkSessionPersistable(s: SdkSession): boolean {
  if (s.status !== 'pending_transcription') {
    return true; // Not pending transcription, include it
  }
  const hasTranscript = s.pendingTranscription?.transcript;
  const hasLlmReasoning = s.pendingTranscription?.modelRecommendation ||
                         s.pendingTranscription?.repoRecommendation ||
                         s.pendingTranscription?.cleanedTranscript;
  return !!(hasTranscript || hasLlmReasoning);
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
  const currentActiveSdkId = get(activeSdkSessionId);

  const persistableSdkSessions = currentSdkSessions.filter(isSdkSessionPersistable);

  const persistedData: PersistedSessions = {
    sdk_sessions: persistableSdkSessions.map(sdkSessionToPersisted),
    active_sdk_session_id: currentActiveSdkId && persistableSdkSessions.some(s => s.id === currentActiveSdkId)
      ? currentActiveSdkId
      : null,
    saved_at: Date.now(),
  };

  try {
    const result = await invoke<{
      overflowSdkSessions: PersistedSdkSession[];
    }>('save_persisted_sessions', {
      sessions: persistedData,
      maxSessions: currentSettings.session_persistence.max_sessions,
    });

    // Archive overflow sessions instead of losing them
    if (result.overflowSdkSessions?.length > 0) {
      // Exempt queued sessions from the overflow sweep. A scheduled launch can sit in
      // `queued` for days or weeks without any activity, so it sorts to the bottom of the
      // overflow list and would be archived away before it ever runs. The backend already
      // dropped their data files, so re-upsert them to put those files back.
      const rescuedSdkSessions = result.overflowSdkSessions.filter((s) => s.status === 'queued');
      const overflowToArchive = result.overflowSdkSessions.filter((s) => s.status !== 'queued');

      if (rescuedSdkSessions.length > 0) {
        console.log(`[sessionPersistence] Keeping ${rescuedSdkSessions.length} queued session(s) out of the overflow sweep`);
        try {
          await invoke('upsert_persisted_sdk_sessions', {
            sessions: rescuedSdkSessions,
            activeSdkSessionId: persistedData.active_sdk_session_id,
          });
        } catch (err) {
          console.error('[sessionPersistence] Failed to re-persist rescued queued sessions:', err);
        }
      }

      if (overflowToArchive.length > 0) {
        console.log(`[sessionPersistence] Archiving ${overflowToArchive.length} overflow SDK sessions`);

        const overflowSdkIds = new Set(overflowToArchive.map((session) => session.id));

        for (const session of overflowToArchive) {
          try {
            await invoke('archive_sdk_session', { session });
          } catch (err) {
            console.error('[sessionPersistence] Failed to archive overflow SDK session:', err);
          }
        }

        // Trim archive after batch archiving
        await invoke('trim_archive', {
          maxEntries: currentSettings.session_persistence.max_archived_sessions ?? 500,
        });

        // Keep the live session list aligned with persistence once overflow sessions are archived.
        sdkSessions.set(
          get(sdkSessions).filter((session) => !overflowSdkIds.has(session.id))
        );

        const currentActiveSdkSessionId = get(activeSdkSessionId);
        if (currentActiveSdkSessionId && overflowSdkIds.has(currentActiveSdkSessionId)) {
          activeSdkSessionId.set(null);
        }

        // Refresh archive metadata and list
        const { archive } = await import('./archive');
        await archive.refresh();
      }
    }

    console.log('[sessionPersistence] Sessions saved to disk');
  } catch (error) {
    console.error('[sessionPersistence] Failed to save sessions:', error);
  }
}

/**
 * Partial autosave used by the debounced saver during a live query: persists
 * only the given (dirty) SDK sessions via `upsert_persisted_sdk_sessions`, so a
 * streaming session doesn't re-serialize and rewrite every other session on
 * each tick. Stale-file cleanup and overflow are left to the full
 * `saveSessionsToDisk` path (which still runs on structural changes,
 * the periodic timer, and visibility/unload).
 */
export async function saveSdkSessionsPartial(dirtyIds: Set<string>): Promise<void> {
  const currentSettings = get(settings);
  if (!currentSettings.session_persistence.enabled) {
    return;
  }

  const allSdkSessions = get(sdkSessions);
  const activeId = get(activeSdkSessionId);

  const toPersist: PersistedSdkSession[] = [];
  for (const id of dirtyIds) {
    const session = allSdkSessions.find(s => s.id === id);
    // Missing → removed since being marked dirty; removal paths trigger a full
    // save that reconciles the stale file, so it's safe to skip here.
    if (!session || !isSdkSessionPersistable(session)) continue;
    toPersist.push(sdkSessionToPersisted(session));
  }

  if (toPersist.length === 0) {
    return;
  }

  try {
    await invoke('upsert_persisted_sdk_sessions', {
      sessions: toPersist,
      activeSdkSessionId: activeId && allSdkSessions.some(s => s.id === activeId) ? activeId : null,
    });
  } catch (error) {
    console.error('[sessionPersistence] Failed to partial-save sessions:', error);
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

  // Restore as many sessions as we keep before auto-archiving — the "Maximum
  // Sessions to Keep" limit is the single source of truth for how many live
  // sessions exist at once.
  const restoreLimit = currentSettings.session_persistence.max_sessions;

  try {
    const persistedData = await invoke<PersistedSessions>('get_persisted_sessions');

    if (!persistedData || !persistedData.sdk_sessions.length) {
      console.log('[sessionPersistence] No persisted sessions found');
      sessionsLoadedFromDisk = true;
      return;
    }

    // Limit the number of sessions to restore based on setting
    // Sessions are already sorted by created_at descending from the backend
    const limitedSdkSessions = persistedData.sdk_sessions.slice(0, restoreLimit);

    console.log('[sessionPersistence] Restoring', limitedSdkSessions.length, 'of', persistedData.sdk_sessions.length, 'SDK sessions (limit:', restoreLimit + ')');

    // Debug: Log thinking levels being restored
    limitedSdkSessions.forEach(s => {
      console.log(`[sessionPersistence] Loading session ${s.id.slice(0, 8)}: effortLevel =`, s.effortLevel);
    });

    // Restore SDK sessions
    let restoredSdkSessionIds: string[] = [];
    if (limitedSdkSessions.length > 0) {
      const restoredSdkSessions = limitedSdkSessions.map(persistedToSdkSession);
      restoredSdkSessionIds = restoredSdkSessions.map(s => s.id);
      sdkSessions.set(restoredSdkSessions);

      // Restore active SDK session selection if it exists and is within the restored sessions
      if (persistedData.active_sdk_session_id) {
        const exists = restoredSdkSessions.some(s => s.id === persistedData.active_sdk_session_id);
        if (exists) {
          activeSdkSessionId.set(persistedData.active_sdk_session_id);
        }
      }
    }
    panes.reconcile(restoredSdkSessionIds);

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
