'use strict';
// 走查 W1 #6:介入日志(<id>.interventions.ndjson)的写放大与无界增长。真源码、临时 HOME、真读盘真写盘。
// 修前:applying / terminal 行都 `...cur` 整份重抄(含 permission 的 input,可能很大)→ 每条介入 3 份完整 input;
// 压实判据 `rowCount > max(256, rowsAfter*3)` 对「恰好 3 行/条」永远不过;interventionRecordCache 只增不减。
//   [D1] applying / terminal 行只写增量字段(不再带 input / toolName / requestedAt),读侧折叠后字段一个不少;
//   [D2] 幂等重放照常:同 idempotencyKey 的重试回放落在终态行上的 decisionResponse(增量行也带得住);
//   [D3] 每条介入恰好 3 行时,周期压实的判据真的会过(不用 force),压完事实与压前一致、行数 = 条数;
//   [D4] 旧格式的整份重抄行与新格式增量行混在一份日志里,折叠结果一致(向后兼容);
//   [D5] 重启终态化(markInterruptedInterventions)写的也是增量行(结构锁;折叠合并语义由 D4 钉);
//   [D6] 缓存生命周期的结构锁:结算/落终态时摘缓存、删会话时清缓存。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { functionBlock } = require('../lib/source-slice');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-iv-delta-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { createSession, registerIntervention, transitionInterventionState, readInterventions, compactInterventionJournal } = srv;

const journal = sid => path.join(root, 'sessions', sid + '.interventions.ndjson');
const rowsOf = sid => fs.readFileSync(journal(sid), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function registered(sid, ids, extraOf) {
  for (const id of ids) registerIntervention(sid, 'permission', id, extraOf(id));
  for (let i = 0; i < 200; i++) { if ((await readInterventions(sid)).length >= ids.length) return; await sleep(10); }
  throw new Error('register 行没落盘');
}

test('[D1] applying / terminal 行只写增量,读侧折叠后字段不丢', async () => {
  const s = await createSession({ title: 'd1', cwd: root });
  const input = { path: '/tmp/a.txt', content: 'x'.repeat(20000) };
  await registered(s.id, ['perm_d1'], () => ({ toolName: 'file_write', tier: 'edit', revertible: true, input }));
  const r = await transitionInterventionState(s.id, 'perm_d1', undefined, 'allowed', {
    source: 'legacy_permission', decidedBy: 'user', idempotencyKey: 'k-d1', decisionFingerprint: 'fp-d1',
    action: () => ({ ok: true }), buildResponse: (_res, st) => ({ ok: true, status: st.status }),
  });
  assert.equal(r.ok, true);
  const rows = rowsOf(s.id);
  assert.equal(rows.length, 3, 'register / applying / terminal 各一行');
  assert.ok(rows[0].input && rows[0].input.content.length === 20000, 'register 行带完整 input');
  for (const row of rows.slice(1)) {
    assert.equal(row.input, undefined, '增量行不再重抄 input');
    assert.equal(row.toolName, undefined);
    assert.equal(row.requestedAt, undefined);
    assert.ok(JSON.stringify(row).length < 600, `增量行很小(实 ${JSON.stringify(row).length} 字节)`);
  }
  assert.equal(rows[1].status, 'applying');
  assert.equal(rows[2].status, 'allowed');
  const [iv] = await readInterventions(s.id);
  assert.equal(iv.status, 'allowed');
  assert.equal(iv.interventionVersion, 2);
  assert.equal(iv.type, 'permission');
  assert.equal(iv.toolName, 'file_write');
  assert.equal(iv.input.content.length, 20000, '折叠后 input 仍在');
  assert.ok(iv.requestedAt && iv.decidedAt, 'requestedAt / decidedAt 都在');
  assert.equal(iv.decidedBy, 'user');
  assert.equal(iv.source, 'legacy_permission');
  assert.equal(iv.idempotencyKey, 'k-d1');
});

test('[D2] 幂等重放:同 key 重试回放终态行上的 decisionResponse', async () => {
  const s = await createSession({ title: 'd2', cwd: root });
  await registered(s.id, ['perm_d2'], () => ({ toolName: 'file_write', input: { p: 1 } }));
  let ran = 0;
  const opts = {
    source: 'contract', idempotencyKey: 'k-d2', decisionFingerprint: 'fp-d2',
    action: () => { ran++; return { ok: true }; }, buildResponse: () => ({ ok: true, marker: 'resp-d2' }),
  };
  const first = await transitionInterventionState(s.id, 'perm_d2', undefined, 'allowed', opts);
  assert.equal(first.ok, true);
  const again = await transitionInterventionState(s.id, 'perm_d2', undefined, 'allowed', opts);
  assert.equal(again.ok, true);
  assert.equal(again.replayed, true);
  assert.equal(again.response.marker, 'resp-d2');
  assert.equal(ran, 1, '重放不再执行动作');
  const conflict = await transitionInterventionState(s.id, 'perm_d2', undefined, 'allowed', { ...opts, decisionFingerprint: 'other' });
  assert.equal(conflict.reason, 'idempotency_conflict');
});

test('[D3] 3 行/条的日志:压实判据真会通过(不用 force),压完事实一致', async () => {
  // (a) 确定性:手摆一份 300 条 × 恰好 3 行(register 整行 + applying / terminal 增量行)的日志,直接问压实。
  const s = await createSession({ title: 'd3', cwd: root });
  const input = { path: '/tmp/a', content: 'y'.repeat(1024) };
  const lines = [];
  for (let i = 0; i < 300; i++) {
    const id = 'perm_d3_' + i, at = new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
    lines.push({ id, type: 'permission', sessionId: s.id, status: 'pending', requestedAt: at, decidedAt: '', decidedBy: '', interventionVersion: 0, toolName: 'file_write', tier: 'edit', input });
    lines.push({ id, sessionId: s.id, status: 'applying', decidedAt: '', decidedBy: '', interventionVersion: 1, source: 'legacy_permission' });
    lines.push({ id, sessionId: s.id, status: 'allowed', decidedAt: at, decidedBy: 'user', interventionVersion: 2, source: 'legacy_permission' });
  }
  fs.writeFileSync(journal(s.id), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(rowsOf(s.id).length, 900, '每条恰好 3 行:修前 900 > max(256, 300*3) 不成立,永不压实');
  assert.ok(fs.statSync(journal(s.id)).size >= 65536);
  const before = await readInterventions(s.id);
  const res = await compactInterventionJournal(s.id);   // 非 force
  assert.equal(res.compacted, true, '修前判据 rowCount > rowsAfter*3 对恰好 3 行/条恒假');
  assert.equal(res.rowsBefore, 900);
  assert.equal(res.rowsAfter, 300);
  assert.equal(rowsOf(s.id).length, 300);
  assert.deepEqual(await readInterventions(s.id), before, '压实前后折叠出的事实逐字段一致');
  assert.equal((await compactInterventionJournal(s.id)).compacted, false, '压完不会立刻再压(摊还)');

  // (b) 真实写入路径:300 条走完 register → applying → terminal,每 128 次追加的周期压实不用 force 就会自己触发。
  const s2 = await createSession({ title: 'd3b', cwd: root });
  const ids = Array.from({ length: 300 }, (_, i) => 'perm_d3b_' + i);
  await registered(s2.id, ids, () => ({ toolName: 'file_write', tier: 'edit', input }));
  for (const id of ids) await transitionInterventionState(s2.id, id, undefined, 'allowed', { source: 'legacy_permission', action: () => ({ ok: true }) });
  await sleep(300);
  await readInterventions(s2.id);   // 等写链(含周期压实)落定
  assert.ok(rowsOf(s2.id).length < 900, `周期压实自己跑过了(磁盘 ${rowsOf(s2.id).length} 行 < 900;修前恒为 900)`);
  const folded = await readInterventions(s2.id);
  assert.equal(folded.length, 300);
  assert.ok(folded.every(iv => iv.status === 'allowed' && iv.interventionVersion === 2 && iv.input && iv.input.content.length === 1024), '压实穿插在迁移里,事实一个不丢');
});

test('[D4] 旧格式整份重抄行 + 新格式增量行混写,折叠结果一致', async () => {
  const s = await createSession({ title: 'd4', cwd: root });
  const reg = { id: 'perm_old', type: 'permission', sessionId: s.id, status: 'pending', requestedAt: '2026-10-01T00:00:00.000Z', decidedAt: '', decidedBy: '', interventionVersion: 0, toolName: 'file_write', input: { a: 1 } };
  const oldApplying = { ...reg, status: 'applying', interventionVersion: 1, source: 'contract' };       // 旧版:整份重抄
  const newTerminal = { id: 'perm_old', sessionId: s.id, status: 'allowed', decidedAt: '2026-10-01T00:00:05.000Z', decidedBy: 'user', interventionVersion: 2, source: 'contract' };   // 新版:增量
  fs.writeFileSync(journal(s.id), [reg, oldApplying, newTerminal].map(r => JSON.stringify(r)).join('\n') + '\n');
  const [iv] = await readInterventions(s.id);
  assert.equal(iv.status, 'allowed');
  assert.equal(iv.interventionVersion, 2);
  assert.deepEqual(iv.input, { a: 1 });
  assert.equal(iv.toolName, 'file_write');
  assert.equal(iv.requestedAt, '2026-10-01T00:00:00.000Z');
});

test('[D5] 重启终态化(markInterruptedInterventions)写增量行(结构锁:不再 ...iv 整份重抄)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/02-session-store.js'), 'utf8');
  const body = functionBlock(src, 'markInterruptedInterventions');
  assert.ok(body.length > 500, '切到了');
  assert.ok(!/\.\.\.iv\b/.test(body), 'cancelled_restart / indeterminate 行不再整份展开 iv(含 input)');
  assert.match(body, /status: 'cancelled_restart'/);
  assert.match(body, /status: 'indeterminate'/);
  // 折叠语义:只带增量字段的终态化行并进 register 行后,type / input 仍在(与 [D4] 同一条读侧合并折叠)。
});

test('[D6] 缓存生命周期(结构锁):结算与落终态摘缓存,删会话清缓存', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/02-session-store.js'), 'utf8');
  const settle = functionBlock(src, 'settleIntervention');
  const transition = functionBlock(src, 'transitionInterventionState');
  const drop = functionBlock(src, 'dropInterventionSessionState');
  const del = functionBlock(src, 'deleteSession');
  assert.ok(settle.length > 100 && transition.length > 1000 && drop.length > 50 && del.length > 1000, '切到了');
  assert.match(settle, /interventionRecordCache\.delete\(/, '结算(终态)摘缓存');
  assert.match(transition, /interventionRecordCache\.delete\(/, '落终态摘缓存');
  assert.ok(!/interventionRecordCache\.set\([^)]*termRec/.test(transition), '终态记录不再塞回缓存');
  assert.match(drop, /interventionRecordCache\.delete\(/);
  assert.match(drop, /interventionAppendCounts\.delete\(/);
  assert.match(del, /dropInterventionSessionState\(id\)/, '删会话清它名下的介入缓存与节拍计数');
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
