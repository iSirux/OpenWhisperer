/**
 * Sidebar session-list repository filter.
 *
 * Holds the set of repo keys the user has toggled on in the filter row above
 * the session list. Empty = no filtering (all sessions shown). Persisted to
 * localStorage (pure UI state, like repo heat).
 *
 * The filtered order is also what the fixed Ctrl+1..9 session-switching
 * hotkey uses (the sidebar renders the number badges), so the layout applies
 * `filterDisplaySessions` with the same selection — keep them in sync.
 */

import { writable, get } from 'svelte/store';
import { repos, type RepoConfig } from './repos';
import type { DisplaySession } from '$lib/types/session';

const STORAGE_KEY = 'open-whisperer:session-repo-filter';

/** Stable key a repo is filtered by (UUID when present, path as fallback). */
export function repoFilterKey(repo: RepoConfig): string {
  return repo.id || repo.path;
}

function load(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/** Selected repo keys. Empty array = filter off. */
export const sessionRepoFilter = writable<string[]>(load());

sessionRepoFilter.subscribe((keys) => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Best-effort only; the filter is a UI nicety
  }
});

export function toggleRepoFilter(key: string): void {
  sessionRepoFilter.update((keys) =>
    keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]
  );
}

export function clearRepoFilter(): void {
  sessionRepoFilter.set([]);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

/**
 * Does this display session belong to one of the given repos? Matched by the
 * stable repoId when available, otherwise by cwd — which is often a worktree
 * ("<repoPath>-worktrees/<branch>"), same resolution as repoRecency's.
 */
function sessionMatchesRepos(session: DisplaySession, selected: RepoConfig[]): boolean {
  const cwd = session.repoPath && session.repoPath !== '.' ? normalizePath(session.repoPath) : '';
  return selected.some((repo) => {
    if (session.repoId && repo.id && session.repoId === repo.id) return true;
    if (!cwd) return false;
    const repoPath = normalizePath(repo.path);
    return cwd === repoPath || cwd.startsWith(`${repoPath}-worktrees/`);
  });
}

/** The subset of `repoList` that owns at least one of the given sessions. */
export function reposWithSessions(
  sessions: DisplaySession[],
  repoList: RepoConfig[]
): RepoConfig[] {
  return repoList.filter((repo) => sessions.some((s) => sessionMatchesRepos(s, [repo])));
}

/**
 * Apply the repo filter to a display-session list. With nothing selected (or
 * a selection that no longer matches any configured repo, e.g. after repos
 * were deleted) the list passes through unchanged. Sessions that belong to no
 * repo (and sequence executions) are hidden while a filter is active.
 */
export function filterDisplaySessions(
  sessions: DisplaySession[],
  selectedKeys: string[],
  repoList?: RepoConfig[]
): DisplaySession[] {
  if (selectedKeys.length === 0) return sessions;
  const list = repoList ?? get(repos).list ?? [];
  const keySet = new Set(selectedKeys);
  const selected = list.filter((r) => keySet.has(repoFilterKey(r)));
  if (selected.length === 0) return sessions;
  return sessions.filter((s) => sessionMatchesRepos(s, selected));
}
