'use strict';
// Current actual encrypted-source lexical capture, then offline fixed pair ledger.
// This tool never imports a model runtime or starts inference.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const { fixture: actualFixture } = require('../lib/fulltext-owned-producer-fixture');
const { identifiers } = require('./calibration-policy.cjs');
const protocol = require('./qwen-reranker-calibration-protocol.cjs');
const root = path.resolve('output/semantic-qwen-reranker-official-v1');
const fixturePath = path.join(__dirname, 'bge-minilm-mixed-development-fixture.json'), mixed = require(fixturePath), corpus = require('./calibration-fixture.cjs');
if (require('node:crypto').createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex') !== '074cc8a579795ca2aa11483cebe01102f37e9f172bca69b4733e4125f3cb9860') throw Error('Mixed fixture changed');
const hash = x => crypto.createHash('sha256').update(x).digest('hex'), read = f => JSON.parse(fs.readFileSync(f));
const sourcePaths = ['13ap-session-fulltext-index.js', '02-session-store.js', '06h-retrieval-index.js', '06ha-semantic-retrieval.js'].map(name => path.resolve('ruyi-workbench/app/src', name));
const sourceSnapshot = () => sourcePaths.map(file => ({ file, sha256: hash(fs.readFileSync(file)) }));
const expectedIndex = protocol.producer.requiredIndexSha256;
const requested = mixed.queries; if(requested.length!==32 || corpus.documents.length!==60) throw Error('scope changed');
function sourceId(docIndex) { return 'CAL' + String(docIndex).padStart(3, '0'); }
function validateRank(h,r) {
  const ref=h.reference;
  if(!r||r.sid!==ref.sessionId||r.messageId!==ref.messageId||r.source!==ref.source||r.contentRevision!==ref.contentRevision||r.start!==ref.matchStart||r.end!==ref.matchEnd||!Number.isSafeInteger(r.lexicalRank)||r.lexicalRank<0||!Number.isFinite(r.score)||r.exact!==(h.strongReason==='all-structured-identifiers-same-field'||h.strongReason==='exact-phrase-same-field')) throw Error('rank observation identity mismatch');
  return {...h,originalLexicalRank:r.lexicalRank,producerExact:r.exact,producerScore:r.score,producerRankScore:r.rankScore};
}
const documents = new Map(corpus.documents.map((doc, index) => [sourceId(index), { ...doc, index, sourceSessionId: sourceId(index) }]));
async function capture(output) {
  if (fs.existsSync(output)) throw Error('Use a new immutable capture.');
  const guard = require('./bge-minilm-mixed-collect.cjs').guard, bindingBefore = guard();
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
  const rankMarker='const projected=await host.project({sourceText,text,reference:Object.freeze(';
  const rankObservation="if(typeof __rankObserver==='function')__rankObserver({sid:hit.row.sessionId,messageId:hit.row.messageId,source:hit.row.source,contentRevision:hit.row.contentRevision,start:hit.start,end:hit.end,lexicalRank:hit.lexicalRank,exact:!!hit.exact,score:hit.score,rankScore:hit.rankScore});";
  if(indexSource.split(rankMarker).length!==2) throw Error('Rank observation boundary drifted');
  const observedSource = indexSource.replace(returnMarker, observation + returnMarker).replace(rankMarker,rankObservation+rankMarker), observedPath = path.join(root, 'current90a-mixed-observed-index.cjs');
  if (fs.existsSync(observedPath)) { if (hash(fs.readFileSync(observedPath)) !== hash(observedSource)) throw Error('Observed producer copy changed.'); }
  else fs.writeFileSync(observedPath, observedSource, { flag: 'wx' });
  if (observedSource.replace(observation, '').replace(rankObservation, '') !== indexSource) throw Error('Observation changed producer behavior.');
  const f = await actualFixture({ enabled: true, module: observedPath });
  const report = { schemaVersion: 1, status: 'RUNNING', scope: 'mixed-development-only', fixtureSha256: hash(fs.readFileSync(fixturePath)),
    captureScriptSha256: hash(fs.readFileSync(__filename)), sourceBefore: before, rows: [], modelsRun: 0,
    observation: { originalIndexSha256: hash(indexSource), observedIndexSha256: hash(observedSource), addedStatement: observation, rankObservation,
      recipe: 'Two metadata-only observers record pre-limit per-session counts and source-authenticated hit ranking immediately before projection. Removing both restores original90a bytes.' },
    limits: ['Actual current encrypted source/store/record/index/privacy owners, isolated synthetic corpus only.', 'Lexical-only pre-verifier capture intentionally retains weak pending evidence. This is not a live mixed dual-model producer run or a precision/admission qualification.', 'Proof classification uses exact current normalization, current host retrievalTerms and shared full-ID parser on the same original field.'] };
  try {
    f.hookContext.SemanticRetrieval = vm.runInNewContext(fs.readFileSync(sourcePaths[3], 'utf8') + '\nSemanticRetrieval;', { require, Buffer, Date, setTimeout, clearTimeout });
    const namespace = vm.runInNewContext('SessionFullTextIndex;', f.hookContext);
    for (const doc of documents.values()) await f.put(doc.sourceSessionId, [{ role: 'user', id: 'm1', content: doc.text }]);
    const index = namespace.create({ ...f.host, resultUnit: 'sessions' }); await index.prepare(null);
    for (const query of requested) {
      const projected = [], candidateStages = [], rankStages = [], requiredIds = identifiers(query.text), terms = [...new Set(f.api.terms(query.text).filter(x => typeof x === 'string' && !x.startsWith('#')).map(normalize))];
      f.hookContext.__candidateObserver = value => candidateStages.push(JSON.parse(JSON.stringify(value)));
      f.hookContext.__rankObserver = value => rankStages.push(JSON.parse(JSON.stringify(value)));
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
      if(rankStages.length!==projected.length) throw Error('rank observation count mismatch');
      for(let n=0;n<projected.length;n++)projected[n]=validateRank(projected[n],rankStages[n]);
      report.rows.push({ queryId: query.id, split: 'mixed-development', querySha256: hash(query.text), hits: projected,
        preFinalLimit: { sessionsObserved: candidateStages.length, uniqueSessions: new Set(candidateStages.map(x => x.sid)).size,
          candidateCount: candidateStages.reduce((sum, x) => sum + x.candidateCount, 0), sessions: candidateStages.sort((a, b) => a.sid.localeCompare(b.sid)) },
        coverage: { sourceComplete: found.coverage.complete === true, sourceCoverage: found.coverage,
          candidateSelectionComplete: candidateStages.length === 60 && new Set(candidateStages.map(x => x.sid)).size === 60
            && candidateStages.every(x => !x.entityTruncated && !x.lexicalTruncated) && candidateStages.reduce((sum, x) => sum + x.candidateCount, 0) <= 50
            && candidateStages.reduce((sum, x) => sum + x.candidateCount, 0) === projected.length
            && found.lexicalAdmission?.truncated !== true && found.entity?.partial !== true,
          weakUnverified: projected.filter(x => !x.strong).length, lexicalPartialBeforeVerifier: found.lexicalAdmission?.partial === true } });
    }
    report.sourceAfter = sourceSnapshot(); report.sourceStable = JSON.stringify(before) === JSON.stringify(report.sourceAfter) && guard().protocolHash === bindingBefore.protocolHash && guard().freezeHash === bindingBefore.freezeHash;
    report.status = report.sourceStable && report.rows.length === requested.length && report.rows.every(x => x.coverage.sourceComplete && x.coverage.candidateSelectionComplete) ? 'PASS_CURRENT_COMPLETE_CAPTURE' : 'FAIL_PARTIAL_CAPTURE';
  } catch (error) { report.status = 'FAIL'; report.error = String(error.stack || error); }
  finally { await f.close(); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
  console.log(JSON.stringify({ output, status: report.status, queries: report.rows.length, hits: report.rows.reduce((n, q) => n + q.hits.length, 0), weak: report.rows.reduce((n, q) => n + q.hits.filter(x => !x.strong).length, 0), error: report.error }));
  if (report.status !== 'PASS_CURRENT_COMPLETE_CAPTURE') process.exitCode = 1;
}
if (require.main === module) capture(path.resolve(process.argv[2] || (()=>{throw Error('new output path required')})())).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={capture,validateRank};
