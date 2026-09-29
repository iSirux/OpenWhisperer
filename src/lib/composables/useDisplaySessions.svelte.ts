// Composable for combining SDK sessions and sequence executions into a unified display list

import { invoke } from '@tauri-apps/api/core';
import { parkedTurnsOf, type SdkSession } from '$lib/stores/sdkSessions';
import type { SessionSortOrder } from '$lib/stores/settings';
import type { DisplaySession } from '$lib/types/session';
import type { SequenceExecution, ExecutionStatus } from '$lib/types/sequence';
import { getStatusSortOrder, isFinishedStatus } from '$lib/utils/sessionStatus';
import { getStatusString } from '$lib/stores/sequenceExecutions';
import { scanTranscript, scanTranscriptFull, pruneTranscriptScans } from './transcriptScan';

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
 * Compute the currently-live subagents from the message stream: unmatched
 * subagent_start markers, matched to stops by agentId (subagents run in
 * parallel, so the most recent start is not necessarily the one that stopped).
 * Reset at each turn boundary (done/stopped) so stale markers from a crashed
 * or restored turn don't linger. Incremental per session (see transcriptScan).
 */
function getLiveSubagentTypes(session: SdkSession): string[] {
  return scanTranscript(session.id, session.messages).liveSubagentTypes;
}

/**
 * Build the subagent status detail: the agent type when there's a single kind,
 * with a count suffix when several run at once (e.g. "explore ×3", "Agent ×4").
 * `count` may exceed `types.length` when background-task tracking sees agents
 * whose subagent hook events haven't arrived (yet).
 */
function formatSubagentDetail(types: string[], count = types.length): string {
  const unique = new Set(types);
  const base = unique.size === 1 && types.length === count ? types[0] : 'Agent';
  return count > 1 ? `${base} ×${count}` : (types[0] ?? 'Agent');
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
  // the message-derived querying/idle status below). A turn parked until the
  // repo/worktree goes idle isn't a rate-limit condition — it surfaces as queued,
  // except while this session's own query is still running (stay querying).
  const parked = parkedTurnsOf(session);
  if (parked.length > 0) {
    // A turn rejected mid-run by a rate limit is a real blocked state, whatever the
    // session is doing now. A deliberately-deferred turn is not: if the session is
    // still working, it stays "querying" and the parked turn shows as a ghost bubble.
    if (parked.some((t) => t.reason === 'rate_limit')) {
      return { status: 'rate_limited' };
    }
    if (session.status !== 'querying' && session.status !== 'initializing') {
      return { status: parked.some((t) => t.reason === 'scheduled') ? 'rate_limited' : 'queued' };
    }
  }

  // Handle initializing status
  if (session.status === 'initializing') {
    return { status: 'initializing' };
  }

  if (session.status === 'error') {
    return { status: 'error' };
  }

  if (session.status === 'querying') {
    // Phase 1: Check if we're inside active subagents. Two channels track the
    // same population: subagent_start/stop markers (SDK hooks) and agent-kind
    // background tasks (task_started events — these arrive in-stream, so they
    // can see background agents before/without the hook events). Use whichever
    // sees more; max avoids double counting agents visible on both.
    const liveTypes = getLiveSubagentTypes(session);
    const liveAgentTasks = (session.liveBackgroundTasks ?? []).filter(t => t.kind === 'agent').length;
    const liveCount = Math.max(liveTypes.length, liveAgentTasks);
    if (liveCount > 0) {
      return { status: 'subagent', detail: formatSubagentDetail(liveTypes, liveCount) };
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

  // Check if there are unfinished subagents
  const unfinished = getLiveSubagentTypes(session);
  if (unfinished.length > 0) {
    return { status: 'subagent', detail: formatSubagentDetail(unfinished) };
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
 * Full scan; the session list uses the incremental per-session fold in
 * transcriptScan.ts, which implements the same rules.
 */
export function getTodoProgress(messages: SdkSession['messages']):
  { completed: number; total: number } | undefined {
  return scanTranscriptFull(messages).todoProgress;
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

// Prompt / latest-message / label previews are line-clamped in the list, but the
// full string would still be laid out (and put in a title attribute) on every
// render — agent replies can run to many KB. Cap them in the transform.
const MAX_PREVIEW_CHARS = 300;

function capPreview(text: string): string;
function capPreview(text: string | undefined): string | undefined;
function capPreview(text: string | undefined): string | undefined {
  if (!text || text.length <= MAX_PREVIEW_CHARS) return text;
  return text.slice(0, MAX_PREVIEW_CHARS).trimEnd() + '…';
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

  const firstUserPrompt = scanTranscript(session.id, session.messages).firstUserContent?.trim();
  if (firstUserPrompt) return firstUserPrompt;

  const draftPrompt = session.draftPrompt?.trim();
  if (draftPrompt) return draftPrompt;

  const pendingPrompt = session.preparedPrompt?.trim() || session.pendingPrompt?.trim();
  if (pendingPrompt) return pendingPrompt;

  return undefined;
}

/**
 * Transform SDK sessions and sequence executions into unified DisplaySession format
 */
export function transformToDisplaySessions(
  sdkSessionsList: SdkSession[],
  sortOrder: SessionSortOrder,
  sequenceExecutions: SequenceExecution[] = []
): DisplaySession[] {
  // Fork parents' labels, resolved lazily (only forked sessions need one).
  let sessionById: Map<string, SdkSession> | undefined;
  const parentLabelOf = (s: SdkSession): string | undefined => {
    if (!s.forkedFromSessionId) return undefined;
    if (s.forkedFromSessionLabel) return capPreview(s.forkedFromSessionLabel);
    sessionById ??= new Map(sdkSessionsList.map((session) => [session.id, session]));
    const parent = sessionById.get(s.forkedFromSessionId);
    return parent ? capPreview(getSessionLabel(parent)) : undefined;
  };

  // Build base sessions (memoized per session object — see buildSdkDisplaySession)
  const baseSessions: DisplaySession[] = [
    ...sdkSessionsList.map((s) => {
      const parentLabel = parentLabelOf(s);
      const cached = sdkDisplayCache.get(s);
      if (cached && cached.parentLabel === parentLabel) return cached.display;
      const display = buildSdkDisplaySession(s, parentLabel);
      sdkDisplayCache.set(s, { display, parentLabel });
      return display;
    }),
    ...sequenceExecutions.map((exec) => {
      let display = sequenceDisplayCache.get(exec);
      if (!display) {
        display = buildSequenceDisplaySession(exec);
        sequenceDisplayCache.set(exec, display);
      }
      return display;
    })
  ];

  pruneTranscriptScans(new Set(sdkSessionsList.map((s) => s.id)));

  // Sort sessions based on user preference
  return baseSessions.sort((a, b) => {
    // Pinned sessions always float to the top
    const pinDiff = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    if (pinDiff !== 0) return pinDiff;
    // Within the pinned group, order by when they were pinned so a newly pinned
    // item lands at the bottom of the pins (just above the unpinned sessions).
    if (a.pinned && b.pinned) {
      const pinnedAtDiff = (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0);
      if (pinnedAtDiff !== 0) return pinnedAtDiff;
    }
    if (sortOrder === 'StatusThenChronological') {
      const statusDiff = getStatusSortOrder(a.status) - getStatusSortOrder(b.status);
      if (statusDiff !== 0) return statusDiff;
    }
    // Chronological: most recently active first
    return b.lastActivityAt - a.lastActivityAt;
  });
}

// The store never mutates sessions in place (updates rebuild the changed session
// object), so a session object seen before maps to the same DisplaySession — the
// list re-renders only the rows whose session actually changed. The cached
// objects are shared: callers must not mutate them (copy instead).
const sdkDisplayCache = new WeakMap<
  SdkSession,
  { display: DisplaySession; parentLabel: string | undefined }
>();
const sequenceDisplayCache = new WeakMap<SequenceExecution, DisplaySession>();

function buildSdkDisplaySession(s: SdkSession, parentLabel: string | undefined): DisplaySession {
  const smartStatus = getSdkSmartStatus(s);
  const finished = isFinishedStatus(smartStatus.status);
  const scan = scanTranscript(s.id, s.messages);
  const todoProgress = scan.todoProgress;
  const showBranch = smartStatus.status !== 'setup';
  return {
    id: s.id,
    type: 'sdk' as const,
    status: smartStatus.status,
    statusDetail: smartStatus.detail,
    prompt: capPreview(
      scan.firstUserContent ||
      s.preparedPrompt ||
      s.pendingPrompt ||
      s.pendingRepoSelection?.transcript ||
      s.pendingTranscription?.transcript ||
      ''
    ),
    // Always use the active session cwd for branch lookup/display.
    // repoId is still carried separately for stable repo metadata (icon/name).
    repoPath: s.cwd,
    repoId: s.repoId,
    // Seed branch from session metadata (e.g. worktree branch set during setup)
    // so it displays immediately before the async git fetch fills it in.
    branch: showBranch ? (s.currentBranch || undefined) : undefined,
    // A setup session's cwd stays on the main checkout until launch; carry the
    // picked worktree so the grouped sidebar can file the draft under it.
    setupWorktreePath:
      !showBranch && s.setupWorktreeMode === 'existing' ? s.setupWorktreePath : undefined,
    model: s.model,
    createdAt: Math.floor(s.createdAt / 1000),
    lastActivityAt: Math.floor(s.lastActivityAt / 1000),
    startedAt: s.startedAt ? Math.floor(s.startedAt / 1000) : undefined,
    accumulatedDurationMs: s.accumulatedDurationMs || 0,
    currentWorkStartedAt: s.currentWorkStartedAt,
    isFinished: finished,
    unread: s.unread,
    pinned: s.pinned,
    pinnedAt: s.pinnedAt,
    latestMessage: capPreview(scan.latestText),
    aiMetadata: s.aiMetadata,
    pendingRepoSelection: s.pendingRepoSelection,
    pendingPlanApproval: !!s.pendingPlanApproval,
    askUserQuestion: !!(s.askUserQuestion?.questions?.length),
    provider: s.provider,
    accountId: s.accountId,
    todoProgress,
    forkInfo: s.forkedFromSessionId
      ? {
          parentSessionId: s.forkedFromSessionId,
          parentLabel,
          inheritedMessageCount: s.forkedMessageCount ?? 0,
        }
      : undefined,
    notionCard: s.notionCard,
    githubIssue: s.githubIssue,
    pr: s.pr ?? undefined,
    validation: s.validation ?? undefined,
    pileItem: s.pileItem,
    sequenceNode: s.sequenceNode,
    spareTokens: s.spareTokens,
    scheduleTag: s.scheduleTag,
    queueInfo: s.queueInfo,
    parkedTurns: s.parkedTurns,
  };
}

function buildSequenceDisplaySession(exec: SequenceExecution): DisplaySession {
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
