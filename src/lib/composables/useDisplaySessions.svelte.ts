// Composable for combining PTY and SDK sessions into a unified display list

import { invoke } from '@tauri-apps/api/core';
import type { TerminalSession } from '$lib/stores/sessions';
import type { SdkSession } from '$lib/stores/sdkSessions';
import type { SessionSortOrder } from '$lib/stores/settings';
import type { DisplaySession } from '$lib/types/session';
import { getStatusSortOrder, isFinishedStatus } from '$lib/utils/sessionStatus';

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

  // Handle initializing status
  if (session.status === 'initializing') {
    return { status: 'initializing' };
  }

  if (session.status === 'error') {
    return { status: 'error' };
  }

  if (session.status === 'querying') {
    // Find the last tool_start that doesn't have a matching tool_result after it
    // Also track if we're in a subagent
    let inSubagent = false;
    let subagentType: string | undefined;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];

      // Track subagent state (stop before start when iterating backwards)
      if (msg.type === 'subagent_stop') {
        continue;
      }
      if (msg.type === 'subagent_start') {
        inSubagent = true;
        subagentType = msg.agentType;
        continue;
      }

      if (msg.type === 'tool_start') {
        if (inSubagent) {
          return { status: 'subagent', detail: subagentType || 'Agent' };
        }

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
        if (inSubagent) {
          return { status: 'subagent', detail: subagentType || 'Agent' };
        }
        return { status: 'thinking' };
      }
      if (msg.type === 'text') {
        if (inSubagent) {
          return { status: 'subagent', detail: subagentType || 'Agent' };
        }
        return { status: 'responding' };
      }
    }

    if (inSubagent) {
      return { status: 'subagent', detail: subagentType || 'Agent' };
    }
    return { status: 'thinking' };
  }

  // Idle states
  if (messages.length === 0) {
    return { status: 'new' };
  }

  const lastMsg = messages.at(-1);
  if (lastMsg?.type === 'done') {
    return { status: 'done' };
  }

  // Check if there's an unfinished subagent
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'subagent_stop' || msg.type === 'done') {
      break;
    }
    if (msg.type === 'subagent_start') {
      return { status: 'subagent', detail: msg.agentType || 'Agent' };
    }
  }

  return { status: 'idle' };
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
 * Transform PTY and SDK sessions into unified DisplaySession format
 */
export function transformToDisplaySessions(
  ptySessions: TerminalSession[],
  sdkSessionsList: SdkSession[],
  sortOrder: SessionSortOrder
): DisplaySession[] {
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
      startedAt: s.created_at,
      accumulatedDurationMs: 0,
      currentWorkStartedAt: undefined,
      isFinished: s.status === 'Completed' || s.status === 'Failed'
    })),
    ...sdkSessionsList.map((s) => {
      const smartStatus = getSdkSmartStatus(s);
      const finished = isFinishedStatus(smartStatus.status);

      return {
        id: s.id,
        type: 'sdk' as const,
        status: smartStatus.status,
        statusDetail: smartStatus.detail,
        prompt:
          s.messages.find((m) => m.type === 'user')?.content ||
          s.pendingPrompt ||
          s.pendingRepoSelection?.transcript ||
          s.pendingTranscription?.transcript ||
          '',
        repoPath: s.cwd,
        model: s.model,
        createdAt: Math.floor(s.createdAt / 1000),
        startedAt: s.startedAt ? Math.floor(s.startedAt / 1000) : undefined,
        accumulatedDurationMs: s.accumulatedDurationMs || 0,
        currentWorkStartedAt: s.currentWorkStartedAt,
        isFinished: finished,
        unread: s.unread,
        latestMessage: getLatestTextMessage(s.messages),
        aiMetadata: s.aiMetadata,
        pendingRepoSelection: s.pendingRepoSelection,
        planMode: s.planMode,
        noteMode: s.noteMode
      };
    })
  ];

  // Sort sessions based on user preference
  return baseSessions.sort((a, b) => {
    if (sortOrder === 'StatusThenChronological') {
      const statusDiff = getStatusSortOrder(a.status) - getStatusSortOrder(b.status);
      if (statusDiff !== 0) return statusDiff;
    }
    // Chronological: newest first
    return b.createdAt - a.createdAt;
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
