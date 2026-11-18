'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const readline = require('node:readline');
const { killOwnTree } = require('../lib/kill-own-tree.js');
const { fixtureChildEnv } = require('../lib/fixture-home.js');
const fixturePath = path.resolve(process.argv[4] || path.join(__dirname, 'pilot-fixture.cjs'));
const fixture = require(fixturePath);
const runtimeDir = path.resolve(__dirname, '../../ruyi-workbench/semantic-runtime');
const lock = require(path.join(runtimeDir, 'models.lock.json'));
function percentile(values, p) { const sorted = values.slice().sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]; }
function lexical(a, b) {
  const grams = text => { const compact = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); return new Set(Array.from({ length: Math.max(0, compact.length - 1) }, (_, i) => compact.slice(i, i + 2))); };
  const left = grams(a), right = grams(b); return [...left].filter(g => right.has(g)).length / Math.max(1, Math.sqrt(left.size * right.size));
}
function metrics(results) { return { count: results.length, recallAt1: results.filter(r => r.rank === 1).length / results.length, recallAt5: results.filter(r => r.rank <= 5).length / results.length, mrr: results.reduce((n, r) => n + 1 / r.rank, 0) / results.length }; }
async function evaluate(root, model) {
  const started = performance.now();
  const homeFixture = fixtureChildEnv({ perTest: true });
  const child = spawn(process.execPath, [path.join(runtimeDir, 'worker.cjs'), '--root', root, '--model', model.id], { windowsHide: true, env: homeFixture.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let seq = 0; let stderrBytes = 0; let peakRssBytes = 0; const tokenLengths = [];
  child.stderr.on('data', data => { stderrBytes += data.length; });
  let readyResolve, readyReject;
  const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const startupTimer = setTimeout(() => readyReject(new Error('READY_TIMEOUT')), 60000);
  child.on('error', readyReject);
  child.on('exit', () => { readyReject(new Error('WORKER_EXIT')); for (const task of pending.values()) task.reject(new Error('WORKER_EXIT')); });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { readyReject(new Error('INVALID_NDJSON')); return; }
    if (message.type === 'ready') { clearTimeout(startupTimer); if (message.ok) readyResolve(message); else readyReject(new Error(message.error.code)); return; }
    const task = pending.get(message.requestId); if (task) { pending.delete(message.requestId); if (message.ok) task.resolve(message); else task.reject(new Error(message.error.code)); }
  });
  async function encode(role, texts) {
    const requestId = `eval-${++seq}`;
    const result = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
    child.stdin.write(JSON.stringify({ op: 'encode', requestId, role, texts, deadlineMs: Date.now() + 60000 }) + '\n');
    const message = await result; peakRssBytes = Math.max(peakRssBytes, message.metrics?.peakRssBytes || message.metrics?.rssBytes || 0); tokenLengths.push(...(message.tokenCounts || [])); return message;
  }
  async function batched(role, texts) { const batchSize = [1, 4, 8].includes(Number(process.env.RUYI_SEMANTIC_EVAL_BATCH)) ? Number(process.env.RUYI_SEMANTIC_EVAL_BATCH) : 8; const vectors = []; for (let i = 0; i < texts.length; i += batchSize) vectors.push(...(await encode(role, texts.slice(i, i + batchSize))).vectors); return vectors; }
  try {
    const ready = await readyPromise; const coldReadyMs = performance.now() - started;
    const docCase = process.env.RUYI_SEMANTIC_EVAL_DOC_CASE;
    const docVectors = await batched('document', fixture.documents.map(d => docCase === 'upper' ? d.text.toUpperCase() : docCase === 'lower' ? d.text.toLowerCase() : d.text));
    const queryVectors = await batched('query', fixture.queries.map(q => q.text));
    const ranks = fixture.queries.map((query, i) => {
      const ranked = fixture.documents.map((doc, j) => ({ id: doc.id, score: queryVectors[i].reduce((n, x, k) => n + x * docVectors[j][k], 0) })).sort((a, b) => b.score - a.score);
      return { id: query.id, group: query.group, rank: ranked.findIndex(item => query.relevant.includes(item.id)) + 1, top: ranked.slice(0, 5) };
    });
    const timings = [];
    for (let i = 0; i < 30; i++) { const begin = performance.now(); await encode('query', [fixture.queries[i % fixture.queries.length].text]); timings.push(performance.now() - begin); }
    const noAnswerVectors = await batched('query', fixture.noAnswer);
    const noAnswerTopScores = noAnswerVectors.map(vector => Math.max(...docVectors.map(doc => doc.reduce((n, x, k) => n + x * vector[k], 0))));
    const threshold = model.retrievalThresholds?.search;
    const filtered = ranks.map(rank => ({ ...rank, rank: rank.top[rank.rank - 1]?.score >= threshold ? rank.rank : Infinity }));
    return { modelId: model.id, modelFingerprint: ready.modelFingerprint, retrievalThresholds: model.retrievalThresholds, vectorDigests: { documents: crypto.createHash('sha256').update(JSON.stringify(docVectors)).digest('hex'), queries: crypto.createHash('sha256').update(JSON.stringify(queryVectors)).digest('hex') }, coldReadyMs, peakRssBytes, tokenLengths: { count: tokenLengths.length, min: Math.min(...tokenLengths), max: Math.max(...tokenLengths), p95: percentile(tokenLengths, .95) }, warmQuery: { count: timings.length, p50Ms: percentile(timings, .5), p95Ms: percentile(timings, .95), maxMs: Math.max(...timings), samplesMs: timings }, modelBytes: model.files.reduce((n, f) => n + f.bytes, 0), onnxBytes: model.files.find(f => f.path.endsWith('.onnx')).bytes, quality: { all: metrics(ranks), groups: Object.fromEntries([...new Set(ranks.map(r => r.group))].map(group => [group, metrics(ranks.filter(r => r.group === group))])) }, thresholdedSearch: { all: metrics(filtered), groups: Object.fromEntries([...new Set(filtered.map(r => r.group))].map(group => [group, metrics(filtered.filter(r => r.group === group))])) }, noAnswer: { count: noAnswerTopScores.length, topCosineScores: noAnswerTopScores, searchFalsePositiveRate: noAnswerTopScores.filter(score => score >= threshold).length / noAnswerTopScores.length, automaticFalsePositiveRate: null, reason: 'Automatic threshold unapproved; automatic injection release gate remains pending.' }, stderrBytes, ranks };
  } finally { clearTimeout(startupTimer); await killOwnTree(child); if (!path.resolve(homeFixture.home).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('INVALID_FIXTURE_HOME'); fs.rmSync(homeFixture.home, { recursive: true, force: true }); }
}
async function main() {
  const root = path.resolve(process.argv[2] || 'output/semantic-runtime');
  const output = path.resolve(process.argv[3] || 'output/semantic-evaluation.json');
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), fixture: { name: fixture.name, sha256: crypto.createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex'), documents: fixture.documents.length, queries: fixture.queries.length, releaseHoldout: fixture.releaseHoldout === true }, environment: { platform: process.platform, arch: process.arch, node: process.version, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, threads: { intraOp: 2, interOp: 1 }, batchSize: process.env.RUYI_SEMANTIC_EVAL_BATCH === '1' ? 1 : 8 }, limitations: ['Synthetic fixture only; small counts do not establish production generalization.', 'Short snippets only; no 1000-chunk retrieval latency or long-document quality claim.', 'No calibrated automatic rejection threshold; no automatic injection approval.'], models: [] };
  const baseline = fixture.queries.map(query => ({ group: query.group, rank: fixture.documents.map(d => ({ id: d.id, score: lexical(query.text, d.text) })).sort((a, b) => b.score - a.score).findIndex(d => query.relevant.includes(d.id)) + 1 }));
  report.lexicalBaseline = { method: 'Unicode normalized character bigram cosine (independent pilot baseline, not product lexical engine)', all: metrics(baseline), groups: Object.fromEntries([...new Set(baseline.map(r => r.group))].map(group => [group, metrics(baseline.filter(r => r.group === group))])) };
  report.environment.disableArena = process.env.RUYI_SEMANTIC_DISABLE_ARENA === '1';
  report.environment.batchSize = [1, 4, 8].includes(Number(process.env.RUYI_SEMANTIC_EVAL_BATCH)) ? Number(process.env.RUYI_SEMANTIC_EVAL_BATCH) : 8;
  report.environment.documentCase = process.env.RUYI_SEMANTIC_EVAL_DOC_CASE || 'original';
  for (const model of lock.models.filter(model => !process.env.RUYI_SEMANTIC_EVAL_MODEL || model.id === process.env.RUYI_SEMANTIC_EVAL_MODEL)) { console.log('Evaluating ' + model.id); try { report.models.push(await evaluate(root, model)); } catch (error) { report.models.push({ modelId: model.id, error: error.message }); process.exitCode = 1; } fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', 'utf8'); }
  console.log(output);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
