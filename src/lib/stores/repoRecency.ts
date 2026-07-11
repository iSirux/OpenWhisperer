/**
 * Repo "heat" tracking for the repository pickers.
 *
 * A localStorage-backed frecency model: every prompt turn sent to a session
 * in a repo bumps that repo's heat score, and
 * scores decay exponentially over time (half-life below). A repo used often
 * stays hot even if the last use was yesterday; a repo touched once cools off
 * quickly. `RepoSelector` orders its one-click buttons hottest-first,
 * overflowing the cold tail into the dropdown.
 *
 * Heat is exposed as the `repoHeat` store so every mounted picker reorders
 * live when any of them (or a session launch) records a use. Note that decay
 * alone never changes the relative order — all scores decay by the same
 * factor — so ordering only changes on touches, and the store only needs to
 * update then.
 */

import { writable, get, type Readable } from 'svelte/store';
import { repos } from './repos';

const STORAGE_KEY = 'open-whisperer:repo-heat';
const MAX_ENTRIES = 50;
/** Time for a repo's heat to halve without new uses. */
const HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

interface RepoHeatEntry {
  /** Accumulated (decayed) use score as of `lastUsed` */
  score: number;
  /** Epoch ms of the most recent use */
  lastUsed: number;
}

type HeatMap = Record<string, RepoHeatEntry>;

function load(): HeatMap {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object') return {};
    const map: HeatMap = {};
    for (const [path, entry] of Object.entries(parsed)) {
      const e = entry as Partial<RepoHeatEntry>;
      if (typeof e?.score === 'number' && typeof e?.lastUsed === 'number') {
        map[path] = { score: e.score, lastUsed: e.lastUsed };
      }
    }
    return map;
  } catch {
    return {};
  }
}

function decayedScore(entry: RepoHeatEntry, now: number): number {
  const elapsed = Math.max(0, now - entry.lastUsed);
  return entry.score * Math.pow(0.5, elapsed / HALF_LIFE_MS);
}

function computeScores(map: HeatMap, now: number): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const [path, entry] of Object.entries(map)) {
    scores[path] = decayedScore(entry, now);
  }
  return scores;
}

/** Snapshot of current heat scores (repo path -> decayed score, higher = hotter). */
export function getRepoHeat(): Record<string, number> {
  return computeScores(load(), Date.now());
}

const heatStore = writable<Record<string, number>>(getRepoHeat());

/** Live heat scores (repo path -> score); updates whenever a repo use is recorded. */
export const repoHeat: Readable<Record<string, number>> = { subscribe: heatStore.subscribe };

/** Record that a repo was just used: decay its old score, then +1. */
function touchRepo(path: string): void {
  if (!path || path === '.' || typeof localStorage === 'undefined') return;
  const now = Date.now();
  const map = load();
  const prev = map[path];
  map[path] = {
    score: (prev ? decayedScore(prev, now) : 0) + 1,
    lastUsed: now,
  };
  // Keep the map bounded: drop the coldest entries beyond the cap
  const entries = Object.entries(map)
    .sort((a, b) => decayedScore(b[1], now) - decayedScore(a[1], now))
    .slice(0, MAX_ENTRIES);
  const bounded = Object.fromEntries(entries);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bounded));
  } catch {
    // Best-effort only; heat is a UI nicety
  }
  heatStore.set(computeScores(bounded, now));
}

/**
 * Record a use for the repo that owns `cwd`. Sessions often run in a git
 * worktree ("<repoPath>-worktrees/<branch>"), so the cwd is resolved back to
 * the configured repo path that heat is keyed by; an unresolvable cwd is
 * ignored (it could never match a picker entry anyway).
 */
export function touchRepoForCwd(cwd: string | undefined): void {
  if (!cwd || cwd === '.') return;
  const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const normalizedCwd = normalize(cwd);
  const list = get(repos).list || [];
  const repo =
    list.find((r) => normalize(r.path) === normalizedCwd) ??
    list.find((r) => normalizedCwd.startsWith(`${normalize(r.path)}-worktrees/`));
  if (repo) touchRepo(repo.path);
}

/** Sort repos hottest-first; untouched repos keep their config order (stable sort). */
export function sortReposByHeat<T extends { path: string }>(
  list: T[],
  heat: Record<string, number> = getRepoHeat()
): T[] {
  return [...list].sort((a, b) => (heat[b.path] ?? 0) - (heat[a.path] ?? 0));
}
