'use strict';
// Fill only pre-frozen, missing train/cal pairs. Never invokes a new model.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { pathToFileURL } = require('node:url');
const { performance } = require('node:perf_hooks');
const fixturePath = path.join(__dirname, 'calibration-fixture.cjs'), fixture = require(fixturePath);
const { identifiers } = require('./calibration-policy.cjs');
const hash = x => crypto.createHash('sha256').update(x).digest('hex'), read = f => JSON.parse(fs.readFileSync(f));
const qwenPath = path.resolve('output/semantic-qwen3-stateless-development-v1.json'), crossPath = path.resolve('output/semantic-calibration-reranker-v1-logits.json');
const lexicalPath = path.resolve('output/semantic-weak-lexical-dev-cap-final.json');
const mode = process.argv[2], output = path.resolve(process.argv[3] || 'output/semantic-qwen-mmarco-pair-plan-v1.json');
if (fs.existsSync(output)) throw Error('Use a new immutable output.');
function plan() {
  const qwen = read(qwenPath), cross = read(crossPath), lexical = read(lexicalPath), fixtureSha256 = hash(fs.readFileSync(fixturePath));
  if (![qwen, cross, lexical].every(x => x.fixtureSha256 === fixtureSha256)) throw Error('Development provenance mismatch.');
  const variant = qwen.variants.find(x => x.id === 'prior-evidence'), qv = new Map(variant.queries.map(x => [x.id, x.vector]));
  const dv = new Map(qwen.documents.map(x => [x.id, x.vector])), measured = new Set(cross.pairs.map(x => x.queryId + '\0' + x.documentId));
  const lex = new Map(lexical.variants.lexical.rows.map(x => [x.id, new Set(x.top.map(h => h.id))]));
  const needed = [], missing = [];
  for (const query of fixture.queries.filter(x => ['train', 'calibration'].includes(x.split))) {
    const required = identifiers(query.text), vector = qv.get(query.id);
    const candidates = fixture.documents.map((doc, index) => ({ doc, index, cosine: vector.reduce((s, v, i) => s + v * dv.get(doc.id)[i], 0) }))
      .filter(x => !lex.get(query.id).has(x.doc.id) && required.every(id => identifiers(x.doc.text).includes(id)))
      .sort((a, b) => b.cosine - a.cosine || a.index - b.index).slice(0, 5);
    // Full top5 union, including pairs below every frozen grid threshold.
    for (const candidate of candidates) {
      const row = { queryId: query.id, documentId: candidate.doc.id, split: query.split,
        querySha256: hash(query.text), documentSha256: hash(candidate.doc.text), cosine: candidate.cosine };
      needed.push(row); if (!measured.has(query.id + '\0' + candidate.doc.id)) missing.push(row);
    }
  }
  return { schemaVersion: 1, fixtureSha256, sources: [fixturePath, qwenPath, crossPath, lexicalPath].map(file => ({ file, sha256: hash(fs.readFileSync(file)) })),
    representationFingerprint: variant.representationFingerprint, selection: 'prior-evidence raw cosine top5 semantic-only after current syntactic ID gate, all train/cal queries, independent of scores/logits/labels; no check.',
    needed, missing, plannedPairsSha256: hash(JSON.stringify(missing)), existingCrossFingerprint: cross.modelFingerprint };
}
async function collect() {
  const planPath = path.resolve(process.argv[4]), frozen = read(planPath), expected = plan();
  if (JSON.stringify(frozen) !== JSON.stringify(expected)) throw Error('Frozen pair plan mismatch.');
  const runtime = path.resolve('output/semantic-runtime-win32-x64'), root = path.resolve('output/semantic-reranker-research-v1');
  const { sha256: fileHash, verifyRuntimeAssets } = require('../../ruyi-workbench/semantic-runtime/verify.cjs');
  const manifest = read(path.join(root, 'research.lock.json'));
  for (const file of manifest.files) if (fs.statSync(path.join(root, file.path)).size !== file.bytes || await fileHash(path.join(root, file.path)) !== file.sha256) throw Error('MMARCO integrity mismatch.');
  await verifyRuntimeAssets(runtime);
  const deny = () => { throw Error('NETWORK_DISABLED'); }; globalThis.fetch = deny;
  for (const name of ['node:http', 'node:https']) { const module = require(name); module.get = deny; module.request = deny; }
  const net = require('node:net'); net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny; require('node:tls').connect = deny;
  const start = performance.now(), { AutoTokenizer, env } = await import(pathToFileURL(path.join(runtime, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs')));
  env.allowRemoteModels = false; env.allowLocalModels = true; env.useFSCache = false;
  const tokenizer = await AutoTokenizer.from_pretrained(root, { local_files_only: true }), ort = require(path.join(runtime, 'node_modules/onnxruntime-node'));
  const session = await ort.InferenceSession.create(path.join(root, 'onnx/model_quint8_avx2.onnx'), { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1, logSeverityLevel: 4 });
  const report = { ...read(crossPath), collectionExtension: { planPath, planSha256: hash(fs.readFileSync(planPath)), collectorSha256: hash(fs.readFileSync(__filename)),
    coldMs: performance.now() - start, contract: 'Original query, original document, tokenizer text_pair, physical1, max256 reject truncation, native CPU2, raw Identity logit', additionalPairs: [], contendedTiming: true }, status: 'RUNNING' };
  const queries = new Map(fixture.queries.filter(x => ['train', 'calibration'].includes(x.split)).map(x => [x.id, x])), documents = new Map(fixture.documents.map(x => [x.id, x]));
  const end = Date.now() + 20000;
  try {
    for (const item of frozen.missing) {
      if (Date.now() >= end) throw Error('Research 20s pair collection budget exhausted.');
      const query = queries.get(item.queryId), document = documents.get(item.documentId);
      if (!query || !document || hash(query.text) !== item.querySha256 || hash(document.text) !== item.documentSha256) throw Error('Frozen text identity mismatch.');
      const began = performance.now(), input = tokenizer([query.text], { text_pair: [document.text], padding: true });
      if (input.input_ids.dims.at(-1) > 256) throw Error('Truncation refused.');
      const feed = Object.fromEntries(session.inputNames.map(name => {
        if (!input[name]) throw Error('Unexpected required graph input.');
        return [name, new ort.Tensor(input[name].type, input[name].data, input[name].dims)];
      }));
      const result = await session.run(feed), values = Array.from(result.logits.data);
      if (values.length !== 1 || !values.every(Number.isFinite)) throw Error('Invalid pair logit.');
      const pair = { queryId: item.queryId, documentId: item.documentId, biScore: item.cosine, logit: values[0], tokens: input.input_ids.dims.at(-1), elapsedMs: performance.now() - began };
      report.pairs.push(pair); report.collectionExtension.additionalPairs.push(pair);
    }
    report.status = 'PASS';
  } catch (error) { report.status = 'FAIL'; report.collectionExtension.error = String(error.stack || error); }
  finally { await session.release(); }
  report.collectionExtension.finishedAt = new Date().toISOString();
  report.collectionExtension.peakRssBytes = process.resourceUsage().maxRSS * 1024;
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, status: report.status, plannedMissing: frozen.missing.length, additionalPairs: report.collectionExtension.additionalPairs.length, peakRssBytes: report.collectionExtension.peakRssBytes }));
  if (report.status !== 'PASS') process.exitCode = 1;
}
if (mode === 'plan') { const report = plan(); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ output, needed: report.needed.length, missing: report.missing.length, missingSha256: report.plannedPairsSha256 })); }
else if (mode === 'collect') collect().catch(error => { console.error(error); process.exitCode = 1; });
else throw Error('Usage: plan output | collect output frozen-plan');
