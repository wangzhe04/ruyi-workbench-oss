'use strict';
// Opt-in actual local worker + production shard index and source-owner integration.
// All documents are synthetic, in an isolated temporary home; never scans user history.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { fixture } = require('../lib/fulltext-owned-producer-fixture.js');
const corpus = require('./acceptance-v3-fixture.cjs');
const frozenFixture = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'acceptance-v3-fixture.cjs'))).digest('hex');
if (frozenFixture !== '32421b607bb5a7584a4d6c8a9c217ce291212229e05a07aded9c96e9a8f204c8') throw Error('Frozen acceptance fixture changed');
const root = path.resolve(__dirname, '../..');
const runtimeRoot = path.resolve(process.argv[2] || path.join(root, 'output/semantic-runtime-win32-x64'));
const output = path.resolve(process.argv[3] || path.join(root, 'output/semantic-s2b-acceptance-v3.json'));
if (fs.existsSync(output)) throw Error('Use a new immutable acceptance report.');
const qwenResearch = process.argv.includes('--qwen-research');
const src = file => fs.readFileSync(path.join(root, 'ruyi-workbench/app/src', file), 'utf8');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const boundFiles = ['06ha-semantic-retrieval.js', '06hb-semantic-runtime.js', '13ap-session-fulltext-index.js'];
const sourceIdentity = () => ({ ...Object.fromEntries(boundFiles.map(name => [name, hash(src(name))])),
  ...(qwenResearch ? { researchAdapter: hash(fs.readFileSync(path.join(__dirname, 'qwen-research-adapter.cjs'))) } : {}) });
const ctx = vm.createContext({ require, Buffer, Date, setTimeout, clearTimeout, SemanticRuntimeHooks: {} });
vm.runInContext(src('06hb-semantic-runtime.js') + '\n;globalThis.clientType=SemanticRuntimeClient;', ctx);
vm.runInContext(src('06ha-semantic-retrieval.js') + '\n;globalThis.retrieval=SemanticRetrieval;', ctx);
const children = [];
const client = qwenResearch ? require('./qwen-research-adapter.cjs').create({ root: runtimeRoot }) : ctx.clientType.create({
  enabled: async () => true,
  settings: () => ({ command: process.execPath, args: [path.join(root, 'ruyi-workbench/semantic-runtime/worker.cjs'), '--root', runtimeRoot], cwd: root,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|TEMP|TMP|PATH|PATHEXT|COMSPEC)$/i.test(key))) }),
  spawn(...args) { const child = cp.spawn(...args); const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))); children.push({ child, closed }); return child; },
});
async function main() {
  const f = await fixture({ enabled: true });
  const report = { schema: 1, generatedAt: new Date().toISOString(), realModel: true, encryptedSource: true,
    fixtureSha256: hash(fs.readFileSync(path.join(__dirname, 'acceptance-v3-fixture.cjs'))),
    sourceHashes: sourceIdentity(),
    researchOnly: qwenResearch, productionRuntime: !qwenResearch,
    checks: [], queries: [], noAnswer: [], unsupported: [], lexicalQueries: [], limitations: ['Synthetic isolated source-owner integration; not a packaged EXE or UI/model consumer authorization test.', 'Only the bounded 40-document acceptance corpus, not a 1000-fragment latency claim.', 'Near-topic missing-fact diagnostics are reported separately: related search results do not establish answerability.', 'This fixture is independently frozen before implementation evaluation; no post-result threshold tuning permitted.'] };
  const check = (label, passed) => { report.checks.push({ label, passed: !!passed }); if (!passed) process.exitCode = 1; };
  try {
    const begin = performance.now(), ready = await client.prepare({ budgetMs: 20000 });
    report.ready = ready; report.coldReadyMs = performance.now() - begin;
    if (!ready.available) throw Error('Real worker did not become available');
    if (qwenResearch && (ready.referenceFingerprint !== 'sha256:4145039138abb861752943e8df98b4d9324c23b32b430b0452b58f1d72924734'
      || ready.dimensions !== 1024 || ready.retrievalThresholds?.search !== .44)) throw Error('Frozen candidate contract changed');
    const namespace = vm.runInNewContext('SessionFullTextIndex', f.hookContext);
    const base = ctx.retrieval.create(client);
    // Research-only model admission: the unchanged shared ID parser and frozen
    // .44 threshold, without registering an unqualified production default.
    const semantic = qwenResearch ? { score: async (query, docs, options) => {
      const result = await base.score(query, docs, options);
      if (!Array.isArray(result.scores)) return result;
      const admission = ctx.retrieval.assessAdmission(query, docs, result.scores, { complete: result.coverage?.complete === true, minScore: .44 });
      admission.policyId = 'qwen-development-44';
      return { ...result, minScore: .44, admission };
    } } : base;
    const index = namespace.create({ ...f.host, resultUnit: 'sessions', semantic });
    const lexicalIndex = namespace.create({ ...f.host, resultUnit: 'sessions' });
    const ids = new Map();
    for (let i = 0; i < corpus.documents.length; i++) {
      const sid = 'Q' + String(i).padStart(3, '0'); ids.set(sid, corpus.documents[i].id);
      await f.put(sid, [{ role: 'user', id: 'm1', content: corpus.documents[i].text }]);
    }
    await index.prepare(null);
    await lexicalIndex.prepare(null);
    if (qwenResearch) {
      // Measure cold population separately from quality. This control string
      // never uses a question, relevance label, document ID or holdout result.
      report.prewarm = []; const started = performance.now(); let complete = false;
      for (let attempt = 0; attempt < 128; attempt++) {
        const began = performance.now();
        const result = await index.search('Prepare complete authorized source coverage.', null, 5);
        report.prewarm.push({ attempt: attempt + 1, elapsedMs: performance.now() - began, semantic: result.semantic,
          ...(typeof client.stats === 'function' ? { runtime: client.stats() } : {}) });
        if (result.semantic?.coverage === 'complete') { complete = true; break; }
      }
      report.prewarmMs = performance.now() - started;
      check('complete corpus prewarm before independent quality metrics', complete);
      if (!complete) throw Error('Native corpus population incomplete; no valid quality measurement');
    }
    for (const query of corpus.queries) {
      const lexical = await lexicalIndex.search(query.text, null, 5);
      const lexicalIds = lexical.results.map(hit => ids.get(hit.reference.sessionId));
      report.lexicalQueries.push({id:query.id,group:query.group,rank:lexicalIds.findIndex(id=>query.relevant.includes(id))+1,top:lexicalIds});
      let result; let attempts=0; const started = performance.now();
      for (let attempt = 0; attempt < 16; attempt++) { attempts++; result = await index.search(query.text, null, 5); if (result.semantic.coverage === 'complete') break; }
      const top = result.results.map(hit => ({ id: ids.get(hit.reference.sessionId), score: hit.score, semanticScore: hit.semanticScore, snippet: hit.snippet }));
      const rank = top.findIndex(hit => query.relevant.includes(hit.id)) + 1;
      report.queries.push({ id: query.id, group: query.group, rank, top, attempts, semantic: result.semantic, elapsedMs: performance.now() - started });
    }
    for (const [name, list] of [['noAnswer',corpus.noAnswer],['unsupported',corpus.unsupported]]) {
      for (let i=0;i<list.length;i++) {
        const lexical=await lexicalIndex.search(list[i],null,5);
        const result=await index.search(list[i],null,5);
        const lexicalIds=new Set(lexical.results.map(hit=>ids.get(hit.reference.sessionId)));
        report[name].push({id:i,count:result.results.length,lexicalCount:lexical.results.length,
          semanticOnlyCount:result.results.filter(hit=>!lexicalIds.has(ids.get(hit.reference.sessionId))).length,
          top:result.results.map(hit=>({id:ids.get(hit.reference.sessionId),semanticScore:hit.semanticScore})),semantic:result.semantic});
      }
    }
    const metrics = rows => ({ count: rows.length, recallAt5: rows.filter(row => row.rank > 0 && row.rank <= 5).length / rows.length,
      mrr: rows.reduce((sum, row) => sum + (row.rank > 0 ? 1 / row.rank : 0), 0) / rows.length });
    report.quality = { all: metrics(report.queries), groups: Object.fromEntries([...new Set(report.queries.map(row => row.group))].map(group => [group, metrics(report.queries.filter(row => row.group === group))])),
      noAnswerFalsePositiveRate: report.noAnswer.filter(row => row.count > 0).length / report.noAnswer.length, semanticOnlyFalsePositiveRate: report.noAnswer.filter(row => row.semanticOnlyCount > 0).length / report.noAnswer.length, lexicalFalsePositiveRate: report.noAnswer.filter(row => row.lexicalCount > 0).length / report.noAnswer.length };
    report.lexicalBaseline={all:metrics(report.lexicalQueries),groups:Object.fromEntries([...new Set(report.lexicalQueries.map(row=>row.group))].map(group=>[group,metrics(report.lexicalQueries.filter(row=>row.group===group))]))};
    check('all positive queries have complete semantic coverage',report.queries.every(row=>row.semantic.coverage==='complete'));
    check('all no-answer queries have complete semantic coverage',report.noAnswer.every(row=>row.semantic.coverage==='complete'));
    check('all scored references carry raw source excerpts', report.queries.every(row => row.top.every(hit => typeof hit.snippet === 'string' && hit.snippet.length)));
    f.allowed.set('Q000', false);
    const revoked = await index.search(corpus.queries[0].text, null, 50);
    check('revoked source is excluded after vector cache warmup', !revoked.results.some(hit => hit.reference.sessionId === 'Q000'));
    check('source and research adapter unchanged during acceptance', JSON.stringify(sourceIdentity()) === JSON.stringify(report.sourceHashes));
    report.acceptanceThresholds = { chineseRecallAt5: .90, crossLanguageRecallAt5: .85, mrr: .75, noAnswerFalsePositiveRate: .05 };
    report.qualityGatePassed = report.quality.groups['zh-zh'].recallAt5 >= .90 && report.quality.groups['zh-en'].recallAt5 >= .85
      && report.quality.groups['en-zh'].recallAt5 >= .85 && report.quality.all.mrr >= .75 && report.quality.noAnswerFalsePositiveRate <= .05 && report.checks.every(row=>row.passed);
    if (!report.qualityGatePassed) process.exitCode = 1;
  } catch (error) { report.error = String(error.code || error.message); process.exitCode = 1; }
  finally {
    if (typeof client.stats === 'function') report.runtimeStats = client.stats();
    report.runtimeStop = await client.stop('disabled'); report.workerClose = await Promise.all(children.map(row => row.closed)); await f.close();
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ output, checks: report.checks, quality: report.quality, qualityGatePassed: report.qualityGatePassed, error: report.error }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
