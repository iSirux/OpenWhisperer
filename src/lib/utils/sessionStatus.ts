// Session status utilities for consistent status styling across the app

/**
 * Status categories for grouping related statuses
 */
export type StatusCategory = 'pending' | 'active' | 'ready' | 'error';

/**
 * Get the status category for sorting and grouping
 */
export function getStatusCategory(status: string): StatusCategory {
  switch (status) {
    case 'setup':
    case 'pending_transcription':
    case 'transcription_error':
    case 'pending_repo':
    case 'initializing':
    case 'Starting':
      return 'pending';

    case 'Running':
    case 'querying':
    case 'tool':
    case 'thinking':
    case 'responding':
    case 'subagent':
    case 'seq_running':
      return 'active';

    case 'Failed':
    case 'error':
    case 'seq_failed':
    case 'seq_cancelled':
      return 'error';

    case 'prepared':
      return 'ready';

    default:
      return 'ready';
  }
}

/**
 * Get the text color class for a status
 */
export function getStatusColor(status: string): string {
  switch (status) {
    case 'setup':
      return 'text-text-muted';
    case 'Starting':
    case 'initializing':
      return 'text-yellow-400';
    case 'pending_transcription':
      return 'text-violet-400';
    case 'prepared':
      return 'text-teal-400';
    case 'queued':
      return 'text-sky-400';
    case 'rate_limited':
      return 'text-amber-400';
    case 'pending_repo':
      return 'text-amber-400';
    case 'pending_plan_approval':
      return 'text-cyan-400';
    case 'awaiting_input':
      return 'text-orange-400';
    case 'Running':
    case 'querying':
    case 'tool':
    case 'thinking':
    case 'responding':
    case 'subagent':
    case 'seq_running':
      return 'text-emerald-400';
    case 'seq_paused':
    case 'seq_waiting':
      return 'text-yellow-400';
    case 'Completed':
    case 'idle':
    case 'done':
    case 'stopped':
    case 'seq_completed':
      return 'text-blue-400';
    case 'new':
      return 'text-text-muted';
    case 'Failed':
    case 'error':
    case 'transcription_error':
    case 'seq_failed':
    case 'seq_cancelled':
      return 'text-red-400';
    default:
      return 'text-text-muted';
  }
}

/**
 * Get the background color class for a status indicator dot
 */
export function getStatusBgColor(status: string): string {
  switch (status) {
    case 'setup':
      return 'bg-slate-400';
    case 'Starting':
    case 'initializing':
      return 'bg-yellow-400';
    case 'pending_transcription':
      return 'bg-violet-400';
    case 'prepared':
      return 'bg-teal-400';
    case 'queued':
      return 'bg-sky-400';
    case 'rate_limited':
      return 'bg-amber-400';
    case 'pending_repo':
      return 'bg-amber-400';
    case 'pending_plan_approval':
      return 'bg-cyan-400';
    case 'awaiting_input':
      return 'bg-orange-400';
    case 'Running':
    case 'querying':
    case 'tool':
    case 'thinking':
    case 'responding':
    case 'subagent':
    case 'seq_running':
      return 'bg-emerald-400';
    case 'seq_paused':
    case 'seq_waiting':
      return 'bg-yellow-400';
    case 'Completed':
    case 'idle':
    case 'done':
    case 'stopped':
    case 'seq_completed':
      return 'bg-blue-400';
    case 'new':
      return 'bg-slate-400';
    case 'Failed':
    case 'error':
    case 'transcription_error':
    case 'seq_failed':
    case 'seq_cancelled':
      return 'bg-red-400';
    default:
      return 'bg-text-muted';
  }
}

/**
 * Map raw Claude SDK agent types to friendly activity-style labels.
 */
function getSubagentLabel(agentType: string): string {
  switch (agentType.toLowerCase()) {
    case 'explore':
      return 'Exploring';
    case 'plan':
      return 'Planning';
    case 'general-purpose':
      return 'Researching';
    case 'bash':
      return 'Running';
    case 'statusline-setup':
      return 'Configuring';
    default:
      if (agentType && agentType.length > 0) {
        return agentType.charAt(0).toUpperCase() + agentType.slice(1);
      }
      return 'Agent';
  }
}

/**
 * Map raw Claude SDK tool names to friendly activity-style labels.
 * Handles count suffixes like "Read ×3" -> "Reading ×3".
 */
function getToolLabel(detail: string): string {
  // Parse out the optional count suffix (e.g., " ×3")
  const countMatch = detail.match(/^(.+?)(\s*×\d+)$/);
  const baseTool = countMatch ? countMatch[1].trim() : detail.trim();
  const countSuffix = countMatch ? countMatch[2] : '';

  let label: string;

  switch (baseTool) {
    case 'Read':
      label = 'Reading';
      break;
    case 'Write':
      label = 'Writing';
      break;
    case 'Edit':
      label = 'Editing';
      break;
    case 'Bash':
      label = 'Executing';
      break;
    case 'Grep':
    case 'Glob':
      label = 'Searching';
      break;
    case 'WebFetch':
      label = 'Fetching';
      break;
    case 'WebSearch':
      label = 'Searching';
      break;
    case 'Task':
      label = 'Delegating';
      break;
    case 'TodoWrite':
    case 'TaskUpdate':
      label = 'Updating tasks';
      break;
    case 'TaskCreate':
      label = 'Planning tasks';
      break;
    case 'NotebookEdit':
      label = 'Editing notebook';
      break;
    case 'LSP':
      label = 'Analyzing';
      break;
    case 'EnterWorktree':
      label = 'Branching';
      break;
    case 'ToolSearch':
      label = 'Discovering';
      break;
    case 'Skill':
      label = 'Running skill';
      break;
    default:
      // Handle MCP tools: "mcp__server__tool" -> "Running tool"
      if (baseTool.startsWith('mcp__')) {
        const parts = baseTool.split('__');
        const mcpToolName = parts.length >= 3 ? parts[parts.length - 1] : undefined;
        label = mcpToolName ? `Running ${mcpToolName}` : 'Running MCP';
      } else {
        label = baseTool.length > 0
          ? baseTool.charAt(0).toUpperCase() + baseTool.slice(1)
          : 'Tool';
      }
      break;
  }

  return label + countSuffix;
}

/**
 * Get the human-readable label for a status
 */
export function getStatusLabel(status: string, detail?: string): string {
  switch (status) {
    case 'setup':
      return 'New Session';
    case 'pending_transcription':
      // detail contains the sub-status: 'recording', 'transcribing', 'processing'
      if (detail === 'recording') return 'Recording';
      if (detail === 'transcribing') return 'Transcribing';
      if (detail === 'processing') return 'Processing';
      return 'Pending';
    case 'transcription_error':
      return 'Retry?';
    case 'prepared':
      return 'Prepared';
    case 'queued':
      return 'Queued';
    case 'rate_limited':
      return 'Rate limited';
    case 'pending_repo':
      return 'Select Repo';
    case 'pending_plan_approval':
      return 'Review Plan';
    case 'awaiting_input':
      return 'Input Needed';
    case 'initializing':
    case 'Starting':
      return 'Starting';
    case 'Running':
    case 'querying':
      return 'Active';
    case 'tool':
      return detail ? getToolLabel(detail) : 'Tool';
    case 'subagent':
      return detail ? getSubagentLabel(detail) : 'Agent';
    case 'thinking':
      return 'Thinking';
    case 'responding':
      return 'Responding';
    case 'idle':
      return 'Ready';
    case 'stopped':
      return 'Stopped';
    case 'done':
    case 'Completed':
    case 'seq_completed':
      return 'Done';
    case 'new':
      return 'New';
    case 'Failed':
    case 'error':
      return 'Error';
    case 'seq_running':
      return 'Running';
    case 'seq_paused':
      return 'Paused';
    case 'seq_waiting':
      return 'Waiting';
    case 'seq_failed':
      return 'Failed';
    case 'seq_cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

/**
 * Check if a status should show an animation (pulsing dot)
 */
export function isStatusAnimating(status: string): boolean {
  return [
    'Running',
    'Starting',
    'querying',
    'tool',
    'thinking',
    'responding',
    'subagent',
    'seq_running'
  ].includes(status);
}

/**
 * Check if a session is actively working based on its status
 */
export function isActivelyWorking(status: string): boolean {
  return [
    'Starting',
    'Running',
    'querying',
    'tool',
    'thinking',
    'responding',
    'subagent',
    'seq_running'
  ].includes(status);
}

/**
 * Check if a status indicates the session is finished
 */
export function isFinishedStatus(status: string): boolean {
  return ['done', 'stopped', 'idle', 'error', 'new', 'Completed', 'Failed', 'seq_completed', 'seq_failed', 'seq_cancelled'].includes(status);
}

/**
 * Status sort order for StatusThenChronological sorting
 * Lower numbers appear first
 */
export function getStatusSortOrder(status: string): number {
  switch (status) {
    // Setup and pending at top (user action needed or in progress)
    case 'setup':
      return -2;
    case 'pending_transcription':
    case 'transcription_error':
      return -1;
    case 'prepared':
      return -0.5;
    // Queued sits just after prepared (both are parked, ready-to-dispatch work)
    case 'queued':
      return -0.4;
    case 'pending_repo':
    case 'initializing':
    case 'Starting':
    case 'Running':
    case 'querying':
    case 'tool':
    case 'thinking':
    case 'responding':
    case 'subagent':
    case 'seq_running':
    case 'seq_waiting':
    // Rate-limited is a live session needing attention — group it with active
    case 'rate_limited':
      return 0;
    case 'idle':
    case 'new':
    case 'seq_paused':
      return 1;
    case 'Completed':
    case 'stopped':
    case 'done':
    case 'seq_completed':
      return 2;
    case 'Failed':
    case 'error':
    case 'seq_failed':
    case 'seq_cancelled':
      return 3;
    default:
      return 4;
  }
}
