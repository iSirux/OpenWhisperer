// Shared session types used across SessionList and SessionCard components

import type { SessionAiMetadata, PlanModeState, NoteModeState, QueueInfo, RateLimitedState } from '$lib/stores/sdkSessions';
import type { SdkProvider } from '$lib/utils/models';
import type { ExecutionStatus } from '$lib/types/sequence';

/**
 * Unified session type for display in the session list and grid views.
 * Combines both PTY and SDK session data into a common format.
 */
export interface DisplaySession {
  id: string;
  type: 'pty' | 'sdk' | 'sequence';
  status: string;
  statusDetail?: string; // e.g., tool name being run
  prompt: string;
  repoPath: string;
  repoId?: string; // Stable repo entity reference for icon/color/name resolution
  model?: string; // model name for SDK sessions
  provider?: SdkProvider; // SDK provider (claude or openai)
  createdAt: number; // When the session was created
  lastActivityAt: number; // When the session last had activity (for sorting)
  branch?: string; // git branch name

  // Timer-based duration tracking (SDK sessions)
  accumulatedDurationMs: number;
  currentWorkStartedAt?: number;
  isFinished: boolean; // Whether the session is done/idle/error

  // Legacy timestamp-based tracking (PTY sessions)
  startedAt?: number;
  endedAt?: number;

  // UI state
  unread?: boolean; // Whether the session completed and user hasn't viewed it yet
  latestMessage?: string; // Latest assistant text message snippet for SDK sessions

  // AI-generated metadata (from Gemini)
  aiMetadata?: SessionAiMetadata;

  // Pending repo selection info (for pending_repo status)
  pendingRepoSelection?: {
    transcript: string;
    recommendedIndex: number | null;
    reasoning: string;
    confidence: string;
  };

  // Plan mode state
  planMode?: PlanModeState;

  // Note mode state
  noteMode?: NoteModeState;

  // Pending plan approval (ExitPlanMode waiting for user)
  pendingPlanApproval?: boolean;
  // Pending AskUserQuestion (Claude asking user a question)
  askUserQuestion?: boolean;

  // Sequence execution fields
  sequenceStatus?: ExecutionStatus;
  sequenceProgress?: { completed: number; total: number };

  // SDK todo/task progress (from TodoWrite tool calls)
  todoProgress?: { completed: number; total: number };

  // Fork lineage (SDK sessions)
  forkInfo?: {
    parentSessionId: string;
    parentLabel?: string;
    inheritedMessageCount: number;
  };

  // Notion card linked to this session
  notionCard?: { id: string; title: string };

  // Pile item this session was launched from
  pileItem?: { id: string; title: string };

  // Smart Queue: a never-launched session parked until its provider's usage
  // window resets or a scheduled window boundary (status === 'queued').
  queueInfo?: QueueInfo | null;
  // Smart Queue: a live session with a pending turn waiting to be re-sent
  // (rate-limit reset or scheduled send; surfaces as status 'rate_limited').
  rateLimited?: RateLimitedState | null;
}
