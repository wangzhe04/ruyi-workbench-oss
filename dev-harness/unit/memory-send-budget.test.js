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
