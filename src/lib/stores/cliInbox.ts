/**
 * `ow` CLI inbox — applies requests written by the `ow` CLI (run by an agent
 * inside its session, or by the user in a terminal): create a schedule, launch a
 * session now, cancel/list schedules, ping.
 *
 * Protocol and rationale: docs/cli-scheduling-spec.md. The backend only moves
 * files (`take_cli_requests` / `write_cli_ack`); everything that needs app state
 * (repo lookup, defaults, Schedule creation, launching) happens here so the
 * schedule schema stays frontend-owned.
 */

import { get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { dev } from '$app/environment';

import { repos, findRepoById, type RepoConfig } from './repos';
import { sdkSessions, normalizeScopePath, type EffortLevel, type SdkSession } from './sdkSessions';
import { settings } from './settings';
import {
  schedules,
  describeScheduleSpec,
  evaluateSchedulesNow,
  isValidScheduleSpec,
  type Schedule,
  type ScheduleSpec,
} from './schedules';
import { launchSession, snapshotLaunchConfigForRepo } from '$lib/utils/sessionLaunch';
import { defaultAccountIdForRepo } from '$lib/utils/accounts';
import {
  clampEffortForModel,
  getModelById,
  getProviderForModel,
  resolveModelAlias,
} from '$lib/utils/models';

const POLL_MS = 2000;
/** Non-`schedule` requests older than this are refused: a stale `run` must never fire later. */
const STALE_MS = 60_000;

type Provider = 'claude' | 'openai';
type CliEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly CliEffort[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

interface CliTarget {
  mode: 'new_session' | 'same_session';
  repoPath: string | null;
  worktreePath: string | null;
  branch: string | null;
  repo: string | null;
  model: string | null;
  effort: CliEffort | null;
  /**
   * Deprecated: the provider follows from `model` since the `--provider` flag was
   * removed. Still honored when no model was requested, so an older installed `ow`
   * binary keeps working until it is updated.
   */
  provider: Provider | null;
  newWorktree: boolean;
}

interface CliRequest {
  version: number;
  id: string;
  createdAt: number;
  kind: 'schedule' | 'run' | 'cancel' | 'list' | 'ping';
  cwd: string;
  sessionId: string | null;
  prompt?: string;
  label?: string | null;
  target?: CliTarget;
  when?: ScheduleSpec;
  waitForIdle?: boolean;
  catchUp?: 'skip' | 'run_once';
  scheduleId?: string;
}

type CliAck =
  | ({ ok: true; kind: CliRequest['kind']; message: string } & Record<string, unknown>)
  | { ok: false; error: string };

/** A user-facing refusal (goes into the ack verbatim). Anything else is an internal error. */
class CliError extends Error {}

interface ResolvedLaunch {
  model: string;
  effortLevel: EffortLevel;
  provider: Provider;
  accountId?: string;
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

function samePath(a: string, b: string): boolean {
  return normalizeScopePath(a) === normalizeScopePath(b);
}

function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}

function sessionName(s: SdkSession): string {
  return s.aiMetadata?.name || s.id.slice(0, 8);
}

function findSession(id: string | null | undefined): SdkSession | undefined {
  if (!id) return undefined;
  return get(sdkSessions).find((s) => s.id === id);
}

function requireTarget(req: CliRequest): CliTarget {
  const t = req.target;
  if (!t || typeof t !== 'object') throw new CliError('Missing target');
  if (t.effort != null && !EFFORTS.includes(t.effort)) {
    throw new CliError(`Invalid effort "${t.effort}" (use ${EFFORTS.join('|')})`);
  }
  if (t.provider != null && t.provider !== 'claude' && t.provider !== 'openai') {
    throw new CliError(`Invalid provider "${t.provider}" (use claude|openai)`);
  }
  return t;
}

function requirePrompt(req: CliRequest): string {
  const prompt = typeof req.prompt === 'string' ? req.prompt.trim() : '';
  if (!prompt) throw new CliError('The prompt is empty');
  return prompt;
}

function requireRepoId(repo: RepoConfig): string {
  if (!repo.id) throw new CliError(`Repository "${repo.name}" has no id yet; reopen the app and retry`);
  return repo.id;
}

/**
 * `--repo` override (name, case-insensitive, or path) wins; otherwise the main
 * worktree root the CLI detected must be a registered repository. The CLI's cwd
 * is tried last so a non-git folder that is itself a registered repo still works.
 */
function resolveRepo(target: CliTarget, cwd: string): RepoConfig {
  const list = get(repos).list;
  const override = target.repo?.trim();
  if (override) {
    const q = override.toLowerCase();
    const found =
      list.find((r) => r.name.toLowerCase() === q) ?? list.find((r) => samePath(r.path, override));
    if (!found) {
      const names = list.map((r) => r.name).join(', ') || '(none)';
      throw new CliError(`Unknown repository "${override}". Registered: ${names}`);
    }
    return found;
  }
  for (const p of [target.repoPath, target.worktreePath, cwd]) {
    if (!p) continue;
    const found = list.find((r) => samePath(r.path, p));
    if (found) return found;
  }
  if (target.repoPath) {
    throw new CliError(
      `Not a registered OpenWhisperer repository: ${target.repoPath}. Add it in the app or pass --repo <name>.`
    );
  }
  throw new CliError('Not inside a git repository. Run ow from a repository, or pass --repo <name>.');
}

/** The existing worktree to run in — only when it belongs to the resolved repo. */
function resolveWorktree(target: CliTarget, repo: RepoConfig): string | undefined {
  if (target.newWorktree) return undefined;
  const wt = target.worktreePath?.trim();
  if (!wt || samePath(wt, repo.path)) return undefined;
  if (target.repoPath && !samePath(target.repoPath, repo.path)) return undefined; // --repo pointed elsewhere
  return wt;
}

/**
 * Turn a requested model name into a concrete catalog id. Short aliases are the
 * documented way to ask for a model from the CLI ("opus", "astra", "5.6-terra"),
 * so an unmatched name is a typo, not a new model: refuse it here rather than
 * letting session creation fail later where nothing surfaces the reason.
 */
function resolveModelName(requested: string): string {
  const resolved = resolveModelAlias(requested);
  if (getModelById(resolved)) return resolved;
  const s = get(settings);
  const known = [
    ...(s.enabled_providers.claude ? s.enabled_models : []),
    ...(s.enabled_providers.openai ? s.enabled_openai_models : []),
  ]
    .map((id) => getModelById(id)?.id)
    .filter((id): id is string => !!id);
  throw new CliError(`Unknown model "${requested}". Available: ${known.join(', ') || '(none enabled)'}`);
}

/**
 * Model/effort/account: explicit request values → the invoking session's (when the
 * CLI ran inside one) → the app defaults for the repo. **The provider follows from
 * the model** — there is no separate provider choice.
 */
function resolveLaunch(target: CliTarget, repo: RepoConfig, invoking?: SdkSession): ResolvedLaunch {
  const s = get(settings);
  const base = snapshotLaunchConfigForRepo(repo);
  const requested = target.model?.trim();

  // `target.provider` only survives for older `ow` binaries that still send it;
  // a requested model always wins over it.
  const legacyProvider = requested ? undefined : (target.provider ?? undefined);

  const model = requested
    ? resolveModelName(requested)
    : legacyProvider
      ? legacyProvider === (invoking?.provider ?? base.provider)
        ? (invoking?.model ?? base.model)
        : legacyProvider === 'openai'
          ? s.openai_model
          : s.default_model
      : (invoking?.model ?? base.model);

  const provider = getProviderForModel(model);
  if (!(provider === 'openai' ? s.enabled_providers.openai : s.enabled_providers.claude)) {
    throw new CliError(
      `Model "${model}" needs the ${provider === 'openai' ? 'Codex' : 'Claude'} provider, which is disabled in Settings → General`
    );
  }

  // Effort follows the invoking session even across providers (the model may have
  // moved the run to Codex; the requested thinking depth still applies), clamped to
  // what the chosen model actually accepts.
  const effortLevel: EffortLevel = clampEffortForModel(
    target.effort
      ? target.effort === 'off'
        ? null
        : target.effort
      : (invoking?.effortLevel ?? base.effortLevel),
    model
  );

  // An account belongs to one provider, so it is only inheritable within it.
  const accountId =
    invoking && (invoking.provider ?? 'claude') === provider
      ? invoking.accountId
      : provider === base.provider
        ? base.accountId
        : s.account_auto_select === 'pace'
          ? undefined // picked by usage pace at launch
          : defaultAccountIdForRepo(s.accounts, repo, provider === 'openai' ? 'OpenAI' : 'Claude');

  return { model, effortLevel, provider, accountId };
}

function targetSummary(schedule: Schedule): string {
  if (schedule.target.kind === 'message') {
    const session = findSession(schedule.target.sessionId);
    return `follow-up in session "${session ? sessionName(session) : schedule.target.sessionId}"`;
  }
  const repo = findRepoById(get(repos).list, schedule.target.repoId);
  const where = schedule.target.useWorktree
    ? ' (new worktree)'
    : schedule.target.worktreePath
      ? ` (worktree ${basename(schedule.target.worktreePath)})`
      : '';
  return `new session · ${repo?.name ?? 'unknown repo'}${where}`;
}

function isBusy(session: SdkSession): boolean {
  return session.status === 'querying' || session.status === 'initializing';
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleSchedule(req: CliRequest): Promise<CliAck> {
  const target = requireTarget(req);
  const prompt = requirePrompt(req);
  if (!isValidScheduleSpec(req.when)) throw new CliError('Invalid or missing schedule timing');
  if (req.when.kind === 'at' && req.when.at <= Date.now()) {
    throw new CliError(`That time is already in the past (${new Date(req.when.at).toLocaleString()})`);
  }

  const invoking = findSession(req.sessionId);
  const repo = resolveRepo(target, req.cwd);
  const repoId = requireRepoId(repo);
  const worktreePath = resolveWorktree(target, repo);
  const launch = resolveLaunch(target, repo, invoking);

  let scheduleTarget: Schedule['target'];
  if (target.mode === 'same_session') {
    if (!invoking) {
      throw new CliError('--same-session needs a live OpenWhisperer session (run ow from inside one)');
    }
    scheduleTarget = {
      kind: 'message',
      sessionId: invoking.id,
      ifSessionGone: 'launch_new',
      fallback: { repoId, ...launch, ...(worktreePath ? { worktreePath } : {}) },
    };
  } else {
    scheduleTarget = {
      kind: 'session',
      repoId,
      ...launch,
      useWorktree: !!target.newWorktree,
      ...(worktreePath ? { worktreePath } : {}),
    };
  }

  const item = schedules.add({
    target: scheduleTarget,
    prompt,
    when: req.when,
    label: req.label?.trim() || undefined,
    waitForIdle: !!req.waitForIdle,
    catchUp: req.catchUp === 'skip' ? 'skip' : 'run_once',
    source: 'cli',
  });
  if (item.nextFireAt == null) {
    schedules.remove(item.id);
    throw new CliError('That schedule would never fire (no upcoming occurrence)');
  }
  if (item.nextFireAt <= Date.now()) void evaluateSchedulesNow();

  return {
    ok: true,
    kind: 'schedule',
    message: `Scheduled "${item.label}" — ${describeScheduleSpec(item.when)} · ${targetSummary(item)}`,
    scheduleId: item.id,
    label: item.label,
    nextFireAt: item.nextFireAt,
    repo: repo.name,
    cwd: worktreePath ?? repo.path,
  };
}

async function handleRun(req: CliRequest): Promise<CliAck> {
  const target = requireTarget(req);
  const prompt = requirePrompt(req);
  const invoking = findSession(req.sessionId);
  const repo = resolveRepo(target, req.cwd);
  const repoId = requireRepoId(repo);
  const worktreePath = resolveWorktree(target, repo);
  const launch = resolveLaunch(target, repo, invoking);

  if (target.mode === 'same_session') {
    if (!invoking) {
      throw new CliError('--same-session needs a live OpenWhisperer session (run ow from inside one)');
    }
    // Park it as a due message-target schedule rather than calling sendPrompt directly:
    // the driver waits for the session to be idle instead of colliding with a running
    // turn, and the run shows up in the schedule history.
    const now = Date.now();
    const item = schedules.add({
      target: {
        kind: 'message',
        sessionId: invoking.id,
        ifSessionGone: 'launch_new',
        fallback: { repoId, ...launch, ...(worktreePath ? { worktreePath } : {}) },
      },
      prompt,
      when: { kind: 'at', at: now },
      nextFireAt: now,
      label: req.label?.trim() || undefined,
      waitForIdle: false,
      catchUp: 'run_once',
      source: 'cli',
    });
    void evaluateSchedulesNow();
    const name = sessionName(invoking);
    return {
      ok: true,
      kind: 'run',
      message: isBusy(invoking)
        ? `Queued follow-up for session "${name}" — it will be sent when the session is idle`
        : `Sent follow-up to session "${name}"`,
      sessionId: invoking.id,
      scheduleId: item.id,
      repo: repo.name,
      cwd: invoking.cwd,
    };
  }

  // `--wait-idle` rides the Smart Queue's after_sessions rail: parked until the
  // target repo/worktree scope has no running session.
  const sessionId = await launchSession({
    prompt,
    repo,
    ...launch,
    useWorktree: !!target.newWorktree,
    ...(worktreePath ? { worktreePath } : {}),
    ...(req.waitForIdle ? { schedule: 'after_sessions' as const } : {}),
    onWorktreeError: 'fail',
  });
  const where = target.newWorktree
    ? ' (new worktree)'
    : worktreePath
      ? ` (worktree ${basename(worktreePath)})`
      : '';
  const parked = findSession(sessionId)?.status === 'queued';
  return {
    ok: true,
    kind: 'run',
    message: parked
      ? req.waitForIdle
        ? `Session queued in ${repo.name}${where} — starts when the worktree is idle`
        : `Session queued in ${repo.name}${where} — the provider's usage window is exhausted; it starts at reset`
      : `Started session in ${repo.name}${where}`,
    sessionId,
    repo: repo.name,
    cwd: worktreePath ?? repo.path,
  };
}

function handleCancel(req: CliRequest): CliAck {
  const q = (req.scheduleId ?? '').trim();
  if (!q) throw new CliError('Missing schedule id');
  const all = get(schedules);
  let matches = all.filter((s) => s.id === q);
  if (matches.length === 0) matches = all.filter((s) => s.id.startsWith(q));
  if (matches.length === 0) throw new CliError(`No schedule with id ${q}`);
  if (matches.length > 1) throw new CliError(`Ambiguous id prefix ${q} (${matches.length} matches)`);
  const [match] = matches;
  schedules.remove(match.id);
  return { ok: true, kind: 'cancel', message: `Deleted schedule "${match.label}" (${match.id})` };
}

function handleList(): CliAck {
  const items = [...get(schedules)].sort(
    (a, b) => (a.nextFireAt ?? Number.MAX_SAFE_INTEGER) - (b.nextFireAt ?? Number.MAX_SAFE_INTEGER)
  );
  return {
    ok: true,
    kind: 'list',
    message: `${items.length} schedule${items.length === 1 ? '' : 's'}`,
    schedules: items.map((s) => ({
      id: s.id,
      label: s.label,
      when: describeScheduleSpec(s.when),
      nextFireAt: s.nextFireAt,
      enabled: s.enabled,
      target: targetSummary(s),
      source: s.source ?? 'app',
    })),
  };
}

async function handlePing(req: CliRequest): Promise<CliAck> {
  const version = await getVersion().catch(() => 'unknown');
  const invoking = findSession(req.sessionId);
  return {
    ok: true,
    kind: 'ping',
    message: `OpenWhisperer ${version}${dev ? ' (dev)' : ''}`,
    sessionId: invoking?.id ?? null,
  };
}

async function handle(req: CliRequest): Promise<CliAck> {
  if (req.version !== 1) {
    throw new CliError(`Unsupported request version ${req.version} — update the ow CLI or the app`);
  }
  if (req.kind !== 'schedule' && Date.now() - (req.createdAt ?? 0) > STALE_MS) {
    throw new CliError('Request expired before the app could handle it (was the app closed?)');
  }
  switch (req.kind) {
    case 'schedule':
      return handleSchedule(req);
    case 'run':
      return handleRun(req);
    case 'cancel':
      return handleCancel(req);
    case 'list':
      return handleList();
    case 'ping':
      return handlePing(req);
    default:
      throw new CliError(`Unknown request kind "${String(req.kind)}"`);
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function processRequest(entry: unknown): Promise<void> {
  const req = entry as Partial<CliRequest>;
  const id = typeof req?.id === 'string' ? req.id : null;
  if (!id) {
    console.warn('[cli-inbox] Ignoring request without id:', entry);
    return;
  }
  let ack: CliAck;
  try {
    ack = await handle(req as CliRequest);
    console.info(`[cli-inbox] ${req.kind} ${id}: ${ack.ok ? ack.message : ack.error}`);
  } catch (error) {
    const message = error instanceof CliError ? error.message : `Internal error: ${String(error)}`;
    if (!(error instanceof CliError)) console.error('[cli-inbox] Request failed:', error);
    ack = { ok: false, error: message };
  }
  try {
    await invoke('write_cli_ack', { id, ack });
  } catch (error) {
    console.error('[cli-inbox] Failed to write ack:', error);
  }
}

let polling = false;

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const raw = await invoke<unknown[]>('take_cli_requests');
    for (const entry of raw ?? []) await processRequest(entry);
  } catch (error) {
    console.error('[cli-inbox] Poll failed:', error);
  } finally {
    polling = false;
  }
}

let started = false;
let currentTeardown: (() => void) | null = null;

/**
 * Start polling the inbox. Idempotent. Call once from `(main)/+layout.svelte`
 * after `schedules.load()` — a schedule request needs the store to be loaded, or
 * the resulting persist would be refused (and a `schedule` request left in the
 * inbox is applied on the next launch anyway).
 */
export function startCliInbox(): () => void {
  if (started && currentTeardown) return currentTeardown;
  started = true;

  void poll();
  let intervalId: ReturnType<typeof setInterval> | null = null;
  if (typeof window !== 'undefined') {
    intervalId = setInterval(() => void poll(), POLL_MS);
  }

  currentTeardown = () => {
    if (!started) return;
    started = false;
    currentTeardown = null;
    if (intervalId != null) clearInterval(intervalId);
  };
  return currentTeardown;
}
