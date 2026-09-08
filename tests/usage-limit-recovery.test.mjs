// Run: node --experimental-vm-modules --test tests/usage-limit-recovery.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as stores from 'svelte/store';
import * as recovery from '../src/lib/utils/usageLimitRecovery.ts';
import { isUsageLimitError, appServerErrorMessage } from '../src-tauri/sidecar/src/usageLimit.ts';

test('reset waits for a fresh successful snapshot and every blocking window', () => {
  const item = { queuedAt: 1_000, targetStartAt: 100_000 };
  const snapshot = { data: {}, lastFetched: 100_000, consecutiveFailures: 0 };
  assert.equal(recovery.usageLimitReady(item, snapshot, false, 99_999), false);
  assert.equal(recovery.usageLimitReady(item, { ...snapshot, lastFetched: 99_999 }, false, 100_000), false);
  assert.equal(recovery.usageLimitReady(item, { ...snapshot, consecutiveFailures: 1 }, false, 100_000), false);
  assert.equal(recovery.usageLimitReady(item, snapshot, true, 100_000), false);
  assert.equal(recovery.usageLimitReady(item, snapshot, false, 100_000), true);
  assert.equal(recovery.usageLimitReady(item, snapshot, false, 400_000), false);
});

test('unknown reset uses a cooldown and repeated rejections pause automatically', () => {
  const snapshot = { data: {}, lastFetched: 61_000, consecutiveFailures: 0 };
  assert.equal(recovery.usageLimitReady({ queuedAt: 1_000 }, snapshot, false, 60_999), false);
  assert.equal(recovery.usageLimitReady({ queuedAt: 1_000 }, snapshot, false, 61_000), true);
  assert.equal(recovery.usageLimitReady({ queuedAt: 1_000, retryAttempts: 3 }, snapshot, false, 61_000), false);
  assert.equal(recovery.usageLimitReady({ queuedAt: 1_000 }, { ...snapshot, data: null }, false, 61_000), false);
});

test('provider classification distinguishes quota exhaustion from transient throttles', () => {
  for (const message of ['HTTP 429 Too many requests', 'Server is temporarily limiting requests (not your usage limit)', 'authentication failed', 'billing_error']) {
    assert.equal(isUsageLimitError(message), false, message);
  }
  assert.equal(isUsageLimitError("You've hit your weekly limit · resets Monday"), true);
  assert.equal(isUsageLimitError('Rate limit reached; resets at 15:00'), true);
  for (const info of ['UsageLimitExceeded', 'usageLimitExceeded', { usageLimitExceeded: {} }]) {
    assert.equal(isUsageLimitError(appServerErrorMessage({ message: 'Allowance exhausted', codexErrorInfo: info })), true);
  }
});

// Exercise the actual session store with Tauri and unrelated application services
// replaced by inert dependencies. No provider requests, credentials or disk writes.
async function sessionHarness() {
  const calls = [];
  const listeners = new Map();
  const settings = stores.writable({ queue: { enabled: true } });
  const context = vm.createContext({ console, Date, Math, crypto, setTimeout: () => 1, clearTimeout: () => {} });
  const source = await readFile(new URL('../src/lib/stores/sdkSessions.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const parsed = ts.createSourceFile('sdkSessions.js', output, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports = new Map();
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const names = statement.importClause?.namedBindings?.elements?.map(e => e.propertyName?.text ?? e.name.text) ?? [];
    imports.set(statement.moduleSpecifier.text, names);
  }
  const values = {
    settings,
    focusedPaneSessionId: stores.writable(null),
    onScreenSessionIds: stores.writable(new Set()),
    repos: stores.writable({ list: [] }),
    getProviderForModel: () => 'claude',
    resolveModelAlias: model => model,
    getMaxContextTokens: () => 200_000,
    providerExhaustion: () => ({ exhausted: false }),
    listen: async (event, callback) => { listeners.set(event, callback); return () => {}; },
    invoke: async (...args) => { calls.push(args); },
  };
  const module = new vm.SourceTextModule(output, { context });
  await module.link(async specifier => {
    const exports = specifier === 'svelte/store' ? stores
      : specifier.endsWith('/usageLimitRecovery') ? recovery
      : Object.fromEntries(imports.get(specifier).map(name => [name, values[name] ?? (() => {})]));
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  const sdk = module.namespace.sdkSessions;
  sdk.ensureSessionLive = async () => {};
  const turn = { id: 'turn', reason: 'rate_limit', provider: 'claude', prompt: 'Do the task', continuation: true, queuedAt: 1 };
  const session = { id: 'session', status: 'idle', messages: [], parkedTurns: [turn] };
  sdk.set([session]);
  return { sdk, calls, settings, session, turn, listeners };
}

test('cancellation during restoration prevents dispatch and preserves the transcript', async () => {
  const { sdk, calls } = await sessionHarness();
  let restored;
  sdk.ensureSessionLive = () => new Promise(resolve => { restored = resolve; });
  const pending = sdk.continueRateLimited('session', 'turn', true);
  sdk.clearRateLimited('session', 'turn');
  restored();
  await pending;
  assert.equal(calls.length, 0);
  assert.equal(stores.get(sdk)[0].parkedTurns.length, 0);
  assert.equal(stores.get(sdk)[0].messages.length, 0);
});

test('disabling auto-continue during restoration prevents dispatch', async () => {
  const { sdk, calls, settings } = await sessionHarness();
  let restored;
  sdk.ensureSessionLive = () => new Promise(resolve => { restored = resolve; });
  const pending = sdk.continueRateLimited('session', 'turn', true);
  settings.set({ queue: { enabled: false } });
  restored();
  await pending;
  assert.equal(calls.length, 0);
  assert.equal(stores.get(sdk)[0].parkedTurns.length, 1);
});

test('overlapping manual and automatic continuations send only once in the same session', async () => {
  const { sdk, calls } = await sessionHarness();
  await Promise.all([
    sdk.continueRateLimited('session', 'turn', true),
    sdk.continueRateLimited('session', 'turn'),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'send_sdk_prompt');
  assert.equal(calls[0][1].id, 'session');
  assert.equal(calls[0][1].prompt, recovery.USAGE_LIMIT_CONTINUATION);
  assert.equal(stores.get(sdk)[0].rateLimitRetryAttempts, 1);
});

test('never-sent turns retain the original prompt and images', async () => {
  const { sdk, calls, session, turn } = await sessionHarness();
  const images = [{ mediaType: 'image/png', data: 'test' }];
  sdk.set([{ ...session, parkedTurns: [{ ...turn, continuation: false, images }] }]);
  await sdk.continueRateLimited('session', 'turn', true);
  assert.equal(calls[0][1].prompt, 'Do the task');
  assert.equal(calls[0][1].images, images);
});

test('retry cap holds automatic sends but manual continuation starts fresh', async () => {
  const { sdk, calls, session, turn } = await sessionHarness();
  sdk.set([{ ...session, parkedTurns: [{ ...turn, retryAttempts: 3 }] }]);
  await sdk.continueRateLimited('session', 'turn', true);
  assert.equal(calls.length, 0);
  await sdk.continueRateLimited('session', 'turn');
  assert.equal(calls.length, 1);
  assert.equal(stores.get(sdk)[0].rateLimitRetryAttempts, 0);
});

test('terminal limit events deduplicate, respect cancellation, and reset the retry cap after progress', async () => {
  const { sdk, listeners } = await sessionHarness();
  sdk.attachSequenceNodeSession({ executionId: 'run', sessionId: 'live', nodeId: 'node', prompt: 'Do the task' });
  await new Promise(resolve => setImmediate(resolve));
  const emit = listeners.get('sdk-rate-limit-live');
  assert.ok(emit);
  const base = stores.get(sdk).find(s => s.id === 'live');
  const running = {
    ...base, inFlightPrompt: 'Do the task', rateLimitRetryAttempts: 3, rateLimitRetryMessageOffset: 1,
    messages: [...base.messages, { type: 'tool_result', timestamp: Date.now(), content: 'Work completed' }],
  };
  sdk.set([running]);
  const event = { payload: { status: 'rejected', resetsAt: (Date.now() + 3_600_000) / 1000, utilization: 100 } };
  emit(event);
  emit(event);
  let parked = stores.get(sdk)[0].parkedTurns;
  assert.equal(parked.length, 1);
  assert.equal(parked[0].continuation, true);
  assert.equal(parked[0].retryAttempts, 0);
  assert.ok(parked[0].resetsAt > Date.now());
  sdk.clearRateLimited('live', parked[0].id);
  emit(event);
  assert.equal(stores.get(sdk)[0].parkedTurns.length, 0);

  sdk.set([{ ...running, messages: base.messages, rateLimitRetryMessageOffset: 1 }]);
  emit(event);
  parked = stores.get(sdk)[0].parkedTurns;
  assert.equal(parked[0].retryAttempts, 3);
  assert.equal(parked[0].continuation, false); // rejection before any work: preserve the prompt
});

test('queue uses each account snapshot and cancels a pending staggered dispatch', async () => {
  const now = Date.now();
  const calls = [];
  const timers = [];
  const snapshot = exhausted => ({ data: { exhausted }, lastFetched: now, consecutiveFailures: 0 });
  const accountRateLimits = stores.writable({ a: snapshot(false), b: snapshot(true) });
  const rateLimits = stores.writable({ data: null, lastFetched: null, consecutiveFailures: 0 });
  const settings = stores.writable({ queue: { enabled: true, fuzzy_delay_after_reset: true, fuzzy_delay_after_reset_min_secs: 1, fuzzy_delay_after_reset_max_secs: 1 } });
  const session = accountId => ({ id: accountId, accountId, provider: 'claude', status: 'idle', parkedTurns: [{
    id: `turn-${accountId}`, reason: 'rate_limit', queuedAt: now - 120_000, resetsAt: now - 60_000,
  }] });
  const sdkSessions = Object.assign(stores.writable([session('a'), session('b')]), {
    continueRateLimited: async id => { calls.push(id); },
    launchPrepared: async id => { calls.push(id); },
  });
  const modules = {
    'svelte/store': stores,
    './sdkSessions': { sdkSessions, parkedTurnsOf: s => s.parkedTurns ?? [], hasBusySessionsInScope: () => false },
    './rateLimits': {
      rateLimits, codexRateLimits: rateLimits, accountRateLimits,
      rateLimitData: stores.derived(rateLimits, s => s.data), codexRateLimitData: stores.derived(rateLimits, s => s.data),
      rateLimitStoreForAccount: () => { throw new Error('Fresh account snapshots must not refetch'); },
    },
    './queueDetection': { providerExhaustion: (_, accountId) => ({ exhausted: stores.get(accountRateLimits)[accountId].data.exhausted }) },
    './settings': { settings },
    '$lib/utils/sound': { playQueueResume: () => {} },
    '$lib/utils/accounts': { isDefaultAccountId: id => id.startsWith('default-') },
    '$lib/utils/usageLimitRecovery': recovery,
  };
  const context = vm.createContext({ Date, Math, console, queueMicrotask, setTimeout: callback => timers.push(callback) });
  const source = await readFile(new URL('../src/lib/stores/smartQueue.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const module = new vm.SourceTextModule(output, { context });
  await module.link(async specifier => {
    const exports = modules[specifier];
    assert.ok(exports, specifier);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  const stop = module.namespace.startSmartQueue();
  assert.equal(timers.length, 1); // account a is ready even though default usage is unknown
  sdkSessions.set([session('b')]); // cancel a while its stagger timer is running
  timers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
  accountRateLimits.set({ a: snapshot(false), b: snapshot(false) });
  assert.equal(timers.length, 1);
  timers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['b']);
  stop();
});
