'use strict';
// Offline research only: stateless Qwen vectors AND independently measured
// MMARCO pair logits. Unmeasured pairs stay unknown; no inference or downloads.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { identifiers, qualityPasses } = require('./calibration-policy.cjs');
const fixturePath = path.join(__dirname, 'calibration-fixture.cjs'), fixture = require(fixturePath);
const qwenPath = path.resolve('output/semantic-qwen3-stateless-development-v1.json');
const crossPath = path.resolve(process.argv[3] || 'output/semantic-calibration-reranker-v1-logits.json');
const lexicalPath = path.resolve('output/semantic-weak-lexical-dev-cap-final.json');
const output = path.resolve(process.argv[2] || 'output/semantic-qwen-mmarco-and-v1.json');
const hash = x => crypto.createHash('sha256').update(x).digest('hex'), read = file => JSON.parse(fs.readFileSync(file));
if (fs.existsSync(output)) throw Error('Use a new immutable report.');
const qwen = read(qwenPath), cross = read(crossPath), lexical = read(lexicalPath), fixtureHash = hash(fs.readFileSync(fixturePath));
if (![qwen, cross, lexical].every(x => x.fixtureSha256 === fixtureHash) || cross.status !== 'PASS') throw Error('Development provenance mismatch.');
const variant = qwen.variants.find(x => x.id === 'prior-evidence');
if (!variant || !qwen.sourceStable || !qwen.repeat.every(x => x.maxDiff === 0)) throw Error('Expected stateless prior-evidence vectors.');
const dv = new Map(qwen.documents.map(x => [x.id, x.vector])), qv = new Map(variant.queries.map(x => [x.id, x.vector]));
const pairs = new Map(cross.pairs.map(x => [x.queryId + '\0' + x.documentId, x]));
const lexRows = new Map(lexical.variants.lexical.rows.map(x => [x.id, x]));
const docIndex = new Map(fixture.documents.map((d, i) => [d.id, i]));
const norm = x => x.normalize('NFKC').toUpperCase();
// Check/acceptance data do not participate in plans, parameter selection or output.
const prepared = fixture.queries.filter(q => ['train', 'calibration'].includes(q.split)).map(query => {
  const vector = qv.get(query.id), lexicalRow = lexRows.get(query.id);
  if (!vector || !lexicalRow) throw Error('Missing development vectors or lexical capture.');
  const required = identifiers(query.text), lex = lexicalRow.top.map((hit, rank) => ({ ...hit, rank,
    exact: hit.reference?.matchKind === 'lexical-entity' || norm(fixture.documents[docIndex.get(hit.id)].text).includes(norm(query.text)) }));
  const lexicalIds = new Set(lex.map(x => x.id));
  const semantic = fixture.documents.map(doc => ({ id: doc.id, score: vector.reduce((n, v, i) => n + v * dv.get(doc.id)[i], 0),
    pair: pairs.get(query.id + '\0' + doc.id), lexical: lexicalIds.has(doc.id), allowed: required.every(id => identifiers(doc.text).includes(id)) }))
    .filter(x => x.allowed).sort((a, b) => b.score - a.score || docIndex.get(a.id) - docIndex.get(b.id));
  return { query, lex, semantic };
});
// Frozen small grid before examining outcomes. No fitted/query/domain features.
const grid = { cosine: [.30, .38, .44, .46, .50, .54, .58, .62], logit: [-8, -6, -4, -2, 0, 2, 4, 6], topK: [1, 3, 5] };
function replay(item, policy, optimistic = false) {
  const fused = new Map(item.lex.map(hit => [hit.id, { id: hit.id, score: hit.score || 0, rankScore: 1 / (61 + hit.rank), exact: hit.exact, semanticOnly: false }]));
  const plans = item.semantic.filter(x => !x.lexical && x.score >= policy.cosine).slice(0, policy.topK);
  const planned = new Set(plans.map(x => x.id)); let semanticRank = 0;
  for (const hit of item.semantic) {
    if (hit.score < policy.cosine || !hit.lexical && (!planned.has(hit.id) || (hit.pair ? hit.pair.logit < policy.logit : !optimistic))) continue;
    const prior = fused.get(hit.id);
    if (prior) prior.rankScore += 1 / (61 + semanticRank);
    else fused.set(hit.id, { id: hit.id, score: hit.score, rankScore: 1 / (61 + semanticRank), semanticOnly: true, ...(hit.pair ? { logit: hit.pair.logit } : { unmeasuredAssumption: true }) });
    semanticRank++;
  }
  const top = [...fused.values()].sort((a, b) => Number(b.exact) - Number(a.exact) || b.rankScore - a.rankScore || b.score - a.score || docIndex.get(a.id) - docIndex.get(b.id)).slice(0, 5);
  return { id: item.query.id, split: item.query.split, kind: item.query.kind, group: item.query.group,
    rank: top.findIndex(x => item.query.relevant.includes(x.id)) + 1, top, plannedPairs: plans.length,
    measuredPairs: plans.filter(x => x.pair).length, missing: plans.filter(x => !x.pair).map(x => x.id) };
}
function metrics(rows) {
  const positive = rows.filter(x => x.kind === 'positive'), quality = list => ({ count: list.length,
    recallAt5: list.length ? list.filter(x => x.rank).length / list.length : null,
    mrr: list.length ? list.reduce((s, x) => s + (x.rank ? 1 / x.rank : 0), 0) / list.length : null });
  const rate = kinds => { const list = rows.filter(x => kinds.includes(x.kind)); return { count: list.length,
    anyResultFpr: list.length ? list.filter(x => x.top.length).length / list.length : null,
    semanticOnlyResultFpr: list.length ? list.filter(x => x.top.some(h => h.semanticOnly)).length / list.length : null }; };
  return { quality: { all: quality(positive), groups: Object.fromEntries([...new Set(positive.map(x => x.group))].map(g => [g, quality(positive.filter(x => x.group === g))])) },
    pureOod: rate(['ood']), entityMismatch: rate(['entity-mismatch']), missingFactDiagnostic: rate(['missing-field', 'missing-number']),
    coverage: { queries: rows.length, completeQueries: rows.filter(x => !x.missing.length).length,
      plannedPairs: rows.reduce((s, x) => s + x.plannedPairs, 0), measuredPairs: rows.reduce((s, x) => s + x.measuredPairs, 0),
      missingPairs: rows.reduce((s, x) => s + x.missing.length, 0) } };
}
const results = [];
for (const cosine of grid.cosine) for (const logit of grid.logit) for (const topK of grid.topK) {
  const policy = { cosine, logit, topK }, rows = prepared.map(x => replay(x, policy)), train = metrics(rows.filter(x => x.split === 'train')), calibration = metrics(rows.filter(x => x.split === 'calibration'));
  const qualityPreserving = qualityPasses(train) && qualityPasses(calibration), coverageComplete = train.coverage.missingPairs + calibration.coverage.missingPairs === 0;
  results.push({ policy, train, calibration, qualityPreserving, coverageComplete,
    passes: qualityPreserving && coverageComplete && train.pureOod.anyResultFpr <= .05 && calibration.pureOod.anyResultFpr <= .05 });
}
const order = (a, b) => Math.max(a.train.pureOod.anyResultFpr, a.calibration.pureOod.anyResultFpr) - Math.max(b.train.pureOod.anyResultFpr, b.calibration.pureOod.anyResultFpr)
  || a.policy.topK - b.policy.topK || b.calibration.quality.all.mrr - a.calibration.quality.all.mrr || b.policy.logit - a.policy.logit || b.policy.cosine - a.policy.cosine;
const passing = results.filter(x => x.passes).sort(order), observedPareto = results.filter(x => x.qualityPreserving).sort(order);
const diagnostic = observedPareto[0] || results.slice().sort((a, b) => b.calibration.quality.all.recallAt5 - a.calibration.quality.all.recallAt5 || order(a, b))[0];
const rows = prepared.map(x => replay(x, diagnostic.policy)), missingPairs = rows.flatMap(x => x.missing.map(documentId => ({ queryId: x.id, documentId })));
const withoutCrossRows = prepared.map(x => replay(x, { ...diagnostic.policy, logit: -Infinity }));
const sameCoarseBaseline = Object.fromEntries(['train', 'calibration'].map(split => [split, metrics(withoutCrossRows.filter(x => x.split === split))]));
const measuredIncrement = Object.fromEntries(['train', 'calibration'].map(split => {
  const selectedRows = rows.filter(x => x.split === split), before = new Map(withoutCrossRows.filter(x => x.split === split).map(x => [x.id, x]));
  return [split, { removedOodQueryResults: selectedRows.filter(x => x.kind === 'ood' && before.get(x.id).top.length && !x.top.length).length,
    lostPositiveQueries: selectedRows.filter(x => x.kind === 'positive' && before.get(x.id).rank && !x.rank).length }];
}));
const completePairsByK = Object.fromEntries(grid.topK.map(topK => { const rows = prepared.map(x => replay(x, { cosine: -1, logit: -Infinity, topK })); return [topK, metrics(rows).coverage]; }));
const values = cross.pairs.map(x => x.elapsedMs).sort((a, b) => a - b), percentile = p => values[Math.ceil(values.length * p) - 1];
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), status: passing.length ? 'OFFLINE_DEVELOPMENT_CANDIDATE_ONLY' : observedPareto.length ? 'INCOMPLETE_PAIR_COVERAGE_NO_QUALIFIED_POLICY' : 'RED_NO_OBSERVED_QUALITY_POLICY',
  sources: [fixturePath, qwenPath, crossPath, lexicalPath, __filename].map(file => ({ file, sha256: hash(fs.readFileSync(file)) })),
  priorResearchDifference: 'Old joint/logistic used MiniLM cosines and MiniLM-selected pair plans. This experiment changes the bi signal to stateless Qwen prior-evidence; no previous logistic refit or thresholds are reused.',
  representationFingerprint: variant.representationFingerprint, crossEncoderFingerprint: cross.modelFingerprint, lexicalSourceHashes: lexical.sourceHashes,
  selectionRule: 'Fixed 192 policies. Train+calibration must both preserve zh>=.90, cross directions>=.85, MRR>=.75, pure OOD any-result FPR<=.05 and have zero unmeasured planned pair. Lower worst pure OOD, smaller K, higher cal MRR, stronger logit/cosine tie-break. No check evaluation.',
  grid, passingPolicies: passing.length, selected: passing[0] || null, diagnostic, qualityPreservingPolicies: observedPareto.length, completePairsByK,
  diagnosticRows: rows, missingPairs, sameCoarseBaseline, measuredIncrement,
  incrementalOodImprovementAtSelectedPoint: Object.values(measuredIncrement).some(x => x.removedOodQueryResults > 0), results,
  resources: { crossAssetBytes: cross.modelBytes, crossProcessHistoricalPeakRssBytes: cross.peakRssBytes, crossHistoricalColdMs: cross.coldReadyMs,
    crossHistoricalContended: cross.contendedTiming, measuredPairMs: { p50: percentile(.5), p95: percentile(.95) },
    note: 'Historical standalone process evidence only, not simultaneous Qwen+MMARCO RSS or production latency. Planned additional inference is 0..topK pairs/query after Qwen threshold; missing pairs need genuine inference before any complete verdict.' },
  limits: ['This evaluator performs no inference/download/production edit; check rows are never evaluated or selected, and no root acceptance fixture/report is loaded.', 'Unmeasured pairs remain unknown and never accepted; observed recall is conservative but not evidence that all measured-passing policies generalize.', 'Pure OOD denominator is separate from exact entity mismatches; missing facts are reported separately.', 'Actual lexical capture is historical and hash-bound; this replay does not qualify current production RRF or source guards.', 'A relevance cross-logit is not entailment/answerability probability; automatic remains null.'] };
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, status: report.status, passingPolicies: passing.length, qualityPreservingPolicies: observedPareto.length, completePairsByK, diagnostic, resources: report.resources }));
