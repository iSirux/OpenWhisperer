// Shared session types used across SessionList and SessionCard components

import type { SessionAiMetadata, PlanModeState, NoteModeState } from '$lib/stores/sdkSessions';

/**
 * Unified session type for display in the session list and grid views.
 * Combines both PTY and SDK session data into a common format.
 */
export interface DisplaySession {
  id: string;
  type: 'pty' | 'sdk';
  status: string;
  statusDetail?: string; // e.g., tool name being run
  prompt: string;
  repoPath: string;
  model?: string; // model name for SDK sessions
  createdAt: number; // When the session was created (for sorting)
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
}
