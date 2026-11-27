'use strict';
// RUYI_SEMANTIC_GEMMA2_ROOT and RUYI_SEMANTIC_GEMMA2_LOCK_SHA256 identify the verified local model.
// node dev-harness/semantic/gemma-stored-restart.cjs <new report.json> [session count] [messages per session]
require('../lib/self-isolate-home');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { fixture } = require('../lib/fulltext-owned-producer-fixture');

const topics = ['delivery schedule', 'garden watering', 'inventory records', 'camera lenses', 'building insulation',
  'railway routes', 'book lending', 'weather station', 'office supplies', 'bicycle repair'];
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function phase(kind, directory, sessionCount, perSession) {
  process.env.RUYI_HOME = process.env.WIN_CLAUDE_WORKBENCH_HOME = path.join(directory, 'model-home');
  const server = path.resolve(__dirname, '../../ruyi-workbench/app/server.js'), bytes = fs.readFileSync(server);
  const m = new Module(server, module);
  m.filename = server;
  m.paths = Module._nodeModulePaths(path.dirname(server));
  m._compile(bytes.toString() + '\nmodule.exports.measure={SemanticRuntimeHooks,SemanticRetrieval,SemanticRuntimeTransportProof,SemanticOriginalWindows,SemanticWindowPolicy};', server);
  const ports = m.exports.measure, runtime = ports.SemanticRuntimeHooks;
  const root = path.join(directory, 'dataset');
  const f = await fixture({ directory: root, enabled: true, master: createHash('sha256').update('synthetic L4 fixture key').digest() });
  const report = { node: process.version, serverSha256: digest(bytes), pid: process.pid, availableParallelism: os.availableParallelism() };
  try {
    const started = performance.now(), until = Date.now() + 60000;
    let ready;
    do {
      ready = await runtime.prepare({ deadline: until });
      if (!ready.available) await sleep(100);
    } while (!ready.available && Date.now() < until);
    assert.ok(ready.available && ready.policyReady, JSON.stringify(ready));
    report.model = ready.modelFingerprint;
    report.modelReadyMs = Math.round(performance.now() - started);
    Object.assign(f.hookContext, ports, { setTimeout, clearTimeout, setImmediate });
    const ids = Array.from({ length: sessionCount }, (_, n) => 'S' + String(n).padStart(3, '0'));
    if (kind === 'build') {
      for (const [i, id] of ids.entries()) {
        const rows = Array.from({ length: perSession }, (_, j) => ({ id: 'm' + j, role: 'user', turnSeq: 1,
          content: topics[(i + j) % topics.length] + ' notes for inspection batch ' + i + ' section ' + j }));
        await f.put(id, rows);
      }
    } else {
      f.catalog.push(...ids);
    }
    let docTexts = 0, queryTexts = 0, scans = 0;
    const observed = { ...runtime, async encode(texts, options) {
      if (options.role === 'document') docTexts += texts.length;
      else if (options.role === 'query') queryTexts += texts.length;
      return runtime.encode(texts, options);
    } };
    const index = vm.runInContext('SessionFullTextIndex', f.hookContext).create({
      ...f.host, resultUnit: 'sessions', vectors: true, encoder: observed, semantic: ports.SemanticRetrieval.create(observed),
      async scan(...args) { scans++; return f.host.scan(...args); },
      ...(kind === 'build' ? { backgroundPolicy: async () => ({ index: true, semantic: true }) } : {}),
    });
    if (kind === 'build') {
      const then = performance.now();
      index.backgroundKick();
      while (index.backgroundStatus().encodedFragments < ids.length * perSession && performance.now() - then < 900000) await sleep(50);
      report.backgroundMs = Math.round(performance.now() - then);
      report.encoded = index.backgroundStatus().encodedFragments;
      assert.equal(report.encoded, ids.length * perSession, JSON.stringify(index.backgroundStatus()));
      report.sealedFiles = ids.filter(sid => {
        const file = path.join(f.sessions, '_fulltext-index-v1', sid, 'vectors.json');
        return /"workData"\s*:\s*3\b/.test(fs.readFileSync(file, 'utf8').slice(0, 256));
      }).length;
      assert.equal(report.sealedFiles, ids.length);
    } else {
      report.queries = [];
      for (let i = 0; i < 20; i++) {
        const q = 'Which ' + topics[i % 10] + ' tasks need ' + (i < 10 ? 'inspection' : 'additional review') + '?';
        const workerBefore = runtime.stats().backend;
        const then = performance.now(), docsBefore = docTexts, queriesBefore = queryTexts, scansBefore = scans;
        const r = await index.search(q, null, 5, { method: ports.SemanticRuntimeTransportProof.method(), deferDocumentEncoding: true,
          deadline: Date.now() + 15000 });
        const workerAfter = runtime.stats().backend;
        report.queries.push({ query: q, ms: Math.round(performance.now() - then), status: r.semantic.status,
          coverage: r.semantic.coverage, candidates: r.semantic.candidateFragments, cached: r.semantic.cachedFragments,
          workerDocumentTexts: workerAfter.documentTexts - workerBefore.documentTexts, workerQueryTexts: workerAfter.queryTexts - workerBefore.queryTexts,
          policy: r.semantic.admission?.policyId, docTexts: docTexts - docsBefore, queryTexts: queryTexts - queriesBefore, scans: scans - scansBefore });
      }
    }
    report.workerStats = runtime.stats().backend;
    return report;
  } finally {
    await runtime.shutdown();
    await f.close();
  }
}

async function main() {
  if (process.argv[2] === '--phase') {
    const [kind, dir, sessions, rows] = process.argv.slice(3);
    const report = await phase(kind, dir, Number(sessions), Number(rows));
    fs.writeFileSync(path.join(dir, kind + '.json'), JSON.stringify(report));
    return;
  }
  const [output, sessions = '25', rows = '40'] = process.argv.slice(2);
  assert.ok(output && !fs.existsSync(output), 'provide a new evidence file');
  for (const value of [sessions, rows]) assert.ok(/^[1-9]\d*$/.test(value) && Number(value) <= 1000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemma-stored-restart-'));
  try {
    const report = { generatedAt: new Date().toISOString(), sessions: Number(sessions), messagesPerSession: Number(rows), encrypted: true,
      measurement: 'Full-text session search with the real worker, encrypted synthetic source and owned index. Two fresh Node processes with recorded available parallelism; warm model before queries.' };
    for (const kind of ['build', 'restart']) {
      const proc = spawnSync(process.execPath, [__filename, '--phase', kind, dir, sessions, rows], { stdio: 'inherit', windowsHide: true });
      if (proc.error) throw proc.error;
      assert.equal(proc.status, 0, kind);
      report[kind] = JSON.parse(fs.readFileSync(path.join(dir, kind + '.json')));
    }
    assert.notEqual(report.build.pid, report.restart.pid);
    const samples = report.restart.queries, sorted = samples.map(s => s.ms).sort((a, b) => a - b);
    report.summary = { complete: samples.filter(s => s.coverage === 'complete').length, documentsEncoded: samples.reduce((n, s) => n + s.docTexts, 0),
      firstComplete: samples.findIndex(s => s.coverage === 'complete') + 1 || null,
      medianMs: (sorted[9] + sorted[10]) / 2, p95Ms: sorted[18] };
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(report.summary));
    assert.equal(report.build.model, report.restart.model);
    assert.equal(report.summary.documentsEncoded, 0);
    assert.ok(report.summary.firstComplete && report.summary.firstComplete <= 3);
    assert.ok(samples.every(s => s.candidates === Number(sessions) * Number(rows) && s.policy && s.queryTexts === 1));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
