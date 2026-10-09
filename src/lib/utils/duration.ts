// Duration formatting utilities

/**
 * Format elapsed time in seconds to human-readable string
 * @param elapsedSeconds - Number of seconds elapsed
 * @returns Formatted string like "5s", "2m 30s", "1h 15m"
 */
export function formatDuration(elapsedSeconds: number): string {
  const mins = Math.floor(elapsedSeconds / 60);
  const secs = elapsedSeconds % 60;

  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    return `${hrs}h ${remainingMins}m`;
  }
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

/**
 * Run time of a finished tool call (tool_start → tool_result), or '' when unknown or
 * under a second — a duration on every quick Read/Grep card would just be noise.
 */
export function formatToolRunDuration(startedAt: number | undefined, endedAt: number): string {
  if (startedAt === undefined) return '';
  const seconds = Math.floor((endedAt - startedAt) / 1000);
  return seconds >= 1 ? formatDuration(seconds) : '';
}

/**
 * Get elapsed time for SDK sessions using timer-based tracking
 * @param accumulatedDurationMs - Total accumulated work time in milliseconds
 * @param currentWorkStartedAt - Timestamp when current work period started (if working)
 * @param isFinished - Whether the session is finished working
 * @param nowSeconds - Current time in seconds (for live updates)
 * @returns Formatted duration string, or null if session hasn't started working yet
 */
export function getElapsedTime(
  accumulatedDurationMs: number,
  currentWorkStartedAt: number | undefined,
  isFinished: boolean,
  nowSeconds: number
): string | null {
  // If no work has been done yet (no accumulated time and not currently working)
  if (accumulatedDurationMs === 0 && !currentWorkStartedAt) {
    return null;
  }

  let totalMs = accumulatedDurationMs;

  // If currently working, add the live elapsed time
  if (currentWorkStartedAt && !isFinished) {
    const liveElapsedMs = (nowSeconds * 1000) - currentWorkStartedAt;
    totalMs += Math.max(0, liveElapsedMs);
  }

  const elapsedSeconds = Math.floor(totalMs / 1000);
  return formatDuration(elapsedSeconds);
}

/** Zero-padded local wall-clock time, e.g. "09:00" (24h — matches the schedule presets). */
function formatClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Absolute label for a scheduled moment (native scheduling / Smart Queue custom times).
 * Short and calendar-anchored rather than a countdown — surfaces that show a countdown
 * render it alongside this.
 *
 * "today 14:30" / "tomorrow 09:00" / "Fri 09:00" (within a week) / "Aug 12 09:00" (beyond).
 * @param ts - Target time (epoch ms)
 * @param nowMs - Reference "now" (epoch ms), injectable for live-ticking callers
 */
export function formatScheduleTarget(ts: number, nowMs: number = Date.now()): string {
  const target = new Date(ts);
  const time = formatClock(target);

  // Compare calendar days (not 24h spans) so "tomorrow 09:00" reads correctly at 23:00.
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDelta = Math.round((startOfDay(target) - startOfDay(new Date(nowMs))) / 86_400_000);

  if (dayDelta === 0) return `today ${time}`;
  if (dayDelta === 1) return `tomorrow ${time}`;
  if (dayDelta > 1 && dayDelta < 7) {
    return `${target.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  }
  return `${target.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

/**
 * Extract repository name from a path
 * @param path - Full repository path
 * @returns The last segment of the path (repo name)
 */
export function getRepoName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}
