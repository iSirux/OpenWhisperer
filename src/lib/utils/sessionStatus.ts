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
    case 'pending_repo':
      return 'text-amber-400';
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
    case 'pending_repo':
      return 'bg-amber-400';
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
    case 'pending_repo':
      return 'Select Repo';
    case 'initializing':
    case 'Starting':
      return 'Starting';
    case 'Running':
    case 'querying':
      return 'Active';
    case 'tool':
      return detail || 'Tool';
    case 'subagent':
      return detail || 'Agent';
    case 'thinking':
      return 'Thinking';
    case 'responding':
      return 'Responding';
    case 'idle':
      return 'Ready';
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
  return ['done', 'idle', 'error', 'new', 'Completed', 'Failed', 'seq_completed', 'seq_failed', 'seq_cancelled'].includes(status);
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
      return 0;
    case 'idle':
    case 'new':
    case 'seq_paused':
      return 1;
    case 'Completed':
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
