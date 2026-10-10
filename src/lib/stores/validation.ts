/**
 * Store for the native Validation pipeline.
 *
 * Validation runs a post-implementation pipeline (review → test → docs → lint →
 * ship → ci) against the committed changes on a session's branch. Each run is
 * driven entirely by the Rust backend over Tauri commands + events; mid-run it
 * can park at a decision "gate" (findings / fix-review diff / ship proposal / CI
 * failure) that the user resolves with approve / fix / skip.
 *
 * Unlike the older validation integration, the fixer is the session's OWN agent:
 * when the backend requests a fix, this store composes a fix prompt, waits for
 * the session to be idle, sends it, watches the session's next
 * querying→idle transition, and reports the outcome back to the backend
 * (`validation_fix_done` / `validation_fix_failed`). See §6 of the spec.
 *
 * A compact summary is mirrored onto `SdkSession.validation` (auto-persisted) so
 * a status badge survives app restart even though full runs are in-memory only.
 */
import { writable, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  sdkSessions,
  parkedTurnsOf,
  type EffortLevel,
  type QueuedValidationTiming,
  type RateLimitedState,
  type SdkSession,
  type SessionValidationSummary,
} from './sdkSessions';
import { settings } from './settings';
import { repos, findRepoById } from './repos';
import { buildFixPrompt } from '$lib/utils/validationFix';
import { buildValidationIntent } from '$lib/utils/validationIntent';
import {
  clampEffortForModel,
  DEFAULT_MODEL_ID,
  getProviderForModel,
  isAutoModel,
  modelSupportsEffort,
} from '$lib/utils/models';
import { noteAccountLaunch, pickAccountIdForRepo } from '$lib/utils/accountAutoSelect';

// ---------------------------------------------------------------------------
// Data model — mirrors src-tauri/src/validation/types.rs (event payloads are
// camelCase). See spec §1.
// ---------------------------------------------------------------------------

/** Pipeline steps, in fixed order. The *set* is user-chosen per run. */
export type StepName = 'simplify' | 'review' | 'test' | 'docs' | 'lint' | 'ship' | 'ci';

/** Canonical step order (fixed); the run's selected steps are a subset of this. */
export const VALIDATION_STEP_ORDER: readonly StepName[] = [
  'simplify',
  'review',
  'test',
  'docs',
  'lint',
  'ship',
  'ci',
] as const;

export type ValidationSeverity = 'error' | 'warning' | 'info';

/** Fail-closed: unknown/missing action deserializes to "ask-user" on the backend. */
export type FindingAction = 'auto-fix' | 'ask-user' | 'no-op';

export interface ValidationFinding {
  /** Deterministic: "<step>-<n>" for agent findings, "user-<n>" for user-added. */
  id: string;
  /** Short imperative title; absent on user-added findings (display falls back to description). */
  title?: string | null;
  severity: ValidationSeverity;
  file?: string | null;
  line?: number | null;
  description: string;
  action: FindingAction;
  /** "agent" | "user" */
  source: string;
  userInstructions?: string | null;
}

export type StepStatus =
  | 'pending'
  | 'running'
  | 'fixing'
  | 'gate'
  | 'fix_review'
  | 'passed'
  | 'skipped'
  | 'failed';

export type RunStatus = 'running' | 'gate' | 'passed' | 'failed' | 'cancelled';

export interface StepRound {
  round: number;
  /** "initial" | "auto_fix" | "user_fix" */
  trigger: string;
  findings: ValidationFinding[];
  /** Which findings were sent to the fixer. */
  selectedIds: string[];
  fixSummary?: string | null;
}

export interface StepProof {
  command?: string | null;
  exitCode?: number | null;
  /** Last ~2000 chars of command output. */
  outputTail?: string | null;
}

export interface EvidenceArtifact {
  kind: string;
  label: string;
  path: string;
}

export interface EvidenceReport {
  tested: string[];
  testingSummary: string;
  artifacts: EvidenceArtifact[];
}

export interface ValidationStep {
  name: StepName;
  status: StepStatus;
  rounds: StepRound[];
  /** Current (latest round) findings. */
  findings: ValidationFinding[];
  proof?: StepProof | null;
  note?: string | null;
  /** Reviewer/agent one-shot transcript text (drawer). */
  transcript?: string | null;
  /** review only: "low" | "medium" | "high" */
  riskLevel?: string | null;
  riskRationale?: string | null;
  /** test only. */
  evidence?: EvidenceReport | null;
  /** Raw `git diff` text of what the fix round changed. */
  fixReviewDiff?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export interface ShipProposal {
  commitMessage: string;
  prTitle: string;
  prBody: string;
  baseBranch: string;
  branch: string;
  hasUncommitted: boolean;
  alreadyPushed: boolean;
  /** If a PR already exists, ship only commits+pushes. */
  existingPrUrl?: string | null;
  /** commit+push only, PR skipped. */
  onDefaultBranch: boolean;
}

export interface GateState {
  step: StepName;
  /** "findings" | "fix_review" | "ship" | "ci_failure" */
  kind: string;
  findings: ValidationFinding[];
  /** kind === "ship" */
  ship?: ShipProposal | null;
  /** kind === "fix_review" */
  diff?: string | null;
}

export interface RunOptions {
  steps: StepName[];
  /** Model id from either configured provider, or "session". */
  reviewerModel: string;
  /** Effort used by every validation agent. */
  reviewerEffort?: string | null;
  /** Agent account id for the reviewer provider; absent means machine default. */
  reviewerAccountId?: string | null;
  /** Error findings get a verify pass before gating. */
  adversarialVerify: boolean;
  /** Defaults to the repo's default branch. */
  baseBranch?: string | null;
}

/** The FULL run snapshot emitted on every `validation-update` event. */
export interface ValidationRun {
  id: string;
  sessionId: string;
  cwd: string;
  status: RunStatus;
  /** Only the user-selected steps, in fixed order. */
  steps: ValidationStep[];
  gate?: GateState | null;
  intent: string;
  options: RunOptions;
  prUrl?: string | null;
  error?: string | null;
  /** A fix turn is being executed by the session. */
  pendingFix: boolean;
  startedAt: number;
  finishedAt?: number | null;
}

/**
 * One live activity item from a validation agent (a tool call or a text
 * block), streamed while the agent works so the run isn't a black box.
 */
export interface AgentActivityItem {
  /** "simplify" | "review" | "verify" | "evidence" | "docs" | "lint" */
  role: string;
  /** "tool" | "text" */
  kind: string;
  tool?: string | null;
  /** One-line tool input summary (command, file path, pattern…). */
  detail?: string | null;
  /** Trimmed text block (agent commentary / reasoning summary). */
  text?: string | null;
  /** Client-stamped arrival time. */
  ts: number;
}

/**
 * The store's per-run view: the backend snapshot plus client-only state (the
 * streaming log, live agent activity, the user's gate selection, user-added
 * findings, and a spinner flag). The backend snapshot is replaced wholesale on
 * each update; the client-only fields are preserved across updates.
 */
export interface ValidationRunView extends ValidationRun {
  /** Bounded streaming log (last MAX_LOG_LINES lines). */
  log: string[];
  /** Bounded live agent activity feed (last MAX_ACTIVITY_ITEMS items). */
  activity: AgentActivityItem[];
  /** Findings the user has checked at the current gate (seeded to auto-fix). */
  selectedFindingIds: string[];
  /** User-added findings for the current gate (sent as addedFindings on respond). */
  userFindings: ValidationFinding[];
  /** A respond/ship request is in flight (drives a spinner). */
  responding?: boolean;
  /** Where fix prompts are sent: the run's own session, or a fresh session
   *  created in the same cwd with the run's context prepended. */
  fixTarget: FixTarget;
  /** Model, effort, and provider-specific account used for a fresh fix session. */
  fixModel: string;
  fixEffort: EffortLevel;
  fixAccountId?: string;
  /** Client-only: whether the dock panel for this run is shown. Closing it does
   *  NOT cancel/dismiss the run — a collapsed status strip stays visible, and a
   *  new gate or a terminal outcome reopens the panel. Persisted on the session. */
  panelOpen: boolean;
  /** Client-only: signature of the gate we last seeded selection for. */
  gateSignature?: string;
  /**
   * Client-only: the run was restored from a persisted session snapshot but the
   * backend no longer has it (the app was restarted, so its tokio task and any
   * live agents are gone). A detached run renders as read-only history — its
   * gate can't be resolved and it can't be cancelled/resumed. Not persisted.
   */
  detached?: boolean;
}

export type FixTarget = 'session' | 'new-session';

/**
 * The slice of a run view persisted on `SdkSession.validationRun` so the whole
 * panel (steps, gate, outcome, PR link, open state) survives an app restart —
 * not just the compact badge summary. Excludes transient streaming feeds
 * (`log`/`activity`) and gate-interaction state that is reseeded on restore.
 */
export type PersistedValidationRun = Omit<
  ValidationRunView,
  'log' | 'activity' | 'responding' | 'selectedFindingIds' | 'userFindings' | 'gateSignature' | 'detached'
>;

// ---------------------------------------------------------------------------
// Event payload shapes (camelCase, matching the Rust contract).
// ---------------------------------------------------------------------------

/** `validation-update-{runId}` — the full serialized run. */
type ValidationUpdatePayload = ValidationRun;

/** `validation-log-{runId}` */
interface ValidationLogPayload {
  line: string;
}

/** `validation-agent-activity-{runId}` — live reviewer/agent activity. */
type AgentActivityPayload = Omit<AgentActivityItem, 'ts'>;

/** `validation-fix-request-{runId}` */
interface ValidationFixRequestPayload {
  step: StepName;
  findings: ValidationFinding[];
  instructions?: string | null;
  round: number;
  /** "auto_fix" | "user_fix" */
  trigger: string;
}

const MAX_LOG_LINES = 500;
const MAX_ACTIVITY_ITEMS = 300;

/** Runs keyed by runId (one visible run per session). */
export const validationRuns = writable<Map<string, ValidationRunView>>(new Map());

/** Active event unlisten handles, keyed by runId. */
const listeners = new Map<string, UnlistenFn[]>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function appendLog(log: string[], line: string): string[] {
  const next = [...log, line];
  if (next.length > MAX_LOG_LINES) next.splice(0, next.length - MAX_LOG_LINES);
  return next;
}

function appendActivity(
  activity: AgentActivityItem[],
  item: AgentActivityItem,
): AgentActivityItem[] {
  const next = [...activity, item];
  if (next.length > MAX_ACTIVITY_ITEMS) next.splice(0, next.length - MAX_ACTIVITY_ITEMS);
  return next;
}

/** Fresh fix sessions always use a supported, concrete effort when available. */
function normalizeFixEffort(
  model: string,
  effort: EffortLevel | string | undefined,
): EffortLevel {
  if (!modelSupportsEffort(model)) return null;
  return clampEffortForModel((effort ?? 'medium') as EffortLevel, model);
}

function patchView(
  runId: string,
  patch: Partial<ValidationRunView> | ((run: ValidationRunView) => Partial<ValidationRunView>),
): void {
  validationRuns.update((map) => {
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

/** A run is "active" while the pipeline is running or parked at a gate. */
function isActiveStatus(status: RunStatus): boolean {
  return status === 'running' || status === 'gate';
}

/** Stable signature of a gate (kind + finding ids) — used to detect gate changes. */
function gateSignature(gate: GateState | null | undefined): string {
  if (!gate) return '';
  return `${gate.kind}::${gate.findings.map((f) => f.id).join(',')}`;
}

/**
 * The run for a session, if any. There is at most one visible run per session.
 * Non-reactive — reads the current store value. For reactive use, derive from
 * the `validationRuns` store directly.
 */
export function getRunForSession(sessionId: string): ValidationRunView | undefined {
  for (const run of get(validationRuns).values()) {
    if (run.sessionId === sessionId) return run;
  }
  return undefined;
}

/** Which step is currently the focus of the run (running/fixing/gated), if any. */
function activeStep(run: ValidationRun): ValidationStep | undefined {
  return run.steps.find(
    (s) =>
      s.status === 'running' ||
      s.status === 'fixing' ||
      s.status === 'gate' ||
      s.status === 'fix_review',
  );
}

/** Mirror a compact run summary onto the session for a restart-surviving badge. */
function mirrorToSession(run: ValidationRun): void {
  const step = activeStep(run);
  const findingCount = run.gate?.findings.length ?? step?.findings.length ?? 0;
  const summary: SessionValidationSummary = {
    runId: run.id,
    status: run.status,
    step: step?.name,
    findingCount,
    prUrl: run.prUrl ?? undefined,
    updatedAt: Date.now(),
  };
  sdkSessions.setSessionValidation(run.sessionId, summary);
}

/** Strip the transient/gate-interaction fields from a view for persistence. */
function toPersistedRun(view: ValidationRunView): PersistedValidationRun {
  const {
    log: _log,
    activity: _activity,
    responding: _responding,
    selectedFindingIds: _selected,
    userFindings: _userFindings,
    gateSignature: _sig,
    detached: _detached,
    ...rest
  } = view;
  return rest;
}

/**
 * Persist the full run onto its session (`SdkSession.validationRun`) so the
 * panel — steps, gate, outcome, PR link, and open/closed state — is restored on
 * the next launch, not just the compact badge. Reads the current view from the
 * store map. (Rehydration seeds the store map directly without going through
 * this, so restoring a run never rewrites what it just loaded — meaning
 * panel open/close on a restored read-only run still persists correctly.)
 */
function persistRun(runId: string): void {
  const view = get(validationRuns).get(runId);
  if (!view) return;
  sdkSessions.setSessionValidationRun(view.sessionId, toPersistedRun(view));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Apply a full backend run snapshot (update event or get_run resync) to the view. */
function applySnapshot(runId: string, incoming: ValidationUpdatePayload): void {
  patchView(runId, (prev) => {
    const sig = gateSignature(incoming.gate);
    let selectedFindingIds = prev.selectedFindingIds;
    let userFindings = prev.userFindings;
    if (sig !== prev.gateSignature) {
      // A new / changed gate (or a cleared gate) — reseed the user's
      // selection to the auto-fixable findings and drop stale user findings.
      selectedFindingIds = (incoming.gate?.findings ?? [])
        .filter((f) => f.action === 'auto-fix')
        .map((f) => f.id);
      userFindings = [];
    }
    // A new gate needs the user's attention, and pass/fail is the outcome they
    // were waiting for — reopen a closed panel for both, unless the user has
    // turned off auto-opening session panels.
    let panelOpen = prev.panelOpen;
    const autoOpen = get(settings).auto_open_session_panels;
    if (autoOpen && sig !== prev.gateSignature && incoming.gate) panelOpen = true;
    if (
      autoOpen &&
      prev.status !== incoming.status &&
      (incoming.status === 'passed' || incoming.status === 'failed')
    ) {
      panelOpen = true;
    }
    return {
      ...incoming,
      log: prev.log,
      activity: prev.activity,
      fixTarget: prev.fixTarget,
      fixModel: prev.fixModel,
      fixEffort: prev.fixEffort,
      fixAccountId: prev.fixAccountId,
      panelOpen,
      selectedFindingIds,
      userFindings,
      gateSignature: sig,
      // Any state change means the backend advanced — clear the spinner.
      responding: false,
    };
  });
  mirrorToSession(incoming);
  persistRun(runId);
  // Terminal runs no longer emit events; a live fix watcher (if any) is moot.
  if (!isActiveStatus(incoming.status)) {
    cancelFixWatcher(runId);
  }
}

/**
 * Register the update/log/fix-request listeners for a run and seed its view.
 * Idempotent per runId.
 */
async function attachRun(runId: string, seed: ValidationRunView): Promise<void> {
  validationRuns.update((map) => {
    const next = new Map(map);
    next.set(runId, seed);
    return next;
  });

  const unlistens: UnlistenFn[] = [];

  unlistens.push(
    await listen<ValidationUpdatePayload>(`validation-update-${runId}`, (e) => {
      applySnapshot(runId, e.payload);
    }),
  );

  unlistens.push(
    await listen<ValidationLogPayload>(`validation-log-${runId}`, (e) => {
      patchView(runId, (r) => ({ log: appendLog(r.log, e.payload.line) }));
    }),
  );

  unlistens.push(
    await listen<AgentActivityPayload>(`validation-agent-activity-${runId}`, (e) => {
      patchView(runId, (r) => ({
        activity: appendActivity(r.activity, { ...e.payload, ts: Date.now() }),
      }));
    }),
  );

  unlistens.push(
    await listen<ValidationFixRequestPayload>(`validation-fix-request-${runId}`, (e) => {
      void startFix(runId, e.payload);
    }),
  );

  listeners.set(runId, unlistens);
}

/**
 * Start a validation run for a session. Throws if a run is already active for
 * the session; replaces a finished run otherwise.
 *
 * Note: the backend generates and returns the run id, so listeners can only
 * attach after the invoke resolves. A `validation_get_run` resync right after
 * attaching covers anything emitted in that gap; every subsequent
 * `validation-update` carries the full snapshot anyway.
 */
async function startRun(
  sessionId: string,
  cwd: string,
  repoId: string | undefined,
  intent: string,
  options: RunOptions,
): Promise<string> {
  const existing = getRunForSession(sessionId);
  if (existing && isActiveStatus(existing.status)) {
    throw new Error('A validation run is already active for this session.');
  }
  if (existing) dismiss(existing.id);

  const pickedReviewerAccountId = options.reviewerAccountId;
  if (!options.reviewerAccountId) {
    const reviewerAccountId = resolveReviewerAccountId(options, repoId, cwd);
    noteAccountLaunch(reviewerAccountId, getProviderForModel(options.reviewerModel));
    options = { ...options, reviewerAccountId };
  }

  const runId = await invoke<string>('validation_start_run', {
    sessionId,
    cwd,
    repoId: repoId ?? null,
    intent,
    options,
  });

  const origin = get(sdkSessions).find((session) => session.id === sessionId);
  const fixModel = origin?.model ?? options.reviewerModel;
  const seed: ValidationRunView = {
    id: runId,
    sessionId,
    cwd,
    status: 'running',
    steps: [],
    gate: null,
    intent,
    options,
    prUrl: null,
    error: null,
    pendingFix: false,
    startedAt: Date.now(),
    finishedAt: null,
    log: [],
    activity: [],
    fixTarget: 'session',
    fixModel,
    fixEffort: normalizeFixEffort(
      fixModel,
      origin?.effortLevel ?? options.reviewerEffort ?? undefined,
    ),
    // An Auto reviewer leaves the fix account on Auto too.
    fixAccountId: origin?.accountId ?? pickedReviewerAccountId ?? undefined,
    panelOpen: true,
    selectedFindingIds: [],
    userFindings: [],
  };
  await attachRun(runId, seed);
  mirrorToSession(seed);
  persistRun(runId);

  // Resync: the run started before our listeners attached, so pull the
  // current snapshot to cover any state emitted in that gap (e.g. an
  // instantly-failed run that will never emit again).
  try {
    const snapshot = await invoke<ValidationUpdatePayload>('validation_get_run', { runId });
    applySnapshot(runId, snapshot);
  } catch {
    // Best-effort; the next update event carries the full state anyway.
  }

  return runId;
}

/** Build a live view from a persisted run snapshot, reseeding gate selection. */
function viewFromPersisted(p: PersistedValidationRun): ValidationRunView {
  const selectedFindingIds = (p.gate?.findings ?? [])
    .filter((f) => f.action === 'auto-fix')
    .map((f) => f.id);
  const origin = get(sdkSessions).find((session) => session.id === p.sessionId);
  return {
    ...p,
    panelOpen: p.panelOpen ?? false,
    fixTarget: p.fixTarget ?? 'session',
    fixModel: p.fixModel ?? origin?.model ?? p.options.reviewerModel,
    fixEffort: normalizeFixEffort(
      p.fixModel ?? origin?.model ?? p.options.reviewerModel,
      p.fixEffort ?? origin?.effortLevel ?? p.options.reviewerEffort ?? undefined,
    ),
    fixAccountId: p.fixAccountId ?? origin?.accountId ?? p.options.reviewerAccountId ?? undefined,
    log: [],
    activity: [],
    selectedFindingIds,
    userFindings: [],
    responding: false,
    gateSignature: gateSignature(p.gate),
    detached: true,
  };
}

/** The backend-owned slice of a run view (what `ValidationRun` deserializes). */
function toBackendRun(view: ValidationRunView): ValidationRun {
  return {
    id: view.id,
    sessionId: view.sessionId,
    cwd: view.cwd,
    status: view.status,
    steps: view.steps,
    gate: view.gate,
    intent: view.intent,
    options: view.options,
    prUrl: view.prUrl,
    error: view.error,
    pendingFix: view.pendingFix,
    startedAt: view.startedAt,
    finishedAt: view.finishedAt,
  };
}

/**
 * Hand a detached run's snapshot back to the backend so it re-adopts it, and go
 * live again. The backend re-enters the pipeline where the run was parked: a
 * gate is re-parked verbatim (free — no agent work until the user decides),
 * while a step that was mid-flight when the app died is re-run from the top.
 */
async function resume(runId: string): Promise<void> {
  const view = get(validationRuns).get(runId);
  if (!view || !view.detached || !isActiveStatus(view.status)) return;

  patchView(runId, { responding: true });
  try {
    const repoId = get(sdkSessions).find((s) => s.id === view.sessionId)?.repoId;
    await invoke<string>('validation_resume_run', {
      run: toBackendRun(view),
      repoId: repoId ?? null,
    });
  } catch (err) {
    patchView(runId, (r) => ({
      responding: false,
      log: appendLog(r.log, `resume failed: ${errMsg(err)}`),
    }));
    throw err;
  }

  // Adopted — attach listeners, then resync in case the run advanced in the gap.
  detachListeners(runId);
  const current = get(validationRuns).get(runId) ?? view;
  await attachRun(runId, { ...current, detached: false, responding: false });
  try {
    const snapshot = await invoke<ValidationUpdatePayload>('validation_get_run', { runId });
    applySnapshot(runId, snapshot);
  } catch {
    // Best-effort; the next update event carries the full state anyway.
  }
}

/**
 * Restore validation runs persisted on sessions (`SdkSession.validationRun`)
 * after sessions load from disk, so the full panel — not just the badge —
 * survives an app restart. Each restored run is seeded read-only (`detached`),
 * then we probe the backend: if it still has the run (e.g. a webview reload
 * without a full process restart), we reattach its live listeners and go live.
 *
 * Otherwise the run's backend task died with the previous process, and we hand
 * the snapshot back via `resume` so it becomes actionable again. Runs parked at
 * a gate resume automatically — re-parking costs nothing and the user's pending
 * decision is the whole point of restoring the panel. A run that was mid-step
 * stays detached until the user asks for it, since resuming re-runs that step's
 * agent. Idempotent — skips sessions whose run is already in the store.
 */
async function rehydrateFromSessions(): Promise<void> {
  const sessions = get(sdkSessions);
  for (const s of sessions) {
    const persisted = s.validationRun;
    if (!persisted) continue;
    if (get(validationRuns).has(persisted.id) || getRunForSession(s.id)) continue;

    const view = viewFromPersisted(persisted);
    validationRuns.update((map) => {
      const next = new Map(map);
      next.set(view.id, view);
      return next;
    });

    try {
      const snapshot = await invoke<ValidationUpdatePayload>('validation_get_run', {
        runId: view.id,
      });
      // Backend still owns this run — reattach listeners and refresh from live state.
      await attachRun(view.id, { ...view, detached: false });
      applySnapshot(view.id, snapshot);
      continue;
    } catch {
      // Backend no longer has it (a real restart) — the view stays detached.
    }

    if (view.status === 'gate') {
      try {
        await resume(view.id);
      } catch {
        // Left detached with a Resume button; the failure is in the run's log.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Queued validation runs
//
// A deferred run is a parked turn on the session (`action: 'validate'`), so it
// shares the message queue's rails: FIFO with queued messages, a ghost bubble
// with Run now / Cancel, persistence across restart, and the Smart Queue's
// triggers (session idle / repo idle / 5h reset / custom time). Two holds keep
// it from colliding with other work:
//   - a queued validation waits for any active run on the session to end;
//   - a queued turn of any kind waits while a run on its session is running
//     (a gate releases the hold — the run is then waiting on the user).
// Run settings are snapshotted at queue time; the intent is built at fire time
// so it covers everything the agent was asked up to that point.
// ---------------------------------------------------------------------------

/**
 * Should a parked turn on this session stay put because of validation?
 * `action` is the parked turn's action (a validation also waits out a gate and a
 * detached run, since `startRun` refuses while any run is active).
 */
export function validationHoldsTurn(sessionId: string, action?: string): boolean {
  const run = getRunForSession(sessionId);
  if (!run || !isActiveStatus(run.status)) return false;
  if (action === 'validate') return true;
  return run.status === 'running' && !run.detached;
}

/**
 * Resolve the "session" reviewer-model choice to a concrete model id (the backend
 * cannot see the live session's model). Unknown / Auto session models fall back
 * to the global default.
 */
export function resolveReviewerModel(choice: string, sessionModel: string | null | undefined): string {
  if (choice !== 'session') return choice;
  if (sessionModel && !isAutoModel(sessionModel)) return sessionModel;
  const fallback = get(settings).validation.reviewer_model;
  return fallback && fallback !== 'session' ? fallback : DEFAULT_MODEL_ID;
}

/** Last-used run options for a repo, resolved against the session (no popover). */
export function defaultRunOptionsForSession(
  session: SdkSession,
  repoId: string | undefined,
  repoSteps?: string[] | null,
): RunOptions {
  const seeded = seedRunOptions({ repoId, repoSteps, defaults: get(settings).validation });
  const reviewerModel = resolveReviewerModel(seeded.reviewerModel, session.model);
  return {
    ...seeded,
    reviewerModel,
    reviewerEffort: seeded.reviewerEffort && modelSupportsEffort(reviewerModel) ? seeded.reviewerEffort : null,
  };
}

/**
 * The reviewer account a run uses: the explicit pick (a reserved `default-*` id =
 * the machine login), or for null (Auto) the repo's pace / default pick for the
 * reviewer's provider — resolved when the run starts, not when it's queued.
 */
function resolveReviewerAccountId(options: RunOptions, repoId: string | undefined, cwd: string): string {
  if (options.reviewerAccountId) return options.reviewerAccountId;
  const list = get(repos).list;
  const scope = cwd.replaceAll('\\', '/');
  const repo =
    findRepoById(list, repoId) ??
    list.find((r) => scope.startsWith(r.path.replaceAll('\\', '/'))) ??
    null;
  const provider = getProviderForModel(options.reviewerModel) === 'openai' ? 'OpenAI' : 'Claude';
  return pickAccountIdForRepo(get(settings).accounts, repo, provider);
}

const STEP_LABELS: Record<StepName, string> = {
  simplify: 'Simplify',
  review: 'Review',
  test: 'Test',
  docs: 'Docs',
  lint: 'Lint',
  ship: 'Ship',
  ci: 'CI',
};

function describeSteps(steps: StepName[]): string {
  return steps.map((s) => STEP_LABELS[s] ?? s).join(' · ');
}

/**
 * Queue a validation run on a session (see the section comment). The reviewer
 * provider/account decide which usage window a 'reset_5h' timing waits on.
 */
function queueRun(
  sessionId: string,
  cwd: string,
  repoId: string | undefined,
  options: RunOptions,
  timing: QueuedValidationTiming,
): void {
  const provider = getProviderForModel(options.reviewerModel);
  sdkSessions.queueValidation(
    sessionId,
    `Validate: ${describeSteps(options.steps)}`,
    { cwd, repoId, options },
    timing,
    { provider, accountId: resolveReviewerAccountId(options, repoId, cwd) },
  );
}

/**
 * Fire a parked validation turn (called from `sdkSessions.continueRateLimited`,
 * i.e. by the Smart Queue or the ghost's Run now). Stays parked while another run
 * is active on the session; otherwise releases the turn and starts the run.
 */
export async function dispatchQueuedValidation(sessionId: string, turn: RateLimitedState): Promise<void> {
  const queued = turn.validation;
  if (!queued) {
    // Malformed (nothing to run) — drop it rather than wedge the queue.
    sdkSessions.clearRateLimited(sessionId, turn.id);
    return;
  }
  if (validationHoldsTurn(sessionId, 'validate')) return;
  const session = get(sdkSessions).find((s) => s.id === sessionId);
  if (!session) return;

  sdkSessions.releaseValidationTurn(
    sessionId,
    turn.id,
    `Validation started (${describeSteps(queued.options.steps)})`,
  );
  try {
    await startRun(sessionId, queued.cwd, queued.repoId, buildValidationIntent(session), queued.options);
  } catch (err) {
    sdkSessions.addNotification(sessionId, `Queued validation failed to start: ${errMsg(err)}`);
    throw err;
  }
}

/** Parked validation turns on a session, oldest first (for badges). */
export function queuedValidationsOf(session: SdkSession): RateLimitedState[] {
  return parkedTurnsOf(session).filter((t) => t.action === 'validate');
}

/** Resolve a gate. `fix` sends the selected findings (+ any user findings) to the fixer. */
async function respond(
  runId: string,
  action: 'approve' | 'skip' | 'fix',
  findingIds?: string[],
  instructions?: string,
  addedFindings?: ValidationFinding[],
): Promise<void> {
  const view = get(validationRuns).get(runId);
  const selected = findingIds ?? view?.selectedFindingIds ?? [];
  // User-added findings that are part of this fix, unless the caller overrides.
  const added =
    addedFindings ??
    (view?.userFindings ?? []).filter((f) => selected.includes(f.id));

  patchView(runId, { responding: true });
  try {
    await invoke('validation_respond', {
      runId,
      action,
      findingIds: action === 'fix' ? selected : null,
      instructions: instructions ?? null,
      addedFindings: added.length > 0 ? added : null,
    });
    // `responding` clears on the next update event.
  } catch (err) {
    patchView(runId, (r) => ({
      responding: false,
      log: appendLog(r.log, `respond failed: ${errMsg(err)}`),
    }));
  }
}

/** Answer a "ship" gate with the (possibly user-edited) commit message / PR text. */
async function executeShip(
  runId: string,
  commitMessage: string,
  prTitle: string,
  prBody: string,
): Promise<void> {
  patchView(runId, { responding: true });
  try {
    await invoke('validation_execute_ship', { runId, commitMessage, prTitle, prBody });
  } catch (err) {
    patchView(runId, (r) => ({
      responding: false,
      log: appendLog(r.log, `ship failed: ${errMsg(err)}`),
    }));
  }
}

/** Stop a run. Never interrupts an in-flight session fix turn — just stops the run. */
async function cancel(runId: string): Promise<void> {
  try {
    await invoke('validation_cancel', { runId });
    // Resolves via a `validation-update` with status "cancelled".
  } catch (err) {
    patchView(runId, (r) => ({
      log: appendLog(r.log, `cancel failed: ${errMsg(err)}`),
    }));
  }
}

/** Remove a finished run from the store. The compact badge summary is kept, but
 *  the persisted full run is cleared so a dismissed run doesn't rehydrate its
 *  panel on the next launch. */
function dismiss(runId: string): void {
  detachListeners(runId);
  cancelFixWatcher(runId);
  const view = get(validationRuns).get(runId);
  validationRuns.update((map) => {
    if (!map.has(runId)) return map;
    const next = new Map(map);
    next.delete(runId);
    return next;
  });
  if (view) sdkSessions.setSessionValidationRun(view.sessionId, null);
}

/** Update the checked findings for the current gate. */
function selectFindings(runId: string, findingIds: string[]): void {
  patchView(runId, { selectedFindingIds: findingIds });
}

/** Show the dock panel for a run. */
function openPanel(runId: string): void {
  patchView(runId, { panelOpen: true });
  persistRun(runId);
}

/** Hide the dock panel without touching the run (a status strip remains). */
function closePanel(runId: string): void {
  patchView(runId, { panelOpen: false });
  persistRun(runId);
}

/** Choose where fix prompts go: the run's session or a fresh one with context. */
function setFixTarget(runId: string, target: FixTarget): void {
  patchView(runId, { fixTarget: target });
  persistRun(runId);
}

/** Choose the model for fixes dispatched to a fresh session. */
function setFixModel(runId: string, model: string): void {
  patchView(runId, (run) => ({
    fixModel: model,
    fixEffort: normalizeFixEffort(model, run.fixEffort ?? undefined),
  }));
  persistRun(runId);
}

/** Choose the effort for fixes dispatched to a fresh session. */
function setFixEffort(runId: string, effort: EffortLevel): void {
  patchView(runId, (run) => ({
    fixEffort: normalizeFixEffort(run.fixModel, effort ?? undefined),
  }));
  persistRun(runId);
}

/** Choose the provider-specific account for fixes dispatched to a fresh session. */
function setFixAccount(runId: string, accountId: string | undefined): void {
  patchView(runId, { fixAccountId: accountId });
  persistRun(runId);
}

/**
 * Add a user-authored finding to the current gate and select it. Sent to the
 * fixer as an `addedFinding` on the next `fix` response.
 */
function addUserFinding(
  runId: string,
  finding: { description: string; severity?: ValidationSeverity; instructions?: string },
): void {
  patchView(runId, (r) => {
    const n = r.userFindings.length + 1;
    const item: ValidationFinding = {
      id: `user-${n}`,
      severity: finding.severity ?? 'warning',
      description: finding.description,
      action: 'auto-fix',
      source: 'user',
      userInstructions: finding.instructions?.trim() ? finding.instructions.trim() : null,
    };
    return {
      userFindings: [...r.userFindings, item],
      selectedFindingIds: [...r.selectedFindingIds, item.id],
    };
  });
}

// ---------------------------------------------------------------------------
// Fix loop (spec §6) — the fixer is the session's own agent.
// ---------------------------------------------------------------------------

type FixPhase = 'awaiting-idle' | 'sending' | 'in-fix';

interface FixWatcher {
  runId: string;
  sessionId: string;
  phase: FixPhase;
  /** The composed fix prompt. */
  prompt: string;
  /** Unsubscribe from the sessions store. */
  unsub: () => void;
  /** Guards the terminal report against double-firing. */
  done: boolean;
}

/** One in-flight fix watcher per run. */
const fixWatchers = new Map<string, FixWatcher>();

/** Statuses that mean the session is busy and can't accept a fix prompt yet. */
function isBusyStatus(status: SdkSession['status']): boolean {
  return status === 'querying' || status === 'initializing';
}

/** The session ended by a user stop (trailing "stopped" marker) rather than completing. */
function wasStoppedByUser(session: SdkSession): boolean {
  const last = session.messages[session.messages.length - 1];
  return last?.type === 'stopped' || session.stopRequestedAt != null;
}

/** The most recent error text on the session, for a fix-failed reason. */
function lastErrorReason(session: SdkSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.type === 'error' && m.content) return m.content;
  }
  return 'The fix turn ended with an error.';
}

/**
 * Compose the fix prompt and hand it to an agent — the run's own session, or
 * (per the run's `fixTarget`) a fresh session created in the same cwd with the
 * run's context prepended — then watch for the turn to finish. Guarded so only
 * one fix runs per run at a time.
 */
async function startFix(runId: string, payload: ValidationFixRequestPayload): Promise<void> {
  // Double-dispatch guard: one in-flight fix per run.
  if (fixWatchers.has(runId)) return;

  const view = get(validationRuns).get(runId);
  if (!view) return;

  const origin = get(sdkSessions).find((s) => s.id === view.sessionId);
  if (!origin) {
    void reportFixFailed(runId, 'The session was closed before the fix could start.');
    return;
  }

  if (view.fixTarget === 'new-session') {
    await startFixInNewSession(runId, view, origin, payload);
    return;
  }

  const prompt = buildFixPrompt(payload.findings, payload.instructions ?? undefined);

  const watcher: FixWatcher = {
    runId,
    sessionId: view.sessionId,
    phase: 'awaiting-idle',
    prompt,
    unsub: () => {},
    done: false,
  };
  fixWatchers.set(runId, watcher);

  // Subscribe (fires synchronously with the current value first).
  watcher.unsub = sdkSessions.subscribe((sessions) => {
    const s = sessions.find((sess) => sess.id === watcher.sessionId);
    void onFixTick(watcher, s);
  });
}

/**
 * Fix in a fresh session using the model/effort selected at the gate. Run it in
 * the run's cwd (same branch/worktree — that's where the changes live), send a
 * context-rich fix prompt as its first turn, and watch that session instead.
 * The origin session stays untouched.
 */
async function startFixInNewSession(
  runId: string,
  view: ValidationRunView,
  origin: SdkSession,
  payload: ValidationFixRequestPayload,
): Promise<void> {
  const prompt = buildFixPrompt(payload.findings, payload.instructions ?? undefined, {
    intent: view.intent,
    cwd: view.cwd,
  });

  // Reserve the watcher slot before the async launch so a second fix-request
  // can't double-dispatch while the session is being created.
  const watcher: FixWatcher = {
    runId,
    sessionId: '',
    phase: 'in-fix',
    prompt,
    unsub: () => {},
    done: false,
  };
  fixWatchers.set(runId, watcher);

  try {
    const model = view.fixModel || origin.model;
    const provider = getProviderForModel(model);
    const effort = normalizeFixEffort(
      model,
      view.fixEffort ?? origin.effortLevel ?? undefined,
    );
    // Unset = Auto (resolved at launch); a reserved `default-*` id is an explicit
    // machine-login pick and is normalized to undefined at session create.
    const accountId = view.fixAccountId || undefined;
    const newId = sdkSessions.createSetupSession(
      model,
      effort,
      provider,
      view.cwd,
    );
    watcher.sessionId = newId;
    await sdkSessions.startSetupSession(newId, {
      prompt,
      cwd: view.cwd,
      repoId: origin.repoId ?? undefined,
      model,
      effortLevel: effort,
      provider,
      accountId,
    });
  } catch (err) {
    finishFix(watcher, 'failed', errMsg(err));
    return;
  }

  patchView(runId, (r) => ({
    log: appendLog(r.log, 'fix dispatched to a new session'),
  }));

  // The prompt was sent as the new session's first turn; watch it finish.
  watcher.unsub = sdkSessions.subscribe((sessions) => {
    const s = sessions.find((sess) => sess.id === watcher.sessionId);
    void onFixTick(watcher, s);
  });
}

/** Drive the fix state machine on each sessions-store change. */
async function onFixTick(watcher: FixWatcher, session: SdkSession | undefined): Promise<void> {
  if (watcher.done) return;
  if (!fixWatchers.has(watcher.runId)) return;

  if (!session) {
    finishFix(watcher, 'failed', 'The session was closed before the fix could complete.');
    return;
  }

  const status = session.status;

  if (watcher.phase === 'sending') return; // send in flight — ignore ticks

  if (watcher.phase === 'awaiting-idle') {
    if (isBusyStatus(status)) return; // wait until the session finishes its turn
    watcher.phase = 'sending';
    try {
      await sdkSessions.sendPrompt(watcher.sessionId, watcher.prompt);
    } catch (err) {
      finishFix(watcher, 'failed', errMsg(err));
      return;
    }
    // sendPrompt has set the session to "querying"; wait for the turn to end.
    watcher.phase = 'in-fix';
    // Re-evaluate immediately in case the turn already resolved.
    const fresh = get(sdkSessions).find((s) => s.id === watcher.sessionId);
    void onFixTick(watcher, fresh);
    return;
  }

  // phase === 'in-fix' — waiting for the fix turn to reach a terminal state.
  if (status === 'querying' || status === 'initializing') return;
  if (status === 'error') {
    finishFix(watcher, 'failed', lastErrorReason(session));
    return;
  }
  if (status === 'idle' || status === 'done') {
    if (wasStoppedByUser(session)) {
      finishFix(watcher, 'failed', 'The fix turn was stopped before it finished.');
    } else {
      finishFix(watcher, 'done');
    }
    return;
  }
  // Any other status (session diverted to setup/queued/etc.) — treat as a failure.
  finishFix(watcher, 'failed', `The session left the fix turn (status: ${status}).`);
}

/** Tear down a fix watcher and report the outcome to the backend. */
function finishFix(watcher: FixWatcher, outcome: 'done' | 'failed', reason?: string): void {
  if (watcher.done) return;
  watcher.done = true;
  fixWatchers.delete(watcher.runId);
  try {
    watcher.unsub();
  } catch {
    /* already detached */
  }
  if (outcome === 'done') {
    void invoke('validation_fix_done', { runId: watcher.runId, fixSummary: null }).catch((err) => {
      patchView(watcher.runId, (r) => ({ log: appendLog(r.log, `fix_done failed: ${errMsg(err)}`) }));
    });
  } else {
    void reportFixFailed(watcher.runId, reason ?? 'The fix turn failed.');
  }
}

/** Report a fix failure to the backend (also used when no watcher could start). */
async function reportFixFailed(runId: string, error: string): Promise<void> {
  try {
    await invoke('validation_fix_failed', { runId, error });
  } catch (err) {
    patchView(runId, (r) => ({ log: appendLog(r.log, `fix_failed failed: ${errMsg(err)}`) }));
  }
}

/** Silently drop a fix watcher (run finished/cancelled) without reporting. */
function cancelFixWatcher(runId: string): void {
  const watcher = fixWatchers.get(runId);
  if (!watcher) return;
  watcher.done = true;
  fixWatchers.delete(runId);
  try {
    watcher.unsub();
  } catch {
    /* already detached */
  }
}

// ---------------------------------------------------------------------------
// Per-repo last-used run options (localStorage) + seeding.
// ---------------------------------------------------------------------------

const RUN_OPTIONS_KEY_PREFIX = 'open-whisperer:validation-run-options:';

function runOptionsKey(repoId: string | undefined): string {
  return `${RUN_OPTIONS_KEY_PREFIX}${repoId ?? 'default'}`;
}

/** Narrow an arbitrary string array to known step names, preserving canonical order. */
function normalizeSteps(steps: unknown): StepName[] {
  const set = new Set(Array.isArray(steps) ? (steps as string[]) : []);
  return VALIDATION_STEP_ORDER.filter((s) => set.has(s));
}

/** Load the last-used run options for a repo from localStorage, or null. */
export function loadRunOptions(repoId: string | undefined): RunOptions | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(runOptionsKey(repoId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RunOptions>;
    const steps = normalizeSteps(parsed.steps);
    if (!parsed.reviewerModel) return null;
    return {
      steps,
      reviewerModel: parsed.reviewerModel,
      reviewerEffort: parsed.reviewerEffort ?? null,
      reviewerAccountId: parsed.reviewerAccountId ?? null,
      adversarialVerify: !!parsed.adversarialVerify,
      baseBranch: parsed.baseBranch ?? null,
    };
  } catch {
    return null;
  }
}

/** Persist the last-used run options for a repo to localStorage (best-effort). */
export function saveRunOptions(repoId: string | undefined, options: RunOptions): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(runOptionsKey(repoId), JSON.stringify(options));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}

/** The minimal shape of `settings.validation` needed to seed run options. */
export interface ValidationDefaults {
  default_steps: string[];
  reviewer_model: string;
  reviewer_effort: string | null;
  adversarial_verify: boolean;
}

/**
 * Seed the run options for a new run, most-specific wins:
 *   localStorage (last used) → repo overrides (validation_steps) → global defaults.
 */
export function seedRunOptions(args: {
  repoId?: string;
  repoSteps?: string[] | null;
  defaults: ValidationDefaults;
}): RunOptions {
  const { repoId, repoSteps, defaults } = args;

  const saved = loadRunOptions(repoId);
  if (saved && saved.steps.length > 0) return saved;

  const repoSelected = normalizeSteps(repoSteps);
  const steps = repoSelected.length > 0 ? repoSelected : normalizeSteps(defaults.default_steps);

  return {
    steps: steps.length > 0 ? steps : ['review'],
    reviewerModel: saved?.reviewerModel ?? defaults.reviewer_model,
    reviewerEffort: saved?.reviewerEffort ?? defaults.reviewer_effort ?? null,
    reviewerAccountId: saved?.reviewerAccountId ?? null,
    adversarialVerify: saved?.adversarialVerify ?? defaults.adversarial_verify,
    baseBranch: saved?.baseBranch ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const validation = {
  startRun,
  queueRun,
  rehydrateFromSessions,
  resume,
  respond,
  executeShip,
  cancel,
  dismiss,
  selectFindings,
  setFixTarget,
  setFixModel,
  setFixEffort,
  setFixAccount,
  addUserFinding,
  openPanel,
  closePanel,
};
