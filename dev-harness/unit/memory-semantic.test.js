'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/06hc-memory-semantic.js'), 'utf8');
const factory = vm.runInNewContext(source + '\nMemorySemanticRecall;', { MemorySemanticHooks: {} });
function fixture(score) {
  const entries = [{ id: 'a' }, { id: 'rule-fill' }, { id: 'b' }, { id: 'legacy-vector' }], fillKeys = new Set(['rule-fill']);
  const calls = [];
  const host = { fallback: () => ({ entries, fillKeys }), enabled: () => true, lexical: () => [{ entry: entries[0], shared: 1 }, { entry: entries[2], shared: 1 }], key: entry => entry.id, text: entry => entry.id, score: async (query, texts, options) => { calls.push({ query, texts, options }); return score; } };
  return { entries, fillKeys, calls, rank: factory.create(host).rank };
}
test('semantic memory reranking preserves membership, rule slots, fillKeys and legacy-only slots', async () => {
  const f = fixture({ status: 'ready', scores: [.1, .9], modelFingerprint: 'model-1' });
  const phases = [];
  const result = await f.rank([], 'query', 4, {}, { scopeId: 'project-a', check: async phase => phases.push(phase) });
  assert.deepEqual(Array.from(result.entries, entry => entry.id), ['b', 'rule-fill', 'a', 'legacy-vector']);
  assert.equal(result.fillKeys, f.fillKeys); assert.deepEqual(phases, ['start', 'finish']);
  assert.deepEqual(Array.from(f.calls[0].texts), ['a', 'b']); assert.equal(f.calls[0].options.purpose, 'rerank');
  assert.equal(result.semantic.automaticCandidates, false);
});
test('disabled memory semantic path does not prepare or encode', async () => {
  const f = fixture({ status: 'ready', scores: [1, 0] }); const result = await f.rank([], 'query', 4, { semanticRetrievalV1: false });
  assert.equal(result.entries, f.entries); assert.equal(result.semantic.status, 'disabled'); assert.equal(f.calls.length, 0);
});
test('disabled and budget exits still revalidate authority before returning baseline', async () => {
  const f = fixture({ status: 'ready', scores: [1, 0] });
  await assert.rejects(f.rank([], 'query', 4, { semanticRetrievalV1: false }, { check: async phase => { if (phase === 'finish') throw Error('memory_semantic.stale'); } }), /memory_semantic.stale/);
  assert.equal(f.calls.length, 0);
});
test('availability, timeout and truncated results preserve the entire previous ranking', async () => {
  for (const status of ['unavailable', 'loading', 'timeout', 'overloaded', 'partial', 'truncated']) {
    const f = fixture({ status, scores: [.1, .9] }); const checks = [];
    const result = await f.rank([], 'query', 4, {}, { check: async phase => checks.push(phase) });
    assert.equal(result.entries, f.entries); assert.equal(result.fillKeys, f.fillKeys); assert.deepEqual(checks, ['start', 'finish']);
  }
});
test('authority or revision failures never return a fallback ranking', async () => {
  const f = fixture({ status: 'ready', scores: [.1, .9] });
  await assert.rejects(f.rank([], 'query', 4, {}, { check: async phase => { if (phase === 'finish') throw Object.assign(Error('work_data.key_unavailable'), { code: 'work_data.key_unavailable' }); } }), /work_data.key_unavailable/);
});
test('memory source guard reaches the scorer and blocks encode after asynchronous preparation', async () => {
  const entries = [{ id: 'a' }, { id: 'b' }]; let current = true, encoded = 0, scoreCalls = 0;
  const rank = factory.create({
    fallback: () => ({ entries, fillKeys: new Set() }), enabled: () => true,
    lexical: () => entries.map(entry => ({ entry, shared: 1 })), key: entry => entry.id, text: entry => entry.id,
    score: async (query, texts, options) => {
      scoreCalls++; assert.equal(typeof options.beforeEncode, 'function');
      await Promise.resolve(); current = false;
      await options.beforeEncode(); encoded++;
      return { status: 'ready', scores: [1, 0], modelFingerprint: 'model' };
    },
  }).rank;
  await assert.rejects(rank(entries, 'query', 2, {}, { check: async () => {
    if (!current) throw Object.assign(Error('privacy.source_revoked'), { code: 'privacy.source_revoked' });
  } }), { code: 'privacy.source_revoked' });
  assert.equal(scoreCalls, 1); assert.equal(encoded, 0);
});
test('explicit search coverage never declares failed or unadmitted encoding complete',async()=>{
  const entries=[{id:'header'}];
  for(const scored of [{status:'timeout',scores:[null],coverage:{cached:0,total:1,complete:false}},
    {status:'unavailable',scores:[null]},
    {status:'ready',scores:[1],coverage:{cached:1,total:1,complete:true}}]){
    const search=factory.create({enabled:()=>true,lexical:()=>[],key:entry=>entry.id,text:entry=>entry.id,score:async()=>scored}).search;
    const result=await search(entries,'query',20,{});
    assert.equal(result.semantic.coverage.complete,false);assert.equal(result.semantic.coverage.admissionEvaluated,false);
    assert.equal(result.semantic.coverage.encodedFragments,scored.coverage?.cached??0);assert.equal(result.entries.length,0);
  }
});
test('explicit search names its bounded first-header selection and admits only scored accepted fragments',async()=>{
  const entries=Array.from({length:70},(_,i)=>({id:'h'+i}));
  const search=factory.create({enabled:()=>true,lexical:()=>[],key:entry=>entry.id,text:entry=>entry.id,score:async(_query,texts)=>({status:'ready',scores:texts.map(()=>1),coverage:{cached:texts.length,total:texts.length,complete:true},admission:{policyId:'test-admission',accepted:texts.map((_,i)=>i===63)}})}).search;
  const result=await search(entries,'query',20,{});assert.deepEqual(Array.from(result.entries,entry=>entry.id),['h63']);
  assert.equal(result.semantic.coverage.selection,'first-64-eligible-headers');assert.equal(result.semantic.coverage.candidateHeaders,70);
  assert.equal(result.semantic.coverage.selectedHeaders,64);assert.equal(result.semantic.coverage.omittedHeaders,6);assert.equal(result.semantic.coverage.complete,false);
});
