// Run: npx tsx --test src/lib/utils/restartResume.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SdkSession } from '$lib/stores/sdkSessions';
import { RESTART_RESUME_PROMPT, awaitingRestartResume, withRestartResume } from './restartResume';

function session(overrides: Partial<SdkSession> = {}): SdkSession {
  return {
    id: 's1',
    provider: 'claude',
    status: 'idle',
    messages: [
      { type: 'user', content: 'do the thing', timestamp: 1_000 },
      { type: 'text', content: 'working…', timestamp: 1_100 },
    ],
    ...overrides,
  } as SdkSession;
}

test('parks a resume turn ahead of the message queued behind the cut-off turn', () => {
  const queuedBehind = {
    id: 'pt_user', reason: 'after_sessions' as const, scope: 'session' as const,
    provider: 'claude' as const, prompt: 'next thing', queuedAt: 1_050,
  };
  const s = session({
    parkedTurns: [queuedBehind],
    messages: [
      ...session().messages,
      { type: 'user', content: 'next thing', queued: 'session_idle', queuedTurnId: 'pt_user', timestamp: 1_050 },
    ],
  });
  const next = withRestartResume(s, 'pt_resume', 5_000);
  assert.ok(next);
  assert.equal(next.parkedTurns![0].id, 'pt_resume');
  assert.equal(next.parkedTurns![0].restartResume, true);
  assert.equal(next.parkedTurns![0].scope, 'session');
  assert.equal(next.parkedTurns![1], queuedBehind);
  // Oldest in FIFO order, even though the queued message predates the last user turn's end.
  assert.ok(next.parkedTurns![0].queuedAt < queuedBehind.queuedAt);
  const ghost = next.messages[next.messages.length - 1];
  assert.deepEqual(ghost, {
    type: 'user', content: RESTART_RESUME_PROMPT, queued: 'session_idle', queuedTurnId: 'pt_resume', timestamp: 5_000,
  });
  assert.ok(awaitingRestartResume(next));
});

test('nothing to resume without a sent user turn', () => {
  assert.equal(withRestartResume(session({ messages: [] }), 'pt', 5_000), null);
});

test('a turn waiting on the user is not resumed', () => {
  const asking = session({
    askUserQuestion: { questions: [{ question: 'q?', header: 'Q', options: [], multiSelect: false }], answers: [], currentQuestionIndex: 0 },
  } as Partial<SdkSession>);
  assert.equal(withRestartResume(asking, 'pt', 5_000), null);
  const planning = session({ pendingPlanApproval: { allowedPrompts: [] } } as Partial<SdkSession>);
  assert.equal(withRestartResume(planning, 'pt', 5_000), null);
});

test('only one resume is ever parked', () => {
  const once = withRestartResume(session(), 'pt_a', 5_000)!;
  assert.equal(withRestartResume(once, 'pt_b', 6_000), null);
});
