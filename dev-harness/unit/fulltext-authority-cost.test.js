'use strict';
// 151 阶段 2F:全文检索的权威复核点一个不少,只降每次复核的成本。本文件为每一种合并钉住「被合并掉的那部分由谁覆盖」:
//   · [F1] 02 select:数据根的 realpath 不再每次单独做,由文件级 realpath(file)===file 覆盖;数据根本身仍每次 select
//          lstat 一次(根是链接/junction 时不穿过它就拒绝)。每次 select 的 lstat+realpath 从 8 次降到 5 次(运行时计数)。
//   · [F2] 数据根被换成 junction(指向同一目录或一份拷贝)、某一级祖先是 junction(文件在 / 文件不在两种)都照旧
//          owner_alias;根正常时文件不存在照旧 null。正文的归属核对与头的读取并行,但只在头判定需要正文后采信:
//          旧式(legacy)头旁边躺着一个链接正文不影响读,现代头的链接/硬链接正文照旧 owner_alias。
//   · [F3] 13ap namespace:目录链逐级 lstat 照旧,realpath 只做最深一级;索引根被换成 junction、数据根祖先是 junction
//          且会话索引目录不存在,都照旧 owned_namespace_changed(后者由「不存在时对已存在的最深一级 realpath」兜住)。
//   · [F4] 13as final 改成有界滑动窗口:仍对本 scope 授权过的每一条来源各做一次 epoch 重读;在飞数不超过窗口宽度;
//          某一条失败后不再起新的。
//   · [F5] 真入口(13as+13ap+02 真源):起点授权之后、出口复核之前,数据根被换成 junction、正文被 rename 替换、
//          头被改写,整次拒绝;什么都不动时照常出结果(对照)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { fixture } = require('../lib/work-data-session-fulltext-fixture.js');

const row = (content, extra = {}) => ({ role: 'user', content, ...extra });
const withFixture = async (fn, options) => { const f = await fixture(options); try { await fn(f); } finally { await f.close(); } };
const JUNCTION = process.platform === 'win32' ? 'junction' : 'dir';
// 只数 fs/promises 上的 lstat/realpath(fixture 的 vm 与本进程共用同一个模块对象);结束即还原。
async function countingFs(work) {
  const counts = { lstat: 0, realpath: 0 }, saved = {};
  for (const name of Object.keys(counts)) { saved[name] = fs[name]; fs[name] = function (...args) { counts[name]++; return saved[name].apply(this, args); }; }
  try { return { value: await work(), counts }; } finally { Object.assign(fs, saved); }
}
// 把目录换成指向 target 的 junction,返回还原函数(先拆 junction 再把原目录挪回)。
async function swapForJunction(dir, target, keep) {
  await fs.rename(dir, keep); await fs.symlink(target, dir, JUNCTION);
  return async () => { try { await fs.unlink(dir); } catch { await fs.rmdir(dir); } await fs.rename(keep, dir); };
}

test('[F1] one select costs at most 5 lstat/realpath calls (root lstat once, file-level lstat+realpath for head and body)', () => withFixture(async f => {
  await f.put('Costed', [row('cost needle')]);
  const { value, counts } = await countingFs(() => f.api.source.inspect('Costed'));
  assert.ok(value && value.head.id === 'Costed');
  // 修前:头、正文各一次 owned(),每次 owned() = 数据根 lstat+realpath + 文件 lstat+realpath → 8 次。
  assert.ok(counts.lstat + counts.realpath <= 5, `lstat ${counts.lstat} + realpath ${counts.realpath}`);
  assert.equal(counts.realpath, 2, 'file-level realpath is still done for head and body');
  assert.equal(counts.lstat, 3, 'root lstat once + head lstat + body lstat');
  // 复审建议 3:并行的正文核对失败时不补核根链(头那一路负责),旧式头 / 头不存在 / 空会话无正文都不比修前多花。
  // 修前:旧式头 4、头不存在 3、空会话无正文 7。
  await f.put('LegacyCost', [row('legacy cost')], { legacy: true });
  await f.put('EmptyCost', []); await fs.unlink(path.join(f.sessions, 'EmptyCost.messages.ndjson'));
  for (const [id, most] of [['LegacyCost', 4], ['Missing_cost', 4], ['EmptyCost', 4]]) {
    const { counts: c } = await countingFs(() => f.api.source.epoch(id));
    assert.ok(c.lstat + c.realpath <= most, `${id}: lstat ${c.lstat} + realpath ${c.realpath}`);
  }
  assert.equal(await f.api.source.epoch('Missing_cost'), null);
}));

test('[F2] sessions root swapped for a junction (same directory or a copy) still refuses with owner_alias', () => withFixture(async f => {
  await f.put('Aliased', [row('alias root needle')]);
  for (const mode of ['same', 'copy']) {
    const keep = f.sessions + '-real-' + mode;
    let target = keep;
    if (mode === 'copy') { target = f.sessions + '-copy'; await fs.cp(f.sessions, target, { recursive: true }); }
    const restore = await swapForJunction(f.sessions, target, keep);
    try {
      await assert.rejects(f.api.source.inspect('Aliased'), { code: 'session_fulltext_source.owner_alias' }, mode + ' existing');
      await assert.rejects(f.api.source.epoch('Missing_one'), { code: 'session_fulltext_source.owner_alias' }, mode + ' missing');
      await assert.rejects(f.api.source.scan('Aliased', async () => {}), { code: 'session_fulltext_source.owner_alias' }, mode + ' scan');
    } finally { await restore(); if (mode === 'copy') await fs.rm(target, { recursive: true, force: true }); }
  }
  assert.ok(await f.api.source.inspect('Aliased'), 'restored root reads again');
  assert.equal(await f.api.source.epoch('Missing_one'), null, 'healthy root + missing head is still null');
}));

test('[F2] an ancestor junction above the sessions root is caught by the file-level realpath, and by the root chain when the file is missing', () => withFixture(async f => {
  await f.put('Ancestor', [row('ancestor needle')]);
  const keep = f.directory + '-real', restore = await swapForJunction(f.directory, keep, keep);
  try {
    await assert.rejects(f.api.source.inspect('Ancestor'), { code: 'session_fulltext_source.owner_alias' });
    // 文件不在:修前先核根链(realpath 不一致)报 owner_alias;合并后由「lstat 失败时补核根链」保持同一结论,而不是 null。
    await assert.rejects(f.api.source.epoch('Missing_two'), { code: 'session_fulltext_source.owner_alias' });
  } finally { await restore(); }
}));

test('[F2] body ownership runs alongside the head read but is only trusted when the head needs a body', () => withFixture(async f => {
  const outside = path.join(f.directory, 'outside-body');
  await fs.writeFile(outside, JSON.stringify(row('outside body')) + '\n');
  // 旧式头:正文位置躺着一个指向外部的链接,不影响读(修前根本不看它)。
  await f.put('LegacyHead', [row('legacy inline needle')], { legacy: true });
  await fs.symlink(outside, path.join(f.sessions, 'LegacyHead.messages.ndjson')).catch(error => { if (error.code !== 'EPERM') throw error; });
  const legacy = await f.api.source.inspect('LegacyHead');
  assert.equal(legacy.head.messageCount, 1);
  // 现代头:硬链接正文照旧 owner_alias;正文缺失且 count>0 照旧 ENOENT 上抛;count=0 的空会话照常读。
  await f.put('Hard', [row('hard body')]);
  const body = path.join(f.sessions, 'Hard.messages.ndjson'), external = path.join(f.directory, 'hard-external');
  await fs.rename(body, external); await fs.link(external, body);
  await assert.rejects(f.api.source.inspect('Hard'), { code: 'session_fulltext_source.owner_alias' });
  await f.put('Gone', [row('gone body')]); await fs.unlink(path.join(f.sessions, 'Gone.messages.ndjson'));
  await assert.rejects(f.api.source.inspect('Gone'), { code: 'ENOENT' });
  await f.put('Empty', []); await fs.unlink(path.join(f.sessions, 'Empty.messages.ndjson'));
  assert.equal((await f.api.source.inspect('Empty')).head.messageCount, 0);
}));

test('[F3] index namespace: an index-root junction to a forged tree is refused by the per-level lstat', () => withFixture(async f => {
  await f.put('Forged', [row('forged namespace needle')]); await f.index.step();
  const indexRoot = path.join(f.sessions, '_fulltext-index-v1'), forged = path.join(f.directory, 'forged-index');
  await fs.cp(indexRoot, forged, { recursive: true });
  const restore = await swapForJunction(indexRoot, forged, indexRoot + '-real');
  try { await assert.rejects(f.index.search('forged namespace needle'), { code: 'session_fulltext.owned_namespace_changed' }); }
  finally { await restore(); }
  assert.ok((await f.index.search('forged namespace needle')).results.length, 'restored namespace searches again');
}));

test('[F3] index namespace: an ancestor junction above the data root is refused by the deepest-level realpath (index present)', () => withFixture(async f => {
  await f.put('Above', [row('above namespace needle')]); await f.index.step();
  // 各级目录本身都是真目录(lstat 全过),只有数据根之上的一级是 junction:只有最深一级的 realpath 看得见。fixture 的
  // authorize 不读源头,所以先撞上的是索引 manifest 的目录链核对(否则要到回读源头时才以 owner_alias 拒绝)。
  const keep = f.directory + '-real', restore = await swapForJunction(f.directory, keep, keep);
  try { await assert.rejects(f.index.search('above namespace needle'), { code: 'session_fulltext.owned_namespace_changed' }); }
  finally { await restore(); }
}));

test('[F3] cost: one single-session search does fewer lstat/realpath calls than before', () => withFixture(async f => {
  await f.put('Counted', [row('counted namespace needle')]); await f.index.step();
  await f.index.search('counted namespace needle');
  // 每次 manifest 读的目录链从 6 次降到 4 次:3 次 lstat(浅到深)+ 最深一级 1 次 realpath(加文件本身 1 次 lstat);
  // 连同 02 的 select(8→5)一起,数一次单会话搜索的总调用。
  const { counts } = await countingFs(() => f.index.search('counted namespace needle'));
  // 修前同一次搜索 lstat 33 + realpath 31 = 64(02 每次 select 8 次、manifest 目录链 6 次);现在 26 + 15 = 41。
  assert.ok(counts.lstat + counts.realpath <= 41, `lstat ${counts.lstat} + realpath ${counts.realpath} for one single-session search`);
}));

test('[F3] index namespace: ancestor junction with a missing session index directory still refuses (no silent "no index")', () => withFixture(async f => {
  await f.put('Ghost', [row('ghost namespace needle')]); await f.index.step();
  await fs.rm(path.join(f.sessions, '_fulltext-index-v1', 'Ghost'), { recursive: true, force: true });
  // The fixture authorizes without reading the source, so the namespace check is the first thing that sees the alias.
  const keep = f.directory + '-real', restore = await swapForJunction(f.directory, keep, keep);
  try { await assert.rejects(f.index.search('ghost namespace needle'), { code: 'session_fulltext.owned_namespace_changed' }); }
  finally { await restore(); }
}));

// 13as with a minimal host (same shape as fulltext-source-serial [S4]): count epoch re-reads and their concurrency.
const SRC = path.resolve(__dirname, '../../ruyi-workbench/app/src/13as-session-fulltext-consumers.js');
function consumers({ sessions = 50, failAt = null, delay = 2 }) {
  const counts = { epoch: 0, ids: new Set(), inFlight: 0, maxInFlight: 0 };
  const ids = Array.from({ length: sessions }, (_, n) => 'S' + String(n).padStart(4, '0'));
  const epochs = new Map(ids.map(id => [id, 'e'.repeat(64)])), armed = { on: false };
  const source = {
    sequence: () => '1',
    epoch: async id => { counts.epoch++; counts.ids.add(id); counts.inFlight++; counts.maxInFlight = Math.max(counts.maxInFlight, counts.inFlight);
      try { await new Promise(resolve => setTimeout(resolve, delay)); if (armed.on && id === ids[failAt]) throw Object.assign(Error('fixture'), { code: 'fixture.epoch_failed' }); return epochs.get(id); } finally { counts.inFlight--; } },
    inspect: async id => ({ head: { kind: 'quick_ask', id }, epoch: epochs.get(id), sequence: '1' }),
    scan: async () => null,
  };
  const context = vm.createContext({ require, structuredClone, Buffer, SessionFullTextHooks: {} });
  const ns = vm.runInContext(require('node:fs').readFileSync(SRC, 'utf8').replace(/\n\/\/ Lazy composition:[\s\S]*$/, '\n') + '\nSessionFullTextConsumers;', context);
  const privacy = { disclosurePolicyGuard: () => () => {}, withPolicy: (_, work) => work(), foreignView: v => v,
    prepareLocalDisclosure: async (_sid, build) => ({ value: await build(), assert() {} }), displayText: async (_sid, value) => value };
  const hooks = ns.create({ readConfig: async () => ({}), configGeneration: () => 0, uiAuthority: async () => ({ scopeId: 'ui', assert() {}, revalidate: async () => {} }),
    modelAuthority: async () => { throw Error('unused'); }, source: () => source, catalog: async () => ids.slice(), metadata: head => ({ id: head.id, cwd: '' }),
    projectKey: () => '', terms: () => [], redact: v => v, privacy, bindIndex: () => ({}), sourceSerial: () => 0 });
  const ui = work => { const req = new EventEmitter(), res = new EventEmitter(); return hooks.withUI(req, res, null, work); };
  return { hooks, ui, counts, epochs, ids, armed };
}

test('[F4] the bounded closing re-read still covers every authorized source and keeps concurrency bounded', async () => {
  const f = consumers({ sessions: 50 });
  await f.ui(async () => { await f.hooks.metadata(); f.counts.epoch = 0; f.counts.ids.clear(); f.counts.maxInFlight = 0; });
  assert.equal(f.counts.ids.size, 50, 'every authorized source is re-read once at the exit');
  assert.equal(f.counts.epoch, 50);
  // 修前是 4 个一批(在飞 ≤4、等最慢的);现在是宽 8 的滑动窗口。
  assert.ok(f.counts.maxInFlight > 4 && f.counts.maxInFlight <= 8, `in flight ${f.counts.maxInFlight}`);
  await assert.rejects(f.ui(async () => { await f.hooks.metadata(); f.epochs.set(f.ids[49], 'f'.repeat(64)); }), { code: 'session_search.source_changed' }, 'the last source counts too');
});

test('[F4] a failing re-read stops new launches and surfaces that failure', async () => {
  const f = consumers({ sessions: 60, failAt: 3 });
  await assert.rejects(f.ui(async () => { await f.hooks.metadata(); f.counts.epoch = 0; f.armed.on = true; }), { code: 'fixture.epoch_failed' });
  assert.ok(f.counts.epoch <= 3 + 1 + 8, `launched ${f.counts.epoch} re-reads after the failure point`);
});

// [F5] 真入口:13as + 13ap + 02 真源,在起点授权(metadata)之后、出口复核之前动盘。
test('[F5] real entry: root junction swap, body rename-replace and head rewrite after authorization all refuse; untouched control passes', async t => {
  const { fixture: consumerFixture } = require('../lib/fulltext-consumer-fixture.js');
  for (const mode of ['none', 'junction', 'body-replace', 'head-rewrite']) {
    const f = await consumerFixture(); t.after(() => f.close());
    const head = title => ({ title, cwd: f.directory, kind: 'mission', updatedAt: '2026-10-24T08:00:00.000Z' });
    await f.put('Alpha', [{ role: 'user', id: 'm1', turnSeq: 1, content: 'zebra quokka needle text' }], { head: head('Alpha thread') });
    await f.put('Beta', [{ role: 'user', id: 'm2', turnSeq: 1, content: 'unrelated body' }], { head: head('BetaOldTitle') });
    const entry = f.installEntrypoints(), original = f.context.SessionFullTextHooks.metadata;
    let restore = null;
    f.context.SessionFullTextHooks.metadata = async (...args) => {
      const out = await original(...args);
      if (mode === 'junction') { const keep = f.sessions + '-real'; restore = await swapForJunction(f.sessions, keep, keep); }
      if (mode === 'body-replace') { const body = path.join(f.sessions, 'Beta.messages.ndjson'), next = body + '.next'; await fs.writeFile(next, await fs.readFile(body)); await fs.rename(next, body); }
      if (mode === 'head-rewrite') { const file = path.join(f.sessions, 'Beta.json'); await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('BetaOldTitle', 'BetaNewTitle')); }
      return out;
    };
    try {
      if (mode === 'none') {
        const value = await entry.threadHistorySearch({ q: 'zebra quokka' }, f.ctx);
        assert.deepEqual(value.results.flatMap(item => item.relatedThreads || []).map(item => item.title), ['BetaOldTitle'], 'control');
      } else await assert.rejects(entry.threadHistorySearch({ q: 'zebra quokka' }, f.ctx), error => /source_changed|owner_alias|owned_namespace_changed|deleted|source_denied/.test(String(error.code || error.message)), mode);
    } finally { if (restore) await restore(); }
  }
});

// [F6] 13ap orderedPool 的重排窗口有界(2F 复审应改 1/2):排头那条回读很慢时,后面最多再起 width-1 条,不会因为
// 「stop()/width() 只看已按序交付的结果」而一路把整库读完;已完成没交付的结果因此最多压 width 条(峰值内存有界)。
async function slowFirstIndex(f, sessions) {
  for (let n = 0; n < sessions; n++) await f.put('P' + String(n).padStart(2, '0'), [row((n % 3 ? 'broad keyword ' : 'broad keyword exact phrase ') + 'filler ' + n, { id: 'm' })]);
  const epochs = new Map(), state = { scans: 0, slow: false, first: null, startedWhileFirstPending: 0, firstPending: false };
  const host = { ...f.host, authorizedEpoch: sid => f.allowed.get(sid) !== false ? epochs.get(sid) ?? null : null,
    scan: async (...args) => { state.scans++; if (state.firstPending) state.startedWhileFirstPending++;
      if (state.slow && state.first === null) { state.first = args[0]; state.firstPending = true; await new Promise(resolve => setTimeout(resolve, 400)); state.firstPending = false; }
      return f.host.scan(...args); } };
  const index = vm.runInNewContext('SessionFullTextIndex', f.hookContext).create({ ...host, resultUnit: 'sessions' });
  for (let n = 0; n < Math.ceil(sessions / 16) + 1; n++) await index.step(16);
  for (const sid of f.catalog) epochs.set(sid, await f.host.epoch(sid));
  await index.search('broad keyword', null, 5);   // warm coverage proofs so the counts below are the candidate re-reads
  const arm = () => { state.scans = 0; state.slow = true; state.first = null; state.startedWhileFirstPending = 0; };
  return { index, state, arm };
}

test('[F6] a slow first candidate does not collapse the lexical preview early stop (re-reads <= cap + 4 + width)', () => withFixture(async f => {
  const { index, state, arm } = await slowFirstIndex(f, 80);
  const normal = await index.search('broad keyword exact', null, 5, { lexicalOnly: true });
  arm(); const slow = await index.search('broad keyword exact', null, 5, { lexicalOnly: true });
  assert.ok(state.scans <= 5 + 4 + 8, `preview re-read ${state.scans} of 80 sources with a slow first candidate`);
  assert.deepEqual(slow.results.map(r => r.reference.sessionId), normal.results.map(r => r.reference.sessionId), 'same top results');
  assert.equal(slow.previewIncomplete, true);
}));

test('[F6] while the head re-read is pending, at most width-1 further re-reads start (finished-but-uncommitted results stay bounded)', () => withFixture(async f => {
  const { index, state, arm } = await slowFirstIndex(f, 40);
  arm(); const full = await index.search('broad keyword exact', null, 5);
  assert.ok(state.scans >= 40, `the full search still re-reads every candidate (${state.scans})`);
  assert.ok(state.startedWhileFirstPending >= 1 && state.startedWhileFirstPending <= 7, `started ${state.startedWhileFirstPending} re-reads behind the slow head`);
  assert.equal(full.coverage.indexedSessions, 40);
}));
