'use strict';
// Fixed36-policy train/cal replay only; no new grid or instruction decisions.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const protocol = require('./qwen-reranker-calibration-protocol.cjs'), { qualityPasses } = require('./calibration-policy.cjs');
const hash = data => crypto.createHash('sha256').update(data).digest('hex'), read = file => JSON.parse(fs.readFileSync(file));
const ledgerPath = path.resolve(process.argv[2]), scoresPath = path.resolve(process.argv[3]), output = path.resolve(process.argv[4]);
if (fs.existsSync(output)) throw Error('Use a new immutable evaluation receipt.');
const ledger = read(ledgerPath), scores = read(scoresPath), capture = read(ledger.capturePath);
if (scores.status !== 'COMPLETE_SCALAR_COLLECTION_NOT_QUALITY_VERDICT' || !scores.coverage?.complete || scores.cleanup?.cleanupStatus !== 'observed' || scores.cleanup?.workerExited !== true
  || !scores.sourceBindingsStable || scores.ledgerSha256 !== hash(fs.readFileSync(ledgerPath)) || scores.pairsSha256 !== ledger.pairsSha256
  || scores.adapterSourceSha256 !== ledger.adapterSourceSha256 || scores.runtimeLockSha256 !== ledger.runtimeLockSha256 || scores.pairs.length !== ledger.pairs.length) throw Error('Incomplete/unbound/unobserved scalar collection; no quality verdict.');
const measured = new Map(scores.pairs.map(x => [x.pairId, x]));
if (measured.size !== ledger.pairs.length || ledger.pairs.some(p => !measured.has(p.pairId)) || scores.pairs.some(p => !Number.isFinite(p.probability) || p.probability < 0 || p.probability > 1 || !Number.isInteger(p.jointTokens) || p.jointTokens > 512)) throw Error('Invalid/missing prescribed pair result.');
const fixturePath = path.join(__dirname, 'calibration-fixture.cjs'), corpus = require(fixturePath);
if (hash(fs.readFileSync(fixturePath)) !== ledger.fixtureSha256) throw Error('Development data changed.');
const queries = corpus.queries.filter(q => ['train', 'calibration'].includes(q.split)), queryPlans = new Map(ledger.queries.map(q => [q.queryId, q]));
const pairs = new Map(ledger.pairs.map(p => [p.pairId, p])), documents = new Map(corpus.documents.map((d, i) => [d.id, { ...d, index: i }]));
const currentSource = fs.readFileSync(capture.sourceBefore[0].file, 'utf8');
if (hash(currentSource) !== capture.sourceBefore[0].sha256) throw Error('Current producer changed.');
const normalize = vm.runInNewContext(currentSource.match(/^  const canonicalText=.*;$/m)[0] + '\n' + currentSource.match(/^  const normalize=.*;$/m)[0] + '\nnormalize;');
// The observed fixed corpus has one lexical field at most, and no mixed strong
// field plus other semantic verification work. Without these facts, captured
// IR scores/projection must be replayed through the actual producer instead.
if (capture.rows.some(q => q.hits.length > 1) || ledger.queries.some(q => q.strongEvidence.length && Object.values(q.perProfile).some(x => x.length))) throw Error('This corpus needs a broader actual-producer RRF replay.');
function replay(query, profile, threshold) {
  const plan = queryPlans.get(query.id), entries = plan.perProfile[profile.id], fused = new Map();
  const admitted = entries.filter(e => measured.get(e.pairId).probability >= threshold);
  const lexical = [...plan.strongEvidence.map(hit => ({ id: hit.fixtureDocumentId, strong: true, sourceId: hit.sourceId })),
    ...admitted.filter(e => e.roles.includes('weak-lexical')).map(e => ({ id: pairs.get(e.pairId).fixtureDocumentId, sourceId: pairs.get(e.pairId).sourceId, weakLexical: true }))];
  for (const [rank, hit] of lexical.entries()) fused.set(hit.id, { ...hit, score: 0, lexical: true, rankScore: 1 / (61 + rank),
    exact: normalize(documents.get(hit.id).text).includes(normalize(query.text)) });
  for (const [rank, entry] of admitted.filter(e => e.roles.includes('semantic')).sort((a, b) => a.coarseRank - b.coarseRank).entries()) {
    const pair = pairs.get(entry.pairId), prior = fused.get(pair.fixtureDocumentId);
    if (prior) { prior.rankScore += 1 / (61 + rank); prior.score = entry.cosine; prior.semantic = true; }
    else fused.set(pair.fixtureDocumentId, { id: pair.fixtureDocumentId, sourceId: pair.sourceId, score: entry.cosine, rankScore: 1 / (61 + rank), semantic: true, lexical: false });
  }
  const all = [...fused.values()].sort((a, b) => Number(b.exact || false) - Number(a.exact || false) || b.rankScore - a.rankScore || b.score - a.score || documents.get(a.id).index - documents.get(b.id).index), top = all.slice(0, 5);
  return { queryId: query.id, split: query.split, kind: query.kind, group: query.group, rank: top.findIndex(x => query.relevant.includes(x.id)) + 1,
    top, admittedBeforeFinalCap: all, requiredPairs: entries.length, jointTokens: entries.reduce((n, x) => n + measured.get(x.pairId).jointTokens, 0) };
}
function metrics(rows) {
  const positives = rows.filter(q => q.kind === 'positive'), quality = a => ({ count: a.length, recallAt5: a.filter(x => x.rank).length / a.length, mrr: a.reduce((n, x) => n + (x.rank ? 1 / x.rank : 0), 0) / a.length });
  const rate = kinds => { const a = rows.filter(x => kinds.includes(x.kind)), fraction = predicate => a.filter(predicate).length / a.length; return { count: a.length,
    anyResultFpr: fraction(q => q.top.length), verifiedCandidateResultFpr: fraction(q => q.top.some(x => !x.strong)),
    semanticOnlyAdmissionFpr: fraction(q => q.admittedBeforeFinalCap.some(x => x.semantic && !x.lexical)),
    weakLexicalResultFpr: fraction(q => q.top.some(x => x.weakLexical)), strongEvidenceResultFpr: fraction(q => q.top.some(x => x.strong)) }; };
  return { quality: { all: quality(positives), groups: Object.fromEntries([...new Set(positives.map(x => x.group))].map(g => [g, quality(positives.filter(x => x.group === g))])) },
    pureOod: rate(['ood']), entityMismatch: rate(['entity-mismatch']), missingField: rate(['missing-field']), missingNumber: rate(['missing-number']),
    cost: { requiredPairs: rows.reduce((n, q) => n + q.requiredPairs, 0), jointTokens: rows.reduce((n, q) => n + q.jointTokens, 0) }, coverage: { queries: rows.length, complete: true } };
}
const candidates = [];
for (const profile of protocol.producer.profiles) for (const threshold of protocol.fixedGrid.thresholds) {
  const rows = queries.map(query => replay(query, profile, threshold)), train = metrics(rows.filter(q => q.split === 'train')), calibration = metrics(rows.filter(q => q.split === 'calibration'));
  const qualityPreserving = qualityPasses(train) && qualityPasses(calibration), passes = qualityPreserving && [train, calibration].every(x => x.pureOod.anyResultFpr <= .05 && x.entityMismatch.anyResultFpr <= .05);
  candidates.push({ profile: profile.id, threshold, train, calibration, qualityPreserving, passes });
}
const ordered = candidates.filter(x => x.passes).sort((a, b) => Math.max(a.train.pureOod.anyResultFpr, a.calibration.pureOod.anyResultFpr) - Math.max(b.train.pureOod.anyResultFpr, b.calibration.pureOod.anyResultFpr)
  || a.train.cost.requiredPairs + a.calibration.cost.requiredPairs - b.train.cost.requiredPairs - b.calibration.cost.requiredPairs
  || a.train.cost.jointTokens + a.calibration.cost.jointTokens - b.train.cost.jointTokens - b.calibration.cost.jointTokens
  || Math.min(b.train.quality.all.mrr, b.calibration.quality.all.mrr) - Math.min(a.train.quality.all.mrr, a.calibration.quality.all.mrr) || b.threshold - a.threshold || a.profile.localeCompare(b.profile));
const selected = ordered[0] || null;
const report = { schemaVersion: 1, status: selected ? 'TRAIN_CAL_DEVELOPMENT_CANDIDATE_NOT_ACCEPTANCE' : 'RED_NO_BOTH_SPLIT_POLICY',
  evaluatorScriptSha256: hash(fs.readFileSync(__filename)), adapterSourceSha256: ledger.adapterSourceSha256, runtimeLockSha256: ledger.runtimeLockSha256,
  ledgerSha256: hash(fs.readFileSync(ledgerPath)), scoresSha256: hash(fs.readFileSync(scoresPath)), protocolSourceSha256: hash(fs.readFileSync(require.resolve('./qwen-reranker-calibration-protocol.cjs'))),
  fixedGrid: protocol.fixedGrid, candidates, passingPolicies: ordered.length, selected,
  selectedRows: selected ? queries.map(q => replay(q, protocol.producer.profiles.find(p => p.id === selected.profile), selected.threshold)) : null,
  limits: ['Existing train/cal labels only. No check/acceptance query or score is opened.', 'Fixed36 predeclared policies; runtime observed quality is not production integration/500ms/combined-RSS qualification.', 'Offline exact-field RRF replay for this specific one-lexical-field/strong-only corpus; actual producer/end-to-end consumers still need separate verification.', 'No incomplete query or pair is treated as a negative; evaluation requires complete prescribed850 with observed cleanup.', 'Missing-field/number relevance diagnostics are separate from unrelated OOD; no answerability or automatic memory injection authorization.'] };
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, status: report.status, passingPolicies: ordered.length, selected }));
