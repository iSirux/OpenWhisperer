/**
 * Store for "No mistakes" validation runs.
 *
 * no-mistakes is a CLI git-push validation proxy: it runs an AI validation
 * pipeline (review → test → docs → lint → push → PR → CI) in an isolated
 * worktree and only pushes / opens a PR when everything is green. Mid-run it can
 * hit a decision "gate" (a set of findings) that the user resolves with
 * approve / fix / skip.
 *
 * The Rust backend is driven per-run over Tauri commands + events (see below).
 * This store owns the run lifecycle and event wiring for the frontend.
 */
import { writable, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type NmStepStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'unknown';

export interface NmStep {
  name: string;
  status: NmStepStatus;
}

export interface NmFinding {
  id: string;
  severity: string;
  file: string;
  action: string;
  description: string;
}

export type NmRunStatus =
  | 'starting'
  | 'setup'
  | 'running'
  | 'gate'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'error';

/** Why a run is parked in the `setup` state. */
export type NmSetupReason = 'not-installed' | 'not-initialized';

export interface NmRun {
  runId: string;
  sessionId: string;
  cwd: string;
  intent: string;
  status: NmRunStatus;
  setupReason?: NmSetupReason;
  steps: NmStep[];
  findings: NmFinding[];
  selectedFindingIds: string[];
  log: string[];
  lastRaw: string;
  outcome?: string;
  message?: string;
  startedAt: number;
  responding?: boolean;
}

/** Canonical pipeline steps, in order. */
export const NM_CANONICAL_STEPS = [
  'review',
  'test',
  'docs',
  'lint',
  'push',
  'pr',
  'ci',
] as const;

// --- Event payload shapes (snake_case fields, matching the Rust contract) ---
interface NmStatusPayload {
  steps: NmStep[];
  raw: string;
}
interface NmGatePayload {
  findings: NmFinding[];
  raw: string;
}
interface NmLogPayload {
  line: string;
}
interface NmDonePayload {
  outcome: 'checks-passed' | 'passed' | 'failed' | 'cancelled' | 'error';
  message: string;
  raw: string;
}
/** Result of the backend `nm_check` environment probe. */
interface NmCheckResult {
  installed: boolean;
  version: string | null;
  initialized: boolean;
  status_ok: boolean;
  raw_status: string;
}

const MAX_LOG_LINES = 500;

/** Runs keyed by runId. */
export const nmRuns = writable<Map<string, NmRun>>(new Map());

/** Active event unlisten handles, keyed by runId. */
const listeners = new Map<string, UnlistenFn[]>();

function patchRun(
  runId: string,
  patch: Partial<NmRun> | ((run: NmRun) => Partial<NmRun>),
): void {
  nmRuns.update((map) => {
    const run = map.get(runId);
    if (!run) return map;
    const p = typeof patch === 'function' ? patch(run) : patch;
    const next = new Map(map);
    next.set(runId, { ...run, ...p });
    return next;
  });
}

function detachListeners(runId: string): void {
  const handles = listeners.get(runId);
  if (handles) {
    for (const off of handles) {
      try {
        off();
      } catch {
        /* already detached */
      }
    }
    listeners.delete(runId);
  }
}

/**
 * The run for a session, if any. There is at most one visible run per session
 * (starting a new run replaces a finished one). Non-reactive — reads the current
 * store value. For reactive use, derive from the `nmRuns` store directly.
 */
export function getRunForSession(sessionId: string): NmRun | undefined {
  for (const run of get(nmRuns).values()) {
    if (run.sessionId === sessionId) return run;
  }
  return undefined;
}

function isActive(status: NmRunStatus): boolean {
  return status === 'starting' || status === 'running' || status === 'gate';
}

async function startRun(
  sessionId: string,
  cwd: string,
  intent: string,
): Promise<string> {
  const existing = getRunForSession(sessionId);
  if (existing && isActive(existing.status)) {
    throw new Error('A no-mistakes run is already active for this session.');
  }
  // Replace a finished run for this session.
  if (existing) dismiss(existing.runId);

  const runId = crypto.randomUUID();
  const run: NmRun = {
    runId,
    sessionId,
    cwd,
    intent,
    status: 'starting',
    steps: [],
    findings: [],
    selectedFindingIds: [],
    log: [],
    lastRaw: '',
    startedAt: Date.now(),
  };
  nmRuns.update((map) => {
    const next = new Map(map);
    next.set(runId, run);
    return next;
  });

  // Wire all four listeners BEFORE kicking off the run so no early event is lost.
  const unlistens: UnlistenFn[] = [];
  unlistens.push(
    await listen<NmStatusPayload>(`nm-status-${runId}`, (e) => {
      patchRun(runId, (r) => {
        const next: Partial<NmRun> = {
          steps: e.payload.steps ?? r.steps,
          lastRaw: e.payload.raw ?? r.lastRaw,
        };
        // A status update means the pipeline is progressing again — leave a
        // gate/starting state and clear any in-flight response spinner.
        if (isActive(r.status)) {
          next.status = 'running';
          next.responding = false;
        }
        return next;
      });
    }),
  );
  unlistens.push(
    await listen<NmGatePayload>(`nm-gate-${runId}`, (e) => {
      const findings = e.payload.findings ?? [];
      const selectedFindingIds = findings
        .filter((f) => f.action === 'auto-fix')
        .map((f) => f.id);
      patchRun(runId, {
        status: 'gate',
        findings,
        selectedFindingIds,
        responding: false,
        lastRaw: e.payload.raw,
      });
    }),
  );
  unlistens.push(
    await listen<NmLogPayload>(`nm-log-${runId}`, (e) => {
      patchRun(runId, (r) => {
        const log = [...r.log, e.payload.line];
        if (log.length > MAX_LOG_LINES) {
          log.splice(0, log.length - MAX_LOG_LINES);
        }
        return { log };
      });
    }),
  );
  unlistens.push(
    await listen<NmDonePayload>(`nm-done-${runId}`, (e) => {
      const { outcome } = e.payload;
      const status: NmRunStatus =
        outcome === 'checks-passed' || outcome === 'passed'
          ? 'passed'
          : outcome === 'failed'
            ? 'failed'
            : outcome === 'cancelled'
              ? 'cancelled'
              : 'error';
      patchRun(runId, {
        status,
        outcome,
        message: e.payload.message,
        lastRaw: e.payload.raw,
        responding: false,
      });
      // Run stays visible until dismissed; we no longer need its listeners.
      detachListeners(runId);
    }),
  );
  listeners.set(runId, unlistens);

  // Preflight: don't launch when the CLI isn't installed or the repo isn't
  // initialized — surface a setup state with one-click fixes instead of a
  // cryptic runtime failure.
  const reason = await checkSetupNeeded(cwd);
  if (reason) {
    patchRun(runId, { status: 'setup', setupReason: reason });
  } else {
    await launch(runId, cwd, intent);
  }

  return runId;
}

/**
 * What setup step is still missing for `cwd`, if any. A failed probe counts
 * as not installed.
 */
async function checkSetupNeeded(cwd: string): Promise<NmSetupReason | null> {
  try {
    const check = await invoke<NmCheckResult>('nm_check', { cwd });
    if (!check.installed) return 'not-installed';
    if (!check.initialized) return 'not-initialized';
    return null;
  } catch {
    return 'not-installed';
  }
}

/** Kick off the backend run; failure turns the run into an error state. */
async function launch(runId: string, cwd: string, intent: string): Promise<void> {
  try {
    await invoke('nm_start_run', { runId, cwd, intent });
  } catch (err) {
    patchRun(runId, {
      status: 'error',
      outcome: 'error',
      message: err instanceof Error ? err.message : String(err),
      responding: false,
    });
    detachListeners(runId);
  }
}

/** Open a terminal running the official no-mistakes installer. */
async function install(runId: string): Promise<void> {
  try {
    await invoke('nm_install');
    patchRun(runId, (r) => ({
      log: [...r.log, 'Installer opened in a terminal window — finish it there, then click "Check again".'],
    }));
  } catch (err) {
    patchRun(runId, (r) => ({
      log: [
        ...r.log,
        `install failed: ${err instanceof Error ? err.message : String(err)}`,
      ],
    }));
  }
}

/**
 * Run `no-mistakes init` in the run's repo, then re-check; the run starts
 * automatically once everything is in place.
 */
async function initRepo(runId: string): Promise<void> {
  const run = get(nmRuns).get(runId);
  if (!run || run.status !== 'setup') return;
  patchRun(runId, { responding: true });
  try {
    const out = await invoke<string>('nm_init', { cwd: run.cwd });
    patchRun(runId, (r) => ({
      log: [...r.log, '$ no-mistakes init', ...out.trim().split('\n').filter(Boolean)],
    }));
  } catch (err) {
    patchRun(runId, (r) => ({
      responding: false,
      log: [
        ...r.log,
        `init failed: ${err instanceof Error ? err.message : String(err)}`,
      ],
    }));
    return;
  }
  patchRun(runId, { responding: false });
  await recheck(runId);
}

/**
 * Re-probe the environment for a run in setup; starts the run once the CLI is
 * installed and the repo is initialized, otherwise advances the setup reason.
 */
async function recheck(runId: string): Promise<void> {
  const run = get(nmRuns).get(runId);
  if (!run || run.status !== 'setup') return;
  patchRun(runId, { responding: true });
  const reason = await checkSetupNeeded(run.cwd);
  if (!reason) {
    // Reset the clock — setup wait time isn't run time.
    patchRun(runId, {
      status: 'starting',
      setupReason: undefined,
      responding: false,
      startedAt: Date.now(),
    });
    await launch(runId, run.cwd, run.intent);
  } else {
    patchRun(runId, (r) => ({
      setupReason: reason,
      responding: false,
      log:
        reason === r.setupReason && reason === 'not-installed'
          ? [...r.log, 'no-mistakes still not found — did the installer finish?']
          : r.log,
    }));
  }
}

async function respond(
  runId: string,
  action: 'approve' | 'fix' | 'skip',
  findingIds: string[] = [],
): Promise<void> {
  patchRun(runId, { responding: true });
  try {
    await invoke('nm_respond', {
      runId,
      action,
      findings: action === 'fix' ? findingIds : [],
    });
    // responding clears on the next gate/done event.
  } catch (err) {
    patchRun(runId, (r) => ({
      responding: false,
      log: [
        ...r.log,
        `respond failed: ${err instanceof Error ? err.message : String(err)}`,
      ],
    }));
  }
}

async function cancel(runId: string): Promise<void> {
  try {
    await invoke('nm_cancel', { runId });
    // The run resolves via a `nm-done` cancelled event.
  } catch (err) {
    patchRun(runId, (r) => ({
      log: [
        ...r.log,
        `cancel failed: ${err instanceof Error ? err.message : String(err)}`,
      ],
    }));
  }
}

function dismiss(runId: string): void {
  detachListeners(runId);
  nmRuns.update((map) => {
    if (!map.has(runId)) return map;
    const next = new Map(map);
    next.delete(runId);
    return next;
  });
}

/** Update the checked findings for a gate (kept in the store for consistency). */
function selectFindings(runId: string, findingIds: string[]): void {
  patchRun(runId, { selectedFindingIds: findingIds });
}

export const noMistakes = {
  startRun,
  respond,
  cancel,
  dismiss,
  selectFindings,
  install,
  initRepo,
  recheck,
};
