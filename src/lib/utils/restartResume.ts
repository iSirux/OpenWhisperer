// Type-only imports (erased at build; sdkSessions value-imports this module).
import type { RateLimitedState, SdkMessage, SdkSession } from '$lib/stores/sdkSessions';

/** Sent to a session whose turn was cut off because the app closed or crashed. */
export const RESTART_RESUME_PROMPT =
  'OpenWhisperer was closed while you were working on this, so your previous turn was cut off partway ' +
  '(any commands, background tasks and subagents it had running were stopped). Check the conversation and ' +
  'the current state of the work, then carry on from where you stopped without repeating completed steps. ' +
  "If you hadn't started on my last message yet, handle it now.";

/** Is this session waiting to resume the turn an app shutdown cut off? */
export function awaitingRestartResume(session: { parkedTurns?: RateLimitedState[] | null }): boolean {
  return (session.parkedTurns ?? []).some(t => t.restartResume);
}

/**
 * A session was mid-turn when the app went away. Park a "carry on" turn at the FRONT
 * of its queue, with a ghost bubble, so it resumes as soon as the Smart Queue starts —
 * and anything the user had queued behind the running turn ("send when idle") keeps
 * waiting until the resumed turn finishes, instead of firing at an idle-looking session.
 *
 * Returns null when there's nothing to resume: no user turn yet, already parked, or
 * the turn was waiting on the user (a question or plan approval) rather than working.
 */
export function withRestartResume(session: SdkSession, turnId: string, now: number): SdkSession | null {
  if (awaitingRestartResume(session)) return null;
  if (session.askUserQuestion?.questions?.length || session.pendingPlanApproval) return null;
  const lastUser = session.messages.findLast(m => m.type === 'user' && !m.queued);
  if (!lastUser) return null;

  const parked = session.parkedTurns ?? [];
  // Oldest in the queue: the Smart Queue drains FIFO by queuedAt, one turn per session
  // per pass, so this goes before every turn queued while the cut-off turn was running.
  const queuedAt = Math.min(lastUser.timestamp, ...parked.map(t => t.queuedAt)) - 1;
  const turn: RateLimitedState = {
    id: turnId,
    reason: 'after_sessions',
    scope: 'session',
    provider: session.provider ?? 'claude',
    prompt: RESTART_RESUME_PROMPT,
    restartResume: true,
    queuedAt,
  };
  const ghost: SdkMessage = {
    type: 'user',
    content: RESTART_RESUME_PROMPT,
    queued: 'session_idle',
    queuedTurnId: turnId,
    timestamp: now,
  };
  return {
    ...session,
    parkedTurns: [turn, ...parked],
    messages: [...session.messages, ghost],
  };
}
