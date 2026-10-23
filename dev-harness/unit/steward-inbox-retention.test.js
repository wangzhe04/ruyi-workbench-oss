'use strict';
// 真落盘验证保留策略、原子替换/追加串行、游标和历史待决语义;只隔离投影与总线,不调用模型。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { functionBlock } = require('../lib/source-slice');
const { loadWorkDataJournals } = require('../lib/work-data-journals-fixture');
const src = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const projectionSource = functionBlock(fs.readFileSync(path.join(src, '06i-steward-core.js'), 'utf8'), 'stewardForeignProjection');
const inboxSource = fs.readFileSync(path.join(src, '13i-steward-inbox.js'), 'utf8');
const configSource = fs.readFileSync(path.join(src, '01-config.js'), 'utf8');
const atomicSource = configSource.slice(configSource.indexOf('async function atomicWriteJson('), configSource.indexOf('async function readFileTail('));
const opsSource = fs.readFileSync(path.join(src, '13l-steward-ops.js'), 'utf8');
const toolSource = opsSource.slice(opsSource.indexOf('async function stewardImplInboxRead('), opsSource.indexOf('// 7) steward_usage'));
const NOW = Date.now(), DAY = 86400000;
const row = (inboxSeq, age = 0, extra = {}) => ({ inboxSeq, at: new Date(NOW - age * DAY).toISOString(),
  kind: 'done', sessionId: 'sess_test', seq: inboxSeq, payload: {}, count: 1, ...extra });
const needs = (inboxSeq, id, age = 60, extra = {}) => row(inboxSeq, age, {
  kind: 'needs_you', seq: id, payload: { interventionId: id }, ...extra,
});

function harness(t, rows = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-inbox-retention-'));
  t.after(() => {
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('ruyi-inbox-retention-'));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const file = path.join(home, 'steward', 'inbox-v1.ndjson');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, rows.map(value => JSON.stringify(value)).join('\n') + (rows.length ? '\n' : ''));
  const io = { ...fsp };
  const context = vm.createContext({ require, fs, fsp: io, path, crypto, Buffer, Date, process, setTimeout, clearTimeout,
    paths: { data: home }, RUYI_EVENTS: { subscribe() {}, emit() {} }, STEWARD_SESSION_ID: 'steward',
    STEWARD_EVENT_KINDS: ['needs_you', 'failed', 'done', 'stalled', 'budget', 'adopted', 'reminder'],
    safeJsonParse: (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } },
    repairMissionChangeTornTail: async () => {}, safeSessionId: value => value, nowIso: () => new Date().toISOString(),
    getPretenderProjectionIndex: async () => ({ sessions: [{ sessionId: 'sess_test', interventions: [] }] }),
    StewardHooks: {}, readConfig: async () => ({workDataEncryptionV1:false}),
    ...loadWorkDataJournals({io}), crypto,
  });
  vm.runInContext(atomicSource + '\n' + inboxSource + '\n' + projectionSource + '\n' + toolSource + '\n' +
    'globalThis.api = { stewardRuntime, stewardMaintainInbox, stewardAppendInboxRows, stewardInboxRead, stewardImplInboxRead, stewardSaveCursor, stewardLoadState };', context);
  return { context, ...context.api, file, read: () => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) };
}

test('清理过期通知,保留当前待决、仍有待决的合并组和未知组;保留重启序号水位', async t => {
  const h = harness(t, [row(1, 60), needs(2, 'open'), needs(3, 'closed'),
    needs(4, 'closed', 60, { count: 2, payload: { interventionId: 'closed', mergedSeqs: ['open', 'closed'] } }),
    needs(5, 'closed', 60, { count: 30 }), row(6, 1), row(7, 60)]);
  h.stewardRuntime.cursor.pendingIds.add('sess_test\0open');
  await h.stewardMaintainInbox(NOW);
  assert.deepEqual(h.read().map(r => r.inboxSeq), [2, 4, 5, 6, 7]);
  await h.stewardLoadState();
  assert.equal(h.stewardRuntime.inboxSeq, 7);
});

test('历史容量最多 5000 条,旧待决不挤占历史额度,增量分页不受默认最新读取影响', async t => {
  const h = harness(t, [needs(1, 'open'), ...Array.from({ length: 5010 }, (_, i) => row(i + 2, 1))]);
  h.stewardRuntime.cursor.pendingIds.add('sess_test\0open');
  await h.stewardMaintainInbox(NOW);
  assert.equal(h.read().length, 5001);
  assert.deepEqual(h.read().slice(0, 2).map(r => r.inboxSeq), [1, 12]);
  const first = await h.stewardInboxRead({ since: 0, limit: 2 });
  assert.deepEqual(Array.from(first.items, r => r.inboxSeq), [1, 12]);
  assert.equal(first.hasMore, true);
  const second = await h.stewardInboxRead({ since: 12, limit: 2 });
  assert.deepEqual(Array.from(second.items, r => r.inboxSeq), [13, 14]);
  const latest = await h.stewardImplInboxRead({ limit: 2 });
  assert.deepEqual(Array.from(latest.items, r => r.inboxSeq), [5011, 5010]);
  assert.equal(latest.order, 'desc');
  const incremental = await h.stewardImplInboxRead({ since: 0, limit: 2 });
  assert.equal(incremental.order, 'asc');
});

test('工具从当前投影核对待决;合并组的最后一条已处理不能掩盖仍待决的较早一条', async t => {
  const h = harness(t, [needs(1, 'open'), needs(2, 'closed'), needs(3, 'closed', 0,
    { count: 2, payload: { interventionId: 'closed', mergedSeqs: ['open', 'closed'] } })]);
  h.context.getPretenderProjectionIndex = async () => ({ sessions: [{ sessionId: 'sess_test',
    interventions: [{ id: 'open', status: 'pending' }, { id: 'closed', status: 'answered' }] }] });
  const result = await h.stewardImplInboxRead({ since: 0 });
  assert.equal(result.pendingCount, 1);
  assert.deepEqual(Array.from(result.items, r => r.pendingState), ['pending', 'not_pending', 'pending']);
  h.context.getPretenderProjectionIndex = async () => { throw new Error('unavailable'); };
  const unknown = await h.stewardImplInboxRead({});
  assert.equal(unknown.pendingCount, null);
  assert.ok(unknown.items.every(r => r.pendingState === 'unknown'));
});

test('整理和追加共用写链,重写前后的新通知都不丢;一小时内不重复扫描', async t => {
  const h = harness(t, [row(1, 60), row(2)]);
  await Promise.all([h.stewardAppendInboxRows([row(3)]), h.stewardMaintainInbox(NOW), h.stewardAppendInboxRows([row(4)])]);
  assert.deepEqual(h.read().map(r => r.inboxSeq), [2, 3, 4]);
  h.context.fsp.open = async () => { throw new Error('must not rescan'); };
  await h.stewardMaintainInbox(NOW + 1);
});

test('读失败、坏行或原子替换失败都保留原文件;整理故障也有节流', async t => {
  for (const failure of ['read', 'invalid', 'rename']) {
    const h = harness(t, [row(1, 60), row(2)]);
    if (failure === 'invalid') fs.appendFileSync(h.file, '{torn');
    if (failure === 'read') h.context.fsp.open = async () => { throw Object.assign(new Error('read I/O'), {code:'EIO'}); };
    if (failure === 'rename') h.context.fsp.rename = async () => { throw Object.assign(new Error('I/O'), { code: 'EIO' }); };
    const before = fs.readFileSync(h.file, 'utf8');
    await assert.rejects(h.stewardMaintainInbox(NOW));
    assert.equal(fs.readFileSync(h.file, 'utf8'), before);
    await h.stewardMaintainInbox(NOW + 1);
    assert.deepEqual(fs.readdirSync(path.dirname(h.file)), ['inbox-v1.ndjson']);
  }
});

test('持久游标的 2000 条上限不裁掉内存待决集合', async t => {
  const h = harness(t);
  for (let i = 0; i < 2010; i++) h.stewardRuntime.cursor.pendingIds.add('sess_test\0iv_' + i);
  await h.stewardSaveCursor(['sess_test'], []);
  assert.equal(h.stewardRuntime.cursor.pendingIds.size, 2010);
  const saved = JSON.parse(fs.readFileSync(path.join(path.dirname(h.file), 'cursor-v1.json'), 'utf8'));
  assert.equal(saved.sources.pendingIds.length, 2000);
});
