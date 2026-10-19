'use strict';
// 62 号第三轮 P1（失败与迟到响应保护）：同一个 attemptId 只执行一次；`checkAttempt` 只读回执。
// 真源码（lib/server-internals 直取 13q 的 stewardRunAct）、临时 HOME；用 open_thread 这种零副作用 act
// 就能把「执行／核对／重放」三态钉死，不需要 provider 或会话夹具。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-act-attempt-'));
process.env.RUYI_HOME = root;
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.HOME = root;
process.env.USERPROFILE = root;

const { loadServerInternals } = require('../lib/server-internals');
const { stewardRunAct } = loadServerInternals(['stewardRunAct']);

const act = sessionId => ({ kind: 'open_thread', sessionId });
const validId = 'attempt-00000001';

test('the same attemptId executes once and reports the replay', async () => {
  const first = await stewardRunAct(act('sess-a'), {}, { attemptId: validId });
  assert.equal(first.ok, true);
  assert.equal(first.kind, 'open_thread');
  assert.equal(first.replayed, undefined);
  const again = await stewardRunAct(act('sess-a'), {}, { attemptId: validId });
  assert.equal(again.ok, true);
  assert.equal(again.replayed, true);
  assert.equal(again.kind, 'open_thread');
  assert.match(again.executedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('checkAttempt is read-only: applied true after a run, false before', async () => {
  const before = await stewardRunAct(null, {}, { attemptId: 'attempt-00000002', check: true });
  assert.equal(before.ok, true);
  assert.equal(before.kind, 'attempt_check');
  assert.equal(before.applied, false);
  await stewardRunAct(act('sess-b'), {}, { attemptId: 'attempt-00000002' });
  const after = await stewardRunAct(null, {}, { attemptId: 'attempt-00000002', check: true });
  assert.equal(after.applied, true);
  assert.match(after.executedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('a check never executes the act it asks about', async () => {
  // 传了真实 act 也不执行：回执查询只看账本。
  const result = await stewardRunAct(act('sess-never'), {}, { attemptId: 'attempt-00000003', check: true });
  assert.equal(result.applied, false);
  const replay = await stewardRunAct(act('sess-never'), {}, { attemptId: 'attempt-00000003' });
  assert.equal(replay.replayed, undefined, 'the check did not burn or run the attempt');
});

test('a check without a usable attemptId is refused instead of executed', async () => {
  for (const attemptId of ['', 'short', 'has space inside', 42, null]) {
    const result = await stewardRunAct(act('sess-c'), {}, { attemptId, check: true });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_request');
  }
  const noAttempt = await stewardRunAct(act('sess-c'), {}, {});
  assert.equal(noAttempt.ok, true, 'a plain act still works without any attempt');
});

test('failed acts do not burn the attempt id', async () => {
  const bad = await stewardRunAct({ kind: 'tool', tool: 'definitely_not_a_tool' }, {}, { attemptId: 'attempt-00000004' });
  assert.equal(bad.ok, false);
  const afterBad = await stewardRunAct(null, {}, { attemptId: 'attempt-00000004', check: true });
  assert.equal(afterBad.applied, false, 'a rejected act must not look executed');
  const good = await stewardRunAct(act('sess-d'), {}, { attemptId: 'attempt-00000004' });
  assert.equal(good.ok, true);
  assert.equal(good.replayed, undefined, 'the retry after a rejection really runs');
});

test('concurrent requests with the same attemptId share one execution', async () => {
  const [first, second] = await Promise.all([
    stewardRunAct(act('sess-f'), {}, { attemptId: 'attempt-00000005' }),
    stewardRunAct(act('sess-f'), {}, { attemptId: 'attempt-00000005' }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(first.replayed, undefined, 'the owner runs the act');
  assert.equal(second.replayed, true, 'the concurrent duplicate is a replay, not a second execution');
  const check = await stewardRunAct(null, {}, { attemptId: 'attempt-00000005', check: true });
  assert.equal(check.applied, true);
});

test('a replay returns the stored result unchanged apart from the replay marker', async () => {
  const first = await stewardRunAct(act('sess-g'), {}, { attemptId: 'attempt-00000006' });
  const replay = await stewardRunAct(act('sess-g'), {}, { attemptId: 'attempt-00000006' });
  const { replayed, executedAt, ...rest } = replay;
  assert.equal(replayed, true);
  assert.match(executedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(rest, first);
});

test('an unusable attemptId on a plain act degrades to a normal execution', async () => {
  const result = await stewardRunAct(act('sess-e'), {}, { attemptId: 'bad id' });
  assert.equal(result.ok, true);
  assert.equal(result.replayed, undefined);
});

test('guarded windows distinguish missing, in-flight and applied without executing checks', async () => {
  const attemptId = 'window-attempt-0001';
  const before = await stewardRunAct(null, {}, { attemptId, check: true });
  assert.equal(before.state, 'unknown', 'a bare missing receipt is not proof of non-execution');
  const window = before.window;
  const proven = await stewardRunAct(null, {}, { attemptId, check: true, window });
  assert.equal(proven.state, 'not_applied');
  const owner = stewardRunAct(act('sess-window'), {}, { attemptId, window });
  const inflight = await stewardRunAct(null, {}, { attemptId, check: true, window });
  assert.equal(inflight.state, 'inflight');
  assert.equal(inflight.applied, null);
  assert.equal((await owner).ok, true);
  assert.equal((await stewardRunAct(null, {}, { attemptId, check: true, window })).state, 'applied');
  assert.equal((await stewardRunAct(act('sess-window'), {}, { attemptId, window })).replayed, true);
});

test('expired or foreign-instance windows cannot execute a missing attempt', async () => {
  const attemptId = 'window-attempt-0002', { window } = await stewardRunAct(null, {}, { attemptId, check: true });
  for (const stale of [{ ...window, serverInstanceId: 'old-instance' }, { ...window, issuedAt: window.issuedAt - 600001, expiresAt: window.expiresAt - 600001 }]) {
    const check = await stewardRunAct(null, {}, { attemptId, check: true, window: stale });
    assert.equal(check.state, 'unknown'); assert.equal(check.applied, null);
    const run = await stewardRunAct(act('sess-never'), {}, { attemptId, window: stale });
    assert.equal(run.error, 'attempt_unknown');
  }
  assert.equal((await stewardRunAct(act('sess-never'), {}, { attemptId: '', window })).ok, false);
});

test('capacity eviction invalidates older missing windows without allowing a second execution', async () => {
  const attemptId = 'window-evicted-0001', { window } = await stewardRunAct(null, {}, { attemptId, check: true });
  await stewardRunAct(act('sess-once'), {}, { attemptId, window });
  for (let i = 0; i < 257; i++) await stewardRunAct(act('sess-fill'), {}, { attemptId: 'fill-capacity-' + i });
  const check = await stewardRunAct(null, {}, { attemptId, check: true, window });
  assert.equal(check.state, 'unknown'); assert.equal(check.applied, null);
  assert.equal((await stewardRunAct(act('sess-once'), {}, { attemptId, window })).error, 'attempt_unknown');
});

test('an attempt cannot replay a receipt for another target or payload', async () => {
  const absent = await stewardRunAct(undefined, {}, { attemptId: 'attempt-absent-0001' });
  assert.equal(absent.ok, false, 'missing act returns a failure instead of throwing');
  await stewardRunAct(act('sess-bound'), {}, { attemptId: 'attempt-bound-00001' });
  const changed = await stewardRunAct(act('sess-other'), {}, { attemptId: 'attempt-bound-00001' });
  assert.equal(changed.ok, false);
  assert.equal(changed.error, 'invalid_request');
  const [owner, mismatch] = await Promise.all([
    stewardRunAct(act('sess-owner'), {}, { attemptId: 'attempt-bound-00002' }),
    stewardRunAct(act('sess-mismatch'), {}, { attemptId: 'attempt-bound-00002' }),
  ]);
  assert.equal(owner.ok, true);
  assert.equal(mismatch.ok, false);
});

test('TTL pruning never turns an executed guarded attempt into an executable missing receipt', async () => {
  const attemptId = 'window-expiry-00001', { window } = await stewardRunAct(null, {}, { attemptId, check: true });
  // Previous capacity-test evictions may share the same millisecond; wait before issuing a new window.
  await new Promise(resolve => setTimeout(resolve, 5));
  const fresh = (await stewardRunAct(null, {}, { attemptId, check: true })).window;
  assert.equal((await stewardRunAct(act('sess-expiry'), {}, { attemptId, window: fresh })).ok, true);
  const realNow = Date.now;
  try {
    Date.now = () => window.expiresAt + 600001;
    const expired = await stewardRunAct(null, {}, { attemptId, check: true, window: fresh });
    assert.equal(expired.state, 'unknown'); assert.equal(expired.applied, null);
    assert.equal((await stewardRunAct(act('sess-expiry'), {}, { attemptId, window: fresh })).error, 'attempt_unknown');
  } finally { Date.now = realNow; }
});
