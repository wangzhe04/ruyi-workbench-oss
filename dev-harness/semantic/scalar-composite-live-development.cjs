'use strict';
// Actual native/controller/source/public-consumer development study. No vector
// or scalar matrix is read. No acceptance fixture and no policy selection.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { performance } = require('node:perf_hooks');
const { fixture } = require('./scalar-window-append-public-consumer-fixture.cjs');
const { CONTRACT: windowContract } = require('./scalar-window-policy-research.cjs');
const { snapshot } = require('./scalar-live-memory-snapshot.cjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function digest(file) { const value = crypto.createHash('sha256'); for await (const data of fs.createReadStream(file)) value.update(data); return value.digest('hex'); }
const clone = value => JSON.parse(JSON.stringify(value));
const complete = result => result?.coverage?.complete === true && result.semantic?.coverage === 'complete' && result.lexicalAdmission?.partial !== true && result.partial !== true;
function classify(hit, diagnostic) {
  const ref = hit.reference;
  const matches = identity => {
    if (!ref || !identity || identity.field !== ref.source) return false;
    try { const source = JSON.parse(identity.sourceId); return Array.isArray(source) && source[0] === ref.sessionId && source[1] === ref.messageId; } catch { return false; }
  };
  const accepted = new Set((diagnostic?.scores || []).filter(row => row.accepted === true).map(row => JSON.stringify(row.identity)));
  const weakLexical = (diagnostic?.requiredWork || []).some(row => row.role === 'weak-lexical' && matches(row.identity) && accepted.has(JSON.stringify(row.identity)));
  const strongLexical = (diagnostic?.strongEvidence || []).some(row => {
    if (row.role !== 'weak-lexical' || !ref) return false;
    const key = JSON.parse(row.fieldKey); return key[0] === ref.sessionId && key[1] === ref.messageOrdinal && key[2] === ref.source;
  });
  const semantic = hit.semanticScore !== undefined;
  return { semantic, semanticOnly: semantic && !weakLexical && !strongLexical, weakLexical, strongLexical };
}
function metrics(rows) {
  const quality = values => ({ count: values.length, recallAt5: values.length ? values.filter(row => row.rank > 0).length / values.length : null,
    mrr: values.length ? values.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / values.length : null,
    partial: values.filter(row => !row.complete).length });
  const positives = rows.filter(row => row.kind === 'positive');
  const negative = kind => { const values = rows.filter(row => row.kind === kind), observed = values.filter(row => row.results.length > 0).length,
    unknownNoResult = values.filter(row => !row.complete && !row.results.length).length, known = values.filter(row => row.complete);
    const semanticOnly = values.filter(row => row.results.some(hit => hit.semanticOnly)).length, weak = values.filter(row => row.results.some(hit => hit.weakLexical)).length;
    return { count: values.length, observedResults: observed, observedAnyResultFpr: values.length ? observed / values.length : null,
      semanticOnlyObservedResults: semanticOnly, semanticOnlyObservedFpr: values.length ? semanticOnly / values.length : null,
      weakLexicalObservedResults: weak, weakLexicalObservedFpr: values.length ? weak / values.length : null,
      partialNoResultUnknown: unknownNoResult, trueNegatives: values.filter(row => row.complete && !row.results.length).length,
      conservativeFprUpperBound: values.length ? (observed + unknownNoResult) / values.length : null,
      completeSubset: { count: known.length, fpr: known.length ? known.filter(row => row.results.length).length / known.length : null } }; };
  return { coverage: { queries: rows.length, complete: rows.filter(row => row.complete).length, partial: rows.filter(row => !row.complete).length },
    quality: { all: quality(positives), groups: Object.fromEntries([...new Set(positives.map(row => row.group))].map(group => [group, quality(positives.filter(row => row.group === group))])) },
    pureOod: negative('ood'), entityMismatch: negative('entity-mismatch'), missingFieldDiagnostic: negative('missing-field'), missingNumberDiagnostic: negative('missing-number') };
}
function countSnapshot(encoder, scalarHost, observerCounts) {
  const stats = target => { try { return clone(target.stats()); } catch (error) { return { diagnosticError: String(error) }; } };
  return { encoderCalls: clone(encoder), nativeCoarse: stats(observerCounts.profile.encoder), nativeScalar: stats(scalarHost) };
}
async function run(options) {
  const directory = path.resolve(options.directory); fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, 'receipt.json'); if (fs.existsSync(output)) throw Error('Use a new immutable live-development directory.');
  const profile = options.profile, native = profile?.kind === 'native-research';
  if (!profile || !['native-research', 'synthetic-test'].includes(profile.kind) || !profile.id || !profile.encoder || !profile.scalarHost || !Array.isArray(profile.bindings)) throw TypeError('Live profile contract invalid.');
  if (native && profile.descriptor?.policyId !== windowContract.id) throw Error('Live native profile must bind the exact window-v2 policy/cache contract.');
  const fixturePath = path.join(__dirname, 'calibration-fixture.cjs');
  if (native && hash(fixturePath) !== 'ce9cde6ac1ac5d44f838b2cba291398d047cfa0ff725646301eb4468e49f7c25') throw Error('Fixed development fixture bytes changed.');
  const corpus = options.corpus || require(fixturePath);
  if (native && (options.corpus || corpus.releaseHoldout !== false)) throw Error('Native runner accepts only its fixed development fixture.');
  const queries = corpus.queries.filter(query => ['train', 'calibration'].includes(query.split));
  if (native && (corpus.documents.length !== 60 || queries.length !== 248)) throw Error('Development cohort changed.');
  const sources = ['scalar-composite-live-development.cjs', 'scalar-public-consumer-fixture.cjs', 'scalar-live-research-layout.cjs', 'scalar-consumer-live-research-source.cjs',
    'scalar-composite-policy-research.cjs', 'scalar-producer-research-source.cjs', 'scalar-consumer-research-source.cjs', 'scalar-live-memory-snapshot.cjs',
    'scalar-window-policy-research.cjs', 'scalar-window-producer-research-source.cjs', 'scalar-window-consumer-research-source.cjs',
    'scalar-window-live-layout.cjs', 'scalar-window-public-consumer-fixture.cjs', 'scalar-window-append-live-layout.cjs',
    'scalar-window-append-public-consumer-fixture.cjs', 'scalar-window-append-cache-research-source.cjs'].map(name => path.join(__dirname, name));
  sources.push(...['13ap-session-fulltext-index.js', '13as-session-fulltext-consumers.js', '06ha-semantic-retrieval.js'].map(name => path.resolve('ruyi-workbench/app/src', name)));
  const bindings = [...sources.map(file => ({ file, sha256: hash(file) })), ...(native ? [{ file: fixturePath, sha256: hash(fixturePath) }] : []), ...profile.bindings];
  for (const binding of bindings) if (!/^[a-f0-9]{64}$/.test(binding.sha256) || await digest(binding.file) !== binding.sha256) throw Error('Profile/source binding changed: ' + binding.file);
  const controller = options.controller || new AbortController(); const signal = controller.signal;
  const cancelled = () => { if (signal.aborted) throw signal.reason === undefined ? Error('research.cancelled') : signal.reason; };
  const encoderCounts = { calls: { query: 0, document: 0 }, submitted: { query: 0, document: 0 }, completed: { query: 0, document: 0 }, successful: { query: 0, document: 0 } };
  const encoder = { ...profile.encoder, async encode(texts, opts) {
    cancelled(); encoderCounts.calls[opts.role]++; encoderCounts.submitted[opts.role] += texts.length;
    const result = await profile.encoder.encode(texts, opts); encoderCounts.completed[opts.role] += result.ok ? result.vectors.length : Number(result.completed) || 0;
    if (result.ok) encoderCounts.successful[opts.role] += result.vectors.length; return result;
  } };
  const docs = new Map(corpus.documents.map((doc, index) => ['CAL' + String(index).padStart(3, '0'), doc]));
  const report = { schemaVersion: 1, status: 'RUNNING', startedAt: new Date().toISOString(), profile: { id: profile.id, kind: profile.kind, descriptor: profile.descriptor },
    bindings, prescribedQueries: queries.length, measuredQueries: 0, cold: {}, prewarm: [], rows: [], memorySnapshots: [], privateHarnessObservations: [],
    contract: { semanticBudgetMs: 1000, consumerBudgetMs: 2500, coldPrepareBudgetPerModelMs: 20000, prewarmMaxCalls: 128, queryAttempts: 1,
      warmupQuery: 'semantic index warmup', corpus: 'Exact60 raw development fields; empty metadata title/summary/cwd, not label-derived hints.',
      scalar: 'raw global eligibleK1 plus scalar>=.95; fixed best original96/16 window per weak field; precise identity/coords dedup; strong lexical only; no old.46 gate or refill',
      policyId: windowContract.id, metadataContext: 'Whole same admitted field after privacy projection, reference:null; not an exact-window quote.',
      representationCache: 'Approved append-stable raw message identity; complete scope/model/raw-revision/field/window/text binding; old metadata/attachment keys, auth/epoch/citation/projection checks unchanged.',
      partial: 'Every query stays in its prescribed denominator; partial no-result is unknown, never a true negative.',
      resources: 'Current coarse+scalar working sets from one OS snapshot batch with creation identities. Report observed paired maxima, never add independent peaks.' },
    limits: ['Development integration and coverage study, not independent acceptance or production/default adoption.', 'Short60-field cohort is not the1000-fragment formal p95 workload. Resource sampling occurs outside query timers and can miss transient peaks.',
      'The paired working-set sum can count pages shared by both processes twice; it is not exclusive incremental physical RAM.',
      'No model-output cache prefill, vectors/scalars JSON or consumed holdout query is read.', 'Private source identities/revisions are harness-only; normal public DTOs retain existing privacy/opaque reference rules.',
      'Cold loading/recovery and cleanup can exceed foreground deadlines; no OS hard wall-clock deadline is claimed.'] };
  let f, pendingObservations = [], failure, hasFailure = false, expectedMemory = null;
  const observe = (result, detail) => pendingObservations.push({ result, detail });
  async function sample(phase) {
    if (!native) { report.memorySnapshots.push({ phase, complete: false, reason: 'synthetic-profile-no-native-memory' }); return; }
    const owned = profile.ownedIdentities(); if (!owned.coarse || !owned.scalar) { report.memorySnapshots.push({ phase, complete: false, reason: 'not-both-owned-live' }); return; }
    const rebind = !expectedMemory || ['coarse', 'scalar'].some(role => expectedMemory[role].pid !== owned[role].pid);
    if (rebind) expectedMemory = clone(owned);
    const value = await snapshot(expectedMemory, path.join(directory, 'memory-home'));
    if (value.complete && !expectedMemory.coarse.creationFileTime) expectedMemory.coarse.creationFileTime = value.rows.find(row => row.role === 'coarse').creationFileTime;
    report.memorySnapshots.push({ phase, ownedGenerationRebound: rebind, ...value, nodeHarness: process.memoryUsage() });
  }
  async function request(query) {
    pendingObservations = []; cancelled(); const began = performance.now(), result = await f.ui(query, null, async ({ req, hooks }) => {
      const abortRequest = () => { req.aborted = true; req.emit('aborted'); };
      signal.addEventListener('abort', abortRequest, { once: true });
      if (signal.aborted) abortRequest();
      try { return await hooks.search(query, 50); } finally { signal.removeEventListener('abort', abortRequest); }
    }); cancelled();
    return { result, elapsedMs: performance.now() - began, observations: pendingObservations };
  }
  try {
    f = await fixture({ enabled: true, runtime: encoder, scalarHost: profile.scalarHost, observeSearch: observe, researchDirectory: path.join(directory, 'source') });
    fs.writeFileSync(path.join(f.directory, 'OWNER.json'), JSON.stringify({ owner: 'scalar-composite-live-development', synthetic: true }) + '\n', { flag: 'wx' });
    for (const [sid, doc] of docs) await f.put(sid, [{ role: 'user', id: 'm1', content: doc.text }], { head: { title: '', summary: '', cwd: '', kind: 'mission' } });
    report.fixtureRecipe = f.fixtureRecipe; report.producerRecipe = f.sources.producer; report.consumerRecipe = { ...f.sources.consumer, source: undefined };
    let began = performance.now(); report.cold.encoder = await profile.encoder.prepare({ deadline: Date.now() + 20000, signal }); report.cold.encoderElapsedMs = performance.now() - began;
    if (report.cold.encoder.available !== true) throw Error('Explicit cold encoder preparation failed.');
    began = performance.now(); report.cold.scalar = await profile.scalarHost.prepare({ deadline: Date.now() + 20000, signal }); report.cold.scalarElapsedMs = performance.now() - began;
    if (report.cold.scalar.ok !== true) throw Error('Explicit cold scalar preparation failed.');
    await sample('both-models-ready');
    let warmed = false;
    for (let n = 0; n < 128; n++) {
      const measured = await request(report.contract.warmupQuery), result = measured.result;
      report.prewarm.push({ call: n + 1, elapsedMs: measured.elapsedMs, coverage: result.coverage, semantic: result.semantic, lexicalAdmission: result.lexicalAdmission,
        complete: complete(result), observedSearches: measured.observations.map(item => ({ status: item.detail?.complete, globalCandidates: item.detail?.globalCandidateCount,
          selected: item.detail?.globalSelectedIndices, scalarPairs: item.detail?.scalarPairs, reason: item.detail?.reason })), counters: countSnapshot(encoderCounts, profile.scalarHost, { profile }) });
      if (complete(result)) { warmed = true; break; }
    }
    report.prewarmComplete = warmed;
    if (!warmed) { report.status = 'FAIL_PREWARM_NO_QUALITY_QUERIES'; throw Error('Bounded128 prewarm incomplete; no quality query may run.'); }
    await sample('prewarm-complete');
    for (const query of queries) {
      const before = countSnapshot(encoderCounts, profile.scalarHost, { profile }), measured = await request(query.text), found = measured.result;
      const after = countSnapshot(encoderCounts, profile.scalarHost, { profile }), last = measured.observations.at(-1)?.detail;
      const results = found.results.slice(0, 5).map(hit => {
        const sid = hit.reference?.sessionId || hit.id, doc = docs.get(sid);
        if (!doc) throw Error('Result source outside owned synthetic corpus.');
        if (hit.reference && (hit.reference.messageId !== 'm1' || hit.reference.source !== 'content')) throw Error('Unexpected source field citation.');
        return { documentId: doc.id, reference: hit.reference, snippet: hit.snippet, ...classify(hit, last), rankScore: hit.rankScore };
      });
      const rank = results.findIndex(hit => query.relevant.includes(hit.documentId)) + 1, done = complete(found);
      report.rows.push({ queryId: query.id, split: query.split, group: query.group, kind: query.kind, complete: done, rank, elapsedMs: measured.elapsedMs,
        results, coverage: found.coverage, semantic: found.semantic, lexicalAdmission: found.lexicalAdmission, before, after,
        cache: { queryEncodeTexts: after.encoderCalls.submitted.query - before.encoderCalls.submitted.query,
          documentEncodeTexts: after.encoderCalls.submitted.document - before.encoderCalls.submitted.document,
          coarseQueryNotRequired: last?.globalCandidateCount === 0,
          coarseQueryCacheHit: last?.globalCandidateCount > 0 && last.globalCoarseComplete === true && after.encoderCalls.submitted.query === before.encoderCalls.submitted.query,
          documentVectorCacheHits: Math.max(0, (found.semantic?.cachedFragments || 0) - (after.encoderCalls.successful.document - before.encoderCalls.successful.document)),
          scalarVerdictCacheHits: last?.reason === 'semantic-deadline' ? null : last?.scores?.filter(row => row.cached).length || 0,
          scalarVerdictCacheAccountingComplete: last?.reason !== 'semantic-deadline',
          scalarVerdicts: last?.scores?.length || 0, cachedFragments: found.semantic?.cachedFragments ?? null },
        privateDiagnostic: last || null });
      report.measuredQueries++;
      if (report.measuredQueries % 16 === 0) await sample('query-' + report.measuredQueries);
      if (report.measuredQueries % 20 === 0) console.log('LIVE_DEVELOPMENT ' + report.measuredQueries + '/' + queries.length);
    }
    report.metrics = Object.fromEntries(['train', 'calibration'].map(split => [split, metrics(report.rows.filter(row => row.split === split))]));
    report.coverageComplete = report.measuredQueries === queries.length && report.rows.every(row => row.complete);
    await sample('quality-loop-finished');
    report.bindingsStable = true; for (const item of bindings) if (await digest(item.file) !== item.sha256) report.bindingsStable = false;
    if (!report.bindingsStable) throw Error('Profile/source binding drift.');
    report.status = report.coverageComplete ? 'COMPLETE_LIVE_DEVELOPMENT_NOT_ACCEPTANCE' : 'PARTIAL_LIVE_DEVELOPMENT_NOT_ACCEPTANCE';
  } catch (error) { failure = error; hasFailure = true; if (report.status === 'RUNNING') report.status = 'FAIL_LIVE_STUDY'; report.error = String(error?.stack || error); }
  finally {
    report.finalCounters = countSnapshot(encoderCounts, profile.scalarHost, { profile });
    const stopped = await Promise.allSettled([Promise.resolve().then(() => profile.encoder.stop('research-stop')), Promise.resolve().then(() => profile.scalarHost.stop())]);
    report.cleanup = Object.fromEntries(['coarse', 'scalar'].map((role, index) => [role, stopped[index].status === 'fulfilled' ? stopped[index].value : { workerExited: false, error: String(stopped[index].reason) }]));
    const exited = report.cleanup.coarse.workerExited === true && report.cleanup.scalar.workerExited === true && report.cleanup.scalar.cleanupStatus === 'observed';
    report.allWorkersObservedExited = exited;
    if (f) { try { if (exited) await f.close(); else { f.master.fill(0); report.retainedFixtureDirectory = f.directory; } }
      catch (error) { report.fixtureCleanupError = String(error); report.status = 'FAIL_FIXTURE_CLEANUP'; hasFailure = true; } }
    if (!exited) report.status = 'FAIL_UNCONFIRMED_WORKER_EXIT';
    const paired = report.memorySnapshots.filter(value => value.complete);
    report.memorySummary = { samples: paired.length, observedPairedMaxWorkingSetBytes: paired.length ? Math.max(...paired.map(value => value.combinedWorkingSetBytes)) : null,
      observedPairedMaxPrivateBytes: paired.length ? Math.max(...paired.map(value => value.combinedPrivateBytes)) : null, independentPeaksAdded: false, trueProcessPeakClaimed: false };
    report.finishedAt = new Date().toISOString(); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify({ output, status: report.status, prewarmCalls: report.prewarm.length, measuredQueries: report.measuredQueries, coverageComplete: report.coverageComplete,
    metrics: report.metrics, allWorkersObservedExited: report.allWorkersObservedExited, error: report.error }));
  return { report, output, failed: hasFailure || !report.allWorkersObservedExited || report.coverageComplete !== true };
}
async function main() {
  const directory = process.argv[2]; if (!directory) throw Error('Use <new-output-directory> [profile-module profile-source-sha256].');
  const modulePath = path.resolve(process.argv[3] || path.join(__dirname, 'scalar-live-msvc-window-profile.cjs'));
  if (process.argv[3] && (!/^[a-f0-9]{64}$/.test(process.argv[4] || '') || hash(modulePath) !== process.argv[4])) throw Error('Explicit custom profile requires its reviewed exact source SHA.');
  const profile = require(modulePath).create(); profile.bindings = [...profile.bindings, { file: modulePath, sha256: hash(modulePath) }];
  const controller = new AbortController(); process.once('SIGINT', () => controller.abort(Error('research.cancelled'))); process.once('SIGTERM', () => controller.abort(Error('research.cancelled')));
  const result = await run({ directory, profile, controller }); if (result.failed) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run, metrics, complete, classify };
