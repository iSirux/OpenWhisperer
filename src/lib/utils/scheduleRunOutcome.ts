/**
 * Outcome of a scheduled run's first turn — pure helpers, no store access (so they
 * can be unit-tested under `tsx --test`).
 *
 * A schedule used to record `status: 'ok'` the moment its session launched, but the
 * agent turn itself can still fail. Real failures seen in the wild:
 *
 * - Claude Code reports API/auth failures as the turn's final ASSISTANT TEXT followed
 *   by a normal `done`, with the session settling to `idle` — e.g.
 *   "Failed to authenticate: OAuth session expired and could not be refreshed" or
 *   "API Error: 529 Overloaded. This is a server-side issue, usually temporary — …".
 *   The 529 one arrived mid-turn, after many tool calls.
 * - Everything the sidecar reports as `sdk-error` lands as a `type: 'error'` message
 *   and settles the session to `error` (process exits, SDK error results, …).
 *
 * `evaluateScheduledTurn` looks at a session from the index where the scheduled turn
 * began and says whether that turn is still running, finished cleanly, got parked by
 * the Smart Queue, or failed (with a classified reason).
 */

import type { SdkMessage } from '$lib/stores/sdkSessions';

export type RunErrorKind = 'auth' | 'transient' | 'usage_limit' | 'other';

export interface RunErrorClass {
  kind: RunErrorKind;
  /** Short human reason for the run history, e.g. "Login expired (OAuth)". */
  note: string;
  /** Worth one automatic retry a few minutes later (overload, 5xx, network blips). */
  retryable: boolean;
}

/**
 * Prefixes Claude Code / Codex use when they surface an API or auth failure as plain
 * assistant text. A final assistant message is only treated as an error when it
 * STARTS with one of these — a real report that merely mentions "API Error" or
 * "overloaded" somewhere must never be flagged.
 */
const ERROR_TEXT_PREFIXES = [
  /^api error\b/i,
  /^failed to authenticate\b/i,
  /^invalid api key\b/i,
  /^oauth token (has )?expired\b/i,
  /^please run \/login\b/i,
  /^credit balance is too low\b/i,
  /^claude ai usage limit reached\b/i,
  /^you'?ve hit your (usage )?limit\b/i,
  /^request timed out\b/i,
  /^connection error\b/i,
];

/** Real error strings are one or two lines; anything longer is a genuine reply. */
const MAX_ERROR_TEXT_LENGTH = 600;

/** Does this final assistant text look like an SDK-surfaced API/auth error? */
export function isErrorLikeAssistantText(text: string | undefined | null): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_ERROR_TEXT_LENGTH) return false;
  return ERROR_TEXT_PREFIXES.some((re) => re.test(trimmed));
}

/** First line of `text`, whitespace-collapsed and capped (fallback note). */
function shortLine(text: string, max = 80): string {
  const line = (text.split(/\r?\n/).find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return 'Unknown error';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * HTTP status code mentioned in an error, only where it is unambiguously a status
 * ("API Error: 529", "status 503", "HTTP 502", Codex's "unexpected status 401") — a
 * bare number elsewhere in an error (a path, an exit code) must not be read as one.
 */
function statusCode(text: string): number | null {
  const m =
    /\b(?:api error|status(?: code)?|http)\s*:?\s*(\d{3})\b/i.exec(text) ??
    /^\s*(\d{3})\b/.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * Classify an error string. Always returns a class: callers decide beforehand
 * whether the text IS an error (an `error` message always is; assistant text only
 * when `isErrorLikeAssistantText`).
 */
export function classifyRunError(text: string): RunErrorClass {
  const raw = text ?? '';
  const lower = raw.toLowerCase();
  const code = statusCode(raw);

  // Auth — retrying would fail the same way; the user has to log in again.
  if (
    code === 401 ||
    /failed to authenticate|invalid api key|please run \/login|unauthori[sz]ed|authentication_error|not logged in|could not be refreshed|refresh token|(oauth|access) (token|session)[^.\n]{0,40}(expired|revoked|invalid)/.test(
      lower
    )
  ) {
    let note = 'Authentication failed';
    if (/oauth|refresh/.test(lower)) note = 'Login expired (OAuth)';
    else if (/invalid api key/.test(lower)) note = 'Invalid API key';
    return { kind: 'auth', note, retryable: false };
  }
  if (code === 403 || /permission_error|forbidden/.test(lower)) {
    return { kind: 'auth', note: 'Access denied (403)', retryable: false };
  }

  // Usage / billing limits — a retry minutes later won't help (the Smart Queue
  // handles real usage-window rejections on its own rail).
  if (/credit balance is too low|insufficient[_ ]quota|billing/.test(lower)) {
    return { kind: 'usage_limit', note: 'Credit balance too low', retryable: false };
  }
  if (/usage limit|hit your (usage )?limit|quota exceeded/.test(lower)) {
    return { kind: 'usage_limit', note: 'Usage limit reached', retryable: false };
  }

  // Transient — worth one retry.
  if (code === 529 || /overloaded/.test(lower)) {
    return { kind: 'transient', note: 'API overloaded (529)', retryable: true };
  }
  if (code === 429 || /rate_limit_error|too many requests/.test(lower)) {
    return { kind: 'transient', note: 'API rate limited (429)', retryable: true };
  }
  if ((code != null && code >= 500 && code <= 599) ||
      /internal server error|bad gateway|service unavailable|gateway timeout|\bapi_error\b|\bserver_error\b/.test(lower)) {
    return {
      kind: 'transient',
      note: code != null && code >= 500 ? `API server error (${code})` : 'API server error',
      retryable: true,
    };
  }
  if (
    /econnreset|etimedout|econnrefused|enotfound|eai_again|socket hang up|fetch failed|network error|connection error|request timed out|stream disconnected|connection (was )?(reset|closed)/.test(
      lower
    )
  ) {
    return { kind: 'transient', note: 'Network error', retryable: true };
  }

  const exit = /exited with code (-?\d+)/i.exec(raw);
  if (exit) return { kind: 'other', note: `Agent process exited (code ${exit[1]})`, retryable: false };

  return { kind: 'other', note: shortLine(raw), retryable: false };
}

// ---------------------------------------------------------------------------
// Turn evaluation
// ---------------------------------------------------------------------------

/** The slice of an `SdkSession` the evaluator reads. */
export interface TurnSessionView {
  status: string;
  messages: SdkMessage[];
  parkedTurns?: Array<{ reason?: string }> | null;
}

export type ScheduledTurnOutcome =
  | { state: 'pending' }
  | { state: 'ok' }
  | { state: 'stopped' }
  /** Parked by the Smart Queue (usage window exhausted) — it re-sends at reset. */
  | { state: 'deferred'; note: string }
  | { state: 'failed'; error: RunErrorClass; detail: string };

const TERMINAL_TYPES = new Set<SdkMessage['type']>(['done', 'stopped', 'error']);

/**
 * Where does the scheduled turn that began at `base` (the session's message count
 * just before the turn was sent; 0 for a freshly launched session) stand?
 *
 * The turn is the first `user` message at/after `base`; it settles at the first
 * `done` / `stopped` / `error` message after it. Tolerates anything appended in
 * between (notifications, worktree setup messages, context-overflow auto-recovery,
 * which settles with the final `done` of the resent prompt).
 */
export function evaluateScheduledTurn(session: TurnSessionView, base: number): ScheduledTurnOutcome {
  const messages = session.messages ?? [];
  const start = Math.max(0, Math.min(base, messages.length));

  let userIdx = -1;
  for (let i = start; i < messages.length; i++) {
    if (messages[i].type === 'user' && !messages[i].queued) {
      userIdx = i;
      break;
    }
  }

  if (userIdx === -1) {
    // The session failed before the prompt ever went out (backend registration,
    // sidecar start, …): `startSetupSession` swallows that into an error message.
    if (session.status === 'error') {
      const err = [...messages.slice(start)].reverse().find((m) => m.type === 'error');
      const detail = err?.content || 'Session failed to start';
      return { state: 'failed', error: classifyRunError(detail), detail };
    }
    return { state: 'pending' };
  }

  let terminalIdx = -1;
  for (let i = userIdx + 1; i < messages.length; i++) {
    if (TERMINAL_TYPES.has(messages[i].type)) {
      terminalIdx = i;
      break;
    }
  }

  if (terminalIdx === -1) {
    // Rate-limit parks settle the session to idle WITHOUT a terminal message (both the
    // send-time gate and a mid-run rejection) — the Smart Queue owns it from here.
    const notBusy = session.status !== 'querying' && session.status !== 'initializing';
    if (notBusy && (session.parkedTurns ?? []).some((t) => t?.reason === 'rate_limit')) {
      return { state: 'deferred', note: 'Rate limited — the Smart Queue re-sends it at reset' };
    }
    return { state: 'pending' };
  }

  const terminal = messages[terminalIdx];
  if (terminal.type === 'stopped') return { state: 'stopped' };
  if (terminal.type === 'error') {
    const detail = terminal.content || 'Agent error';
    return { state: 'failed', error: classifyRunError(detail), detail };
  }

  // `done`: the turn's final main-agent text is where Claude Code puts API/auth errors.
  for (let i = terminalIdx - 1; i > userIdx; i--) {
    const m = messages[i];
    if (m.type !== 'text' || m.parentToolUseId) continue;
    if (isErrorLikeAssistantText(m.content)) {
      const detail = (m.content ?? '').trim();
      return { state: 'failed', error: classifyRunError(detail), detail };
    }
    break;
  }
  return { state: 'ok' };
}
