'use strict';
// 151 阶段 5 P14:原 unit/semantic-calibration.test.js 里守产品 06ha 的断言原样迁来(用例名与断言逐字未改)。
// 只测研究校准夹具、研究策略(研究目录里的 calibration-*.cjs)与内容查询实验的断言随研究证据归档,
// 原件整份在 dev-harness/archive/ 的研究证据归档里(清单与复原方法见 archive/README.md)。
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const pure = vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/06ha-semantic-retrieval.js'), 'utf8') + '\nSemanticRetrieval;', { require, Buffer, Date, setTimeout, clearTimeout });
test('structured identifiers are syntactic, Unicode-normalized and not a sample lookup', () => {
  assert.deepEqual(Array.from(pure.structuredIds('Compare ＺＺ－９１ and zz-91 with AB_742.')), ['zz-91', 'ab_742']);
  assert.equal(pure.structuredIds('zz-910').includes('zz-91'),false);
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
  const descriptor={available:true,modelFingerprint:'measured-test',modelId:'synthetic-scalar-model',retrievalThresholds:{search:.34,automatic:null}};
  const semantic=pure.create({prepare:async()=>descriptor,encode:async texts=>({ok:true,modelFingerprint:descriptor.modelFingerprint,vectors:texts.map(()=>[1,0])})});
  const result=await semantic.score('Inspect ZZ-91',['ZZ-91 rule','ZZ-92 rule','an unencoded rule'],{maxEncodeDocuments:2});
  assert.deepEqual(Array.from(result.scores),[1,1,null]);
  assert.deepEqual(Array.from(result.admission.accepted),[true,false,null]);
  assert.equal(result.admission.status,'partial');assert.equal(result.admission.answerability,'not-assessed');
  assert.equal(result.admission.policyId,pure.searchPolicy.id);
});
test('production search contract matches the offline model and keeps automatic additions disabled',()=>{
  const policy=require('../../ruyi-workbench/semantic-runtime/search-admission-policy.json');
  const contract=pure.windowPolicy.CONTRACT;
  assert.equal(policy.model,contract.modelId);
  assert.equal(policy.sessionSemanticResults,contract.topK);
  assert.equal(policy.minimumCosine,contract.threshold);
  assert.equal(policy.automatic,contract.automatic);
  assert.equal(policy.explicitMemoryDistinctResults,3);
});
