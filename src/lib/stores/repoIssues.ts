import { get, writable } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import type { RepoConfig } from '$lib/stores/repos';

/**
 * Per-repo GitHub issues cache backing the repo Issues view.
 * Issues are fetched via the gh CLI (`fetch_github_issues`), pinned to the
 * repo's `gh_user` when set. Cached per repo id with staleness-based refetch.
 */

export interface GitHubLabel {
  name: string;
  color: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  /** "open" | "closed" */
  state: string;
  state_reason: string | null;
  labels: GitHubLabel[];
  assignees: string[];
  milestone: string | null;
  author: string;
  url: string;
  created_at: string;
  updated_at: string;
  linked_pr_numbers: number[];
}

export interface GitHubIssueComment {
  author: string;
  body: string;
  created_at: string;
}

export interface GitHubIssueDetail {
  number: number;
  title: string;
  state: string;
  url: string;
  body: string;
  comments: GitHubIssueComment[];
}

export type IssueStateFilter = 'open' | 'closed' | 'all';

export interface RepoIssuesEntry {
  issues: GitHubIssue[];
  loading: boolean;
  error: string | null;
  lastFetched: number | null;
  stateFilter: IssueStateFilter;
}

const EMPTY_ENTRY: RepoIssuesEntry = {
  issues: [],
  loading: false,
  error: null,
  lastFetched: null,
  stateFilter: 'open',
};

/** Refetch when the cached list is older than this on view entry. */
const STALE_MS = 2 * 60 * 1000;

function createRepoIssuesStore() {
  const { subscribe, update } = writable<Map<string, RepoIssuesEntry>>(new Map());

  function patch(repoId: string, changes: Partial<RepoIssuesEntry>) {
    update((map) => {
      const next = new Map(map);
      next.set(repoId, { ...(next.get(repoId) ?? EMPTY_ENTRY), ...changes });
      return next;
    });
  }

  async function fetch(repo: RepoConfig, stateFilter?: IssueStateFilter): Promise<void> {
    if (!repo.id) return;
    const repoId = repo.id;
    const current = get({ subscribe }).get(repoId) ?? EMPTY_ENTRY;
    const state = stateFilter ?? current.stateFilter;
    patch(repoId, { loading: true, error: null, stateFilter: state });
    try {
      const issues = await invoke<GitHubIssue[]>('fetch_github_issues', {
        repoPath: repo.path,
        ghUser: repo.gh_user || null,
        state,
        limit: 100,
      });
      patch(repoId, { issues, loading: false, lastFetched: Date.now() });
    } catch (e) {
      patch(repoId, { loading: false, error: String(e) });
    }
  }

  return {
    subscribe,

    fetch,

    /** Fetch on view entry unless a fresh (< 2 min) cache exists. */
    async fetchIfStale(repo: RepoConfig): Promise<void> {
      if (!repo.id) return;
      const entry = get({ subscribe }).get(repo.id);
      if (entry?.loading) return;
      if (entry?.lastFetched && Date.now() - entry.lastFetched < STALE_MS) return;
      await fetch(repo);
    },

    /** Change the open/closed/all filter and refetch. */
    async setStateFilter(repo: RepoConfig, stateFilter: IssueStateFilter): Promise<void> {
      await fetch(repo, stateFilter);
    },
  };
}

export const repoIssues = createRepoIssuesStore();

export const EMPTY_REPO_ISSUES: RepoIssuesEntry = EMPTY_ENTRY;

/** Fetch one issue's full body + comments (used at session-launch time). */
export async function fetchIssueDetail(
  repo: RepoConfig,
  number: number
): Promise<GitHubIssueDetail> {
  return invoke<GitHubIssueDetail>('fetch_github_issue', {
    repoPath: repo.path,
    ghUser: repo.gh_user || null,
    number,
  });
}
