'use strict';
// Current actual encrypted-source lexical capture, then offline fixed pair ledger.
// This tool never imports a model runtime or starts inference.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const { fixture: actualFixture } = require('../lib/fulltext-owned-producer-fixture');
const { identifiers } = require('./calibration-policy.cjs');
const protocol = require('./qwen-reranker-calibration-protocol.cjs');
const root = path.resolve('output/semantic-qwen-reranker-official-v1');
const fixturePath = path.join(__dirname, 'calibration-fixture.cjs'), corpus = require(fixturePath);
const hash = x => crypto.createHash('sha256').update(x).digest('hex'), read = f => JSON.parse(fs.readFileSync(f));
const sourcePaths = ['13ap-session-fulltext-index.js', '02-session-store.js', '06h-retrieval-index.js', '06ha-semantic-retrieval.js'].map(name => path.resolve('ruyi-workbench/app/src', name));
const sourceSnapshot = () => sourcePaths.map(file => ({ file, sha256: hash(fs.readFileSync(file)) }));
const expectedIndex = protocol.producer.requiredIndexSha256;
const requested = corpus.queries.filter(x => ['train', 'calibration'].includes(x.split));
function sourceId(docIndex) { return 'CAL' + String(docIndex).padStart(3, '0'); }
const documents = new Map(corpus.documents.map((doc, index) => [sourceId(index), { ...doc, index, sourceSessionId: sourceId(index) }]));
async function capture(output) {
  if (fs.existsSync(output)) throw Error('Use a new immutable capture.');
  const before = sourceSnapshot(); if (before[0].sha256 !== expectedIndex) throw Error('Current producer differs from the declared90a study.');
  const indexSource = fs.readFileSync(sourcePaths[0], 'utf8');
  // Evaluate the two exact current one-line normalizer declarations; no new
  // tokenizer/stopword policy is invented for the development capture.
  const canon = indexSource.match(/^  const canonicalText=.*;$/m)?.[0], normal = indexSource.match(/^  const normalize=.*;$/m)?.[0];
  if (!canon || !normal) throw Error('Current normalizer declaration absent.');
  const normalize = vm.runInNewContext(canon + '\n' + normal + '\nnormalize;');
  const returnMarker = 'return {sid,value,candidates,semanticRows,fragmentCount,entityTruncated,lexicalTruncated,totals};';
  const observation = "if(typeof __candidateObserver==='function')__candidateObserver({sid,candidateCount:candidates.length,entityTruncated,lexicalTruncated});";
  if (indexSource.split(returnMarker).length !== 2) throw Error('Pre-global-limit producer observation boundary drifted.');
  const observedSource = indexSource.replace(returnMarker, observation + returnMarker), observedPath = path.join(root, 'current90a-observed-index.cjs');
  if (fs.existsSync(observedPath)) { if (hash(fs.readFileSync(observedPath)) !== hash(observedSource)) throw Error('Observed producer copy changed.'); }
  else fs.writeFileSync(observedPath, observedSource, { flag: 'wx' });
  if (observedSource.replace(observation, '') !== indexSource) throw Error('Observation changed producer behavior.');
  const f = await actualFixture({ enabled: true, module: observedPath });
  const report = { schemaVersion: 1, status: 'RUNNING', scope: 'train-calibration-only', fixtureSha256: hash(fs.readFileSync(fixturePath)),
    captureScriptSha256: hash(fs.readFileSync(__filename)), sourceBefore: before, rows: [], modelsRun: 0,
    observation: { originalIndexSha256: hash(indexSource), observedIndexSha256: hash(observedSource), addedStatement: observation,
      recipe: 'Insert a metadata-only observer immediately before each per-session scanIndex return, after source dedup and before global4096/final50 limits. Removing that one statement restores the exact original90a bytes.' },
    limits: ['Actual current encrypted source/store/record/index/privacy owners, isolated synthetic corpus only.', 'Lexical-only pre-verifier capture intentionally retains weak pending evidence. Its results are not a precision/admission qualification.', 'Proof classification uses exact current normalization, current host retrievalTerms and shared full-ID parser on the same original field.'] };
  try {
    f.hookContext.SemanticRetrieval = vm.runInNewContext(fs.readFileSync(sourcePaths[3], 'utf8') + '\nSemanticRetrieval;', { require, Buffer, Date, setTimeout, clearTimeout });
    const namespace = vm.runInNewContext('SessionFullTextIndex;', f.hookContext);
    for (const doc of documents.values()) await f.put(doc.sourceSessionId, [{ role: 'user', id: 'm1', content: doc.text }]);
    const index = namespace.create({ ...f.host, resultUnit: 'sessions' }); await index.prepare(null);
    for (const query of requested) {
      const projected = [], candidateStages = [], requiredIds = identifiers(query.text), terms = [...new Set(f.api.terms(query.text).filter(x => typeof x === 'string' && !x.startsWith('#')).map(normalize))];
      f.hookContext.__candidateObserver = value => candidateStages.push(JSON.parse(JSON.stringify(value)));
      f.project(input => {
        const ref = input.reference, doc = documents.get(ref.sessionId);
        if (!doc || ref.messageId !== 'm1' || ref.source !== 'content' || input.sourceText !== doc.text) throw Error('Actual original source identity/text mismatch.');
        const field = normalize(input.sourceText), fieldIds = identifiers(input.sourceText), idsComplete = requiredIds.length > 0 && requiredIds.every(id => fieldIds.includes(id));
        if (requiredIds.length && !idsComplete) throw Error('Producer disclosed an incomplete structured-ID field.');
        const reason = idsComplete ? 'all-structured-identifiers-same-field' : field.includes(normalize(query.text)) ? 'exact-phrase-same-field'
          : terms.length > 0 && terms.every(term => field.includes(term)) ? 'all-effective-terms-same-field' : null;
        projected.push({ fixtureDocumentId: doc.id, sourceId: ref.sessionId + ':m1:content', reference: JSON.parse(JSON.stringify(ref)),
          rawFieldSha256: hash(input.sourceText), rawWindowSha256: hash(input.sourceText.slice(ref.start, ref.end)), strong: reason !== null, strongReason: reason,
          requiredIdentifierCount: requiredIds.length, effectiveTermCount: terms.length });
      });
      const found = await index.search(query.text, null, 50);
      if (found.results.length !== projected.length || projected.some((row, n) => JSON.stringify(row.reference) !== JSON.stringify(found.results[n].reference))) throw Error('Actual projection/result ledger mismatch.');
      report.rows.push({ queryId: query.id, split: query.split, querySha256: hash(query.text), hits: projected,
        preFinalLimit: { sessionsObserved: candidateStages.length, uniqueSessions: new Set(candidateStages.map(x => x.sid)).size,
          candidateCount: candidateStages.reduce((sum, x) => sum + x.candidateCount, 0), sessions: candidateStages.sort((a, b) => a.sid.localeCompare(b.sid)) },
        coverage: { sourceComplete: found.coverage.complete === true, sourceCoverage: found.coverage,
          candidateSelectionComplete: candidateStages.length === 60 && new Set(candidateStages.map(x => x.sid)).size === 60
            && candidateStages.every(x => !x.entityTruncated && !x.lexicalTruncated) && candidateStages.reduce((sum, x) => sum + x.candidateCount, 0) <= 50
            && found.lexicalAdmission?.truncated !== true && found.entity?.partial !== true,
          weakUnverified: projected.filter(x => !x.strong).length, lexicalPartialBeforeVerifier: found.lexicalAdmission?.partial === true } });
    }
    report.sourceAfter = sourceSnapshot(); report.sourceStable = JSON.stringify(before) === JSON.stringify(report.sourceAfter);
    report.status = report.sourceStable && report.rows.length === requested.length && report.rows.every(x => x.coverage.sourceComplete && x.coverage.candidateSelectionComplete) ? 'PASS_CURRENT_COMPLETE_CAPTURE' : 'FAIL_PARTIAL_CAPTURE';
  } catch (error) { report.status = 'FAIL'; report.error = String(error.stack || error); }
  finally { await f.close(); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
  console.log(JSON.stringify({ output, status: report.status, queries: report.rows.length, hits: report.rows.reduce((n, q) => n + q.hits.length, 0), weak: report.rows.reduce((n, q) => n + q.hits.filter(x => !x.strong).length, 0), error: report.error }));
  if (report.status !== 'PASS_CURRENT_COMPLETE_CAPTURE') process.exitCode = 1;
}
function plan(output, capturePath) {
  if (fs.existsSync(output)) throw Error('Use a new immutable ledger.');
  const captured = read(capturePath), miniPath = path.resolve('output/semantic-calibration-minilm-v3-vectors.json'), qwenPath = path.resolve('output/semantic-qwen3-stateless-development-v1.json');
  const mini = read(miniPath), qwen = read(qwenPath), variant = qwen.variants.find(x => x.id === 'prior-evidence');
  if (captured.status !== 'PASS_CURRENT_COMPLETE_CAPTURE' || !captured.sourceStable || captured.sourceBefore[0].sha256 !== expectedIndex
    || [mini, qwen, captured].some(x => x.fixtureSha256 !== hash(fs.readFileSync(fixturePath)))) throw Error('Unqualified current source/vector capture.');
  const conservationFailures = [];
  for (const row of captured.rows) {
    if (row.preFinalLimit.candidateCount !== row.hits.length) conservationFailures.push({ queryId: row.queryId, phase: 'global', before: row.preFinalLimit.candidateCount, projected: row.hits.length });
    for (const stage of row.preFinalLimit.sessions) {
      const count = row.hits.filter(hit => hit.reference.sessionId === stage.sid).length;
      if (count !== stage.candidateCount) conservationFailures.push({ queryId: row.queryId, sid: stage.sid, before: stage.candidateCount, projected: count });
    }
  }
  if (conservationFailures.length) throw Error('Pre-cap/projected field candidates differ; do not silently shrink scope.');
  const captureRows = new Map(captured.rows.map(q => [q.queryId, q])), profileDefinitions = protocol.producer.profiles;
  const allowIds = new Set(requested.map(q => q.id));
  function freezeView(id, input, rows, sourceFile, fingerprint) {
    // Whole historical JSON is parsed; only allowlisted rows are selected
    // before vector access/Map creation, and a train/cal-only view is frozen.
    const queries = rows.filter(row => allowIds.has(row.id));
    if (queries.length !== allowIds.size || new Set(queries.map(row => row.id)).size !== allowIds.size) throw Error('Incomplete train/cal vector view.');
    const value = { schemaVersion: 1, status: 'PASS_FROZEN_TRAIN_CAL_VIEW', fixtureSha256: input.fixtureSha256,
      sourceFile, sourceFileSha256: hash(fs.readFileSync(sourceFile)), modelFingerprint: fingerprint,
      documents: input.documents, queries, excludedQueryRows: rows.length - queries.length,
      dataflow: 'Existing container parsed; non-allowlisted query vector fields are never accessed for projection/ranking/fitting/selection. Only the full fixed60-document corpus is retained.' };
    const file = path.join(root, id + '-train-cal-vectors-v1.json'), bytes = JSON.stringify(value, null, 2) + '\n';
    if (fs.existsSync(file)) { if (hash(fs.readFileSync(file)) !== hash(bytes)) throw Error('Frozen vector view changed.'); }
    else fs.writeFileSync(file, bytes, { flag: 'wx' });
    return { file, value };
  }
  const miniView = freezeView('minilm', mini, mini.queries, miniPath, mini.ready.modelFingerprint);
  const qwenView = freezeView('qwen-prior-evidence', qwen, variant.queries, qwenPath, variant.representationFingerprint);
  const vectors = Object.fromEntries([['minilm', miniView], ['qwen-prior-evidence', qwenView]].map(([name, view]) => [name,
    { dv: new Map(view.value.documents.map(x => [x.id, x.vector])), qv: new Map(view.value.queries.map(x => [x.id, x.vector])) }]));
  const pairs = new Map(), queryPlans = [];
  for (const query of requested) {
    const current = captureRows.get(query.id), strong = current.hits.filter(x => x.strong), weak = current.hits.filter(x => !x.strong), required = identifiers(query.text);
    const strongIds = new Set(strong.map(x => x.fixtureDocumentId)), ranks = {};
    for (const [name, data] of Object.entries(vectors)) {
      const q = data.qv.get(query.id); if (!q) throw Error('Missing real query vector.');
      ranks[name] = [...documents.values()].map(doc => ({ doc, cosine: q.reduce((sum, value, n) => sum + value * data.dv.get(doc.id)[n], 0) }))
        .filter(x => required.every(id => identifiers(x.doc.text).includes(id))).sort((a, b) => b.cosine - a.cosine || a.doc.index - b.doc.index);
    }
    const perProfile = {};
    for (const profile of profileDefinitions) {
      const union = new Map();
      for (const [rank, item] of ranks[profile.encoder].slice(0, profile.topK).entries()) if (!strongIds.has(item.doc.id)) union.set(item.doc.id, { doc: item.doc, roles: ['semantic'], coarseRank: rank + 1, cosine: item.cosine });
      for (const hit of weak) { const doc = documents.get(hit.reference.sessionId); if (!union.has(doc.id)) union.set(doc.id, { doc, roles: ['weak-lexical'] }); else union.get(doc.id).roles.push('weak-lexical'); }
      perProfile[profile.id] = [];
      for (const item of union.values()) {
        const doc = item.doc, ref = current.hits.find(x => x.fixtureDocumentId === doc.id)?.reference;
        const revision = hash(JSON.stringify({ role: 'user', id: 'm1', content: doc.text }));
        if (ref && ref.contentRevision !== revision) throw Error('Actual source revision disagrees with original source row.');
        const identity = { sessionId: doc.sourceSessionId, messageId: 'm1', source: 'content', contentRevision: revision, start: 0, end: doc.text.length };
        const key = hash(JSON.stringify([query.id, hash(query.text), identity, hash(doc.text)]));
        if (!pairs.has(key)) pairs.set(key, { pairId: key, queryId: query.id, split: query.split, fixtureDocumentId: doc.id, sourceId: doc.sourceSessionId + ':m1:content',
          sourceIdentity: identity, querySha256: hash(query.text), rawFieldSha256: hash(doc.text), profiles: [],
          tokenization: { status: 'pending-native-joint-tokenizer', jointTokens: null, hostLimit: 512, truncate: false } });
        pairs.get(key).profiles.push(profile.id); perProfile[profile.id].push({ pairId: key, roles: item.roles, ...(item.coarseRank ? { coarseRank: item.coarseRank, cosine: item.cosine } : {}) });
      }
    }
    queryPlans.push({ queryId: query.id, split: query.split, strongEvidence: strong, weakEvidenceCount: weak.length, perProfile });
  }
  const ledger = [...pairs.values()];
  const runtimeLockPath = path.join(root, 'runtime/rank-buffer-t6.lock.json');
  const report = { schemaVersion: 1, status: 'FROZEN_PLAN_PENDING_NATIVE_TOKEN_COUNTS_NO_INFERENCE', fixtureSha256: captured.fixtureSha256,
    planScriptSha256: hash(fs.readFileSync(__filename)), adapterSourceSha256: hash(fs.readFileSync(path.join(__dirname, 'qwen-reranker-native.cjs'))),
    protocolSourceSha256: hash(fs.readFileSync(path.join(__dirname, 'qwen-reranker-calibration-protocol.cjs'))), protocolReceiptSha256: hash(fs.readFileSync(path.join(root, 'calibration-protocol-v2.json'))),
    capturePath, captureSha256: hash(fs.readFileSync(capturePath)), runtimeLockPath, runtimeLockSha256: hash(fs.readFileSync(runtimeLockPath)),
    candidateConservation: { queries: captured.rows.length, sessionsObservedPerQuery: 60,
      totalBeforeGlobalLimit: captured.rows.reduce((n, q) => n + q.preFinalLimit.candidateCount, 0), totalVerifiedProjected: captured.rows.reduce((n, q) => n + q.hits.length, 0),
      maxBeforeGlobalLimitPerQuery: Math.max(...captured.rows.map(q => q.preFinalLimit.candidateCount)), globalCap: 4096, finalCap: 50,
      perQueryPerSourceIdentityMatched: true, failures: conservationFailures },
    vectorSources: [miniView.file, qwenView.file].map(file => ({ file, sha256: hash(fs.readFileSync(file)) })), modelSha256: protocol.verifier.modelSha256,
    strongBypassOrder: 'Choose the declared raw topK first, then remove only same-field strong evidence from verifier work; never refill beyond K merely because a strong field bypassed inference.',
    profiles: profileDefinitions, grid: protocol.fixedGrid, pairs: ledger, pairsSha256: hash(JSON.stringify(ledger)), queries: queryPlans,
    counts: { queries: queryPlans.length, uniquePairs: ledger.length, pendingJointTokenCounts: ledger.length,
      perProfile: Object.fromEntries(profileDefinitions.map(p => [p.id, queryPlans.reduce((n, q) => n + q.perProfile[p.id].length, 0)])),
      weakLexicalHits: queryPlans.reduce((n, q) => n + q.weakEvidenceCount, 0) },
    sourceReplay: 'Collector must recreate the actual encrypted-source fixture from this same immutable corpus/producer, verify every field identity/revision/hash and fresh source epochs/authority before text writes. No stale capture authorization object or ciphertext epoch is reused across fixture generations.',
    limits: ['No inference/model/compile run. All joint counts remain pending, not guessed from another tokenizer.', 'Strong evidence only bypasses its same original field; no unconditional historical lexical union.', 'All 36 fixed policies reuse this predeclared pair union; incomplete/null results may not shrink scope or OOD denominators.', 'No check/acceptance fixture/query/label/report is evaluated.'] };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, pairCount: ledger.length, pairsSha256: report.pairsSha256, counts: report.counts, adapterSourceSha256: report.adapterSourceSha256, runtimeLockSha256: report.runtimeLockSha256 }));
}
const mode = process.argv[2], output = path.resolve(process.argv[3] || path.join(root, mode === 'capture' ? 'current90a-lexical-capture-v1.json' : 'development-pair-plan-v1.json'));
if (require.main === module) (mode === 'capture' ? capture(output) : mode === 'plan' ? Promise.resolve().then(() => plan(output, path.resolve(process.argv[4]))) : Promise.reject(Error('Use capture <new-output> or plan <new-output> <capture>'))).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { capture, plan };
