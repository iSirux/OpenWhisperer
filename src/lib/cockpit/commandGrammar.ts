/**
 * Cockpit command grammar — a pure, deterministic, side-effect-free parser that
 * turns one spoken utterance into exactly one `CockpitIntent`.
 *
 * Design rules (docs/flow-mode-brainstorm-2026-07.md §4.8):
 * - No LLM router: the screen carries the context, speech only carries the intent.
 * - Mishears die VISIBLY: anything that doesn't match the grammar becomes
 *   `{ type: 'unknown' }` — the parser NEVER guesses a near-match, and free
 *   dictation is only accepted behind an explicit verb prefix ("dispatch …").
 * - Deixis instead of classification: short verbs ("stop", "approve") resolve
 *   against the focused session; explicit targets (nickname / board number)
 *   override focus.
 *
 * The parser is pure: it receives a snapshot of the board (`CockpitContext`)
 * and returns an intent with concrete session ids already resolved. Execution
 * (and validation against live store state) happens in `intentExecutor.ts`.
 */

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

/** One addressable card on the fleet board, as the parser sees it. */
export interface CockpitSessionRef {
  id: string;
  /** Speakable callsign from `session.aiMetadata?.nickname` (e.g. "falcon"). */
  nickname?: string;
  /** Display name (fallback label; NOT used for voice matching). */
  name: string;
  /** 1-based board number, stable for the lifetime of the board ordering. */
  index: number;
  /** Raw `SdkSession['status']` value (informational). */
  status: string;
  /** Waiting on the user: plan approval, AskUserQuestion, or needs-interaction. */
  isBlocked: boolean;
  /** Finished its last turn (idle with a trailing done/stopped marker, or `done`). */
  isDone: boolean;
  /** True when the session has an open AskUserQuestion (numbered options). */
  hasQuestion?: boolean;
}

/** Snapshot of cockpit state the parser needs to resolve an utterance. */
export interface CockpitContext {
  sessions: CockpitSessionRef[];
  focusedSessionId: string | null;
  /** A dispatch draft is open — draft verbs ("go", "cancel", "add …") apply. */
  draftActive: boolean;
  /** A destructive action is awaiting verbal confirmation. */
  pendingConfirm: boolean;
}

// ---------------------------------------------------------------------------
// Intent union
// ---------------------------------------------------------------------------

/** How a focus target was expressed (for the interpretation preview). */
export type FocusVia = 'nickname' | 'number' | 'next' | 'previous' | 'blocked';

/**
 * The full discriminated union of cockpit intents.
 *
 * Session-targeted intents carry a resolved `sessionId` (explicit target in the
 * utterance, else the focused session). If no target could be resolved, the
 * parser returns `unknown` instead — it never invents a target.
 */
export type CockpitIntent =
  /**
   * Move the focus ring.
   * @example "falcon" → { type: 'focus', sessionId: <falcon>, via: 'nickname' }
   * @example "number three" / bare "three" (when 3 can only be a board number)
   * @example "next" / "previous"
   * @example "the blocked one" → first blocked session
   */
  | { type: 'focus'; sessionId: string; via: FocusVia }
  /**
   * Interrupt the running query (destructive → two-step confirm downstream).
   * @example "stop" (focused) · "stop falcon" · "stop number two"
   */
  | { type: 'stop_session'; sessionId: string }
  /**
   * Nudge a session to continue.
   * @example "keep going" (focused) · "continue" · "continue falcon"
   */
  | { type: 'continue_session'; sessionId: string }
  /**
   * Open the normal session view ("show me" hands off to the screen).
   * @example "open" (focused) · "open falcon" · "show me two"
   */
  | { type: 'open_session'; sessionId: string }
  /**
   * Approve a pending plan (or submit staged question answers).
   * @example "approve" (focused) · "approve falcon" · "approve the plan"
   */
  | { type: 'approve'; sessionId: string }
  /**
   * Reject a pending plan (destructive → two-step confirm downstream).
   * @example "reject" (focused) · "reject falcon" · "deny the plan"
   */
  | { type: 'reject'; sessionId: string }
  /**
   * Answer the focused session's open question by option number (1-based as
   * spoken; the executor maps to the 0-based option index).
   * @example "two" (focused session has an open question) · "option two"
   */
  | { type: 'answer_option'; sessionId: string; option: number }
  /**
   * Answer the focused session's open question with free text.
   * @example "answer use the staging database" · "reply yes but pin the version"
   */
  | { type: 'answer_text'; sessionId: string; text: string }
  /**
   * Start a dispatch draft from free dictation. Requires the verb prefix —
   * bare dictation NEVER becomes a dispatch.
   * @example "new task add retry logic to the whisper client"
   * @example "dispatch fix the failing docker test" · "delegate …"
   */
  | { type: 'dispatch'; text: string }
  /**
   * Send free text to a specific session.
   * @example "tell falcon also add tests"
   * @example "falcon, also add tests" (nickname-prefix form)
   */
  | { type: 'tell'; sessionId: string; text: string }
  /**
   * Park a transcript-only note in the pile.
   * @example "note remember to bump the sdk version" · "pile this docker idea"
   */
  | { type: 'pile_note'; text: string }
  /**
   * Fleet status briefing (rendered by the UI from the `fleetBriefing` store).
   * @example "status" · "what's the status" · "fleet status"
   */
  | { type: 'status' }
  /**
   * Blockers-first briefing.
   * @example "what needs me" · "any blockers" · "who needs me"
   */
  | { type: 'what_needs_me' }
  /**
   * Hide finished cards from the board (destructive-ish → two-step confirm).
   * @example "dismiss the done ones" · "clear done"
   */
  | { type: 'dismiss_done' }
  /**
   * Launch the open dispatch draft. Only parsed while `ctx.draftActive`.
   * @example "go" · "launch it" · "send it"
   */
  | { type: 'draft_go' }
  /**
   * Discard the open dispatch draft. Only parsed while `ctx.draftActive`.
   * @example "cancel" · "never mind" · "scrap it"
   */
  | { type: 'draft_cancel' }
  /**
   * Change the draft's model by family name. Only while `ctx.draftActive`.
   * @example "make it opus" · "use haiku" · "switch to sonnet"
   */
  | { type: 'draft_set_model'; model: 'opus' | 'sonnet' | 'haiku' | 'fable' }
  /**
   * Change the draft's repository by name. Only while `ctx.draftActive`.
   * @example "repo claude whisperer" · "change repo to funnelfeedr"
   */
  | { type: 'draft_set_repo'; name: string }
  /**
   * Append dictation to the draft transcript. Only while `ctx.draftActive`.
   * @example "add and write tests for it" · "also make sure CI stays green"
   */
  | { type: 'draft_append'; text: string }
  /**
   * Confirm the pending destructive action. Only while `ctx.pendingConfirm`.
   * @example "yes" · "confirm" · "do it"
   */
  | { type: 'confirm_yes' }
  /**
   * Abort the pending destructive action. Only while `ctx.pendingConfirm`.
   * @example "no" · "cancel" · "never mind"
   */
  | { type: 'confirm_no' }
  /**
   * A nickname matched MORE THAN ONE session (dupes can happen: concurrent
   * name generation races, or sessions restored from before the exclusion
   * list). Never silently pick one — surface the candidates so the user can
   * say the board number instead.
   * @example "falcon" (two Falcons) → { type: 'ambiguous', nickname: 'Falcon', candidates: [#2, #5] }
   */
  | { type: 'ambiguous'; text: string; nickname: string; candidates: Array<{ sessionId: string; index: number }> }
  /**
   * The visible-failure fallback. Anything unmatched lands here — including
   * bare dictation without a dispatch verb and commands whose explicit target
   * doesn't resolve.
   * @example "hmm let me think about that" → { type: 'unknown', text: … }
   */
  | { type: 'unknown'; text: string };

// ---------------------------------------------------------------------------
// Normalization (mirrors voiceCommands.ts conventions)
// ---------------------------------------------------------------------------

/**
 * Normalize an utterance for matching: lowercase, strip punctuation to spaces,
 * collapse whitespace. Number WORDS are intentionally NOT rewritten globally
 * (that would corrupt phrases like "the blocked one"); use `wordToNumber` on
 * individual tokens where a number is expected.
 */
export function normalizeUtterance(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** Parse a single token as a number ("three" or "3"); null when it isn't one. */
export function wordToNumber(token: string): number | null {
  if (token in NUMBER_WORDS) return NUMBER_WORDS[token];
  if (/^\d+$/.test(token)) return parseInt(token, 10);
  return null;
}

// ---------------------------------------------------------------------------
// Target resolution helpers (pure)
// ---------------------------------------------------------------------------

function normalizeNickname(nick: string): string {
  return normalizeUtterance(nick);
}

/**
 * Match a nickname at the start of a token list. Nicknames may be multi-word;
 * matching is whole-token and case-insensitive. Returns ALL sessions whose
 * nickname matches at the longest consumed length (duplicates are possible —
 * callers must surface `ambiguous` for >1, never pick silently), or null.
 */
function matchNicknamePrefix(
  tokens: string[],
  sessions: CockpitSessionRef[]
): { sessions: CockpitSessionRef[]; consumed: number } | null {
  let bestConsumed = 0;
  let matches: CockpitSessionRef[] = [];
  for (const session of sessions) {
    if (!session.nickname) continue;
    const nickTokens = normalizeNickname(session.nickname).split(' ').filter(Boolean);
    if (nickTokens.length === 0 || nickTokens.length > tokens.length) continue;
    if (!nickTokens.every((t, i) => tokens[i] === t)) continue;
    if (nickTokens.length > bestConsumed) {
      bestConsumed = nickTokens.length;
      matches = [session];
    } else if (nickTokens.length === bestConsumed) {
      matches.push(session);
    }
  }
  return bestConsumed > 0 ? { sessions: matches, consumed: bestConsumed } : null;
}

/** Build the `ambiguous` intent for a duplicated nickname. */
function ambiguousIntent(text: string, candidates: CockpitSessionRef[]): CockpitIntent {
  return {
    type: 'ambiguous',
    text,
    nickname: candidates[0]?.nickname ?? '',
    candidates: candidates.map((s) => ({ sessionId: s.id, index: s.index })),
  };
}

/** Find a session by 1-based board number. */
function sessionByNumber(n: number, sessions: CockpitSessionRef[]): CockpitSessionRef | null {
  return sessions.find((s) => s.index === n) ?? null;
}

/**
 * Result of resolving a target expression: a single session, an ambiguous
 * nickname (caller must surface `ambiguous`), or no match (caller surfaces
 * `unknown` — never a guess).
 */
interface TargetResult {
  session: CockpitSessionRef | null;
  ambiguous?: CockpitSessionRef[];
}

/**
 * Resolve an explicit target expression (the full remainder of a command).
 * Accepts: a nickname, "number N", "session N", bare N, or filler-prefixed
 * variants ("the blocked one").
 */
function resolveExplicitTarget(
  tokens: string[],
  ctx: CockpitContext
): TargetResult {
  if (tokens.length === 0) return { session: null };

  // "the blocked one" / "blocked one" / "the blocked session"
  const joined = tokens.join(' ');
  if (/^(the )?blocked (one|session)$/.test(joined)) {
    return { session: ctx.sessions.find((s) => s.isBlocked) ?? null };
  }

  // Nickname (must consume ALL tokens — partial trailing junk is a mismatch)
  const nick = matchNicknamePrefix(tokens, ctx.sessions);
  if (nick && nick.consumed === tokens.length) {
    if (nick.sessions.length > 1) return { session: null, ambiguous: nick.sessions };
    return { session: nick.sessions[0] };
  }

  // "number N" / "session N"
  if (tokens.length === 2 && (tokens[0] === 'number' || tokens[0] === 'session')) {
    const n = wordToNumber(tokens[1]);
    if (n !== null) return { session: sessionByNumber(n, ctx.sessions) };
    return { session: null };
  }

  // Bare N
  if (tokens.length === 1) {
    const n = wordToNumber(tokens[0]);
    if (n !== null) return { session: sessionByNumber(n, ctx.sessions) };
  }

  return { session: null };
}

/** The focused session ref, if any. */
function focusedSession(ctx: CockpitContext): CockpitSessionRef | null {
  if (!ctx.focusedSessionId) return null;
  return ctx.sessions.find((s) => s.id === ctx.focusedSessionId) ?? null;
}

/**
 * Resolve the target for a verb command: explicit remainder if present
 * (must resolve or the whole utterance is `unknown`), else the focused session.
 * Returns `{ session: null }` for "explicit target given but unresolvable".
 */
function resolveVerbTarget(
  remainderTokens: string[],
  ctx: CockpitContext
): TargetResult & { explicitGiven: boolean } {
  // Strip leading articles/fillers commonly produced by ASR
  const tokens = [...remainderTokens];
  while (tokens.length > 0 && (tokens[0] === 'the' || tokens[0] === 'it' || tokens[0] === 'that')) {
    // "it"/"that"/"the plan" style fillers mean "the focused one"
    if (tokens.length === 1 || (tokens[0] === 'the' && ['plan', 'session', 'query', 'one'].includes(tokens[1] ?? ''))) {
      return { session: focusedSession(ctx), explicitGiven: false };
    }
    break;
  }

  if (tokens.length === 0) {
    return { session: focusedSession(ctx), explicitGiven: false };
  }
  return { ...resolveExplicitTarget(tokens, ctx), explicitGiven: true };
}

// ---------------------------------------------------------------------------
// Phrase tables (exact-match after normalization; longest-first not needed
// because matching is whole-utterance or anchored-prefix)
// ---------------------------------------------------------------------------

const CONFIRM_YES = new Set(['yes', 'confirm', 'do it', 'yeah', 'yep', 'go ahead', 'confirmed']);
const CONFIRM_NO = new Set(['no', 'cancel', 'nope', 'never mind', 'nevermind', 'abort', 'cancel that']);

const DRAFT_GO = new Set(['go', 'launch it', 'launch', 'send it', 'ship it', 'start it', 'go go']);
const DRAFT_CANCEL = new Set(['cancel', 'cancel it', 'cancel that', 'never mind', 'nevermind', 'scrap it', 'discard']);

const STATUS_PHRASES = new Set(['status', 'whats the status', 'what s the status', 'status report', 'fleet status', 'give me the status']);
const NEEDS_ME_PHRASES = new Set(['what needs me', 'any blockers', 'what needs my attention', 'who needs me', 'anything blocked', 'blockers']);
const DISMISS_DONE_PHRASES = new Set(['dismiss the done ones', 'clear done', 'dismiss done', 'clear the done ones', 'dismiss the finished ones', 'clear finished']);

const NEXT_PHRASES = new Set(['next', 'the next one', 'go next', 'next one', 'next session']);
const PREV_PHRASES = new Set(['previous', 'the previous one', 'previous one', 'go back', 'back', 'previous session']);
const BLOCKED_PHRASES = new Set(['the blocked one', 'blocked one', 'the blocked session', 'go to the blocked one']);

const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const;
type ModelFamily = (typeof MODEL_FAMILIES)[number];

// Verb → intent kind for targeted commands. Order matters only for prefix scan.
const TARGET_VERBS: Array<{ prefix: string; kind: 'stop_session' | 'continue_session' | 'open_session' | 'approve' | 'reject' }> = [
  { prefix: 'stop', kind: 'stop_session' },
  { prefix: 'keep going', kind: 'continue_session' },
  { prefix: 'continue', kind: 'continue_session' },
  { prefix: 'show me', kind: 'open_session' },
  { prefix: 'open', kind: 'open_session' },
  { prefix: 'approve', kind: 'approve' },
  { prefix: 'reject', kind: 'reject' },
  { prefix: 'deny', kind: 'reject' },
];

const DISPATCH_PREFIXES = ['new task', 'dispatch', 'delegate'];
const PILE_PREFIXES = ['pile this', 'note'];
const ANSWER_TEXT_PREFIXES = ['answer', 'reply with', 'reply'];

/** If `text` starts with `prefix` on a word boundary, return the remainder. */
function stripPrefix(text: string, prefix: string): string | null {
  if (text === prefix) return '';
  if (text.startsWith(prefix + ' ')) return text.slice(prefix.length + 1);
  return null;
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

/**
 * Parse one utterance into a `CockpitIntent`.
 *
 * Precedence (first match wins):
 *  1. Confirm yes/no — only while `ctx.pendingConfirm`, only exact phrases.
 *  2. Draft verbs (go / cancel / set model / set repo / append) — only while
 *     `ctx.draftActive`.
 *  3. Explicit-target verb commands (stop / continue / open / approve / reject).
 *  4. Fleet commands (status / what-needs-me / dismiss-done).
 *  5. Answer flows ("option N", "answer …") and bare option numbers — only
 *     when the focused session has an open question.
 *  6. Bare focus: nickname / "number N" / bare N / next / previous / blocked.
 *  7. Tell: "tell <target> …" and "<nickname> …" prefix.
 *  8. Dispatch / pile-note (verb-prefixed dictation).
 *  9. `unknown` — everything else, including bare dictation.
 */
export function parseUtterance(raw: string, ctx: CockpitContext): CockpitIntent {
  const text = normalizeUtterance(raw);
  if (!text) return { type: 'unknown', text: raw.trim() };
  const tokens = text.split(' ');
  const focused = focusedSession(ctx);

  // --- 1. Confirm flow (exact phrases only; anything else falls through) ---
  if (ctx.pendingConfirm) {
    if (CONFIRM_YES.has(text)) return { type: 'confirm_yes' };
    if (CONFIRM_NO.has(text)) return { type: 'confirm_no' };
  }

  // --- 2. Draft verbs ---
  if (ctx.draftActive) {
    if (DRAFT_GO.has(text)) return { type: 'draft_go' };
    if (DRAFT_CANCEL.has(text)) return { type: 'draft_cancel' };

    // "make it opus" / "use haiku" / "switch to sonnet" / "set model to fable"
    const modelMatch = text.match(/^(?:make it|use|switch to|set model to|model)\s+(\w+)$/);
    if (modelMatch && (MODEL_FAMILIES as readonly string[]).includes(modelMatch[1])) {
      return { type: 'draft_set_model', model: modelMatch[1] as ModelFamily };
    }

    // "repo <name>" / "change repo to <name>" / "set repo to <name>"
    const repoMatch = text.match(/^(?:change repo to|set repo to|switch repo to|repo)\s+(.+)$/);
    if (repoMatch) {
      return { type: 'draft_set_repo', name: repoMatch[1] };
    }

    // "add <text>" / "append <text>" / "also <text>"
    for (const prefix of ['add', 'append', 'also']) {
      const rest = stripPrefix(text, prefix);
      if (rest !== null && rest.length > 0) {
        return { type: 'draft_append', text: rest };
      }
    }
  }

  // --- 3. Explicit-target verb commands ---
  for (const { prefix, kind } of TARGET_VERBS) {
    const rest = stripPrefix(text, prefix);
    if (rest === null) continue;
    const restTokens = rest === '' ? [] : rest.split(' ');
    const resolved = resolveVerbTarget(restTokens, ctx);
    if (resolved.ambiguous) return ambiguousIntent(text, resolved.ambiguous);
    if (!resolved.session) {
      // Explicit target given but unresolvable, or bare verb with no focus:
      // visible failure, never a guess.
      return { type: 'unknown', text };
    }
    return { type: kind, sessionId: resolved.session.id } as CockpitIntent;
  }

  // --- 4. Fleet commands ---
  if (STATUS_PHRASES.has(text)) return { type: 'status' };
  if (NEEDS_ME_PHRASES.has(text)) return { type: 'what_needs_me' };
  if (DISMISS_DONE_PHRASES.has(text)) return { type: 'dismiss_done' };

  // --- 5. Answer flows (focused session with an open question) ---
  const focusedHasQuestion = !!(focused && (focused.hasQuestion ?? focused.isBlocked));

  // "option N" is always an answer attempt (fails visibly without a question)
  const optionMatch = text.match(/^option\s+(\S+)$/);
  if (optionMatch) {
    const n = wordToNumber(optionMatch[1]);
    if (n !== null && focused && focusedHasQuestion) {
      return { type: 'answer_option', sessionId: focused.id, option: n };
    }
    return { type: 'unknown', text };
  }

  // "answer <text>" / "reply <text>"
  for (const prefix of ANSWER_TEXT_PREFIXES) {
    const rest = stripPrefix(text, prefix);
    if (rest !== null && rest.length > 0) {
      if (focused && focusedHasQuestion) {
        return { type: 'answer_text', sessionId: focused.id, text: rest };
      }
      return { type: 'unknown', text };
    }
  }

  // Bare number: answer option when the focused session has an open question,
  // else a board-number focus when it can only be that.
  if (tokens.length === 1) {
    const n = wordToNumber(tokens[0]);
    if (n !== null) {
      if (focused && focusedHasQuestion) {
        return { type: 'answer_option', sessionId: focused.id, option: n };
      }
      const target = sessionByNumber(n, ctx.sessions);
      if (target) return { type: 'focus', sessionId: target.id, via: 'number' };
      return { type: 'unknown', text };
    }
  }

  // --- 6. Bare focus ---
  if (NEXT_PHRASES.has(text) || PREV_PHRASES.has(text)) {
    const ordered = [...ctx.sessions].sort((a, b) => a.index - b.index);
    if (ordered.length === 0) return { type: 'unknown', text };
    const dir = NEXT_PHRASES.has(text) ? 1 : -1;
    const currentIdx = focused ? ordered.findIndex((s) => s.id === focused.id) : -1;
    const nextIdx =
      currentIdx === -1
        ? dir === 1 ? 0 : ordered.length - 1
        : (currentIdx + dir + ordered.length) % ordered.length;
    return {
      type: 'focus',
      sessionId: ordered[nextIdx].id,
      via: dir === 1 ? 'next' : 'previous',
    };
  }

  if (BLOCKED_PHRASES.has(text)) {
    const blocked = ctx.sessions.find((s) => s.isBlocked);
    if (blocked) return { type: 'focus', sessionId: blocked.id, via: 'blocked' };
    return { type: 'unknown', text };
  }

  // "number N" focus
  const numberMatch = text.match(/^(?:number|session)\s+(\S+)$/);
  if (numberMatch) {
    const n = wordToNumber(numberMatch[1]);
    const target = n !== null ? sessionByNumber(n, ctx.sessions) : null;
    if (target) return { type: 'focus', sessionId: target.id, via: 'number' };
    return { type: 'unknown', text };
  }

  // Bare nickname → focus. Nickname + trailing text → tell (handled below).
  const nickPrefix = matchNicknamePrefix(tokens, ctx.sessions);
  if (nickPrefix && nickPrefix.consumed === tokens.length) {
    if (nickPrefix.sessions.length > 1) return ambiguousIntent(text, nickPrefix.sessions);
    return { type: 'focus', sessionId: nickPrefix.sessions[0].id, via: 'nickname' };
  }

  // --- 7. Tell ---
  {
    const rest = stripPrefix(text, 'tell');
    if (rest !== null && rest.length > 0) {
      const restTokens = rest.split(' ');
      const target = matchNicknamePrefix(restTokens, ctx.sessions);
      let session: CockpitSessionRef | null = null;
      let consumed = 0;
      if (target) {
        if (target.sessions.length > 1) return ambiguousIntent(text, target.sessions);
        session = target.sessions[0];
        consumed = target.consumed;
      } else {
        // "tell number two …" / "tell two …"
        const head = restTokens[0] === 'number' || restTokens[0] === 'session' ? restTokens[1] : restTokens[0];
        const skip = restTokens[0] === 'number' || restTokens[0] === 'session' ? 2 : 1;
        const n = head !== undefined ? wordToNumber(head) : null;
        if (n !== null) {
          session = sessionByNumber(n, ctx.sessions);
          consumed = skip;
        }
      }
      const message = restTokens.slice(consumed).join(' ').replace(/^to\s+/, '');
      if (session && message.length > 0) {
        return { type: 'tell', sessionId: session.id, text: message };
      }
      return { type: 'unknown', text };
    }
  }

  // "<nickname> <text>" prefix form ("falcon, also add tests"). If the trailing
  // text is exactly a bare command verb, treat it as that command targeted at
  // the nickname ("falcon stop" ≡ "stop falcon").
  if (nickPrefix && nickPrefix.consumed < tokens.length) {
    if (nickPrefix.sessions.length > 1) return ambiguousIntent(text, nickPrefix.sessions);
    const restText = tokens.slice(nickPrefix.consumed).join(' ');
    const verb = TARGET_VERBS.find((v) => v.prefix === restText);
    if (verb) {
      return { type: verb.kind, sessionId: nickPrefix.sessions[0].id } as CockpitIntent;
    }
    return { type: 'tell', sessionId: nickPrefix.sessions[0].id, text: restText };
  }

  // --- 8. Dispatch / pile note (verb-prefixed dictation only) ---
  for (const prefix of DISPATCH_PREFIXES) {
    const rest = stripPrefix(text, prefix);
    if (rest !== null && rest.length > 0) {
      // Preserve the RAW casing/punctuation of the dictated tail when possible:
      // dictation goes to an agent, so don't send the flattened version.
      const rawTail = extractRawTail(raw, rest);
      return { type: 'dispatch', text: rawTail ?? rest };
    }
  }
  for (const prefix of PILE_PREFIXES) {
    const rest = stripPrefix(text, prefix);
    if (rest !== null && rest.length > 0) {
      const rawTail = extractRawTail(raw, rest);
      return { type: 'pile_note', text: rawTail ?? rest };
    }
  }

  // --- 9. Visible failure ---
  return { type: 'unknown', text };
}

/**
 * Best-effort recovery of the original (punctuated, cased) tail of `raw` that
 * corresponds to the normalized remainder `normalizedRest`. Falls back to null
 * when the alignment is ambiguous.
 */
function extractRawTail(raw: string, normalizedRest: string): string | null {
  const restWords = normalizedRest.split(' ');
  if (restWords.length === 0) return null;
  const firstWord = restWords[0];
  const idx = raw.toLowerCase().search(new RegExp(`\\b${firstWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
  if (idx === -1) return null;
  const tail = raw.slice(idx).trim();
  return tail.length > 0 ? tail : null;
}

/**
 * Human-readable label for an intent, for the interpretation preview and the
 * utterance ledger ("→ Falcon: follow-up" style).
 */
export function describeIntent(intent: CockpitIntent, ctx: CockpitContext): string {
  const label = (id: string): string => {
    const s = ctx.sessions.find((x) => x.id === id);
    if (!s) return id;
    return s.nickname ? s.nickname : `#${s.index} ${s.name}`;
  };
  switch (intent.type) {
    case 'focus': return `focus → ${label(intent.sessionId)} (${intent.via})`;
    case 'stop_session': return `stop → ${label(intent.sessionId)}`;
    case 'continue_session': return `continue → ${label(intent.sessionId)}`;
    case 'open_session': return `open → ${label(intent.sessionId)}`;
    case 'approve': return `approve → ${label(intent.sessionId)}`;
    case 'reject': return `reject → ${label(intent.sessionId)}`;
    case 'answer_option': return `answer option ${intent.option} → ${label(intent.sessionId)}`;
    case 'answer_text': return `answer → ${label(intent.sessionId)}: "${intent.text}"`;
    case 'dispatch': return `new task: "${truncate(intent.text)}"`;
    case 'tell': return `tell ${label(intent.sessionId)}: "${truncate(intent.text)}"`;
    case 'pile_note': return `pile note: "${truncate(intent.text)}"`;
    case 'status': return 'fleet status';
    case 'what_needs_me': return 'what needs me';
    case 'dismiss_done': return 'dismiss done sessions';
    case 'draft_go': return 'launch draft';
    case 'draft_cancel': return 'cancel draft';
    case 'draft_set_model': return `draft model → ${intent.model}`;
    case 'draft_set_repo': return `draft repo → ${intent.name}`;
    case 'draft_append': return `draft append: "${truncate(intent.text)}"`;
    case 'confirm_yes': return 'confirm';
    case 'confirm_no': return 'abort';
    case 'ambiguous': {
      const nums = intent.candidates.map((c) => `#${c.index}`).join(' and ');
      return `"${intent.nickname}" matches ${nums} — say the number`;
    }
    case 'unknown': return 'didn’t catch that';
  }
}

function truncate(text: string, max = 48): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
