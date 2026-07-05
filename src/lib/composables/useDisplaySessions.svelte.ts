// Composable for combining PTY and SDK sessions into a unified display list

import { invoke } from '@tauri-apps/api/core';
import type { TerminalSession } from '$lib/stores/sessions';
import type { SdkSession } from '$lib/stores/sdkSessions';
import type { SessionSortOrder } from '$lib/stores/settings';
import type { DisplaySession } from '$lib/types/session';
import type { SequenceExecution, ExecutionStatus } from '$lib/types/sequence';
import { getStatusSortOrder, isFinishedStatus } from '$lib/utils/sessionStatus';
import { getStatusString } from '$lib/stores/sequenceExecutions';

// Cache for git branches to avoid repeated calls
const branchCache = new Map<string, string>();

async function getGitBranch(repoPath: string): Promise<string | undefined> {
  if (!repoPath || repoPath === '.') return undefined;

  if (branchCache.has(repoPath)) {
    return branchCache.get(repoPath);
  }

  try {
    const branch = await invoke<string>('get_git_branch', { repoPath });
    if (branch) {
      branchCache.set(repoPath, branch);
      return branch;
    }
  } catch {
    // Not a git repo or error getting branch, silently ignore
  }

  return undefined;
}

/**
 * Get smart status for SDK sessions based on messages
 */
export function getSdkSmartStatus(session: SdkSession): {
  status: string;
  detail?: string;
} {
  const messages = session.messages;

  // Handle setup status (user configuring session before starting)
  if (session.status === 'setup') {
    return { status: 'setup' };
  }

  // Handle pending_transcription status
  if (session.status === 'pending_transcription') {
    const subStatus = session.pendingTranscription?.status || 'recording';
    // Check for transcription error
    if (session.pendingTranscription?.transcriptionError) {
      return {
        status: 'transcription_error',
        detail: session.pendingTranscription.transcriptionError
      };
    }
    return { status: 'pending_transcription', detail: subStatus };
  }

  // Handle pending_repo status
  if (session.status === 'pending_repo') {
    return { status: 'pending_repo' };
  }

  // Handle pending plan approval (ExitPlanMode intercepted)
  if (session.pendingPlanApproval) {
    return { status: 'pending_plan_approval' };
  }

  // Handle pending AskUserQuestion
  if (session.askUserQuestion?.questions?.length) {
    return { status: 'awaiting_input' };
  }

  // Handle queued status (Smart Queue: a never-launched session parked until
  // its provider's usage window resets or a scheduled window boundary passes)
  if (session.status === 'queued') {
    return { status: 'queued' };
  }

  // Smart Queue: a live session with a pending turn waiting on a rate-limit
  // reset or a scheduled send surfaces as rate_limited (takes precedence over
  // the message-derived querying/idle status below).
  if (session.rateLimited != null) {
    return { status: 'rate_limited' };
  }

  // Handle initializing status
  if (session.status === 'initializing') {
    return { status: 'initializing' };
  }

  if (session.status === 'error') {
    return { status: 'error' };
  }

  if (session.status === 'querying') {
    // Phase 1: Check if we're inside an active subagent.
    // Scan backwards — if we find subagent_start before subagent_stop,
    // the subagent is still running. Its internal tool/text messages appear
    // AFTER (higher index than) the subagent_start, so a single backwards
    // pass that checks tool/text would return early before ever reaching it.
    let activeSubagentType: string | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'subagent_stop') {
        break; // Most recent subagent has ended
      }
      if (msg.type === 'subagent_start') {
        activeSubagentType = msg.agentType;
        break; // Found an active (unclosed) subagent
      }
    }

    if (activeSubagentType) {
      return { status: 'subagent', detail: activeSubagentType };
    }

    // Phase 2: No active subagent — determine status from latest messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];

      // Skip subagent markers (already handled above)
      if (msg.type === 'subagent_start' || msg.type === 'subagent_stop') {
        continue;
      }

      if (msg.type === 'tool_start') {
        // Count consecutive calls to this same tool
        let count = 1;
        const currentTool = msg.tool;

        for (let j = i - 1; j >= 0; j--) {
          const prevMsg = messages[j];
          if (prevMsg.type === 'tool_start') {
            if (prevMsg.tool === currentTool) {
              count++;
            } else {
              break;
            }
          }
        }

        const detail = count > 1 ? `${msg.tool} ×${count}` : msg.tool;
        return { status: 'tool', detail };
      }
      if (msg.type === 'tool_result') {
        return { status: 'thinking' };
      }
      if (msg.type === 'text') {
        return { status: 'responding' };
      }
    }

    return { status: 'thinking' };
  }

  // Idle states
  if (messages.length === 0) {
    return { status: 'new' };
  }

  const lastMsg = messages.at(-1);
  if (lastMsg?.type === 'stopped') {
    return { status: 'stopped' };
  }
  if (lastMsg?.type === 'done') {
    return { status: 'done' };
  }

  // Check if there's an unfinished subagent
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'subagent_stop' || msg.type === 'done' || msg.type === 'stopped') {
      break;
    }
    if (msg.type === 'subagent_start') {
      return { status: 'subagent', detail: msg.agentType || 'Agent' };
    }
  }

  return { status: 'idle' };
}

/**
 * Extract todo/task progress from the SDK message stream.
 *
 * Claude Code replaced the single-snapshot `TodoWrite` tool (one call carried the
 * full list) with per-task `TaskCreate`/`TaskUpdate` tools (each call touches one
 * task). We therefore accumulate across the whole session: every TaskCreate adds a
 * task (starting pending) and every TaskUpdate changes a task's status by id.
 * Falls back to the legacy TodoWrite snapshot for older/restored sessions.
 */
export function getTodoProgress(messages: SdkSession['messages']):
  { completed: number; total: number } | undefined {
  let hasTaskTools = false;
  let created = 0;
  // Latest status per task id (from TaskUpdate). Ids that never receive an
  // update simply stay pending and only contribute to the total via `created`.
  const statusById = new Map<string, string>();

  for (const msg of messages) {
    if (msg.type !== 'tool_start' || !msg.input) continue;
    if (msg.tool === 'TaskCreate') {
      hasTaskTools = true;
      created++;
    } else if (msg.tool === 'TaskUpdate') {
      hasTaskTools = true;
      const taskId = msg.input.taskId;
      const status = msg.input.status;
      if (typeof taskId === 'string' && typeof status === 'string') {
        statusById.set(taskId, status);
      }
    }
  }

  if (hasTaskTools) {
    let completed = 0;
    let deleted = 0;
    for (const status of statusById.values()) {
      if (status === 'deleted') deleted++;
      else if (status === 'completed') completed++;
    }
    const total = Math.max(0, created - deleted);
    if (total === 0) return undefined;
    return { completed: Math.min(completed, total), total };
  }

  // Legacy TodoWrite: a single message carries the full list snapshot. Scan
  // backwards and stop at the first match (the most recent todo state).
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'tool_start' && msg.tool === 'TodoWrite' && msg.input) {
      const todos = msg.input.todos as Array<{ status: string }> | undefined;
      if (todos && Array.isArray(todos) && todos.length > 0) {
        const completed = todos.filter(t => t.status === 'completed').length;
        return { completed, total: todos.length };
      }
    }
  }
  return undefined;
}

/**
 * Get the latest assistant text message from SDK messages
 */
export function getLatestTextMessage(messages: SdkSession['messages']): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'text' && msg.content) {
      return msg.content;
    }
  }
  return undefined;
}

/**
 * Map a sequence ExecutionStatus to a display status string
 */
function mapExecutionStatus(status: ExecutionStatus): string {
  const s = getStatusString(status);
  switch (s) {
    case 'running':
    case 'initializing':
      return 'seq_running';
    case 'completed':
      return 'seq_completed';
    case 'failed':
      return 'seq_failed';
    case 'cancelled':
      return 'seq_cancelled';
    case 'paused':
      return 'seq_paused';
    case 'waiting_for_approval':
      return 'seq_waiting';
    default:
      return 'seq_running';
  }
}

function getSessionLabel(session: SdkSession): string | undefined {
  const aiName = session.aiMetadata?.name?.trim();
  if (aiName) return aiName;

  const firstUserPrompt = session.messages.find((message) => message.type === 'user')?.content?.trim();
  if (firstUserPrompt) return firstUserPrompt;

  const draftPrompt = session.draftPrompt?.trim();
  if (draftPrompt) return draftPrompt;

  const pendingPrompt = session.preparedPrompt?.trim() || session.pendingPrompt?.trim();
  if (pendingPrompt) return pendingPrompt;

  return undefined;
}

/**
 * Transform PTY, SDK sessions, and sequence executions into unified DisplaySession format
 */
export function transformToDisplaySessions(
  ptySessions: TerminalSession[],
  sdkSessionsList: SdkSession[],
  sortOrder: SessionSortOrder,
  sequenceExecutions: SequenceExecution[] = []
): DisplaySession[] {
  const sdkLabelById = new Map(
    sdkSessionsList.map((session) => [session.id, getSessionLabel(session)])
  );

  // Build base sessions
  const baseSessions: DisplaySession[] = [
    ...ptySessions.map((s) => ({
      id: s.id,
      type: 'pty' as const,
      status: s.status,
      statusDetail: undefined,
      prompt: s.prompt,
      repoPath: s.repo_path,
      createdAt: s.created_at,
      lastActivityAt: s.created_at,
      startedAt: s.created_at,
      accumulatedDurationMs: 0,
      currentWorkStartedAt: undefined,
      isFinished: s.status === 'Completed' || s.status === 'Failed'
    })),
    ...sdkSessionsList.map((s) => {
      const smartStatus = getSdkSmartStatus(s);
      const finished = isFinishedStatus(smartStatus.status);
      const todoProgress = getTodoProgress(s.messages);
      const showBranch = smartStatus.status !== 'setup';
      return {
        id: s.id,
        type: 'sdk' as const,
        status: smartStatus.status,
        statusDetail: smartStatus.detail,
        prompt:
          s.messages.find((m) => m.type === 'user')?.content ||
          s.preparedPrompt ||
          s.pendingPrompt ||
          s.pendingRepoSelection?.transcript ||
          s.pendingTranscription?.transcript ||
          '',
        // Always use the active session cwd for branch lookup/display.
        // repoId is still carried separately for stable repo metadata (icon/name).
        repoPath: s.cwd,
        repoId: s.repoId,
        // Seed branch from session metadata (e.g. worktree branch set during setup)
        // so it displays immediately before the async git fetch fills it in.
        branch: showBranch ? (s.currentBranch || undefined) : undefined,
        model: s.model,
        createdAt: Math.floor(s.createdAt / 1000),
        lastActivityAt: Math.floor(s.lastActivityAt / 1000),
        startedAt: s.startedAt ? Math.floor(s.startedAt / 1000) : undefined,
        accumulatedDurationMs: s.accumulatedDurationMs || 0,
        currentWorkStartedAt: s.currentWorkStartedAt,
        isFinished: finished,
        unread: s.unread,
        latestMessage: getLatestTextMessage(s.messages),
        aiMetadata: s.aiMetadata,
        pendingRepoSelection: s.pendingRepoSelection,
        pendingPlanApproval: !!s.pendingPlanApproval,
        askUserQuestion: !!(s.askUserQuestion?.questions?.length),
        provider: s.provider,
        todoProgress,
        forkInfo: s.forkedFromSessionId
          ? {
              parentSessionId: s.forkedFromSessionId,
              parentLabel: s.forkedFromSessionLabel || sdkLabelById.get(s.forkedFromSessionId),
              inheritedMessageCount: s.forkedMessageCount ?? 0,
            }
          : undefined,
        notionCard: s.notionCard,
        pileItem: s.pileItem,
        queueInfo: s.queueInfo,
        rateLimited: s.rateLimited,
      };
    }),
    ...sequenceExecutions.map((exec) => {
      const displayStatus = mapExecutionStatus(exec.status);
      return {
        id: exec.id,
        type: 'sequence' as const,
        status: displayStatus,
        statusDetail: exec.total_nodes > 0
          ? `${exec.completed_node_ids.length}/${exec.total_nodes}`
          : undefined,
        prompt: exec.sequence_name,
        repoPath: '',
        createdAt: Math.floor(new Date(exec.started_at).getTime() / 1000),
        lastActivityAt: Math.floor(new Date(exec.started_at).getTime() / 1000),
        accumulatedDurationMs: exec.completed_at
          ? new Date(exec.completed_at).getTime() - new Date(exec.started_at).getTime()
          : 0,
        currentWorkStartedAt: !exec.completed_at
          ? new Date(exec.started_at).getTime()
          : undefined,
        isFinished: isFinishedStatus(displayStatus),
        sequenceStatus: exec.status,
        sequenceProgress: exec.total_nodes > 0
          ? { completed: exec.completed_node_ids.length, total: exec.total_nodes }
          : undefined,
      };
    })
  ];

  // Sort sessions based on user preference
  return baseSessions.sort((a, b) => {
    if (sortOrder === 'StatusThenChronological') {
      const statusDiff = getStatusSortOrder(a.status) - getStatusSortOrder(b.status);
      if (statusDiff !== 0) return statusDiff;
    }
    // Chronological: most recently active first
    return b.lastActivityAt - a.lastActivityAt;
  });
}

/**
 * Fetch and update branches for sessions asynchronously
 */
export async function fetchBranchesForSessions(
  sessions: DisplaySession[],
  updateCallback: (updatedSessions: DisplaySession[]) => void
): Promise<void> {
  const updates: Map<string, string> = new Map();

  await Promise.all(
    sessions.map(async (session) => {
      if (session.status === 'setup') return;
      const branch = await getGitBranch(session.repoPath);
      if (branch) {
        updates.set(session.id, branch);
      }
    })
  );

  if (updates.size > 0) {
    const updatedSessions = sessions.map((s) => {
      const branch = updates.get(s.id);
      return branch ? { ...s, branch } : s;
    });
    updateCallback(updatedSessions);
  }
}
