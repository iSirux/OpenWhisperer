/**
 * Sidebar session-list grouped view mode.
 *
 * When enabled, the session list is grouped by repository, and by worktree
 * within each repository. The toggle lives at the right end of the repo
 * filter row and is persisted to localStorage (pure UI state, like the repo
 * filter itself).
 *
 * Grouping reorders the rendered list, and the fixed Ctrl+1..9 session-
 * switching hotkey (plus Ctrl+W's "advance to next session") in the main
 * layout must follow the same order the sidebar renders — both sides go
 * through `applySessionGrouping` so the number badges stay accurate.
 */

import { writable, get } from 'svelte/store';
import { repos, type RepoConfig } from './repos';
import { normalizePath } from './sessionRepoFilter';
import type { DisplaySession } from '$lib/types/session';

const STORAGE_KEY = 'open-whisperer:session-list-grouped';
const COLLAPSED_STORAGE_KEY = 'open-whisperer:session-groups-collapsed';

function load(): boolean {
  if (typeof localStorage === 'undefined') return true;
  // Grouped is the default; only an explicit toggle-off overrides it
  return localStorage.getItem(STORAGE_KEY) !== 'false';
}

/** Whether the sidebar session list is grouped by repository/worktree. */
export const sessionListGrouped = writable<boolean>(load());

sessionListGrouped.subscribe((grouped) => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, String(grouped));
  } catch {
    // Best-effort only; the view mode is a UI nicety
  }
});

export function toggleSessionGrouping(): void {
  sessionListGrouped.update((grouped) => !grouped);
}

function loadCollapsed(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Collapse keys of collapsed groups: a repo group's `key`, or
 * `worktreeCollapseKey(...)` for a worktree subgroup. Keys of groups that no
 * longer exist are kept (harmless) so a group reappearing later — e.g. its
 * sessions were all closed and a new one opened — stays collapsed.
 */
export const collapsedSessionGroups = writable<string[]>(loadCollapsed());

collapsedSessionGroups.subscribe((keys) => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Best-effort only
  }
});

export function toggleGroupCollapsed(key: string): void {
  collapsedSessionGroups.update((keys) =>
    keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]
  );
}

/** Collapse key for a worktree subgroup, scoped to its repo group. */
export function worktreeCollapseKey(groupKey: string, worktreeKey: string): string {
  return `${groupKey}::${worktreeKey}`;
}

/**
 * 'main' = the repo's primary checkout, 'worktree' = a "<repoPath>-worktrees/"
 * checkout, 'other' = a cwd that belongs to the repo (matched by repoId) but
 * lives elsewhere on disk.
 */
export type WorktreeKind = 'main' | 'worktree' | 'other';

export interface SessionWorktreeGroup {
  /** Unique within the parent repo group (normalized cwd, or 'main'). */
  key: string;
  kind: WorktreeKind;
  /** Worktree directory name; 'main' for the primary checkout. */
  label: string;
  /** Original-case cwd, for tooltips. Empty for the main checkout. */
  path: string;
  sessions: DisplaySession[];
}

export interface SessionRepoGroup {
  /** Unique across groups (repo key, or 'no-repo' for the trailing group). */
  key: string;
  /** null for the trailing "no repository" group (sequences, unknown cwds). */
  repo: RepoConfig | null;
  name: string;
  worktrees: SessionWorktreeGroup[];
  sessionCount: number;
}

/** Same repo resolution as the repo filter: stable repoId first, then cwd. */
function resolveRepo(session: DisplaySession, repoList: RepoConfig[]): RepoConfig | null {
  if (session.repoId) {
    const byId = repoList.find((r) => r.id && r.id === session.repoId);
    if (byId) return byId;
  }
  const cwd =
    session.repoPath && session.repoPath !== '.' ? normalizePath(session.repoPath) : '';
  if (!cwd) return null;
  return (
    repoList.find((r) => {
      const repoPath = normalizePath(r.path);
      return cwd === repoPath || cwd.startsWith(`${repoPath}-worktrees/`);
    }) ?? null
  );
}

function lastPathSegment(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path;
}

function worktreeInfo(
  session: DisplaySession,
  repo: RepoConfig | null
): { key: string; kind: WorktreeKind; label: string; path: string } {
  const raw = session.repoPath && session.repoPath !== '.' ? session.repoPath : '';
  const cwd = raw ? normalizePath(raw) : '';
  if (!repo || !cwd) {
    return { key: 'main', kind: 'main', label: 'main', path: '' };
  }
  const repoPath = normalizePath(repo.path);
  if (cwd === repoPath) {
    return { key: 'main', kind: 'main', label: 'main', path: '' };
  }
  const kind = cwd.startsWith(`${repoPath}-worktrees/`) ? 'worktree' : 'other';
  return { key: cwd, kind, label: lastPathSegment(raw), path: raw };
}

/**
 * Order sessions within a worktree group with a *stable* comparator: pinned
 * sessions lead (earlier pins first, matching the flat view), and everything
 * else is ordered by creation time (newest first). Deliberately independent of
 * `lastActivityAt`/status so grouped lists don't reshuffle as sessions become
 * active — a session only moves when the user pins it.
 */
function compareGroupedSessions(a: DisplaySession, b: DisplaySession): number {
  const pinDiff = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
  if (pinDiff !== 0) return pinDiff;
  if (a.pinned && b.pinned) {
    const pinnedAtDiff = (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0);
    if (pinnedAtDiff !== 0) return pinnedAtDiff;
  }
  return b.createdAt - a.createdAt;
}

/**
 * Group an (already filtered) display-session list by repository, then by
 * worktree within each repository. Groups follow the configured repository
 * order (the same order the repository rail shows); within a repo the main
 * checkout leads, followed by worktrees alphabetically. The "no repository"
 * group (sequences, unknown cwds) always trails. Sessions inside a group use a
 * stable order (pinned first, then by creation time) — grouped lists never
 * reorder by recency/status, so a session only moves when the user pins it.
 */
export function groupDisplaySessions(
  sessions: DisplaySession[],
  repoList: RepoConfig[]
): SessionRepoGroup[] {
  const groups = new Map<string, SessionRepoGroup>();
  let noRepo: SessionRepoGroup | null = null;

  for (const session of sessions) {
    const repo = resolveRepo(session, repoList);
    let group: SessionRepoGroup;
    if (repo) {
      const key = repo.id || repo.path;
      const existing = groups.get(key);
      if (existing) {
        group = existing;
      } else {
        group = { key, repo, name: repo.name, worktrees: [], sessionCount: 0 };
        groups.set(key, group);
      }
    } else {
      noRepo ??= { key: 'no-repo', repo: null, name: 'Other', worktrees: [], sessionCount: 0 };
      group = noRepo;
    }

    const info = worktreeInfo(session, repo);
    let worktree = group.worktrees.find((w) => w.key === info.key);
    if (!worktree) {
      worktree = { ...info, sessions: [] };
      group.worktrees.push(worktree);
    }
    worktree.sessions.push(session);
    group.sessionCount++;
  }

  const repoOrder = new Map(repoList.map((r, i) => [r.id || r.path, i]));
  const result = [...groups.values()].sort(
    (a, b) => (repoOrder.get(a.key) ?? 0) - (repoOrder.get(b.key) ?? 0)
  );
  for (const group of result) {
    group.worktrees.sort((a, b) => {
      const mainDiff = (a.kind === 'main' ? 0 : 1) - (b.kind === 'main' ? 0 : 1);
      if (mainDiff !== 0) return mainDiff;
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    });
    for (const worktree of group.worktrees) {
      worktree.sessions.sort(compareGroupedSessions);
    }
  }
  if (noRepo) result.push(noRepo);
  return result;
}

/**
 * Whether a worktree subgroup renders its own subheader — several checkouts
 * in the repo, or a lone non-main one. Only subgroups with a header are
 * collapsible; a stale collapse key on a header-less subgroup is ignored so
 * its sessions can't get stuck hidden with nothing to click.
 */
export function worktreeHasHeader(
  group: SessionRepoGroup,
  worktree: SessionWorktreeGroup
): boolean {
  return group.worktrees.length > 1 || worktree.kind !== 'main';
}

/**
 * The grouped list in rendered order (what the number badges count through),
 * with sessions inside collapsed groups omitted — they aren't visible, so
 * the hotkeys skip them too.
 */
export function flattenSessionGroups(
  groups: SessionRepoGroup[],
  collapsedKeys?: ReadonlySet<string>
): DisplaySession[] {
  return groups.flatMap((g) => {
    if (collapsedKeys?.has(g.key)) return [];
    return g.worktrees.flatMap((w) =>
      collapsedKeys?.has(worktreeCollapseKey(g.key, w.key)) && worktreeHasHeader(g, w)
        ? []
        : w.sessions
    );
  });
}

/**
 * Reorder a display-session list the way the grouped sidebar renders it (a
 * no-op when grouping is off), dropping sessions in collapsed groups. Used by
 * the main layout's fixed hotkeys so they follow the sidebar's visual order.
 */
export function applySessionGrouping(
  sessions: DisplaySession[],
  grouped: boolean,
  repoList?: RepoConfig[]
): DisplaySession[] {
  if (!grouped) return sessions;
  const list = repoList ?? get(repos).list ?? [];
  return flattenSessionGroups(
    groupDisplaySessions(sessions, list),
    new Set(get(collapsedSessionGroups))
  );
}
