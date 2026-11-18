'use strict';
// Test harness only: the profile itself never reads this fixture or observations.
// IDs are frozen before inference and are neither selected by score nor by v6.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { create } = require('./scalar-live-gcc-profile.cjs');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const observationFile = path.resolve('output/semantic-native-mingw-research/gcc-development-observations-v1.json');
const output = path.resolve('output/semantic-native-mingw-research/gcc-live-profile-smoke-v1.json');
const planFile = path.resolve('output/semantic-native-mingw-research/gcc-live-profile-smoke-plan-v1.json');
if (fs.existsSync(output) || fs.existsSync(planFile)) throw Error('Use new immutable smoke artifacts');
const docIds = ['apiary','apiary-adjacent','choir','choir-adjacent','kiln','kiln-adjacent','balloon','balloon-adjacent','tide','tide-adjacent'];
const queryIds = ['apiary-zh','apiary-en','apiary-entity','apiary-correction','apiary-missing-field','apiary-missing-number','apiary-unknown-entity','choir-zh','choir-en','choir-entity'];
const observationBytes = fs.readFileSync(observationFile), observed = JSON.parse(observationBytes);
if (observed.status !== 'COMPLETE_GCC_DEVELOPMENT_CAPTURE_NOT_QUALITY_VERDICT') throw Error('GCC observations incomplete');
const corpus = require('./calibration-fixture.cjs');
const docs = new Map(corpus.documents.filter(x => docIds.includes(x.id)).map(x => [x.id,x]));
const queries = new Map(corpus.queries.filter(x => x.split === 'train' && queryIds.includes(x.id)).map(x => [x.id,x]));
const oldDocs = new Map(observed.documents.filter(x => docIds.includes(x.id)).map(x => [x.id,x]));
const oldQueries = new Map(observed.queries.filter(x => x.split === 'train' && queryIds.includes(x.id)).map(x => [x.id,x]));
if ([docs,queries,oldDocs,oldQueries].some(x => x.size !== 10)) throw Error('Fixed sample missing');
const p = create(), plan = { status: 'PREDECLARED', scope: '10 fixed development docs and 10 fixed train queries; repeated in reverse order; no check or acceptance data',
  observationSha256: sha(observationBytes), docIds, queryIds, maxAbsTolerance: 0.000001, bindings: p.bindings, sourceSha256: sha(fs.readFileSync(__filename)) };
fs.writeFileSync(planFile, JSON.stringify(plan) + '\n', { flag: 'wx' });
const report = { status: 'RUNNING', planSha256: sha(fs.readFileSync(planFile)), rows: [], cleanup: {}, limitations: [
  'Research source and process smoke only; no product budget, end-to-end consumer, release quality, packaging or portability qualification.',
  'Job host discards native stdout/stderr and secrets; no user text is written into this receipt.' ] };
let error;
async function run() {
  const ready = await p.encoder.prepare({ deadline: Date.now() + 20000, budgetMs: 20000 });
  if (!ready.ok || !ready.modelFingerprint) throw Error('coarse preparation not ready: ' + JSON.stringify(ready));
  report.encoderFingerprint = ready.modelFingerprint; report.before = p.ownedIdentities();
  const first = new Map(), ordered = [...docIds.map(id => ['document',id]),...queryIds.map(id => ['query',id])];
  for (const [role,id] of [...ordered,...ordered.slice().reverse()]) {
    const row = (role === 'query' ? queries : docs).get(id), old = (role === 'query' ? oldQueries : oldDocs).get(id);
    const expectedHash = role === 'query' ? old.querySha256 : old.sourceSha256;
    if (sha(row.text) !== expectedHash) throw Error('sample source changed');
    let guards = 0;
    const result = await p.encoder.encode([row.text], { role, deadline: Date.now() + 1000, beforeEncode: async () => {
      guards++; if (sha(row.text) !== expectedHash) throw Error('source changed during encode');
    } });
    if (!result.ok || result.vectors?.length !== 1 || result.encodedTokens?.[0] !== old.tokens
      || result.encodedTokenHashes?.[0] !== old.tokensSha256 || result.encodedLastTokens?.[0] !== 151643 || guards < 3)
      throw Error('token, EOS, guard or encoder result mismatch');
    const vector = result.vectors[0], baseline = old.vector;
    let maxAbs = 0; for (let i=0;i<1024;i++) maxAbs = Math.max(maxAbs, Math.abs(vector[i]-baseline[i]));
    if (maxAbs > plan.maxAbsTolerance) throw Error('GCC embedding observation mismatch');
    const key = role + ':' + id, vectorSha256 = sha(JSON.stringify(vector));
    if (first.has(key) && first.get(key) !== vectorSha256) throw Error('reverse-order repeat drift');
    first.set(key,vectorSha256); report.rows.push({ role, id, tokens: old.tokens, tokenSha256: old.tokensSha256, maxAbs, guards });
  }
  report.coarseStats = p.encoder.stats();
  if (report.coarseStats.eraseWrites !== 40 || report.coarseStats.embeddingWrites !== 40) throw Error('every embedding must have a proven erase');
  const scalarReady = await p.scalarHost.prepare({ deadline: Date.now() + 20000 });
  if (!scalarReady.ok) throw Error('scalar preparation not ready');
  report.scalarFingerprints = scalarReady; report.bothOwners = p.ownedIdentities();
  let guardCount = 0;
  const result = await p.scalarHost.verify('What is the capital of China?', { text: 'The capital of China is Beijing.' }, {
    deadline: Date.now() + 1000, fingerprints: scalarReady, beforeVerify: async () => { guardCount++; }
  });
  if (!result.ok || !Number.isFinite(result.score) || guardCount < 3) throw Error('scalar synthetic verification failed');
  report.scalar = { score: result.score, tokens: result.jointTokens, guards: guardCount }; report.scalarStats = p.scalarHost.stats();
  if (report.scalarStats.nativeStats?.eraseWrites !== 1 || report.scalarStats.nativeStats?.rankWrites !== 1) throw Error('scalar erase/rank proof missing');
}
(async () => {
  try { await run(); report.status = 'PASS_RESEARCH_SMOKE_ONLY'; }
  catch (e) { error = e; report.status = 'FAIL'; report.error = String(e?.stack || e); }
  finally {
    for (const [name, fn] of [['coarse',()=>p.encoder.stop()], ['scalar',()=>p.scalarHost.stop()]]) {
      try { report.cleanup[name] = await fn(); } catch (e) { report.cleanup[name] = { cleanupStatus: 'unknown', error: String(e) }; }
      if (report.cleanup[name].cleanupStatus !== 'observed' || report.cleanup[name].workerExited !== true) report.status = 'FAIL_UNOBSERVED_CLEANUP';
    }
    fs.writeFileSync(output, JSON.stringify(report) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: report.status, rows: report.rows.length, error: report.error, cleanup: report.cleanup }));
    if (error || report.status !== 'PASS_RESEARCH_SMOKE_ONLY') process.exitCode = 1;
  }
})();
