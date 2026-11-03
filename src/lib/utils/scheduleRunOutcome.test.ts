// Run: npx tsx --test src/lib/utils/scheduleRunOutcome.test.ts
//
// Fixtures are the exact strings found in real scheduled sessions whose first turn
// failed but was recorded as "ok".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SdkMessage } from '$lib/stores/sdkSessions';
import {
  classifyRunError,
  evaluateScheduledTurn,
  isErrorLikeAssistantText,
} from './scheduleRunOutcome';

const OAUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const OVERLOADED =
  'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.';

let ts = 1;
const msg = (type: SdkMessage['type'], extra: Partial<SdkMessage> = {}): SdkMessage => ({
  type,
  timestamp: ts++,
  ...extra,
});

test('classifies the real auth failure as non-retryable auth', () => {
  const c = classifyRunError(OAUTH);
  assert.equal(c.kind, 'auth');
  assert.equal(c.retryable, false);
  assert.equal(c.note, 'Login expired (OAuth)');
});

test('classifies the real 529 as a retryable transient error', () => {
  const c = classifyRunError(OVERLOADED);
  assert.equal(c.kind, 'transient');
  assert.equal(c.retryable, true);
  assert.equal(c.note, 'API overloaded (529)');
});

test('classifies other API / network / auth shapes', () => {
  assert.deepEqual(
    [
      classifyRunError('API Error: 500 {"type":"error","error":{"type":"api_error"}}'),
      classifyRunError('API Error: 503 Service Unavailable'),
      classifyRunError('API Error: Connection error.'),
      classifyRunError('Error: read ECONNRESET'),
      classifyRunError('stream disconnected before completion'),
      classifyRunError('API Error: 429 {"error":{"type":"rate_limit_error"}}'),
    ].map((c) => [c.kind, c.retryable]),
    [
      ['transient', true],
      ['transient', true],
      ['transient', true],
      ['transient', true],
      ['transient', true],
      ['transient', true],
    ]
  );
  assert.equal(classifyRunError('API Error: 502 Bad Gateway').note, 'API server error (502)');
  assert.equal(classifyRunError('Invalid API key · Please run /login').kind, 'auth');
  assert.equal(classifyRunError('unexpected status 401 Unauthorized').kind, 'auth');
  assert.equal(classifyRunError('Credit balance is too low').kind, 'usage_limit');
  assert.equal(classifyRunError("You've hit your limit · resets 3pm").retryable, false);
});

test('unknown errors are non-retryable with a short note', () => {
  const crash = classifyRunError('Claude Code process exited with code 3221225786');
  assert.equal(crash.kind, 'other');
  assert.equal(crash.retryable, false);
  assert.equal(crash.note, 'Agent process exited (code 3221225786)');
  // A number that is not an HTTP status must not be read as one.
  assert.equal(classifyRunError('Something broke at line 500 of foo.ts').kind, 'other');
  const long = classifyRunError('x'.repeat(200));
  assert.ok(long.note.length <= 80);
});

test('only error-shaped assistant text counts, never a report mentioning errors', () => {
  assert.equal(isErrorLikeAssistantText(OAUTH), true);
  assert.equal(isErrorLikeAssistantText(OVERLOADED), true);
  assert.equal(
    isErrorLikeAssistantText('## Prod logs\n\nGMI was overloaded; API Error: 529 seen 1,800 times.'),
    false
  );
  assert.equal(isErrorLikeAssistantText(`API Error: 529 ${'x'.repeat(1000)}`), false);
  assert.equal(isErrorLikeAssistantText(''), false);
});

test('fresh session: auth text then done → failed', () => {
  const out = evaluateScheduledTurn(
    { status: 'idle', messages: [msg('user', { content: 'p' }), msg('text', { content: OAUTH }), msg('done')] },
    0
  );
  assert.equal(out.state, 'failed');
  assert.equal(out.state === 'failed' && out.error.kind, 'auth');
});

test('mid-turn 529 after tool calls → failed transient', () => {
  const out = evaluateScheduledTurn(
    {
      status: 'idle',
      messages: [
        msg('user', { content: 'p' }),
        msg('tool_start', { tool: 'Bash', toolUseId: 't1' }),
        msg('tool_result', { tool: 'Bash', toolUseId: 't1' }),
        msg('text', { content: OVERLOADED }),
        msg('done'),
      ],
    },
    0
  );
  assert.equal(out.state === 'failed' && out.error.retryable, true);
});

test('normal completion, still running, stop', () => {
  const ok = evaluateScheduledTurn(
    { status: 'idle', messages: [msg('user'), msg('text', { content: 'All good.' }), msg('done')] },
    0
  );
  assert.equal(ok.state, 'ok');
  const running = evaluateScheduledTurn(
    { status: 'querying', messages: [msg('user'), msg('text', { content: 'Working…' })] },
    0
  );
  assert.equal(running.state, 'pending');
  const stopped = evaluateScheduledTurn({ status: 'idle', messages: [msg('user'), msg('stopped')] }, 0);
  assert.equal(stopped.state, 'stopped');
});

test('a subagent text is not the final output', () => {
  const out = evaluateScheduledTurn(
    {
      status: 'idle',
      messages: [
        msg('user'),
        msg('text', { content: OVERLOADED, parentToolUseId: 'agent1' }),
        msg('text', { content: 'Report done.' }),
        msg('done'),
      ],
    },
    0
  );
  assert.equal(out.state, 'ok');
});

test('message target: only the turn after base counts', () => {
  const earlier = [msg('user'), msg('text', { content: OAUTH }), msg('done')];
  const base = earlier.length;
  const pending = evaluateScheduledTurn({ status: 'idle', messages: earlier }, base);
  assert.equal(pending.state, 'pending');
  const out = evaluateScheduledTurn(
    { status: 'idle', messages: [...earlier, msg('user'), msg('text', { content: 'Fine.' }), msg('done')] },
    base
  );
  assert.equal(out.state, 'ok');
});

test('sdk-error message settles as failed', () => {
  const out = evaluateScheduledTurn(
    { status: 'error', messages: [msg('user'), msg('error', { content: 'Claude Code process exited with code 1' })] },
    0
  );
  assert.equal(out.state, 'failed');
});

test('session that failed before the prompt was sent', () => {
  const out = evaluateScheduledTurn(
    { status: 'error', messages: [msg('error', { content: 'Failed to start sidecar' })] },
    0
  );
  assert.equal(out.state, 'failed');
  // A non-terminal setup error before the prompt is not the turn's outcome.
  const setup = evaluateScheduledTurn(
    {
      status: 'idle',
      messages: [msg('error', { content: 'Worktree post-setup failed: x' }), msg('user'), msg('done')],
    },
    0
  );
  assert.equal(setup.state, 'ok');
});

test('rate-limit park without a terminal message → deferred', () => {
  const out = evaluateScheduledTurn(
    { status: 'idle', messages: [msg('user')], parkedTurns: [{ reason: 'rate_limit' }] },
    0
  );
  assert.equal(out.state, 'deferred');
  const queued = evaluateScheduledTurn({ status: 'queued', messages: [] }, 0);
  assert.equal(queued.state, 'pending');
});
