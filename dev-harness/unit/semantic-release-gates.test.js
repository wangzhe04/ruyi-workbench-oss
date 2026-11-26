'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { check, sr2Accepted, sr6Accepted } = require('../lib/semantic-release-gates.cjs');
const acceptedMetrics = () => ({schema:1,kind:'semantic-sr2-acceptance',realModel:true,encryptedSource:true,frozenBeforeEvaluation:true,fixtureSha256:'a'.repeat(64),quality:{noAnswerCount:40,chineseRecallAt5:.95,zhEnRecallAt5:.9,enZhRecallAt5:.9,mrr:.8,noAnswerFalsePositiveRate:.025,completeCoverage:true},performance:{fragments:1000,warmSamplesMs:Array(20).fill(400),warmQueryEncodeSamplesMs:Array(20).fill(100),completeCoverage:true,includesSourceAndPrivacy:true,coldReadyMs:2000,indexBuildMs:800,prewarmMs:12000},rawEvidence:[]});
test('3.1 release rejects pending gates and stale evidence while candidate 3.0 builds remain possible', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-semantic-gates-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return { path: name, sha256: crypto.createHash('sha256').update(value).digest('hex') }; };
  write('ruyi-workbench/package.json', JSON.stringify({ version: '3.0.1' }));
  assert.equal(check(root).applicable, false);
  write('ruyi-workbench/package.json', JSON.stringify({ version: '3.1.0' }));
  const evidence = write('receipt.json', '{"passed":true}');
  const data = { schema: 1, release: '3.1', status: 'pending', gates: [], bindings: [] };
  const save = () => write('docs/optimization-plan/evidence/semantic-retrieval-20261116/release-gates.json', JSON.stringify(data));
  save(); assert.throws(() => check(root), /SR1 is not accepted/);
  data.status = 'pass'; data.gates = Array.from({ length: 8 }, (_, n) => ({ id: 'SR' + (n + 1), status: 'pass', evidence: [evidence] }));
  const metrics=acceptedMetrics();metrics.rawEvidence=[write('quality.json','{}'),write('performance.json','{}')];
  data.gates[1].acceptance=write('sr2.json',JSON.stringify(metrics));
  const privacy=acceptedPrivacy();privacy.rawEvidence=[write('privacy.json','{}'),write('replay.json','{}'),write('lifecycle.json','{}')];
  data.gates[5].acceptance=write('sr6.json',JSON.stringify(privacy));
  data.bindings = ['app/server.js', 'semantic-runtime/gemma2-profile-validation.cjs', 'semantic-runtime/gemma2-provider.cjs'].map(name => write('ruyi-workbench/' + name, name));
  save(); assert.equal(check(root).passed, true);
  const historical = structuredClone(metrics);
  delete historical.performance.warmQueryEncodeSamplesMs;
  data.gates[1].acceptance = write('sr2.json', JSON.stringify(historical));
  save(); assert.throws(() => check(root), /SR2 quantitative quality\/performance acceptance is missing or failed/);
  data.gates[1].acceptance = write('sr2.json', JSON.stringify(metrics));
  save();
  write('receipt.json', '{}'); assert.throws(() => check(root), /evidence is missing or changed/);
  write('receipt.json', '{"passed":true}'); write('ruyi-workbench/app/server.js', 'changed'); assert.throws(() => check(root), /bindings are missing or changed/);
});
function acceptedPrivacy() {
  return {schema:1,kind:'semantic-sr6-acceptance',realPrivacyGateway:true,syntheticDataOnly:true,lifecyclePolicy:'startup-resident-v1',
    checks:Object.fromEntries(['sameLengthPinDictionary','sameLengthNameDictionary','messageQuery','sessionSearch','snapshotQuery','legacyInputOpaqueOutput','providerReplay','compactionEgress','tamperDenied','crossSessionDenied','cancelDenied','sourceRewriteDenied','workDataOff','freshProcess','portableRestore','startupInitialization','idleResident','crossSessionWarm','shutdownRelease','hardParentExit','disableRelease'].map(key=>[key,true])),rawEvidence:[{},{},{}]};
}
test('SR6 requires reference confidentiality and durable lifecycle proofs, not snippet masking alone', () => {
  const value=acceptedPrivacy();assert.equal(sr6Accepted(value),true);
  for(const key of Object.keys(value.checks)){const copy=structuredClone(value);copy.checks[key]=false;assert.equal(sr6Accepted(copy),false,key);}
  const copy=structuredClone(value);copy.realPrivacyGateway=false;assert.equal(sr6Accepted(copy),false);
  copy.realPrivacyGateway=true;copy.rawEvidence.pop();assert.equal(sr6Accepted(copy),false);
});
test('SR6 rejects historical idle-unload receipts after startup-resident requirement', () => {
  const value=acceptedPrivacy();value.checks.idleRelease=true;
  delete value.lifecyclePolicy;assert.equal(sr6Accepted(value),false);
  value.lifecyclePolicy='on-demand-idle60';assert.equal(sr6Accepted(value),false);
  value.lifecyclePolicy='startup-resident-v1';assert.equal(sr6Accepted(value),true);
  for(const key of ['startupInitialization','idleResident','crossSessionWarm','shutdownRelease','hardParentExit']){
    const old=structuredClone(value);delete old.checks[key];assert.equal(sr6Accepted(old),false,key);
  }
});
test('SR2 refuses high false positives, incomplete or selectively summarized latency receipts', () => {
  const value=acceptedMetrics();value.rawEvidence=[{},{}];assert.equal(sr2Accepted(value),true);
  const bad=change=>{const copy=structuredClone(value);change(copy);assert.equal(sr2Accepted(copy),false);};
  bad(v=>v.quality.noAnswerFalsePositiveRate=.051);
  bad(v=>v.quality.zhEnRecallAt5=.84);
  bad(v=>v.quality.completeCoverage=false);
  bad(v=>v.performance.completeCoverage=false);
  bad(v=>v.performance.warmSamplesMs=[499]);
  bad(v=>v.performance.warmSamplesMs=Array(20).fill(501));
  bad(v=>v.performance.warmSamplesMs[0]=NaN);
  bad(v=>v.performance.includesSourceAndPrivacy=false);
  bad(v=>v.performance.fragments=999);
  bad(v=>v.frozenBeforeEvaluation=false);
});
test('SR2 checks independent nearest-rank p95 limits on paired warm query samples', () => {
  const value = acceptedMetrics();
  value.rawEvidence = [{}, {}];
  const p = value.performance;
  p.warmSamplesMs = [501, ...Array(19).fill(500)];
  p.warmQueryEncodeSamplesMs = [151, ...Array(19).fill(150)];
  assert.equal(sr2Accepted(value), true);

  p.warmQueryEncodeSamplesMs[1] = 150.01;
  assert.equal(sr2Accepted(value), false);
  p.warmQueryEncodeSamplesMs[1] = 150;
  p.warmSamplesMs[1] = 500.01;
  assert.equal(sr2Accepted(value), false);
});
test('SR2 requires finite nonnegative encode timings for the entire warm search cohort', () => {
  const value = acceptedMetrics();
  value.rawEvidence = [{}, {}];
  const p = value.performance;
  for (const count of [19, 21]) {
    p.warmQueryEncodeSamplesMs = Array(count).fill(100);
    assert.equal(sr2Accepted(value), false, `encode sample count ${count}`);
  }
  p.warmQueryEncodeSamplesMs = Array(20).fill(100);
  for (const invalid of [NaN, Infinity, -1, '100', null]) {
    p.warmQueryEncodeSamplesMs[0] = invalid;
    assert.equal(sr2Accepted(value), false, `encode sample ${invalid}`);
  }
  delete p.warmQueryEncodeSamplesMs[0];
  assert.equal(sr2Accepted(value), false);
  p.warmQueryEncodeSamplesMs[0] = 0;
  assert.equal(sr2Accepted(value), true);
});
