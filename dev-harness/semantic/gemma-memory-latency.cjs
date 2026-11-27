'use strict';
// Measures the built production preflight in an isolated home, with no provider calls.
// Usage: node .../gemma-memory-latency.cjs <app/server.js> <report.json>
require('../lib/self-isolate-home');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), Module = require('node:module'), assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const reference = require('../../docs/optimization-plan/evidence/semantic-retrieval-20261116/memory-send-128-full-local-20261127.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = new AsyncLocalStorage();
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
async function measure(key, work, phase) {
  const parent = frame.getStore();
  if (!parent) return work();
  const current = { totals: parent.totals, childMs: 0 };
  const start = performance.now();
  try { return await frame.run(current, work); }
  finally {
    const elapsed = performance.now() - start;
    current.totals[key] += elapsed - current.childMs;
    if (key === 'checksMs') {
      current.totals.checks++;
      if (phase) {
        const bucket = current.totals.checkPhases[phase] ||= { calls:0, ms:0 };
        bucket.calls++;
        bucket.ms += elapsed - current.childMs;
      }
    }
    parent.childMs += elapsed;
  }
}
async function main() {
  const server = path.resolve(process.argv[2]), source = fs.readFileSync(server, 'utf8');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemma-memory-'));
  process.env.RUYI_HOME = process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
  const config = { configSchema: 9, semanticRetrievalV1: true, runtimeMemoryVectorRecallV1: true, autoImportClaudeCodeMcp: false };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  const mod = new Module(server, module);
  mod.filename = server; mod.paths = Module._nodeModulePaths(path.dirname(server)); mod.measure = measure;
  // Instrument only the isolated compiled module; do not change the on-disk artifact.
  const splitChecks = process.argv.includes('--check-phases');
  let code = source;
  if (splitChecks) {
    // Tag the original callback without adding an await, another timer, or any I/O.
    const tags = [
      ["() => context.check?.('finish', automaticBaseline ? undefined : selected)",
       "event => context.check?.('finish', automaticBaseline ? undefined : selected, 'policy-' + event.phase)"],
      ["context.check?.('finish',automaticBaseline && entry ? [entry] : selected)",
       "context.check?.('finish',automaticBaseline && entry ? [entry] : selected, 'field')"],
      ["disclosed => check('finish', disclosed)", "disclosed => check('finish', disclosed, 'disclosure')"]
    ];
    for (const [from, to] of tags) {
      assert.equal(code.split(from).length, 2);
      code = code.replace(from, to);
    }
  }
  for (const [from, to] of [
    ['const check = async (phase, watch) => {','const check = (...args) => module.measure("checksMs", () => checkImpl(...args), ' + (splitChecks ? '(args[2] || args[0])' : 'null') + '); const checkImpl = async (phase, watch) => {'],
    ['const decision = await request.evaluate(known ? scored : null, {','const evaluate = (...args) => module.measure("evaluateMs", () => request.evaluate(...args)); const decision = await evaluate(known ? scored : null, {']
  ]) { assert.equal(code.split(from).length, 2); code = code.replace(from, to); }
  mod._compile(code + '\nmodule.exports.bench = {resolveMemoryPreflight, SemanticRuntimeHooks, memoryProjectDir, pending:()=>typeof memoryHeaderPrewarm!=="undefined" && memoryHeaderPrewarm.pending()};', server);
  const srv = mod.exports, api = srv.bench, runtime = api.SemanticRuntimeHooks;
  const encode = runtime.encode;
  let foregroundDocuments = 0;
  runtime.encode = (texts, opts) => {
    if (opts.role === 'document' && frame.getStore() && opts.priority !== 'background') foregroundDocuments += texts.length;
    return opts.role === 'query' ? measure('queryMs', () => encode(texts, opts)) : encode(texts, opts);
  };
  try {
    const cwd = path.join(home, 'project'); fs.mkdirSync(cwd);
    const dir = api.memoryProjectDir(cwd); fs.mkdirSync(dir, { recursive: true });
    const filler = ['仓储','消防','备份','报销','采购','调度','审计','运维','工单','照明','打印','库存'];
    for (let i=0; i<128; i++) {
      const id='memory-'+String(i).padStart(3,'0'), name=reference.topics[i] || filler[i%filler.length]+i;
      fs.writeFileSync(path.join(dir,id+'.md'), ['---','name: '+name,'description: '+name,'type: reference','---',name].join('\n'));
    }
    const sessions = await Promise.all([1,2].map(i => srv.createSession({ title: 'latency '+i, cwd })));
    for (const s of sessions) s.turnSeq=1;
    const readyUntil = Date.now()+90000;
    do {
      await runtime.prepare({ deadline:readyUntil, budgetMs:2000 });
      if (!runtime.descriptor().available) await sleep(200);
    } while (!runtime.descriptor().available && Date.now()<readyUntil);
    assert.equal(runtime.descriptor().available,true,JSON.stringify(runtime.descriptor()));
    const sample = async (query, session) => {
      const foregroundBefore = foregroundDocuments;
      const before = runtime.stats().backend, t = { checks:0, checksMs:0, evaluateMs:0, queryMs:0, ...(splitChecks ? {checkPhases:{}} : {}) };
      const start = performance.now();
      const result = await frame.run({ totals:t, childMs:0 },()=>api.resolveMemoryPreflight(session,cwd,query,null,config));
      const elapsedMs = performance.now()-start, after = runtime.stats().backend;
      return { query, status:result.status.semantic.status, elapsedMs,...t, otherMs:elapsedMs-t.checksMs-t.evaluateMs-t.queryMs,
        documentTexts:after.documentTexts-before.documentTexts, foregroundDocumentTexts:foregroundDocuments-foregroundBefore, kills:after.kills-before.kills };
    };
    const cold = await sample(reference.queries[0],sessions[0]);
    const waitStart = Date.now();
    while(api.pending() && Date.now()-waitStart < 150000) await sleep(100);
    assert.ok(!api.pending(),'prewarm did not settle');
    const prewarmMs = Date.now()-waitStart;
    const warm = [];
    for (const query of reference.queries.slice(1)) warm.push(await sample(query,sessions[0]));
    const secondSession = await sample(reference.queries[1],sessions[1]);
    const summary = {};
    for (const key of ['elapsedMs','queryMs','checksMs','checks','evaluateMs','otherMs']) {
      const sorted = warm.map(row=>row[key]).sort((a,b)=>a-b);
      summary[key] = { median:(sorted[3]+sorted[4])/2,p95:sorted[7] };
    }
    const report = { serverSha256:hash(source),availableParallelism:os.availableParallelism(),model:runtime.descriptor().modelFingerprint,scope:'128 synthetic project headers; resident worker; distinct warm queries; exclusive timings in ms',cold,prewarmMs,warm,secondSession,summary };
    fs.writeFileSync(process.argv[3], JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({ cold,prewarmMs,secondSession,summary }));
  } finally { await runtime.shutdown(); fs.rmSync(home,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
