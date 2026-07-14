// Shared session types used across SessionList and SessionCard components

import type { SessionAiMetadata, QueueInfo, RateLimitedState } from '$lib/stores/sdkSessions';
import type { SdkProvider } from '$lib/utils/models';
import type { ExecutionStatus } from '$lib/types/sequence';

/**
 * Unified session type for display in the session list and grid views.
 * Combines SDK session and sequence execution data into a common format.
 */
export interface DisplaySession {
  id: string;
  type: 'sdk' | 'sequence';
  status: string;
  statusDetail?: string; // e.g., tool name being run
  prompt: string;
  repoPath: string;
  repoId?: string; // Stable repo entity reference for icon/color/name resolution
  model?: string; // model name for SDK sessions
  provider?: SdkProvider; // SDK provider (claude or openai)
  accountId?: string; // agent account this session is pinned to (undefined = machine default)
  createdAt: number; // When the session was created
  lastActivityAt: number; // When the session last had activity (for sorting)
  branch?: string; // git branch name

  // Timer-based duration tracking (SDK sessions)
  accumulatedDurationMs: number;
  currentWorkStartedAt?: number;
  isFinished: boolean; // Whether the session is done/idle/error
  startedAt?: number; // When the first query started (epoch seconds)

  // UI state
  unread?: boolean; // Whether the session completed and user hasn't viewed it yet
  pinned?: boolean; // Pinned sessions sort to the top of the list (SDK sessions only)
  pinnedAt?: number; // When pinned (epoch ms); newer pins sort below earlier pins
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

  // GitHub issue linked to this session
  githubIssue?: { number: number; title: string; url: string };

  // Pile item this session was launched from
  pileItem?: { id: string; title: string };

  // Spare Tokens library prompt this session was launched from
  spareTokens?: { promptId: string; auto: boolean };

  // Smart Queue: a never-launched session parked until its provider's usage
  // window resets or a scheduled window boundary (status === 'queued').
  queueInfo?: QueueInfo | null;
  // Smart Queue: a live session with a pending turn waiting to be re-sent
  // (rate-limit reset or scheduled send; surfaces as status 'rate_limited').
  rateLimited?: RateLimitedState | null;
}
