'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const fixture = require('../semantic/calibration-fixture.cjs');
const { assess, identifiers } = require('../semantic/calibration-policy.cjs');
const pure = vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/06ha-semantic-retrieval.js'), 'utf8') + '\nSemanticRetrieval;', { require, Buffer, Date, setTimeout, clearTimeout });
test('development fixture separates missing facts from unrelated retrieval and corrective evidence', () => {
  assert.equal(fixture.releaseHoldout, false); assert.equal(fixture.documents.length, 60); assert.equal(fixture.queries.length, 310);
  assert.equal(new Set(fixture.documents.map(row => row.id)).size, fixture.documents.length);
  assert.equal(new Set(fixture.queries.map(row => row.id)).size, fixture.queries.length);
  assert.ok(fixture.documents.every(row => row.text.length <= 96));
  for (const row of fixture.queries) {
    assert.ok(['train', 'calibration', 'check'].includes(row.split));
    assert.ok(row.relevant.every(id => fixture.documents.some(doc => doc.id === id)));
    if (row.kind.startsWith('missing-')) { assert.equal(row.answerSupported, false); assert.ok(row.relevant.length); }
    if (row.kind === 'entity-mismatch' || row.kind === 'ood') assert.equal(row.relevant.length, 0);
    if (row.group === 'correction') { assert.equal(row.answerSupported, true); assert.ok(row.relevant.length); }
  }
});
test('structured identifiers are syntactic, Unicode-normalized and not a sample lookup', () => {
  assert.deepEqual(identifiers('Compare ＺＺ－９１ and zz-91 with AB_742.'), ['zz-91', 'ab_742']);
  assert.deepEqual(Array.from(pure.structuredIds('Compare ＺＺ－９１ and zz-91 with AB_742.')), ['zz-91', 'ab_742']);
  assert.equal(pure.structuredIds('zz-910').includes('zz-91'),false);
  assert.deepEqual(identifiers('48 kHz, 96000 Hz and three samples'), []);
  const policy = { id: 'test', minScore: .34, minGap: 0, minZ: 0, identifiers: true };
  assert.deepEqual(assess('Find UVW-528', ['UVW-528 rule', 'UVW-529 rule'], [.4, .9], policy).accepted, [true, false]);
  assert.deepEqual(assess('Must the rate be 96000 Hz?', ['The sample rate is 48000 Hz.'], [.8], policy).accepted, [true], 'a contradicted numerical presupposition can retrieve its corrective evidence');
});

test('content query experiment preserves negation, conditions, quantities and identifiers', () => {
  const {contentQuery}=require('../semantic/calibration-content-query.cjs');
  assert.equal(contentQuery('How do I inspect WHAT-91 before 08:30 without removing 12 bolts?').text,'inspect WHAT-91 before 08:30 without removing 12 bolts');
  assert.equal(contentQuery('是否不允许在-12.5度后打开XYZ-103？').text,'不允许在-12.5度后打开XYZ-103');
  assert.equal(contentQuery("Why can't CAN-9 run without 2 wheels?").text,"can't CAN-9 run without 2 wheels");
  assert.ok(contentQuery('几何标本的目的是什么？').text.includes('几何标本的目的'));
  assert.equal(contentQuery('What do I do?').text,'');
});
test('partial scoring does not pretend a complete background confidence decision', () => {
  const base = { id: 'test', minScore: .34, minGap: 0, minZ: 0, identifiers: false };
  assert.deepEqual(assess('q', ['a', 'b'], [.8, null], base, false).accepted, [true, null]);
  assert.deepEqual(assess('q', ['a', 'b'], [.8, null], { ...base, minGap: .02 }, false).accepted, [null, null]);
});
test('semantic absolute deadline is propagated and a prepared late worker gets no text', async () => {
  const expiry = Date.now() - 1; let encoded = 0, guarded = 0, deadline;
  const semantic = pure.create({ prepare: async options => { deadline = options.deadline; return { available: true, modelFingerprint: 'test' }; }, encode: async () => { encoded++; return { ok: false, reason: 'timeout' }; } });
  const result = await semantic.score('q', ['a'], { deadline: expiry, beforeEncode: async () => { guarded++; } });
  assert.equal(deadline, expiry); assert.equal(result.status, 'timeout'); assert.equal(encoded, 0); assert.ok(guarded > 0);
});
test('expired budget cannot suppress a source authority error', async () => {
  const semantic = pure.create({ prepare: async () => ({ available: true, modelFingerprint: 'test' }), encode: async () => assert.fail('No text may reach encoder') });
  await assert.rejects(semantic.score('q', ['a'], { deadline: Date.now() - 1, beforeEncode: async () => { throw Object.assign(Error('work_data.key_locked'), { code: 'work_data.key_locked' }); } }), { code: 'work_data.key_locked' });
});
test('insufficient tail budget stops cooperatively without sending a doomed batch', async () => {
  let encoded = 0;
  const semantic = pure.create({ prepare: async () => ({ available: true, modelFingerprint: 'test' }), encode: async () => { encoded++; assert.fail('No doomed request should reach the bridge'); } });
  const result = await semantic.score('q', ['a'], { deadline: Date.now() + 30 });
  assert.equal(result.status, 'timeout'); assert.equal(encoded, 0);
});
test('encoder receives a conservative minimum budget and known scores survive a later timeout', async () => {
  const calls = []; let documents = 0;
  const semantic = pure.create({ prepare: async () => ({ available: true, modelFingerprint: 'test', retrievalThresholds: { search: .5 } }),
    encode: async (texts, options) => { calls.push(options); if (options.role === 'document' && ++documents === 2) return { ok: false, reason: 'timeout' };
      return { ok: true, modelFingerprint: 'test', vectors: texts.map(() => [1, 0]) }; } });
  const result = await semantic.score('q', Array.from({ length: 8 }, (_, i) => 'doc-' + i));
  assert.equal(result.status, 'timeout'); assert.equal(result.scores.filter(Number.isFinite).length, 4);
  assert.ok(calls.every(options => options.minimumBudgetMs >= 64 && options.deadline <= Date.now() + 1000));
});
test('production admission keeps raw cosine and treats missing scores as unknown', async () => {
  const descriptor={available:true,modelFingerprint:'measured-test',modelId:pure.searchPolicy.modelId,retrievalThresholds:{search:.34,automatic:null}};
  const semantic=pure.create({prepare:async()=>descriptor,encode:async texts=>({ok:true,modelFingerprint:descriptor.modelFingerprint,vectors:texts.map(()=>[1,0])})});
  const result=await semantic.score('Inspect ZZ-91',['ZZ-91 rule','ZZ-92 rule','an unencoded rule'],{maxEncodeDocuments:2});
  assert.deepEqual(Array.from(result.scores),[1,1,null]);
  assert.deepEqual(Array.from(result.admission.accepted),[true,false,null]);
  assert.equal(result.admission.status,'partial');assert.equal(result.admission.answerability,'not-assessed');
  assert.equal(result.admission.policyId,pure.searchPolicy.id);
});
test('production policy agrees with the calibration audit descriptor and keeps automatic disabled',()=>{
  const policy=require('../../ruyi-workbench/semantic-runtime/search-admission-policy.json');
  const models=require('../../ruyi-workbench/semantic-runtime/models.lock.json'),model=models.models.find(row=>row.id===models.defaultModel);
  assert.equal(policy.policy.id,pure.searchPolicy.id);assert.equal(policy.policy.minimumCosine,pure.searchPolicy.minScore);
  assert.equal(model.retrievalThresholds.search,pure.searchPolicy.minScore);assert.equal(model.retrievalThresholds.automatic,null);
  assert.equal(model.retrievalPolicy.automatic,null);assert.equal(policy.development.checkOodFpr>.05,true,'The failed precision gate remains explicitly visible');
});
