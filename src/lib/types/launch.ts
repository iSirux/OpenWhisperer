/** A single runnable command/service for a repository (e.g., "npm run dev") */
export interface LaunchCommand {
  /** Unique identifier (UUID) */
  id: string;
  /** Display name (e.g., "Frontend Dev Server") */
  name: string;
  /** Shell command to execute (e.g., "npm run dev") */
  command: string;
  /** Working directory relative to repo root (for monorepo sub-projects) */
  working_dir?: string;
  /** Extra environment variables to set */
  env?: Record<string, string>;
  /** Whether this command was auto-detected by scanning the repo */
  auto_detected?: boolean;
}

/** A named group of launch commands that can be started together */
export interface LaunchProfile {
  /** Unique identifier (UUID) */
  id: string;
  /** Display name (e.g., "Full Stack", "Frontend Only") */
  name: string;
  /** List of LaunchCommand IDs to include in this profile */
  command_ids: string[];
}

/** Runtime state for a currently running launch profile */
export interface LaunchRuntime {
  repoId: string;
  profileId?: string;
  profileName?: string;
  runningCommandIds: string[];
  startedAt: number;
  /** The session cwd at the time of launch — may be a worktree path */
  launchedFromCwd?: string;
}

/** A launch that's queued to execute after the current agent finishes */
export interface QueuedLaunch {
  repoId: string;
  profileId: string;
  profileName: string;
  sessionId: string;
}
