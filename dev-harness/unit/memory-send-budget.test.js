'use strict';
// 152 L1/L2: send-time memory recall is bounded, and header vectors are shared across sessions.
const { test } = require('node:test');
const a = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { functionBlock, constBlock } = require('../lib/source-slice');
const source = name => fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');

// Same production modules as semantic-gemma2-memory-observation.test.js; the fake codec sleeps per text.
function setup({ msPerText = 30 } = {}) {
  const fakeToken = Object.freeze({});
  const c = vm.createContext({ require, Buffer, Date, WeakRef, crypto, setTimeout, clearTimeout, MemorySemanticHooks: {},
    SemanticRuntimeTransportProof: Object.freeze({ snapshot: () => fakeToken, verify: result => ({ ...result, vectors: result.vectors.map(v => v.slice()), truncated: result.truncated?.slice() }), method: () => fakeToken, isMethod: value => value === fakeToken, lifecycle: () => fakeToken }) });
  const retrieval = source('06h-retrieval-index.js');
  vm.runInContext([constBlock(source('00-boot.js'), 'SemanticFailurePolicy'), source('06h9-semantic-policy.js'), source('06ha-semantic-retrieval.js'),
    constBlock(retrieval, 'RETRIEVAL_TEXT_CAP'), functionBlock(retrieval, 'retrievalTerms'), source('06hc-memory-semantic.js')].join('\n'), c);
  const model = vm.runInContext('SemanticWindowPolicy.CONTRACT', c), calls = [];
  c.testRuntime = {
    descriptor: () => ({ modelId: model.modelId, available: true }),
    prepare: async () => ({ available: true, policyReady: true, modelId: model.modelId, modelFingerprint: model.modelFingerprint, retrievalThresholds: { search: .70, automatic: null } }),
    encode: async (texts, opts) => {
      await opts.beforeEncode?.();
      calls.push({ role: opts.role, texts: [...texts], scopeId: opts.scopeId });
      await new Promise(resolve => setTimeout(resolve, msPerText * texts.length));
      return { ok: true, modelFingerprint: model.modelFingerprint, vectors: texts.map(text => { const score = opts.role === 'query' ? 1 : /accepted/.test(text) ? .9 : .1; return [score, Math.sqrt(1 - score * score), ...Array(766).fill(0)]; }) };
    },
  };
  const api = vm.runInContext('const scorer=SemanticRetrieval.create(testRuntime);({MemorySemanticRecall,score:scorer.score,prime:scorer.prime});', c);
  return { c, api, calls, model };
}
function recall(f, entries) {
  return f.api.MemorySemanticRecall.create({
    fallback: () => ({ entries: entries.slice(0, 3), fillKeys: new Set() }), enabled: () => true, budgetSafe: () => true,
    lexical: () => entries.slice(0, 3).map(entry => ({ entry, shared: 1, score: 1 })),
    key: entry => entry.id, text: entry => entry.text, searchText: entry => entry.text,
    descriptor: f.c.testRuntime.descriptor, score: f.api.score, prime: f.api.prime,
  });
}
test('L3 a memory header without coresummary carries its description once', () => {
  const build = vm.runInNewContext(constBlock(source('06d-memory-domain.js'), 'CORE_MEMORY_SUMMARY_CAP') + ';' + functionBlock(source('06d-memory-domain.js'), 'memorySemanticHeaderText') + ';memorySemanticHeaderText');
  const description = '部署前先冻结写入并核对备份校验和';
  // Pre-fix: [id, name, description, coresummary || description, type] repeated the description.
  const plain = build('deploy-freeze', { name: '发布冻结', description }, 'project');
  a.equal(plain.split(description).length - 1, 1);
  a.equal(plain, 'deploy-freeze 发布冻结 ' + description + ' project');
  a.equal(build('x', { name: 'n', description: 'd', coresummary: 'd' }, 'user'), 'x n d user');
  a.equal(build('x', { name: 'n', description: 'd', coresummary: 's' }, 'user'), 'x n d s user');
  a.equal(build('x', {}, 'user'), 'x x user');
});

const headers = n => Array.from({ length: n }, (_, i) => ({ id: 'm' + i, memoryVersion: '1', text: 'unrelated header number ' + i }));

test('L1 send-time recall answers within its budget with the keyword baseline when header vectors are cold', async () => {
  const f = setup(), entries = headers(128);
  const began = Date.now();
  // Pre-fix: no deadline reached the scorer, so this waited for all 128 headers (about 3.9 s with this codec).
  const r = await recall(f, entries).rank(entries, 'question', 8, {}, { scopeId: 'memory:s1:p', check: async () => {}, deadline: Date.now() + 400 });
  const elapsed = Date.now() - began;
  a.equal(docCalls(f), 0, 'cold sends leave all document encoding to prewarm');
  a.ok(elapsed <= 500, `send preflight took ${elapsed} ms`);
  a.deepEqual(Array.from(r.entries, e => e.id), ['m0', 'm1', 'm2']);
  a.notEqual(r.semantic.status, 'reranked');
  a.ok(r.semantic.fallback, 'the fallback is disclosed');
});

test('L1 the send preflight hands the scorer a bounded deadline (structural: the 06d call site)', () => {
  // Pre-fix the rank() context carried no deadline at all (F3 in 152), so the 06hc default below was the only bound.
  const body = functionBlock(source('06d-memory-domain.js'), 'resolveMemoryPreflight');
  const call = body.slice(body.indexOf('MemorySemanticHooks.rank('), body.indexOf('rankMemoriesForRecallDetailed(nonCore'));
  a.match(call, /deadline:\s*Date\.now\(\)\s*\+\s*MEMORY_SEND_SEMANTIC_BUDGET_MS/);
  const flags = vm.runInNewContext(constBlock(source('01c-runtime-flags.js'), 'MEMORY_SEND_SEMANTIC_BUDGET_MS') + ';MEMORY_SEND_SEMANTIC_BUDGET_MS');
  a.ok(flags > 0 && flags <= 1000, `send budget ${flags} ms`);
});

test('L1 without an explicit deadline the automatic path still uses the default send budget', async () => {
  const f = setup(), entries = headers(128);
  const began = Date.now();
  await recall(f, entries).rank(entries, 'question', 8, {}, { scopeId: 'memory:s1:p', check: async () => {} });
  a.ok(Date.now() - began <= 500, 'the default budget bounds the automatic path');
});

const docCalls = f => f.calls.filter(call => call.role === 'document').reduce((n, call) => n + call.texts.length, 0);
const sendContext = scopeId => ({ scopeId, check: async () => {}, deadline: Date.now() + 10000 });

test('L2 a second session in the same project reuses the header vectors (no document re-encode)', async () => {
  const f = setup({ msPerText: 1 }), entries = headers(20);
  const memory = recall(f, entries);
  const primed = await memory.prime(entries);
  a.equal(primed.status, 'ready');
  const first = docCalls(f);
  a.equal(first, entries.length);
  const r1 = await memory.rank(entries, 'question', 8, {}, sendContext('memory:session-1:p'));
  a.equal(r1.semantic.status, 'reranked');
  a.equal(docCalls(f), first);
  // Pre-fix: the document cache key and encode scope carried the session id, so this re-encoded every header.
  const r2 = await recall(f, entries).rank(entries, 'question', 8, {}, sendContext('memory:session-2:p'));
  a.equal(r2.semantic.status, 'reranked');
  a.equal(docCalls(f), first, 'the second session encoded only its query');
  a.ok(f.calls.filter(call => call.role === 'document').every(call => call.scopeId === 'memory-headers'));
});

test('L2 prime encodes exactly the rows a later send looks up, checking each source first', async () => {
  const f = setup({ msPerText: 1 }), entries = headers(12), checked = [];
  const memory = recall(f, entries);
  const primed = await memory.prime(entries, { check: async batch => { checked.push(...batch.map(e => e.id)); } });
  a.equal(primed.status, 'ready');
  a.equal(primed.encoded, primed.total);
  a.deepEqual([...new Set(checked)].sort(), entries.map(e => e.id).sort());
  const before = docCalls(f);
  const r = await memory.rank(entries, 'question', 8, {}, sendContext('memory:any-session:p'));
  a.equal(r.semantic.status, 'reranked');
  a.equal(docCalls(f), before, 'the send encoded no document after prime');
  a.ok(f.calls.filter(call => call.role === 'document').every(call => call.texts.length === 1), 'prime sends one text per batch');
});

test('L2 a failing source check stops prime before that header is encoded', async () => {
  const f = setup({ msPerText: 1 }), entries = headers(5), revoked = Error('revoked');
  await a.rejects(recall(f, entries).prime(entries, { check: async batch => { if (batch.includes(entries[2])) throw revoked; } }), error => error === revoked);
  a.equal(docCalls(f), 2);
});

test('L2 editing one memory re-encodes only that header', async () => {
  const f = setup({ msPerText: 1 }), entries = headers(10);
  const memory = recall(f, entries);
  await memory.prime(entries, {});
  const before = docCalls(f);
  const edited = entries.map((entry, i) => i === 4 ? { ...entry, memoryVersion: '2', text: 'accepted edited header' } : entry);
  const again = await memory.prime(edited, {});
  a.equal(again.status, 'ready');
  a.equal(docCalls(f) - before, 1);
});

// The production prewarm driver at the bottom of 06hc, with its 06d collaborators stubbed.
function driver({ entries, config = { semanticRetrievalV1: true, runtimeMemoryVectorRecallV1: true } }) {
  const f = setup({ msPerText: 1 });
  let library = 'v1';
  const authority = 'test-authority';
  const live = new Map(entries.map(e => [e.id, e]));
  const fileStamps = new Map(entries.map(e => [e.id, 1]));
  Object.assign(f.c, {
    SemanticRuntimeHooks: f.c.testRuntime, readConfig: async () => ({ ...config }), memoryVectorRecallEnabled: c => c?.runtimeMemoryVectorRecallV1 === true,
    memorySnapshotToken: async () => ({ library, config: 'c', capturedAt: Date.now(), libraryTrusted: true, configTrusted: true }),
    loadMemoryRegistry: async () => Object.assign(Array.from(live.values()), { authority }), memoryIsExpired: () => false,
    memoryBodyAuthority: async () => authority,
    memoryStatBaseline: registry => new Map(registry.map(e => [e.id, fileStamps.get(e.id)])),
    memoryEntriesUnchanged: async (batch, baseline) => batch.every(e => baseline.get(e.id) === fileStamps.get(e.id)),
    memoryRetrievalKey: e => e.id, memoryExplicitRetrievalText: e => e.text, memoryRetrievalText: e => e.text, projectKeyForCwd: cwd => 'project:' + cwd,
    rankMemoriesForRecallDetailed: () => ({ entries: [], fillKeys: new Set() }), rankRelevantMemoriesScored: () => [], memorySemanticBudgetSafe: () => true,
  });
  // setup() already evaluated all of 06hc in f.c; its host closures resolve these globals at call time.
  const prewarm = vm.runInContext('memoryHeaderPrewarm', f.c);
  const settle = async () => { for (let n = 0; n < 200 && prewarm.pending(); n++) await new Promise(resolve => setTimeout(resolve, 10)); };
  return { f, prewarm, settle, bump: () => { library = 'v' + Math.random(); },
    edit(entry) { live.set(entry.id, entry); fileStamps.set(entry.id, fileStamps.get(entry.id) + 1); } };
}

test('prewarm encodes exactly the entries the send path selected, and nothing when semantic recall is off', async () => {
  const entries = headers(6), d = driver({ entries });
  d.prewarm.schedule('C:/p', [entries[1], entries[3]]);
  await d.settle();
  a.deepEqual(d.f.calls.filter(c => c.role === 'document').flatMap(c => c.texts).sort(), [entries[1].text, entries[3].text].sort());
  const off = driver({ entries, config: { semanticRetrievalV1: true, runtimeMemoryVectorRecallV1: false } });
  off.prewarm.schedule('C:/p', entries);
  await off.settle();
  a.equal(off.f.calls.length, 0);
});

test('prewarm restarts its pass when the library changes mid-way and finishes the rest', async () => {
  const entries = headers(4), d = driver({ entries });
  let changed = false;
  const encode = d.f.c.testRuntime.encode;
  d.f.c.testRuntime.encode = async (texts, opts) => { const r = await encode(texts, opts); if (!changed) { changed = true; d.bump(); } return r; };
  d.prewarm.schedule('C:/p');
  await d.settle();
  const encoded = new Set(d.f.calls.filter(c => c.role === 'document').flatMap(c => c.texts));
  a.deepEqual([...encoded].sort(), entries.map(e => e.text).sort(), 'every header is cached after the restarted pass');
  a.equal(d.prewarm.pending(), 0);
});

test('prewarm rechecks the file at encode time after an in-place edit that leaves the directory token unchanged', async () => {
  const entries = headers(3), d = driver({ entries });
  const changed = { ...entries[1], memoryVersion: '2', text: 'revised memory header' };
  const encode = d.f.c.testRuntime.encode;
  let edited = false;
  d.f.c.testRuntime.encode = async (texts, options) => {
    if (!edited && texts.includes(entries[1].text)) {
      edited = true;
      d.edit(changed);
    }
    return encode(texts, options);
  };
  d.prewarm.schedule('C:/p', entries);
  await d.settle();
  a.ok(edited);
  const encoded = d.f.calls.flatMap(call => call.texts);
  a.ok(!encoded.includes(entries[1].text), 'the revoked text never reaches the encoder');
  a.ok(encoded.includes(changed.text), 'the restarted pass encodes the revised version');
});

test('a work-data key that locks before the background send prevents inference', async () => {
  const entries = headers(2), d = driver({ entries });
  const encode = d.f.c.testRuntime.encode;
  let locked = false;
  d.f.c.testRuntime.encode = async (texts, options) => {
    if (!locked) {
      locked = true;
      d.f.c.memoryBodyAuthority = async () => { throw Object.assign(Error('work_data_key.absent'), { code: 'work_data_key.absent' }); };
    }
    return encode(texts, options);
  };
  d.prewarm.schedule('C:/p', entries);
  await d.settle();
  a.ok(locked);
  a.equal(d.f.calls.length, 0);
  a.equal(d.prewarm.pending(), 0);
});
