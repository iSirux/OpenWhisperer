import { get, writable } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { repos, findRepoById, type RepoConfig } from '$lib/stores/repos';
import { settings } from '$lib/stores/settings';
import { findRepoByPath } from '$lib/utils/repoIcons';
import {
  sdkSessions,
  normalizeScopePath,
  type SdkSession,
  type SessionPrSummary,
} from '$lib/stores/sdkSessions';

/**
 * Per-session GitHub PR state backing the PR badge and panel.
 * Detection: a session's branch is checked for an existing PR via
 * `fetch_branch_pr` (gh CLI, pinned to the repo's `gh_user`). A summary is
 * mirrored onto `SdkSession.pr` (auto-persisted) so badges survive restart;
 * the full live status (checks, mergeability) lives only here.
 */

export interface GitHubPrCheck {
  name: string;
  /** "pass" | "fail" | "pending" | "skipped" | "neutral" */
  status: string;
  url: string | null;
}

export interface GitHubPrStatus {
  number: number;
  title: string;
  /** PR description (markdown). */
  body: string;
  url: string;
  /** "open" | "merged" | "closed" */
  state: string;
  is_draft: boolean;
  /** "mergeable" | "conflicting" | "unknown" | "" */
  mergeable: string;
  /** "clean" | "blocked" | "behind" | "dirty" | "unstable" | ... | "" */
  merge_state_status: string;
  /** "" | "approved" | "changes_requested" | "review_required" */
  review_decision: string;
  base_ref: string;
  head_ref: string;
  additions: number;
  deletions: number;
  changed_files: number;
  checks: GitHubPrCheck[];
}

export type MergeStrategy = 'squash' | 'merge' | 'rebase';

/** Result of the post-merge branch/worktree cleanup command. */
export interface BranchCleanupResult {
  worktree_removed: boolean;
  local_branch_deleted: boolean;
  remote_branch_deleted: boolean;
  warnings: string[];
}

/** Backend `PrDiff`: the PR's unified diff, cut short past a size cap. */
export interface PrDiff {
  patch: string;
  truncated: boolean;
}

export interface SessionPrEntry {
  pr: GitHubPrStatus | null;
  loading: boolean;
  merging: boolean;
  error: string | null;
  mergeError: string | null;
  lastFetched: number | null;
  panelOpen: boolean;
  /** Post-merge cleanup (delete branch/worktree) in flight. */
  cleaning: boolean;
  /** Combined merge → cleanup → archive action in flight (spans the two above). */
  finishing: boolean;
  cleanupError: string | null;
  /** Set once cleanup succeeded — the branch/worktree are gone. */
  cleanupResult: BranchCleanupResult | null;
  /** Unified diff of the PR — lazily fetched when the Diff tab is opened. */
  diff: string | null;
  diffTruncated: boolean;
  diffLoading: boolean;
  diffError: string | null;
  /** Diffstat the cached diff belongs to; a new push invalidates it. */
  diffSignature: string | null;
}

const EMPTY_ENTRY: SessionPrEntry = {
  pr: null,
  loading: false,
  merging: false,
  error: null,
  mergeError: null,
  lastFetched: null,
  panelOpen: false,
  cleaning: false,
  finishing: false,
  cleanupError: null,
  cleanupResult: null,
  diff: null,
  diffTruncated: false,
  diffLoading: false,
  diffError: null,
  diffSignature: null,
};

/**
 * Identity of the diff a PR currently has. The panel polls the PR every 15s
 * while open, so a push that changes the diffstat is what tells us the cached
 * patch is stale — cheaper and more reliable than re-fetching on a timer.
 */
export function diffSignature(pr: GitHubPrStatus): string {
  return `${pr.number}:${pr.additions}:${pr.deletions}:${pr.changed_files}:${pr.state}`;
}

/** Uncommitted/unpushed state of a working tree (backend `WorkingTreeState`). */
export interface WorkingTreeState {
  uncommitted: number;
  unpushed: number;
  branch: string | null;
}

/**
 * Read a working tree's uncommitted/unpushed state. Used to warn before merging
 * a PR that wouldn't include local work. Returns null when it can't be read —
 * callers treat that as "nothing to warn about" rather than blocking the merge.
 */
export async function fetchWorkingTreeState(cwd: string | undefined): Promise<WorkingTreeState | null> {
  if (!cwd || cwd === '.') return null;
  try {
    return await invoke<WorkingTreeState>('get_git_working_tree_state', { repoPath: cwd });
  } catch (e) {
    console.warn('[sessionPrs] Failed to read working tree state:', e);
    return null;
  }
}

/** Auto-detection reuses a fetch newer than this; manual refresh bypasses. */
const STALE_MS = 60 * 1000;

/** Default remote branch per repo path (e.g. "origin/main"), null = lookup failed. */
const defaultBranchCache = new Map<string, string | null>();

/** Resolve and cache a repo's default remote branch (e.g. "origin/main"). */
export async function getDefaultBranch(repoPath: string): Promise<string | null> {
  if (!repoPath || repoPath === '.') return null;
  if (defaultBranchCache.has(repoPath)) return defaultBranchCache.get(repoPath) ?? null;
  let result: string | null = null;
  try {
    result = await invoke<string>('get_git_default_branch', { repoPath });
  } catch {
    result = null;
  }
  defaultBranchCache.set(repoPath, result);
  return result;
}

/** "origin/main" → "main" */
export function defaultBranchTail(defaultBranch: string | null): string | null {
  if (!defaultBranch) return null;
  const idx = defaultBranch.indexOf('/');
  return idx >= 0 ? defaultBranch.slice(idx + 1) : defaultBranch;
}

function sessionBranch(session: SdkSession): string | null {
  return session.currentBranch?.trim() || session.createdBranch?.trim() || null;
}

/**
 * Stable key for the "worktree scope" a session's PR belongs to: the same
 * checked-out directory + branch. Sessions sharing a scope are looking at the
 * exact same PR, so their PR state must stay in lock-step (that's the divergence
 * bug when several sessions run in one worktree). Null when the session isn't a
 * shareable PR candidate (no cwd or no branch).
 */
function scopeKeyFor(session: SdkSession): string | null {
  if (!session.cwd || session.cwd === '.') return null;
  const branch = sessionBranch(session);
  if (!branch) return null;
  return `${normalizeScopePath(session.cwd)}::${branch}`;
}

/** All live sessions in the same worktree scope (including `session` itself). */
function scopeSiblings(session: SdkSession): SdkSession[] {
  const key = scopeKeyFor(session);
  if (!key) return [session];
  return get(sdkSessions).filter((s) => scopeKeyFor(s) === key);
}

/**
 * Release the agent process of every session working *in* this directory.
 *
 * Each session's agent (Claude CLI / codex app-server) is spawned with the
 * session cwd as its working directory, and on Windows a directory cannot be
 * deleted while any process sits in it — git's `--force` and the backend's
 * read-only/retry fallback can't beat a cwd lock, so the worktree delete fails
 * every time until the agents let go. Matched by cwd rather than PR scope: a
 * session with a stale branch label is still holding the same directory.
 *
 * The sessions themselves are untouched — archiving stays the user's own step.
 */
async function releaseAgentsInDirectory(dirPath: string): Promise<void> {
  const target = normalizeScopePath(dirPath);
  const occupants = get(sdkSessions).filter(
    (s) => s.cwd && normalizeScopePath(s.cwd) === target
  );
  await Promise.all(occupants.map((s) => sdkSessions.releaseAgentProcess(s.id)));
}

/**
 * Archive every session working in this directory, sequentially (each archive
 * rewrites the archive index, so concurrent closes would race).
 */
async function archiveSessionsInDirectory(dirPath: string): Promise<void> {
  const target = normalizeScopePath(dirPath);
  const occupants = get(sdkSessions).filter(
    (s) => s.cwd && normalizeScopePath(s.cwd) === target
  );
  for (const s of occupants) {
    await sdkSessions.closeSession(s.id);
  }
}

/** Scopes for which we've already auto-opened the PR panel this app session, so
 *  a manually-closed panel isn't reopened on every subsequent poll. */
const autoOpenedScopes = new Set<string>();

function resolveRepo(session: SdkSession): RepoConfig | undefined {
  const list = get(repos).list;
  return (
    (session.repoId ? findRepoById(list, session.repoId) : undefined) ??
    findRepoByPath(list, session.cwd) ??
    undefined
  );
}

function toSummary(pr: GitHubPrStatus): SessionPrSummary {
  return { number: pr.number, url: pr.url, state: pr.state, title: pr.title, isDraft: pr.is_draft };
}

/** Deep equality of two PR statuses. Small plain objects with a backend-fixed key order,
 *  so a JSON comparison is exact and cheap. */
function samePrStatus(a: GitHubPrStatus | null, b: GitHubPrStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function createSessionPrsStore() {
  const { subscribe, set } = writable<Map<string, SessionPrEntry>>(new Map());

  /**
   * Apply `changes` to every listed session's entry in ONE store write, skipping entries
   * the changes wouldn't alter — the 15s poll mostly re-delivers the same PR, and every write
   * wakes each PR badge/panel. An unchanged `pr` keeps its old object identity.
   */
  function patchMany(sessionIds: string[], changes: Partial<SessionPrEntry>) {
    const map = get({ subscribe });
    let next: Map<string, SessionPrEntry> | null = null;
    const keys = Object.keys(changes) as (keyof SessionPrEntry)[];
    for (const sessionId of sessionIds) {
      const prev = map.get(sessionId);
      const base = prev ?? EMPTY_ENTRY;
      const changedKeys = keys.filter((key) =>
        key === 'pr' ? !samePrStatus(base.pr, changes.pr ?? null) : base[key] !== changes[key]
      );
      if (prev && changedKeys.length === 0) continue;
      const entry: SessionPrEntry = { ...base };
      for (const key of changedKeys) Object.assign(entry, { [key]: changes[key] });
      next ??= new Map(map);
      next.set(sessionId, entry);
    }
    if (next) set(next);
  }

  function patch(sessionId: string, changes: Partial<SessionPrEntry>) {
    patchMany([sessionId], changes);
  }

  function entryFor(sessionId: string): SessionPrEntry {
    return get({ subscribe }).get(sessionId) ?? EMPTY_ENTRY;
  }

  /** Whether this session is even a PR candidate (GitHub repo, non-default branch). */
  async function isCandidate(session: SdkSession): Promise<boolean> {
    if (!session.cwd || session.cwd === '.') return false;
    const branch = sessionBranch(session);
    if (!branch) return false;
    const repo = resolveRepo(session);
    if (!repo?.github_url) return false;
    const tail = defaultBranchTail(await getDefaultBranch(repo.path));
    // On the default branch (or unknown default) a "PR for this branch" is meaningless.
    if (!tail || branch === tail) return false;
    return true;
  }

  async function refresh(session: SdkSession): Promise<void> {
    const entry = entryFor(session.id);
    // After cleanup the worktree directory is gone — fetching there would only
    // produce a "path does not exist" error over a finished PR lifecycle.
    if (entry.loading || entry.cleanupResult) return;
    const branch = sessionBranch(session);
    if (!branch) return;
    const repo = resolveRepo(session);
    // Mark every session in the scope as loading so a sibling's detection tick
    // doesn't kick off a second concurrent fetch of the same PR.
    const siblings = scopeSiblings(session);
    const siblingIds = siblings.map((s) => s.id);
    patchMany(siblingIds, { loading: true, error: null });
    try {
      const pr = await invoke<GitHubPrStatus | null>('fetch_branch_pr', {
        repoPath: session.cwd,
        ghUser: repo?.gh_user || null,
        branch,
      });
      const now = Date.now();
      // The result is the same PR for every session in the scope — apply it to
      // all of them so their badges/panels never diverge.
      const wasKnown = siblings.some((s) => entryFor(s.id).pr != null);
      const summary = pr ? toSummary(pr) : null;
      patchMany(siblingIds, { pr, loading: false, lastFetched: now });
      // No-op for an unchanged summary (setSessionPr compares before writing).
      for (const s of siblings) sdkSessions.setSessionPr(s.id, summary);
      maybeAutoOpen(session, pr, wasKnown);
    } catch (e) {
      // Keep siblings' last good PR; only the initiating session records the error.
      patchMany(siblingIds, { loading: false });
      patch(session.id, { error: String(e), lastFetched: Date.now() });
    }
  }

  /** Open the PR panel across the scope the first time a PR appears, if enabled. */
  function maybeAutoOpen(
    session: SdkSession,
    pr: GitHubPrStatus | null,
    wasKnown: boolean,
  ): void {
    if (!pr || wasKnown) return;
    // Only surface an actionable PR — a merged/closed one shouldn't pop the panel
    // open (e.g. the first detect after an app restart). Drafts are state "open".
    if (pr.state !== 'open') return;
    if (!get(settings).auto_open_session_panels) return;
    const key = scopeKeyFor(session);
    if (!key || autoOpenedScopes.has(key)) return;
    autoOpenedScopes.add(key);
    for (const s of scopeSiblings(session)) {
      patch(s.id, { panelOpen: true });
      sdkSessions.setSessionPrPanelOpen(s.id, true);
    }
  }

  /**
   * Restore persisted PR-panel open state onto the store after sessions load
   * from disk, so a session whose PR dock was left open reopens it on the next
   * launch. The PR itself is refetched by the normal `detectIfStale` path when
   * the session view mounts; here we only seed the panel-open flag.
   */
  function rehydrateFromSessions(): void {
    for (const s of get(sdkSessions)) {
      if (s.prPanelOpen) patch(s.id, { panelOpen: true });
    }
  }

  /** Merge the session's PR. Remembers the strategy on the repo config. */
  async function merge(session: SdkSession, strategy: MergeStrategy): Promise<void> {
    const entry = entryFor(session.id);
    const pr = entry.pr;
    if (!pr || entry.merging) return;
    const repo = resolveRepo(session);
    patch(session.id, { merging: true, mergeError: null });
    try {
      await invoke('merge_github_pr', {
        repoPath: session.cwd,
        ghUser: repo?.gh_user || null,
        number: pr.number,
        strategy,
      });
      patch(session.id, { merging: false });
      // Remember the strategy per repo (best-effort).
      if (repo && repo.last_merge_strategy !== strategy) {
        const index = get(repos).list.findIndex((r) => r.id === repo.id);
        if (index >= 0) {
          repos.updateRepo(index, { last_merge_strategy: strategy }).catch(() => {});
        }
      }
      await refresh(session);
    } catch (e) {
      patch(session.id, { merging: false, mergeError: String(e) });
    }
  }

  /** Post-merge cleanup: remove the session's worktree (when it runs in one),
   *  delete the local branch, best-effort delete the remote branch. The
   *  backend refuses when unsafe (uncommitted changes, unpushed commits). */
  async function cleanup(session: SdkSession): Promise<void> {
    const entry = entryFor(session.id);
    if (entry.cleaning || entry.cleanupResult) return;
    const branch = sessionBranch(session);
    const repo = resolveRepo(session);
    if (!branch || !repo?.path) {
      patch(session.id, { cleanupError: 'Could not resolve the session branch or repository' });
      return;
    }
    const isWorktree =
      !!session.cwd && normalizeScopePath(session.cwd) !== normalizeScopePath(repo.path);
    patch(session.id, { cleaning: true, cleanupError: null });
    try {
      // Nothing can delete the worktree while an agent process is still
      // sitting in it (see releaseAgentsInDirectory).
      if (isWorktree && session.cwd) {
        await releaseAgentsInDirectory(session.cwd);
      }
      const result = await invoke<BranchCleanupResult>('cleanup_merged_branch', {
        repoPath: repo.path,
        branch,
        worktreePath: isWorktree ? session.cwd : null,
      });
      // The branch/worktree is now gone for every session in the scope — stop
      // them all from re-fetching a dead path.
      for (const s of scopeSiblings(session)) {
        patch(s.id, { cleaning: false, cleanupResult: result });
      }
    } catch (e) {
      patch(session.id, { cleaning: false, cleanupError: String(e) });
    }
  }

  /**
   * One-click finish: merge → delete branch/worktree → archive the sessions that
   * lived there. Each step is gated on the previous one actually succeeding — a
   * refused cleanup (uncommitted or unpushed work) must not archive the sessions
   * that still hold it. Only a worktree session archives its scope siblings; in
   * the main checkout the directory is shared with every other session of the
   * repo, so only this session is archived.
   */
  async function mergeAndFinish(session: SdkSession, strategy: MergeStrategy): Promise<void> {
    const entry = entryFor(session.id);
    if (!entry.pr || entry.merging || entry.cleaning || entry.finishing) return;
    const repo = resolveRepo(session);
    const isWorktree =
      !!session.cwd && !!repo?.path &&
      normalizeScopePath(session.cwd) !== normalizeScopePath(repo.path);
    patch(session.id, { finishing: true });
    try {
      await merge(session, strategy);
      if (entryFor(session.id).mergeError) return;
      await cleanup(session);
      if (entryFor(session.id).cleanupError) return;
      if (isWorktree && session.cwd) {
        await archiveSessionsInDirectory(session.cwd);
      } else {
        await sdkSessions.closeSession(session.id);
      }
    } finally {
      patch(session.id, { finishing: false });
    }
  }

  return {
    subscribe,

    /** Force-refresh the PR status for a session (panel refresh button / polling). */
    refresh,

    /** Detect the session's PR unless a fresh result exists. Cheap to call often.
     *  `force` bypasses staleness (e.g. right after a turn ends, when the agent
     *  may have just created the PR) but still requires a PR-candidate session. */
    async detectIfStale(session: SdkSession, force = false): Promise<void> {
      const entry = entryFor(session.id);
      if (entry.loading || entry.merging) return;
      // Scope-aware freshness: if a session sharing this worktree is already
      // fetching, or fetched recently, reuse that instead of a duplicate call —
      // its result is propagated to us by `refresh`.
      const now = Date.now();
      for (const s of scopeSiblings(session)) {
        if (s.id === session.id) continue;
        const sib = entryFor(s.id);
        if (sib.loading) return;
        if (!force && sib.lastFetched && now - sib.lastFetched < STALE_MS) return;
      }
      if (!force && entry.lastFetched && now - entry.lastFetched < STALE_MS) return;
      if (!(await isCandidate(session))) return;
      await refresh(session);
    },

    /**
     * Load the PR's unified diff (Diff tab). No-op when a cached patch already
     * matches the PR's current diffstat; `force` refetches regardless.
     */
    async loadDiff(session: SdkSession, force = false): Promise<void> {
      const entry = entryFor(session.id);
      const pr = entry.pr;
      if (!pr || entry.diffLoading) return;
      const signature = diffSignature(pr);
      if (!force && entry.diff !== null && entry.diffSignature === signature) return;
      const repo = resolveRepo(session);
      // After cleanup the worktree is gone — gh can still read the merged PR
      // from the main checkout, which is where the user ends up anyway.
      const repoPath = entry.cleanupResult ? (repo?.path ?? session.cwd) : session.cwd;
      if (!repoPath || repoPath === '.') return;
      patch(session.id, { diffLoading: true, diffError: null });
      try {
        const result = await invoke<PrDiff>('fetch_pr_diff', {
          repoPath,
          ghUser: repo?.gh_user || null,
          number: pr.number,
        });
        patch(session.id, {
          diff: result.patch,
          diffTruncated: result.truncated,
          diffSignature: signature,
          diffLoading: false,
        });
      } catch (e) {
        patch(session.id, { diffLoading: false, diffError: String(e) });
      }
    },

    merge,

    cleanup,

    mergeAndFinish,

    rehydrateFromSessions,

    openPanel(sessionId: string): void {
      patch(sessionId, { panelOpen: true, mergeError: null });
      sdkSessions.setSessionPrPanelOpen(sessionId, true);
    },

    closePanel(sessionId: string): void {
      patch(sessionId, { panelOpen: false });
      sdkSessions.setSessionPrPanelOpen(sessionId, false);
    },

    togglePanel(sessionId: string): void {
      const open = !entryFor(sessionId).panelOpen;
      patch(sessionId, { panelOpen: open, mergeError: null });
      sdkSessions.setSessionPrPanelOpen(sessionId, open);
    },
  };
}

export const sessionPrs = createSessionPrsStore();
