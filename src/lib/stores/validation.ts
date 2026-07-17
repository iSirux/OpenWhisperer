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
import { sdkSessions, type SdkSession, type SessionValidationSummary } from './sdkSessions';
import { buildFixPrompt } from '$lib/utils/validationFix';

// ---------------------------------------------------------------------------
// Data model — mirrors src-tauri/src/validation/types.rs (event payloads are
// camelCase). See spec §1.
// ---------------------------------------------------------------------------

/** Pipeline steps, in fixed order. The *set* is user-chosen per run. */
export type StepName = 'review' | 'test' | 'docs' | 'lint' | 'ship' | 'ci';

/** Canonical step order (fixed); the run's selected steps are a subset of this. */
export const VALIDATION_STEP_ORDER: readonly StepName[] = [
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
  /** Claude model id, or "session" (= use the session's model). */
  reviewerModel: string;
  /** "low" | "medium" | "high" | null */
  reviewerEffort?: string | null;
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
  /** "review" | "verify" | "evidence" | "docs" | "lint" */
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
  /** Client-only: signature of the gate we last seeded selection for. */
  gateSignature?: string;
}

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
    return {
      ...incoming,
      log: prev.log,
      activity: prev.activity,
      selectedFindingIds,
      userFindings,
      gateSignature: sig,
      // Any state change means the backend advanced — clear the spinner.
      responding: false,
    };
  });
  mirrorToSession(incoming);
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

  const runId = await invoke<string>('validation_start_run', {
    sessionId,
    cwd,
    repoId: repoId ?? null,
    intent,
    options,
  });

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
    selectedFindingIds: [],
    userFindings: [],
  };
  await attachRun(runId, seed);
  mirrorToSession(seed);

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

/** Remove a finished run from the store (its mirrored session badge is kept). */
function dismiss(runId: string): void {
  detachListeners(runId);
  cancelFixWatcher(runId);
  validationRuns.update((map) => {
    if (!map.has(runId)) return map;
    const next = new Map(map);
    next.delete(runId);
    return next;
  });
}

/** Update the checked findings for the current gate. */
function selectFindings(runId: string, findingIds: string[]): void {
  patchView(runId, { selectedFindingIds: findingIds });
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
 * Compose the fix prompt and hand it to the session's agent, then watch for the
 * turn to finish. Guarded so only one fix runs per run at a time.
 */
async function startFix(runId: string, payload: ValidationFixRequestPayload): Promise<void> {
  // Double-dispatch guard: one in-flight fix per run.
  if (fixWatchers.has(runId)) return;

  const view = get(validationRuns).get(runId);
  if (!view) return;
  const sessionId = view.sessionId;

  const session = get(sdkSessions).find((s) => s.id === sessionId);
  if (!session) {
    void reportFixFailed(runId, 'The session was closed before the fix could start.');
    return;
  }

  const prompt = buildFixPrompt(payload.findings, payload.instructions ?? undefined);

  const watcher: FixWatcher = {
    runId,
    sessionId,
    phase: 'awaiting-idle',
    prompt,
    unsub: () => {},
    done: false,
  };
  fixWatchers.set(runId, watcher);

  // Subscribe (fires synchronously with the current value first).
  watcher.unsub = sdkSessions.subscribe((sessions) => {
    const s = sessions.find((sess) => sess.id === sessionId);
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
    adversarialVerify: saved?.adversarialVerify ?? defaults.adversarial_verify,
    baseBranch: saved?.baseBranch ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const validation = {
  startRun,
  respond,
  executeShip,
  cancel,
  dismiss,
  selectFindings,
  addUserFinding,
};
