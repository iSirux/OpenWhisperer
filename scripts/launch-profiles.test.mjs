import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as stores from 'svelte/store';

// Exercise the production store with a simulated Tauri backend; no terminals are launched.
function setup() {
  const calls = [];
  let status = 'running';
  let launchGate;
  const repo = { id: 'repo', launch_profiles: [
    { id: 'build', name: 'Build', execution_type: 'task', command_ids: ['build'] },
    { id: 'test', name: 'Tests', execution_type: 'task', command_ids: ['test'] },
    { id: 'serve', name: 'API', execution_type: 'service', command_ids: ['serve'] },
  ] };
  const modules = {
    'svelte/store': stores,
    '@tauri-apps/api/core': { invoke: async (name, args) => {
      calls.push({ name, ...args });
      if (name === 'launch_profile' && launchGate) await launchGate;
      return name === 'get_launch_task_status' ? { status } : [];
    } },
    '@tauri-apps/api/event': { listen: async () => () => {} },
    './repos': { repos: stores.writable({ list: [repo] }), findRepoById: () => repo },
    './sdkSessions': { sdkSessions: stores.writable([]), hasBusySessionsInScope: () => false, normalizeScopePath: p => p },
  };
  const source = readFileSync(new URL('../src/lib/stores/launchProfiles.ts', import.meta.url), 'utf8')
    .replaceAll('import.meta.hot', 'undefined');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  vm.runInNewContext(outputText, { exports, require: id => {
    assert.ok(modules[id], `Unexpected import: ${id}`);
    return modules[id];
  }, console, setTimeout, clearTimeout });
  const store = exports.launchStore;
  return { store, calls, state: () => stores.get(store), setStatus: value => { status = value; }, setLaunchGate: value => { launchGate = value; } };
}

test('build → tests → service advances only on success and preserves worktree', async () => {
  const h = setup();
  await h.store.launchProfile('repo', 'build', '/worktree');
  await h.store.launchProfile('repo', 'test', '/different-worktree');
  await h.store.launchProfile('repo', 'serve', '/different-worktree');
  await h.store.refreshStatus('repo');
  assert.equal(h.calls.filter(c => c.name === 'launch_profile').length, 1);
  h.setStatus('succeeded');
  await Promise.all([h.store.refreshStatus('repo'), h.store.refreshStatus('repo')]);
  assert.equal(h.state().runtimes.repo.profileId, 'test');
  await h.store.refreshStatus('repo');
  assert.equal(h.state().runtimes.repo.profileId, 'serve');
  assert.equal(h.state().taskQueues.repo.length, 0);
  assert.deepEqual(h.calls.filter(c => c.name === 'launch_profile').map(c => [c.profileId, c.cwd]), [
    ['build', '/worktree'], ['test', '/worktree'], ['serve', '/worktree'],
  ]);
});

test('failure pauses the queue until retry succeeds', async () => {
  const h = setup();
  await h.store.launchProfile('repo', 'build', '/worktree');
  await h.store.launchProfile('repo', 'serve');
  h.setStatus('failed');
  await h.store.refreshStatus('repo');
  await h.store.refreshStatus('repo');
  assert.equal(h.state().runtimes.repo.taskStatus, 'failed');
  assert.equal(h.state().taskQueues.repo.length, 1);
  await h.store.retryTask('repo');
  h.setStatus('succeeded');
  await h.store.refreshStatus('repo');
  assert.equal(h.state().runtimes.repo.profileId, 'serve');
});

test('removing a queued task skips it; stopping clears the queue', async () => {
  const h = setup();
  await h.store.launchProfile('repo', 'build');
  await h.store.launchProfile('repo', 'test');
  await h.store.launchProfile('repo', 'serve');
  h.store.removeTaskQueueItem('repo', 0);
  assert.equal(h.state().taskQueues.repo[0].profileId, 'serve');
  await h.store.stopAll('repo');
  h.setStatus('succeeded');
  await h.store.refreshStatus('repo');
  assert.equal(h.state().taskQueues.repo.length, 0);
  assert.equal(h.calls.filter(c => c.name === 'launch_profile').length, 1);
});

test('services are final queue items and launch normally outside a task', async () => {
  const h = setup();
  await h.store.launchProfile('repo', 'serve');
  await h.store.launchProfile('repo', 'build');
  await h.store.launchProfile('repo', 'serve');
  await h.store.launchProfile('repo', 'test');
  assert.equal(h.state().taskQueues.repo.length, 1);
  assert.match(h.state().errors.repo, /final queue item/);
});

test('queueing and stopping work while the task terminal is opening', async () => {
  const h = setup();
  let release;
  h.setLaunchGate(new Promise(resolve => { release = resolve; }));
  const launch = h.store.launchProfile('repo', 'build');
  await h.store.launchProfile('repo', 'serve');
  assert.equal(h.state().taskQueues.repo.length, 1);
  const stop = h.store.stopAll('repo');
  assert.equal(h.calls.some(c => c.name === 'stop_launch_profile'), false);
  release();
  await Promise.all([launch, stop]);
  assert.equal(h.state().runtimes.repo, undefined);
  assert.equal(h.state().taskQueues.repo.length, 0);
});

test('a queued service failing to start leaves a retryable paused queue', async () => {
  const h = setup();
  await h.store.launchProfile('repo', 'build');
  await h.store.launchProfile('repo', 'serve');
  h.setLaunchGate(Promise.reject(new Error('Terminal unavailable')));
  h.setStatus('succeeded');
  await h.store.refreshStatus('repo');
  assert.equal(h.state().runtimes.repo.taskStatus, 'failed');
  assert.equal(h.state().taskQueues.repo.length, 1);
  assert.match(h.state().errors.repo, /Terminal unavailable/);
});
