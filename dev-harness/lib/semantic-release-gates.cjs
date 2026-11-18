'use strict';
// Candidate packages can be built before acceptance. Release qualification for
// 3.1 and later must not mistake an old package receipt for this new capability.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const required = ['SR1', 'SR2', 'SR3', 'SR4', 'SR5', 'SR6', 'SR7', 'SR8'];
const manifest = 'docs/optimization-plan/evidence/semantic-retrieval-20261116/release-gates.json';
// S2b: a green label alone cannot close the quality/performance release gate.
function sr2Accepted(value) {
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const fraction = n => finite(n) && n >= 0 && n <= 1;
  const q = value?.quality, p = value?.performance;
  return value?.schema === 1 && value?.kind === 'semantic-sr2-acceptance'
    && value.realModel === true && value.encryptedSource === true
    && value.frozenBeforeEvaluation === true
    && /^[a-f0-9]{64}$/.test(value.fixtureSha256 || '')
    && Number.isInteger(q?.noAnswerCount) && q.noAnswerCount >= 40
    && ['chineseRecallAt5', 'zhEnRecallAt5', 'enZhRecallAt5', 'mrr', 'noAnswerFalsePositiveRate'].every(k => fraction(q[k]))
    && q.chineseRecallAt5 >= .90 && q.zhEnRecallAt5 >= .85 && q.enZhRecallAt5 >= .85
    && q.mrr >= .75 && q.noAnswerFalsePositiveRate <= .05 && q.completeCoverage === true
    && Number.isInteger(p?.fragments) && p.fragments >= 1000
    && Array.isArray(p.warmSamplesMs) && p.warmSamplesMs.length >= 20
    && p.warmSamplesMs.every(n => finite(n) && n >= 0)
    && [...p.warmSamplesMs].sort((a,b) => a-b)[Math.ceil(p.warmSamplesMs.length * .95)-1] <= 500
    && p.completeCoverage === true && p.includesSourceAndPrivacy === true
    && finite(p.coldReadyMs) && p.coldReadyMs >= 0
    && finite(p.indexBuildMs) && p.indexBuildMs >= 0
    && finite(p.prewarmMs) && p.prewarmMs >= 0
    && Array.isArray(value.rawEvidence) && value.rawEvidence.length >= 2;
}
// Confidentiality includes the reference carrier, not only the visible snippet.
// The evidence must cover real gateway/transport paths and durable key semantics.
function sr6Accepted(value) {
  const checks = value?.checks;
  return value?.schema === 1 && value?.kind === 'semantic-sr6-acceptance'
    && value.realPrivacyGateway === true && value.syntheticDataOnly === true
    // User requirement supersedes the historical idle60 unload policy.
    && value.lifecyclePolicy === 'startup-resident-v1'
    && ['sameLengthPinDictionary', 'sameLengthNameDictionary', 'messageQuery',
      'sessionSearch', 'snapshotQuery', 'legacyInputOpaqueOutput',
      'providerReplay', 'compactionEgress', 'tamperDenied', 'crossSessionDenied',
      'cancelDenied', 'sourceRewriteDenied', 'workDataOff', 'freshProcess',
      'portableRestore', 'startupInitialization', 'idleResident', 'crossSessionWarm',
      'shutdownRelease', 'hardParentExit', 'disableRelease'].every(key => checks?.[key] === true)
    && Array.isArray(value.rawEvidence) && value.rawEvidence.length >= 3;
}
function check(root, { force = false } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'ruyi-workbench/package.json'), 'utf8')).version;
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match) throw Error('Invalid product version');
  if (!force && (+match[1] < 3 || (+match[1] === 3 && +match[2] < 1))) return { applicable: false, version };
  const data = JSON.parse(fs.readFileSync(path.join(root, manifest), 'utf8'));
  const errors = [], hashes = new Map();
  function verify(item) {
    if (!item || typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256 || '')) return false;
    const parts = item.path.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || /[\\:]/.test(p))) return false;
    const file = path.join(root, ...parts);
    try {
      if (!hashes.has(file)) hashes.set(file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
      return hashes.get(file) === item.sha256;
    } catch { return false; }
  }
  if (data.schema !== 1 || data.release !== '3.1' || data.status !== 'pass') errors.push('semantic release scope is not accepted');
  for (const id of required) {
    const rows = (data.gates || []).filter(row => row.id === id);
    if (rows.length !== 1 || rows[0].status !== 'pass') { errors.push(id + ' is not accepted'); continue; }
    if (!Array.isArray(rows[0].evidence) || !rows[0].evidence.length || !rows[0].evidence.every(verify)) errors.push(id + ' evidence is missing or changed');
    if (id === 'SR2' || id === 'SR6') {
      let receipt;
      try { if (verify(rows[0].acceptance)) receipt = JSON.parse(fs.readFileSync(path.join(root, rows[0].acceptance.path), 'utf8')); } catch { /* reject below */ }
      const accepted = id === 'SR2' ? sr2Accepted(receipt) : sr6Accepted(receipt);
      if (!accepted || !receipt.rawEvidence.every(verify)) errors.push(id + ' ' + (id === 'SR2' ? 'quantitative quality/performance' : 'reference confidentiality/lifecycle') + ' acceptance is missing or failed');
    }
  }
  const bindings = data.bindings;
  if (!Array.isArray(bindings) || !bindings.length || !bindings.every(verify)
    || !bindings.some(item => item.path === 'ruyi-workbench/app/server.js')
    || !bindings.some(item => item.path === 'ruyi-workbench/semantic-runtime/models.lock.json')
    || !bindings.some(item => item.path === 'ruyi-workbench/semantic-runtime/worker.cjs')) errors.push('final source/model bindings are missing or changed');
  if (errors.length) throw Error('3.1 semantic release gates: ' + errors.join('; '));
  return { applicable: true, version, passed: true };
}
if (require.main === module) {
  try { console.log(JSON.stringify(check(path.resolve(__dirname, '../..'), { force: process.argv.includes('--require-pass') }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { check, sr2Accepted, sr6Accepted };
