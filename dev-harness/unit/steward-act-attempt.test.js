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

test('an unusable attemptId on a plain act degrades to a normal execution', async () => {
  const result = await stewardRunAct(act('sess-e'), {}, { attemptId: 'bad id' });
  assert.equal(result.ok, true);
  assert.equal(result.replayed, undefined);
});
