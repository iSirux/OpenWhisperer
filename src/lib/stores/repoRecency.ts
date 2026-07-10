/**
 * Repo "heat" tracking for the repository pickers.
 *
 * A localStorage-backed frecency model: every use of a repo (picking it in a
 * selector, launching a session for it) bumps its heat score, and scores decay
 * exponentially over time (half-life below). A repo used often stays hot even
 * if the last use was yesterday; a repo touched once cools off quickly.
 * `RepoSelector` orders its one-click buttons hottest-first, overflowing the
 * cold tail into the dropdown.
 */

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

/** Snapshot of current heat scores (repo path -> decayed score, higher = hotter). */
export function getRepoHeat(): Record<string, number> {
  const now = Date.now();
  const map = load();
  const scores: Record<string, number> = {};
  for (const [path, entry] of Object.entries(map)) {
    scores[path] = decayedScore(entry, now);
  }
  return scores;
}

/** Record that a repo was just used/selected: decay its old score, then +1. */
export function touchRepo(path: string): void {
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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Best-effort only; heat is a UI nicety
  }
}

/** Sort repos hottest-first; untouched repos keep their config order (stable sort). */
export function sortReposByHeat<T extends { path: string }>(
  list: T[],
  heat: Record<string, number> = getRepoHeat()
): T[] {
  return [...list].sort((a, b) => (heat[b.path] ?? 0) - (heat[a.path] ?? 0));
}
