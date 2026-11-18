'use strict';
// Offline candidate ceilings only. No encoder/verifier/model/acceptance access.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { identifiers } = require('./calibration-policy.cjs');
const hash = x => crypto.createHash('sha256').update(x).digest('hex'), read = f => JSON.parse(fs.readFileSync(f));
const fixturePath = path.join(__dirname, 'calibration-fixture.cjs'), fixture = require(fixturePath);
const lexicalPath = path.resolve('output/semantic-weak-lexical-dev-cap-final.json'), lexical = read(lexicalPath);
const miniPath = path.resolve('output/semantic-calibration-minilm-v3-vectors.json'), mini = read(miniPath);
const qwenPath = path.resolve('output/semantic-qwen3-stateless-development-v1.json'), qwen = read(qwenPath);
const output = path.resolve(process.argv[2] || 'output/semantic-coarse-oracle-v2.json');
if (fs.existsSync(output)) throw Error('Use a new immutable report.');
const fixtureSha256 = hash(fs.readFileSync(fixturePath));
if (![lexical, mini, qwen].every(x => x.fixtureSha256 === fixtureSha256)) throw Error('Development provenance mismatch.');
const groups = ['zh-zh', 'zh-en', 'en-zh', 'en-en'], floors = { 'zh-zh': .90, 'zh-en': .85, 'en-zh': .85, 'en-en': null };
const documents = new Map(fixture.documents.map((doc, index) => [doc.id, { ...doc, index, sourceSessionId: 'CAL' + String(index).padStart(3, '0'),
  sourceMessageId: 'm1', sourceField: 'content', sourceId: 'CAL' + String(index).padStart(3, '0') + ':m1:content' }]));
const bySource = new Map([...documents.values()].map(x => [x.sourceSessionId, x]));
const lexicalRows = new Map(); let referenceChecks = 0;
for (const row of lexical.variants.lexical.rows) {
  const canonicalIds = [];
  for (const hit of row.top) {
    const doc = bySource.get(hit.reference?.sessionId), ref = hit.reference;
    if (!doc || hit.id !== doc.id || ref.messageId !== 'm1' || ref.source !== 'content' || ref.coordinate !== 'utf16'
      || hit.snippet !== doc.text.slice(ref.snippetStart, ref.snippetEnd)) throw Error('Lexical source identity/content mapping mismatch.');
    referenceChecks++; canonicalIds.push(doc.id);
  }
  lexicalRows.set(row.id, canonicalIds);
}
const requested = fixture.queries.filter(x => ['train', 'calibration'].includes(x.split) && x.kind === 'positive' && groups.includes(x.group));
const allowedQueryIds = new Set(requested.map(x => x.id));
const qwenVariant = qwen.variants.find(x => x.id === 'prior-evidence');
if (!qwenVariant || !qwen.repeat.every(x => x.maxDiff === 0)) throw Error('Expected stateless Qwen prior-evidence vectors.');
const models = [{ id: 'minilm', documents: mini.documents, queries: mini.queries.filter(x => allowedQueryIds.has(x.id)), ks: [1, 3, 5, 10, 20], fingerprint: mini.ready.modelFingerprint },
  { id: 'qwen-prior-evidence', documents: qwen.documents, queries: qwenVariant.queries.filter(x => allowedQueryIds.has(x.id)), ks: [1, 3, 5, 10], fingerprint: qwenVariant.representationFingerprint }];
const results = {};
for (const model of models) {
  const dv = new Map(model.documents.map(x => [x.id, x.vector])), qv = new Map(model.queries.map(x => [x.id, x.vector]));
  if (dv.size !== fixture.documents.length || [...documents.keys()].some(id => !dv.has(id))) throw Error('Missing/duplicate actual document vector IDs.');
  const rows = requested.map(query => {
    const q = qv.get(query.id), required = identifiers(query.text), lexicalGold = lexicalRows.get(query.id) || [];
    if (!q) throw Error('Missing development query vector.');
    const ranked = [...documents.values()].map(doc => ({ id: doc.id, sourceId: doc.sourceId, score: q.reduce((s, v, i) => s + v * dv.get(doc.id)[i], 0),
      index: doc.index, idAllowed: required.every(id => identifiers(doc.text).includes(id)) })).sort((a, b) => b.score - a.score || a.index - b.index);
    const semanticOnly = ranked.filter(x => x.idAllowed && !lexicalGold.includes(x.id));
    const rawRank = ranked.findIndex(x => query.relevant.includes(x.id)) + 1;
    const semanticRank = semanticOnly.findIndex(x => query.relevant.includes(x.id)) + 1;
    return { queryId: query.id, split: query.split, group: query.group, rawRank, semanticOnlyRelevantRank: semanticRank,
      lexicalRelevantHit: query.relevant.some(id => lexicalGold.includes(id)), relevant: query.relevant.map(id => ({ fixtureDocumentId: id, sourceId: documents.get(id)?.sourceId })),
      rawRelevantRanks: query.relevant.map(id => ({ fixtureDocumentId: id, sourceId: documents.get(id)?.sourceId, rank: ranked.findIndex(x => x.id === id) + 1 })) };
  });
  function metrics(split, group, k, hybrid) {
    const values = rows.filter(x => x.split === split && x.group === group);
    const hit = row => hybrid ? row.lexicalRelevantHit || row.semanticOnlyRelevantRank > 0 && row.semanticOnlyRelevantRank <= k : row.rawRank > 0 && row.rawRank <= k;
    return { count: values.length, hits: values.filter(hit).length, recallAtK: values.filter(hit).length / values.length,
      failedQueryIds: values.filter(x => !hit(x)).map(x => x.queryId) };
  }
  function gates(k, hybrid) { return ['train', 'calibration'].every(split => Object.entries(floors).every(([group, floor]) => floor === null || metrics(split, group, k, hybrid).recallAtK >= floor)); }
  results[model.id] = { fingerprint: model.fingerprint, requestedK: model.ks,
    rawRanking: Object.fromEntries(model.ks.map(k => [k, Object.fromEntries(['train', 'calibration'].map(split => [split, Object.fromEntries(groups.map(g => [g, metrics(split, g, k, false)]))]))])),
    historicalLexicalUnionOracle: Object.fromEntries(model.ks.map(k => [k, Object.fromEntries(['train', 'calibration'].map(split => [split, Object.fromEntries(groups.map(g => [g, metrics(split, g, k, true)]))]))])),
    minimumK: Object.fromEntries([['raw', false], ['historicalLexicalUnion', true]].map(([name, hybrid]) => [name, {
      amongRequested: model.ks.find(k => gates(k, hybrid)) ?? null,
      exactInteger1to60: Array.from({ length: 60 }, (_, i) => i + 1).find(k => gates(k, hybrid)) ?? null,
      perSplitDirection: Object.fromEntries(['train', 'calibration'].map(split => [split, Object.fromEntries(groups.map(group => [group, {
        floor: floors[group], minimumK: floors[group] === null ? null : Array.from({ length: 60 }, (_, i) => i + 1).find(k => metrics(split, group, k, hybrid).recallAtK >= floors[group]) ?? null,
      }]))])) } ])), rows };
}
const currentIndexPath = path.resolve('ruyi-workbench/app/src/13ap-session-fulltext-index.js'), currentIndexSha256 = hash(fs.readFileSync(currentIndexPath));
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), scope: 'train-calibration-positive-four-directions-only', fixtureSha256,
  sources: [fixturePath, miniPath, qwenPath, lexicalPath, __filename, path.join(__dirname, 'lexical-admission-development.cjs')].map(file => ({ file, sha256: hash(fs.readFileSync(file)) })),
  existingDirectionalFloors: floors, mrrNote: 'These are recall ceilings, not final rank or verifier MRR. en-en has no independently specified directional floor in the existing gate and is reported without inventing one.',
  lexicalEvidence: { capturedIndexSha256: lexical.sourceHashes['13ap-session-fulltext-index.js'], currentIndexSha256, isCurrent90aCapture: lexical.sourceHashes['13ap-session-fulltext-index.js'] === currentIndexSha256 && currentIndexSha256.startsWith('90a'),
    referenceChecks, proof: 'CAL000..CAL059 mapping from the actual encrypted-source producer; every observed lexical hit independently checked by real reference.sessionId/messageId/source and exact original snippet. Fixture IDs are never substituted for citation source IDs.' },
  sourceIds: [...documents.values()].map(x => ({ fixtureDocumentId: x.id, sourceId: x.sourceId, sourceSessionId: x.sourceSessionId, sourceMessageId: x.sourceMessageId, sourceField: x.sourceField })),
  results, limits: ['No model/compile/download, verifier fitting or acceptance fixture/report read.', 'Existing JSON containers are parsed; query rows are allowlisted by train/cal ID before any vector access/map/rank. Non-allowlisted query vectors never enter candidate calculations or metrics.', 'Historical lexical capture is 3fc, not current 90a; union is only an optimistic candidate upper bound and cannot establish current production precision or unconditional lexical preservation.', 'No cosine threshold or scalar verifier is applied. Source ID/structured-ID guard remains intact; adjacent and base documents stay distinct.', 'Minimum integer K is an oracle candidate-feasibility diagnostic on train/cal relevance metadata, not a selected deployment K or a license to enlarge latency/coverage budgets.', 'Strong/weak current field evidence must be freshly frozen before verifier calibration; weak lexical must be verified too.'] };
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, lexicalEvidence: report.lexicalEvidence, minimumK: Object.fromEntries(Object.entries(results).map(([model, r]) => [model, r.minimumK])) }));
