'use strict';
// 151 阶段 4A(150 S6、S7、S14、S15、U5):后台增量建索引、持久向量、短查询语义噪声与命中方式。
//   [G1] 后台调度器在请求之外建索引:搜索本身不建(首次搜索只付词法成本),逐片推进后全部可搜;
//   [G2] S7 单个会话超出预算 → 跳过标记、换下一个,不挡后面的会话;到期后加倍预算重试并建成;
//   [G3] 后台提交与搜索读租约互斥:持租约期间不换 manifest,放掉后才提交;
//   [G4] 维护期与撤权:维护暂停时一片不写;索引关时不建;语义关时不编码、不落向量(S15);
//   [G5] S14 向量落盘:重启后不再编码文档片段就有语义命中(不需暖机);加密档下向量文件是密封载体、不落明文;
//   [G6] S14 删除一条会话只清它自己的向量(盘上与进程内),别的会话不重编;
//   [G7] 撤权即停:编码途中语义被关 / 会话被改写 → 不再编码、不落盘;
//   [G8] U5 短查询(「大巴」)余弦 0.58 的噪声不进结果,长查询照常;每条结果标命中方式(lexical / semantic / both)。
const { test } = require('node:test');
const a = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), vm = require('node:vm');
const { fixture } = require('../lib/fulltext-owned-producer-fixture');
const SRC = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const semanticApi = () => vm.runInNewContext(fs.readFileSync(path.join(SRC, '06ha-semantic-retrieval.js'), 'utf8') + '\nSemanticRetrieval;', { require, Date });
const MODEL = 'fake-background-encoder';
const DESCRIPTOR = { available: true, modelFingerprint: MODEL, modelId: 'synthetic-scalar-model', retrievalThresholds: { search: 0.34 } };
// 「大巴」「客车」同义 → [1,0,0];「解释」类口头语与「大巴」余弦 0.58(150 U5 实测的噪声量级);其余正交。
const embed = text => /大巴|客车/.test(text) ? [1, 0, 0] : /解释/.test(text) ? [0.58, Math.sqrt(1 - 0.58 * 0.58), 0] : [0, 0, 1];
function runtime() {
  const calls = { documents: 0, queries: 0, documentTexts: [] };
  return { calls, descriptor: () => ({ ...DESCRIPTOR }), prepare: async () => ({ ...DESCRIPTOR }), estimateEncodingBudget: (_role, n) => n * 10,
    async encode(texts, options) { if (options.beforeEncode) await options.beforeEncode(); if (options.role === 'document') { calls.documents += texts.length; calls.documentTexts.push(...texts); } else calls.queries++;
      if (this.onEncode) await this.onEncode(texts, options); return { ok: true, modelFingerprint: MODEL, vectors: texts.map(embed) }; } };
}
function create(f, { policy = { index: true, semantic: true }, encoder = null, searchRuntime = null, vectors = true, extra = {} } = {}) {
  return vm.runInNewContext('SessionFullTextIndex', f.hookContext).create({ ...f.host, resultUnit: 'sessions', vectors,
    backgroundPolicy: async () => ({ ...policy }), ...(encoder ? { encoder } : {}), ...(searchRuntime ? { semantic: semanticApi().create(searchRuntime) } : {}), ...extra });
}
async function settle(index, max = 200) { let outcome; for (let n = 0; n < max; n++) { outcome = await index.backgroundTick(); if (!outcome.again || outcome.retryLater) return outcome; } throw Error('background did not settle'); }
const indexDir = f => path.join(f.sessions, '_fulltext-index-v1');
const exists = file => fs.existsSync(file);
const manifests = f => exists(indexDir(f)) ? fs.readdirSync(indexDir(f)).filter(name => exists(path.join(indexDir(f), name, 'manifest.json'))) : [];
function virtualClock(f) { let now = Date.now(); class VirtualDate extends Date { static now() { return now; } } f.hookContext.Date = VirtualDate; return { advance: ms => { now += ms; }, now: () => now }; }

test('[G1] the background builder indexes outside any request; search itself builds nothing', async t => {
  const f = await fixture(); t.after(() => f.close());
  for (let n = 0; n < 24; n++) await f.put('S' + String(n).padStart(2, '0'), [{ role: 'user', id: 'm' + n, content: `第 ${n} 条会话:回滚预案与常规说明` }]);
  const index = create(f, { policy: { index: true, semantic: false } });
  const first = await index.search('回滚预案', null, 30);
  a.equal(manifests(f).length, 0, 'a search never builds the index');
  a.equal(first.coverage.pendingSessions, 24);
  index.backgroundKick();
  const outcome = await settle(index);
  a.equal(outcome.again, false);
  a.equal(manifests(f).length, 24, 'every session was built by background slices');
  const after = await index.search('回滚预案', null, 30);
  a.equal(after.coverage.complete, true);
  a.equal(after.results.length, 24);
  a.equal(after.coverage.background.state, 'idle');
  a.ok(index.backgroundComplete(), 'complete flag set after a full pass');
  a.ok(after.results.every(row => row.matchMode === 'lexical'), 'lexical-only results are marked lexical');
});

test('[G2] a session over its budget is skipped and marked; later sessions still build; retry with a doubled budget succeeds', async t => {
  const f = await fixture(); t.after(() => f.close());
  const clock = virtualClock(f);
  await f.put('A1', [{ role: 'user', id: 'a', content: '普通会话一 needle' }]);
  await f.put('BIG', [{ role: 'user', id: 'b', content: '大文本 needle '.repeat(2000) }]);
  await f.put('C1', [{ role: 'user', id: 'c', content: '普通会话二 needle' }]);
  await f.put('C2', [{ role: 'user', id: 'd', content: '普通会话三 needle' }]);
  let slow = true;
  // BIG 的正文读一次「耗时」31 s(虚拟钟),超过首轮 30 s 预算。
  f.scan(async id => { if (id === 'BIG' && slow) clock.advance(31000); });
  const index = create(f, { policy: { index: true, semantic: false } });
  index.backgroundKick(); await settle(index);
  a.deepEqual(manifests(f).sort(), ['A1', 'C1', 'C2'], 'sessions after the oversized one are not blocked');
  const partial = await index.search('needle', null, 30);
  a.equal(partial.coverage.background.skippedSessions, 1);
  a.deepEqual([...partial.coverage.background.skipped], ['budget']);
  a.equal(partial.coverage.complete, false);
  a.equal(index.backgroundComplete(), false);
  slow = false; clock.advance(61000);
  await settle(index);
  a.deepEqual(manifests(f).sort(), ['A1', 'BIG', 'C1', 'C2'], 'the skipped session is retried after its backoff and built');
  const complete = await index.search('needle', null, 30);
  a.equal(complete.coverage.complete, true);
  a.equal(complete.coverage.background.skippedSessions, 0);
});

test('[G3] a background commit waits for search read leases', async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.put('L1', [{ role: 'user', id: 'a', content: 'lease needle' }]);
  const index = create(f, { policy: { index: true, semantic: false } });
  let release = null, taken;const leased = new Promise(resolve => { taken = resolve; });
  f.scan(async id => { if (id === 'L1' && !release) { release = await index.beginRead(); taken(); } });
  index.backgroundKick();
  const tick = settle(index);
  await leased;
  a.ok(release, 'lease was taken while the session was being built');
  for (let n = 0; n < 50; n++) await new Promise(resolve => setImmediate(resolve));
  a.equal(exists(path.join(indexDir(f), 'L1', 'manifest.json')), false, 'no manifest is committed while a read lease is held');
  release();
  await tick;
  a.equal(exists(path.join(indexDir(f), 'L1', 'manifest.json')), true, 'commit proceeds after the lease is released');
});

test('[G4] maintenance pause, a disabled index and disabled semantics stop background work', async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.put('M1', [{ role: 'user', id: 'a', content: '大巴 维护期' }]);
  const encoder = runtime(), policy = { index: true, semantic: true };
  const index = create(f, { policy, encoder });
  index.setMaintenancePaused(true); index.backgroundKick();
  await settle(index);
  a.equal(manifests(f).length, 0, 'nothing is written inside the maintenance window');
  index.setMaintenancePaused(false);
  policy.index = false; await settle(index);
  a.equal(manifests(f).length, 0, 'index disabled: no background build');
  policy.index = true; policy.semantic = false; await settle(index);
  a.equal(manifests(f).length, 1);
  a.equal(encoder.calls.documents, 0, 'S15: semantic off encodes nothing in the background');
  a.equal(exists(path.join(indexDir(f), 'M1', 'vectors.json')), false, 'semantic off writes no vectors');
  policy.semantic = true; index.backgroundKick({ force: true }); await settle(index);
  a.ok(encoder.calls.documents > 0, 'semantic on: background encodes');
  a.equal(exists(path.join(indexDir(f), 'M1', 'vectors.json')), true);
});

for (const encrypted of [false, true]) test(`[G5] persisted vectors survive a restart without re-encoding (${encrypted ? 'encrypted' : 'plain'})`, async t => {
  const f = await fixture({ enabled: encrypted }); t.after(() => f.close());
  await f.put('L', [{ role: 'user', id: 'l', content: '明天坐大巴去机场' }]);
  await f.put('S', [{ role: 'user', id: 's', content: '长途客车的时刻表' }]);
  await f.put('O', [{ role: 'user', id: 'o', content: '完全无关的话题' }]);
  const encoder = runtime(), index = create(f, { encoder });
  index.backgroundKick(); await settle(index);
  a.ok(encoder.calls.documents >= 3);
  const file = path.join(indexDir(f), 'S', 'vectors.json'), raw = await fsp.readFile(file, 'utf8');
  if (encrypted) { a.match(raw, /^\{[^\n]*"workData"\s*:\s*3\b/, 'sealed carrier'); a.ok(!raw.includes(MODEL) && !raw.includes('fulltext-window'), 'no plaintext record in the sealed vector file'); }
  else { const value = JSON.parse(raw); a.equal(value.model, MODEL); a.equal(value.sessionId, 'S'); }
  const restarted = runtime(), fresh = create(f, { searchRuntime: restarted });
  const result = await fresh.search('大巴', null, 10, { deferDocumentEncoding: true });
  a.equal(restarted.calls.documents, 0, 'no document fragment is encoded after restart');
  a.equal(restarted.calls.queries, 1, 'only the query is encoded');
  const synonym = result.results.find(row => row.reference.sessionId === 'S');
  a.ok(synonym, 'semantic-only hit comes from the persisted vectors');
  a.equal(synonym.matchMode, 'semantic');
  a.equal(result.results.find(row => row.reference.sessionId === 'L').matchMode, 'both');
  a.ok(result.semantic.cachedFragments >= 3);
});

test('[G6] deleting one session clears only its own vectors', async t => {
  const f = await fixture(); t.after(() => f.close());
  for (const id of ['A', 'B', 'C']) await f.put(id, [{ role: 'user', id, content: id + ' 坐大巴去 ' + id }]);
  const encoder = runtime(), index = create(f, { encoder });
  index.backgroundKick(); await settle(index);
  await index.search('大巴', null, 10, { deferDocumentEncoding: true });
  const cached = index.vectorsCached();
  f.catalog.splice(f.catalog.indexOf('B'), 1);
  await index.invalidate('B', true);
  a.equal(exists(path.join(indexDir(f), 'B')), false, 'the deleted session namespace (with its vectors) is gone');
  a.equal(exists(path.join(indexDir(f), 'A', 'vectors.json')), true);
  a.equal(exists(path.join(indexDir(f), 'C', 'vectors.json')), true);
  a.equal(index.vectorsCached(), cached - 1, 'only the deleted session leaves the in-memory vector cache');
  // In-request cache (no persisted store): deleting one session must not re-encode the others.
  const g = await fixture(); t.after(() => g.close());
  for (const id of ['A', 'B', 'C']) await g.put(id, [{ role: 'user', id, content: id + ' 坐大巴去 ' + id }]);
  const live = runtime(), plain = create(g, { searchRuntime: live, vectors: false });
  await plain.step(16); await plain.search('大巴', null, 10);
  const encoded = live.calls.documents;
  g.catalog.splice(g.catalog.indexOf('B'), 1); await plain.invalidate('B', true);
  await plain.search('大巴', null, 10);
  a.equal(live.calls.documents, encoded, 'remaining sessions keep their cached vectors (pre-fix: the whole cache was cleared)');
});

test('[G7] revocation mid-encoding stops encoding and nothing stale is persisted', async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.put('R', [{ role: 'user', id: 'r', content: Array.from({ length: 200 }, (_, n) => `第${n}句话说到大巴。`).join('') }]);
  const policy = { index: true, semantic: true }, encoder = runtime(), file = path.join(indexDir(f), 'R', 'vectors.json');
  let batches = 0; encoder.onEncode = async (_texts, options) => { if (options.role === 'document' && ++batches === 1) policy.semantic = false; };
  const index = create(f, { policy, encoder });
  index.backgroundKick(); await settle(index);
  a.equal(batches, 1, 'no further batch after semantics were switched off');
  a.equal(exists(file), false, 'no vector file after revocation');
  // Rewrite of the session while a batch is in flight: nothing from the old body is encoded after it or persisted.
  policy.semantic = true; batches = 0; let cut = -1;
  encoder.onEncode = async (_texts, options) => { if (options.role === 'document' && ++batches === 1) { await f.put('R', [{ role: 'user', id: 'r', content: '改写后的内容' }]); cut = encoder.calls.documentTexts.length; } };
  index.backgroundKick(); await settle(index);
  a.ok(cut > 0, 'the rewrite happened during an encoding batch');
  a.equal(exists(file), false, 'the stale batch is never written');
  encoder.onEncode = null; index.backgroundKick({ force: true }); await settle(index);
  a.ok(encoder.calls.documentTexts.slice(cut).every(text => !/大巴/.test(text)), 'old content is not encoded after the rewrite');
  const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
  a.equal(Object.keys(raw.entries).length, 1, 'only the rewritten content is persisted');
});

test('[G8] short queries keep semantic noise out; long queries unchanged; every hit carries its match mode', async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.put('L', [{ role: 'user', id: 'l', content: '明天坐大巴去机场' }]);
  await f.put('S', [{ role: 'user', id: 's', content: '长途客车的时刻表' }]);
  await f.put('N', [{ role: 'user', id: 'n', content: '这里再解释一下。' }]);
  const index = create(f, { searchRuntime: runtime(), vectors: false });
  await index.step(16);
  const short = await index.search('大巴', null, 10);
  const ids = short.results.map(row => row.reference.sessionId);
  a.ok(ids.includes('L') && ids.includes('S'), 'lexical hit and a high-confidence synonym stay');
  a.ok(!ids.includes('N'), 'cos 0.58 noise is not admitted for a 2-character query');
  const modes = Object.fromEntries(short.results.map(row => [row.reference.sessionId, row.matchMode]));
  a.equal(modes.L, 'both'); a.equal(modes.S, 'semantic');
  const long = await index.search('明天坐大巴去机场的安排', null, 10);
  a.ok(long.results.some(row => row.reference.sessionId === 'N' && row.matchMode === 'semantic'), 'longer queries keep the ordinary admission threshold');
  a.ok(short.semantic.shortQueryFiltered >= 1, 'the short-query filter reports how many semantic-only hits it dropped');
  const both = short.results.find(row => row.reference.sessionId === 'L');
  a.match(both.snippet, /大巴/, 'a hit matched both ways keeps the keyword excerpt');
});

// ── 4A 复审(v2) ────────────────────────────────────────────────────────────────────────────
const { AsyncLocalStorage } = require('node:async_hooks');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('[G9] F1 background timers never inherit a request-scoped (restricted) catalog', async t => {
  const f = await fixture(); t.after(() => f.close());
  for (const id of ['S1', 'S2', 'S3']) await f.put(id, [{ role: 'user', id: 'm' + id, content: 'needle text ' + id }]);
  const als = new AsyncLocalStorage();
  const index = create(f, { policy: { index: true, semantic: false }, extra: { timers: { setTimeout, clearTimeout },
    catalog: async () => { const restricted = als.getStore(); return restricted ? [...restricted] : [...f.catalog]; } } });
  index.backgroundKick(); for (let n = 0; n < 200 && manifests(f).length < 3; n++) await sleep(20);
  a.deepEqual(manifests(f), ['S1', 'S2', 'S3']);
  await als.run(['S1'], async () => { index.backgroundKick({ force: true }); await sleep(400); });
  for (let n = 0; n < 100 && index.backgroundStatus().state !== 'idle'; n++) await sleep(20);
  await sleep(200);
  a.deepEqual(manifests(f), ['S1', 'S2', 'S3'], 'a kick inside an exact-session request does not purge other sessions');
});

test('[G10] F2 a rebuild prunes vectors of edited-away text; semantic off removes vector files', async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.put('E', [{ role: 'user', id: 'e1', content: '大巴 已删除的内容 ' + 'x'.repeat(300) }, { role: 'user', id: 'e2', content: '第二条 大巴' }]);
  await f.put('K', [{ role: 'user', id: 'k1', content: '保留的会话 大巴' }]);
  const policy = { index: true, semantic: true }, encoder = runtime(), index = create(f, { policy, encoder });
  index.backgroundKick(); await settle(index);
  const file = id => path.join(indexDir(f), id, 'vectors.json'), entries = id => Object.keys(JSON.parse(fs.readFileSync(file(id), 'utf8')).entries).length;
  const before = entries('E');
  a.ok(before > 1);
  // Encoder now unavailable: only the lexical rebuild runs, and it must still prune.
  encoder.descriptor = () => ({ available: false, state: 'failed', reason: 'unavailable' });
  // Edit away the second message (a rewind-style truncation); the first message keeps its ordinal and windows.
  await f.put('E', [{ role: 'user', id: 'e1', content: '大巴 已删除的内容 ' + 'x'.repeat(300) }]);
  index.backgroundKick({ force: true }); await settle(index);
  a.equal(entries('E'), before - 1, `the removed message's window is pruned, the rest kept (before ${before})`);
  const raw = fs.readFileSync(file('E'), 'utf8'); a.ok(!/第二条/.test(raw));
  a.ok(entries('K') >= 1, 'other sessions untouched');
  policy.semantic = false; policy.index = false; index.backgroundKick(); await settle(index);
  a.equal(fs.existsSync(file('E')), false); a.equal(fs.existsSync(file('K')), false, 'semantic off: vector files removed');
});

test('[G11] F3 a queued delete does not wait for a long background build', async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.put('A', [{ role: 'user', id: 'a', content: 'small' }]);
  const rows = []; for (let n = 0; n < 40; n++) rows.push({ role: 'user', id: 'b' + n, content: 'big row ' + n });
  await f.put('BIG', rows); await f.put('C', [{ role: 'user', id: 'c', content: 'small c' }]);
  let slow = false; f.scan(async id => { if (id === 'BIG' && slow) await sleep(50); });
  const index = create(f, { policy: { index: true, semantic: false } });
  index.backgroundKick(); await settle(index);
  await f.put('BIG', rows.concat([{ role: 'user', id: 'bx', content: 'more' }]));
  slow = true; index.backgroundKick({ force: true });
  const tick = index.backgroundTick(); await sleep(100);
  const t0 = Date.now(); await index.invalidate('A', true); const waited = Date.now() - t0;
  await tick; slow = false;
  a.ok(waited < 1000, `delete waited ${waited} ms (pre-fix: the whole ~2 s build)`);
  a.equal(index.backgroundStatus().skippedSessions, 0, 'yielding leaves no skip marker');
  f.catalog.splice(f.catalog.indexOf('A'), 1); index.backgroundKick(); await settle(index);
  a.ok(manifests(f).includes('BIG'), 'the yielded session is rebuilt afterwards');
});

test('[G12] F4 searches naming a skipped session keep its marker, backoff and doubled budget', async t => {
  const f = await fixture(); t.after(() => f.close());
  let now = Date.now(); class VirtualDate extends Date { static now() { return now; } } f.hookContext.Date = VirtualDate;
  await f.put('A1', [{ role: 'user', id: 'a', content: 'needle a' }]); await f.put('BIG', [{ role: 'user', id: 'b', content: 'needle big' }]);
  let attempts = 0; f.scan(async id => { if (id === 'BIG') { attempts++; now += 31000; } });
  const index = create(f, { policy: { index: true, semantic: false } });
  index.backgroundKick(); await settle(index);
  const first = attempts;
  for (let round = 0; round < 4; round++) {
    const found = await index.search('needle', null, 30);
    a.equal(found.coverage.background.skippedSessions, 1, 'skip marker still reported');
    index.backgroundKick({ result: found }); await settle(index);
  }
  a.equal(attempts, first, 'no fresh 30 s attempt per search');
  // 每次建要读两遍正文(预读 + 建),各 +31 s:30 s → 60 s 仍不够,到 120 s 才建成 —— 预算确实在逐次加倍。
  for (let n = 0; n < 4 && !manifests(f).includes('BIG'); n++) { now += 20 * 60000; index.backgroundKick(); await settle(index); }
  a.ok(manifests(f).includes('BIG'), 'after the backoff the doubled budget builds it');
});

test('[G13] F5 the background stays quiet during and right after a keyword-first-screen lease', async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.put('Q', [{ role: 'user', id: 'q', content: 'quiet needle' }]);
  const index = create(f, { policy: { index: true, semantic: false } });
  const release = await index.beginRead({ priority: true });
  index.backgroundKick();
  const during = await index.backgroundTick(); a.equal(during.again, true); a.equal(manifests(f).length, 0, 'nothing built while a first-screen read is open');
  release();
  const after = await index.backgroundTick(); a.equal(after.again, true); a.ok(after.delay > 1000, `quiet window ${after.delay} ms`); a.equal(manifests(f).length, 0);
  await sleep(after.delay + 50); await settle(index);
  a.deepEqual(manifests(f), ['Q']);
});

// ── 4A 二审(v3) ────────────────────────────────────────────────────────────────────────────
async function drive(index, ms) { const end = Date.now() + ms; let outcome; while (Date.now() < end) { outcome = await index.backgroundTick(); if (!outcome.again) return outcome; await sleep(Math.min(outcome.delay || 0, 500)); } return outcome; }

test('[G14] (c) steady turns: a slow session yields at most twice, then builds through; it stays pending (not complete) meanwhile', async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.put('A', [{ role: 'user', id: 'a', content: 'needle a' }]);
  const rows = []; for (let n = 0; n < 30; n++) rows.push({ role: 'user', id: 'b' + n, content: 'needle big ' + n });
  await f.put('BIG', rows);
  let busy = false, visits = 0; f.scan(async (id, _row, n) => { if (id === 'BIG') { visits++; if (n === 20) busy = true; } });
  const index = create(f, { policy: { index: true, semantic: false }, extra: { idle: () => !busy } });
  index.backgroundKick();
  await index.backgroundTick();
  a.equal(manifests(f).includes('BIG'), false);
  a.equal(index.backgroundComplete(), false, 'a yielded session keeps the pass incomplete');
  await drive(index, 12000);
  a.ok(manifests(f).includes('BIG'), `built under steady turns (row visits ${visits})`);
  a.equal(busy, true, 'the host never became idle');
  a.equal(index.backgroundStatus().skippedSessions, 0);
});

test('[G14b] (c) agent-run-only busyness never aborts an in-progress build', async t => {
  const f = await fixture(); t.after(() => f.close());
  const rows = []; for (let n = 0; n < 30; n++) rows.push({ role: 'user', id: 'b' + n, content: 'needle big ' + n });
  await f.put('BIG', rows);
  let scans = 0; f.scan(async (id, _row, n) => { if (id === 'BIG' && n === 0) scans++; });
  const index = create(f, { policy: { index: true, semantic: false }, extra: { idle: () => true, busy: () => true } });
  index.backgroundKick(); await drive(index, 8000);
  a.ok(manifests(f).includes('BIG')); a.equal(scans, 2, 'one build (preview + body scan), never restarted');
});

test('[G15] (e) background batches stay small; a foreground encode during a background batch succeeds within its budget', async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.put('L', [{ role: 'user', id: 'l', content: Array.from({ length: 60 }, (_, n) => `第${n}句话讲到大巴的安排。`).join('') }]);
  let inFlight = false, maxBatch = 0, overloaded = 0;
  const firstDocument = Promise.withResolvers();
  const shared = { descriptor: () => ({ ...DESCRIPTOR }), prepare: async () => ({ ...DESCRIPTOR }), estimateEncodingBudget: (_r, n) => n * 60,
    async encode(texts, options) { if (inFlight) { overloaded++; return { ok: false, reason: 'overloaded' }; } inFlight = true;
      try { if (options.role === 'document') { maxBatch = Math.max(maxBatch, texts.length); firstDocument.resolve(); } await sleep(options.role === 'document' ? 100 : 20); return { ok: true, modelFingerprint: MODEL, vectors: texts.map(embed) }; } finally { inFlight = false; } } };
  // 夹具的 vm 上下文没有计时器;生产里批间 50 ms 的空档靠它。
  f.hookContext.setTimeout = setTimeout;
  const index = create(f, { encoder: shared, extra: { timers: { setTimeout: null } } });
  index.backgroundKick(); await index.backgroundTick();
  // 前台的 06ha 跑在带计时器的上下文里(生产里就是主上下文)。
  const foreground = vm.runInNewContext(fs.readFileSync(path.join(SRC, '06ha-semantic-retrieval.js'), 'utf8') + '\nSemanticRetrieval;', { require, Date, setTimeout }).create(shared);
  const background = drive(index, 20000);
  await Promise.race([firstDocument.promise, background.then(() => { throw Error('background did not submit a document'); })]);
  const t0 = Date.now(), scored = await foreground.score('大巴', ['坐大巴'], { scopeId: 'fg', deadlineMs: 250, identities: ['x'] });
  const spent = Date.now() - t0;
  await background;
  a.ok(maxBatch <= 2, `background batch ${maxBatch} texts (≤150 ms at 60 ms/text)`);
  a.ok(overloaded >= 1, 'the foreground call did meet a busy runtime');
  a.notEqual(scored.status, 'overloaded', `foreground scored instead of overloaded (${scored.status})`);
  a.ok(scored.scores.some(score => Number.isFinite(score)), 'foreground got a score');
  a.ok(spent <= 300, `within its own budget (${spent} ms)`);
});

test('[G15b] a slow single document can acquire a background lease and persist its vector', async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.put('SLOW', [{ role: 'user', id: 'slow', content: '坐大巴出发' }]);
  const encoder = runtime(), attempts = [];
  encoder.estimateEncodingBudget = (_role, count) => 1200 * count;
  encoder.encode = async (texts, options) => {
    attempts.push({ count: texts.length, ...options });
    if (Math.min(options.budgetMs ?? 1000, options.deadline - Date.now()) < 1200)
      return { ok: false, reason: 'timeout' };
    return { ok: true, modelFingerprint: MODEL, vectors: texts.map(embed) };
  };
  const index = create(f, { encoder });
  index.backgroundKick(); await settle(index);
  a.equal(attempts.length, 1);
  a.equal(attempts[0].count, 1);
  a.equal(attempts[0].maxWaitMs, 0);
  a.equal(attempts[0].priority, 'background');
  a.ok(attempts[0].budgetMs <= 8000);
  a.ok(exists(path.join(indexDir(f), 'SLOW', 'vectors.json')));
});

test('[G16] P6 semantic off→on in the middle of a purge re-encodes the purged sessions', async t => {
  const f = await fixture(); t.after(() => f.close());
  for (const id of ['V1', 'V2', 'V3']) await f.put(id, [{ role: 'user', id: 'm' + id, content: '大巴 ' + id }]);
  const policy = { index: true, semantic: true }, encoder = runtime();
  let idleSeq = null; const index = create(f, { policy, encoder, extra: { idle: () => idleSeq && idleSeq.length ? idleSeq.shift() : true } });
  index.backgroundKick(); await settle(index);
  policy.semantic = false; idleSeq = [true, true, true, true, false];
  await index.backgroundTick();
  const partial = ['V1', 'V2', 'V3'].map(id => fs.existsSync(path.join(indexDir(f), id, 'vectors.json')));
  a.ok(partial.some(Boolean) && partial.some(x => !x), `purge stopped mid-pass (${partial})`);
  policy.semantic = true; idleSeq = null;
  index.backgroundKick(); await settle(index);
  a.deepEqual(['V1', 'V2', 'V3'].map(id => fs.existsSync(path.join(indexDir(f), id, 'vectors.json'))), [true, true, true], 'every session has vectors again');
});

// ── 4A 三审(v4) ────────────────────────────────────────────────────────────────────────────
test('[G17] P7 retry waits are not learned as encoding cost: repeated collisions keep succeeding on one instance', async () => {
  let now = 10000, busyUntil = 0;
  class Clock extends Date { static now() { return now; } }
  const wait = (resolve, ms) => { now += ms; queueMicrotask(resolve); };
  const queryBudgets = [];
  const shared = { descriptor: () => ({ ...DESCRIPTOR }), prepare: async () => ({ ...DESCRIPTOR }),
    async encode(texts, options) {
      if (Clock.now() < busyUntil) return { ok: false, reason: 'overloaded' };
      if (options.role === 'query') queryBudgets.push(options.minimumBudgetMs);
      now += 5;
      return { ok: true, modelFingerprint: MODEL, vectors: texts.map(() => [1, 0, 0]) };
    } };
  const retrieval = vm.runInNewContext(fs.readFileSync(path.join(SRC, '06ha-semantic-retrieval.js'), 'utf8') + '\nSemanticRetrieval;', { require, Date: Clock, setTimeout: wait }).create(shared);
  const statuses = [];
  for (let n = 0; n < 4; n++) {
    busyUntil = Clock.now() + 120;
    statuses.push((await retrieval.score('query ' + n, ['doc ' + n], { scopeId: 's', deadlineMs: 250, identities: ['i' + n] })).status);
    now += 150;
  }
  a.equal(queryBudgets.length, 4);
  a.ok(queryBudgets.every(budget => budget <= queryBudgets[0]), 'retry waits never inflate the next query budget');
  a.deepEqual(statuses, ['ready', 'ready', 'ready', 'ready'], `every collision recovered within 250 ms (${statuses})`);
});

test('[G18] (b) a background build on a busy host is paced with timed gaps; on an idle host it is not', async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.put('BIG', [{ role: 'user', id: 'b', content: '工作台在大文本下建立全文索引需要分片处理。'.repeat(12000) }]);
  let paced = 0; f.hookContext.setTimeout = (fn, ms, ...rest) => { if (ms === 25) paced++; return setTimeout(fn, ms, ...rest); };
  let busy = true;
  const index = create(f, { policy: { index: true, semantic: false }, extra: { timers: { setTimeout: null }, idle: () => true, busy: () => busy } });
  index.backgroundKick(); await drive(index, 8000);
  a.ok(manifests(f).includes('BIG')); a.ok(paced > 0, `busy host: ${paced} paced gaps during the build`);
  // Idle host: same build without pacing.
  await f.put('BIG', [{ role: 'user', id: 'b', content: '另一段需要重新建索引的大文本内容。'.repeat(12000) }]);
  busy = false; paced = 0; index.backgroundKick({ force: true }); await drive(index, 20000);
  a.equal(paced, 0, 'idle host: no paced gaps');
});

test('[G10] 152 L4: Gemma sessions are background-encoded into schema 2 with the sha256 of each original window', async t => {
  const f = await fixture(); t.after(() => f.close());
  const text = '明天坐大巴去机场';
  await f.put('G', [{ role: 'user', id: 'g', content: text }]);
  const encoder = runtime(), gemma = { ...DESCRIPTOR, modelId: 'embeddinggemma-2-text-q4' };
  encoder.descriptor = () => ({ ...gemma }); encoder.prepare = async () => ({ ...gemma });
  const index = create(f, { encoder });
  index.backgroundKick(); await settle(index);
  // Pre-fix: encodeUnit returned at once for the Gemma model, so no window was encoded and no file was written.
  a.ok(encoder.calls.documents > 0, 'the Gemma model is background-encoded');
  a.ok(encoder.calls.documentTexts.includes(text), 'the original spelling is what gets encoded');
  const value = JSON.parse(await fsp.readFile(path.join(indexDir(f), 'G', 'vectors.json'), 'utf8'));
  a.equal(value.schema, 2);
  a.deepEqual(Object.keys(value.texts).sort(), Object.keys(value.entries).sort());
  a.ok(Object.values(value.texts).includes(require('node:crypto').createHash('sha256').update(text).digest('hex')));
});

test('a qualified vector space survives restart and a mismatched space forces re-encoding', async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.put('SPACE', [{ id:'m', role:'user', content:'大巴前往机场' }]);
  const api = semanticApi(), model = api.windowPolicy.CONTRACT.modelFingerprint;
  f.hookContext.SemanticRetrieval = api;
  const encoder = runtime(), descriptor = { ...DESCRIPTOR, modelId:'embeddinggemma-2-text-q4', modelFingerprint:model };
  encoder.descriptor = () => descriptor;
  encoder.prepare = async () => descriptor;
  let encoded = 0;
  encoder.encode = async (texts, options) => {
    await options.beforeEncode?.();
    encoded += texts.length;
    return {ok:true, modelFingerprint:model, vectors:texts.map(() => [1,...Array(767).fill(0)])};
  };
  const build = async () => { const index = create(f, {encoder}); index.backgroundKick(); await settle(index); };
  await build();
  const file = path.join(indexDir(f), 'SPACE', 'vectors.json');
  const record = JSON.parse(await fsp.readFile(file));
  a.equal(record.schema, 3);
  a.match(record.space, /^sha256:[a-f0-9]{64}$/);
  a.deepEqual(Object.keys(record.texts), Object.keys(record.entries));
  await build(); a.equal(encoded, 1);
  await fsp.writeFile(file, JSON.stringify({...record, space:'sha256:' + '0'.repeat(64)}));
  await build(); a.equal(encoded, 2);
  const {space, ...legacy} = record;
  await fsp.writeFile(file, JSON.stringify({...legacy, schema:2, model:'old-worker'}));
  await build(); a.equal(encoded, 3);
});

test('a session exceeding the Gemma vector file capacity yields to the next session', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const clock = virtualClock(f);
  const large = Array.from({ length: 2000 }, (_, i) => ({ id: 'm' + i, role: 'user', content: 'sample row ' + i }));
  await f.put('A', large);
  await f.put('B', [{ id: 'last', role: 'user', content: 'next session' }]);
  const encoder = runtime();
  encoder.descriptor = () => ({ ...DESCRIPTOR, modelId: 'embeddinggemma-2-text-q4' });
  const vector = Array(768).fill(0);
  vector[0] = 1;
  let count = 0;
  encoder.encode = async texts => {
    count += texts.length;
    // Make each remaining batch exhaust a slice once the file nears its limit.
    if (count >= 1940) clock.advance(1000);
    return { ok: true, modelFingerprint: MODEL, vectors: texts.map(() => vector) };
  };
  const index = create(f, { encoder });
  await settle(index, 12);
  const stored = sid => JSON.parse(fs.readFileSync(path.join(indexDir(f), sid, 'vectors.json'), 'utf8')).entries;
  a.ok(Object.keys(stored('A')).length < large.length);
  a.equal(Object.keys(stored('B')).length, 1);
});

test('a new query scans each reopened Gemma body as often as an in-memory query', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const token = Object.freeze({});
  Object.assign(f.hookContext, {
    SemanticRuntimeTransportProof: {
      snapshot: () => token, verify: result => result, method: () => token, isMethod: value => value === token,
      lifecycle: () => token,
    },
  });
  const policy = fs.readFileSync(path.join(SRC, '06h9-semantic-policy.js'), 'utf8');
  const scorer = fs.readFileSync(path.join(SRC, '06ha-semantic-retrieval.js'), 'utf8');
  const api = vm.runInContext(policy + '\n' + scorer + '\n({ SemanticRetrieval, SemanticWindowPolicy });', f.hookContext);
  const model = api.SemanticWindowPolicy.CONTRACT;
  const descriptor = { ...DESCRIPTOR, policyReady: true, modelFingerprint: model.modelFingerprint, modelId: model.modelId };
  const encoder = runtime();
  encoder.prepare = async () => descriptor;
  encoder.descriptor = () => descriptor;
  let documents = 0;
  encoder.encode = async (texts, opts) => {
    await opts.beforeEncode?.();
    if (opts.role === 'document') documents += texts.length;
    const vector = Array(768).fill(0);
    vector[opts.role === 'query' ? 0 : 1] = 1;
    return { ok: true, modelFingerprint: model.modelFingerprint, vectors: texts.map(() => vector) };
  };
  await f.put('A', [{ role: 'user', id: 'first', content: 'apple tree' }]);
  await f.put('B', [{ role: 'user', id: 'first', content: 'orange tree' }]);
  await settle(create(f, { encoder }));
  a.equal(documents, 2);

  let scans = 0;
  const fresh = create(f, { extra: {
    semantic: api.SemanticRetrieval.create(encoder),
    async scan(...args) { scans++; return f.host.scan(...args); },
  } });
  async function measure(query) {
    scans = 0;
    const result = await fresh.search(query, null, 5, { method: token, deadline: Date.now() + 15000 });
    a.equal(result.semantic.coverage, 'complete');
    a.equal(result.semantic.status, 'ready');
    a.equal(result.results.length, 0);
    return scans;
  }
  const cold = await measure('unrelated journey');
  const hot = await measure('different journey');
  a.ok(hot >= 2, 'each source was verified');
  a.equal(cold, hot, 'persisted-vector backfill provides the body proofs used by final verification');
  a.equal(documents, 2, 'both searches used the persisted vectors');
});
