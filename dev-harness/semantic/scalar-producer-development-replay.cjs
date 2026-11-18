'use strict';
// Actual encrypted producer/06ha/source/RRF/privacy path, replaying frozen real
// model outputs. No native starts and no measured latency/resource claim.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { fixture } = require('../lib/fulltext-owned-producer-fixture');
const { transform } = require('./scalar-producer-research-source.cjs');
const { createCompositePolicy, CONTRACT } = require('./scalar-composite-policy-research.cjs');
const { createScalarVerifierBridge } = require('./scalar-verifier-bridge-prototype.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex'), read = file => JSON.parse(fs.readFileSync(file));
const artifactRoot = path.resolve('output/semantic-qwen-reranker-official-v1');
const paths = {
  fixture: path.join(__dirname, 'calibration-fixture.cjs'),
  producer: path.resolve('ruyi-workbench/app/src/13ap-session-fulltext-index.js'), semantic: path.resolve('ruyi-workbench/app/src/06ha-semantic-retrieval.js'),
  vectors: path.join(artifactRoot, 'qwen-prior-evidence-train-cal-vectors-v1.json'), ledger: path.join(artifactRoot, 'development-pair-plan-v2.json'),
  scalars: path.join(artifactRoot, 'development-scalars-v1.json'), expected: path.join(artifactRoot, 'development-selection-v1.json'),
  bridge: require.resolve('./scalar-verifier-bridge-prototype.cjs'), policy: require.resolve('./scalar-composite-policy-research.cjs'), transformer: require.resolve('./scalar-producer-research-source.cjs'),
};
async function main(output) {
  if (fs.existsSync(output)) throw Error('Use a new immutable replay receipt.');
  const directory = path.dirname(output); fs.mkdirSync(directory, { recursive: true });
  const sourceBefore = Object.fromEntries(Object.entries(paths).map(([key, file]) => [key, { file, sha256: hash(fs.readFileSync(file)) }]));
  const corpus = require(paths.fixture), queries = corpus.queries.filter(query => ['train', 'calibration'].includes(query.split));
  const encoded = read(paths.vectors), ledger = read(paths.ledger), scalars = read(paths.scalars), expected = read(paths.expected);
  if (encoded.fixtureSha256 !== sourceBefore.fixture.sha256 || ledger.fixtureSha256 !== sourceBefore.fixture.sha256 || scalars.ledgerSha256 !== sourceBefore.ledger.sha256
    || scalars.status !== 'COMPLETE_SCALAR_COLLECTION_NOT_QUALITY_VERDICT' || !scalars.sourceBindingsStable || !scalars.coverage.complete
    || scalars.cleanup?.cleanupStatus !== 'observed' || scalars.cleanup?.workerExited !== true || expected.scoresSha256 !== sourceBefore.scalars.sha256
    || expected.selected?.profile !== 'qwen-k1' || expected.selected?.threshold !== CONTRACT.threshold) throw Error('Incomplete or inconsistent frozen development research.');
  const measured = new Map(scalars.pairs.map(pair => [pair.pairId, pair]));
  const pairOutputs = new Map(ledger.pairs.map(pair => [JSON.stringify([pair.queryId, pair.sourceIdentity.sessionId, pair.sourceIdentity.source, pair.sourceIdentity.start, pair.sourceIdentity.end, pair.rawFieldSha256]), measured.get(pair.pairId)]));
  const queryByText = new Map(queries.map(query => [query.text, query])), expectedById = new Map(expected.selectedRows.map(query => [query.queryId, query]));
  const docsBySid = new Map(corpus.documents.map((doc, index) => ['CAL' + String(index).padStart(3, '0'), doc]));
  const documentVectors = new Map(encoded.documents.map(doc => [doc.id, doc.vector])), queryVectors = new Map(encoded.queries.map(query => [query.id, query.vector]));
  const documentByText = new Map(corpus.documents.map(doc => [doc.text, doc]));
  const transformed = transform(fs.readFileSync(paths.producer, 'utf8')), modulePath = path.join(directory, 'research-producer.cjs');
  if (fs.existsSync(modulePath)) { if (hash(fs.readFileSync(modulePath)) !== transformed.transformedSha256) throw Error('Research module copy differs.'); }
  else fs.writeFileSync(modulePath, transformed.source, { flag: 'wx' });
  const primitive = vm.runInNewContext(fs.readFileSync(paths.semantic, 'utf8') + '\nSemanticRetrieval;', { require, Buffer, Date, setTimeout, clearTimeout });
  const normalize = vm.runInNewContext(fs.readFileSync(paths.producer, 'utf8').match(/^  const canonicalText=.*;$/m)[0] + '\n' + fs.readFileSync(paths.producer, 'utf8').match(/^  const normalize=.*;$/m)[0] + '\nnormalize;');
  const report = { schemaVersion: 1, status: 'RUNNING', replayScriptSha256: hash(fs.readFileSync(__filename)), sourceBefore, sourceTransform: transformed,
    policy: CONTRACT, replayOnly: true, nativeStarts: 0, coverage: { prescribedQueries: queries.length, completedQueries: 0 }, rows: [], scalarWrites: 0,
    limits: ['Frozen real vectors/scalars are replayed through actual06ha and encrypted-source producer; no new inference, performance or combined resource qualification.',
      'Only train/cal allowlisted queries are evaluated; no acceptance/check fixture or score is opened.', 'This runner covers actual13ap with one short field per session; broader consumer/metadata behavior requires separate adversarial tests and independent consumer qualification.',
      'Complete scalar identities/scores are private WeakMap harness diagnostics, not fields in the public producer result. This receipt is synthetic research only; do not migrate diagnostics or raw derived digests to UI/model DTOs.',
      'All per-query work shares the existing semantic1000ms/consumer2500ms absolute deadlines. No incomplete query is removed from coverage or called a negative.'] };
  let f;
  try {
    f = await fixture({ enabled: true, module: modulePath }); f.hookContext.SemanticRetrieval = primitive;
    for (const [sid, doc] of docsBySid) await f.put(sid, [{ role: 'user', id: 'm1', content: doc.text }]);
    const fingerprints = { modelFingerprint: 'sha256:' + ledger.modelSha256, runtimeFingerprint: 'sha256:' + ledger.runtimeLockSha256,
      templateFingerprint: 'sha256:' + hash(JSON.stringify(scalars.contract)), policyFingerprint: 'sha256:' + hash(JSON.stringify(CONTRACT)) };
    const scalarHost = { prepare: async () => ({ ok: true, ...fingerprints }), stop: async () => ({ workerExited: true, cleanupStatus: 'observed', replayNeverStarted: true }),
      verify: async (queryText, source, options) => {
        await options.beforeVerify();
        const query = queryByText.get(queryText), sid = source.identity.sessionId, doc = docsBySid.get(sid);
        if (!query || !doc || source.identity.field !== 'content' || source.identity.revision !== hash(JSON.stringify({ role: 'user', id: 'm1', content: doc.text }))) throw Error('Replay cannot identify actual source.');
        const measured = pairOutputs.get(JSON.stringify([query.id, sid, 'content', source.identity.start, source.identity.end, hash(source.text)]));
        if (!measured || !Number.isFinite(measured.probability)) throw Error('No genuinely measured scalar for this exact query/field/window.');
        report.scalarWrites++; return { ok: true, ...fingerprints, score: measured.probability, accepted: measured.probability >= CONTRACT.threshold };
      } };
    const bridge = createScalarVerifierBridge(scalarHost), policy = createCompositePolicy({ bridge, identify: primitive.structuredIds, normalize, terms: f.api.terms });
    const runtime = { prepare: async () => ({ available: true, modelId: 'qwen-prior-evidence-raw-replay', modelFingerprint: encoded.modelFingerprint, retrievalThresholds: { search: -1, automatic: null } }),
      encode: async (texts, options) => { await options.beforeEncode?.(); const vectors = texts.map(text => {
        if (options.role === 'query') { const query = queryByText.get(text); if (!query) throw Error('Unknown non-train/cal query.'); return queryVectors.get(query.id); }
        const doc = documentByText.get(text); if (!doc) throw Error('Unexpected original window: no genuine embedding available.'); return documentVectors.get(doc.id);
      }); if (vectors.some(value => !value)) throw Error('Missing measured vector.'); return { ok: true, modelFingerprint: encoded.modelFingerprint, vectors }; } };
    const scorer = primitive.create(runtime), namespace = vm.runInNewContext('SessionFullTextIndex;', f.hookContext);
    const index = namespace.create({ ...f.host, semantic: scorer, scalarComposite: policy, resultUnit: 'sessions' }); await index.prepare(null);
    for (const query of queries) {
      const began = Date.now(), deadline = began + 2500, check = () => { if (Date.now() >= deadline) throw Error('Research consumer2500ms exceeded.'); };
      const found = await index.search(query.text, null, 50, { deadline, check }); await index.revalidate(found, null, { check });
      const actual = found.results.map(hit => {
        const ref = hit.reference, doc = docsBySid.get(ref.sessionId);
        if (!doc || ref.messageId !== 'm1' || ref.source !== 'content' || ref.contentRevision !== hash(JSON.stringify({ role: 'user', id: 'm1', content: doc.text }))
          || hit.snippet !== doc.text.slice(ref.snippetStart, ref.snippetEnd)) throw Error('Actual reference/snippet mismatch.');
        return { id: doc.id, reference: ref, snippet: hit.snippet, score: hit.score, rankScore: hit.rankScore, semantic: hit.semanticScore !== undefined };
      });
      const diagnostic = index.researchReport(found), planned = expectedById.get(query.id), actualIds = actual.slice(0, 5).map(hit => hit.id), expectedIds = planned.top.map(hit => hit.id);
      const actualWork = diagnostic?.requiredWork || [], uniqueWork = new Set(actualWork.map(item => JSON.stringify(item.identity)));
      const rankAgrees = actual.slice(0, 5).every((hit, n) => {
        const baseline = planned.top[n]; if (!baseline) return false;
        // The offline evaluator stores the RRF component and sorts exact hits
        // separately.90a emits the same priority as +1 in public rankScore.
        const exactPriority = baseline.exact || primitive.structuredIds(query.text).length > 0 ? 1 : 0;
        return hit.semantic === !!baseline.semantic && Math.abs(hit.rankScore - (baseline.rankScore + exactPriority)) < 1e-12;
      });
      if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds) || uniqueWork.size !== planned.requiredPairs || !rankAgrees) throw Error('Actual producer replay differs from frozen policy: ' + query.id);
      const complete = found.coverage.complete === true && found.semantic.coverage === 'complete' && diagnostic?.complete === true && found.lexicalAdmission.partial === false;
      report.rows.push({ queryId: query.id, split: query.split, matchesFrozenPolicy: true, rrfComponentsAndSemanticFlagsAgree: rankAgrees, requiredPairs: planned.requiredPairs, scalar: diagnostic,
        sourceCoverage: found.coverage, semantic: found.semantic, lexicalAdmission: found.lexicalAdmission, complete, actual });
      if (!complete) throw Error('Prescribed query has incomplete source/coarse/scalar coverage: ' + query.id);
      report.coverage.completedQueries++;
      if (report.coverage.completedQueries % 40 === 0) console.log('ACTUAL_REPLAY ' + report.coverage.completedQueries + '/' + queries.length);
    }
    report.coverage.complete = report.coverage.completedQueries === queries.length;
    report.sourceAfter = Object.fromEntries(Object.entries(paths).map(([key, file]) => [key, { file, sha256: hash(fs.readFileSync(file)) }]));
    report.sourceBindingsStable = JSON.stringify(sourceBefore) === JSON.stringify(report.sourceAfter);
    if (!report.sourceBindingsStable) throw Error('Code/data source drifted.');
    report.status = 'PASS_ACTUAL_PRODUCER_REPLAY_NOT_LIVE_QUALIFICATION';
  } catch (error) { report.status = 'FAIL_REPLAY'; report.error = String(error.stack || error); }
  finally { if (f) await f.close(); report.workerCleanup = { cleanupStatus: 'observed', workerExited: true, nativeNeverStarted: true }; fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
  console.log(JSON.stringify({ output, status: report.status, coverage: report.coverage, scalarWrites: report.scalarWrites, error: report.error }));
  if (report.status !== 'PASS_ACTUAL_PRODUCER_REPLAY_NOT_LIVE_QUALIFICATION') process.exitCode = 1;
}
if (require.main === module) main(path.resolve(process.argv[2] || 'output/semantic-scalar-producer-development-v1/replay.json')).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
