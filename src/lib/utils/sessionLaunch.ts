/**
 * Shared session launch helpers.
 *
 * Extracted from NotionKanban so that any feature that batch-launches SDK
 * sessions (kanban cards, pile items, ...) shares the same machinery:
 *  - `launchSession` — create a setup session, optionally in a fresh git
 *    worktree, tag it with its source entity, and start it.
 *  - `createSessionQueue` — a sequential launch queue with optional random
 *    stagger delays between items (avoids hammering the sidecar/git).
 */

import { get, writable } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { sdkSessions, settingsToStoreEffort, type EffortLevel, type SdkImageContent } from '$lib/stores/sdkSessions';
import { settings } from '$lib/stores/settings';
import { activeRepo, type RepoConfig } from '$lib/stores/repos';
import { defaultAccountIdForRepo } from '$lib/utils/accounts';

export interface LaunchConfig {
  repo: RepoConfig;
  model: string;
  effortLevel: EffortLevel;
  provider: 'claude' | 'openai';
  /** Agent account to pin the launched session to (undefined = machine default). */
  accountId?: string;
}

interface WorktreeCreationResult {
  worktree_path: string;
  branch: string;
}

/** Source-entity tags applied to launched sessions (shown as indicators in lists). */
export interface SessionTag {
  notionCard?: { id: string; title: string };
  pileItem?: { id: string; title: string };
  githubIssue?: { number: number; title: string; url: string };
  spareTokens?: { promptId: string; auto: boolean };
  /** Schedule that spawned this session (native scheduling). Stored as `scheduleTag`
   *  on the session — `schedule` is already taken by the launch-deferral option. */
  schedule?: { id: string; label: string };
}

/**
 * Snapshot the current model/effort/provider for a specific repo so queued
 * launches are not affected by the user switching things mid-batch.
 */
export function snapshotLaunchConfigForRepo(repo: RepoConfig): LaunchConfig {
  const s = get(settings);
  const provider = s.sdk_provider === 'OpenAI' ? 'openai' : ('claude' as const);
  const model = provider === 'openai' ? s.openai_model : s.default_model;
  const effortLevel = settingsToStoreEffort(s.default_effort_level);
  const accountId = defaultAccountIdForRepo(s.accounts, repo, provider === 'openai' ? 'OpenAI' : 'Claude');
  return { repo, model, effortLevel, provider, accountId };
}

/**
 * Snapshot the current repo/model/effort/provider so queued launches are not
 * affected by the user switching things mid-batch.
 */
export function snapshotLaunchConfig(): LaunchConfig | null {
  const repo = get(activeRepo);
  if (!repo) return null;
  return snapshotLaunchConfigForRepo(repo);
}

export interface LaunchSessionOptions {
  prompt: string;
  /** Images attached to the first prompt (e.g., a recording screenshot). */
  images?: SdkImageContent[];
  repo: RepoConfig;
  model: string;
  effortLevel: EffortLevel;
  provider: 'claude' | 'openai';
  /** Agent account to pin the launched session to (undefined = machine default). */
  accountId?: string;
  /** Create a fresh git worktree for the session (branch name generated from `branchNameHint`). */
  useWorktree?: boolean;
  /** Run in this existing worktree (absolute path) instead of the main checkout. Ignored when
   *  `useWorktree` is set. The caller is responsible for checking that the directory exists. */
  worktreePath?: string;
  /** Hint used to generate the worktree branch name (defaults to the prompt). */
  branchNameHint?: string;
  systemPrompt?: string;
  tag?: SessionTag;
  /** When set, defer the launch (fire-and-forget) instead of starting now: to the next
   *  usage-window reset ('5h'/'7d'), until the worktree is idle ('after_sessions'),
   *  or to a custom wall-clock time ({ at }).
   *  Parks the session as `queued`; the Smart Queue dispatches it via launchPrepared. */
  schedule?: import('$lib/stores/sdkSessions').QueueWindow | 'after_sessions' | { at: number };
  /** What to do when worktree creation fails. 'fallback' (default) silently launches in the
   *  main repo path; 'fail' throws instead — for unattended launches (scheduled runs) that
   *  must never silently end up editing the main checkout. */
  onWorktreeError?: 'fallback' | 'fail';
}

/**
 * Create and start an SDK session for a prompt, optionally in a fresh worktree.
 * Returns the session ID.
 */
export async function launchSession(opts: LaunchSessionOptions): Promise<string> {
  const { repo, model, effortLevel, provider } = opts;

  const sessionId = sdkSessions.createSetupSession(model, effortLevel, provider, repo.path);

  if (opts.tag) {
    // Every tag but `schedule` maps 1:1 onto its session field; `schedule` lands on
    // `scheduleTag` (the session's `schedule*` prefix is otherwise deferral state).
    const { schedule, ...inlineTags } = opts.tag;
    sdkSessions.set(
      get(sdkSessions).map((s) =>
        s.id === sessionId
          ? { ...s, ...inlineTags, ...(schedule ? { scheduleTag: schedule } : {}) }
          : s
      )
    );
  }

  let cwd = (!opts.useWorktree && opts.worktreePath) || repo.path;
  let createdBranch: string | undefined;
  let worktreePostSetup:
    | { repoPath: string; copyFiles: string[]; postCreateCommands: string[] }
    | undefined;

  if (opts.useWorktree) {
    try {
      const branchName = await invoke<string>('generate_worktree_branch_name', {
        prompt: opts.branchNameHint || opts.prompt,
        repoPath: repo.path,
      });

      const result = await invoke<WorktreeCreationResult>('create_git_worktree_only', {
        repoPath: repo.path,
        branchName,
        worktreePath: null,
        baseBranch: repo.worktree_base_branch || null,
      });

      cwd = result.worktree_path;
      createdBranch = result.branch;

      const copyFiles = repo.worktree_copy_files || [];
      const postCreateCommands = repo.worktree_post_create_commands || [];
      if (copyFiles.length > 0 || postCreateCommands.length > 0) {
        worktreePostSetup = { repoPath: repo.path, copyFiles, postCreateCommands };
      }
    } catch (err) {
      if (opts.onWorktreeError === 'fail') {
        // Unattended launch (e.g. a scheduled run): abort instead of quietly pointing the
        // agent at the main checkout. Drop the setup session we just created so a failed
        // launch doesn't leave an empty "New Session" behind.
        console.error('[launch] Failed to create worktree, aborting launch:', err);
        void sdkSessions.closeSession(sessionId);
        throw err;
      }
      console.error('[launch] Failed to create worktree, using repo path:', err);
    }
  }

  await sdkSessions.startSetupSession(sessionId, {
    prompt: opts.prompt,
    images: opts.images,
    cwd,
    repoId: repo.id ?? undefined,
    model,
    effortLevel,
    provider,
    accountId: opts.accountId,
    systemPrompt: opts.systemPrompt,
    createdBranch,
    worktreePostSetup,
    schedule: opts.schedule,
  });

  return sessionId;
}

function randomDelay(): Promise<void> {
  const ms = 1000 + Math.random() * 4000;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sequential task queue for batch session launches.
 * `size` and `processing` are stores for UI binding.
 */
export function createSessionQueue() {
  const queue: Array<() => Promise<void>> = [];
  const size = writable(0);
  const processing = writable(false);
  let running = false;

  async function run() {
    if (running) return;
    running = true;
    processing.set(true);

    while (queue.length > 0) {
      const task = queue.shift()!;
      size.set(queue.length);
      try {
        await task();
      } catch (err) {
        console.error('[launch-queue] Queue task failed:', err);
      }
    }

    size.set(0);
    running = false;
    processing.set(false);
  }

  /**
   * Add tasks to the queue. With `stagger: true`, a random 1-5s delay is
   * inserted between consecutive tasks.
   */
  function enqueue(tasks: Array<() => Promise<void>>, opts?: { stagger?: boolean }) {
    for (let i = 0; i < tasks.length; i++) {
      queue.push(tasks[i]);
      if (opts?.stagger && i < tasks.length - 1) {
        queue.push(randomDelay);
      }
    }
    size.set(queue.length);
    void run();
  }

  return { size, processing, enqueue };
}
