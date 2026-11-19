'use strict';
// 151 阶段 2 / 150 号文 S8、S9、S13 与「预算不够一片」「超时回复不等进程观测」「语义关零开销」:
//   [B1] S13 来源解析途中撞截止:已编好的批次照样计入本次覆盖(修前整次抛出 → cachedFragments=0,前端误判「语义没进展」);
//   [B2] S8 回验合并:多批编码时权威复核(authorize/epoch)只在来源解析时与 score 结束后各一次,不再乘以批数;
//        编码中途外部改盘(不推进程内 sequence)由结束时的权威复核拦下,整次报 source_changed;
//   [B3] 剩下的预算连一片都编不完时不再解析下一批来源(修前读完正文才发现编不了);
//   [B4] S9 worker 不回 workerEncodeMs 时用往返计时更新估计(修前估计永远停在初值,4 条一批要留 592 ms);
//   [B5] 编码超时先回话再收进程:回复不等那次进程观测(Windows 上是一次 PowerShell,约 0.8 s);
//   [B6] 语义关(调用方传 semanticDisabled)时零语义开销:不建语义行、不碰运行时。
const { test } = require('node:test');
const a = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), vm = require('node:vm'), cp = require('node:child_process');
const { fixture } = require('../lib/fulltext-owned-producer-fixture');
const { killOwnTree } = require('../lib/kill-own-tree');
const SRC = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const read = name => fs.readFileSync(path.join(SRC, name), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function virtualClock(start = 1e6) { let now = start; class VirtualDate extends Date { static now() { return now; } } return { Date: VirtualDate, now: () => now, set: value => { now = value; }, advance: async ms => { now += ms; await new Promise(resolve => setImmediate(resolve)); } }; }
// 13ap 与 06ha 只经 Date.now() 读时间:两边换成同一只冻结的虚拟钟,预算与截止在任何机器负载下都是确定的(2C 复审应改 2)。
const primitiveApi = (DateClass = Date) => vm.runInNewContext(read('06ha-semantic-retrieval.js') + '\nSemanticRetrieval;', { require, Date: DateClass });
const text = n => `第${n}号会话的正文,`.padEnd(150, '文');

async function corpus(t, count = 6) {
  const f = await fixture(); t.after(() => f.close());
  f.clock = virtualClock(Date.now()); f.hookContext.Date = f.clock.Date;
  for (let n = 0; n < count; n++) await f.put('S' + n, [{ role: 'user', id: 'm' + n, content: (n === 0 ? 'needle ' : '') + text(n) }]);
  return f;
}
const indexWith = (f, runtime, host = f.host) => vm.runInNewContext('SessionFullTextIndex', f.hookContext).create({ ...host, resultUnit: 'sessions', semantic: primitiveApi(f.clock ? f.clock.Date : Date).create(runtime) });
const fakeRuntime = (onEncode = async () => {}, documentVector = [1, 0]) => ({ calls: { prepare: 0, documents: 0 },
  async prepare() { this.calls.prepare++; return { available: true, modelFingerprint: 'fake-budget' }; },
  async encode(texts, options) { if (options.role === 'document') this.calls.documents += texts.length; await onEncode(texts, options); return { ok: true, modelFingerprint: 'fake-budget', vectors: texts.map(() => options.role === 'query' ? [1, 0] : documentVector) }; } });

test('[B1] a deadline hit while resolving a later batch keeps the batches already encoded in this call', async t => {
  const f = await corpus(t);
  const runtime = fakeRuntime(), index = indexWith(f, runtime);
  await index.step(16);
  let armed = false;
  // Resolving the third session's source runs past the semantic deadline (the source owner is slow right then):
  // the frozen clock jumps 2 s inside that source read, nowhere else.
  f.scan(async id => { if (id === 'S2' && armed) { armed = false; f.clock.set(f.clock.now() + 2000); } });
  armed = true;
  const result = await index.search('needle', null, 10, { deadline: f.clock.now() + 600 });
  a.equal(result.semantic.status, 'timeout');
  a.ok(runtime.calls.documents >= 4, 'the first batch was encoded before the slow source');
  a.ok(result.semantic.cachedFragments >= 4, `encoded fragments are reported, not dropped (cached ${result.semantic.cachedFragments})`);
  a.equal(result.results[0].reference.sessionId, 'S0', 'lexical result unaffected');
});

test('[B2] authoritative source checks are made at resolution and once after scoring, not once per encoded batch', async t => {
  const f = await corpus(t, 8);
  let checks = 0;
  const host = { ...f.host, authorize: async (...args) => { checks++; return f.host.authorize(...args); }, epoch: async (...args) => { checks++; return f.host.epoch(...args); } };
  // Orthogonal document vectors: nothing is admitted semantically, so both indexes disclose the same lexical hit and
  // the difference in authoritative checks is exactly what the semantic scoring pass itself performed.
  const runtime = fakeRuntime(async () => {}, [0, 1]), index = indexWith(f, runtime, host);
  const lexicalOnly = vm.runInNewContext('SessionFullTextIndex', f.hookContext).create({ ...host, resultUnit: 'sessions' });
  await index.step(16);
  checks = 0; const reference = await lexicalOnly.search('needle', null, 10); const baseline = checks;
  checks = 0; const result = await index.search('needle', null, 10); const semanticChecks = checks - baseline;
  a.equal(result.semantic.coverage, 'complete'); a.deepEqual(result.results.map(row => row.reference.sessionId), reference.results.map(row => row.reference.sessionId));
  a.ok(runtime.calls.documents >= 16, 'several document batches were encoded');
  // Resolution (authorize + epoch per source) and the closing pass (authorize + epoch per source): 4 per source.
  // Pre-fix every batch re-ran authorize + epoch for each active source before and after encoding and after resolving.
  a.ok(semanticChecks <= 8 * 4, `semantic pass made ${semanticChecks} authoritative checks for 8 sources`);
});

test('[B2] an external rewrite of an encoded source during scoring is refused by the closing authoritative check', async t => {
  const f = await corpus(t, 4);
  let armed = false;
  const runtime = fakeRuntime(async (texts, options) => { if (armed && options.role === 'document') { armed = false;
    // Written behind the source owner's back: no in-process sequence bump, only the on-disk stamp changes.
    await fsp.appendFile(path.join(f.sessions, 'S1.messages.ndjson'), ''); const file = path.join(f.sessions, 'S1.messages.ndjson'), now = new Date(Date.now() + 5000); await fsp.utimes(file, now, now); } });
  const index = indexWith(f, runtime);
  await index.step(16); armed = true;
  await a.rejects(index.search('needle', null, 10), error => ['session_fulltext.source_changed', 'session_fulltext.source_denied', 'session_fulltext.disclosure_changed'].includes(error.code));
});

test('[B3] when the remaining budget cannot fit one document, the next batch source is not resolved', async () => {
  const clock = virtualClock();
  const api = vm.runInNewContext(read('06ha-semantic-retrieval.js') + '\nSemanticRetrieval;', { require, Buffer, Date: clock.Date, setTimeout: () => { throw Error('real timer'); }, clearTimeout: () => {} });
  let resolves = 0, documents = 0;
  const semantic = api.create({ prepare: async () => ({ available: true, modelFingerprint: 'virtual' }), estimateEncodingBudget: (role, count) => role === 'document' ? 150 * count : 10,
    encode: async (texts, options) => { if (options.role === 'query') { await clock.advance(100); return { ok: true, modelFingerprint: 'virtual', vectors: [[1, 0]] }; } documents += texts.length; return { ok: true, modelFingerprint: 'virtual', vectors: texts.map(() => [1, 0]) }; } });
  const result = await semantic.score('query', ['a', 'b', 'c'], { scopeId: 's', identities: [0, 1, 2], deadlineMs: 200, resolveTexts: async indices => { resolves++; return indices.map(n => 'payload ' + n); } });
  a.equal(result.status, 'timeout');
  a.equal(resolves, 0, 'no source resolution once one fragment no longer fits the remaining 100 ms (needs 150)');
  a.equal(documents, 0);
});

const runtimeSource = read('06hb-semantic-runtime.js');
const fingerprint = 'c'.repeat(64);
function client({ worker, observeExitMs = 0 }) {
  const context = vm.createContext({ SemanticRuntimeHooks: {}, Buffer, setTimeout, clearTimeout, Date, require, process, __dirname, WeakRef });
  const api = vm.runInContext(runtimeSource + '\n;SemanticRuntimeClient;', context);
  const children = [], exited = child => child.exitCode !== null || child.signalCode !== null;
  const instance = api.create({ enabled: async () => true, startupMs: 5000,
    settings: () => ({ command: process.execPath, args: ['-e', worker], env: {}, cwd: process.cwd() }),
    spawn: (...args) => { const child = cp.spawn(...args); children.push(child); return child; },
    // Identity is immediate; the post-exit observation is slow, like Get-Process through PowerShell.
    observe: async pid => { const child = children.find(row => row.pid === pid); if (!child || exited(child)) { await delay(observeExitMs); return { exists: false }; } return { exists: true, pid, creationFileTime: '133' + pid }; } });
  return { client: instance, async close() { try { await instance.stop('disabled'); } catch { /* below */ } for (const child of children) if (!exited(child)) killOwnTree(child); } };
}
const ready = `console.log(JSON.stringify({type:'ready',modelFingerprint:'${fingerprint}',dimensions:8}));`;

test('[B4] without workerEncodeMs the encoding estimate follows measured round trips', async () => {
  const worker = `const readline=require('node:readline');${ready}readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);setTimeout(()=>console.log(JSON.stringify({ok:true,requestId:r.requestId,modelFingerprint:'${fingerprint}',vectors:r.texts.map(()=>[1,0,0,0,0,0,0,0])})),5*r.texts.length);});`;
  const f = client({ worker });
  try {
    a.equal((await f.client.prepare({ budgetMs: 5000, deadline: Date.now() + 5000 })).available, true);
    const initial = f.client.estimateEncodingBudget('document', 4);
    for (let n = 0; n < 6; n++) a.equal((await f.client.encode(['a', 'b', 'c', 'd'], { role: 'document', budgetMs: 1000 })).ok, true);
    const learned = f.client.estimateEncodingBudget('document', 4);
    a.ok(learned < initial / 2, `estimate for 4 documents moved from ${initial} ms to ${learned} ms`);
  } finally { await f.close(); }
});

test('[B5] an encode timeout replies at its own deadline instead of waiting for the slow process observation', async () => {
  // Answers the warmup, then never answers again; exits when its stdin closes.
  const worker = `const readline=require('node:readline');${ready}let n=0;readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(++n===1)console.log(JSON.stringify({ok:true,requestId:r.requestId,modelFingerprint:'${fingerprint}',vectors:r.texts.map(()=>[1,0,0,0,0,0,0,0])}));});`;
  const f = client({ worker, observeExitMs: 1500 });
  try {
    a.equal((await f.client.prepare({ budgetMs: 5000, deadline: Date.now() + 5000 })).available, true);
    const began = Date.now();
    const result = await f.client.encode(['x'], { role: 'query', budgetMs: 300 });
    const elapsed = Date.now() - began;
    a.equal(result.ok, false); a.equal(result.reason, 'timeout');
    a.ok(elapsed < 1200, `timeout replied after ${elapsed} ms (observation takes 1500 ms)`);
    // The owner is being collected: a request right after sees it unavailable rather than writing to it.
    const next = await f.client.encode(['y'], { role: 'query', budgetMs: 300 });
    a.equal(next.ok, false);
  } finally { await f.close(); }
});

test('[B7] a lexical preview re-reads only enough candidate sources for its cap and returns the same top results', async t => {
  const f = await fixture(); t.after(() => f.close());
  for (let n = 0; n < 40; n++) await f.put('P' + String(n).padStart(2, '0'), [{ role: 'user', id: 'm', content: (n % 3 ? 'broad keyword ' : 'broad keyword exact phrase ') + text(n) }]);
  // authorizedEpoch (as the production consumer provides) lets coverage reuse its per-source proofs, so the scan count
  // below is the candidate re-read itself.
  const epochs = new Map();
  let scans = 0; const host = { ...f.host, scan: async (...args) => { scans++; return f.host.scan(...args); }, authorizedEpoch: sid => f.allowed.get(sid) !== false ? epochs.get(sid) ?? null : null };
  const index = vm.runInNewContext('SessionFullTextIndex', f.hookContext).create({ ...host, resultUnit: 'sessions' });
  for (let n = 0; n < 4; n++) await index.step(16);
  for (const sid of f.catalog) epochs.set(sid, await f.host.epoch(sid));
  await index.search('broad keyword', null, 5);   // warm the per-source coverage proofs
  scans = 0; const full = await index.search('broad keyword exact', null, 5); const fullScans = scans;
  scans = 0; const preview = await index.search('broad keyword exact', null, 5, { lexicalOnly: true }); const previewScans = scans;
  a.equal(full.coverage.indexedSessions, 40);
  a.deepEqual(preview.results.map(row => row.reference.sessionId), full.results.map(row => row.reference.sessionId));
  a.ok(fullScans >= 40, `full search re-reads every candidate source (${fullScans})`);
  a.equal(preview.previewIncomplete, true, 'a preview that stopped early says so (13as maps it to partial:true)'); a.equal(full.previewIncomplete, undefined);
  a.ok(previewScans <= 5 + 4 + 4, `preview re-read ${previewScans} sources for a cap of 5`);
});

test('[B6] semanticDisabled skips semantic rows and never touches the runtime', async t => {
  const f = await corpus(t, 3);
  const runtime = fakeRuntime(), index = indexWith(f, runtime);
  await index.step(16);
  const off = await index.search('needle', null, 10, { semanticDisabled: true });
  a.equal(runtime.calls.prepare, 0, 'runtime not prepared');
  a.equal(off.semantic.status, 'disabled'); a.equal(off.semantic.candidateFragments, 0);
  a.equal(off.results[0].reference.sessionId, 'S0');
  // 关键词先回、语义后补:调用方本发还在建索引时传 semanticDeferred —— 只交词法、语义标 deferred,不碰运行时。
  const later = await index.search('needle', null, 10, { semanticDeferred: true });
  a.equal(runtime.calls.prepare, 0); a.equal(later.semantic.status, 'deferred'); a.equal(later.results[0].reference.sessionId, 'S0');
  const on = await index.search('needle', null, 10);
  a.ok(runtime.calls.prepare > 0 && on.semantic.candidateFragments > 0, 'the same index still scores when semantic is on');
});

// 150 S6 时间片的两条边界(复审建议 6):默认 1.5 s 片、每发至少推进 16 个(修前的保证)、每发至多推进 256 个。
// 时钟冻结,只在每访问一个会话(build 的第一步读 epoch)时推进固定毫秒;epoch 回非 HEX 让 build 立刻返回,不碰磁盘 ——
// 被钉的是「每发推进几个」这条调度规则本身,与机器负载无关。
async function slices(t, count, msPerSession) {
  const f = await fixture(); t.after(() => f.close());
  const ids = Array.from({ length: count }, (_, n) => 'T' + String(n).padStart(3, '0'));
  const clock = virtualClock(Date.now()); f.hookContext.Date = clock.Date;
  let visited = 0;
  const host = { ...f.host, catalog: async () => ids.slice(), epoch: async () => { visited++; clock.set(clock.now() + msPerSession); return null; } };
  const index = vm.runInNewContext('SessionFullTextIndex', f.hookContext).create(host);
  return async () => { visited = 0; const progress = await index.prepare(null, { incremental: true, threadSearch: true }); return { visited, done: progress.done }; };
}
test('[B8] the default thread-search slice is 1.5 s of preparation, never fewer than 16 sessions', async t => {
  const timed = await slices(t, 40, 50);   // 50 ms per session: the 1.5 s slice ends after exactly 30
  a.deepEqual(await timed(), { visited: 30, done: false }); a.deepEqual(await timed(), { visited: 10, done: true });
  const slow = await slices(t, 20, 200);   // would end after 8; the pre-fix guarantee of 16 per call still holds
  a.deepEqual(await slow(), { visited: 16, done: false }); a.deepEqual(await slow(), { visited: 4, done: true });
});
test('[B8] one thread-search call never advances more than 256 sessions even when the clock never moves', async t => {
  const frozen = await slices(t, 260, 0);
  a.deepEqual(await frozen(), { visited: 256, done: false }); a.deepEqual(await frozen(), { visited: 4, done: true });
});

// 复审建议 4:工作数据维护期间的迁移编解码会重写 _fulltext-index-v1 而不经 beginMutation;进出维护各推一次
// mutationSerial,revalidate 与覆盖率沿用 manifest 的捷径因此失效、照旧重读。
test('[B9] index files rewritten during a maintenance pause are re-read by revalidate, not trusted from the search', async t => {
  const f = await corpus(t, 2);
  const index = vm.runInNewContext('SessionFullTextIndex', f.hookContext).create({ ...f.host, resultUnit: 'sessions' });
  await index.step(16);
  const result = await index.search('needle', null, 10);
  a.equal((await index.revalidate(result, null)).changed, 0, 'control: nothing changed');
  index.setMaintenancePaused(true);
  // Stand-in for a migration codec rewriting the owned namespace without beginMutation.
  await fsp.unlink(path.join(f.sessions, '_fulltext-index-v1', 'S0', 'manifest.json'));
  index.setMaintenancePaused(false);
  a.ok((await index.revalidate(result, null)).changed >= 1, 'the rewritten manifest is noticed');
});
