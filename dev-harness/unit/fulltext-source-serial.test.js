'use strict';
// 150 号文 S6:13as 的 cap.assert 原来每调一次就把本 scope 授权过的全部来源逐个重算 sequence(O(N)),又被乘进逐行、
// 逐 shard 的 check —— 160 会话一发搜索上万次。现在 02 给一个全库共用的「来源可能变了」计数器
// (sessionFullTextSourceSerial,sessionFullTextSequence 读的五张表任何一次 set/delete/clear 都推它),
// 计数器没动时 cap.assert 只比对本 scope 新授权、还没比过的那几条。
//   · [S1] 运行时:真 server.js 里五张表每一张的 set/delete/clear 都推计数器(漏一张 = 那张表变了 cap.assert 也看不见);
//   · [S2] 13as:计数器不动时 N 次 assert 的 sequence 计算量是 O(N) 而不是 O(N²);计数器一动就整表重比,真变了的来源照样报 source_changed;
//   · [S3] 没有计数器的宿主(vm 夹具)照旧每次整表比对(行为与修前逐字相同);
//   · [S4] 披露前那次权威复核(final 重读 epoch)覆盖本 scope 授权过的每一条来源(不只是被披露的);
//   · [S5] 管家线程搜索的 relatedThreads(来自 metadata())在相关会话被进程外改写/删除后整次拒绝。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-source-serial-'));
process.env.RUYI_HOME = HOME_DIR;
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME_DIR;
const { loadServerInternals } = require('../lib/server-internals');
const api = loadServerInternals(['sessionFullTextSourceSerial', 'sessionFullTextSequence', 'sessionDiskWriteSeq', 'sessionFullTextHeadWriteSeq',
  'sessionDeleteTombstones', 'sessionPermissionModeOverrides', 'sessionDesktopToolsOverrides']);
test.after(() => fs.rmSync(HOME_DIR, { recursive: true, force: true }));

test('[S1] every map read by sessionFullTextSequence bumps the shared source serial on set/delete/clear', () => {
  const maps = ['sessionDiskWriteSeq', 'sessionFullTextHeadWriteSeq', 'sessionDeleteTombstones', 'sessionPermissionModeOverrides', 'sessionDesktopToolsOverrides'];
  for (const name of maps) {
    const map = api[name];
    for (const [op, run] of [['set', () => map.set('serial_probe', name === 'sessionDeleteTombstones' ? { at: 1 } : 1)], ['delete', () => map.delete('serial_probe')], ['clear-empty', () => { const kept = [...map]; map.clear(); for (const [k, v] of kept) map.set(k, v); }]]) {
      const before = api.sessionFullTextSourceSerial(), sequence = api.sessionFullTextSequence('serial_probe');
      run();
      assert.ok(api.sessionFullTextSourceSerial() > before, `${name}.${op} must bump the serial`);
      if (op === 'set') assert.notEqual(api.sessionFullTextSequence('serial_probe'), sequence, `${name} really feeds the sequence`);
    }
    assert.equal(map.has('serial_probe'), false);
  }
  const quiet = api.sessionFullTextSourceSerial();
  api.sessionDiskWriteSeq.get('anything'); api.sessionFullTextSequence('anything');
  assert.equal(api.sessionFullTextSourceSerial(), quiet, 'reads do not bump');
});

// 13as with a minimal host: enough to authorize N sources inside one UI scope and drive cap.assert through metadata().
const SRC = path.resolve(__dirname, '../../ruyi-workbench/app/src/13as-session-fulltext-consumers.js');
function consumers({ serial, sessions = 200 }) {
  const sequences = new Map(), epochs = new Map(), counts = { sequence: 0, epoch: 0, epochIds: new Set() };
  const ids = Array.from({ length: sessions }, (_, n) => 'S' + String(n).padStart(4, '0'));
  for (const id of ids) { sequences.set(id, '1'); epochs.set(id, 'e'.repeat(64)); }
  const source = {
    sequence: id => { counts.sequence++; return sequences.get(id); },
    epoch: async id => { counts.epoch++; counts.epochIds.add(id); return epochs.get(id); },
    inspect: async id => ({ head: { kind: 'quick_ask', id }, epoch: epochs.get(id), sequence: sequences.get(id) }),
    scan: async () => null,
  };
  const context = vm.createContext({ require, structuredClone, Buffer, SessionFullTextHooks: {} });
  const ns = vm.runInContext(fs.readFileSync(SRC, 'utf8').replace(/\n\/\/ Lazy composition:[\s\S]*$/, '\n') + '\nSessionFullTextConsumers;', context);
  const privacy = { disclosurePolicyGuard: () => () => {}, withPolicy: (_, work) => work(), foreignView: v => v,
    prepareLocalDisclosure: async (_sid, build) => ({ value: await build(), assert() {} }), displayText: async (_sid, value) => value };
  const hooks = ns.create({ readConfig: async () => ({}), configGeneration: () => 0, uiAuthority: async () => ({ scopeId: 'ui', assert() {}, revalidate: async () => {} }),
    modelAuthority: async () => { throw Error('unused'); }, source: () => source, catalog: async () => ids.slice(), metadata: head => ({ id: head.id, cwd: '' }),
    projectKey: () => '', terms: () => [], redact: v => v, privacy, bindIndex: () => ({}), ...(serial ? { sourceSerial: serial } : {}) });
  const ui = work => { const req = new EventEmitter(), res = new EventEmitter(); return hooks.withUI(req, res, null, work); };
  return { hooks, ui, counts, sequences, epochs, ids };
}

// 披露前的权威复核(final 重读 epoch)覆盖本 scope 授权过的每一条来源 —— 不只是经 disclose 的那几条:元数据
// (标题、相关线程、存在与否)可以不经 disclose 就进到输出(13k 的 relatedThreads 取自 metadata())。2C 首版曾把
// final 收窄到 cap.disclosed,复审判为阻塞(只计数的来源被外部改写或删除后,旧标题照样外发),已撤回;[S5] 用真入口钉住。
test('[S4] the closing authoritative epoch re-read covers every authorized source, disclosed or only listed', async () => {
  let serialValue = 0;
  const f = consumers({ serial: () => serialValue, sessions: 50 });
  await f.ui(async () => { await f.hooks.metadata(); f.counts.epoch = 0; f.counts.epochIds.clear(); await f.hooks.publicMetadata(f.ids[3]); await f.hooks.publicMetadata(f.ids[9]); });
  assert.equal(f.counts.epochIds.size, 50, 'every authorized source is re-read at the end');
  await assert.rejects(f.ui(async () => { await f.hooks.metadata(); await f.hooks.publicMetadata(f.ids[3]); f.epochs.set(f.ids[3], 'f'.repeat(64)); }), { code: 'session_search.source_changed' });
  f.epochs.set(f.ids[3], 'e'.repeat(64));
  // A source that was only listed (its metadata may reach the output without disclose) refuses too.
  await assert.rejects(f.ui(async () => { await f.hooks.metadata(); await f.hooks.publicMetadata(f.ids[3]); f.epochs.set(f.ids[20], 'f'.repeat(64)); }), { code: 'session_search.source_changed' });
});

// 复审探针 probe-a-related.js 转成测试:管家线程搜索(13k)把 metadata() 里别的会话的 id/标题作为 relatedThreads 交给
// 模型;那条会话在 metadata() 之后被进程外改写或删除时,整次必须拒绝,不能交出旧标题。
test('[S5] steward relatedThreads from metadata() refuse after an out-of-process rewrite or delete of the related session', async t => {
  const p = require('node:path'), fsp = require('node:fs/promises');
  const { fixture } = require('../lib/fulltext-consumer-fixture.js');
  for (const mode of ['rewrite', 'delete', 'none']) {
    const f = await fixture(); t.after(() => f.close());
    const head = title => ({ title, cwd: f.directory, kind: 'mission', updatedAt: '2026-10-24T08:00:00.000Z' });
    await f.put('Alpha', [{ role: 'user', id: 'm1', turnSeq: 1, content: 'zebra quokka needle text' }], { head: head('Alpha thread') });
    await f.put('Beta', [{ role: 'user', id: 'm2', turnSeq: 1, content: 'unrelated body' }], { head: head('BetaOldTitle') });
    const entry = f.installEntrypoints(), original = f.context.SessionFullTextHooks.metadata;
    f.context.SessionFullTextHooks.metadata = async (...args) => {
      const out = await original(...args), file = p.join(f.sessions, 'Beta.json');
      if (mode === 'rewrite') await fsp.writeFile(file, (await fsp.readFile(file, 'utf8')).replace('BetaOldTitle', 'BetaNewTitle'));
      if (mode === 'delete') { await fsp.unlink(file); await fsp.unlink(p.join(f.sessions, 'Beta.messages.ndjson')); }
      return out;
    };
    if (mode === 'none') {
      const value = await entry.threadHistorySearch({ q: 'zebra quokka' }, f.ctx);
      assert.deepEqual(value.results.flatMap(row => row.relatedThreads || []).map(row => row.title), ['BetaOldTitle'], 'control: the related thread is emitted when nothing changes');
    } else await assert.rejects(entry.threadHistorySearch({ q: 'zebra quokka' }, f.ctx), error => /source_changed|deleted|source_denied/.test(String(error.code || error.message)), mode);
  }
});

test('[S2] with a source serial, N authorized sources cost O(N) sequence reads, and a real change is still caught', async () => {
  let serialValue = 0;
  const f = consumers({ serial: () => serialValue });
  await f.ui(async () => { const rows = await f.hooks.metadata(); assert.equal(rows.length, f.ids.length); });
  // metadata() authorizes each source and asserts the scope around each one: O(N) with the counter, O(N^2) without.
  assert.ok(f.counts.sequence <= f.ids.length * 6, `sequence reads ${f.counts.sequence} for ${f.ids.length} sources`);
  // A source rewritten in process bumps the serial; the very next assert re-compares everything and refuses.
  await assert.rejects(f.ui(async () => { await f.hooks.metadata(); f.sequences.set(f.ids[7], '2'); serialValue++; await f.hooks.metadata(); }), { code: 'session_search.source_changed' });
});

test('[S3] without a source serial every assert re-compares all sources (unchanged pre-fix behaviour)', async () => {
  const f = consumers({ serial: null, sessions: 60 });
  await f.ui(async () => { await f.hooks.metadata(); });
  assert.ok(f.counts.sequence > 60 * 60 / 2, `quadratic fallback kept: ${f.counts.sequence}`);
  await assert.rejects(f.ui(async () => { await f.hooks.metadata(); f.sequences.set(f.ids[3], '2'); await f.hooks.metadata(); }), { code: 'session_search.source_changed' });
});
