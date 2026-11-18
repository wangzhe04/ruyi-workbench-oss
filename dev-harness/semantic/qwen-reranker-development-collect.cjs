'use strict';
// Genuine fixed-ledger scalar collection. No threshold selection or holdout.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { fixture: actualFixture } = require('../lib/fulltext-owned-producer-fixture');
const { createVerifier } = require('./qwen-reranker-native.cjs');
const root = path.resolve('output/semantic-qwen-reranker-official-v1');
const ledgerPath = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
const fixturePath = path.join(__dirname, 'calibration-fixture.cjs'), corpus = require(fixturePath);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex'), read = file => JSON.parse(fs.readFileSync(file));
async function digest(file) { const value = crypto.createHash('sha256'); for await (const data of fs.createReadStream(file)) value.update(data); return value.digest('hex'); }
if (fs.existsSync(output)) throw Error('Use a new immutable collection receipt.');
const frozenLedgerSha256 = 'c4b8535b02d05c2dbdc62cad162dce5761cb8c1f31f85ddfe592682890f75ebd';
const ledgerBytes = fs.readFileSync(ledgerPath);
if (hash(ledgerBytes) !== frozenLedgerSha256) throw Error('Collector requires the independently reviewed frozen ledger bytes.');
const ledger = JSON.parse(ledgerBytes), capture = read(ledger.capturePath);
const allowedQueries = corpus.queries.filter(x => ['train', 'calibration'].includes(x.split)), queries = new Map(allowedQueries.map(q => [q.id, q]));
const documents = new Map(corpus.documents.map((doc, i) => ['CAL' + String(i).padStart(3, '0'), doc]));
const adapterPath = path.join(__dirname, 'qwen-reranker-native.cjs'), launcherPath = path.join(__dirname, 'native-job-launcher.cjs');
const bindings = [{ file: ledgerPath, sha256: frozenLedgerSha256 },
  { file: fixturePath, sha256: ledger.fixtureSha256 }, { file: ledger.capturePath, sha256: ledger.captureSha256 },
  { file: adapterPath, sha256: ledger.adapterSourceSha256 }, { file: ledger.runtimeLockPath, sha256: ledger.runtimeLockSha256 },
  ...ledger.vectorSources, ...capture.sourceBefore,
  { file: path.join(__dirname, 'qwen-reranker-calibration-protocol.cjs'), sha256: ledger.protocolSourceSha256 },
  { file: path.join(root, 'calibration-protocol-v2.json'), sha256: ledger.protocolReceiptSha256 },
  { file: path.join(__dirname, 'qwen-reranker-pair-plan.cjs'), sha256: ledger.planScriptSha256 },
  { file: path.join(root, 'repro/pair-plan-capture-v2.cjs'), sha256: capture.captureScriptSha256 },
  { file: __filename, sha256: hash(fs.readFileSync(__filename)) }, { file: launcherPath, sha256: hash(fs.readFileSync(launcherPath)) }];
function verifyBindings() { for (const item of bindings) if (hash(fs.readFileSync(item.file)) !== item.sha256) throw Error('Frozen code/data binding changed: ' + path.basename(item.file)); }
function verifyPair(pair) {
  const query = queries.get(pair.queryId), doc = documents.get(pair.sourceIdentity.sessionId), identity = pair.sourceIdentity;
  if (!query || !doc || query.split !== pair.split || doc.id !== pair.fixtureDocumentId || identity.messageId !== 'm1' || identity.source !== 'content'
    || identity.start !== 0 || identity.end !== doc.text.length || hash(query.text) !== pair.querySha256 || hash(doc.text) !== pair.rawFieldSha256
    || hash(JSON.stringify({ role: 'user', id: 'm1', content: doc.text })) !== identity.contentRevision) throw Error('Ledger original source/query mismatch.');
  return { query, doc };
}
verifyBindings();
if (ledger.status !== 'FROZEN_PLAN_PENDING_NATIVE_TOKEN_COUNTS_NO_INFERENCE' || hash(JSON.stringify(ledger.pairs)) !== ledger.pairsSha256
  || ledger.counts.uniquePairs !== ledger.pairs.length || new Set(ledger.pairs.map(p => p.pairId)).size !== ledger.pairs.length) throw Error('Invalid frozen pair ledger.');
ledger.pairs.forEach(verifyPair);
const abort = new AbortController();
process.once('SIGINT', () => abort.abort(new Error('research.cancelled'))); process.once('SIGTERM', () => abort.abort(new Error('research.cancelled')));
const report = { schemaVersion: 1, status: 'RUNNING', startedAt: new Date().toISOString(), collectorSourceSha256: hash(fs.readFileSync(__filename)),
  adapterSourceSha256: ledger.adapterSourceSha256, runtimeLockSha256: ledger.runtimeLockSha256, ledgerSha256: frozenLedgerSha256,
  ledgerPath, pairsSha256: ledger.pairsSha256, fixtureSha256: ledger.fixtureSha256, modelSha256: ledger.modelSha256,
  sourceBindings: bindings, requestedPairs: ledger.pairs.length, pairs: [], researchBatches: [], guardCalls: 0, modelsStarted: 0,
  network: { applicationOffline: true, loopbackOnly: true, osFirewall: false },
  limits: ['All planned train/cal pairs require real native inference. No check/acceptance query or threshold result is consumed.', 'Joint512 refusals, source drift or unobserved cleanup stop this entire collection without shrinking scope.', 'Developer collection uses research batching; this does not prove a production1s/500ms request budget or dual-model RSS.', 'Actual encrypted-source fixture is recreated with fresh source epochs. Captured authorization objects/epochs are not reused.'] };
let f, verifier, failure, prepareAttempted = false;
(async () => {
  try {
    f = await actualFixture({ enabled: true });
    for (const [sid, doc] of documents) await f.put(sid, [{ role: 'user', id: 'm1', content: doc.text }]);
    const scope = await f.host.scope(null), liveSources = new Map();
    async function guard(pair) {
      report.guardCalls++; if (abort.signal.aborted) throw abort.signal.reason;
      verifyPair(pair);
      if (!await f.host.enabled() || f.host.assertScope(null, scope) !== true || await f.host.authorize(pair.sourceIdentity.sessionId, null, scope) !== true) throw Error('Synthetic source authority changed.');
      const sid = pair.sourceIdentity.sessionId, sequence = f.host.sourceSequence(sid); let found = 0;
      const proof = await f.host.scan(sid, async (row, ordinal) => {
        if (ordinal !== 0 || row.id !== 'm1' || row.role !== 'user' || typeof row.content !== 'string'
          || hash(JSON.stringify(row)) !== pair.sourceIdentity.contentRevision || hash(row.content) !== pair.rawFieldSha256) throw Error('Actual original field/revision mismatch.');
        found++;
      }, { check: () => { if (abort.signal.aborted) throw abort.signal.reason; } });
      if (found !== 1 || !proof || await f.host.epoch(sid) !== proof.epoch || f.host.sourceSequence(sid) !== sequence || f.host.assertScope(null, scope) !== true
        || f.host.assertAuthorized(sid, null, scope) !== true) throw Error('Actual source proof changed across await.');
      const state = JSON.stringify([proof.epoch, proof.revision, sequence]);
      if (liveSources.has(sid) && liveSources.get(sid) !== state) throw Error('Actual source generation changed.');
      liveSources.set(sid, state);
    }
    // Validate every prescribed source before the native process receives text.
    for (const pair of ledger.pairs) await guard(pair);
    verifyBindings();
    prepareAttempted = true; verifier = await createVerifier({ profile: 'rank-buffer-t6' }); report.modelsStarted++;
    if (verifier.runtimeLockSha256 !== ledger.runtimeLockSha256 || verifier.adapterSourceSha256 !== ledger.adapterSourceSha256) throw Error('Native profile/source differs from ledger.');
    report.verifierFingerprint = verifier.fingerprint; report.contract = verifier.contract; report.nativeLaunchToReadyMs = verifier.coldReadyMs;
    let batchStart = Date.now(), batchOffset = 0;
    for (let n = 0; n < ledger.pairs.length; n++) {
      const pair = ledger.pairs[n], { query, doc } = verifyPair(pair), began = Date.now();
      const result = await verifier.score(query.text, doc.text, { signal: abort.signal, beforeRerank: () => guard(pair) });
      if (!result.ok || !Number.isSafeInteger(result.tokens) || result.tokens > 512 || !Number.isFinite(result.probability)) {
        report.refusal = { pairId: pair.pairId, result }; throw Error('Prescribed pair was refused; coverage unknown, stop without scope reduction.');
      }
      report.pairs.push({ pairId: pair.pairId, queryId: pair.queryId, sourceId: pair.sourceId, probability: result.probability,
        jointTokens: result.tokens, nativeHttpMs: result.elapsedMs, wholePairMs: Date.now() - began });
      if (Date.now() - batchStart >= 20000 || n === ledger.pairs.length - 1) {
        report.researchBatches.push({ offset: batchOffset, completed: n + 1 - batchOffset, elapsedMs: Date.now() - batchStart }); batchOffset = n + 1; batchStart = Date.now();
      }
      if ((n + 1) % 50 === 0) console.log(`REAL_PAIRS ${n + 1}/${ledger.pairs.length}`);
    }
    for (const pair of new Map(ledger.pairs.map(pair => [pair.sourceId, pair])).values()) await guard(pair);
    verifyBindings();
    if (await digest(path.join(root, 'artifacts/qwen3-reranker-0.6b-rank-q4_k_m.gguf')) !== ledger.modelSha256) throw Error('Final model bytes changed.');
    const runtimeLock = read(ledger.runtimeLockPath);
    for (const file of runtimeLock.files) if (await digest(path.join(root, 'runtime/rank-buffer-t6', file.path)) !== file.sha256) throw Error('Final runtime bytes changed.');
    report.sourceBindingsStable = true;
    report.coverage = { complete: report.pairs.length === ledger.pairs.length, requestedPairs: ledger.pairs.length, measuredPairs: report.pairs.length, refusedPairs: 0 };
    report.status = 'COMPLETE_SCALAR_COLLECTION_NOT_QUALITY_VERDICT';
  } catch (error) { failure = error; report.status = 'FAIL_STOPPED_WITHOUT_SCOPE_REDUCTION'; report.error = String(error?.stack || error); }
  finally {
    if (verifier) { report.nativeStats = verifier.stats(); try { report.cleanup = await verifier.stop(); } catch (error) { report.cleanup = { workerExited: false, error: String(error) }; } }
    else if (!prepareAttempted) report.cleanup = { workerExited: true, cleanupStatus: 'observed', nativeNeverStarted: true };
    if (f) { try { await f.close(); } catch (error) { report.sourceCleanupError = String(error); report.status = 'FAIL_SOURCE_CLEANUP'; } }
    if (report.cleanup?.cleanupStatus !== 'observed' || report.cleanup?.workerExited !== true) report.status = 'FAIL_UNOBSERVED_CLEANUP';
    report.finishedAt = new Date().toISOString(); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, status: report.status, requestedPairs: ledger.pairs.length, completedPairs: report.pairs.length, cleanup: report.cleanup, error: report.error }));
    if (failure || report.status !== 'COMPLETE_SCALAR_COLLECTION_NOT_QUALITY_VERDICT') process.exitCode = 1;
  }
})();
