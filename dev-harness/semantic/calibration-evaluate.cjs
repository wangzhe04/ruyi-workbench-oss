'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const fixturePath = path.join(__dirname, 'calibration-fixture.cjs'), fixture = require(fixturePath);
const { metrics, passes, qualityPasses, candidates } = require('./calibration-policy.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function main() {
  const input = path.resolve(process.argv[2] || 'output/semantic-calibration-v1-vectors.json');
  const output = path.resolve(process.argv[3] || 'output/semantic-calibration-v1-selection.json');
  if (fs.existsSync(output)) throw Error('Use a new output file; failed policies are retained.');
  const encoded = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (encoded.status !== 'PASS' || encoded.fixtureSha256 !== hash(fs.readFileSync(fixturePath))) throw Error('Encoding/fixture provenance mismatch.');
  const docs = new Map(encoded.documents.map(row => [row.id, row.vector])), queryVectors = new Map(encoded.queries.map(row => [row.id, row.vector]));
  const matrix = Object.fromEntries(fixture.queries.map(query => { const q = queryVectors.get(query.id); if (!q) throw Error('Missing query vector'); return [query.id, fixture.documents.map(doc => { const vector = docs.get(doc.id); if (!vector || vector.length !== q.length) throw Error('Missing document vector'); return q.reduce((sum, value, i) => sum + value * vector[i], 0); })]; }));
  const compact = value => { const { rows, ...summary } = value; return { ...summary, passed: passes(value) }; };
  const modelRange=process.argv.includes('--model-range');
  const results = (modelRange?candidates(10,98):candidates()).map(policy => {
    const train = metrics(fixture, matrix, policy, 'train'), calibration = metrics(fixture, matrix, policy, 'calibration');
    return { policy, train: compact(train), calibration: compact(calibration) };
  });
  // Selection uses train+calibration only. The check split never chooses a policy.
  const good = results.filter(row => row.train.passed && row.calibration.passed).sort((a, b) => a.calibration.searchNegativeAdmission.rate - b.calibration.searchNegativeAdmission.rate || b.calibration.quality.all.mrr - a.calibration.quality.all.mrr || Number(a.policy.minGap > 0) + Number(a.policy.minZ > 0) - Number(b.policy.minGap > 0) - Number(b.policy.minZ > 0));
  const complexity = policy => Number(policy.minGap > 0) + Number(policy.minZ > 0);
  const preserving = results.filter(row => qualityPasses(row.train) && qualityPasses(row.calibration)).sort((a, b) =>
    Math.max(a.train.searchNegativeAdmission.rate, a.calibration.searchNegativeAdmission.rate) - Math.max(b.train.searchNegativeAdmission.rate, b.calibration.searchNegativeAdmission.rate)
    || a.calibration.searchNegativeAdmission.rate - b.calibration.searchNegativeAdmission.rate
    || complexity(a.policy) - complexity(b.policy) || b.policy.minScore - a.policy.minScore || b.calibration.quality.all.mrr - a.calibration.quality.all.mrr);
  const fallback = preserving[0] || results.slice().sort((a, b) => b.calibration.quality.all.mrr - a.calibration.quality.all.mrr)[0];
  const selected = good[0] || null, illustrative = selected || fallback;
  const baseline = { id: 'previous-cosine-0.22', minScore: .22, minGap: 0, minZ: 0, identifiers: false };
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), fixture: fixture.name, fixtureSha256: encoded.fixtureSha256, vectorsSha256: hash(fs.readFileSync(input)), modelFingerprint: encoded.ready.modelFingerprint,representationFingerprint:encoded.representationFingerprint||null,inputTransform:encoded.inputTransform?{id:encoded.inputTransform.id,sourceSha256:encoded.inputTransform.sourceSha256,parserSha256:encoded.inputTransform.parserSha256}:null,modelId:encoded.ready.modelId,thresholdRange:modelRange?[.1,.98]:[.22,.8],
    selectionRule: 'First seek all targets on BOTH train and calibration. If none, preserve declared quality floors on both splits, minimize worst search-negative FPR, then calibration FPR, prefer no background statistic, then higher cosine threshold. Check split never selects.',
    status: selected ? 'DEVELOPMENT_CANDIDATE' : preserving.length ? 'RED_PARTIAL_IMPROVEMENT' : 'RED_NO_POLICY_PASSES', selectedPolicy: (selected || preserving[0])?.policy || null,
    baseline: Object.fromEntries(['train', 'calibration', 'check'].map(split => [split, metrics(fixture, matrix, baseline, split)])),
    candidate: Object.fromEntries(['train', 'calibration', 'check'].map(split => [split, metrics(fixture, matrix, illustrative.policy, split)])),
    passesAllDevelopmentTargets: !!selected, qualityPreservingCandidates: preserving.length, results,
    limits: ['Bi-encoder admission estimates search relevance, not factual answerability.', 'No old acceptance data or new root holdout is read.', 'These metrics are semantic admission only; any-result FPR must additionally preserve and measure the independent production lexical route.', 'Small synthetic splits do not prove production-general FPR. automatic remains null.'] };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ output, status: report.status, selected: report.selectedPolicy, illustrative: illustrative.policy, baseline: compact(report.baseline.check), check: compact(report.candidate.check) }));
}
try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
